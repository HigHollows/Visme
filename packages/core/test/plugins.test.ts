import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@assistant/db";
import { migrateSettings } from "@assistant/schemas";
import { describe, expect, it, vi } from "vitest";
import { CalendarService, MemoryService, PluginManager, ProposalService, TaskService, DeadlineService, isPrivateAddress } from "../src";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function makePlugin(opts: { manifest?: object; code?: string; files?: Record<string, string> } = {}) {
  const dir = tmp("plug-");
  const manifest = { id: "demo", name: "Démo", version: "1.0.0", permissions: [], tools: [{ name: "run", description: "Exécute", parameters: { type: "object", properties: {} } }], triggers: [], entry: "index.mjs", ...opts.manifest };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "index.mjs"), opts.code ?? "export default { tools: { run: async () => 'ok' } };");
  for (const [f, c] of Object.entries(opts.files ?? {})) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), c); }
  return dir;
}

function setup(over: Partial<ConstructorParameters<typeof PluginManager>[0]> = {}) {
  const db = openDatabase(join(tmp("pm-"), "t.db"), { key: "k" });
  const cal = new CalendarService({ db, auth: {} as never, notify: () => {} });
  const tasks = new TaskService(db);
  const proposals = new ProposalService(db, cal, tasks, new DeadlineService(db, cal, tasks));
  const memory = new MemoryService(db);
  const settings = migrateSettings({});
  const m = new PluginManager({ db, pluginsDir: join(tmp("pd-"), "plugins"), settings: () => settings, router: () => null, memory: () => memory, proposals: () => proposals, cal: () => cal, timeoutMs: 15_000, ...over });
  return { db, m, proposals, memory };
}

const enable = (m: PluginManager, id = "demo") => m.enable(id, (m.list().find((p) => p.id === id)!).permissions);

describe("installation", () => {
  it("installe désactivé, exige le consentement exact aux permissions", () => {
    const { m } = setup();
    const v = m.install(makePlugin({ manifest: { permissions: ["ai", "mail:read"] } }));
    expect(v).toMatchObject({ enabled: false, needsConsent: true, permissions: ["ai", "mail:read"] });
    expect(() => m.enable("demo", ["ai"])).toThrow(/ne correspondent pas/);
    expect(() => m.enable("demo", ["ai", "mail:read", "calendar:read"])).toThrow(/ne correspondent pas/);
    m.enable("demo", ["mail:read", "ai"]);
    expect(m.list()[0]).toMatchObject({ enabled: true, needsConsent: false, granted: ["ai", "mail:read"] });
    m.disable("demo");
    expect(m.list()[0]!.enabled).toBe(false);
    m.remove("demo");
    expect(m.list()).toEqual([]);
  });

  it("refuse manifeste invalide, entrée absente ou hors dossier, liens symboliques, plugin trop gros", () => {
    const { m } = setup();
    expect(() => m.install(makePlugin({ manifest: { id: "Mauvais ID!" } }))).toThrow(/Manifeste invalide/);
    expect(() => m.install(makePlugin({ manifest: { permissions: ["root"] } }))).toThrow(/permission inconnue/);
    expect(() => m.install(makePlugin({ manifest: { entry: "../evil.mjs" } }))).toThrow(/Manifeste invalide/);
    expect(() => m.install(makePlugin({ manifest: { entry: "absent.mjs" } }))).toThrow(/introuvable/);
    expect(() => m.install(makePlugin({ manifest: { tools: [{ name: "a__b", description: "x" }] } }))).toThrow(/Manifeste invalide/);
    const withLink = makePlugin();
    symlinkSync("/etc/hosts", join(withLink, "lien"));
    expect(() => m.install(withLink)).toThrow(/Lien symbolique/);
    const big = makePlugin({ files: { "gros.bin": "x".repeat(6 * 1024 * 1024) } });
    expect(() => m.install(big)).toThrow(/trop volumineux/);
    expect(() => m.install(tmp("vide-"))).toThrow(/manifest.json/);
  });

  it("mise à jour : version supérieure obligatoire ; permissions élargies → reconsentement", () => {
    const { m } = setup();
    m.install(makePlugin({ manifest: { permissions: ["ai"] } }));
    enable(m);
    expect(() => m.install(makePlugin({ manifest: { permissions: ["ai"] } }))).toThrow(/déjà installée/);
    m.install(makePlugin({ manifest: { version: "1.1.0", permissions: ["ai"] } }));
    expect(m.list()[0]).toMatchObject({ version: "1.1.0", enabled: true }); // mêmes permissions : reste actif
    m.install(makePlugin({ manifest: { version: "2.0.0", permissions: ["ai", "mail:read"] } }));
    expect(m.list()[0]).toMatchObject({ version: "2.0.0", enabled: false, needsConsent: true });
  });
});

describe("exécution isolée et permissions", () => {
  it("exécute un outil dans un processus isolé", async () => {
    const { m } = setup();
    m.install(makePlugin({ code: "export default { tools: { run: async (ctx, a) => 'salut ' + a.name } };" }));
    expect(m.toolDefs()).toEqual([]); // inactif : aucun outil exposé
    enable(m);
    expect(m.toolDefs()[0]).toMatchObject({ name: "plugin:demo:run" });
    expect(await m.callTool("plugin:demo:run", { name: "Paul" })).toBe("salut Paul");
    await expect(m.callTool("plugin:demo:absent", {})).rejects.toThrow(/Outil inconnu/);
    await expect(m.callTool("mauvais nom", {})).rejects.toThrow(/invalide/);
  });

  it("le bac à sable bloque fichiers, processus, réseau, modules réseau et process.kill", async () => {
    const { m } = setup();
    m.install(makePlugin({
      code: `
        const t = async (f) => { try { return 'OK:' + String(await f()).slice(0, 30); } catch (e) { return 'BLOQUÉ'; } };
        export default { tools: { run: async () => {
          const fs = await import('node:fs');
          const { createRequire } = await import('node:module');
          const req = createRequire(import.meta.url);
          const res = {
            lireFichier: await t(() => fs.readFileSync('/etc/hosts', 'utf8')),
            ecrireFichier: await t(() => fs.writeFileSync('/tmp/pwned-plugin', 'x')),
            processus: await t(() => req('child_process').execSync('echo hi')),
            reseau: await t(() => req('net')),
            http: await t(() => req('https')),
            fetch: await t(() => typeof fetch === 'function' ? 'dispo' : (() => { throw 1; })()),
            kill: await t(() => process.kill(process.pid, 0)),
            env: JSON.stringify(Object.keys(process.env).filter((k) => !k.startsWith('__CF'))),
          };
          return JSON.stringify(res);
        } } };`,
    }));
    enable(m);
    const res = JSON.parse(await m.callTool("plugin:demo:run", {}));
    expect(res).toMatchObject({ lireFichier: "BLOQUÉ", ecrireFichier: "BLOQUÉ", processus: "BLOQUÉ", reseau: "BLOQUÉ", http: "BLOQUÉ", fetch: "BLOQUÉ", kill: "BLOQUÉ" });
    expect(JSON.parse(res.env)).toEqual([]); // aucune variable d'environnement transmise
  });

  it("une API sans permission accordée est refusée ; avec, elle fonctionne", async () => {
    const { m, db } = setup();
    db.prepare("INSERT INTO accounts(id, provider, email, tokens, created_at) VALUES ('a','google','me@x.com','{}',1)").run();
    db.prepare("INSERT INTO mails(id, account_id, remote_id, subject, from_name, from_addr, to_addrs, date, snippet, body, created_at) VALUES ('a:1','a','1','Devis Dupont','','p@x.com','',1,'snip','corps du devis',1)").run();
    m.install(makePlugin({ code: "export default { tools: { run: async (ctx) => JSON.stringify(await ctx.mail.search({ q: 'devis' })) } };" }));
    enable(m);
    await expect(m.callTool("plugin:demo:run", {})).rejects.toThrow(/Permission « mail:read » non accordée/);
    expect(m.list()[0]!.lastError).toContain("mail:read");

    m.install(makePlugin({ manifest: { version: "1.0.1", permissions: ["mail:read"] }, code: "export default { tools: { run: async (ctx) => JSON.stringify(await ctx.mail.search({ q: 'devis' })) } };" }));
    expect(m.list()[0]).toMatchObject({ enabled: false, needsConsent: true });
    enable(m);
    expect(JSON.parse(await m.callTool("plugin:demo:run", {}))[0]).toMatchObject({ subject: "Devis Dupont", from: "p@x.com" });
  });

  it("intégrité : un plugin modifié après installation est désactivé", async () => {
    const { m, db } = setup();
    m.install(makePlugin());
    enable(m);
    const dir = (db.prepare("SELECT dir FROM plugins WHERE id='demo'").get() as { dir: string }).dir;
    writeFileSync(join(dir, "index.mjs"), "export default { tools: { run: async () => 'piraté' } };");
    await expect(m.callTool("plugin:demo:run", {})).rejects.toThrow(/modifiés/);
    expect(m.list()[0]!.enabled).toBe(false);
  });

  it("erreurs du plugin, module cassé et boucle infinie (délai) sont contenus", async () => {
    const { m } = setup({ timeoutMs: 1500 });
    m.install(makePlugin({ code: "export default { tools: { run: async () => { throw new Error('boum'); } } };" }));
    enable(m);
    await expect(m.callTool("plugin:demo:run", {})).rejects.toThrow(/boum/);

    m.install(makePlugin({ manifest: { version: "1.0.1" }, code: "this is not javascript" }));
    enable(m);
    await expect(m.callTool("plugin:demo:run", {})).rejects.toThrow(/Chargement impossible/);

    m.install(makePlugin({ manifest: { version: "1.0.2" }, code: "export default { tools: { run: async () => { while (true) {} } } };" }));
    enable(m);
    await expect(m.callTool("plugin:demo:run", {})).rejects.toThrow(/Délai dépassé/);
  });

  it("événements : seuls les plugins abonnés et actifs sont appelés ; stockage propre au plugin", async () => {
    const { m, db } = setup();
    m.install(makePlugin({
      manifest: { triggers: [{ event: "agent.cycle" }] },
      code: "export default { on: { 'agent.cycle': async (ctx, e) => { await ctx.storage.set('last', e.summary); } }, tools: { run: async (ctx) => (await ctx.storage.get('last')) ?? 'rien' } };",
    }));
    m.emit("agent.cycle", { summary: "x" }); // désactivé : ignoré
    await new Promise((r) => setTimeout(r, 300));
    expect(db.prepare("SELECT count(*) AS n FROM plugin_storage").get()).toEqual({ n: 0 });
    enable(m);
    m.emit("agent.cycle", { summary: "cycle 1" });
    await vi.waitFor(async () => expect(await m.callTool("plugin:demo:run", {})).toBe("cycle 1"), { timeout: 8000 });
    m.remove("demo");
    expect(db.prepare("SELECT count(*) AS n FROM plugin_storage").get()).toEqual({ n: 0 }); // stockage supprimé avec le plugin
  });

  it("proposals.create crée des suggestions « À valider » et jamais d'action directe", async () => {
    const { m, proposals, db } = setup();
    m.install(makePlugin({ manifest: { permissions: ["propose"] }, code: "export default { tools: { run: async (ctx) => JSON.stringify(await ctx.proposals.create({ kind: 'task', title: 'Relancer Paul', reason: 'silence depuis 10 jours' })) } };" }));
    enable(m);
    expect(await m.callTool("plugin:demo:run", {})).toBe('{"created":true}');
    expect(proposals.list()[0]).toMatchObject({ kind: "task", title: "Relancer Paul", sourceRef: { type: "plugin", id: "demo" } });
    expect(db.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    expect((db.prepare("SELECT actor FROM audit_log WHERE action='plugin.propose'").get() as any).actor).toBe("plugin:demo"); // journalisé
  });
});

describe("accès réseau courtier", () => {
  const fetchOk = (calls: string[]) => (async (u: string) => { calls.push(u); return new Response("réponse"); }) as never;
  let seq = 0;
  const run = async (m: PluginManager, url: string) => {
    m.install(makePlugin({ manifest: { version: `1.0.${++seq}`, permissions: ["net:api.exemple.com"] }, code: `export default { tools: { run: async (ctx) => { try { const r = await ctx.net.fetch(${JSON.stringify(url)}); return 'OK ' + r.status + ' ' + r.text; } catch (e) { return 'ERR ' + e.message; } } } };` }));
    enable(m);
    return m.callTool("plugin:demo:run", {});
  };

  it("autorise l'hôte déclaré en HTTPS", async () => {
    const calls: string[] = [];
    const { m } = setup({ fetch: fetchOk(calls), lookup: async () => ["93.184.216.34"] });
    expect(await run(m, "https://api.exemple.com/v1/x")).toBe("OK 200 réponse");
    expect(calls).toEqual(["https://api.exemple.com/v1/x"]);
  });

  it("refuse hôte non déclaré, http, IP littérale, port, adresse privée (DNS) et redirection vers un autre hôte", async () => {
    const calls: string[] = [];
    const { m } = setup({ fetch: fetchOk(calls), lookup: async (h) => (h === "api.exemple.com" ? ["10.0.0.5"] : ["93.184.216.34"]) });
    expect(await run(m, "https://autre.com/")).toMatch(/ERR Permission « net:autre.com »/);
    expect(await run(m, "http://api.exemple.com/")).toMatch(/ERR Seul HTTPS/);
    expect(await run(m, "https://api.exemple.com:8443/")).toMatch(/ERR Port/);
    expect(await run(m, "https://api.exemple.com/")).toMatch(/ERR Adresse privée/); // le DNS pointe vers le réseau local
    expect(calls).toEqual([]);

    const { m: m2 } = setup({ lookup: async () => ["93.184.216.34"], fetch: (async () => new Response("", { status: 302, headers: { location: "https://evil.com/steal" } })) as never });
    expect(await run(m2, "https://api.exemple.com/")).toMatch(/ERR Redirection vers un autre hôte refusée/);
  });

  it("isPrivateAddress", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::1", "fe80::1", "fd00::1", "100.64.0.1"]) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1"]) expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("plugins officiels", () => {
  it("les plugins livrés sont valides et listés", () => {
    const { m } = setup({ bundledDir: join(process.cwd(), "plugins") });
    const ids = m.available().map((p) => p.id).sort();
    expect(ids).toEqual(["example-hello", "graphify"]);
    const g = m.installBundled("graphify");
    expect(g).toMatchObject({ enabled: false, permissions: ["ai", "documents:read", "memory:read", "memory:write"] });
    m.installBundled("example-hello");
  });

  it("exemple « hello » : outil + compteur d'événements", async () => {
    const { m } = setup({ bundledDir: join(process.cwd(), "plugins") });
    m.installBundled("example-hello");
    enable(m, "example-hello");
    m.emit("agent.cycle", {});
    await vi.waitFor(async () => expect(await m.callTool("plugin:example-hello:hello", { name: "Léa" })).toContain("1 fois"), { timeout: 8000 });
  });
});
