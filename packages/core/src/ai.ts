import {
  AIRouter,
  CostTracker,
  createProvider,
  type AIProvider,
  type FetchFn,
  type Price,
  type TaskKind,
} from "@assistant/ai";
import type { Db } from "@assistant/db";
import type { Settings } from "@assistant/schemas";

/** Prix indicatifs (USD / M tokens), surchargeables : à tenir à jour avec les tarifs des fournisseurs. */
export const DEFAULT_PRICES: Record<string, Price> = {};

export function buildProviders(
  settings: Settings,
  keys: ReadonlyMap<string, string>,
  fetchFn?: FetchFn,
): Record<string, AIProvider> {
  const out: Record<string, AIProvider> = {};
  for (const [id, cfg] of Object.entries(settings.ai.providers)) {
    const key = keys.get(id);
    if (key) out[id] = createProvider(id, cfg, key, fetchFn);
  }
  return out;
}

function startOf(unit: "day" | "month", now: number) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (unit === "month") d.setDate(1);
  return d.getTime();
}

export function usageTotals(db: Db, now = Date.now()) {
  const sum = (since: number) =>
    (db.prepare("SELECT COALESCE(SUM(usd),0) AS s FROM usage_log WHERE at >= ?").get(since) as { s: number }).s;
  return { todayUsd: sum(startOf("day", now)), monthUsd: sum(startOf("month", now)) };
}

/** Routeur branché sur la base : coûts persistés et plafonds issus des settings. */
export function buildRouter(db: Db, settings: Settings, providers: Record<string, AIProvider>) {
  const tracker = new CostTracker(settings.ai.limits);
  const { todayUsd, monthUsd } = usageTotals(db);
  // Réhydrate le suivi à partir de la base (le mois couvre aussi le jour).
  tracker.record(monthUsd - todayUsd, startOf("month", Date.now()));
  tracker.record(todayUsd);
  const insert = db.prepare("INSERT INTO usage_log(at, task, provider, model, usd) VALUES (?,?,?,?,?)");
  return new AIRouter({
    providers,
    routes: settings.ai.routes as never,
    prices: DEFAULT_PRICES,
    tracker,
    redactSensitive: settings.ai.redactSensitive,
    audit: (e) => insert.run(Date.now(), e.task satisfies TaskKind, e.route.provider, e.route.model, e.usd),
  });
}
