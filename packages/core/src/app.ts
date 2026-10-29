import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { audit, openDatabase, type Db } from "@assistant/db";
import { migrateSettings, exportSettings, type Settings } from "@assistant/schemas";
import { createProvider } from "@assistant/ai";
import { buildProviders, buildRouter, usageTotals } from "./ai";
import { DocumentPipeline } from "./documents/pipeline";
import { CalendarService } from "./calendar";
import type { Feature } from "./google";
import { MailService } from "./mail";
import { search } from "./search";
import { registerChat, type Notify } from "./chat";
import { RpcError, RpcServer } from "./rpc";

/** Construit le serveur RPC. La base n'est ouverte qu'après `init` (clé fournie par le shell). */
export interface AppOptions {
  fetch?: typeof fetch;
  notify?: Notify;
  /** Ouvre une URL dans le navigateur système (injecté par le sidecar). */
  openUrl?: (url: string) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export function createApp(opts: AppOptions = {}): RpcServer {
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

  const notify = opts.notify ?? (() => {});
  const getRouter = () => {
    const settings = loadSettings();
    const providers = buildProviders(settings, keys, opts.fetch);
    return Object.keys(providers).length ? buildRouter(need(), settings, providers) : null;
  };
  let pipeline: DocumentPipeline | null = null;
  const docs = () => (pipeline ??= new DocumentPipeline({ db: need(), settings: loadSettings, router: getRouter, notify }));

  const parseDoc = (r: any) => ({
    ...r,
    warnings: JSON.parse(r.warnings),
    tags: JSON.parse(r.tags),
    entities: JSON.parse(r.entities),
    dates: JSON.parse(r.dates),
  });
  const DOC_COLS = "id, name, path, ext, size, status, error, warnings, summary, tags, entities, dates, created_at AS createdAt, indexed_at AS indexedAt";

  rpc.register("documents.add", async (p: { paths: string[] }) => {
    const results: { path: string; id?: string; duplicate?: boolean; error?: string }[] = [];
    for (const path of (p.paths ?? []).slice(0, 200)) {
      try {
        results.push({ path, ...(await docs().add(path)) });
      } catch (e) {
        results.push({ path, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return results;
  });
  rpc.register("documents.list", () =>
    need().prepare(`SELECT ${DOC_COLS} FROM documents ORDER BY created_at DESC`).all().map(parseDoc),
  );
  rpc.register("documents.get", (p: { id: string }) => {
    const r = need().prepare(`SELECT ${DOC_COLS} FROM documents WHERE id = ?`).get(p.id);
    if (!r) throw new RpcError(-32602, "Document introuvable");
    return parseDoc(r);
  });
  rpc.register("documents.delete", (p: { id: string }) => (docs().remove(p.id), { ok: true }));
  rpc.register("documents.reindex", (p: { id: string }) => (docs().reindex(p.id), { ok: true }));

  let mailSvc: MailService | null = null;
  const mail = () =>
    (mailSvc ??= new MailService({
      db: need(),
      fetch: opts.fetch,
      notify,
      sleep: opts.sleep,
      openUrl: opts.openUrl ?? (() => { throw new Error("Ouverture du navigateur indisponible"); }),
    }));

  rpc.register("google.config.get", () => {
    const c = mail().getGoogleConfig();
    return { clientId: c?.clientId ?? "", hasSecret: !!c?.clientSecret };
  });
  rpc.register("google.config.set", (p: { clientId: string; clientSecret?: string }) => (mail().setGoogleConfig(p), { ok: true }));
  rpc.register("accounts.list", () => mail().listAccounts());
  let calSvc: CalendarService | null = null;
  const cal = () =>
    (calSvc ??= new CalendarService({ db: need(), auth: mail().auth, fetch: opts.fetch, notify, sleep: opts.sleep }));

  rpc.register("accounts.connectGoogle", async (p: { mail?: boolean; calendar?: boolean; loginHint?: string }) => {
    const features: Feature[] = [...(p.mail === false ? [] : ["mail" as const]), ...(p.calendar ? ["calendar" as const] : [])];
    const acc = await mail().connectGoogle(features, p.loginHint);
    mail().startSync(acc.id);
    cal().startSync(acc.id);
    return acc;
  });
  rpc.register("accounts.remove", (p: { id: string }) => (mail().removeAccount(p.id), { ok: true }));
  rpc.register("mail.sync", (p: { accountId?: string }) => {
    const ids = p.accountId ? [p.accountId] : (mail().listAccounts() as { id: string }[]).map((a) => a.id);
    return { started: ids.filter((id) => mail().startSync(id)).length };
  });
  rpc.register("calendar.sync", (p: { accountId?: string }) => {
    const ids = p.accountId ? [p.accountId] : (mail().listAccounts() as { id: string }[]).map((a) => a.id);
    return { started: ids.filter((id) => cal().startSync(id)).length };
  });
  rpc.register("calendar.list", (p: { from: number; to: number }) => cal().list(Number(p.from), Number(p.to)));
  rpc.register("calendar.get", (p: { id: string }) => cal().get(p.id));
  rpc.register("calendar.create", (p: any) => cal().create(p));
  rpc.register("calendar.update", (p: any) => cal().update(p.id, p));
  rpc.register("calendar.delete", (p: { id: string }) => (cal().delete(p.id), { ok: true }));

  rpc.register("mail.list", (p: any) => mail().list(p ?? {}));
  rpc.register("mail.get", (p: { id: string }) => mail().get(p.id));

  rpc.register("search.query", async (p: { q: string; limit?: number }) =>
    search(need(), getRouter(), String(p.q ?? "").slice(0, 500), Math.min(p.limit ?? 20, 50)),
  );

  registerChat({ rpc, db: need, settings: loadSettings, keys, fetch: opts.fetch, notify });

  rpc.register("audit.list", (p: { limit?: number }) =>
    need()
      .prepare("SELECT id, at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(Math.min(p.limit ?? 50, 500)),
  );

  return rpc;
}
