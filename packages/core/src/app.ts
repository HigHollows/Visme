import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { audit, openDatabase, type Db } from "@assistant/db";
import { migrateSettings, exportSettings, type Settings } from "@assistant/schemas";
import { createProvider } from "@assistant/ai";
import { usageTotals } from "./ai";
import { registerChat, type Notify } from "./chat";
import { RpcError, RpcServer } from "./rpc";

/** Construit le serveur RPC. La base n'est ouverte qu'après `init` (clé fournie par le shell). */
export function createApp(opts: { fetch?: typeof fetch; notify?: Notify } = {}): RpcServer {
  const rpc = new RpcServer();
  /** Clés API en mémoire uniquement ; elles viennent du trousseau via le shell. */
  const keys = new Map<string, string>();
  let db: Db | null = null;
  const need = (): Db => {
    if (!db) throw new RpcError(-32001, "Application non initialisée");
    return db;
  };

  rpc.register("ping", () => "pong");

  rpc.register("init", (p: { dataDir: string; key: string; profile?: string }) => {
    if (db) throw new RpcError(-32002, "Déjà initialisée");
    const profile = (p.profile ?? "default").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!profile) throw new RpcError(-32602, "Nom de profil invalide");
    mkdirSync(p.dataDir, { recursive: true });
    db = openDatabase(join(p.dataDir, `${profile}.db`), { key: p.key });
    return { ok: true };
  });

  const loadSettings = (): Settings => {
    const row = need().prepare("SELECT value FROM kv WHERE key='settings'").get() as { value: string } | undefined;
    return migrateSettings(row ? JSON.parse(row.value) : {});
  };

  rpc.register("settings.get", () => loadSettings());

  rpc.register("settings.set", (p: { settings: unknown }) => {
    const s = migrateSettings(p.settings); // validation par schéma
    const d = need();
    const before = loadSettings();
    d.prepare("INSERT INTO kv(key,value) VALUES('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
      JSON.stringify(s),
    );
    audit(d, "user", "settings.update", undefined, { settings: before });
    return s;
  });

  rpc.register("settings.export", () => exportSettings(loadSettings()));

  rpc.register("ai.setKeys", (p: { keys: Record<string, string> }) => {
    for (const [id, k] of Object.entries(p.keys)) {
      if (k) keys.set(id, k);
      else keys.delete(id);
    }
    return { configured: [...keys.keys()] };
  });

  rpc.register("ai.status", () => {
    const s = loadSettings();
    return {
      providers: Object.keys(s.ai.providers).map((id) => ({ id, hasKey: keys.has(id) })),
      usage: usageTotals(need()),
    };
  });

  rpc.register("ai.test", async (p: { provider: string }) => {
    const cfg = loadSettings().ai.providers[p.provider];
    if (!cfg) throw new RpcError(-32602, "Fournisseur inconnu");
    const key = keys.get(p.provider);
    if (!key) return { ok: false, error: "Aucune clé API enregistrée" };
    return createProvider(p.provider, cfg, key, opts.fetch).testConnection();
  });

  registerChat({ rpc, db: need, settings: loadSettings, keys, fetch: opts.fetch, notify: opts.notify ?? (() => {}) });

  rpc.register("audit.list", (p: { limit?: number }) =>
    need()
      .prepare("SELECT id, at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(Math.min(p.limit ?? 50, 500)),
  );

  return rpc;
}
