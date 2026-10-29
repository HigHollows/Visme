import { OAuthError, authorize, microsoftEndpoints, MS_SCOPES, refreshTokens, type FetchFn, type Tokens } from "@assistant/connectors";
import type { Db } from "@assistant/db";
import type { AccountTokenRow } from "./google";

export type MsFeature = "mail" | "send" | "calendar" | "calendarWrite";

export interface MicrosoftConfig {
  /** ID d'application (client) enregistré dans Microsoft Entra / Azure par l'utilisateur (type « client public »). */
  clientId: string;
  /** « common » (comptes pro et perso), « organizations », « consumers », ou l'ID du locataire. */
  tenant: string;
}

const ALLOWED_AUTH_HOSTS = new Set(["login.microsoftonline.com"]);

/** Configuration OAuth, jetons et portées des comptes Microsoft 365 / Outlook.com. */
export class MicrosoftAuth {
  constructor(
    private db: Db,
    private f?: FetchFn,
  ) {}

  getConfig(): MicrosoftConfig | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key='microsoft_oauth'").get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as MicrosoftConfig) : null;
  }

  setConfig(c: { clientId: string; tenant?: string }) {
    const clientId = c.clientId.trim();
    if (!/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(clientId)) throw new Error("ID d'application invalide (attendu : un GUID)");
    const tenant = (c.tenant ?? "common").trim() || "common";
    if (!/^[\w.-]+$/.test(tenant)) throw new Error("Locataire invalide");
    this.db
      .prepare("INSERT INTO kv(key,value) VALUES('microsoft_oauth',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify({ clientId, tenant }));
  }

  static features(tokensJson: string): Record<MsFeature, boolean> {
    const scope = (JSON.parse(tokensJson) as Tokens).scope ?? "";
    const has = (s: string) => scope.split(/\s+/).some((x) => x.replace(/^https:\/\/graph\.microsoft\.com\//, "").toLowerCase() === s.toLowerCase());
    return {
      mail: has("Mail.Read") || has("Mail.ReadWrite"),
      send: has("Mail.Send"),
      calendar: has("Calendars.Read") || has("Calendars.ReadWrite"),
      calendarWrite: has("Calendars.ReadWrite"),
    };
  }

  async authorize(features: MsFeature[], openUrl: (url: string) => void | Promise<void>, loginHint?: string): Promise<Tokens> {
    const cfg = this.getConfig();
    if (!cfg) throw new Error("Renseignez d'abord l'ID d'application Microsoft (Settings › Comptes).");
    if (!features.length) throw new Error("Choisissez au moins une fonctionnalité.");
    const scopes = [...MS_SCOPES.base, ...features.flatMap((x) => [...MS_SCOPES[x]])];
    const tokens = await authorize({
      endpoints: microsoftEndpoints(cfg.tenant), clientId: cfg.clientId, scopes, fetch: this.f,
      redirectHost: "localhost", // Microsoft n'accepte que « http://localhost » pour une application de bureau
      extraParams: { prompt: "select_account", ...(loginHint && { login_hint: loginHint }) },
      openUrl: (url) => {
        const u = new URL(url);
        if (u.protocol !== "https:" || !ALLOWED_AUTH_HOSTS.has(u.hostname)) throw new Error("URL d'autorisation refusée");
        return openUrl(url);
      },
    });
    if (!tokens.refreshToken) throw new Error("Microsoft n'a pas renvoyé de jeton d'actualisation ; réessayez.");
    return tokens;
  }

  async accessToken(acc: AccountTokenRow, force = false): Promise<string> {
    let t = JSON.parse(acc.tokens) as Tokens;
    if (!force && t.expiresAt - 60_000 > Date.now()) return t.accessToken;
    const cfg = this.getConfig();
    if (!cfg || !t.refreshToken) throw new OAuthError("Compte à reconnecter", true);
    try {
      t = await refreshTokens(microsoftEndpoints(cfg.tenant), cfg.clientId, undefined, t.refreshToken, this.f);
    } catch (e) {
      if (e instanceof OAuthError && e.reauth) this.db.prepare("UPDATE accounts SET status='reauth' WHERE id=?").run(acc.id);
      throw e;
    }
    t.scope ??= (JSON.parse(acc.tokens) as Tokens).scope;
    acc.tokens = JSON.stringify(t);
    this.db.prepare("UPDATE accounts SET tokens=? WHERE id=?").run(acc.tokens, acc.id);
    return t.accessToken;
  }
}
