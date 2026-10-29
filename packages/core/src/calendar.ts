import { randomUUID } from "node:crypto";
import { CalendarClient, SyncTokenExpiredError, type CalEvent, type FetchFn } from "@assistant/connectors";
import { audit, type Db } from "@assistant/db";
import { GoogleAuth } from "./google";

const CALENDAR_ID = "primary";
const WINDOW_PAST_DAYS = 30;
const WINDOW_FUTURE_DAYS = 365;
const MAX_RANGE_MS = 400 * 86_400_000;
const MAX_LIST = 3000;

export interface CalendarDeps {
  db: Db;
  auth: GoogleAuth;
  fetch?: FetchFn;
  notify: (method: string, params: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface EventInput {
  title: string;
  start: number;
  end: number;
  allDay?: boolean;
  description?: string;
  location?: string;
}

interface AccountRow {
  id: string;
  tokens: string;
}

const COLS = `id, account_id AS accountId, title, description, location, start_at AS start, end_at AS end,
  all_day AS allDay, source, source_ref AS sourceRef, confidence, ai_added AS aiAdded, link`;

function shape(r: any) {
  return { ...r, allDay: !!r.allDay, aiAdded: !!r.aiAdded, sourceRef: r.sourceRef ? JSON.parse(r.sourceRef) : null };
}

function validate(e: EventInput) {
  const title = String(e.title ?? "").trim();
  if (!title) throw new Error("Titre requis");
  if (title.length > 500) throw new Error("Titre trop long");
  if (!Number.isFinite(e.start) || !Number.isFinite(e.end)) throw new Error("Dates invalides");
  if (e.end < e.start) throw new Error("La fin précède le début");
  return {
    title,
    start: Math.trunc(e.start),
    end: Math.trunc(e.end),
    allDay: e.allDay ? 1 : 0,
    description: String(e.description ?? "").slice(0, 5000),
    location: String(e.location ?? "").slice(0, 500),
  };
}

export class CalendarService {
  private syncing = new Set<string>();

  constructor(private d: CalendarDeps) {}

  // --- synchronisation Google ---

  startSync(accountId: string): boolean {
    const row = this.d.db.prepare("SELECT tokens FROM accounts WHERE id=?").get(accountId) as { tokens: string } | undefined;
    if (!row || !GoogleAuth.features(row.tokens).calendar) return false;
    if (this.syncing.has(accountId)) return false;
    this.syncing.add(accountId);
    // L'erreur est déjà enregistrée et notifiée : on évite un « unhandled rejection » qui ferait tomber le sidecar.
    void this.sync(accountId)
      .catch(() => {})
      .finally(() => this.syncing.delete(accountId));
    return true;
  }

  private setStatus(accountId: string, status: string, error: string | null, done = false) {
    this.d.db
      .prepare(
        `INSERT INTO calendar_sync(account_id, status, error, last_sync_at) VALUES (?,?,?,?)
         ON CONFLICT(account_id) DO UPDATE SET status=excluded.status, error=excluded.error,
           last_sync_at=COALESCE(?, last_sync_at)`,
      )
      .run(accountId, status, error, done ? Date.now() : null, done ? Date.now() : null);
  }

  async sync(accountId: string): Promise<{ upserted: number; removed: number }> {
    const db = this.d.db;
    const acc = db.prepare("SELECT id, tokens FROM accounts WHERE id=?").get(accountId) as AccountRow | undefined;
    if (!acc) throw new Error("Compte introuvable");
    if (!GoogleAuth.features(acc.tokens).calendar) throw new Error("Ce compte n'a pas accès au calendrier");
    this.setStatus(accountId, "syncing", null);
    this.d.notify("calendar.event", { accountId, status: "syncing" });
    try {
      const client = new CalendarClient({
        getAccessToken: () => this.d.auth.accessToken(acc),
        refreshAccessToken: () => this.d.auth.accessToken(acc, true),
        fetch: this.d.fetch,
        sleep: this.d.sleep,
      });
      const row = db.prepare("SELECT sync_token FROM calendar_sync WHERE account_id=?").get(accountId) as
        | { sync_token: string | null }
        | undefined;

      const fullSync = async () => {
        const now = Date.now();
        const r = await client.sync(CALENDAR_ID, {
          timeMin: new Date(now - WINDOW_PAST_DAYS * 86_400_000).toISOString(),
          timeMax: new Date(now + WINDOW_FUTURE_DAYS * 86_400_000).toISOString(),
        });
        // Synchro complète : l'état local des événements Google est remplacé (gère les suppressions manquées).
        db.transaction(() => {
          db.prepare("DELETE FROM events WHERE account_id=? AND source='google'").run(accountId);
          return this.apply(accountId, r.events);
        })();
        return r;
      };

      let result: { upserted: number; removed: number };
      let token: string;
      if (row?.sync_token) {
        try {
          const r = await client.sync(CALENDAR_ID, { syncToken: row.sync_token });
          result = this.apply(accountId, r.events);
          token = r.syncToken;
        } catch (e) {
          if (!(e instanceof SyncTokenExpiredError)) throw e;
          const r = await fullSync();
          result = { upserted: r.events.filter((x) => !x.cancelled).length, removed: 0 };
          token = r.syncToken;
        }
      } else {
        const r = await fullSync();
        result = { upserted: r.events.filter((x) => !x.cancelled).length, removed: 0 };
        token = r.syncToken;
      }
      db.prepare("UPDATE calendar_sync SET sync_token=? WHERE account_id=?").run(token, accountId);
      this.setStatus(accountId, "idle", null, true);
      this.d.notify("calendar.event", { accountId, status: "done", ...result });
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.setStatus(accountId, "error", message);
      this.d.notify("calendar.event", { accountId, status: "error", error: message });
      throw e;
    }
  }

  private apply(accountId: string, events: CalEvent[]) {
    const db = this.d.db;
    const up = db.prepare(
      `INSERT INTO events(id, account_id, calendar_id, remote_id, title, description, location, start_at, end_at, all_day, source, link, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'google', ?, ?, ?)
       ON CONFLICT(account_id, calendar_id, remote_id) DO UPDATE SET title=excluded.title, description=excluded.description,
         location=excluded.location, start_at=excluded.start_at, end_at=excluded.end_at, all_day=excluded.all_day,
         link=excluded.link, updated_at=excluded.updated_at`,
    );
    const del = db.prepare("DELETE FROM events WHERE account_id=? AND calendar_id=? AND remote_id=?");
    let upserted = 0;
    let removed = 0;
    const now = Date.now();
    for (const e of events) {
      if (e.cancelled) removed += Number(del.run(accountId, CALENDAR_ID, e.remoteId).changes);
      else {
        up.run(`${accountId}:${CALENDAR_ID}:${e.remoteId}`, accountId, CALENDAR_ID, e.remoteId, e.title, e.description, e.location,
          e.start, e.end, e.allDay ? 1 : 0, e.link, now, now);
        upserted++;
      }
    }
    return { upserted, removed };
  }

  // --- lecture / écriture locale ---

  /** Événements qui chevauchent [from, to). */
  list(from: number, to: number) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error("Intervalle invalide");
    if (to - from > MAX_RANGE_MS) throw new Error("Intervalle trop large");
    return this.d.db
      .prepare(
        `SELECT ${COLS} FROM events
         WHERE start_at < ? AND (end_at > ? OR (end_at = start_at AND start_at >= ?))
         ORDER BY start_at, end_at LIMIT ?`,
      )
      .all(to, from, from, MAX_LIST)
      .map(shape);
  }

  get(id: string) {
    const r = this.d.db.prepare(`SELECT ${COLS} FROM events WHERE id=?`).get(id);
    if (!r) throw new Error("Événement introuvable");
    return shape(r);
  }

  create(e: EventInput, meta?: { aiAdded: true; confidence: number; sourceRef: { type: string; id: string } | null }) {
    const v = validate(e);
    const id = `${meta ? "ai" : "local"}:${randomUUID()}`;
    const now = Date.now();
    this.d.db
      .prepare(
        `INSERT INTO events(id, title, description, location, start_at, end_at, all_day, source, source_ref, confidence, ai_added, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, v.title, v.description, v.location, v.start, v.end, v.allDay, meta ? "ai" : "local",
        meta?.sourceRef ? JSON.stringify(meta.sourceRef) : null, meta?.confidence ?? null, meta ? 1 : 0, now, now);
    audit(this.d.db, meta ? "ai" : "user", "event.create", { id, title: v.title, sourceRef: meta?.sourceRef }, { delete: id });
    return this.get(id);
  }

  /** Un événement de même titre démarrant à moins de 2 h existe déjà (ex. invitation déjà dans Google Agenda). */
  hasSimilar(title: string, start: number) {
    return !!this.d.db
      .prepare("SELECT 1 FROM events WHERE lower(title)=? AND ABS(start_at - ?) < 7200000")
      .get(title.toLowerCase(), start);
  }

  removeRaw(id: string) {
    this.d.db.prepare("DELETE FROM events WHERE id=?").run(id);
  }

  /** Restaure un événement tel qu'il était (annulation d'une modification ou suppression). */
  restore(e: ReturnType<CalendarService["get"]>) {
    this.d.db
      .prepare(
        `INSERT OR REPLACE INTO events(id, title, description, location, start_at, end_at, all_day, source, source_ref, confidence, ai_added, link, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(e.id, e.title, e.description, e.location, e.start, e.end, e.allDay ? 1 : 0, e.source,
        e.sourceRef ? JSON.stringify(e.sourceRef) : null, e.confidence, e.aiAdded ? 1 : 0, e.link, Date.now(), Date.now());
  }

  /** Synchronise sans doublon avec la planification en cours ; renvoie null si une synchro tourne déjà. */
  async syncNow(accountId: string) {
    if (this.syncing.has(accountId)) return null;
    this.syncing.add(accountId);
    try {
      return await this.sync(accountId);
    } finally {
      this.syncing.delete(accountId);
    }
  }

  private assertLocal(id: string) {
    const r = this.d.db.prepare("SELECT source FROM events WHERE id=?").get(id) as { source: string } | undefined;
    if (!r) throw new Error("Événement introuvable");
    // Les événements Google sont en lecture seule tant que l'écriture vers Google n'est pas autorisée.
    if (r.source === "google") throw new Error("Cet événement vient de Google Agenda (lecture seule).");
  }

  update(id: string, e: EventInput) {
    this.assertLocal(id);
    const v = validate(e);
    const before = this.get(id);
    this.d.db
      .prepare("UPDATE events SET title=?, description=?, location=?, start_at=?, end_at=?, all_day=?, updated_at=? WHERE id=?")
      .run(v.title, v.description, v.location, v.start, v.end, v.allDay, Date.now(), id);
    audit(this.d.db, "user", "event.update", { id }, { restore: before });
    return this.get(id);
  }

  delete(id: string) {
    this.assertLocal(id);
    const before = this.get(id);
    this.d.db.prepare("DELETE FROM events WHERE id=?").run(id);
    audit(this.d.db, "user", "event.delete", { id }, { restore: before });
  }
}
