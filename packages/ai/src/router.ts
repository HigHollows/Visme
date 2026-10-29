import { CostTracker, computeCost, type Price } from "./cost";
import { redact } from "./redaction";
import {
  AIError,
  type AIProvider,
  type ChatChunk,
  type ChatMessage,
  type ChatRequest,
  type Route,
  type TaskKind,
  type TaskRoute,
} from "./types";

export interface RouterOptions {
  providers: Record<string, AIProvider>;
  routes: Partial<Record<TaskKind, TaskRoute>>;
  prices?: Record<string, Price>; // clé "provider/model"
  tracker?: CostTracker;
  redactSensitive?: boolean;
  /** Journal d'audit : jamais de clés, jamais le contenu complet. */
  audit?: (e: { task: TaskKind; route: Route; usd: number; redactions: Record<string, number> }) => void;
}

const RETRYABLE = new Set(["rate_limit", "unavailable"]);

export class AIRouter {
  constructor(private opts: RouterOptions) {}

  private routeFor(task: TaskKind): TaskRoute {
    const r = this.opts.routes[task];
    if (!r) throw new AIError(`Aucune route configurée pour "${task}"`, "other");
    return r;
  }

  private provider(id: string): AIProvider {
    const p = this.opts.providers[id];
    if (!p) throw new AIError(`Fournisseur inconnu : ${id}`, "other");
    return p;
  }

  private prepare(messages: ChatMessage[]) {
    const counts: Record<string, number> = {};
    if (!this.opts.redactSensitive) return { messages, counts };
    const out = messages.map((m) => {
      if (m.role === "system") return m;
      const r = redact(m.content);
      for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + v;
      return { ...m, content: r.text };
    });
    return { messages: out, counts };
  }

  async *chat(task: TaskKind, req: Omit<ChatRequest, "model">): AsyncIterable<ChatChunk> {
    this.opts.tracker?.assertWithinBudget();
    const { primary, fallback } = this.routeFor(task);
    const { messages, counts } = this.prepare(req.messages);

    const attempts = fallback ? [primary, fallback] : [primary];
    let lastErr: unknown;
    for (const route of attempts) {
      const provider = this.provider(route.provider);
      let emitted = false;
      try {
        for await (const chunk of provider.chat({ ...req, messages, model: route.model })) {
          emitted = true;
          if (chunk.type === "usage") {
            const price = this.opts.prices?.[`${route.provider}/${route.model}`];
            const usd = price ? computeCost(price, chunk.inputTokens, chunk.outputTokens) : 0;
            this.opts.tracker?.record(usd);
            this.opts.audit?.({ task, route, usd, redactions: counts });
          }
          yield chunk;
        }
        return;
      } catch (e) {
        lastErr = e;
        // Pas de bascule en cours de flux : le consommateur a déjà reçu du texte.
        if (emitted || !(e instanceof AIError) || !RETRYABLE.has(e.kind)) throw e;
      }
    }
    throw lastErr;
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.opts.tracker?.assertWithinBudget();
    const { primary, fallback } = this.routeFor("embedding");
    const safe = this.opts.redactSensitive ? texts.map((t) => redact(t).text) : texts;
    try {
      return await this.provider(primary.provider).embed(safe, primary.model);
    } catch (e) {
      if (fallback && e instanceof AIError && RETRYABLE.has(e.kind))
        return this.provider(fallback.provider).embed(safe, fallback.model);
      throw e;
    }
  }
}
