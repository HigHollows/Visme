import {
  AIError,
  type AIProvider,
  type ChatChunk,
  type ChatMessage,
  type ChatRequest,
  type Transcript,
  type TranscribeOptions,
} from "../types";
import { httpError, networkGuard, sseData, type FetchFn } from "./sse";

export interface OpenAIOptions {
  apiKey: string;
  /** Pour les endpoints compatibles OpenAI (Mistral, Ollama distant, etc.). */
  baseUrl?: string;
  id?: string;
  fetch?: FetchFn;
}

function toOpenAIMessages(messages: ChatMessage[]) {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role === "assistant" && m.toolCalls?.length)
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      };
    if (m.images?.length)
      return {
        role: m.role,
        content: [
          ...m.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } })),
          { type: "text", text: m.content },
        ],
      };
    return { role: m.role, content: m.content };
  });
}

export class OpenAIProvider implements AIProvider {
  readonly id: string;
  readonly capabilities = { chat: true, tools: true, vision: true, embeddings: true, transcription: true };
  private base: string;
  private f: FetchFn;

  constructor(private o: OpenAIOptions) {
    this.id = o.id ?? "openai";
    this.base = (o.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.f = o.fetch ?? fetch;
  }

  private auth() {
    return { authorization: `Bearer ${this.o.apiKey}` };
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const body = {
      model: req.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: toOpenAIMessages(req.messages),
      ...(req.maxTokens && { max_completion_tokens: req.maxTokens }),
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      ...(req.tools?.length && {
        tools: req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      }),
    };
    const res = await networkGuard(
      this.f(`${this.base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.auth() },
        body: JSON.stringify(body),
        signal: req.signal,
      }),
    );

    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage: { inputTokens: number; outputTokens: number } | null = null;
    for await (const data of sseData(res)) {
      if (data === "[DONE]") break;
      const ev = JSON.parse(data);
      if (ev.usage) usage = { inputTokens: ev.usage.prompt_tokens ?? 0, outputTokens: ev.usage.completion_tokens ?? 0 };
      const delta = ev.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) yield { type: "text", text: delta.content };
      for (const tc of delta.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
    }
    for (const c of calls.values()) yield { type: "tool_call", id: c.id, name: c.name, args: c.args ? JSON.parse(c.args) : {} };
    if (usage) yield { type: "usage", ...usage };
    yield { type: "done" };
  }

  async embed(texts: string[], model: string): Promise<number[][]> {
    const res = await networkGuard(
      this.f(`${this.base}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.auth() },
        body: JSON.stringify({ model, input: texts }),
      }),
    );
    if (!res.ok) throw httpError(res.status, await res.text());
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  async transcribe(audio: Uint8Array, opts: TranscribeOptions): Promise<Transcript> {
    const form = new FormData();
    form.set("file", new Blob([audio as BlobPart], { type: opts.mime ?? "application/octet-stream" }), opts.filename ?? "audio.webm");
    form.set("model", opts.model);
    if (opts.language) form.set("language", opts.language);
    // Les modèles « diarize » identifient les interlocuteurs ; whisper-1 donne des segments horodatés ; les autres, du texte.
    const diarize = /diarize/i.test(opts.model);
    form.set("response_format", diarize ? "diarized_json" : opts.model === "whisper-1" ? "verbose_json" : "json");
    if (diarize) form.set("chunking_strategy", "auto");
    const res = await networkGuard(
      this.f(`${this.base}/audio/transcriptions`, { method: "POST", headers: this.auth(), body: form, signal: opts.signal }),
    );
    if (!res.ok) throw httpError(res.status, await res.text());
    const j = (await res.json()) as { text?: string; segments?: { start?: number; end?: number; speaker?: string; text?: string }[] };
    const segments = (j.segments ?? [])
      .filter((s) => typeof s.text === "string" && s.text.trim())
      .map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, speaker: s.speaker, text: s.text!.trim() }));
    const text = (j.text ?? segments.map((s) => s.text).join(" ")).trim();
    return { text, ...(segments.length && { segments }) };
  }

  async testConnection() {
    try {
      const res = await this.f(`${this.base}/models`, { headers: this.auth() });
      if (!res.ok) return { ok: false, error: httpError(res.status, await res.text()).message };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
