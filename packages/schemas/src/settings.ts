import { z } from "zod";

export const SETTINGS_VERSION = 2;

const route = z.object({ provider: z.string(), model: z.string() });
const taskRoute = z.object({ primary: route, fallback: route.optional() });

export const autonomy = z.enum(["observe", "propose", "act_with_approval", "act_alone"]);

export const settingsSchema = z.object({
  version: z.literal(SETTINGS_VERSION),
  general: z
    .object({
      language: z.enum(["fr", "en"]).default("fr"),
      theme: z.enum(["system", "light", "dark"]).default("system"),
      launchAtLogin: z.boolean().default(false),
      /** Recherche automatique de mises à jour au démarrage (contacte GitHub, n'envoie que la version et le système). */
      checkUpdates: z.boolean().default(true),
    })
    .default({}),
  ai: z
    .object({
      /** Les clés API ne sont JAMAIS ici : elles vivent dans le trousseau système. */
      providers: z
        .record(
          z.object({
            kind: z.enum(["anthropic", "openai", "openai_compatible"]),
            baseUrl: z.string().url().optional(),
          }),
        )
        .default({}),
      routes: z.record(taskRoute).default({}),
      redactSensitive: z.boolean().default(true),
      economyMode: z.boolean().default(false),
      limits: z
        .object({
          dailyUsd: z.number().positive().optional(),
          monthlyUsd: z.number().positive().optional(),
        })
        .default({}),
    })
    .default({}),
  deadlines: z
    .object({
      /** Alertes avant la prochaine échéance et avant la date limite de résiliation. */
      alertDays: z.array(z.number().int().min(0).max(365)).max(8).default([30, 7, 1]),
    })
    .default({}),
  notifications: z
    .object({
      deadlineAlerts: z.boolean().default(true),
      /** Notification système quand l'agent a de nouvelles suggestions à valider. */
      newProposals: z.boolean().default(false),
    })
    .default({}),
  meetings: z
    .object({
      /** Par défaut l'audio est supprimé dès que la transcription est terminée. */
      retainAudio: z.boolean().default(false),
      /** Langue de la réunion (aide la transcription) ; vide = détection automatique. */
      language: z.string().max(10).default(""),
    })
    .default({}),
  capture: z
    .object({
      /** Raccourci global ouvrant la capture rapide (syntaxe Tauri). */
      shortcut: z.string().max(60).default("CommandOrControl+Shift+Space"),
    })
    .default({}),
  style: z
    .object({
      /** Apprentissage de mon style depuis mes mails envoyés : désactivé tant que je n'ai pas donné mon accord. */
      learningEnabled: z.boolean().default(false),
    })
    .default({}),
  agent: z
    .object({
      /** Désactivé par défaut : l'analyse envoie des extraits de mails à l'IA, ce qui exige un accord explicite. */
      enabled: z.boolean().default(false),
      autonomy: autonomy.default("propose"),
      syncIntervalMinutes: z.number().int().min(1).max(1440).default(15),
      eventConfidenceThreshold: z.number().min(0).max(1).default(0.7),
      draftOnly: z.boolean().default(true),
    })
    .default({}),
});

export type Settings = z.infer<typeof settingsSchema>;

/** Migre un JSON de n'importe quelle version antérieure vers la version courante. */
export function migrateSettings(raw: unknown): Settings {
  const obj = (typeof raw === "object" && raw ? { ...(raw as Record<string, unknown>) } : {}) as Record<
    string,
    unknown
  >;
  let v = typeof obj.version === "number" ? obj.version : 1;
  if (v > SETTINGS_VERSION) throw new Error(`Settings v${v} plus récents que l'application`);
  if (v === 1) {
    // v1 : "ai.dailyLimit" à plat → "ai.limits.dailyUsd"
    const ai = { ...((obj.ai as Record<string, unknown>) ?? {}) };
    if (typeof ai.dailyLimit === "number") {
      ai.limits = { ...(ai.limits as object), dailyUsd: ai.dailyLimit };
      delete ai.dailyLimit;
    }
    obj.ai = ai;
    v = 2;
  }
  return settingsSchema.parse({ ...obj, version: v });
}

/** Export JSON : tout champ ressemblant à un secret est retiré. */
export function exportSettings(s: Settings): string {
  const strip = (k: string, v: unknown) => (/key|secret|token|password/i.test(k) ? undefined : v);
  return JSON.stringify(s, strip, 2);
}
