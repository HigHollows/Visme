import { audit, type Db } from "@assistant/db";
import type { DeadlineService } from "../deadlines";
import type { ProposalService } from "../proposals";
import { decide, type Autonomy, type ObligationSuggestion } from "./analyze";

export interface ObligationDeps {
  db: Db;
  deadlines: DeadlineService;
  proposals: ProposalService;
  autonomy: Autonomy;
  threshold: number;
}

const near = (a: number | null, b: number | null) => (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) < 3 * 86_400_000);

/**
 * Traite des échéances détectées : met à jour un abonnement connu (nouveau montant, nouvelle date),
 * ignore les redites, sinon propose ou crée selon le niveau d'autonomie. Renvoie (ajouts auto, suggestions).
 */
export function handleObligations(
  d: ObligationDeps,
  obligations: ObligationSuggestion[],
  source: { ref: { type: string; id: string }; key: string | null; label: string },
): { auto: number; proposed: number } {
  let auto = 0;
  let proposed = 0;
  for (const o of obligations) {
    const existing = d.deadlines.findActive(o.service, o.kind);
    if (existing && near(existing.nextDate, o.nextDate) && (o.amount === null || existing.amount === o.amount)) continue; // déjà connue
    const payload = {
      service: o.service, kind: o.kind, amount: o.amount, currency: o.currency, periodicity: o.periodicity,
      nextDate: o.nextDate, cancelBy: o.cancelBy, ...(existing && { updateId: existing.id }),
    };
    const title = `${existing ? "Mise à jour" : "Échéance"} : ${o.service}${o.amount !== null ? ` (${o.amount} ${o.currency})` : ""}`;
    const prop = {
      kind: "deadline" as const, title, payload, sourceRef: source.ref, sourceKey: source.key, confidence: o.confidence,
      reason: `${source.label}${o.evidence ? ` — « ${o.evidence} »` : ""}`,
    };
    if (d.proposals.isKnown(prop)) continue;
    const verdict = decide("deadline", o, d.autonomy === "act_with_approval" ? "propose" : d.autonomy, d.threshold);
    if (verdict === "auto") {
      const input = { service: o.service, kind: o.kind, amount: o.amount, currency: o.currency, periodicity: o.periodicity, nextDate: o.nextDate, cancelBy: o.cancelBy };
      const meta = { aiAdded: true, confidence: o.confidence, sourceRef: source.ref };
      const row = existing ? d.deadlines.update(existing.id, { ...input, notes: existing.notes }, meta) : d.deadlines.create(input, meta);
      d.proposals.create(prop, "auto", row.id);
      audit(d.db, "ai", "deadline.auto", { id: row.id, service: o.service });
      auto++;
    } else if (verdict === "propose" && d.proposals.create(prop)) proposed++;
  }
  return { auto, proposed };
}
