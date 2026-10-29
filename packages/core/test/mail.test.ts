import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src";

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const msg = (id: string, subject: string, body: string, from = "Ann <ann@x.com>") => ({
  id, threadId: `t${id}`, snippet: body.slice(0, 20), internalDate: String(1_700_000_000_000 + Number(id) * 1000), labelIds: ["INBOX"],
  payload: { mimeType: "text/plain", headers: [{ name: "From", value: from }, { name: "Subject", value: subject }], body: { data: b64(body) } },
});

/** Faux Google : OAuth + API Gmail avec boîte modifiable. */
function fakeGoogle() {
  const state = {
    mails: new Map<string, ReturnType<typeof msg>>([["1", msg("1", "Devis Dupont", "Voici le devis de mars pour Dupont")], ["2", msg("2", "Newsletter", "Promos de la semaine")]]),
    historyId: 100,
    history: [] as any[],
    historyExpired: false,
    accessTokens: [] as string[],
    tokenCalls: [] as Record<string, string>[],
    revoked: false,
  };
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
  const fetch = (async (url: string, init: RequestInit = {}) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const body = Object.fromEntries(new URLSearchParams(init.body as URLSearchParams));
      state.tokenCalls.push(body);
      if (body.grant_type === "refresh_token" && state.revoked) return json({ error: "invalid_grant", error_description: "Token revoked" }, 400);
      return json({ access_token: `AT${state.tokenCalls.length}`, ...(body.grant_type === "authorization_code" && { refresh_token: "RT" }), expires_in: 3600 });
    }
    state.accessTokens.push((init.headers as any).authorization);
    const u = new URL(url);
    if (u.pathname.endsWith("/profile")) return json({ emailAddress: "moi@gmail.com", historyId: state.historyId });
    if (u.pathname.endsWith("/messages")) return json({ messages: [...state.mails.keys()].map((id) => ({ id })) });
    if (u.pathname.includes("/messages/")) {
      const m = state.mails.get(decodeURIComponent(u.pathname.split("/").pop()!));
      return m ? json(m) : json({}, 404);
    }
    if (u.pathname.endsWith("/history")) return state.historyExpired ? json({}, 404) : json({ historyId: state.historyId, history: state.history });
    return json({}, 404);
  }) as never;
  return { state, fetch };
}

async function setup() {
  const g = fakeGoogle();
  const events: any[] = [];
  const opened: string[] = [];
  const rpc = createApp({
    fetch: g.fetch,
    notify: (m, p) => events.push({ m, ...(p as object) }),
    sleep: async () => {},
    openUrl: async (url) => {
      opened.push(url);
      const u = new URL(url);
      const cb = new URL(u.searchParams.get("redirect_uri")!);
      cb.searchParams.set("code", "CODE");
      cb.searchParams.set("state", u.searchParams.get("state")!);
      await fetch(cb);
    },
  });
  const call = async (method: string, params?: unknown) =>
    JSON.parse((await rpc.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })))!);
  await call("init", { dataDir: mkdtempSync(join(tmpdir(), "mail-")), key: "k" });
  const idle = async (accountId: string) => {
    for (let i = 0; i < 400; i++) {
      const a = (await call("accounts.list")).result.find((x: any) => x.id === accountId);
      if (a.syncStatus !== "syncing") return a;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timeout");
  };
  return { g, call, events, opened, idle };
}

const CID = "123-abc.apps.googleusercontent.com";

describe("mail Gmail", () => {
  it("refuse la connexion sans identifiant client, et valide son format", async () => {
    const { call } = await setup();
    expect((await call("accounts.connectGoogle")).error.message).toContain("identifiant client");
    expect((await call("google.config.set", { clientId: "n'importe quoi" })).error).toBeDefined();
  });

  it("connecte, synchronise, lit, et ne divulgue aucun jeton", async () => {
    const { g, call, opened, idle } = await setup();
    await call("google.config.set", { clientId: CID, clientSecret: "SECRET" });
    expect((await call("google.config.get")).result).toEqual({ clientId: CID, hasSecret: true });

    const acc = (await call("accounts.connectGoogle")).result;
    expect(acc.email).toBe("moi@gmail.com");
    expect(new URL(opened[0]!).searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    const done = await idle(acc.id);
    expect(done).toMatchObject({ syncStatus: "idle", mailCount: 2 });
    expect(JSON.stringify(await call("accounts.list"))).not.toMatch(/AT\d|"RT"|SECRET/);

    const list = (await call("mail.list", {})).result;
    expect(list.map((m: any) => m.subject)).toEqual(["Newsletter", "Devis Dupont"]); // plus récent d'abord
    const full = (await call("mail.get", { id: list[1].id })).result;
    expect(full.body).toContain("devis de mars");
    expect(g.state.tokenCalls[0]).toMatchObject({ client_secret: "SECRET", grant_type: "authorization_code" });
  });

  it("synchro incrémentale : ajoute et supprime via l'historique", async () => {
    const { g, call, idle } = await setup();
    await call("google.config.set", { clientId: CID });
    const acc = (await call("accounts.connectGoogle")).result;
    await idle(acc.id);

    g.state.mails.set("3", msg("3", "Facture EDF", "Montant 89 euros avant le 15"));
    g.state.mails.delete("2");
    g.state.historyId = 105;
    g.state.history = [{ messagesAdded: [{ message: { id: "3" } }] }, { messagesDeleted: [{ message: { id: "2" } }] }];
    expect((await call("mail.sync", { accountId: acc.id })).result.started).toBe(1);
    const a = await idle(acc.id);
    expect(a.mailCount).toBe(2);
    const subjects = (await call("mail.list", {})).result.map((m: any) => m.subject);
    expect(subjects).toContain("Facture EDF");
    expect(subjects).not.toContain("Newsletter");
  });

  it("historique expiré → resynchronisation complète", async () => {
    const { g, call, idle } = await setup();
    await call("google.config.set", { clientId: CID });
    const acc = (await call("accounts.connectGoogle")).result;
    await idle(acc.id);
    g.state.historyExpired = true;
    g.state.mails.set("9", msg("9", "Nouveau", "après expiration"));
    await call("mail.sync", { accountId: acc.id });
    expect((await idle(acc.id)).mailCount).toBe(3);
  });

  it("recherche plein texte (liste + palette globale)", async () => {
    const { call, idle } = await setup();
    await call("google.config.set", { clientId: CID });
    const acc = (await call("accounts.connectGoogle")).result;
    await idle(acc.id);
    expect((await call("mail.list", { q: "dupont" })).result.map((m: any) => m.subject)).toEqual(["Devis Dupont"]);
    const hits = (await call("search.query", { q: "devis mars" })).result;
    expect(hits[0]).toMatchObject({ type: "mail", title: "Devis Dupont" });
    expect((await call("mail.list", { q: "\"; DROP TABLE mails; --" })).result).toEqual([]);
  });

  it("jeton expiré → rafraîchi ; refresh révoqué → compte à reconnecter", async () => {
    const { g, call, idle } = await setup();
    await call("google.config.set", { clientId: CID });
    const acc = (await call("accounts.connectGoogle")).result;
    await idle(acc.id);
    const before = g.state.tokenCalls.length;
    // On avance l'horloge pour faire expirer le jeton d'accès stocké.
    const realNow = Date.now;
    Date.now = () => realNow() + 2 * 3600_000;
    try {
      await call("mail.sync", { accountId: acc.id });
      await idle(acc.id);
      expect(g.state.tokenCalls.length).toBe(before + 1);
      expect(g.state.tokenCalls.at(-1)).toMatchObject({ grant_type: "refresh_token", refresh_token: "RT" });

      Date.now = () => realNow() + 5 * 3600_000;
      g.state.revoked = true;
      await call("mail.sync", { accountId: acc.id });
      const a = await idle(acc.id);
      expect(a).toMatchObject({ syncStatus: "error", status: "reauth" });
    } finally {
      Date.now = realNow;
    }
  });

  it("supprimer le compte supprime ses mails et l'index", async () => {
    const { call, idle } = await setup();
    await call("google.config.set", { clientId: CID });
    const acc = (await call("accounts.connectGoogle")).result;
    await idle(acc.id);
    await call("accounts.remove", { id: acc.id });
    expect((await call("accounts.list")).result).toEqual([]);
    expect((await call("mail.list", {})).result).toEqual([]);
    expect((await call("search.query", { q: "devis" })).result).toEqual([]);
  });
});
