import { randomUUID } from "node:crypto";
import {
  GraphClient, createRealDav, testImap, testSmtp, realImapFactory,
  type CalDavConfig, type DavLike, type FetchFn, type ImapConfig, type ImapFactory, type SmtpConfig,
} from "@assistant/connectors";
import { audit, type Db } from "@assistant/db";
import { GoogleAuth, type Feature, type GoogleConfig } from "./google";
import { MicrosoftAuth, type MicrosoftConfig, type MsFeature } from "./microsoft";
import { caldavCalendar, imapMail, type ImapAccountConfig } from "./providers/imap";
import { googleCalendar, googleMail } from "./providers/google";
import { microsoftCalendar, microsoftMail } from "./providers/microsoft";
import type { CalendarProvider, MailProvider } from "./providers/types";

export type ProviderKind = "google" | "microsoft" | "imap" | "caldav";

export interface AccountFeatures {
  mail: boolean;
  send: boolean;
  calendar: boolean;
  calendarWrite: boolean;
}

export interface AccountRow {
  id: string;
  provider: ProviderKind;
  email: string;
  tokens: string;
}

/** Fonctionnalités accordées à un compte, quel que soit son fournisseur. */
export function featuresOf(a: { provider: string; tokens: string }): AccountFeatures {
  const t = JSON.parse(a.tokens);
  switch (a.provider) {
    case "google": return GoogleAuth.features(a.tokens);
    case "microsoft": return MicrosoftAuth.features(a.tokens);
    case "imap": return { mail: true, send: !!t.smtp, calendar: false, calendarWrite: false };
    case "caldav": return { mail: false, send: false, calendar: true, calendarWrite: true };
    default: return { mail: false, send: false, calendar: false, calendarWrite: false };
  }
}

export interface AccountDeps {
  db: Db;
  fetch?: FetchFn;
  openUrl: (url: string) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** Injectables pour les tests (aucun serveur réel). */
  imapFactory?: ImapFactory;
  dav?: (cfg: CalDavConfig) => Promise<DavLike>;
}

export interface ImapSetup {
  email: string;
  imapHost: string;
  imapPort?: number;
  imapSecure?: boolean;
  user?: string;
  password: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPassword?: string;
  /** Connexion non chiffrée : refusée sauf vers la machine locale (tests, serveurs de développement). */
  insecure?: boolean;
}

const host = (h: string) => {
  const v = String(h ?? "").trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(v)) throw new Error(`Nom de serveur invalide : ${h}`);
  return v;
};
const port = (p: unknown, dflt: number) => {
  const n = Number(p ?? dflt);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("Port invalide");
  return n;
};

/** Comptes de messagerie et de calendrier (Google, Microsoft, IMAP/SMTP, CalDAV) : connexion, jetons, fournisseurs. */
export class AccountService {
  readonly google: GoogleAuth;
  readonly microsoft: MicrosoftAuth;

  constructor(private d: AccountDeps) {
    this.google = new GoogleAuth(d.db, d.fetch);
    this.microsoft = new MicrosoftAuth(d.db, d.fetch);
  }

  // --- configuration OAuth ---

  getGoogleConfig(): GoogleConfig | null { return this.google.getConfig(); }
  setGoogleConfig(c: GoogleConfig) { this.google.setConfig(c); }
  getMicrosoftConfig(): MicrosoftConfig | null { return this.microsoft.getConfig(); }
  setMicrosoftConfig(c: { clientId: string; tenant?: string }) { this.microsoft.setConfig(c); }

  // --- liste ---

  list() {
    const rows = this.d.db
      .prepare(
        `SELECT a.id, a.provider, a.email, a.status, a.sync_status AS syncStatus, a.sync_error AS syncError,
                a.last_sync_at AS lastSyncAt, a.tokens, (SELECT count(*) FROM mails m WHERE m.account_id = a.id) AS mailCount,
                cs.status AS calendarStatus, cs.error AS calendarError, cs.last_sync_at AS calendarLastSyncAt,
                (SELECT count(*) FROM events e WHERE e.account_id = a.id) AS eventCount
         FROM accounts a LEFT JOIN calendar_sync cs ON cs.account_id = a.id ORDER BY a.created_at`,
      )
      .all() as ({ id: string; provider: string; tokens: string } & Record<string, unknown>)[];
    // Les jetons et mots de passe ne quittent jamais le moteur : on n'expose que les fonctionnalités accordées.
    return rows.map(({ tokens, ...r }) => ({ ...r, features: featuresOf({ provider: r.provider, tokens }) }));
  }

  row(id: string): AccountRow {
    const r = this.d.db.prepare("SELECT id, provider, email, tokens FROM accounts WHERE id=?").get(id) as AccountRow | undefined;
    if (!r) throw new Error("Compte introuvable");
    return r;
  }

  remove(id: string) {
    this.d.db.prepare("DELETE FROM accounts WHERE id = ?").run(id); // cascade : mails, événements, état de synchro
    audit(this.d.db, "user", "account.remove", { id });
  }

  private save(provider: ProviderKind, email: string, tokens: unknown): string {
    const existing = this.d.db.prepare("SELECT id FROM accounts WHERE provider=? AND email=?").get(provider, email) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    if (existing) this.d.db.prepare("UPDATE accounts SET tokens=?, status='ok' WHERE id=?").run(JSON.stringify(tokens), id);
    else this.d.db.prepare("INSERT INTO accounts(id, provider, email, tokens, created_at) VALUES (?,?,?,?,?)").run(id, provider, email, JSON.stringify(tokens), Date.now());
    return id;
  }

  // --- connexion ---

  async connectGoogle(features: Feature[] = ["mail"], loginHint?: string) {
    const tokens = await this.google.authorize(features, this.d.openUrl, loginHint);
    const f = this.d.fetch ?? fetch;
    const url = features.includes("mail") || features.includes("send")
      ? "https://gmail.googleapis.com/gmail/v1/users/me/profile"
      : "https://www.googleapis.com/calendar/v3/calendars/primary";
    const res = await f(url, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
    if (!res.ok) throw new Error(`Impossible de lire le profil du compte (${res.status})`);
    const j = (await res.json()) as { emailAddress?: string; id?: string };
    const email = (j.emailAddress ?? j.id ?? "").toLowerCase();
    if (!email.includes("@")) throw new Error("Adresse du compte introuvable");
    const id = this.save("google", email, tokens);
    audit(this.d.db, "user", "account.connect", { id, email, provider: "google", features });
    return { id, email, features: featuresOf({ provider: "google", tokens: JSON.stringify(tokens) }) };
  }

  async connectMicrosoft(features: MsFeature[] = ["mail"], loginHint?: string) {
    const tokens = await this.microsoft.authorize(features, this.d.openUrl, loginHint);
    const g = new GraphClient({ getAccessToken: async () => tokens.accessToken, fetch: this.d.fetch, sleep: this.d.sleep });
    const { email } = await g.me();
    const id = this.save("microsoft", email, tokens);
    audit(this.d.db, "user", "account.connect", { id, email, provider: "microsoft", features });
    return { id, email, features: featuresOf({ provider: "microsoft", tokens: JSON.stringify(tokens) }) };
  }

  /** Compte IMAP/SMTP : les identifiants sont vérifiés avant d'être enregistrés (dans la base chiffrée). */
  async addImap(p: ImapSetup) {
    const email = String(p.email ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Adresse e-mail invalide");
    if (!p.password) throw new Error("Mot de passe requis (utilisez un mot de passe d'application si votre fournisseur en propose)");
    const user = (p.user || email).trim();
    const imap: ImapConfig = { host: host(p.imapHost), port: port(p.imapPort, 993), secure: p.imapSecure ?? port(p.imapPort, 993) === 993, user, pass: p.password, ...(p.insecure && { insecure: true }) };
    const smtp: SmtpConfig | undefined = p.smtpHost
      ? { host: host(p.smtpHost), port: port(p.smtpPort, 587), secure: p.smtpSecure ?? port(p.smtpPort, 587) === 465, user: (p.smtpUser || user).trim(), pass: p.smtpPassword || p.password, ...(p.insecure && { insecure: true }) }
      : undefined;
    const factory = this.d.imapFactory ?? realImapFactory;
    await testImap(imap, factory).catch((e) => { throw new Error(`Connexion IMAP impossible : ${e instanceof Error ? e.message : e}`); });
    if (smtp) await testSmtp(smtp).catch((e) => { throw new Error(`Connexion SMTP impossible : ${e instanceof Error ? e.message : e}`); });
    const cfg: ImapAccountConfig = { imap, smtp };
    const id = this.save("imap", email, { kind: "imap", ...cfg });
    audit(this.d.db, "user", "account.connect", { id, email, provider: "imap", smtp: !!smtp });
    return { id, email, features: featuresOf({ provider: "imap", tokens: JSON.stringify({ smtp }) }) };
  }

  async addCalDav(p: { url: string; user: string; password: string; calendar?: string }) {
    const cfg: CalDavConfig = { url: String(p.url ?? "").trim(), user: String(p.user ?? "").trim(), pass: p.password, calendar: p.calendar?.trim() || undefined };
    if (!cfg.user || !cfg.pass) throw new Error("Identifiant et mot de passe requis");
    await (this.d.dav ?? createRealDav)(cfg).catch((e) => { throw new Error(`Connexion CalDAV impossible : ${e instanceof Error ? e.message : e}`); });
    const email = cfg.user.toLowerCase();
    const id = this.save("caldav", email, { kind: "caldav", ...cfg });
    audit(this.d.db, "user", "account.connect", { id, email, provider: "caldav", url: new URL(cfg.url).host });
    return { id, email, features: featuresOf({ provider: "caldav", tokens: "{}" }) };
  }

  // --- fournisseurs ---

  /** Jeton d'accès frais pour un compte OAuth (renouvelé si nécessaire). */
  accessToken(acc: AccountRow, force = false): Promise<string> {
    if (acc.provider === "google") return this.google.accessToken(acc, force);
    if (acc.provider === "microsoft") return this.microsoft.accessToken(acc, force);
    throw new Error("Ce compte n'utilise pas OAuth");
  }

  mailProvider(accountId: string): MailProvider | null {
    const acc = this.row(accountId);
    const f = featuresOf(acc);
    if (!f.mail) return null;
    const oauth = { getAccessToken: () => this.accessToken(acc), refreshAccessToken: () => this.accessToken(acc, true), fetch: this.d.fetch, sleep: this.d.sleep };
    if (acc.provider === "google") return googleMail(oauth, acc.email, f.send);
    if (acc.provider === "microsoft") return microsoftMail(oauth, f.send);
    if (acc.provider === "imap") return imapMail(JSON.parse(acc.tokens), acc.email, this.d.imapFactory);
    return null;
  }

  calendarProvider(accountId: string): CalendarProvider | null {
    const acc = this.row(accountId);
    const f = featuresOf(acc);
    if (!f.calendar) return null;
    const oauth = { getAccessToken: () => this.accessToken(acc), refreshAccessToken: () => this.accessToken(acc, true), fetch: this.d.fetch, sleep: this.d.sleep };
    if (acc.provider === "google") return googleCalendar(oauth, f.calendarWrite);
    if (acc.provider === "microsoft") return microsoftCalendar(oauth, f.calendarWrite);
    if (acc.provider === "caldav") {
      const t = JSON.parse(acc.tokens) as CalDavConfig;
      return caldavCalendar(t, this.d.dav ? () => this.d.dav!(t) : undefined);
    }
    return null;
  }
}
