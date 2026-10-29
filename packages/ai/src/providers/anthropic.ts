import {
  AIError,
  type AIProvider,
  type ChatChunk,
  type ChatMessage,
  type ChatRequest,
} from "../types";
import { httpError, networkGuard, sseData, type FetchFn } from "./sse";

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchFn;
}

function toAnthropicMessages(messages: ChatMessage[]) {
  const out: { role: "user" | "assistant"; content: unknown }[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }],
      });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      const blocks: unknown[] = m.content ? [{ type: "text", text: m.content }] : [];
      for (const c of m.toolCalls) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      out.push({ role: "assistant", content: blocks });
    } else if (m.images?.length) {
      out.push({
        role: m.role as "user" | "assistant",
        content: [
          ...m.images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })),
          { type: "text", text: m.content },
        ],
      });
    } else {
      out.push({ role: m.role as "user" | "assistant", content: m.content });
    }
  }
  return out;
}

export class AnthropicProvider implements AIProvider {
  readonly id = "anthropic";
  readonly capabilities = { chat: true, tools: true, vision: true, embeddings: false, transcription: false };
  private base: string;
  private f: FetchFn;

  constructor(private o: AnthropicOptions) {
    this.base = (o.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.f = o.fetch ?? fetch;
  }

  private headers() {
    return {
      "content-type": "application/json",
      "x-api-key": this.o.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      stream: true,
      ...(system && { system }),
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      ...(req.tools?.length && {
        tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      }),
      messages: toAnthropicMessages(req.messages),
    };
    const res = await networkGuard(
      this.f(`${this.base}/v1/messages`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: req.signal,
      }),
    );

    let inputTokens = 0;
    let outputTokens = 0;
    const tools = new Map<number, { id: string; name: string; json: string }>();
    for await (const data of sseData(res)) {
      const ev = JSON.parse(data);
      switch (ev.type) {
        case "message_start":
          inputTokens = ev.message?.usage?.input_tokens ?? 0;
          outputTokens = ev.message?.usage?.output_tokens ?? 0;
          break;
        case "content_block_start":
          if (ev.content_block?.type === "tool_use")
            tools.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: "" });
          break;
        case "content_block_delta":
          if (ev.delta?.type === "text_delta") yield { type: "text", text: ev.delta.text };
          else if (ev.delta?.type === "input_json_delta") {
            const t = tools.get(ev.index);
            if (t) t.json += ev.delta.partial_json;
          }
          break;
        case "content_block_stop": {
          const t = tools.get(ev.index);
          if (t) {
            yield { type: "tool_call", id: t.id, name: t.name, args: t.json ? JSON.parse(t.json) : {} };
            tools.delete(ev.index);
          }
          break;
        }
        case "message_delta":
          outputTokens = ev.usage?.output_tokens ?? outputTokens;
          break;
        case "error":
          throw new AIError(ev.error?.message ?? "Erreur Anthropic", ev.error?.type === "overloaded_error" ? "unavailable" : "other");
      }
    }
    yield { type: "usage", inputTokens, outputTokens };
    yield { type: "done" };
  }

  async embed(): Promise<number[][]> {
    throw new AIError("Anthropic ne propose pas d'embeddings", "unsupported");
  }

  async transcribe(): Promise<never> {
    throw new AIError("Anthropic ne propose pas de transcription", "unsupported");
  }

  async testConnection() {
    try {
      const res = await this.f(`${this.base}/v1/models?limit=1`, { headers: this.headers() });
      if (!res.ok) return { ok: false, error: httpError(res.status, await res.text()).message };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
