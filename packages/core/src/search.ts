import type { AIRouter } from "@assistant/ai";
import type { Db } from "@assistant/db";

export interface SearchItem {
  type: "document" | "conversation";
  id: string;
  title: string;
  snippet: string;
  score: number;
}

const RRF_K = 60;
const PER_SOURCE = 30;

/** Transforme une saisie libre en requête FTS5 sûre : mots entre guillemets, préfixe sur le dernier. */
export function ftsQuery(q: string, mode: "and" | "or" = "and"): string | null {
  const words = q.normalize("NFKC").match(/[\p{L}\p{N}]{2,}/gu);
  if (!words?.length) return null;
  const terms = words.slice(0, 12).map((w, i, a) => (i === a.length - 1 ? `"${w}"*` : `"${w}"`));
  return terms.join(mode === "and" ? " AND " : " OR ");
}

interface ChunkHit {
  chunkId: number;
  docId: string;
  title: string;
  text: string;
}

function ftsHits(db: Db, q: string): ChunkHit[] {
  const run = (expr: string) =>
    db
      .prepare(
        `SELECT c.id AS chunkId, d.id AS docId, d.name AS title,
                snippet(chunks_fts, 0, '«', '»', ' … ', 24) AS text
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         JOIN documents d ON d.node_id = c.node_id
         WHERE chunks_fts MATCH ?
         ORDER BY bm25(chunks_fts) LIMIT ?`,
      )
      .all(expr, PER_SOURCE) as ChunkHit[];
  const and = ftsQuery(q, "and");
  if (!and) return [];
  const hits = run(and);
  if (hits.length) return hits;
  const or = ftsQuery(q, "or");
  return or && or !== and ? run(or) : [];
}

async function vectorHits(db: Db, router: AIRouter | null, q: string): Promise<ChunkHit[]> {
  if (!router || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='chunk_vec'").get()) return [];
  try {
    const [v] = await router.embed([q]);
    if (!v) return [];
    const rows = db
      .prepare(`SELECT rowid AS id FROM chunk_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance`)
      .all(Buffer.from(new Float32Array(v).buffer), PER_SOURCE) as { id: number }[];
    const get = db.prepare(
      `SELECT c.id AS chunkId, d.id AS docId, d.name AS title, substr(c.text, 1, 240) AS text
       FROM chunks c JOIN documents d ON d.node_id = c.node_id WHERE c.id = ?`,
    );
    return rows.map((r) => get.get(r.id) as ChunkHit | undefined).filter((x): x is ChunkHit => !!x);
  } catch {
    return []; // pas de route d'embedding, quota atteint, dimension différente… : on retombe sur les mots-clés
  }
}

function conversationHits(db: Db, q: string): SearchItem[] {
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = db
    .prepare(
      `SELECT c.id, c.title, substr(m.content, MAX(1, instr(lower(m.content), lower(?)) - 40), 160) AS snippet
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.content LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\'
       GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 10`,
    )
    .all(q, like, like) as { id: string; title: string; snippet: string }[];
  return rows.map((r, i) => ({ type: "conversation", id: r.id, title: r.title, snippet: r.snippet ?? "", score: 1 / (RRF_K + i) }));
}

/** Recherche hybride : mots-clés (BM25) + sémantique (KNN), fusionnés par Reciprocal Rank Fusion. */
export async function search(db: Db, router: AIRouter | null, q: string, limit = 20): Promise<SearchItem[]> {
  q = q.trim();
  if (!q) return [];
  const [fts, vec] = [ftsHits(db, q), await vectorHits(db, router, q)];

  const scores = new Map<number, { hit: ChunkHit; score: number }>();
  for (const list of [fts, vec]) {
    list.forEach((hit, rank) => {
      const cur = scores.get(hit.chunkId);
      const add = 1 / (RRF_K + rank + 1);
      if (cur) {
        cur.score += add;
        // Préfère l'extrait FTS (mots surlignés) à l'extrait brut du vectoriel.
        if (list === fts) cur.hit = hit;
      } else scores.set(hit.chunkId, { hit, score: add });
    });
  }

  // Un résultat par document : son meilleur passage.
  const byDoc = new Map<string, SearchItem>();
  for (const { hit, score } of [...scores.values()].sort((a, b) => b.score - a.score)) {
    if (!byDoc.has(hit.docId))
      byDoc.set(hit.docId, { type: "document", id: hit.docId, title: hit.title, snippet: hit.text, score });
  }
  return [...byDoc.values(), ...conversationHits(db, q)].slice(0, limit);
}
