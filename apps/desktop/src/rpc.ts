import { invoke } from "@tauri-apps/api/core";

export const rpc = <T,>(method: string, params?: unknown) => invoke<T>("rpc", { method, params });

export type Kind = "anthropic" | "openai" | "openai_compatible";
export interface Route { provider: string; model: string }
export interface TaskRoute { primary: Route; fallback?: Route }

export interface AiSettings {
  providers: Record<string, { kind: Kind; baseUrl?: string }>;
  routes: Record<string, TaskRoute>;
  redactSensitive: boolean;
  economyMode: boolean;
  limits: { dailyUsd?: number; monthlyUsd?: number };
}
export interface AppSettings { version: number; ai: AiSettings; [k: string]: unknown }

export interface AiStatus {
  providers: { id: string; hasKey: boolean }[];
  usage: { todayUsd: number; monthUsd: number };
}

export const TASKS: { id: string; label: string; hint: string }[] = [
  { id: "triage", label: "Tri des mails", hint: "modèle économique" },
  { id: "extraction", label: "Extraction (dates, montants)", hint: "économique" },
  { id: "summary", label: "Résumés", hint: "intermédiaire" },
  { id: "chat", label: "Chat", hint: "modèle puissant" },
  { id: "draft", label: "Rédaction de brouillons", hint: "modèle puissant" },
  { id: "embedding", label: "Embeddings", hint: "OpenAI ou compatible" },
  { id: "ocr", label: "OCR (vision)", hint: "modèle avec vision" },
  { id: "stt", label: "Transcription audio", hint: "OpenAI ou compatible" },
];
