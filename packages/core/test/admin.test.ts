import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src";

const sse = (t: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\ndata: [DONE]\n\n`);

async function setup(opts: { ai?: boolean } = {}) {
  const bodies: any[] = [];
  const events: any[] = [];
  const rpc = createApp({
    notify: (m, p) => events.push({ m, ...(p as object) }),
    fetch: (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(init.body as string)); return sse("Semaine chargée : trois rendez-vous."); }) as never,
  });
  const call = async (method: string, params?: unknown) => JSON.parse((await rpc.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })))!);
  const dataDir = mkdtempSync(join(tmpdir(), "adm-"));
  await call("init", { dataDir, key: "k", profile: "p1" });
  if (opts.ai) {
    const s = (await call("settings.get")).result;
    s.ai.providers = { oa: { kind: "openai" } };
    s.ai.routes = { summary: { primary: { provider: "oa", model: "m" } } };
    await call("settings.set", { settings: s });
    await call("ai.setKeys", { keys: { oa: "k" } });
  }
  return { call, dataDir, bodies, events };
}

describe("dossiers surveillés", () => {
  it("importe l'existant, puis les nouveaux fichiers ; ignore temporaires, cachés et formats inconnus ; s'arrête à la suppression", async () => {
    const t = await setup();
    const dir = mkdtempSync(join(tmpdir(), "watched-"));
    writeFileSync(join(dir, "ancien.txt"), "contenu ancien marqueurancien");
    writeFileSync(join(dir, ".cache.txt"), "caché");
    writeFileSync(join(dir, "dl.pdf.crdownload"), "partiel");
    writeFileSync(join(dir, "programme.exe"), "MZ");
    mkdirSync(join(dir, "sous"));
    writeFileSync(join(dir, "sous", "note.md"), "# Note\nmarqueursousdossier");

    expect((await t.call("watch.add", { path: join(dir, "inexistant") })).error).toBeDefined();
    expect((await t.call("watch.add", { path: join(dir, "ancien.txt") })).error.message).toContain("pas un dossier");
    await t.call("watch.add", { path: dir });
    await vi.waitFor(async () => expect((await t.call("documents.list")).result.map((d: any) => d.name).sort()).toEqual(["ancien.txt", "note.md"]), { timeout: 8000 });

    // Un fichier qui arrive plus tard est importé automatiquement (après stabilisation)
    writeFileSync(join(dir, "recu.txt"), "nouveau marqueurrecu");
    await vi.waitFor(async () => expect((await t.call("documents.list")).result.some((d: any) => d.name === "recu.txt")).toBe(true), { timeout: 10_000 });
    // dédoublonnage : un second scan n'ajoute rien
    await t.call("watch.scan");
    await new Promise((r) => setTimeout(r, 300));
    expect((await t.call("documents.list")).result).toHaveLength(3);
    expect((await t.call("watch.list")).result).toEqual([{ path: dir }]);
    // l'original n'est jamais touché
    expect(readFileSync(join(dir, "ancien.txt"), "utf8")).toContain("marqueurancien");

    await t.call("watch.remove", { path: dir });
    writeFileSync(join(dir, "apres.txt"), "après suppression");
    await new Promise((r) => setTimeout(r, 2500));
    expect((await t.call("documents.list")).result.some((d: any) => d.name === "apres.txt")).toBe(false);
  }, 30_000);
});

describe("administration, RGPD, diagnostics", () => {
  it("export complet du profil : toutes les données, jamais de jeton ni de clé", async () => {
    const t = await setup();
    await t.call("tasks.create", { title: "Tâche exportée" });
    await t.call("calendar.create", { title: "Événement exporté", start: Date.now(), end: Date.now() + 3600_000 });
    await t.call("memory.addNode", { type: "project", label: "Projet exporté" });
    const out = join(t.dataDir, "export.json");
    const r = (await t.call("privacy.export", { path: out })).result;
    expect(r.rows).toBeGreaterThan(2);
    const json = readFileSync(out, "utf8");
    const data = JSON.parse(json);
    expect(data.tasks.map((x: any) => x.title)).toEqual(["Tâche exportée"]);
    expect(data.events[0].title).toBe("Événement exporté");
    expect(data.nodes.some((n: any) => n.label === "Projet exporté")).toBe(true);
    expect(data.audit_log.length).toBeGreaterThan(0);
    expect(json).not.toMatch(/"tokens"|apiKey|sk-/);
    if (process.platform !== "win32") expect(statSync(out).mode & 0o077).toBe(0); // lisible par l'utilisateur seul
  });

  it("diagnostics : version, taille, compteurs", async () => {
    const t = await setup();
    await t.call("tasks.create", { title: "x" });
    const d = (await t.call("diagnostics.get")).result;
    expect(d).toMatchObject({ schemaVersion: 9, counts: { events: 0 } });
    expect(d.dbBytes).toBeGreaterThan(1000);
    expect(d.node).toMatch(/^v\d+/);
  });

  it("journal d'audit filtrable et paginé, sans injection LIKE", async () => {
    const t = await setup();
    for (let i = 0; i < 5; i++) await t.call("tasks.create", { title: `t${i}` });
    await t.call("calendar.create", { title: "e", start: 1, end: 2 });
    const tasks = (await t.call("audit.list", { action: "task." })).result;
    expect(tasks.every((a: any) => a.action.startsWith("task."))).toBe(true);
    expect(tasks).toHaveLength(5);
    const page = (await t.call("audit.list", { action: "task.", limit: 2 })).result;
    const next = (await t.call("audit.list", { action: "task.", limit: 2, beforeId: page.at(-1).id })).result;
    expect(next[0].id).toBeLessThan(page.at(-1).id);
    expect((await t.call("audit.list", { action: "%" })).result).toEqual([]); // le joker est échappé
    expect((await t.call("audit.list", { actor: "user" })).result.length).toBeGreaterThan(0);
  });

  it("réglages : export sans secret, import validé, réinitialisation", async () => {
    const t = await setup();
    const s = (await t.call("settings.get")).result;
    s.agent.autonomy = "observe";
    s.general.theme = "dark";
    await t.call("settings.set", { settings: s });
    const exported = (await t.call("settings.export")).result;
    expect(exported).not.toMatch(/key|secret|token/i);
    await t.call("settings.reset");
    expect((await t.call("settings.get")).result.agent.autonomy).toBe("propose");
    expect((await t.call("settings.import", { json: exported })).result.agent.autonomy).toBe("observe");
    expect((await t.call("settings.import", { json: "{pas du json" })).error.message).toContain("illisible");
    expect((await t.call("settings.import", { json: JSON.stringify({ agent: { syncIntervalMinutes: 0 } }) })).error).toBeDefined();
    expect((await t.call("settings.import", { json: JSON.stringify({ version: 99 }) })).error).toBeDefined();
  });

  it("mémoire : statistiques, export/import des éléments manuels", async () => {
    const a = await setup();
    const proj = (await a.call("memory.addNode", { type: "project", label: "Rénovation" })).result.id;
    const org = (await a.call("memory.addNode", { type: "org", label: "Artisan SARL" })).result.id;
    await a.call("memory.addEdge", { src: proj, dst: org, rel: "prestataire" });
    expect((await a.call("memory.stats")).result).toMatchObject({ manualNodes: 2, manualEdges: 1 });
    const data = (await a.call("memory.export")).result;

    const b = await setup();
    expect((await b.call("memory.import", { data })).result).toEqual({ nodes: 2, edges: 1 });
    expect((await b.call("memory.import", { data })).result).toEqual({ nodes: 0, edges: 0 }); // idempotent
    const g = (await b.call("memory.graph", {})).result;
    expect(g.nodes.map((n: any) => n.label).sort()).toEqual(["Artisan SARL", "Rénovation"]);
    expect((await b.call("memory.import", { data: { format: 2 } })).error.message).toContain("invalide");
    // un fichier hostile ne peut ni inventer de type, ni lier à des nœuds absents
    const evil = { format: 1, nodes: [{ id: "x", type: "alien", label: "?" }, { id: "doc:abc", type: "document", label: "pirate" }], edges: [{ src: "x", dst: "y", rel: "z" }] };
    const r = (await b.call("memory.import", { data: evil })).result;
    expect(r.edges).toBe(0);
    expect((await b.call("memory.graph", {})).result.nodes.some((n: any) => n.id === "doc:abc")).toBe(false);
  });
});

describe("résumé hebdomadaire", () => {
  it("couvre 7 jours, échéances comprises, avec cache séparé du résumé du jour", async () => {
    const t = await setup({ ai: true });
    const soon = Date.now() + 2 * 86_400_000;
    await t.call("calendar.create", { title: "Revue trimestrielle", start: soon, end: soon + 3600_000 });
    await t.call("deadlines.create", { service: "Assurance habitation", kind: "insurance", nextDate: soon, periodicity: "yearly", amount: 300 });
    const w = (await t.call("digest.get", { period: "week" })).result;
    expect(w.text).toContain("Semaine chargée");
    const sent = JSON.stringify(t.bodies.at(-1));
    expect(sent).toContain("Revue trimestrielle");
    expect(sent).toContain("Assurance habitation");
    expect(sent).toContain("7 prochains jours");
    const calls = t.bodies.length;
    expect((await t.call("digest.get", { period: "week" })).result.text).toBe(w.text);
    expect(t.bodies.length).toBe(calls); // cache
    await t.call("digest.get", {}); // le résumé du jour est indépendant
    expect(t.bodies.length).toBe(calls + 1);
  });
});
