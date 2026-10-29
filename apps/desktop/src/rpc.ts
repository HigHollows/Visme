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
  important: "Important", to_reply: "À répondre", invoice: "Facture", newsletter: "Newsletter", spam: "Spam", pro: "Pro", perso: "Perso",
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
  invoice: "Facture", subscription: "Abonnement", contract: "Contrat", renewal: "Renouvellement",
  warranty: "Garantie", tax: "Impôt", insurance: "Assurance", other: "Autre",
};
export const PERIOD_LABEL: Record<string, string> = { weekly: "Hebdo", monthly: "Mensuel", quarterly: "Trimestriel", yearly: "Annuel", one_off: "Ponctuel" };
export const PERMISSION_LABELS: Record<string, string> = {
  ai: "Utiliser l'IA configurée (consomme du budget)",
  "documents:read": "Lire vos documents (résumés et texte)",
  "mail:read": "Lire vos mails",
  "calendar:read": "Lire votre calendrier",
  "memory:read": "Lire le graphe de mémoire",
  "memory:write": "Ajouter des liens au graphe de mémoire",
  propose: "Proposer des tâches/événements (toujours validés par vous)",
};
export const describePermission = (p: string) => (p.startsWith("net:") ? `Accéder au site ${p.slice(4)} (HTTPS uniquement)` : PERMISSION_LABELS[p] ?? p);
