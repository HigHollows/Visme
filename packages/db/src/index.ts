import Database from "better-sqlite3-multiple-ciphers";
import * as sqliteVec from "sqlite-vec";
import { migrations } from "./migrations";

export type Db = Database.Database;

export interface OpenOptions {
  /** Clé de chiffrement (issue du trousseau système). Obligatoire. */
  key: string;
  /** Dimension des embeddings ; crée la table vectorielle si fournie. */
  vectorDim?: number;
}

export function openDatabase(path: string, opts: OpenOptions): Db {
  if (!opts.key) throw new Error("Clé de chiffrement requise");
  const db = new Database(path);
  db.pragma("cipher='sqlcipher'");
  db.pragma("legacy=4");
  // Échappement du guillemet simple : la clé est du texte arbitraire.
  db.pragma(`key='${opts.key.replace(/'/g, "''")}'`);
  try {
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch {
    db.close();
    throw new Error("Clé incorrecte ou base corrompue");
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  sqliteVec.load(db);
  migrate(db);
  if (opts.vectorDim) {
    const dim = Math.trunc(opts.vectorDim);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(embedding float[${dim}])`);
  }
  return db;
}

export function migrate(db: Db) {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
}

export function audit(db: Db, actor: string, action: string, detail?: unknown, undo?: unknown) {
  db.prepare("INSERT INTO audit_log(at, actor, action, detail, undo) VALUES (?,?,?,?,?)").run(
    Date.now(),
    actor,
    action,
    detail === undefined ? null : JSON.stringify(detail),
    undo === undefined ? null : JSON.stringify(undo),
  );
}
