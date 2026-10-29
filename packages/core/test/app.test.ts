import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src";

async function call(rpc: ReturnType<typeof createApp>, method: string, params?: unknown) {
  const out = await rpc.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  return JSON.parse(out!);
}

describe("rpc app", () => {
  it("refuse tout accès avant init", async () => {
    const r = await call(createApp(), "settings.get");
    expect(r.error.code).toBe(-32001);
  });

  it("répond à ping, rejette JSON invalide et méthode inconnue", async () => {
    const rpc = createApp();
    expect((await call(rpc, "ping")).result).toBe("pong");
    expect(JSON.parse((await rpc.handleLine("{pas json"))!).error.code).toBe(-32700);
    expect((await call(rpc, "nope")).error.code).toBe(-32601);
  });

  it("ne répond pas aux notifications", async () => {
    expect(await createApp().handleLine('{"jsonrpc":"2.0","method":"ping"}')).toBeNull();
  });

  it("init, lit/écrit les settings et journalise", async () => {
    const rpc = createApp();
    const dataDir = mkdtempSync(join(tmpdir(), "app-"));
    expect((await call(rpc, "init", { dataDir, key: "k" })).result.ok).toBe(true);
    expect((await call(rpc, "init", { dataDir, key: "k" })).error.code).toBe(-32002);
    const s = (await call(rpc, "settings.get")).result;
    expect(s.agent.autonomy).toBe("propose");
    s.agent.autonomy = "observe";
    expect((await call(rpc, "settings.set", { settings: s })).result.agent.autonomy).toBe("observe");
    expect((await call(rpc, "settings.set", { settings: { agent: { syncIntervalMinutes: 0 } } })).error).toBeDefined();
    const log = (await call(rpc, "audit.list", {})).result;
    expect(log[0].action).toBe("settings.update");
  });

  it("empêche la traversée de chemin dans le nom de profil", async () => {
    const rpc = createApp();
    const dataDir = mkdtempSync(join(tmpdir(), "app-"));
    const r = await call(rpc, "init", { dataDir, key: "k", profile: "../../evil" });
    expect(r.result.ok).toBe(true); // nom assaini en "evil"
  });
});

describe("rpc ai", () => {
  it("teste la connexion avec la clé en mémoire, sans jamais la renvoyer", async () => {
    let auth = "";
    const rpc = createApp({
      fetch: (async (_u: string, init: RequestInit) => {
        auth = (init.headers as Record<string, string>)["x-api-key"] ?? "";
        return new Response("{}");
      }) as never,
    });
    await call(rpc, "init", { dataDir: mkdtempSync(join(tmpdir(), "app-")), key: "k" });
    const s = (await call(rpc, "settings.get")).result;
    s.ai.providers = { claude: { kind: "anthropic" } };
    await call(rpc, "settings.set", { settings: s });

    expect((await call(rpc, "ai.test", { provider: "claude" })).result).toEqual({
      ok: false,
      error: "Aucune clé API enregistrée",
    });
    await call(rpc, "ai.setKeys", { keys: { claude: "sk-ant-secret" } });
    const status = await call(rpc, "ai.status");
    expect(status.result.providers).toEqual([{ id: "claude", hasKey: true }]);
    expect(JSON.stringify(status)).not.toContain("sk-ant-secret");
    expect((await call(rpc, "ai.test", { provider: "claude" })).result).toEqual({ ok: true });
    expect(auth).toBe("sk-ant-secret");
    expect((await call(rpc, "ai.test", { provider: "inconnu" })).error).toBeDefined();
  });
});

describe("rpc chat", () => {
  const sseBody = (...texts: string[]) =>
    new Response(
      [
        { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 1 } } },
        ...texts.map((t) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })),
        { type: "message_delta", usage: { output_tokens: 2 } },
      ]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join(""),
    );

  async function setup(fetchImpl: typeof fetch) {
    const events: any[] = [];
    const rpc = createApp({ fetch: fetchImpl, notify: (m, p) => events.push({ m, ...(p as object) }) });
    await call(rpc, "init", { dataDir: mkdtempSync(join(tmpdir(), "app-")), key: "k" });
    const s = (await call(rpc, "settings.get")).result;
    s.ai.providers = { claude: { kind: "anthropic" } };
    s.ai.routes = { chat: { primary: { provider: "claude", model: "m" } } };
    await call(rpc, "settings.set", { settings: s });
    await call(rpc, "ai.setKeys", { keys: { claude: "k" } });
    const done = (id: string) =>
      new Promise<void>((res) => {
        const t = setInterval(() => events.some((e) => e.streamId === id && e.type === "done") && (clearInterval(t), res()), 5);
      });
    return { rpc, events, done };
  }

  it("diffuse la réponse, la persiste et enregistre l'historique", async () => {
    const { rpc, events, done } = await setup((async () => sseBody("Bon", "jour")) as never);
    const r = (await call(rpc, "chat.send", { streamId: "s1", text: "Salut" })).result;
    await done("s1");
    expect(events.filter((e) => e.type === "text").map((e) => e.text).join("")).toBe("Bonjour");
    const msgs = (await call(rpc, "chat.get", { id: r.conversationId })).result;
    expect(msgs.map((m: any) => [m.role, m.content])).toEqual([["user", "Salut"], ["assistant", "Bonjour"]]);
    expect((await call(rpc, "chat.list")).result[0].title).toBe("Salut");
  });

  it("envoie l'historique au tour suivant", async () => {
    const bodies: any[] = [];
    const { rpc, done } = await setup((async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return sseBody("ok");
    }) as never);
    const r = (await call(rpc, "chat.send", { streamId: "a", text: "un" })).result;
    await done("a");
    await call(rpc, "chat.send", { streamId: "b", conversationId: r.conversationId, text: "deux" });
    await done("b");
    expect(bodies[1].messages.map((m: any) => m.content)).toEqual(["un", "ok", "deux"]);
    expect(bodies[1].system).toContain("DONNÉE");
  });

  it("signale une erreur API sans planter", async () => {
    const { rpc, events, done } = await setup((async () => new Response("no", { status: 401 })) as never);
    await call(rpc, "chat.send", { streamId: "e", text: "x" });
    await done("e");
    expect(events.find((e) => e.type === "error")?.message).toContain("401");
  });

  it("refuse l'envoi sans route ou sans clé", async () => {
    const rpc = createApp();
    await call(rpc, "init", { dataDir: mkdtempSync(join(tmpdir(), "app-")), key: "k" });
    expect((await call(rpc, "chat.send", { streamId: "x", text: "hi" })).error.code).toBe(-32010);
    expect((await call(rpc, "chat.send", { streamId: "y", text: "  " })).error.code).toBe(-32602);
  });

  it("annule un flux en cours en conservant le texte reçu", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const enc = new TextEncoder();
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const stream = new ReadableStream({
        async start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "début" } })}\n\n`));
          await gate;
          if (init.signal?.aborted) c.error(new DOMException("abort", "AbortError"));
          else c.close();
        },
      });
      init.signal?.addEventListener("abort", release);
      return new Response(stream);
    }) as never;
    const { rpc, events, done } = await setup(fetchImpl);
    const r = (await call(rpc, "chat.send", { streamId: "c", text: "long" })).result;
    await new Promise((r) => setTimeout(r, 50));
    await call(rpc, "chat.cancel", { streamId: "c" });
    await done("c");
    expect(events.find((e) => e.type === "done").cancelled).toBe(true);
    const msgs = (await call(rpc, "chat.get", { id: r.conversationId })).result;
    expect(msgs.at(-1).content).toBe("début");
  });
});
