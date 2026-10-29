export type Role = "system" | "user" | "assistant" | "tool";

export interface ImagePart {
  mime: string;
  /** Base64 sans préfixe data: */
  data: string;
}

/** Document joint (PDF) lu nativement par le modèle : sert à l'OCR des PDF scannés. */
export interface DocumentPart {
  mime: string;
  filename?: string;
  /** Base64 sans préfixe data: */
  data: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** Documents joints (PDF), pour role "user". */
  documents?: DocumentPart[];
  /** Images jointes (vision / OCR), pour role "user". */
  images?: ImagePart[];
  /** Pour role "tool" : l'appel auquel ce message répond. */
  toolCallId?: string;
  /** Pour role "assistant" : appels d'outils émis à ce tour. */
  toolCalls?: { id: string; name: string; args: unknown }[];
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

export interface TranscribeOptions {
  model: string;
  language?: string;
  /** Nom de fichier avec extension (le fournisseur s'en sert pour reconnaître le format). */
  filename?: string;
  mime?: string;
  signal?: AbortSignal;
}

export interface AIProvider {
  readonly id: string;
  readonly capabilities: Capabilities;
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
  embed(texts: string[], model: string): Promise<number[][]>;
  transcribe(audio: Uint8Array, opts: TranscribeOptions): Promise<Transcript>;
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
