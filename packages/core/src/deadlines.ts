import { randomUUID } from "node:crypto";
import { audit, type Db } from "@assistant/db";
import type { CalendarService } from "./calendar";
import { slug } from "./memory";
import type { TaskService } from "./tasks";

export const KINDS = ["invoice", "subscription", "contract", "renewal", "warranty", "tax", "insurance", "other"] as const;
export const PERIODS = ["weekly", "monthly", "quarterly", "yearly", "one_off"] as const;
export type Kind = (typeof KINDS)[number];
export type Period = (typeof PERIODS)[number];

export interface DeadlineInput {
  service: string;
  kind: Kind;
  amount?: number | null;
  currency?: string;
  periodicity?: Period;
  nextDate?: number | null;
  cancelBy?: number | null;
  notes?: string;
}

export interface DeadlineMeta {
  sourceRef?: { type: string; id: string } | null;
  confidence?: number | null;
  aiAdded?: boolean;
}

const DAY = 86_400_000;
const COLS = `id, service, kind, amount, currency, periodicity, next_date AS nextDate, cancel_by AS cancelBy, status, notes,
  source_ref AS sourceRef, confidence, price_history AS priceHistory, event_id AS eventId, task_id AS taskId, created_at AS createdAt`;

type Row = ReturnType<typeof shape>;
function shape(r: any) {
  return { ...r, sourceRef: r.sourceRef ? (JSON.parse(r.sourceRef) as { type: string; id: string }) : null, priceHistory: JSON.parse(r.priceHistory) as { at: number; amount: number }[] };
}

function validate(i: DeadlineInput) {
  const service = String(i.service ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!service) throw new Error("Service requis");
  if (!(KINDS as readonly string[]).includes(i.kind)) throw new Error("Type d'échéance inconnu");
  const periodicity = (i.periodicity ?? "one_off") as Period;
  if (!(PERIODS as readonly string[]).includes(periodicity)) throw new Error("Périodicité inconnue");
  const amount = i.amount == null ? null : Number(i.amount);
  if (amount !== null && (!Number.isFinite(amount) || amount < 0 || amount > 1e8)) throw new Error("Montant invalide");
  const date = (v: unknown) => (v == null ? null : Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : (() => { throw new Error("Date invalide"); })());
  const nextDate = date(i.nextDate);
  const cancelBy = date(i.cancelBy);
  if (nextDate !== null && cancelBy !== null && cancelBy > nextDate) throw new Error("La date limite de résiliation doit précéder l'échéance");
  const currency = String(i.currency ?? "EUR").toUpperCase().slice(0, 3) || "EUR";
  return { service, kind: i.kind, amount, currency, periodicity, nextDate, cancelBy, notes: String(i.notes ?? "").slice(0, 2000) };
}

const fmtDate = (t: number) => new Date(t).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
const perMonth = (amount: number, p: Period) => (p === "weekly" ? (amount * 52) / 12 : p === "monthly" ? amount : p === "quarterly" ? amount / 3 : p === "yearly" ? amount / 12 : 0);

export class DeadlineService {
  constructor(
    private db: Db,
    private cal: CalendarService,
    private tasks: TaskService,
  ) {}

  list(status?: "active" | "cancelled" | "paid") {
    const rows = this.db
      .prepare(`SELECT ${COLS} FROM deadlines ${status ? "WHERE status=?" : ""} ORDER BY (next_date IS NULL), next_date`)
      .all(...(status ? [status] : [])) as any[];
    const all = rows.map(shape);
    // Signalements : doublons (même service récurrent actif en double) et hausses de prix.
    const recurring = all.filter((d) => d.status === "active" && d.periodicity !== "one_off");
    const counts = new Map<string, number>();
    for (const d of recurring) counts.set(slug(d.service), (counts.get(slug(d.service)) ?? 0) + 1);
    return all.map((d) => {
      const h = d.priceHistory;
      const last = h.at(-1)?.amount;
      const prev = h.at(-2)?.amount;
      return { ...d, duplicate: d.status === "active" && d.periodicity !== "one_off" && (counts.get(slug(d.service)) ?? 0) > 1,
        priceIncrease: last !== undefined && prev !== undefined && last > prev ? { from: prev, to: last } : null };
    });
  }

  get(id: string): Row {
    const r = this.db.prepare(`SELECT ${COLS} FROM deadlines WHERE id=?`).get(id);
    if (!r) throw new Error("Échéance introuvable");
    return shape(r);
  }

  /** Total mensuel et annuel des abonnements actifs, par devise. */
  summary() {
    const totals = new Map<string, number>();
    let count = 0;
    for (const d of this.list("active")) {
      if (d.periodicity === "one_off" || d.amount == null) continue;
      count++;
      totals.set(d.currency, (totals.get(d.currency) ?? 0) + perMonth(d.amount, d.periodicity as Period));
    }
    return { recurringCount: count, totals: [...totals].map(([currency, monthly]) => ({ currency, monthly: Math.round(monthly * 100) / 100, yearly: Math.round(monthly * 1200) / 100 })) };
  }

  findActive(service: string, kind: string) {
    const r = this.db.prepare(`SELECT ${COLS} FROM deadlines WHERE status='active' AND kind=?`).all(kind) as any[];
    const s = slug(service);
    const hit = r.find((x) => slug(x.service) === s);
    return hit ? shape(hit) : null;
  }

  /** Crée l'échéance et, automatiquement, l'événement (date d'échéance) et la tâche (résiliation) liés. */
  create(i: DeadlineInput, meta: DeadlineMeta = {}): Row {
    const v = validate(i);
    const id = `dl:${randomUUID()}`;
    const now = Date.now();
    const history = v.amount !== null ? [{ at: now, amount: v.amount }] : [];
    this.db
      .prepare(
        `INSERT INTO deadlines(id, service, kind, amount, currency, periodicity, next_date, cancel_by, notes, source_ref, confidence, price_history, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, v.service, v.kind, v.amount, v.currency, v.periodicity, v.nextDate, v.cancelBy, v.notes,
        meta.sourceRef ? JSON.stringify(meta.sourceRef) : null, meta.confidence ?? null, JSON.stringify(history), now, now);
    this.syncLinks(id, meta);
    audit(this.db, meta.aiAdded ? "ai" : "user", "deadline.create", { id, service: v.service });
    return this.get(id);
  }

  /** Met à jour (ex. nouvelle facture d'un abonnement connu) en gardant l'historique des montants. */
  update(id: string, i: DeadlineInput, meta: DeadlineMeta = {}): Row {
    const before = this.get(id);
    const v = validate(i);
    const history = [...before.priceHistory];
    if (v.amount !== null && v.amount !== history.at(-1)?.amount) history.push({ at: Date.now(), amount: v.amount });
    this.db
      .prepare("UPDATE deadlines SET service=?, kind=?, amount=?, currency=?, periodicity=?, next_date=?, cancel_by=?, notes=?, price_history=?, updated_at=? WHERE id=?")
      .run(v.service, v.kind, v.amount, v.currency, v.periodicity, v.nextDate, v.cancelBy, v.notes, JSON.stringify(history), Date.now(), id);
    this.syncLinks(id, meta);
    audit(this.db, "user", "deadline.update", { id });
    return this.get(id);
  }

  setStatus(id: string, status: "active" | "cancelled" | "paid") {
    this.get(id);
    this.db.prepare("UPDATE deadlines SET status=?, updated_at=? WHERE id=?").run(status, Date.now(), id);
    if (status !== "active") this.dropLinks(id);
    else this.syncLinks(id, {});
  }

  delete(id: string) {
    this.get(id);
    this.dropLinks(id);
    this.db.prepare("DELETE FROM deadlines WHERE id=?").run(id);
    audit(this.db, "user", "deadline.delete", { id });
  }

  private dropLinks(id: string) {
    const d = this.get(id);
    if (d.eventId) { try { this.cal.removeRaw(d.eventId); } catch {} }
    if (d.taskId) { try { this.tasks.removeRaw(d.taskId); } catch {} }
    this.db.prepare("UPDATE deadlines SET event_id=NULL, task_id=NULL WHERE id=?").run(id);
  }

  /** Aligne l'événement et la tâche liés sur les dates de l'échéance. */
  private syncLinks(id: string, meta: DeadlineMeta) {
    const d = this.get(id);
    this.dropLinks(id);
    if (d.status !== "active") return;
    const aiMeta = meta.aiAdded ? { aiAdded: true as const, confidence: meta.confidence ?? 0.8, sourceRef: meta.sourceRef ?? null } : undefined;
    let eventId: string | null = null;
    let taskId: string | null = null;
    if (d.nextDate) {
      const amount = d.amount != null ? ` — ${d.amount.toLocaleString("fr-FR")} ${d.currency}` : "";
      eventId = this.cal.create({ title: `Échéance : ${d.service}${amount}`, start: d.nextDate, end: d.nextDate + DAY, allDay: true }, aiMeta).id;
    }
    if (d.cancelBy) {
      taskId = this.tasks.create(
        { title: `Résilier ${d.service} avant le ${fmtDate(d.cancelBy)}`, due: d.cancelBy, priority: 1 },
        { aiAdded: !!meta.aiAdded, confidence: meta.confidence ?? null, sourceRef: meta.sourceRef ?? null },
        meta.aiAdded ? "ai" : "user",
      ).id;
    }
    this.db.prepare("UPDATE deadlines SET event_id=?, task_id=? WHERE id=?").run(eventId, taskId, id);
  }

  /**
   * Alertes à déclencher maintenant (échéance et date limite de résiliation).
   * Pour chaque date, seul le seuil le plus proche franchi est notifié : une échéance saisie à J-5 ne déclenche pas
   * les alertes « 30 jours » et « 7 jours » en rafale. Les seuils dépassés sont marqués pour ne pas revenir.
   */
  fireAlerts(alertDays: number[], now = Date.now()) {
    const days = [...new Set(alertDays)].sort((a, b) => a - b);
    const out: { deadlineId: string; service: string; kind: "due" | "cancel"; days: number; date: number }[] = [];
    const mark = this.db.prepare("INSERT OR IGNORE INTO deadline_alerts(deadline_id, kind, days, target_date, fired_at) VALUES (?,?,?,?,?)");
    for (const d of this.list("active")) {
      for (const [kind, date] of [["due", d.nextDate], ["cancel", d.cancelBy]] as const) {
        if (date == null || date < now - DAY) continue; // passée depuis plus d'un jour : trop tard pour alerter
        const crossed = days.filter((n) => now >= date - n * DAY);
        if (!crossed.length) continue;
        const smallest = crossed[0]!;
        let fresh = false;
        for (const n of crossed) if (mark.run(d.id, kind, n, date, now).changes && n === smallest) fresh = true;
        if (fresh) out.push({ deadlineId: d.id, service: d.service, kind, days: smallest, date });
      }
    }
    return out;
  }

  /** Prochaines échéances (pour l'affichage), triées par date. */
  upcoming(withinDays: number, now = Date.now()) {
    const items: { deadlineId: string; service: string; kind: "due" | "cancel"; date: number; amount: number | null }[] = [];
    for (const d of this.list("active")) {
      for (const [kind, date] of [["due", d.nextDate], ["cancel", d.cancelBy]] as const)
        if (date != null && date >= now - DAY && date <= now + withinDays * DAY) items.push({ deadlineId: d.id, service: d.service, kind, date, amount: d.amount });
    }
    return items.sort((a, b) => a.date - b.date);
  }
}
