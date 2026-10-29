import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@assistant/db";
import { describe, expect, it } from "vitest";
import { CalendarService, DeadlineService, ProposalService, TaskService } from "../src";
import { validateObligations } from "../src/agent/analyze";
import { handleObligations } from "../src/agent/obligations";

const DAY = 86_400_000;
const NOW = new Date(2026, 2, 10, 9).getTime();
const at = (d: number) => NOW + d * DAY;

function setup() {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "dl-")), "t.db"), { key: "k" });
  const cal = new CalendarService({ db, auth: {} as never, notify: () => {} });
  const tasks = new TaskService(db);
  const deadlines = new DeadlineService(db, cal, tasks);
  const proposals = new ProposalService(db, cal, tasks, deadlines);
  return { db, cal, tasks, deadlines, proposals };
}

describe("échéances", () => {
  it("crée l'échéance avec son événement (échéance) et sa tâche (résiliation) liés", () => {
    const { deadlines, cal, tasks } = setup();
    const d = deadlines.create({ service: "Netflix", kind: "subscription", amount: 13.49, periodicity: "monthly", nextDate: at(20), cancelBy: at(10) });
    expect(cal.get(d.eventId!)).toMatchObject({ title: expect.stringContaining("Échéance : Netflix"), allDay: true, start: at(20) });
    expect(tasks.get(d.taskId!)).toMatchObject({ title: expect.stringContaining("Résilier Netflix"), due: at(10), priority: 1 });
    // changer les dates met à jour les éléments liés sans doublon
    const u = deadlines.update(d.id, { service: "Netflix", kind: "subscription", amount: 13.49, periodicity: "monthly", nextDate: at(30), cancelBy: at(25) });
    expect(cal.list(at(29), at(32))).toHaveLength(1);
    expect(cal.list(at(19), at(22))).toHaveLength(0);
    expect(tasks.list().filter((t: any) => t.status === "open")).toHaveLength(1);
    expect(u.eventId).not.toBe(d.eventId);
  });

  it("résilier ou supprimer retire l'événement et la tâche liés", () => {
    const { deadlines, cal, tasks } = setup();
    const d = deadlines.create({ service: "Salle de sport", kind: "subscription", amount: 30, periodicity: "monthly", nextDate: at(5), cancelBy: at(3) });
    deadlines.setStatus(d.id, "cancelled");
    expect(cal.list(at(0), at(10))).toHaveLength(0);
    expect(tasks.list()).toHaveLength(0);
    deadlines.setStatus(d.id, "active");
    expect(cal.list(at(0), at(10))).toHaveLength(1);
    deadlines.delete(d.id);
    expect(deadlines.list()).toHaveLength(0);
    expect(cal.list(at(0), at(10))).toHaveLength(0);
  });

  it("valide les entrées", () => {
    const { deadlines } = setup();
    const base = { service: "X", kind: "invoice" as const };
    expect(() => deadlines.create({ ...base, service: " " })).toThrow(/Service/);
    expect(() => deadlines.create({ ...base, kind: "bidon" as never })).toThrow(/Type/);
    expect(() => deadlines.create({ ...base, amount: -3 })).toThrow(/Montant/);
    expect(() => deadlines.create({ ...base, nextDate: at(5), cancelBy: at(9) })).toThrow(/précéder/);
  });

  it("totaux mensuel/annuel, doublons et hausses de prix", () => {
    const { deadlines } = setup();
    deadlines.create({ service: "Spotify", kind: "subscription", amount: 10, periodicity: "monthly", nextDate: at(5) });
    deadlines.create({ service: "Assurance auto", kind: "insurance", amount: 600, periodicity: "yearly", nextDate: at(100) });
    deadlines.create({ service: "Journal", kind: "subscription", amount: 30, periodicity: "quarterly", nextDate: at(40) });
    deadlines.create({ service: "Facture ponctuelle", kind: "invoice", amount: 999, periodicity: "one_off", nextDate: at(2) });
    deadlines.create({ service: "spotify ", kind: "subscription", amount: 10, periodicity: "monthly", nextDate: at(6) }); // doublon
    const s = deadlines.summary();
    expect(s.totals).toEqual([{ currency: "EUR", monthly: 80, yearly: 960 }]); // 10 + 50 + 10 + 10 ; la facture ponctuelle est exclue
    const list = deadlines.list();
    expect(list.filter((d) => d.duplicate).map((d) => d.service)).toEqual(["Spotify", "spotify"]);

    const j = list.find((d) => d.service === "Journal")!;
    expect(j.priceIncrease).toBeNull();
    deadlines.update(j.id, { service: "Journal", kind: "subscription", amount: 36, periodicity: "quarterly", nextDate: at(40) });
    expect(deadlines.list().find((d) => d.id === j.id)!.priceIncrease).toEqual({ from: 30, to: 36 });
  });

  it("alertes 30/7/1 : une seule alerte par date (le seuil le plus proche), jamais deux fois", () => {
    const { deadlines } = setup();
    const d = deadlines.create({ service: "Taxe", kind: "tax", nextDate: at(40), cancelBy: at(5) });
    const days = [30, 7, 1];
    expect(deadlines.fireAlerts(days, NOW)).toEqual([expect.objectContaining({ kind: "cancel", days: 7 })]); // J-5 : seuil 7 j, pas 30 en plus
    expect(deadlines.fireAlerts(days, NOW + 1 * DAY)).toEqual([]); // rien de nouveau
    expect(deadlines.fireAlerts(days, at(11))).toEqual([expect.objectContaining({ kind: "due", days: 30 })]);
    expect(deadlines.fireAlerts(days, at(33))).toEqual([expect.objectContaining({ kind: "due", days: 7 })]);
    expect(deadlines.fireAlerts(days, at(39.5))).toEqual([expect.objectContaining({ kind: "due", days: 1 })]);
    expect(deadlines.fireAlerts(days, at(39.6))).toEqual([]);
    // une date modifiée re-déclenche
    deadlines.update(d.id, { service: "Taxe", kind: "tax", nextDate: at(45) });
    expect(deadlines.fireAlerts(days, at(44.5))).toEqual([expect.objectContaining({ kind: "due", days: 1 })]);
    // l'échéance passée depuis longtemps n'alerte plus
    expect(deadlines.fireAlerts(days, at(80))).toEqual([]);
  });
});

describe("extraction des échéances", () => {
  const body = "Votre abonnement Netflix à 17,99 € par mois sera renouvelé le 15 avril. Résiliation possible jusqu'au 10 avril.";
  const raw = [{ service: "Netflix", kind: "subscription", amount: 17.99, currency: "eur", periodicity: "monthly", nextDate: "2026-04-15", cancelBy: "2026-04-10", confidence: 0.9, evidence: "abonnement Netflix à 17,99 € par mois" }];

  it("valide, normalise et vérifie la preuve", () => {
    const [o] = validateObligations(raw, body, NOW);
    expect(o).toMatchObject({ service: "Netflix", amount: 17.99, currency: "EUR", periodicity: "monthly", evidenceFound: true, confidence: 0.9 });
    const [h] = validateObligations([{ ...raw[0], evidence: "texte inventé" }], body, NOW);
    expect(h!.confidence).toBeCloseTo(0.45);
  });

  it("écarte dates absentes/incohérentes/trop anciennes et montants absurdes", () => {
    const bad = [
      { ...raw[0], nextDate: null, cancelBy: null },
      { ...raw[0], nextDate: "2026-04-10", cancelBy: "2026-04-15" }, // résiliation après l'échéance
      { ...raw[0], nextDate: "2020-01-01", cancelBy: null },
      { ...raw[0], service: "" },
      { ...raw[0], amount: -5, kind: "n'importe quoi", periodicity: "jamais" },
    ];
    const out = validateObligations(bad, body, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ amount: null, kind: "other", periodicity: "one_off" });
  });
});

describe("traitement des échéances détectées (handleObligations)", () => {
  const body = "Netflix 17,99 € / mois. Renouvellement le 15 avril. Résiliation avant le 10 avril.";
  const ob = (over = {}) => validateObligations([{ service: "Netflix", kind: "subscription", amount: 17.99, periodicity: "monthly", nextDate: "2026-04-15", cancelBy: "2026-04-10", confidence: 0.9, evidence: "Netflix 17,99 € / mois", ...over }], body, NOW);
  const src = { ref: { type: "mail", id: "m1" }, key: "billing@netflix.com", label: "Mail Netflix" };

  it("proposer : une suggestion « À valider », exécutée à l'acceptation (échéance + événement + tâche)", () => {
    const { db, deadlines, proposals, cal, tasks } = setup();
    const deps = { db, deadlines, proposals, autonomy: "propose" as const, threshold: 0.7 };
    expect(handleObligations(deps, ob(), src)).toEqual({ auto: 0, proposed: 1 });
    expect(deadlines.list()).toHaveLength(0);
    expect(handleObligations(deps, ob(), src)).toEqual({ auto: 0, proposed: 0 }); // même mail : pas de doublon
    const [p] = proposals.list();
    expect(p).toMatchObject({ kind: "deadline" });
    proposals.accept(p.id);
    const [d] = deadlines.list();
    expect(d).toMatchObject({ service: "Netflix", amount: 17.99 });
    expect(cal.get(d!.eventId!)).toMatchObject({ aiAdded: true });
    expect(tasks.get(d!.taskId!)).toMatchObject({ aiAdded: true });
  });

  it("« agir avec validation » : les échéances (argent) ne sont jamais ajoutées seules ; « agir seul » oui, si fiable", () => {
    const a = setup();
    expect(handleObligations({ db: a.db, deadlines: a.deadlines, proposals: a.proposals, autonomy: "act_with_approval", threshold: 0.7 }, ob(), src)).toEqual({ auto: 0, proposed: 1 });
    const b = setup();
    expect(handleObligations({ db: b.db, deadlines: b.deadlines, proposals: b.proposals, autonomy: "act_alone", threshold: 0.7 }, ob(), src)).toEqual({ auto: 1, proposed: 0 });
    expect(b.deadlines.list()).toHaveLength(1);
    expect(handleObligations({ db: b.db, deadlines: b.deadlines, proposals: b.proposals, autonomy: "act_alone", threshold: 0.7 }, ob(), { ...src, ref: { type: "mail", id: "m2" } })).toEqual({ auto: 0, proposed: 0 }); // déjà connue
    const c = setup();
    expect(handleObligations({ db: c.db, deadlines: c.deadlines, proposals: c.proposals, autonomy: "act_alone", threshold: 0.7 }, ob({ evidence: "inventé" }), src)).toEqual({ auto: 0, proposed: 1 }); // sans preuve → À valider
  });

  it("abonnement connu : un nouveau montant propose une mise à jour et garde l'historique de prix", () => {
    const { db, deadlines, proposals } = setup();
    const deps = { db, deadlines, proposals, autonomy: "propose" as const, threshold: 0.7 };
    const known = deadlines.create({ service: "Netflix", kind: "subscription", amount: 13.49, periodicity: "monthly", nextDate: new Date(2026, 3, 15).getTime() });
    expect(handleObligations(deps, ob({ amount: 17.99 }), src)).toEqual({ auto: 0, proposed: 1 });
    const [p] = proposals.list();
    expect(p!.title).toContain("Mise à jour");
    proposals.accept(p!.id);
    expect(deadlines.list()).toHaveLength(1); // mise à jour, pas de doublon
    expect(deadlines.get(known.id).priceHistory.map((h: { amount: number }) => h.amount)).toEqual([13.49, 17.99]);
    expect(deadlines.list()[0]!.priceIncrease).toEqual({ from: 13.49, to: 17.99 });
  });
});
