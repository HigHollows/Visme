import { randomUUID } from "node:crypto";
import { GmailClient, HistoryExpiredError, type FetchFn, type MailMessage } from "@assistant/connectors";
import { audit, type Db } from "@assistant/db";
import { GoogleAuth, type Feature, type GoogleConfig } from "./google";

const INITIAL_QUERY = "newer_than:30d";
const INITIAL_MAX = 500;
const CONCURRENCY = 5;

export interface MailDeps {
  db: Db;
  fetch?: FetchFn;
  openUrl: (url: string) => void | Promise<void>;
  notify: (method: string, params: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

interface AccountRow {
  id: string;
  provider: string;
  email: string;
  tokens: string;
  history_id: string | null;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

export class MailService {
  private syncing = new Set<string>();
  readonly auth: GoogleAuth;

  constructor(private d: MailDeps) {
    this.auth = new GoogleAuth(d.db, d.fetch);
  }

  // --- configuration OAuth (client ID créé par l'utilisateur dans sa console Google) ---

  getGoogleConfig(): GoogleConfig | null {
    return this.auth.getConfig();
  }

  setGoogleConfig(c: GoogleConfig) {
    this.auth.setConfig(c);
  }

  // --- comptes ---

  listAccounts() {
    const rows = this.d.db
      .prepare(
        `SELECT a.id, a.provider, a.email, a.status, a.sync_status AS syncStatus, a.sync_error AS syncError,
                a.last_sync_at AS lastSyncAt, a.tokens, (SELECT count(*) FROM mails m WHERE m.account_id = a.id) AS mailCount,
                cs.status AS calendarStatus, cs.error AS calendarError, cs.last_sync_at AS calendarLastSyncAt,
                (SELECT count(*) FROM events e WHERE e.account_id = a.id) AS eventCount
         FROM accounts a LEFT JOIN calendar_sync cs ON cs.account_id = a.id ORDER BY a.created_at`,
      )
      .all() as ({ id: string; tokens: string } & Record<string, unknown>)[];
    // Les jetons ne quittent jamais le sidecar : on n'expose que les fonctionnalités accordées.
    return rows.map(({ tokens, ...r }) => ({ ...r, features: GoogleAuth.features(tokens) }));
  }

  removeAccount(id: string) {
    this.d.db.prepare("DELETE FROM accounts WHERE id = ?").run(id); // cascade : mails + index plein texte
    audit(this.d.db, "user", "account.remove", { id });
  }

  async connectGoogle(features: Feature[] = ["mail"], loginHint?: string): Promise<{ id: string; email: string; features: Record<Feature, boolean> }> {
    const tokens = await this.auth.authorize(features, this.d.openUrl, loginHint);
    // Le profil Gmail donne l'adresse ; sans portée mail, on la lit via le calendrier "primary" (son id est l'adresse).
    const email = await this.resolveEmail(tokens.accessToken, features);

    const existing = this.d.db.prepare("SELECT id FROM accounts WHERE provider='google' AND email=?").get(email) as
      | { id: string }
      | undefined;
    const id = existing?.id ?? randomUUID();
    if (existing)
      this.d.db.prepare("UPDATE accounts SET tokens=?, status='ok' WHERE id=?").run(JSON.stringify(tokens), id);
    else
      this.d.db
        .prepare("INSERT INTO accounts(id, provider, email, tokens, created_at) VALUES (?, 'google', ?, ?, ?)")
        .run(id, email, JSON.stringify(tokens), Date.now());
    audit(this.d.db, "user", "account.connect", { id, email, provider: "google", features });
    return { id, email, features: GoogleAuth.features(JSON.stringify(tokens)) };
  }

  private async resolveEmail(accessToken: string, features: Feature[]): Promise<string> {
    const f = this.d.fetch ?? fetch;
    const url = features.includes("mail")
      ? "https://gmail.googleapis.com/gmail/v1/users/me/profile"
      : "https://www.googleapis.com/calendar/v3/calendars/primary";
    const res = await f(url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Impossible de lire le profil du compte (${res.status})`);
    const j = (await res.json()) as { emailAddress?: string; id?: string };
    const email = (j.emailAddress ?? j.id ?? "").toLowerCase();
    if (!email.includes("@")) throw new Error("Adresse du compte introuvable");
    return email;
  }

  // --- synchronisation ---

  /** Lance la synchro en arrière-plan ; l'avancement est notifié via `mail.event`. */
  startSync(accountId: string): boolean {
    const row = this.d.db.prepare("SELECT tokens FROM accounts WHERE id=?").get(accountId) as { tokens: string } | undefined;
    if (!row || !GoogleAuth.features(row.tokens).mail) return false; // compte sans accès au mail (calendrier seul)
    if (this.syncing.has(accountId)) return false;
    this.syncing.add(accountId);
    // L'erreur est déjà enregistrée sur le compte et notifiée à l'UI : on ne la laisse pas remonter en « unhandled rejection ».
    void this.sync(accountId)
      .catch(() => {})
      .finally(() => this.syncing.delete(accountId));
    return true;
  }

  private upsert(accountId: string, m: MailMessage) {
    this.d.db
      .prepare(
        `INSERT INTO mails(id, account_id, remote_id, thread_id, subject, from_name, from_addr, to_addrs, date, snippet, body, labels, attachments, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET subject=excluded.subject, from_name=excluded.from_name, from_addr=excluded.from_addr,
           to_addrs=excluded.to_addrs, date=excluded.date, snippet=excluded.snippet, body=excluded.body,
           labels=excluded.labels, attachments=excluded.attachments`,
      )
      .run(
        `${accountId}:${m.id}`, accountId, m.id, m.threadId, m.subject, m.fromName, m.fromAddr, m.to, m.date,
        m.snippet, m.bodyText, JSON.stringify(m.labels), JSON.stringify(m.attachments), Date.now(),
      );
  }

  async sync(accountId: string): Promise<{ added: number; deleted: number }> {
    const db = this.d.db;
    const acc = db.prepare("SELECT id, provider, email, tokens, history_id FROM accounts WHERE id=?").get(accountId) as
      | AccountRow
      | undefined;
    if (!acc) throw new Error("Compte introuvable");
    db.prepare("UPDATE accounts SET sync_status='syncing', sync_error=NULL WHERE id=?").run(accountId);
    this.d.notify("mail.event", { accountId, status: "syncing" });
    try {
      const gmail = new GmailClient({
        getAccessToken: () => this.auth.accessToken(acc),
        refreshAccessToken: () => this.auth.accessToken(acc, true),
        fetch: this.d.fetch,
        sleep: this.d.sleep,
      });

      const fetchAndStore = async (ids: string[]) => {
        let n = 0;
        await pool(ids, CONCURRENCY, async (id) => {
          const m = await gmail.getMessage(id);
          if (m) (this.upsert(accountId, m), n++);
        });
        return n;
      };

      let added = 0;
      let deleted = 0;
      let historyId = acc.history_id;
      let full = !historyId;
      if (historyId) {
        try {
          const ch = await gmail.changesSince(historyId);
          added = await fetchAndStore(ch.added);
          for (const id of ch.deleted) deleted += Number(db.prepare("DELETE FROM mails WHERE id=?").run(`${accountId}:${id}`).changes);
          historyId = ch.historyId;
        } catch (e) {
          if (!(e instanceof HistoryExpiredError)) throw e;
          full = true;
        }
      }
      if (full) {
        // On relève le point de départ AVANT de lister, pour ne rater aucun mail arrivé pendant la synchro.
        const profile = await gmail.profile();
        added = await fetchAndStore(await gmail.listIds(INITIAL_QUERY, INITIAL_MAX));
        historyId = profile.historyId;
      }
      db.prepare("UPDATE accounts SET history_id=?, sync_status='idle', last_sync_at=? WHERE id=?").run(historyId, Date.now(), accountId);
      if (added || deleted) audit(db, "ai", "mail.sync", { accountId, added, deleted });
      this.d.notify("mail.event", { accountId, status: "done", added, deleted });
      return { added, deleted };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      db.prepare("UPDATE accounts SET sync_status='error', sync_error=? WHERE id=?").run(message, accountId);
      this.d.notify("mail.event", { accountId, status: "error", error: message });
      throw e;
    }
  }

  // --- lecture ---

  list(p: { accountId?: string; q?: string; limit?: number; offset?: number }) {
    const limit = Math.min(p.limit ?? 50, 200);
    const where: string[] = [];
    const args: unknown[] = [];
    let from = "mails m";
    if (p.q?.trim()) {
      const fts = ftsExpr(p.q);
      if (!fts) return [];
      from = "mails m JOIN mails_fts ON mails_fts.rowid = m.rowid";
      where.push("mails_fts MATCH ?");
      args.push(fts);
    }
    if (p.accountId) (where.push("m.account_id = ?"), args.push(p.accountId));
    return this.d.db
      .prepare(
        `SELECT m.id, m.account_id AS accountId, m.subject, m.from_name AS fromName, m.from_addr AS fromAddr, m.date,
                m.snippet, m.category, json_array_length(m.attachments) AS attachmentCount
         FROM ${from} ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY m.date DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, p.offset ?? 0);
  }

  get(id: string) {
    const r = this.d.db
      .prepare(
        `SELECT id, account_id AS accountId, subject, from_name AS fromName, from_addr AS fromAddr, to_addrs AS toAddrs,
                date, body, attachments, category, summary FROM mails WHERE id=?`,
      )
      .get(id) as any;
    if (!r) throw new Error("Mail introuvable");
    return { ...r, attachments: JSON.parse(r.attachments) };
  }
}

function ftsExpr(q: string): string | null {
  const words = q.normalize("NFKC").match(/[\p{L}\p{N}]{2,}/gu);
  return words?.length ? words.slice(0, 12).map((w, i, a) => (i === a.length - 1 ? `"${w}"*` : `"${w}"`)).join(" AND ") : null;
}
