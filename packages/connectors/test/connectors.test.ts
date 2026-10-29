import { describe, expect, it } from "vitest";
import {
  GOOGLE,
  GmailClient,
  GmailError,
  HistoryExpiredError,
  OAuthError,
  authorize,
  createPkce,
  htmlToText,
  parseAddress,
  parseMessage,
  refreshTokens,
} from "../src";
import { createHash } from "node:crypto";

const b64 = (s: string) => Buffer.from(s).toString("base64url");

describe("html / adresses", () => {
  it("htmlToText retire scripts et balises, décode les entités", () => {
    const t = htmlToText('<style>p{}</style><p>Bonjour&nbsp;<b>Marie</b> &amp; Paul</p><script>alert(1)</script><br>Total : 5&euro; &#233;');
    expect(t).toBe("Bonjour Marie & Paul\n\nTotal : 5€ é");
    expect(t).not.toContain("alert");
  });
  it("parseAddress", () => {
    expect(parseAddress('"Dupont, Jean" <Jean@Ex.com>')).toEqual({ name: "Dupont, Jean", addr: "jean@ex.com" });
    expect(parseAddress("a@b.fr")).toEqual({ name: "", addr: "a@b.fr" });
  });
});

describe("parseMessage", () => {
  it("lit multipart/alternative, pièces jointes et préfère text/plain", () => {
    const m = parseMessage({
      id: "1", threadId: "t", snippet: "s", internalDate: "1700000000000", labelIds: ["INBOX"],
      payload: {
        headers: [{ name: "From", value: "Ann <ann@x.com>" }, { name: "Subject", value: "Facture" }, { name: "To", value: "moi@x.com" }],
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "multipart/alternative", parts: [
            { mimeType: "text/plain", body: { data: b64("Texte brut") } },
            { mimeType: "text/html", body: { data: b64("<p>HTML</p>") } },
          ] },
          { mimeType: "application/pdf", filename: "facture.pdf", body: { attachmentId: "att1", size: 1234 } },
        ],
      },
    });
    expect(m).toMatchObject({ subject: "Facture", fromAddr: "ann@x.com", fromName: "Ann", bodyText: "Texte brut", date: 1700000000000 });
    expect(m.attachments).toEqual([{ name: "facture.pdf", mime: "application/pdf", size: 1234, attachmentId: "att1" }]);
  });
  it("retombe sur le HTML converti", () => {
    const m = parseMessage({ id: "2", threadId: "t", payload: { headers: [], mimeType: "text/html", body: { data: b64("<div>Salut</div>") } } });
    expect(m.bodyText).toBe("Salut");
    expect(m.subject).toBe("(sans objet)");
  });
});

describe("OAuth PKCE + loopback", () => {
  it("le challenge est le SHA-256 du verifier", () => {
    const { verifier, challenge } = createPkce();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  const tokenFetch = (calls: any[]) =>
    (async (url: string, init: RequestInit) => {
      calls.push({ url, body: Object.fromEntries(new URLSearchParams(init.body as URLSearchParams)) });
      return new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }));
    }) as never;

  it("échange le code avec le verifier et le bon redirect_uri", async () => {
    const calls: any[] = [];
    const tokens = await authorize({
      endpoints: GOOGLE, clientId: "cid", scopes: ["s1", "s2"], fetch: tokenFetch(calls),
      openUrl: async (url) => {
        const u = new URL(url);
        expect(u.searchParams.get("code_challenge_method")).toBe("S256");
        expect(u.searchParams.get("scope")).toBe("s1 s2");
        const cb = new URL(u.searchParams.get("redirect_uri")!);
        cb.searchParams.set("code", "CODE");
        cb.searchParams.set("state", u.searchParams.get("state")!);
        await fetch(cb);
      },
    });
    expect(tokens).toMatchObject({ accessToken: "AT", refreshToken: "RT" });
    expect(calls[0].body).toMatchObject({ grant_type: "authorization_code", code: "CODE", client_id: "cid" });
    expect(calls[0].body.code_verifier.length).toBeGreaterThan(40);
    expect(calls[0].body.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("rejette un state falsifié sans appeler le jeton", async () => {
    const calls: any[] = [];
    await expect(
      authorize({
        endpoints: GOOGLE, clientId: "cid", scopes: [], fetch: tokenFetch(calls),
        openUrl: async (url) => {
          const cb = new URL(new URL(url).searchParams.get("redirect_uri")!);
          cb.searchParams.set("code", "CODE");
          cb.searchParams.set("state", "forgé");
          await fetch(cb);
        },
      }),
    ).rejects.toThrow(/state/);
    expect(calls).toHaveLength(0);
  });

  it("remonte un refus utilisateur et expire au bout du délai", async () => {
    await expect(
      authorize({
        endpoints: GOOGLE, clientId: "c", scopes: [],
        openUrl: async (url) => {
          const cb = new URL(new URL(url).searchParams.get("redirect_uri")!);
          cb.searchParams.set("error", "access_denied");
          await fetch(cb);
        },
      }),
    ).rejects.toThrow(/refusée/);
    await expect(authorize({ endpoints: GOOGLE, clientId: "c", scopes: [], openUrl: () => {}, timeoutMs: 50 })).rejects.toThrow(/Délai/);
  });

  it("refresh : conserve l'ancien refresh token, signale une révocation", async () => {
    const ok = (async () => new Response(JSON.stringify({ access_token: "N", expires_in: 10 }))) as never;
    expect((await refreshTokens(GOOGLE, "c", undefined, "OLD", ok)).refreshToken).toBe("OLD");
    const revoked = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as never;
    await expect(refreshTokens(GOOGLE, "c", undefined, "OLD", revoked)).rejects.toMatchObject({ reauth: true });
    expect(OAuthError).toBeDefined();
  });
});

describe("GmailClient", () => {
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });

  it("rafraîchit le jeton après un 401 puis réessaie", async () => {
    const seen: string[] = [];
    const c = new GmailClient({
      getAccessToken: async () => "old", refreshAccessToken: async () => "new",
      fetch: (async (_u: string, i: RequestInit) => {
        const a = (i.headers as any).authorization; seen.push(a);
        return a === "Bearer new" ? json({ emailAddress: "a@b.c", historyId: 7 }) : json({}, 401);
      }) as never,
    });
    expect(await c.profile()).toEqual({ email: "a@b.c", historyId: "7" });
    expect(seen).toEqual(["Bearer old", "Bearer new"]);
  });

  it("réessaie sur 429 en respectant Retry-After, puis abandonne", async () => {
    let n = 0; const waits: number[] = [];
    const c = new GmailClient({
      getAccessToken: async () => "t", sleep: async (ms) => void waits.push(ms),
      fetch: (async () => (++n < 3 ? new Response("", { status: 429, headers: { "retry-after": "2" } }) : json({ emailAddress: "x", historyId: 1 }))) as never,
    });
    await c.profile();
    expect(waits).toEqual([2000, 2000]);
    const dead = new GmailClient({ getAccessToken: async () => "t", sleep: async () => {}, fetch: (async () => new Response("", { status: 503 })) as never });
    await expect(dead.profile()).rejects.toBeInstanceOf(GmailError);
  });

  it("pagine la liste et agrège l'historique (ajouts puis suppressions)", async () => {
    const c = new GmailClient({
      getAccessToken: async () => "t",
      fetch: (async (u: string) => {
        if (u.includes("/messages?")) return u.includes("pageToken=p2") ? json({ messages: [{ id: "c" }] }) : json({ messages: [{ id: "a" }, { id: "b" }], nextPageToken: "p2" });
        return json({ historyId: "99", history: [
          { messagesAdded: [{ message: { id: "x" } }, { message: { id: "y" } }] },
          { messagesDeleted: [{ message: { id: "y" } }] },
        ] });
      }) as never,
    });
    expect(await c.listIds("q", 10)).toEqual(["a", "b", "c"]);
    expect(await c.changesSince("1")).toEqual({ added: ["x"], deleted: ["y"], historyId: "99" });
  });

  it("history 404 → HistoryExpiredError ; message 404 → null", async () => {
    const c = new GmailClient({ getAccessToken: async () => "t", fetch: (async () => json({}, 404)) as never });
    await expect(c.changesSince("1")).rejects.toBeInstanceOf(HistoryExpiredError);
    expect(await c.getMessage("gone")).toBeNull();
  });
});
