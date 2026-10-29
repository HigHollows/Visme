import { z } from "zod";

/** Événements auxquels un plugin peut s'abonner. */
export const EVENTS = ["document.indexed", "mail.analyzed", "agent.cycle"] as const;
export type PluginEvent = (typeof EVENTS)[number];

/**
 * Permissions déclarées dans le manifeste. L'utilisateur les accepte explicitement à l'activation ;
 * une permission non accordée rend l'appel d'API correspondant impossible.
 */
export const PERMISSION_RE = /^(ai|documents:read|mail:read|calendar:read|memory:read|memory:write|propose|net:[a-z0-9]([a-z0-9.-]*[a-z0-9])?)$/;

export const PERMISSION_LABELS: Record<string, string> = {
  ai: "Utiliser l'IA configurée (consomme du budget)",
  "documents:read": "Lire vos documents (résumés et texte)",
  "mail:read": "Lire vos mails",
  "calendar:read": "Lire votre calendrier",
  "memory:read": "Lire le graphe de mémoire",
  "memory:write": "Ajouter des liens au graphe de mémoire",
  propose: "Proposer des tâches/événements (toujours validés par vous)",
};

export function describePermission(p: string): string {
  if (p.startsWith("net:")) return `Accéder au site ${p.slice(4)} (HTTPS uniquement)`;
  return PERMISSION_LABELS[p] ?? p;
}

export const manifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, "id invalide (minuscules, chiffres et tirets)"),
  name: z.string().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "version attendue : x.y.z"),
  description: z.string().max(500).default(""),
  author: z.string().max(100).optional(),
  permissions: z.array(z.string().regex(PERMISSION_RE, "permission inconnue")).max(20).default([]),
  triggers: z.array(z.object({ event: z.enum(EVENTS) })).max(10).default([]),
  tools: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/).refine((n) => !n.includes("__"), "« __ » interdit dans un nom d'outil"),
        description: z.string().min(1).max(500),
        parameters: z.record(z.unknown()).default({ type: "object", properties: {} }),
      }),
    )
    .max(20)
    .default([]),
  /** Fichier JavaScript (ES module) relatif au dossier du plugin. */
  entry: z
    .string()
    .regex(/^[\w.-]+(\/[\w.-]+)*\.m?js$/, "entry invalide")
    .refine((e) => !e.split("/").includes(".."), "entry invalide")
    .default("index.mjs"),
});
export type PluginManifest = z.infer<typeof manifestSchema>;

/** API fournie à un plugin ; chaque méthode exige la permission indiquée. */
export interface PluginContext {
  /** permission `ai` */
  ai: { complete(p: { task?: "extraction" | "summary" | "chat" | "triage"; system?: string; prompt: string; maxTokens?: number }): Promise<string> };
  /** permission `documents:read` */
  documents: {
    list(p?: { limit?: number }): Promise<{ id: string; name: string; summary: string | null }[]>;
    get(id: string): Promise<{ id: string; name: string; summary: string | null; tags: string[]; entities: { name: string; type: string }[]; dates: { date: string; label: string }[]; text: string }>;
  };
  /** permission `mail:read` */
  mail: {
    search(p: { q: string; limit?: number }): Promise<{ id: string; subject: string; from: string; date: number; snippet: string }[]>;
    get(id: string): Promise<{ id: string; subject: string; from: string; date: number; body: string }>;
  };
  /** permission `calendar:read` */
  calendar: { list(p: { from: number; to: number }): Promise<{ id: string; title: string; start: number; end: number }[]> };
  /** permissions `memory:read` / `memory:write` */
  memory: {
    neighbors(id: string): Promise<{ id: string; type: string; label: string; rel: string }[]>;
    link(p: { a: MemoryEndpoint; b: MemoryEndpoint; rel: string }): Promise<void>;
  };
  /** permission `propose` : crée une suggestion dans « À valider », jamais une action directe. */
  proposals: {
    create(p: { kind: "task" | "event"; title: string; reason?: string; due?: number; start?: number; end?: number; confidence?: number }): Promise<{ created: boolean }>;
  };
  /** permission `net:<hôte>` */
  net: { fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text: string }> };
  /** Toujours disponible : stockage propre au plugin (100 Ko par valeur, 200 clés). */
  storage: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<void> };
  log(...args: unknown[]): void;
}

export type MemoryEndpoint = { document: string } | { type: "person" | "org" | "project" | "topic"; label: string };

export interface PluginModule {
  /** Gestionnaires d'événements, par nom d'événement déclaré dans `triggers`. */
  on?: Partial<Record<PluginEvent, (ctx: PluginContext, event: any) => Promise<void> | void>>;
  /** Outils exposés au chat, par nom déclaré dans `tools`. Renvoient du texte. */
  tools?: Record<string, (ctx: PluginContext, args: any) => Promise<string> | string>;
}

/** Aide de typage pour les auteurs de plugins (identité à l'exécution). */
export function definePlugin<T extends PluginModule>(p: T): T {
  return p;
}

/** Compare deux versions x.y.z ; renvoie un nombre positif si a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  return 0;
}
