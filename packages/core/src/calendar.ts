import { randomUUID } from "node:crypto";
import { type CalEvent } from "@assistant/connectors";
import { audit, type Db } from "@assistant/db";
import type { Settings } from "@assistant/schemas";
import { featuresOf, type AccountService } from "./accounts";
import { CAL_ID } from "./providers/types";

const WINDOW_PAST_DAYS = 30;
const WINDOW_FUTURE_DAYS = 365;
const MAX_RANGE_MS = 400 * 86_400_000;
const MAX_LIST = 3000;

export interface CalendarDeps {
  db: Db;
  accounts: AccountService;
  settings: () => Settings;
  notify: (method: string, params: unknown) => void;
}

const LOCAL_SOURCES = ["local", "ai"];
const isRemote = (source: string) => !LOCAL_SOURCES.includes(source);

export interface EventInput {
  title: string;
  start: number;
  end: number;
  allDay?: boolean;
  description?: string;
  location?: string;
}

const COLS = `id, account_id AS accountId, title, description, location, start_at AS start, end_at AS end,
  all_day AS allDay, source, source_ref AS sourceRef, confidence, ai_added AS aiAdded, link,
  remote_id AS remoteId, calendar_id AS calendarId, push_error AS pushError`;

function shape(r: any) {
  return { ...r, allDay: !!r.allDay, aiAdded: !!r.aiAdded, sourceRef: r.sourceRef ? JSON.parse(r.sourceRef) : null };
}

/** `writable` : l'événement peut être modifié/supprimé (local, ou distant avec accès en écriture). */
function withWritable<T extends { source: string; accountId: string | null }>(e: T, writable: Set<string>) {
  return { ...e, writable: !isRemote(e.source) || (!!e.accountId && writable.has(e.accountId)) };
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
    const row = this.d.db.prepare("SELECT provider, tokens FROM accounts WHERE id=?").get(accountId) as { provider: string; tokens: string } | undefined;
    if (!row || !featuresOf(row).calendar) return false;
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
    const acc = db.prepare("SELECT id, provider FROM accounts WHERE id=?").get(accountId) as { id: string; provider: string } | undefined;
    if (!acc) throw new Error("Compte introuvable");
    this.setStatus(accountId, "syncing", null);
    this.d.notify("calendar.event", { accountId, status: "syncing" });
    try {
      const provider = this.d.accounts.calendarProvider(accountId);
      if (!provider) throw new Error("Ce compte n'a pas accès au calendrier");
      const row = db.prepare("SELECT sync_token FROM calendar_sync WHERE account_id=?").get(accountId) as { sync_token: string | null } | undefined;
      const now = Date.now();
      const out = await provider.sync(row?.sync_token ?? null, { from: now - WINDOW_PAST_DAYS * 86_400_000, to: now + WINDOW_FUTURE_DAYS * 86_400_000 });

      let result = { upserted: 0, removed: 0 };
      if (!out.unchanged) {
        db.transaction(() => {
          // Synchro complète : l'état local des événements distants est remplacé (gère les suppressions manquées).
          // Les événements créés ici puis écrits vers ce compte (source local/ai) sont conservés.
          if (out.full) db.prepare("DELETE FROM events WHERE account_id=? AND source NOT IN ('local','ai')").run(accountId);
          result = this.apply(accountId, acc.provider, out.events);
        })();
      }
      db.prepare("UPDATE calendar_sync SET sync_token=? WHERE account_id=?").run(out.cursor, accountId);
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

  private apply(accountId: string, provider: string, events: CalEvent[]) {
    const calId = CAL_ID[provider] ?? "default";
    const db = this.d.db;
    const up = db.prepare(
      `INSERT INTO events(id, account_id, calendar_id, remote_id, title, description, location, start_at, end_at, all_day, source, link, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, ?, ?, ?, ?)
       ON CONFLICT(account_id, calendar_id, remote_id) DO UPDATE SET title=excluded.title, description=excluded.description,
         location=excluded.location, start_at=excluded.start_at, end_at=excluded.end_at, all_day=excluded.all_day,
         link=excluded.link, updated_at=excluded.updated_at`,
    );
    const del = db.prepare("DELETE FROM events WHERE account_id=? AND calendar_id=? AND remote_id=?");
    let upserted = 0;
    let removed = 0;
    const now = Date.now();
    for (const e of events) {
      if (e.cancelled) removed += Number(del.run(accountId, calId, e.remoteId).changes);
      else {
        up.run(`${accountId}:${calId}:${e.remoteId}`, accountId, calId, e.remoteId, e.title, e.description, e.location,
          e.start, e.end, e.allDay ? 1 : 0, provider, e.link, now, now);
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
    const writable = this.writableAccounts();
    return this.d.db
      .prepare(
        `SELECT ${COLS} FROM events
         WHERE start_at < ? AND (end_at > ? OR (end_at = start_at AND start_at >= ?))
         ORDER BY start_at, end_at LIMIT ?`,
      )
      .all(to, from, from, MAX_LIST)
      .map((r) => withWritable(shape(r), writable));
  }

  get(id: string) {
    const r = this.d.db.prepare(`SELECT ${COLS} FROM events WHERE id=?`).get(id);
    if (!r) throw new Error("Événement introuvable");
    return withWritable(shape(r), this.writableAccounts());
  }

  // --- écriture vers l'agenda distant (file d'attente série, jamais bloquante) ---

  private chain: Promise<unknown> = Promise.resolve();
  private queue(fn: () => Promise<void>) {
    this.chain = this.chain.then(fn).catch(() => {});
  }

  /** Attend la fin des écritures distantes en cours (tests, arrêt propre). */
  idle() {
    return this.chain;
  }

  private writePayload(r: { title: string; start: number; end: number; allDay: boolean | number; location: string; description: string }) {
    return { title: r.title, start: r.start, end: r.end, allDay: !!r.allDay, location: r.location, description: r.description };
  }

  private pushFail(id: string, e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    try { this.d.db.prepare("UPDATE events SET push_error=? WHERE id=?").run(message.slice(0, 300), id); } catch { /* supprimé entre-temps */ }
    this.d.notify("calendar.event", { status: "push-error", id, error: message });
  }

  /** Écrit un nouvel événement local dans le compte choisi (Settings › Comptes › « Écrire les événements dans »). */
  private queueCreate(id: string) {
    const target = this.d.settings().calendar.writeTo;
    if (!target) return;
    this.queue(async () => {
      try {
        const provider = this.d.accounts.calendarProvider(target);
        if (!provider?.create) throw new Error("Ce compte n'autorise pas l'écriture dans l'agenda");
        const acc = this.d.accounts.row(target);
        const cur = this.d.db.prepare(`SELECT ${COLS} FROM events WHERE id=?`).get(id) as any;
        if (!cur || cur.remoteId) return; // supprimé ou déjà écrit
        const remoteId = await provider.create(this.writePayload(cur));
        try {
          this.d.db.prepare("UPDATE events SET account_id=?, calendar_id=?, remote_id=?, push_error=NULL WHERE id=?").run(target, CAL_ID[acc.provider] ?? "default", remoteId, id);
        } catch {
          // Une synchro a déjà ramené cet événement depuis le serveur : on garde cette copie-là.
          this.d.db.prepare("DELETE FROM events WHERE id=?").run(id);
        }
        this.d.notify("calendar.event", { status: "pushed", id });
      } catch (e) {
        this.pushFail(id, e);
      }
    });
  }

  private queueUpdate(id: string) {
    this.queue(async () => {
      try {
        const cur = this.d.db.prepare(`SELECT ${COLS} FROM events WHERE id=?`).get(id) as any;
        if (!cur?.remoteId || !cur.accountId) return;
        const provider = this.d.accounts.calendarProvider(cur.accountId);
        if (!provider?.update) throw new Error("Ce compte n'autorise pas l'écriture dans l'agenda");
        await provider.update(cur.remoteId, this.writePayload(cur));
        this.d.db.prepare("UPDATE events SET push_error=NULL WHERE id=?").run(id);
      } catch (e) {
        this.pushFail(id, e);
      }
    });
  }

  private queueRemove(accountId: string, remoteId: string) {
    this.queue(async () => {
      try {
        const provider = this.d.accounts.calendarProvider(accountId);
        if (!provider?.remove) return;
        await provider.remove(remoteId);
      } catch (e) {
        this.d.notify("calendar.event", { status: "push-error", error: `Suppression distante impossible : ${e instanceof Error ? e.message : e}` });
      }
    });
  }

  /** Comptes pour lesquels l'écriture est possible. */
  private writableAccounts(): Set<string> {
    return new Set(this.d.accounts.list().filter((a) => a.features.calendarWrite).map((a) => a.id));
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
    this.queueCreate(id);
    return this.get(id);
  }

  /** Un événement de même titre démarrant à moins de 2 h existe déjà (ex. invitation déjà dans l'agenda). */
  hasSimilar(title: string, start: number) {
    return !!this.d.db
      .prepare("SELECT 1 FROM events WHERE lower(title)=? AND ABS(start_at - ?) < 7200000")
      .get(title.toLowerCase(), start);
  }

  /** Suppression « brute » (annulation) : supprime aussi la copie distante si l'événement y avait été écrit. */
  removeRaw(id: string) {
    const cur = this.d.db.prepare("SELECT account_id AS accountId, remote_id AS remoteId, source FROM events WHERE id=?").get(id) as
      | { accountId: string | null; remoteId: string | null; source: string }
      | undefined;
    this.d.db.prepare("DELETE FROM events WHERE id=?").run(id);
    if (cur?.accountId && cur.remoteId && !isRemote(cur.source)) this.queueRemove(cur.accountId, cur.remoteId);
  }

  /** Restaure un événement tel qu'il était (annulation d'une modification ou suppression). */
  restore(e: ReturnType<CalendarService["get"]>) {
    this.d.db
      .prepare(
        `INSERT OR REPLACE INTO events(id, account_id, calendar_id, remote_id, title, description, location, start_at, end_at, all_day, source, source_ref, confidence, ai_added, link, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(e.id, e.accountId, e.calendarId, e.remoteId, e.title, e.description, e.location, e.start, e.end, e.allDay ? 1 : 0, e.source,
        e.sourceRef ? JSON.stringify(e.sourceRef) : null, e.confidence, e.aiAdded ? 1 : 0, e.link, Date.now(), Date.now());
    if (e.remoteId) this.queueUpdate(e.id);
    else if (!isRemote(e.source)) this.queueCreate(e.id);
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

  /** Un événement distant n'est modifiable que si le compte a l'accès en écriture ; les événements locaux le sont toujours. */
  private assertWritable(id: string) {
    const r = this.d.db.prepare("SELECT source, account_id AS accountId FROM events WHERE id=?").get(id) as { source: string; accountId: string | null } | undefined;
    if (!r) throw new Error("Événement introuvable");
    if (isRemote(r.source) && !(r.accountId && this.writableAccounts().has(r.accountId)))
      throw new Error("Cet événement vient d'un agenda synchronisé en lecture seule (autorisez l'écriture dans Settings › Comptes).");
  }

  update(id: string, e: EventInput) {
    this.assertWritable(id);
    const v = validate(e);
    const before = this.get(id);
    this.d.db
      .prepare("UPDATE events SET title=?, description=?, location=?, start_at=?, end_at=?, all_day=?, updated_at=? WHERE id=?")
      .run(v.title, v.description, v.location, v.start, v.end, v.allDay, Date.now(), id);
    audit(this.d.db, "user", "event.update", { id }, { restore: before });
    if (before.remoteId) this.queueUpdate(id);
    return this.get(id);
  }

  delete(id: string) {
    this.assertWritable(id);
    const before = this.get(id);
    this.d.db.prepare("DELETE FROM events WHERE id=?").run(id);
    audit(this.d.db, "user", "event.delete", { id }, { restore: before });
    if (before.accountId && before.remoteId) this.queueRemove(before.accountId, before.remoteId);
  }
}
