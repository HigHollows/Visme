import { createHash, randomUUID } from "node:crypto";
import { audit, type Db } from "@assistant/db";
import type { CalendarService } from "./calendar";
import type { TaskService } from "./tasks";

export type SourceRef = { type: string; id: string } | null;

export interface NewProposal {
  kind: "event" | "task";
  title: string;
  payload: Record<string, unknown>;
  reason: string;
  sourceRef: SourceRef;
  /** Expéditeur : sert à apprendre des refus. */
  sourceKey: string | null;
  confidence: number;
}

const COLS = `id, kind, status, title, payload, reason, source_ref AS sourceRef, source_key AS sourceKey,
  confidence, created_at AS createdAt, decided_at AS decidedAt, result_ref AS resultRef`;

function shape(r: any) {
  return { ...r, payload: JSON.parse(r.payload), sourceRef: r.sourceRef ? JSON.parse(r.sourceRef) : null };
}

const normTitle = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function dedupeKey(p: Pick<NewProposal, "kind" | "title" | "payload" | "sourceRef">) {
  const when = String((p.payload.start ?? p.payload.due ?? "") as string | number);
  return createHash("sha1")
    .update([p.kind, normTitle(p.title), when.slice(0, 16), p.sourceRef?.id ?? ""].join("|"))
    .digest("hex");
}

export class ProposalService {
  constructor(
    private db: Db,
    private cal: CalendarService,
    private tasks: TaskService,
  ) {}

  /** Crée une proposition ; renvoie null si elle existe déjà (même mail, même objet), y compris déjà refusée. */
  create(p: NewProposal, status: "pending" | "auto" = "pending", resultRef: string | null = null) {
    const id = `prop:${randomUUID()}`;
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO proposals(id, kind, status, title, payload, reason, source_ref, source_key, confidence, dedupe_key, created_at, decided_at, result_ref)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, p.kind, status, p.title, JSON.stringify(p.payload), p.reason, p.sourceRef ? JSON.stringify(p.sourceRef) : null,
        p.sourceKey, p.confidence, dedupeKey(p), Date.now(), status === "auto" ? Date.now() : null, resultRef);
    return r.changes ? id : null;
  }

  isKnown(p: Pick<NewProposal, "kind" | "title" | "payload" | "sourceRef">) {
    return !!this.db.prepare("SELECT 1 FROM proposals WHERE dedupe_key=?").get(dedupeKey(p));
  }

  list(status: "pending" | "decided" = "pending", limit = 200) {
    const where = status === "pending" ? "status='pending'" : "status<>'pending'";
    const order = status === "pending" ? "created_at DESC" : "decided_at DESC";
    return this.db.prepare(`SELECT ${COLS} FROM proposals WHERE ${where} ORDER BY ${order} LIMIT ?`).all(limit).map(shape);
  }

  count() {
    return (this.db.prepare("SELECT count(*) AS n FROM proposals WHERE status='pending'").get() as { n: number }).n;
  }

  private pending(id: string) {
    const r = this.db.prepare(`SELECT ${COLS} FROM proposals WHERE id=?`).get(id);
    if (!r) throw new Error("Proposition introuvable");
    const p = shape(r);
    if (p.status !== "pending") throw new Error("Cette proposition a déjà été traitée");
    return p;
  }

  /** Exécute la proposition (éventuellement modifiée) et la marque acceptée. */
  accept(id: string, edits: Record<string, unknown> = {}) {
    const p = this.pending(id);
    const d = { ...p.payload, ...edits } as Record<string, any>;
    let resultRef: string;
    if (p.kind === "event") {
      const ev = this.cal.create(
        { title: d.title ?? p.title, start: Number(d.start), end: Number(d.end), allDay: !!d.allDay, location: d.location, description: d.description },
        { aiAdded: true, confidence: p.confidence, sourceRef: p.sourceRef },
      );
      resultRef = ev.id;
    } else {
      const t = this.tasks.create(
        { title: d.title ?? p.title, due: d.due ?? null, notes: d.notes, priority: d.priority },
        { aiAdded: true, confidence: p.confidence, sourceRef: p.sourceRef },
        "user", // l'utilisateur a validé : action de sa part
      );
      resultRef = t.id;
    }
    this.db
      .prepare("UPDATE proposals SET status='accepted', decided_at=?, result_ref=?, payload=?, title=? WHERE id=?")
      .run(Date.now(), resultRef, JSON.stringify(d), String(d.title ?? p.title), id);
    audit(this.db, "user", "proposal.accept", { id, kind: p.kind, resultRef, edited: Object.keys(edits).length > 0 });
    return { resultRef };
  }

  reject(id: string) {
    const p = this.pending(id);
    this.db.prepare("UPDATE proposals SET status='rejected', decided_at=? WHERE id=?").run(Date.now(), id);
    audit(this.db, "user", "proposal.reject", { id, kind: p.kind, title: p.title });
  }

  /** Bilan des décisions pour un expéditeur : l'IA cesse de proposer si tout est refusé. */
  senderStats(sourceKey: string) {
    const rows = this.db
      .prepare("SELECT status, count(*) AS n FROM proposals WHERE source_key=? GROUP BY status")
      .all(sourceKey) as { status: string; n: number }[];
    const get = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
    return { accepted: get("accepted") + get("auto"), rejected: get("rejected") };
  }

  recentRefusals(limit = 8) {
    return (this.db
      .prepare("SELECT title FROM proposals WHERE status='rejected' ORDER BY decided_at DESC LIMIT ?")
      .all(limit) as { title: string }[]).map((r) => r.title.slice(0, 80));
  }
}
