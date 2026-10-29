import {
  GOOGLE,
  OAuthError,
  authorize,
  refreshTokens,
  type FetchFn,
  type Tokens,
} from "@assistant/connectors";
import type { Db } from "@assistant/db";

export const SCOPES = {
  mail: "https://www.googleapis.com/auth/gmail.readonly",
  send: "https://www.googleapis.com/auth/gmail.send",
  calendar: "https://www.googleapis.com/auth/calendar.events.readonly",
  calendarWrite: "https://www.googleapis.com/auth/calendar.events",
} as const;
export type Feature = keyof typeof SCOPES;

const ALLOWED_AUTH_HOSTS = new Set(["accounts.google.com"]);

export interface GoogleConfig {
  clientId: string;
  clientSecret?: string;
}

export interface AccountTokenRow {
  id: string;
  tokens: string;
}

/** Configuration OAuth, jetons et portées des comptes Google (partagés entre mails et calendrier). */
export class GoogleAuth {
  constructor(
    private db: Db,
    private f?: FetchFn,
  ) {}

  getConfig(): GoogleConfig | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key='google_oauth'").get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as GoogleConfig) : null;
  }

  setConfig(c: GoogleConfig) {
    const clientId = c.clientId.trim();
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId))
      throw new Error("Identifiant client invalide (attendu : xxx.apps.googleusercontent.com)");
    const secret = c.clientSecret?.trim() || this.getConfig()?.clientSecret; // vide = conserver l'existant
    this.db
      .prepare("INSERT INTO kv(key,value) VALUES('google_oauth',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify({ clientId, ...(secret && { clientSecret: secret }) }));
  }

  /** Les comptes créés avant l'ajout du calendrier n'ont pas de `scope` stocké : ils n'ont que le mail. */
  static features(tokensJson: string): Record<Feature, boolean> {
    const scope = (JSON.parse(tokensJson) as Tokens).scope;
    if (scope === undefined) return { mail: true, send: false, calendar: false, calendarWrite: false };
    const has = (s: string) => scope.split(/\s+/).includes(s);
    const write = has(SCOPES.calendarWrite);
    return { mail: has(SCOPES.mail), send: has(SCOPES.send), calendar: has(SCOPES.calendar) || write, calendarWrite: write };
  }

  async authorize(features: Feature[], openUrl: (url: string) => void | Promise<void>, loginHint?: string): Promise<Tokens> {
    const cfg = this.getConfig();
    if (!cfg) throw new Error("Renseignez d'abord l'identifiant client Google (Settings → Comptes).");
    if (!features.length) throw new Error("Choisissez au moins le mail ou le calendrier.");
    const tokens = await authorize({
      endpoints: GOOGLE,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      scopes: features.map((x) => SCOPES[x]),
      fetch: this.f,
      // Conserve les portées déjà accordées (ex. ajouter le calendrier à un compte mail existant).
      extraParams: { include_granted_scopes: "true", ...(loginHint && { login_hint: loginHint }) },
      openUrl: (url) => {
        const u = new URL(url);
        if (u.protocol !== "https:" || !ALLOWED_AUTH_HOSTS.has(u.hostname)) throw new Error("URL d'autorisation refusée");
        return openUrl(url);
      },
    });
    if (!tokens.refreshToken) throw new Error("Google n'a pas renvoyé de jeton d'actualisation ; réessayez.");
    return tokens;
  }

  async accessToken(acc: AccountTokenRow, force = false): Promise<string> {
    let t = JSON.parse(acc.tokens) as Tokens;
    if (!force && t.expiresAt - 60_000 > Date.now()) return t.accessToken;
    const cfg = this.getConfig();
    if (!cfg || !t.refreshToken) throw new OAuthError("Compte à reconnecter", true);
    try {
      t = await refreshTokens(GOOGLE, cfg.clientId, cfg.clientSecret, t.refreshToken, this.f);
    } catch (e) {
      if (e instanceof OAuthError && e.reauth) this.db.prepare("UPDATE accounts SET status='reauth' WHERE id=?").run(acc.id);
      throw e;
    }
    // Google ne renvoie pas toujours `scope` au refresh : on garde celui déjà connu.
    t.scope ??= (JSON.parse(acc.tokens) as Tokens).scope;
    acc.tokens = JSON.stringify(t);
    this.db.prepare("UPDATE accounts SET tokens=? WHERE id=?").run(acc.tokens, acc.id);
    return t.accessToken;
  }
}
