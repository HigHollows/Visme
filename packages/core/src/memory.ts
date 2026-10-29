import { randomUUID } from "node:crypto";
import { audit, type Db } from "@assistant/db";

export const NODE_TYPES = ["person", "org", "mail", "document", "event", "task", "project", "topic"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

const MAX_MAILS = 2000;
const MAX_GRAPH_NODES = 1500;

export const slug = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

interface DesiredNode { id: string; type: NodeType; label: string; props?: Record<string, unknown> }
interface DesiredEdge { src: string; dst: string; rel: string }

/**
 * Mémoire en graphe : les nœuds et liens sont dérivés automatiquement des mails, documents, événements et tâches
 * (reconstruction idempotente), et l'utilisateur peut en ajouter, renommer ou « oublier » à la main.
 */
export class MemoryService {
  constructor(private db: Db) {}

  private suppressed(): Set<string> {
    const r = this.db.prepare("SELECT value FROM kv WHERE key='memory_suppressed'").get() as { value: string } | undefined;
    return new Set(r ? (JSON.parse(r.value) as string[]) : []);
  }

  private saveSuppressed(s: Set<string>) {
    this.db.prepare("INSERT INTO kv(key,value) VALUES('memory_suppressed',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify([...s]));
  }

  /** Recalcule la partie automatique du graphe. Les éléments créés à la main ne sont jamais touchés. */
  rebuild(): { nodes: number; edges: number } {
    const nodes = new Map<string, DesiredNode>();
    const edges = new Map<string, DesiredEdge>();
    const addNode = (n: DesiredNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n); };
    const addEdge = (src: string, dst: string, rel: string) => { if (src !== dst) edges.set(`${src}|${dst}|${rel}`, { src, dst, rel }); };
    const db = this.db;

    // Documents : le nœud lui-même est géré par le pipeline ; on ajoute entités et étiquettes.
    for (const d of db.prepare("SELECT node_id AS nodeId, entities, tags FROM documents WHERE status='ready'").all() as { nodeId: string; entities: string; tags: string }[]) {
      for (const e of JSON.parse(d.entities) as { name: string; type: string }[]) {
        const s = slug(e.name);
        if (!s) continue;
        const type: NodeType = e.type === "person" ? "person" : e.type === "org" ? "org" : "topic";
        const id = `ent:${type}:${s}`;
        addNode({ id, type, label: e.name, props: e.type === "place" ? { place: true } : {} });
        addEdge(d.nodeId, id, "mentions");
      }
      for (const t of JSON.parse(d.tags) as string[]) {
        const s = slug(t);
        if (!s) continue;
        addNode({ id: `topic:${s}`, type: "topic", label: t });
        addEdge(d.nodeId, `topic:${s}`, "tagged");
      }
    }

    // Mails récents : expéditeur, et lien vers ce que l'agent en a tiré.
    for (const m of db.prepare("SELECT id, subject, from_name AS fromName, from_addr AS fromAddr, category FROM mails ORDER BY date DESC LIMIT ?").all(MAX_MAILS) as { id: string; subject: string; fromName: string; fromAddr: string; category: string | null }[]) {
      const mid = `mail:${m.id}`;
      addNode({ id: mid, type: "mail", label: m.subject, props: { mailId: m.id, category: m.category } });
      if (m.fromAddr) {
        const pid = `person:${m.fromAddr}`;
        addNode({ id: pid, type: "person", label: m.fromName || m.fromAddr, props: { email: m.fromAddr } });
        addEdge(pid, mid, "sent");
        // Même nom qu'une personne citée dans un document : on relie les deux.
        if (m.fromName) addEdge(pid, `ent:person:${slug(m.fromName)}`, "same_as");
      }
    }

    const link = (kind: "event" | "task", rows: { id: string; title: string; sourceRef: string | null }[]) => {
      for (const r of rows) {
        const ref = r.sourceRef ? (JSON.parse(r.sourceRef) as { type: string; id: string }) : null;
        if (!ref) continue;
        const id = `${kind}:${r.id}`;
        addNode({ id, type: kind, label: r.title, props: { refId: r.id } });
        if (ref.type === "mail") addEdge(`mail:${ref.id}`, id, "derived");
        else if (ref.type === "document") addEdge(`doc:${ref.id}`, id, "derived");
      }
    };
    link("event", db.prepare("SELECT id, title, source_ref AS sourceRef FROM events WHERE source_ref IS NOT NULL").all() as never);
    link("task", db.prepare("SELECT id, title, source_ref AS sourceRef FROM tasks WHERE source_ref IS NOT NULL").all() as never);

    // Échéances : le service devient une organisation reliée à sa source.
    for (const d of db.prepare("SELECT service, source_ref AS sourceRef FROM deadlines WHERE status='active'").all() as { service: string; sourceRef: string | null }[]) {
      const s = slug(d.service);
      if (!s) continue;
      const oid = `ent:org:${s}`;
      addNode({ id: oid, type: "org", label: d.service });
      const ref = d.sourceRef ? (JSON.parse(d.sourceRef) as { type: string; id: string }) : null;
      if (ref?.type === "mail") addEdge(`mail:${ref.id}`, oid, "concerns");
      if (ref?.type === "document") addEdge(`doc:${ref.id}`, oid, "concerns");
    }

    const skip = this.suppressed();
    const keepNode = (id: string) => !skip.has(id);

    db.transaction(() => {
      const existing = new Set((db.prepare("SELECT id FROM nodes").all() as { id: string }[]).map((n) => n.id));
      const up = db.prepare(
        "INSERT INTO nodes(id, type, label, props) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label, props=excluded.props WHERE json_extract(nodes.props,'$.manual') IS NOT 1",
      );
      for (const n of nodes.values()) if (keepNode(n.id)) up.run(n.id, n.type, n.label, JSON.stringify({ ...n.props, derived: true }));
      const ie = db.prepare("INSERT OR IGNORE INTO edges(src, dst, rel, derived) VALUES (?,?,?,1)");
      for (const e of edges.values()) {
        if (!keepNode(e.src) || !keepNode(e.dst) || skip.has(`edge:${e.src}|${e.dst}|${e.rel}`)) continue;
        // Les extrémités doivent exister (les nœuds document sont créés par le pipeline).
        if ((nodes.has(e.src) || existing.has(e.src)) && (nodes.has(e.dst) || existing.has(e.dst))) ie.run(e.src, e.dst, e.rel);
      }
      // Nettoyage : nœuds dérivés dont la source a disparu, et liens dérivés obsolètes.
      for (const row of db.prepare("SELECT id FROM nodes WHERE json_extract(props,'$.derived') = 1").all() as { id: string }[])
        if (!nodes.has(row.id)) db.prepare("DELETE FROM nodes WHERE id=?").run(row.id);
      for (const e of db.prepare("SELECT src, dst, rel FROM edges WHERE derived=1").all() as DesiredEdge[])
        if (!edges.has(`${e.src}|${e.dst}|${e.rel}`)) db.prepare("DELETE FROM edges WHERE src=? AND dst=? AND rel=?").run(e.src, e.dst, e.rel);
    })();

    const c = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    return { nodes: c("nodes"), edges: c("edges") };
  }

  /** Graphe pour l'affichage : les nœuds les plus connectés d'abord, plafonné. */
  graph(p: { types?: string[]; limit?: number } = {}) {
    const limit = Math.min(p.limit ?? MAX_GRAPH_NODES, MAX_GRAPH_NODES);
    const nodes = this.db
      .prepare(
        `SELECT n.id, n.type, n.label, n.props,
                (SELECT count(*) FROM edges e WHERE e.src = n.id OR e.dst = n.id) AS degree
         FROM nodes n ORDER BY degree DESC, n.label LIMIT ?`,
      )
      .all(limit) as { id: string; type: string; label: string; props: string; degree: number }[];
    const filtered = p.types?.length ? nodes.filter((n) => p.types!.includes(n.type)) : nodes;
    const ids = new Set(filtered.map((n) => n.id));
    const edges = (this.db.prepare("SELECT src, dst, rel, derived FROM edges").all() as { src: string; dst: string; rel: string; derived: number }[])
      .filter((e) => ids.has(e.src) && ids.has(e.dst))
      .map((e) => ({ ...e, manual: e.derived === 0 }));
    return { nodes: filtered.map((n) => ({ ...n, props: JSON.parse(n.props) })), edges };
  }

  neighbors(id: string, limit = 12) {
    return this.db
      .prepare(
        `SELECT n.id, n.type, n.label, e.rel FROM edges e
         JOIN nodes n ON n.id = CASE WHEN e.src = @id THEN e.dst ELSE e.src END
         WHERE e.src = @id OR e.dst = @id LIMIT @limit`,
      )
      .all({ id, limit }) as { id: string; type: string; label: string; rel: string }[];
  }

  // --- édition manuelle ---

  addNode(p: { type: string; label: string }) {
    const label = String(p.label ?? "").trim().slice(0, 200);
    if (!label) throw new Error("Libellé requis");
    if (!(NODE_TYPES as readonly string[]).includes(p.type)) throw new Error("Type de nœud inconnu");
    const id = `manual:${randomUUID()}`;
    this.db.prepare("INSERT INTO nodes(id, type, label, props) VALUES (?,?,?,?)").run(id, p.type, label, JSON.stringify({ manual: true }));
    audit(this.db, "user", "memory.node.add", { id, label });
    return id;
  }

  /** Renommer un nœud automatique le fige : il devient « manuel » et n'est plus écrasé. */
  renameNode(id: string, label: string) {
    const l = String(label ?? "").trim().slice(0, 200);
    if (!l) throw new Error("Libellé requis");
    const r = this.db.prepare("UPDATE nodes SET label=?, props=json_set(props,'$.manual',json('true')) WHERE id=?").run(l, id);
    if (!r.changes) throw new Error("Nœud introuvable");
  }

  addEdge(src: string, dst: string, rel: string) {
    const r = String(rel ?? "").trim().slice(0, 60) || "lié à";
    if (src === dst) throw new Error("Un nœud ne peut pas être lié à lui-même");
    const ok = this.db.prepare("SELECT count(*) AS n FROM nodes WHERE id IN (?,?)").get(src, dst) as { n: number };
    if (ok.n !== 2) throw new Error("Nœud introuvable");
    this.db.prepare("INSERT OR REPLACE INTO edges(src, dst, rel, derived) VALUES (?,?,?,0)").run(src, dst, r);
  }

  deleteEdge(src: string, dst: string, rel: string) {
    this.db.prepare("DELETE FROM edges WHERE src=? AND dst=? AND rel=?").run(src, dst, rel);
    // Un lien automatique supprimé à la main ne doit pas revenir : on mémorise la suppression.
    const s = this.suppressed();
    s.add(`edge:${src}|${dst}|${rel}`);
    this.saveSuppressed(s);
  }

  /** « Oubli ciblé » : supprime le nœud et empêche sa reconstruction automatique. */
  forget(id: string) {
    this.db.prepare("DELETE FROM nodes WHERE id=?").run(id);
    const s = this.suppressed();
    s.add(id);
    this.saveSuppressed(s);
    audit(this.db, "user", "memory.forget", { id });
  }

  clearAll() {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM edges WHERE derived=0 OR 1=1").run();
      this.db.prepare("DELETE FROM nodes WHERE id NOT LIKE 'doc:%'").run();
      this.db.prepare("DELETE FROM kv WHERE key='memory_suppressed'").run();
    })();
  }
}

/** Extension utilisée par la couche plugins (API `memory.link`). */
export type PluginEndpoint = { document: string } | { type: "person" | "org" | "project" | "topic"; label: string };

declare module "./memory" {
  interface MemoryService {
    pluginLink(pluginId: string, a: PluginEndpoint, b: PluginEndpoint, rel: string): boolean;
  }
}

MemoryService.prototype.pluginLink = function (this: MemoryService, pluginId: string, a: PluginEndpoint, b: PluginEndpoint, rel: string) {
  const db = (this as unknown as { db: Db }).db;
  const skip = (this as unknown as { suppressed(): Set<string> }).suppressed();
  const resolve = (e: PluginEndpoint): string | null => {
    if ("document" in e) {
      return db.prepare("SELECT 1 FROM nodes WHERE id=?").get(`doc:${e.document}`) ? `doc:${e.document}` : null;
    }
    const label = String(e.label ?? "").trim().slice(0, 200);
    const s = slug(label);
    if (!s || !["person", "org", "project", "topic"].includes(e.type)) return null;
    const id = e.type === "person" || e.type === "org" ? `ent:${e.type}:${s}` : `${e.type}:${s}`;
    if (skip.has(id)) return null; // l'utilisateur a demandé à l'oublier
    db.prepare("INSERT OR IGNORE INTO nodes(id, type, label, props) VALUES (?,?,?,?)").run(id, e.type, label, JSON.stringify({ plugin: pluginId }));
    return id;
  };
  const src = resolve(a);
  const dst = resolve(b);
  const r = String(rel ?? "").trim().slice(0, 60) || "lié à";
  if (!src || !dst || src === dst || skip.has(`edge:${src}|${dst}|${r}`)) return false;
  db.prepare("INSERT OR IGNORE INTO edges(src, dst, rel, derived) VALUES (?,?,?,0)").run(src, dst, r);
  audit(db, `plugin:${pluginId}`, "memory.link", { src, dst, rel: r });
  return true;
};
