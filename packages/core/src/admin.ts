import { statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { audit, type Db } from "@assistant/db";
import { NODE_TYPES, slug } from "./memory";

const EXPORT_TABLES: [string, string][] = [
  ["accounts", "SELECT id, provider, email, status, created_at FROM accounts"], // jamais les jetons
  ["mails", "SELECT id, account_id, subject, from_name, from_addr, to_addrs, date, snippet, body, labels, attachments, category, summary FROM mails"],
  ["documents", "SELECT id, name, path, ext, size, status, summary, tags, entities, dates, created_at FROM documents"],
  ["events", "SELECT * FROM events"],
  ["tasks", "SELECT * FROM tasks"],
  ["proposals", "SELECT * FROM proposals"],
  ["deadlines", "SELECT * FROM deadlines"],
  ["meetings", "SELECT id, title, source, started_at, duration_ms, status, transcript, minutes FROM meetings"],
  ["conversations", "SELECT * FROM conversations"],
  ["messages", "SELECT * FROM messages"],
  ["drafts", "SELECT * FROM drafts"],
  ["presets", "SELECT * FROM presets WHERE builtin=0"],
  ["style_profiles", "SELECT * FROM style_profiles"],
  ["contact_groups", "SELECT * FROM contact_groups"],
  ["nodes", "SELECT * FROM nodes"],
  ["edges", "SELECT * FROM edges"],
  ["usage_log", "SELECT * FROM usage_log"],
  ["audit_log", "SELECT * FROM audit_log"],
];

const COUNT_TABLES = ["mails", "documents", "chunks", "events", "tasks", "proposals", "deadlines", "meetings", "conversations", "messages", "nodes", "edges", "audit_log"];

export class AdminService {
  constructor(
    private db: Db,
    private dbPath: () => string,
  ) {}

  /** Export RGPD (droit d'accès / portabilité) : toutes les données du profil, en JSON, sans aucun secret. */
  exportAll(path: string, settingsJson: string) {
    const data: Record<string, unknown> = { exportedAt: new Date().toISOString(), format: 1, settings: JSON.parse(settingsJson) };
    for (const [name, sql] of EXPORT_TABLES) data[name] = this.db.prepare(sql).all();
    writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
    audit(this.db, "user", "privacy.export", { path });
    return { tables: EXPORT_TABLES.length, rows: EXPORT_TABLES.reduce((n, [t]) => n + (data[t] as unknown[]).length, 0) };
  }

  diagnostics() {
    const counts: Record<string, number> = {};
    for (const t of COUNT_TABLES) counts[t] = (this.db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    let size = 0;
    try { size = statSync(this.dbPath()).size; } catch { /* base en mémoire */ }
    return {
      node: process.version, platform: `${process.platform}-${process.arch}`, dbBytes: size, counts,
      schemaVersion: this.db.pragma("user_version", { simple: true }) as number,
      lastErrors: this.db.prepare("SELECT at, actor, action, detail FROM audit_log WHERE action LIKE '%error%' ORDER BY id DESC LIMIT 10").all(),
    };
  }

  /** Journal d'audit filtrable (acteur, préfixe d'action), paginé par identifiant. */
  auditLog(p: { actor?: string; action?: string; beforeId?: number; limit?: number }) {
    const esc = (v: string) => `${v.replace(/[\\%_]/g, "\\$&")}%`;
    const where: string[] = [];
    const args: unknown[] = [];
    if (p.actor) { where.push("actor LIKE ? ESCAPE '\\'"); args.push(esc(p.actor)); }
    if (p.action) { where.push("action LIKE ? ESCAPE '\\'"); args.push(esc(p.action)); }
    if (p.beforeId) { where.push("id < ?"); args.push(Number(p.beforeId)); }
    return this.db
      .prepare(`SELECT id, at, actor, action, detail FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`)
      .all(...args, Math.min(p.limit ?? 100, 500));
  }

  // --- mémoire : export / import des éléments créés à la main ---

  memoryStats() {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      nodes: n("SELECT count(*) AS n FROM nodes"),
      edges: n("SELECT count(*) AS n FROM edges"),
      manualNodes: n("SELECT count(*) AS n FROM nodes WHERE json_extract(props,'$.manual')=1 OR json_extract(props,'$.plugin') IS NOT NULL"),
      manualEdges: n("SELECT count(*) AS n FROM edges WHERE derived=0"),
      chunks: n("SELECT count(*) AS n FROM chunks"),
    };
  }

  memoryExport() {
    return {
      format: 1,
      nodes: this.db.prepare("SELECT id, type, label FROM nodes WHERE json_extract(props,'$.manual')=1 OR json_extract(props,'$.plugin') IS NOT NULL").all(),
      edges: this.db.prepare("SELECT src, dst, rel FROM edges WHERE derived=0").all(),
    };
  }

  /** Importe nœuds et liens manuels (validés ; les liens vers des nœuds inexistants sont ignorés). */
  memoryImport(data: unknown) {
    const d = data as { format?: number; nodes?: { id: string; type: string; label: string }[]; edges?: { src: string; dst: string; rel: string }[] };
    if (!d || d.format !== 1 || !Array.isArray(d.nodes) || !Array.isArray(d.edges)) throw new Error("Fichier de mémoire invalide");
    let nodes = 0;
    let edges = 0;
    this.db.transaction(() => {
      for (const n of d.nodes!.slice(0, 20_000)) {
        if (typeof n?.id !== "string" || typeof n.label !== "string" || !(NODE_TYPES as readonly string[]).includes(n.type) || !n.label.trim()) continue;
        // Les identifiants importés sont préfixés : un fichier ne peut pas écraser un nœud automatique existant.
        const id = n.id.startsWith("manual:") || n.id.startsWith("ent:") || n.id.startsWith("topic:") || n.id.startsWith("project:") ? n.id : `manual:${slug(n.id)}`;
        nodes += Number(this.db.prepare("INSERT OR IGNORE INTO nodes(id, type, label, props) VALUES (?,?,?,?)").run(id, n.type, n.label.trim().slice(0, 200), JSON.stringify({ manual: true })).changes);
      }
      for (const e of d.edges!.slice(0, 50_000)) {
        if (typeof e?.src !== "string" || typeof e.dst !== "string" || typeof e.rel !== "string") continue;
        const ok = this.db.prepare("SELECT count(*) AS n FROM nodes WHERE id IN (?,?)").get(e.src, e.dst) as { n: number };
        if (ok.n === 2 && e.src !== e.dst) edges += Number(this.db.prepare("INSERT OR IGNORE INTO edges(src, dst, rel, derived) VALUES (?,?,?,0)").run(e.src, e.dst, e.rel.slice(0, 60)).changes);
      }
    })();
    audit(this.db, "user", "memory.import", { nodes, edges });
    return { nodes, edges };
  }
}
