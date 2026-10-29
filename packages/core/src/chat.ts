import { randomUUID } from "node:crypto";
import type { AIRouter, ChatMessage, ToolDef } from "@assistant/ai";
import type { Db } from "@assistant/db";
import type { Settings } from "@assistant/schemas";
import { parseLocalDateTime } from "./agent/analyze";
import { buildProviders, buildRouter } from "./ai";
import type { CalendarService } from "./calendar";
import type { MemoryService } from "./memory";
import type { Preset, PresetService } from "./presets";
import type { ProposalService } from "./proposals";
import { SYSTEM_PROMPT } from "./prompts";
import { contextBlock, retrieve, type Source } from "./retrieval";
import { RpcError, type RpcServer } from "./rpc";

export type Notify = (method: string, params: unknown) => void;

const HISTORY_LIMIT = 40;
const MAX_INPUT = 20_000;
const MAX_TOOL_ROUNDS = 4;
const MAX_MENTIONS = 5;
const MENTION_RE = /@\[([^\]]{1,120})\]\((document|mail|event):([^)\s]{1,200})\)/g;

/** Commandes slash → préréglage + consigne. */
const SLASH: Record<string, { preset: string; build: (arg: string) => string; agenda?: boolean }> = {
  resume: { preset: "doc_summary", build: (a) => `Résume ${a || "le document mentionné"}.` },
  traduis: { preset: "translate", build: (a) => a },
  agenda: { preset: "planning", build: (a) => a || "Que contient mon agenda dans les prochains jours ?", agenda: true },
  cherche: { preset: "search", build: (a) => a },
  tache: { preset: "general", build: (a) => `Crée une tâche : ${a}` },
};

export function parseSlash(text: string): { command: string; arg: string } | null {
  const m = text.match(/^\/([a-zA-Zéèêàù]+)\s*([\s\S]*)$/);
  return m ? { command: m[1]!.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""), arg: m[2]!.trim() } : null;
}

export interface ChatDeps {
  rpc: RpcServer;
  db: () => Db;
  settings: () => Settings;
  keys: ReadonlyMap<string, string>;
  fetch?: typeof fetch;
  notify: Notify;
  presets: () => PresetService;
  memory: () => MemoryService;
  proposals: () => ProposalService;
  cal: () => CalendarService;
  /** Outils fournis par des plugins (préfixe "plugin:<id>:<outil>"). */
  pluginTools?: () => { defs: ToolDef[]; call(name: string, args: unknown): Promise<string> };
  /** Consignes de style d'écriture à ajouter au préréglage « Mails ». */
  styleHint?: () => string;
}

const TOOL_DEFS: Record<string, ToolDef> = {
  search_data: {
    name: "search_data",
    description: "Cherche dans les mails, documents et événements de l'utilisateur. À utiliser pour retrouver une information précise.",
    parameters: { type: "object", properties: { query: { type: "string", description: "Mots-clés ou question" } }, required: ["query"] },
  },
  create_event: {
    name: "create_event",
    description: "Propose un événement au calendrier. L'utilisateur devra le valider dans « À valider ».",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "Date et heure locales, format YYYY-MM-DDTHH:mm (ou YYYY-MM-DD si toute la journée)" },
        end: { type: "string", description: "Fin, même format (optionnel)" },
        location: { type: "string" },
      },
      required: ["title", "start"],
    },
  },
  create_task: {
    name: "create_task",
    description: "Propose une tâche. L'utilisateur devra la valider dans « À valider ».",
    parameters: { type: "object", properties: { title: { type: "string" }, due: { type: "string", description: "Échéance YYYY-MM-DD (optionnel)" } }, required: ["title"] },
  },
};

function sourceLabel(s: Source) {
  return { n: s.n, type: s.type, id: s.id, title: s.title };
}

export function registerChat(d: ChatDeps) {
  const streams = new Map<string, AbortController>();

  d.rpc.register("chat.list", () =>
    d.db().prepare("SELECT id, title, updated_at AS updatedAt, preset_id AS presetId FROM conversations ORDER BY updated_at DESC LIMIT 200").all(),
  );

  d.rpc.register("chat.get", (p: { id: string }) =>
    (d.db().prepare("SELECT id, role, content, created_at AS createdAt, sources FROM messages WHERE conversation_id = ? ORDER BY id").all(p.id) as any[]).map(
      (m) => ({ ...m, sources: m.sources ? JSON.parse(m.sources) : [] }),
    ),
  );

  d.rpc.register("chat.delete", (p: { id: string }) => {
    d.db().prepare("DELETE FROM conversations WHERE id = ?").run(p.id);
    return { ok: true };
  });

  d.rpc.register("chat.cancel", (p: { streamId: string }) => {
    streams.get(p.streamId)?.abort();
    return { ok: true };
  });

  /** Charge le contenu des éléments mentionnés avec @ (limité) ; renvoie le texte nettoyé et les sources. */
  function resolveMentions(db: Db, text: string): { text: string; sources: Source[] } {
    const sources: Source[] = [];
    const cleaned = text.replace(MENTION_RE, (_m, label: string, type: string, id: string) => {
      if (sources.length < MAX_MENTIONS) {
        const n = sources.length + 1;
        if (type === "document") {
          const rows = db
            .prepare("SELECT c.text FROM chunks c JOIN documents dd ON dd.node_id=c.node_id WHERE dd.id=? ORDER BY c.id LIMIT 8")
            .all(id) as { text: string }[];
          if (rows.length) sources.push({ n, type: "document", id, title: label, excerpt: rows.map((r) => r.text).join("\n").slice(0, 6000) });
        } else if (type === "mail") {
          const m = db.prepare("SELECT subject, from_name AS f, from_addr AS a, body FROM mails WHERE id=?").get(id) as { subject: string; f: string; a: string; body: string } | undefined;
          if (m) sources.push({ n, type: "mail", id, title: m.subject, excerpt: `De ${m.f || m.a}\n${m.body.slice(0, 4000)}` });
        } else {
          const e = db.prepare("SELECT title, start_at AS s, end_at AS e, location, description FROM events WHERE id=?").get(id) as any;
          if (e) sources.push({ n, type: "event", id, title: e.title, excerpt: `${new Date(e.s).toLocaleString("fr-FR")} → ${new Date(e.e).toLocaleString("fr-FR")} ${e.location} ${e.description}`.slice(0, 1000) });
        }
      }
      return `@${label}`;
    });
    return { text: cleaned, sources };
  }

  d.rpc.register("chat.send", (p: { streamId: string; conversationId?: string; text: string; presetId?: string }) => {
    let text = (p.text ?? "").trim();
    if (!text) throw new RpcError(-32602, "Message vide");
    if (text.length > MAX_INPUT) throw new RpcError(-32602, "Message trop long");
    if (!p.streamId || streams.has(p.streamId)) throw new RpcError(-32602, "streamId invalide");

    const db = d.db();
    const presets = d.presets();
    let presetId = p.presetId ?? "general";
    let withAgenda = false;

    // Commande slash : change de préréglage et reformule la consigne.
    const slash = parseSlash(text);
    if (slash) {
      const def = SLASH[slash.command];
      if (!def) throw new RpcError(-32602, `Commande inconnue : /${slash.command} (disponibles : ${Object.keys(SLASH).map((k) => "/" + k).join(", ")})`);
      presetId = def.preset;
      text = def.build(slash.arg);
      withAgenda = !!def.agenda;
      if (!text.trim()) throw new RpcError(-32602, `/${slash.command} attend un texte`);
    }
    let preset: Preset;
    try { preset = presets.get(presetId); } catch { throw new RpcError(-32602, "Préréglage introuvable"); }

    const settings = d.settings();
    const route = preset.provider && preset.model
      ? { primary: { provider: preset.provider, model: preset.model } }
      : settings.ai.routes.chat;
    if (!route) throw new RpcError(-32010, "Aucun modèle configuré pour le chat (Settings → IA).");
    if (!d.keys.has(route.primary.provider))
      throw new RpcError(-32010, `Aucune clé API pour « ${route.primary.provider} » (Settings → IA).`);

    const now = Date.now();
    let conversationId = p.conversationId;
    if (conversationId) {
      if (!db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(conversationId)) throw new RpcError(-32602, "Conversation introuvable");
    } else {
      conversationId = randomUUID();
      const title = text.replace(MENTION_RE, "@$1").replace(/\s+/g, " ").slice(0, 60);
      db.prepare("INSERT INTO conversations(id, title, created_at, updated_at, preset_id) VALUES (?,?,?,?,?)").run(conversationId, title, now, now, presetId);
    }
    const mentions = resolveMentions(db, text);
    db.prepare("INSERT INTO messages(conversation_id, role, content, created_at) VALUES (?,?,?,?)").run(conversationId, "user", mentions.text, now);

    const history = (
      db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?").all(conversationId, HISTORY_LIMIT) as ChatMessage[]
    ).reverse();

    const controller = new AbortController();
    streams.set(p.streamId, controller);
    const convId = conversationId;
    const emit = (e: Record<string, unknown>) => d.notify("chat.event", { streamId: p.streamId, conversationId: convId, ...e });

    void (async () => {
      let answer = "";
      let cancelled = false;
      let sources: Source[] = [];
      try {
        const router = buildRouter(db, settings, buildProviders(settings, d.keys, d.fetch));
        const hasSearch = preset.tools.includes("search_data");

        // 1. Contexte : éléments mentionnés d'abord, puis mémoire hybride (mots-clés + vecteurs + graphe).
        sources = [...mentions.sources];
        let related: string[] = [];
        if (hasSearch && mentions.text.trim().length >= 3 && !mentions.sources.length) {
          const r = await retrieve(db, router, d.memory(), mentions.text, 5);
          sources = r.sources;
          related = r.related;
        }
        let extra = "";
        if (withAgenda) {
          const evs = d.cal().list(Date.now(), Date.now() + 14 * 86_400_000) as { title: string; start: number; end: number; allDay: boolean }[];
          extra = `Agenda des 14 prochains jours :\n${evs.map((e) => `- ${new Date(e.start).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: e.allDay ? undefined : "short" })} ${e.title}`).join("\n") || "- aucun événement"}`;
        }

        // 2. Prompt : consignes (système) ; données récupérées dans un message utilisateur séparé, donc masquées par le routeur.
        const system = [
          SYSTEM_PROMPT,
          preset.systemPrompt,
          preset.tone && `Ton : ${preset.tone}.`,
          preset.language && `Langue de réponse : ${preset.language}.`,
          presetId === "mails" ? d.styleHint?.() ?? "" : "",
          `Date et heure actuelles : ${new Date().toLocaleString("fr-FR")}.`,
        ].filter(Boolean).join("\n\n");
        const ctx = [contextBlock(sources, related), extra && `<donnees>\n${extra}\n</donnees>`].filter(Boolean).join("\n\n");
        const messages: ChatMessage[] = [{ role: "system", content: system }, ...(ctx ? [{ role: "user" as const, content: ctx }] : []), ...history];

        if (sources.length) emit({ type: "sources", sources: sources.map(sourceLabel) });

        // 3. Boucle d'outils : les outils n'exécutent jamais d'action directe, ils créent des suggestions à valider.
        const plugin = d.pluginTools?.();
        const tools: ToolDef[] = [
          ...preset.tools.filter((t) => TOOL_DEFS[t]).map((t) => TOOL_DEFS[t]!),
          // Les fournisseurs d'IA n'acceptent pas « : » dans un nom d'outil : on expose « plugin__id__outil ».
          ...(plugin?.defs.filter((t) => preset.tools.includes(t.name)).map((t) => ({ ...t, name: t.name.replace(/:/g, "__") })) ?? []),
        ];
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          const calls: { id: string; name: string; args: unknown }[] = [];
          let roundText = "";
          for await (const chunk of router.chat("chat", { messages, tools: tools.length ? tools : undefined, signal: controller.signal }, route)) {
            if (chunk.type === "text") {
              roundText += chunk.text;
              answer += chunk.text;
              emit({ type: "text", text: chunk.text });
            } else if (chunk.type === "tool_call") calls.push({ id: chunk.id, name: chunk.name, args: chunk.args });
          }
          if (!calls.length || round === MAX_TOOL_ROUNDS) break;
          messages.push({ role: "assistant", content: roundText, toolCalls: calls });
          for (const c of calls) {
            const result = await runTool(c.name.replace(/^plugin__([a-z][a-z0-9-]*)__/, "plugin:$1:"), c.args);
            emit({ type: "tool", name: c.name, result: result.slice(0, 200) });
            messages.push({ role: "tool", toolCallId: c.id, content: result });
          }
        }

        async function runTool(name: string, args: any): Promise<string> {
          try {
            if (!preset.tools.includes(name)) return "Outil non autorisé pour ce préréglage.";
            const a = args && typeof args === "object" ? args : {};
            if (name === "search_data") {
              const r = await retrieve(db, router, d.memory(), String(a.query ?? "").slice(0, 300), 5);
              for (const s of r.sources) if (!sources.some((x) => x.id === s.id)) sources.push({ ...s, n: sources.length + 1 });
              emit({ type: "sources", sources: sources.map(sourceLabel) });
              return r.sources.length ? r.sources.map((s) => `[S${sources.find((x) => x.id === s.id)!.n}] ${s.title}: ${s.excerpt}`).join("\n") : "Aucun résultat.";
            }
            if (name === "create_event") {
              const start = parseLocalDateTime(a.start);
              if (!start) return "Date de début invalide (format attendu YYYY-MM-DDTHH:mm).";
              const end = parseLocalDateTime(a.end)?.t;
              const allDay = !start.hasTime;
              const payload = { title: String(a.title ?? "").slice(0, 200), start: start.t, end: allDay ? start.t + 86_400_000 : end && end > start.t ? end : start.t + 3600_000, allDay, location: String(a.location ?? "").slice(0, 200) };
              if (!payload.title) return "Titre manquant.";
              const id = d.proposals().create({ kind: "event", title: payload.title, payload, reason: "Demandé dans le chat", sourceRef: { type: "conversation", id: convId }, sourceKey: null, confidence: 1 });
              return id ? "Suggestion d'événement créée : l'utilisateur doit la valider dans « À valider »." : "Cette suggestion existe déjà.";
            }
            if (name === "create_task") {
              const due = a.due ? parseLocalDateTime(a.due)?.t ?? null : null;
              const payload = { title: String(a.title ?? "").slice(0, 200), due };
              if (!payload.title) return "Titre manquant.";
              const id = d.proposals().create({ kind: "task", title: payload.title, payload, reason: "Demandé dans le chat", sourceRef: { type: "conversation", id: convId }, sourceKey: null, confidence: 1 });
              return id ? "Suggestion de tâche créée : l'utilisateur doit la valider dans « À valider »." : "Cette suggestion existe déjà.";
            }
            if (name.startsWith("plugin:") && plugin) return await plugin.call(name, a);
            return "Outil inconnu.";
          } catch (e) {
            return `Erreur de l'outil : ${e instanceof Error ? e.message : String(e)}`;
          }
        }
      } catch (e) {
        if (controller.signal.aborted) cancelled = true;
        else emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        streams.delete(p.streamId);
        if (answer) {
          db.prepare("INSERT INTO messages(conversation_id, role, content, created_at, model, sources) VALUES (?,?,?,?,?,?)").run(
            convId, "assistant", answer, Date.now(), route.primary.model, sources.length ? JSON.stringify(sources.map(sourceLabel)) : null,
          );
        }
        db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(Date.now(), convId);
        emit({ type: "done", cancelled });
      }
    })();

    return { conversationId, presetId };
  });
}
