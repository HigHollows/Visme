import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type FetchFn = typeof fetch;

export interface OAuthEndpoints {
  authUrl: string;
  tokenUrl: string;
}

export const GOOGLE: OAuthEndpoints = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
};

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms */
  expiresAt: number;
  /** Portées accordées (séparées par des espaces), telles que renvoyées par le fournisseur. */
  scope?: string;
}

const b64url = (b: Buffer) => b.toString("base64url");

export function createPkce() {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export interface FlowOptions {
  endpoints: OAuthEndpoints;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  /** Ouvre l'URL d'autorisation dans le navigateur système. */
  openUrl: (url: string) => void | Promise<void>;
  fetch?: FetchFn;
  timeoutMs?: number;
  /** Paramètres supplémentaires de l'URL d'autorisation (ex. login_hint). */
  extraParams?: Record<string, string>;
}

const DONE_PAGE = (ok: boolean) =>
  `<!doctype html><meta charset="utf-8"><title>ASSISTANT</title><body style="font-family:system-ui;text-align:center;margin-top:20vh"><h2>${
    ok ? "Connexion réussie" : "Connexion échouée"
  }</h2><p>Vous pouvez fermer cet onglet et revenir à ASSISTANT.</p></body>`;

async function tokenRequest(
  f: FetchFn,
  url: string,
  params: Record<string, string>,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }> {
  const res = await f(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      detail = j.error_description ?? j.error ?? detail;
    } catch {}
    throw new OAuthError(`Échec OAuth (${res.status}) : ${detail}`, res.status === 400 || res.status === 401);
  }
  return JSON.parse(text);
}

export class OAuthError extends Error {
  constructor(
    message: string,
    /** true si le refresh token est invalide/révoqué : il faut reconnecter le compte. */
    readonly reauth = false,
  ) {
    super(message);
  }
}

/** Flux "application de bureau" : PKCE + redirection sur 127.0.0.1 (pas de serveur distant). */
export async function authorize(o: FlowOptions): Promise<Tokens> {
  const f = o.fetch ?? fetch;
  const { verifier, challenge } = createPkce();
  const state = b64url(randomBytes(24));

  let resolveCode!: (code: string) => void;
  let rejectCode!: (e: Error) => void;
  const codePromise = new Promise<string>((res, rej) => ((resolveCode = res), (rejectCode = rej)));

  // Le rejet peut survenir avant le `await` ci-dessous (callback très rapide) : on évite un « unhandled rejection ».
  codePromise.catch(() => {});

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== "/") {
      res.writeHead(404).end();
      return;
    }
    const err = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    // Contre le CSRF : l'état doit correspondre exactement à celui que nous avons émis.
    const okState = url.searchParams.get("state") === state;
    res.writeHead(code && okState && !err ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    res.end(DONE_PAGE(!!code && okState && !err));
    if (err) rejectCode(new OAuthError(`Autorisation refusée : ${err}`));
    else if (!okState) rejectCode(new OAuthError("Réponse OAuth invalide (state)"));
    else if (code) resolveCode(code);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const timer = setTimeout(() => rejectCode(new OAuthError("Délai dépassé : connexion non terminée")), o.timeoutMs ?? 300_000);
  try {
    const auth = new URL(o.endpoints.authUrl);
    const p = {
      client_id: o.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: o.scopes.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      prompt: "consent",
      ...o.extraParams,
    };
    for (const [k, v] of Object.entries(p)) auth.searchParams.set(k, v);
    await o.openUrl(auth.toString());

    const code = await codePromise;
    const now = Date.now();
    const t = await tokenRequest(f, o.endpoints.tokenUrl, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: o.clientId,
      code_verifier: verifier,
      ...(o.clientSecret && { client_secret: o.clientSecret }),
    });
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: now + t.expires_in * 1000, scope: t.scope };
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

export async function refreshTokens(
  endpoints: OAuthEndpoints,
  clientId: string,
  clientSecret: string | undefined,
  refreshToken: string,
  f: FetchFn = fetch,
): Promise<Tokens> {
  const now = Date.now();
  const t = await tokenRequest(f, endpoints.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    ...(clientSecret && { client_secret: clientSecret }),
  });
  // Google ne renvoie pas toujours un nouveau refresh token : on conserve l'ancien.
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? refreshToken, expiresAt: now + t.expires_in * 1000, scope: t.scope };
}
