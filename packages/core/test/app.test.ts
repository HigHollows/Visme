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
