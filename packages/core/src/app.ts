import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { audit, openDatabase, type Db } from "@assistant/db";
import { migrateSettings, exportSettings, type Settings } from "@assistant/schemas";
import { createProvider } from "@assistant/ai";
import { buildProviders, buildRouter, usageTotals } from "./ai";
import { DocumentPipeline } from "./documents/pipeline";
import { Agent } from "./agent/agent";
import { CalendarService } from "./calendar";
import type { Feature } from "./google";
import { MailService } from "./mail";
import { MemoryService } from "./memory";
import { PresetService } from "./presets";
import { ProposalService } from "./proposals";
import { search } from "./search";
import { TaskService } from "./tasks";
import { UndoService } from "./undo";
import { registerChat, type Notify } from "./chat";
import { RpcError, RpcServer } from "./rpc";

/** Construit le serveur RPC. La base n'est ouverte qu'après `init` (clé fournie par le shell). */
export interface AppOptions {
  fetch?: typeof fetch;
  notify?: Notify;
  /** Ouvre une URL dans le navigateur système (injecté par le sidecar). */
  openUrl?: (url: string) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** Pour les tests : horloge et minuteries injectables. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
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
    agent().configure();
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
    agent().configure(); // prend en compte activation, fréquence, autonomie
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

  let tasksSvc: TaskService | null = null;
  const tasks = () => (tasksSvc ??= new TaskService(need()));
  let proposalSvc: ProposalService | null = null;
  const proposals = () => (proposalSvc ??= new ProposalService(need(), cal(), tasks()));
  let undoSvc: UndoService | null = null;
  const undo = () => (undoSvc ??= new UndoService(need(), cal(), tasks()));
  let agentSvc: Agent | null = null;
  const agent = () =>
    (agentSvc ??= new Agent({
      db: need(), settings: loadSettings, router: getRouter, mail: mail(), cal: cal(), tasks: tasks(), proposals: proposals(),
      notify, now: opts.now, setTimer: opts.setTimer, clearTimer: opts.clearTimer,
    }));

  let memSvc: MemoryService | null = null;
  const memory = () => (memSvc ??= new MemoryService(need()));
  let presetSvc: PresetService | null = null;
  const presets = () => (presetSvc ??= new PresetService(need()));

  registerChat({
    rpc, db: need, settings: loadSettings, keys, fetch: opts.fetch, notify,
    presets, memory, proposals, cal,
  });

  rpc.register("presets.list", () => presets().list());
  rpc.register("presets.create", (p: any) => presets().create(p));
  rpc.register("presets.update", (p: any) => presets().update(p.id, p));
  rpc.register("presets.delete", (p: { id: string }) => (presets().delete(p.id), { ok: true }));
  rpc.register("presets.reset", (p: { id: string }) => presets().reset(p.id));

  rpc.register("memory.graph", (p: { types?: string[] }) => {
    memory().rebuild(); // dérivé de l'état courant : toujours à jour, et peu coûteux
    return memory().graph(p ?? {});
  });
  rpc.register("memory.neighbors", (p: { id: string }) => memory().neighbors(p.id, 30));
  rpc.register("memory.addNode", (p: { type: string; label: string }) => ({ id: memory().addNode(p) }));
  rpc.register("memory.renameNode", (p: { id: string; label: string }) => (memory().renameNode(p.id, p.label), { ok: true }));
  rpc.register("memory.addEdge", (p: { src: string; dst: string; rel: string }) => (memory().addEdge(p.src, p.dst, p.rel), { ok: true }));
  rpc.register("memory.deleteEdge", (p: { src: string; dst: string; rel: string }) => (memory().deleteEdge(p.src, p.dst, p.rel), { ok: true }));
  rpc.register("memory.forget", (p: { id: string }) => (memory().forget(p.id), { ok: true }));
  rpc.register("memory.clear", () => (memory().clearAll(), { ok: true }));

  rpc.register("tasks.list", (p: { status?: "open" | "done" }) => tasks().list(p ?? {}));
  rpc.register("tasks.create", (p: any) => tasks().create(p));
  rpc.register("tasks.update", (p: any) => tasks().update(p.id, p));
  rpc.register("tasks.setDone", (p: { id: string; done: boolean }) => tasks().setDone(p.id, !!p.done));
  rpc.register("tasks.delete", (p: { id: string }) => (tasks().delete(p.id), { ok: true }));

  rpc.register("proposals.list", (p: { status?: "pending" | "decided" }) => proposals().list(p?.status ?? "pending"));
  rpc.register("proposals.count", () => ({ pending: proposals().count() }));
  rpc.register("proposals.accept", (p: { id: string; edits?: Record<string, unknown> }) => {
    const r = proposals().accept(p.id, p.edits ?? {});
    notify("proposals.event", { pending: proposals().count() });
    return r;
  });
  rpc.register("proposals.acceptMany", (p: { ids: string[] }) => {
    // Validation groupée : une proposition qui échoue n'empêche pas les autres.
    const out = p.ids.slice(0, 200).map((id) => {
      try { return { id, ...proposals().accept(id) }; } catch (e) { return { id, error: e instanceof Error ? e.message : String(e) }; }
    });
    notify("proposals.event", { pending: proposals().count() });
    return out;
  });
  rpc.register("proposals.reject", (p: { ids: string[] }) => {
    for (const id of p.ids.slice(0, 200)) proposals().reject(id);
    notify("proposals.event", { pending: proposals().count() });
    return { ok: true };
  });

  rpc.register("actions.list", (p: { limit?: number }) => undo().list(p?.limit ?? 50));
  rpc.register("actions.undo", (p: { id: number }) => (undo().undo(Number(p.id)), { ok: true }));

  rpc.register("agent.status", () => agent().status());
  rpc.register("agent.journal", (p: { limit?: number }) => agent().journal(p?.limit ?? 30));
  rpc.register("agent.runNow", () => {
    void agent().cycle("manual").catch(() => {});
    return { started: true };
  });
  rpc.register("agent.reanalyze", (p: { mailId: string }) => (agent().reanalyze(p.mailId), { ok: true }));
  rpc.register("digest.get", (p: { force?: boolean }) => agent().digest(!!p?.force));

  rpc.register("mail.list", (p: any) => mail().list(p ?? {}));
  rpc.register("mail.get", (p: { id: string }) => mail().get(p.id));

  rpc.register("search.query", async (p: { q: string; limit?: number }) =>
    search(need(), getRouter(), String(p.q ?? "").slice(0, 500), Math.min(p.limit ?? 20, 50)),
  );


  rpc.register("audit.list", (p: { limit?: number }) =>
    need()
      .prepare("SELECT id, at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(Math.min(p.limit ?? 50, 500)),
  );

  return rpc;
}
