import { tr } from "./i18n";
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
  { id: "triage", label: tr("Tri des mails"), hint: tr("modèle économique") },
  { id: "extraction", label: tr("Extraction (dates, montants)"), hint: tr("économique") },
  { id: "summary", label: tr("Résumés"), hint: tr("intermédiaire") },
  { id: "chat", label: tr("Chat"), hint: tr("modèle puissant") },
  { id: "draft", label: tr("Rédaction de brouillons"), hint: tr("modèle puissant") },
  { id: "embedding", label: tr("Embeddings"), hint: tr("OpenAI ou compatible") },
  { id: "ocr", label: tr("OCR (vision)"), hint: tr("modèle avec vision") },
  { id: "stt", label: tr("Transcription audio"), hint: tr("OpenAI ou compatible") },
];

export type Autonomy = "observe" | "propose" | "act_with_approval" | "act_alone";
export interface AgentSettings {
  enabled: boolean; autonomy: Autonomy; syncIntervalMinutes: number; eventConfidenceThreshold: number; draftOnly: boolean;
}
export interface Proposal {
  id: string; kind: "event" | "task" | "deadline"; status: string; title: string; reason: string; confidence: number;
  payload: { title?: string; start?: number; end?: number; allDay?: boolean; location?: string; due?: number | null; [k: string]: unknown };
  sourceRef: { type: string; id: string } | null; createdAt: number; decidedAt: number | null;
}
export const CATEGORY_LABEL: Record<string, string> = {
  important: tr("Important"), to_reply: tr("À répondre"), invoice: tr("Facture"), newsletter: tr("Newsletter"), spam: tr("Spam"), pro: tr("Pro"), perso: tr("Perso"),
};

export interface Preset {
  id: string; name: string; systemPrompt: string; tools: string[]; tone: string; language: string;
  provider: string | null; model: string | null; builtin: boolean;
}
export interface SourceRef { n: number; type: "document" | "mail" | "event" | "conversation"; id: string; title: string }
export interface StyleProfile {
  greetings: string[]; closings: string[]; formality: "tu" | "vous" | "mixte"; length: "court" | "moyen" | "long";
  tone: string; signature: string; notes: string;
}
export const KIND_LABEL: Record<string, string> = {
  invoice: tr("Facture"), subscription: tr("Abonnement"), contract: tr("Contrat"), renewal: tr("Renouvellement"),
  warranty: tr("Garantie"), tax: tr("Impôt"), insurance: tr("Assurance"), other: tr("Autre"),
};
export const PERIOD_LABEL: Record<string, string> = { weekly: tr("Hebdo"), monthly: tr("Mensuel"), quarterly: tr("Trimestriel"), yearly: tr("Annuel"), one_off: tr("Ponctuel") };
export const PERMISSION_LABELS: Record<string, string> = {
  ai: tr("Utiliser l'IA configurée (consomme du budget)"),
  "documents:read": tr("Lire vos documents (résumés et texte)"),
  "mail:read": tr("Lire vos mails"),
  "calendar:read": tr("Lire votre calendrier"),
  "memory:read": tr("Lire le graphe de mémoire"),
  "memory:write": tr("Ajouter des liens au graphe de mémoire"),
  propose: tr("Proposer des tâches/événements (toujours validés par vous)"),
};
export const describePermission = (p: string) => (p.startsWith("net:") ? tr("Accéder au site {0} (HTTPS uniquement)", p.slice(4)) : PERMISSION_LABELS[p] ?? p);
