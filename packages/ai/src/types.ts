export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  toolCallId?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export type ChatChunk =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done" };

export interface Capabilities {
  chat: boolean;
  tools: boolean;
  vision: boolean;
  embeddings: boolean;
  transcription: boolean;
}

export interface Transcript {
  text: string;
  segments?: { start: number; end: number; speaker?: string; text: string }[];
}

export interface AIProvider {
  readonly id: string;
  readonly capabilities: Capabilities;
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
  embed(texts: string[], model: string): Promise<number[][]>;
  transcribe(audio: Uint8Array, opts: { model: string; language?: string }): Promise<Transcript>;
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}

/** Tâches pour lesquelles un fournisseur/modèle est configurable. */
export type TaskKind =
  | "triage"
  | "extraction"
  | "summary"
  | "chat"
  | "draft"
  | "embedding"
  | "ocr"
  | "stt";

export interface Route {
  provider: string;
  model: string;
}

export interface TaskRoute {
  primary: Route;
  fallback?: Route;
}

export class AIError extends Error {
  constructor(
    message: string,
    readonly kind: "rate_limit" | "unavailable" | "auth" | "budget" | "unsupported" | "other",
  ) {
    super(message);
  }
}
