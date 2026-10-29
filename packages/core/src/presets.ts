import { randomUUID } from "node:crypto";
import type { Db } from "@assistant/db";

export const CHAT_TOOLS = ["search_data", "create_event", "create_task"] as const;

export interface PresetInput {
  name: string;
  systemPrompt: string;
  tools: string[];
  tone?: string;
  language?: string;
  provider?: string | null;
  model?: string | null;
}

const BUILTIN: (PresetInput & { id: string; sort: number })[] = [
  { id: "general", sort: 1, name: "Général", tools: ["search_data", "create_event", "create_task"], tone: "", language: "",
    systemPrompt: "Tu es l'assistant personnel de l'utilisateur. Tu t'appuies sur ses données (mails, documents, agenda) quand c'est utile." },
  { id: "mails", sort: 2, name: "Mails (rédiger / répondre)", tools: ["search_data"], tone: "professionnel et naturel", language: "",
    systemPrompt: "Tu aides à rédiger et à répondre aux mails. Propose des brouillons prêts à copier, jamais envoyés automatiquement. Respecte le style d'écriture de l'utilisateur s'il t'est donné." },
  { id: "translate", sort: 3, name: "Traduction", tools: [], tone: "fidèle", language: "",
    systemPrompt: "Tu es un traducteur. Traduis le texte fourni sans l'expliquer ni le commenter. Si la langue cible n'est pas précisée, traduis vers l'anglais si le texte est en français, sinon vers le français." },
  { id: "doc_summary", sort: 4, name: "Résumé de document", tools: ["search_data"], tone: "synthétique", language: "",
    systemPrompt: "Tu résumes les documents fournis : points clés, chiffres, dates, décisions et actions à faire, sous forme concise." },
  { id: "search", sort: 5, name: "Recherche dans mes données", tools: ["search_data"], tone: "factuel", language: "",
    systemPrompt: "Tu réponds uniquement à partir des données de l'utilisateur. Cite systématiquement tes sources avec [S1], [S2]… Si les données ne contiennent pas la réponse, dis-le clairement." },
  { id: "planning", sort: 6, name: "Planning", tools: ["search_data", "create_event", "create_task"], tone: "concret", language: "",
    systemPrompt: "Tu aides à organiser le temps : agenda, tâches, priorités. Quand tu proposes un rendez-vous ou une tâche, utilise les outils : ils créent une suggestion que l'utilisateur validera." },
];

interface Row { id: string; name: string; system_prompt: string; tools: string; tone: string; language: string; provider: string | null; model: string | null; builtin: number; sort: number }

const shape = (r: Row) => ({
  id: r.id, name: r.name, systemPrompt: r.system_prompt, tools: JSON.parse(r.tools) as string[], tone: r.tone,
  language: r.language, provider: r.provider, model: r.model, builtin: !!r.builtin, sort: r.sort,
});
export type Preset = ReturnType<typeof shape>;

function validate(p: PresetInput) {
  const name = String(p.name ?? "").trim().slice(0, 80);
  if (!name) throw new Error("Nom requis");
  const systemPrompt = String(p.systemPrompt ?? "").trim().slice(0, 8000);
  if (!systemPrompt) throw new Error("Prompt système requis");
  // Outils autorisés : outils intégrés ou outils de plugins ("plugin:<id>:<outil>").
  const tools = [...new Set(p.tools ?? [])].filter((t) => (CHAT_TOOLS as readonly string[]).includes(t) || /^plugin:[\w-]+:[\w-]+$/.test(t));
  return { name, systemPrompt, tools, tone: String(p.tone ?? "").slice(0, 200), language: String(p.language ?? "").slice(0, 50),
    provider: p.provider ? String(p.provider).slice(0, 80) : null, model: p.model ? String(p.model).slice(0, 120) : null };
}

export class PresetService {
  constructor(private db: Db) {
    this.seed();
  }

  private seed() {
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO presets(id, name, system_prompt, tools, tone, language, builtin, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?,?)`,
    );
    const now = Date.now();
    for (const b of BUILTIN) ins.run(b.id, b.name, b.systemPrompt, JSON.stringify(b.tools), b.tone ?? "", b.language ?? "", b.sort, now, now);
  }

  list(): Preset[] {
    return (this.db.prepare("SELECT * FROM presets ORDER BY sort, name").all() as Row[]).map(shape);
  }

  get(id: string): Preset {
    const r = this.db.prepare("SELECT * FROM presets WHERE id=?").get(id) as Row | undefined;
    if (!r) throw new Error("Préréglage introuvable");
    return shape(r);
  }

  create(p: PresetInput): Preset {
    const v = validate(p);
    const id = `custom:${randomUUID()}`;
    const now = Date.now();
    this.db
      .prepare("INSERT INTO presets(id, name, system_prompt, tools, tone, language, provider, model, builtin, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,0,100,?,?)")
      .run(id, v.name, v.systemPrompt, JSON.stringify(v.tools), v.tone, v.language, v.provider, v.model, now, now);
    return this.get(id);
  }

  update(id: string, p: PresetInput): Preset {
    this.get(id);
    const v = validate(p);
    this.db
      .prepare("UPDATE presets SET name=?, system_prompt=?, tools=?, tone=?, language=?, provider=?, model=?, updated_at=? WHERE id=?")
      .run(v.name, v.systemPrompt, JSON.stringify(v.tools), v.tone, v.language, v.provider, v.model, Date.now(), id);
    return this.get(id);
  }

  /** Les préréglages d'origine ne se suppriment pas : on peut les rétablir. */
  delete(id: string) {
    if (this.get(id).builtin) throw new Error("Un préréglage d'origine ne peut pas être supprimé (utilisez « Rétablir »).");
    this.db.prepare("DELETE FROM presets WHERE id=?").run(id);
  }

  reset(id: string): Preset {
    const b = BUILTIN.find((x) => x.id === id);
    if (!b) throw new Error("Ce préréglage n'a pas de version d'origine");
    return this.update(id, b);
  }
}
