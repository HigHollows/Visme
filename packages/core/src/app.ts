import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { audit, openDatabase, type Db } from "@assistant/db";
import { migrateSettings, exportSettings, type Settings } from "@assistant/schemas";
import { createProvider } from "@assistant/ai";
import { buildProviders, buildRouter, usageTotals } from "./ai";
import { DocumentPipeline } from "./documents/pipeline";
import { Agent } from "./agent/agent";
import { CalendarService } from "./calendar";
import { handleObligations } from "./agent/obligations";
import { DeadlineService } from "./deadlines";
import type { Feature } from "./google";
import { AccountService } from "./accounts";
import type { MsFeature } from "./microsoft";
import { MailService } from "./mail";
import { MemoryService } from "./memory";
import { PresetService } from "./presets";
import { DraftService, StyleService } from "./style";
import { PluginManager } from "./plugins/manager";
import { MeetingService } from "./meetings/service";
import { AdminService } from "./admin";
import { WatchService } from "./watch";
import { CaptureService } from "./capture";
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
  /** Pour les tests : faux serveurs IMAP / CalDAV. */
  imapFactory?: import("@assistant/connectors").ImapFactory;
  dav?: (cfg: import("@assistant/connectors").CalDavConfig) => Promise<import("@assistant/connectors").DavLike>;
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
  let dataDirPath = "";
  let bundledPluginsDir: string | undefined;
  const need = (): Db => {
    if (!db) throw new RpcError(-32001, "Application non initialisée");
    return db;
  };

  rpc.register("ping", () => "pong");

  rpc.register("init", (p: { dataDir: string; key: string; profile?: string; bundledPluginsDir?: string; readOnly?: boolean }) => {
    if (db) throw new RpcError(-32002, "Déjà initialisée");
    const profile = (p.profile ?? "default").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!profile) throw new RpcError(-32602, "Nom de profil invalide");
    mkdirSync(p.dataDir, { recursive: true });
    dataDirPath = p.dataDir;
    bundledPluginsDir = p.bundledPluginsDir;
    dbFile = join(p.dataDir, `${profile}.db`);
    db = openDatabase(dbFile, { key: p.key });
    if (p.readOnly) {
      // Vue combinée : ce sidecar n'a ni agent, ni clés, ni accès réseau, et ne répond qu'à « overview ».
      rpc.setGuard((m) => (m === "overview" || m === "ping" ? null : "Profil ouvert en lecture seule"));
      return { ok: true };
    }
    agent().configure();
    watcher().startAll();
    return { ok: true };
  });

  const loadSettings = (): Settings => {
    const row = need().prepare("SELECT value FROM kv WHERE key='settings'").get() as { value: string } | undefined;
    return migrateSettings(row ? JSON.parse(row.value) : {});
  };

  const saveSettings = (s: Settings) => {
    need().prepare("INSERT INTO kv(key,value) VALUES('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(s));
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

  /** Importe des réglages exportés : validés par le schéma ; les clés API ne sont jamais importées (elles n'existent pas dans l'export). */
  rpc.register("settings.import", (p: { json: string }) => {
    let raw: unknown;
    try { raw = JSON.parse(p.json); } catch { throw new RpcError(-32602, "Fichier JSON illisible"); }
    const s = migrateSettings(raw);
    const d = need();
    d.prepare("INSERT INTO kv(key,value) VALUES('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(s));
    audit(d, "user", "settings.import");
    agent().configure();
    return s;
  });
  rpc.register("settings.reset", () => {
    const d = need();
    d.prepare("DELETE FROM kv WHERE key='settings'").run();
    audit(d, "user", "settings.reset");
    agent().configure();
    return loadSettings();
  });

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
  const docs = () =>
    (pipeline ??= new DocumentPipeline({
      db: need(), settings: loadSettings, router: getRouter, notify,
      onIndexed: (doc) => plugins().emit("document.indexed", doc),
      onObligations: (doc, obligations) => {
        const a = loadSettings().agent;
        handleObligations(
          { db: need(), deadlines: deadlines(), proposals: proposals(), autonomy: a.autonomy, threshold: a.eventConfidenceThreshold },
          obligations, { ref: { type: "document", id: doc.id }, key: null, label: `Document « ${doc.name} »` },
        );
        notify("proposals.event", { pending: proposals().count() });
      },
    }));

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

  let accountSvc: AccountService | null = null;
  const accounts = () =>
    (accountSvc ??= new AccountService({
      db: need(), fetch: opts.fetch, sleep: opts.sleep, imapFactory: opts.imapFactory, dav: opts.dav,
      openUrl: opts.openUrl ?? (() => { throw new Error("Ouverture du navigateur indisponible"); }),
    }));
  let mailSvc: MailService | null = null;
  const mail = () =>
    (mailSvc ??= new MailService({
      db: need(), accounts: accounts(), dataDir: () => dataDirPath, settings: loadSettings, notify, fetch: opts.fetch, now: opts.now,
      documents: { add: (path, o) => docs().add(path, o) },
    }));
  let calSvc: CalendarService | null = null;
  const cal = () => (calSvc ??= new CalendarService({ db: need(), accounts: accounts(), settings: loadSettings, notify }));

  rpc.register("google.config.get", () => {
    const c = accounts().getGoogleConfig();
    return { clientId: c?.clientId ?? "", hasSecret: !!c?.clientSecret };
  });
  rpc.register("google.config.set", (p: { clientId: string; clientSecret?: string }) => (accounts().setGoogleConfig(p), { ok: true }));
  rpc.register("microsoft.config.get", () => {
    const c = accounts().getMicrosoftConfig();
    return { clientId: c?.clientId ?? "", tenant: c?.tenant ?? "common" };
  });
  rpc.register("microsoft.config.set", (p: { clientId: string; tenant?: string }) => (accounts().setMicrosoftConfig(p), { ok: true }));
  rpc.register("accounts.list", () => accounts().list());

  const startSyncs = (id: string) => {
    mail().startSync(id);
    cal().startSync(id);
  };
  rpc.register("accounts.connectGoogle", async (p: { mail?: boolean; calendar?: boolean; send?: boolean; calendarWrite?: boolean; loginHint?: string }) => {
    const features: Feature[] = [
      ...(p.mail === false ? [] : ["mail" as const]),
      ...(p.send ? ["send" as const] : []),
      ...(p.calendar || p.calendarWrite ? ["calendar" as const] : []),
      ...(p.calendarWrite ? ["calendarWrite" as const] : []),
    ];
    const acc = await accounts().connectGoogle(features, p.loginHint);
    startSyncs(acc.id);
    return acc;
  });
  rpc.register("accounts.connectMicrosoft", async (p: { mail?: boolean; calendar?: boolean; send?: boolean; calendarWrite?: boolean; loginHint?: string }) => {
    const features: MsFeature[] = [
      ...(p.mail === false ? [] : ["mail" as const]),
      ...(p.send ? ["send" as const] : []),
      ...(p.calendar || p.calendarWrite ? ["calendar" as const] : []),
      ...(p.calendarWrite ? ["calendarWrite" as const] : []),
    ];
    const acc = await accounts().connectMicrosoft(features, p.loginHint);
    startSyncs(acc.id);
    return acc;
  });
  rpc.register("accounts.addImap", async (p: any) => {
    const acc = await accounts().addImap(p);
    startSyncs(acc.id);
    return acc;
  });
  rpc.register("accounts.addCalDav", async (p: any) => {
    const acc = await accounts().addCalDav(p);
    startSyncs(acc.id);
    return acc;
  });
  rpc.register("accounts.remove", (p: { id: string }) => {
    // Si les événements étaient écrits vers ce compte, on retire le réglage pour ne pas pointer dans le vide.
    const s = loadSettings();
    if (s.calendar.writeTo === p.id) saveSettings({ ...s, calendar: { writeTo: null } });
    accounts().remove(p.id);
    return { ok: true };
  });
  rpc.register("mail.sync", (p: { accountId?: string }) => {
    const ids = p.accountId ? [p.accountId] : accounts().list().map((a) => a.id);
    return { started: ids.filter((id) => mail().startSync(id)).length };
  });
  rpc.register("mail.importAttachments", (p: { id: string }) => mail().importAttachments(p.id));
  rpc.register("calendar.sync", (p: { accountId?: string }) => {
    const ids = p.accountId ? [p.accountId] : accounts().list().map((a) => a.id);
    return { started: ids.filter((id) => cal().startSync(id)).length };
  });
  rpc.register("calendar.list", (p: { from: number; to: number }) => cal().list(Number(p.from), Number(p.to)));
  rpc.register("calendar.get", (p: { id: string }) => cal().get(p.id));
  rpc.register("calendar.create", (p: any) => cal().create(p));
  rpc.register("calendar.update", (p: any) => cal().update(p.id, p));
  rpc.register("calendar.delete", (p: { id: string }) => (cal().delete(p.id), { ok: true }));

  let tasksSvc: TaskService | null = null;
  const tasks = () => (tasksSvc ??= new TaskService(need()));
  const tasks_ = tasks;
  let deadlineSvc: DeadlineService | null = null;
  const deadlines = () => (deadlineSvc ??= new DeadlineService(need(), cal(), tasks()));
  let proposalSvc: ProposalService | null = null;
  const proposals = () => (proposalSvc ??= new ProposalService(need(), cal(), tasks(), deadlines()));
  let undoSvc: UndoService | null = null;
  const undo = () => (undoSvc ??= new UndoService(need(), cal(), tasks()));
  let agentSvc: Agent | null = null;
  const agent = () =>
    (agentSvc ??= new Agent({
      db: need(), settings: loadSettings, router: getRouter, mail: mail(), cal: cal(), tasks: tasks(), proposals: proposals(), deadlines: deadlines(), memory: memory(),
      emit: (e, p) => plugins().emit(e, p),
      notify, now: opts.now, setTimer: opts.setTimer, clearTimer: opts.clearTimer,
    }));

  let memSvc: MemoryService | null = null;
  const memory = () => (memSvc ??= new MemoryService(need()));
  let presetSvc: PresetService | null = null;
  const presets = () => (presetSvc ??= new PresetService(need()));

  let pluginSvc: PluginManager | null = null;
  const plugins = () =>
    (pluginSvc ??= new PluginManager({
      db: need(), pluginsDir: join(dataDirPath, "plugins"), bundledDir: bundledPluginsDir, settings: loadSettings,
      router: getRouter, memory, proposals, cal, fetch: opts.fetch,
    }));

  let meetingSvc: MeetingService | null = null;
  const meetings = () =>
    (meetingSvc ??= new MeetingService({
      db: need(), dataDir: dataDirPath, settings: loadSettings, router: getRouter, tasks: tasks(), cal: cal(), proposals: proposals(),
      documents: { add: (p) => docs().add(p), remove: (id) => docs().remove(id) }, notify, now: opts.now,
    }));

  rpc.register("meetings.list", () => meetings().list());
  rpc.register("meetings.get", (p: { id: string }) => meetings().get(p.id));
  rpc.register("meetings.start", (p: { title?: string; language?: string; consent: boolean }) => meetings().start(p));
  rpc.register("meetings.segment", (p: any) => meetings().addSegment(p));
  rpc.register("meetings.finish", (p: { id: string; durationMs: number }) => (meetings().finish(p.id, p.durationMs), { ok: true }));
  rpc.register("meetings.import", (p: { path: string; title?: string }) => meetings().import(p.path, p.title));
  rpc.register("meetings.rename", (p: { id: string; title: string }) => (meetings().rename(p.id, p.title), { ok: true }));
  rpc.register("meetings.delete", (p: { id: string }) => (meetings().delete(p.id), { ok: true }));
  rpc.register("meetings.deleteAudio", (p: { id: string }) => (meetings().deleteAudio(p.id), { ok: true }));
  rpc.register("meetings.retry", (p: { id: string }) => (meetings().retry(p.id), { ok: true }));
  rpc.register("meetings.reprocess", (p: { id: string }) => {
    void meetings().reprocess(p.id).catch(() => {});
    return { started: true };
  });

  let captureSvc: CaptureService | null = null;
  const capture = () =>
    (captureSvc ??= new CaptureService({ db: need(), dataDir: dataDirPath, settings: loadSettings, router: getRouter, tasks: tasks(), cal: cal(), proposals: proposals(), documents: { add: (p) => docs().add(p) }, now: opts.now }));
  rpc.register("capture.submit", async (p: any) => {
    const r = await capture().submit(p ?? {});
    notify("proposals.event", { pending: proposals().count() });
    return r;
  });

  let dbFile = "";
  let watchSvc: WatchService | null = null;
  const watcher = () => (watchSvc ??= new WatchService({ db: need(), add: (p) => docs().add(p), notify }));
  let adminSvc: AdminService | null = null;
  const admin = () => (adminSvc ??= new AdminService(need(), () => dbFile));

  rpc.register("watch.list", () => watcher().list());
  rpc.register("watch.add", (p: { path: string }) => (watcher().add(p.path), { ok: true }));
  rpc.register("watch.remove", (p: { path: string }) => (watcher().remove(p.path), { ok: true }));
  rpc.register("watch.scan", async (p: { path?: string }) => {
    const dirs = p?.path ? [p.path] : watcher().list().map((f) => f.path);
    let n = 0;
    for (const d of dirs) n += await watcher().scan(d);
    return { candidates: n };
  });

  rpc.register("privacy.export", (p: { path: string }) => admin().exportAll(String(p.path), exportSettings(loadSettings())));
  rpc.register("diagnostics.get", () => admin().diagnostics());
  rpc.register("memory.stats", () => admin().memoryStats());
  rpc.register("memory.export", () => admin().memoryExport());
  rpc.register("memory.import", (p: { data: unknown }) => admin().memoryImport(p.data));

  let styleSvc: StyleService | null = null;
  const style = () => (styleSvc ??= new StyleService({ db: need(), settings: loadSettings, router: getRouter }));
  let draftSvc: DraftService | null = null;
  const drafts = () => (draftSvc ??= new DraftService({ db: need(), settings: loadSettings, router: getRouter }, style()));

  registerChat({
    rpc, db: need, settings: loadSettings, keys, fetch: opts.fetch, notify,
    presets, memory, proposals, cal,
    styleHint: () => style().hint(null),
    pluginTools: () => ({ defs: plugins().toolDefs(), call: (n, a) => plugins().callTool(n, a) }),
  });

  rpc.register("plugins.list", () => plugins().list());
  rpc.register("plugins.available", () => plugins().available().map(({ dir: _d, ...rest }) => rest));
  rpc.register("plugins.installBundled", (p: { id: string }) => plugins().installBundled(p.id));
  rpc.register("plugins.installFolder", (p: { path: string }) => plugins().install(p.path));
  rpc.register("plugins.enable", (p: { id: string; permissions: string[] }) => (plugins().enable(p.id, p.permissions ?? []), { ok: true }));
  rpc.register("plugins.disable", (p: { id: string }) => (plugins().disable(p.id), { ok: true }));
  /** Teste un outil de plugin à la main (utile aux auteurs de plugins). */
  rpc.register("plugins.callTool", async (p: { name: string; args?: unknown }) => ({ result: await plugins().callTool(p.name, p.args ?? {}) }));
  rpc.register("plugins.remove", (p: { id: string }) => (plugins().remove(p.id), { ok: true }));

  rpc.register("style.list", () => ({ profiles: style().list(), groups: style().groups(), learningEnabled: loadSettings().style.learningEnabled }));
  rpc.register("style.set", (p: { scope: string; profile: unknown }) => (style().set(p.scope, p.profile, "manual"), { ok: true }));
  rpc.register("style.delete", (p: { scope: string }) => (style().delete(p.scope), { ok: true }));
  rpc.register("style.learn", (p: { scope?: string }) => style().learn(p?.scope ?? "global"));
  rpc.register("style.reset", () => ({ removed: style().resetLearned() }));
  rpc.register("style.setGroup", (p: { addr: string; group: string | null }) => (style().setGroup(p.addr, p.group), { ok: true }));
  rpc.register("drafts.list", (p: { mailId: string }) => drafts().list(p.mailId));
  rpc.register("drafts.reply", (p: any) => drafts().reply(p));
  rpc.register("drafts.update", (p: { id: string; body: string }) => (drafts().update(p.id, p.body), { ok: true }));
  rpc.register("drafts.delete", (p: { id: string }) => (drafts().delete(p.id), { ok: true }));
  /** Envoi d'un brouillon : action sensible, exige `confirm: true`, le réglage « autoriser l'envoi » et un compte autorisé. */
  rpc.register("drafts.send", (p: { draftId: string; to?: string[]; cc?: string[]; subject?: string; confirm: boolean }) => mail().sendDraft(p));

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

  rpc.register("overview", () => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const from = start.getTime();
    const events = (cal().list(from, from + 86_400_000) as { title: string; start: number; allDay: boolean }[]).slice(0, 8).map((e) => ({ title: e.title, start: e.start, allDay: e.allDay }));
    const tasks = (tasks_().list({ status: "open" }) as { title: string; due: number | null }[]).filter((t) => t.due !== null && t.due < from + 86_400_000).slice(0, 8).map((t) => ({ title: t.title, due: t.due }));
    return { events, tasks, pendingProposals: proposals().count() };
  });
  rpc.register("deadlines.list", (p: { status?: "active" | "cancelled" | "paid" }) => deadlines().list(p?.status));
  rpc.register("deadlines.summary", () => ({ ...deadlines().summary(), upcoming: deadlines().upcoming(Math.max(...loadSettings().deadlines.alertDays, 30)) }));
  rpc.register("deadlines.create", (p: any) => deadlines().create(p));
  rpc.register("deadlines.update", (p: any) => deadlines().update(p.id, p));
  rpc.register("deadlines.setStatus", (p: { id: string; status: "active" | "cancelled" | "paid" }) => (deadlines().setStatus(p.id, p.status), { ok: true }));
  rpc.register("deadlines.delete", (p: { id: string }) => (deadlines().delete(p.id), { ok: true }));
  rpc.register("deadlines.checkAlerts", () => {
    const alerts = deadlines().fireAlerts(loadSettings().deadlines.alertDays);
    for (const a of alerts) notify("deadline.alert", a);
    return alerts;
  });

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
  rpc.register("digest.get", (p: { force?: boolean; period?: "day" | "week" }) => agent().digest(!!p?.force, p?.period === "week" ? "week" : "day"));

  rpc.register("mail.list", (p: any) => mail().list(p ?? {}));
  rpc.register("mail.get", (p: { id: string }) => mail().get(p.id));

  rpc.register("search.query", async (p: { q: string; limit?: number }) =>
    search(need(), getRouter(), String(p.q ?? "").slice(0, 500), Math.min(p.limit ?? 20, 50)),
  );


  rpc.register("audit.list", (p: { limit?: number; actor?: string; action?: string; beforeId?: number }) => admin().auditLog(p ?? {}));

  return rpc;
}
