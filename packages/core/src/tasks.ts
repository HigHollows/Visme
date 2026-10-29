import { randomUUID } from "node:crypto";
import { audit, type Db } from "@assistant/db";

export interface TaskInput {
  title: string;
  notes?: string;
  due?: number | null;
  priority?: number;
  project?: string | null;
  labels?: string[];
}

export interface TaskMeta {
  aiAdded?: boolean;
  confidence?: number | null;
  sourceRef?: { type: string; id: string } | null;
}

const COLS = `id, title, notes, due_at AS due, priority, status, project, labels, parent_id AS parentId,
  source_ref AS sourceRef, ai_added AS aiAdded, confidence, created_at AS createdAt, completed_at AS completedAt`;

function shape(r: any) {
  return { ...r, labels: JSON.parse(r.labels), aiAdded: !!r.aiAdded, sourceRef: r.sourceRef ? JSON.parse(r.sourceRef) : null };
}

function validate(t: TaskInput) {
  const title = String(t.title ?? "").replace(/\s+/g, " ").trim();
  if (!title) throw new Error("Titre requis");
  if (title.length > 300) throw new Error("Titre trop long");
  const due = t.due == null ? null : Number(t.due);
  if (due !== null && !Number.isFinite(due)) throw new Error("Échéance invalide");
  const priority = t.priority === 1 ? 1 : 0;
  return {
    title,
    notes: String(t.notes ?? "").slice(0, 5000),
    due: due === null ? null : Math.trunc(due),
    priority,
    project: t.project ? String(t.project).slice(0, 100) : null,
    labels: JSON.stringify((t.labels ?? []).map((l) => String(l).slice(0, 40)).slice(0, 20)),
  };
}

export class TaskService {
  constructor(private db: Db) {}

  list(p: { status?: "open" | "done" } = {}) {
    const where = p.status ? "WHERE status = ?" : "";
    const rows = this.db
      .prepare(`SELECT ${COLS} FROM tasks ${where} ORDER BY (due_at IS NULL), due_at, created_at DESC LIMIT 2000`)
      .all(...(p.status ? [p.status] : []));
    return rows.map(shape);
  }

  get(id: string) {
    const r = this.db.prepare(`SELECT ${COLS} FROM tasks WHERE id=?`).get(id);
    if (!r) throw new Error("Tâche introuvable");
    return shape(r);
  }

  create(t: TaskInput, meta: TaskMeta = {}, actor: "user" | "ai" = meta.aiAdded ? "ai" : "user") {
    const v = validate(t);
    const id = `task:${randomUUID()}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO tasks(id, title, notes, due_at, priority, project, labels, source_ref, ai_added, confidence, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, v.title, v.notes, v.due, v.priority, v.project, v.labels, meta.sourceRef ? JSON.stringify(meta.sourceRef) : null,
        meta.aiAdded ? 1 : 0, meta.confidence ?? null, now, now);
    audit(this.db, actor, "task.create", { id, title: v.title, sourceRef: meta.sourceRef }, { delete: id });
    return this.get(id);
  }

  update(id: string, t: TaskInput) {
    const before = this.get(id);
    const v = validate(t);
    this.db
      .prepare("UPDATE tasks SET title=?, notes=?, due_at=?, priority=?, project=?, labels=?, updated_at=? WHERE id=?")
      .run(v.title, v.notes, v.due, v.priority, v.project, v.labels, Date.now(), id);
    audit(this.db, "user", "task.update", { id }, { restore: before });
    return this.get(id);
  }

  setDone(id: string, done: boolean) {
    this.get(id);
    this.db
      .prepare("UPDATE tasks SET status=?, completed_at=?, updated_at=? WHERE id=?")
      .run(done ? "done" : "open", done ? Date.now() : null, Date.now(), id);
    return this.get(id);
  }

  delete(id: string) {
    const before = this.get(id);
    this.db.prepare("DELETE FROM tasks WHERE id=?").run(id);
    audit(this.db, "user", "task.delete", { id }, { restore: before });
  }

  /** Restaure une tâche supprimée (annulation). */
  restore(t: ReturnType<TaskService["get"]>) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tasks(id, title, notes, due_at, priority, status, project, labels, source_ref, ai_added, confidence, created_at, updated_at, completed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(t.id, t.title, t.notes, t.due, t.priority, t.status, t.project, JSON.stringify(t.labels),
        t.sourceRef ? JSON.stringify(t.sourceRef) : null, t.aiAdded ? 1 : 0, t.confidence, t.createdAt, Date.now(), t.completedAt);
  }

  removeRaw(id: string) {
    this.db.prepare("DELETE FROM tasks WHERE id=?").run(id);
  }

  hasOpenSimilar(title: string) {
    const n = title.toLowerCase();
    return !!this.db.prepare("SELECT 1 FROM tasks WHERE status='open' AND lower(title)=?").get(n);
  }
}
