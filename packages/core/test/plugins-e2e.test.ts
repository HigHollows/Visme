import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src";

const sse = (events: object[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
const text = (t: string) => sse([{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }, { type: "message_delta", usage: { output_tokens: 2 } }]);
const toolUse = (id: string, name: string, args: object) =>
  sse([{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } }, { type: "content_block_stop", index: 0 }]);

describe("plugin Graphify de bout en bout", () => {
  it("enrichit le graphe après indexation d'un document, et expose un outil au chat", async () => {
    const bodies: any[] = [];
    const chatQueue: (() => Response)[] = [];
    const events: any[] = [];
    const rpc = createApp({
      notify: (m, p) => events.push({ m, ...(p as object) }),
      fetch: (async (_u: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        bodies.push(body);
        if (String(body.system).includes("plugin « Graphify »"))
          return text(JSON.stringify([{ a: { type: "person", label: "Jean Dupont" }, b: { type: "org", label: "Dupont SARL" }, rel: "dirige" }, { a: { type: "alien", label: "x" }, b: { type: "org", label: "y" }, rel: "z" }]));
        return (chatQueue.shift() ?? (() => text("ok")))();
      }) as never,
    });
    const call = async (method: string, params?: unknown) => JSON.parse((await rpc.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })))!);
    await call("init", { dataDir: mkdtempSync(join(tmpdir(), "e2e-")), key: "k", bundledPluginsDir: join(process.cwd(), "plugins") });
    const s = (await call("settings.get")).result;
    s.ai.providers = { claude: { kind: "anthropic" } };
    s.ai.routes = { chat: { primary: { provider: "claude", model: "m" } }, extraction: { primary: { provider: "claude", model: "m" } } };
    await call("settings.set", { settings: s });
    await call("ai.setKeys", { keys: { claude: "k" } });

    expect((await call("plugins.available")).result.map((p: any) => p.id).sort()).toEqual(["example-hello", "graphify"]);
    const inst = (await call("plugins.installBundled", { id: "graphify" })).result;
    expect(inst).toMatchObject({ enabled: false, needsConsent: true });
    expect((await call("plugins.enable", { id: "graphify", permissions: ["ai"] })).error.message).toContain("ne correspondent pas");
    await call("plugins.enable", { id: "graphify", permissions: inst.permissions });

    // Un document est indexé → l'événement déclenche le plugin dans son bac à sable.
    const f = join(mkdtempSync(join(tmpdir(), "doc-")), "societe.txt");
    writeFileSync(f, "Jean Dupont dirige la société Dupont SARL depuis 2019. Contact : jean@dupont.fr");
    const [added] = (await call("documents.add", { paths: [f] })).result;
    await vi.waitFor(async () => {
      const g = (await call("memory.graph", {})).result;
      expect(g.edges.some((e: any) => e.rel === "dirige")).toBe(true);
    }, { timeout: 15_000 });

    const g = (await call("memory.graph", {})).result;
    const labels = g.nodes.map((n: any) => n.label);
    expect(labels).toEqual(expect.arrayContaining(["Jean Dupont", "Dupont SARL"]));
    expect(labels).not.toContain("x"); // type invalide écarté par le plugin
    const edge = g.edges.find((e: any) => e.rel === "dirige");
    expect(edge).toMatchObject({ manual: true }); // lien posé par un plugin : conservé à la reconstruction
    expect(g.edges.some((e: any) => e.src === `doc:${added.id}` && e.rel === "mentions")).toBe(true);
    // audit : actions du plugin tracées
    await vi.waitFor(async () => {
      const audit = (await call("audit.list", { limit: 200 })).result.filter((a: any) => a.actor === "plugin:graphify").map((a: any) => a.action);
      expect(audit).toEqual(expect.arrayContaining(["plugin.ai", "memory.link", "plugin.run"]));
    }, { timeout: 10_000 });

    // Outil du plugin dans le chat : nom « sûr » côté fournisseur, résolu côté hôte.
    const preset = (await call("presets.create", { name: "Graphe", systemPrompt: "Réponds.", tools: ["plugin:graphify:relations"] })).result;
    chatQueue.push(() => toolUse("t1", "plugin__graphify__relations", { name: "Jean Dupont", type: "person" }));
    chatQueue.push(() => text("Jean Dupont dirige Dupont SARL."));
    const streamId = "s1";
    await call("chat.send", { streamId, text: "Qui est Jean Dupont ?", presetId: preset.id });
    await vi.waitFor(() => expect(events.some((e) => e.streamId === streamId && e.type === "done")).toBe(true), { timeout: 10_000 });
    const chatBodies = bodies.filter((b) => !String(b.system).includes("plugin « Graphify »") && b.messages.length > 0);
    expect(chatBodies[0].tools.map((t: any) => t.name)).toEqual(["plugin__graphify__relations"]);
    expect(JSON.stringify(chatBodies.at(-1).messages.at(-1))).toContain("dirige");
    expect(events.find((e) => e.type === "error")).toBeUndefined();

    // Désactivé : ses outils disparaissent.
    await call("plugins.disable", { id: "graphify" });
    expect((await call("plugins.list")).result[0].enabled).toBe(false);
  }, 30_000);
});
