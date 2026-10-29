import { audit, type Db } from "@assistant/db";
import type { CalendarService } from "./calendar";
import type { TaskService } from "./tasks";

const UNDOABLE = ["event.create", "event.update", "event.delete", "task.create", "task.update", "task.delete"];

/** Journal des actions annulables (créations, modifications et suppressions d'événements et de tâches). */
export class UndoService {
  constructor(
    private db: Db,
    private cal: CalendarService,
    private tasks: TaskService,
  ) {}

  list(limit = 50) {
    const rows = this.db
      .prepare(
        `SELECT id, at, actor, action, detail FROM audit_log
         WHERE undo IS NOT NULL AND undone_at IS NULL AND action IN (${UNDOABLE.map(() => "?").join(",")})
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...UNDOABLE, Math.min(limit, 200)) as { detail: string | null }[];
    return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  }

  undo(id: number) {
    const row = this.db.prepare("SELECT action, undo, undone_at FROM audit_log WHERE id=?").get(id) as
      | { action: string; undo: string | null; undone_at: number | null }
      | undefined;
    if (!row?.undo || !UNDOABLE.includes(row.action)) throw new Error("Action non annulable");
    if (row.undone_at) throw new Error("Action déjà annulée");
    const u = JSON.parse(row.undo) as { delete?: string; restore?: any };
    this.db.transaction(() => {
      if (row.action.startsWith("event.")) {
        if (u.delete) this.cal.removeRaw(u.delete);
        else if (u.restore) this.cal.restore(u.restore);
      } else {
        if (u.delete) this.tasks.removeRaw(u.delete);
        else if (u.restore) this.tasks.restore(u.restore);
      }
      this.db.prepare("UPDATE audit_log SET undone_at=? WHERE id=?").run(Date.now(), id);
      audit(this.db, "user", "undo", { id, action: row.action });
    })();
  }
}
