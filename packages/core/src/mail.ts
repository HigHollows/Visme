import { randomUUID } from "node:crypto";
import {
  GOOGLE,
  GmailClient,
  HistoryExpiredError,
  OAuthError,
  authorize,
  refreshTokens,
  type FetchFn,
  type MailMessage,
  type Tokens,
} from "@assistant/connectors";
import { audit, type Db } from "@assistant/db";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const INITIAL_QUERY = "newer_than:30d";
const INITIAL_MAX = 500;
const CONCURRENCY = 5;
const ALLOWED_AUTH_HOSTS = new Set(["accounts.google.com"]);

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

export interface GoogleConfig {
  clientId: string;
  clientSecret?: string;
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

  constructor(private d: MailDeps) {}

  // --- configuration OAuth (client ID créé par l'utilisateur dans sa console Google) ---

  getGoogleConfig(): GoogleConfig | null {
    const row = this.d.db.prepare("SELECT value FROM kv WHERE key='google_oauth'").get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as GoogleConfig) : null;
  }

  setGoogleConfig(c: GoogleConfig) {
    const clientId = c.clientId.trim();
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId))
      throw new Error("Identifiant client invalide (attendu : xxx.apps.googleusercontent.com)");
    const prev = this.getGoogleConfig();
    const secret = c.clientSecret?.trim() || prev?.clientSecret; // vide = conserver l'existant
    this.d.db
      .prepare("INSERT INTO kv(key,value) VALUES('google_oauth',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify({ clientId, ...(secret && { clientSecret: secret }) }));
  }

  // --- comptes ---

  listAccounts() {
    return this.d.db
      .prepare(
        `SELECT a.id, a.provider, a.email, a.status, a.sync_status AS syncStatus, a.sync_error AS syncError,
                a.last_sync_at AS lastSyncAt, (SELECT count(*) FROM mails m WHERE m.account_id = a.id) AS mailCount
         FROM accounts a ORDER BY a.created_at`,
      )
      .all();
  }

  removeAccount(id: string) {
    this.d.db.prepare("DELETE FROM accounts WHERE id = ?").run(id); // cascade : mails + index plein texte
    audit(this.d.db, "user", "account.remove", { id });
  }

  async connectGoogle(): Promise<{ id: string; email: string }> {
    const cfg = this.getGoogleConfig();
    if (!cfg) throw new Error("Renseignez d'abord l'identifiant client Google (Settings → Comptes).");
    const tokens = await authorize({
      endpoints: GOOGLE,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      scopes: [GMAIL_SCOPE],
      fetch: this.d.fetch,
      openUrl: (url) => {
        const u = new URL(url);
        if (u.protocol !== "https:" || !ALLOWED_AUTH_HOSTS.has(u.hostname)) throw new Error("URL d'autorisation refusée");
        return this.d.openUrl(url);
      },
    });
    if (!tokens.refreshToken) throw new Error("Google n'a pas renvoyé de jeton d'actualisation ; réessayez.");
    const gmail = new GmailClient({ getAccessToken: async () => tokens.accessToken, fetch: this.d.fetch, sleep: this.d.sleep });
    const { email } = await gmail.profile();

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
    audit(this.d.db, "user", "account.connect", { id, email, provider: "google" });
    return { id, email };
  }

  // --- jetons ---

  private async accessToken(acc: AccountRow, force = false): Promise<string> {
    let t = JSON.parse(acc.tokens) as Tokens;
    if (!force && t.expiresAt - 60_000 > Date.now()) return t.accessToken;
    const cfg = this.getGoogleConfig();
    if (!cfg || !t.refreshToken) throw new OAuthError("Compte à reconnecter", true);
    try {
      t = await refreshTokens(GOOGLE, cfg.clientId, cfg.clientSecret, t.refreshToken, this.d.fetch);
    } catch (e) {
      if (e instanceof OAuthError && e.reauth) this.d.db.prepare("UPDATE accounts SET status='reauth' WHERE id=?").run(acc.id);
      throw e;
    }
    acc.tokens = JSON.stringify(t);
    this.d.db.prepare("UPDATE accounts SET tokens=? WHERE id=?").run(acc.tokens, acc.id);
    return t.accessToken;
  }

  // --- synchronisation ---

  /** Lance la synchro en arrière-plan ; l'avancement est notifié via `mail.event`. */
  startSync(accountId: string): boolean {
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
        getAccessToken: () => this.accessToken(acc),
        refreshAccessToken: () => this.accessToken(acc, true),
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
