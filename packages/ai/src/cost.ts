import { AIError } from "./types";

/** Prix en USD par million de tokens. À surcharger via les settings. */
export interface Price {
  inputPerM: number;
  outputPerM: number;
}

export function computeCost(price: Price, inputTokens: number, outputTokens: number): number {
  return (inputTokens * price.inputPerM + outputTokens * price.outputPerM) / 1_000_000;
}

export interface Limits {
  dailyUsd?: number;
  monthlyUsd?: number;
}

/** Suit la dépense et refuse les appels qui dépasseraient les plafonds. */
export class CostTracker {
  private records: { at: number; usd: number }[] = [];

  constructor(
    private limits: Limits = {},
    private now: () => number = Date.now,
  ) {}

  setLimits(l: Limits) {
    this.limits = l;
  }

  record(usd: number) {
    this.records.push({ at: this.now(), usd });
  }

  private sumSince(start: number) {
    return this.records.filter((r) => r.at >= start).reduce((s, r) => s + r.usd, 0);
  }

  private startOfDay() {
    const d = new Date(this.now());
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  private startOfMonth() {
    const d = new Date(this.now());
    d.setHours(0, 0, 0, 0);
    d.setDate(1);
    return d.getTime();
  }

  today() {
    return this.sumSince(this.startOfDay());
  }

  month() {
    return this.sumSince(this.startOfMonth());
  }

  assertWithinBudget() {
    const { dailyUsd, monthlyUsd } = this.limits;
    if (dailyUsd !== undefined && this.today() >= dailyUsd)
      throw new AIError("Plafond journalier atteint", "budget");
    if (monthlyUsd !== undefined && this.month() >= monthlyUsd)
      throw new AIError("Plafond mensuel atteint", "budget");
  }
}
