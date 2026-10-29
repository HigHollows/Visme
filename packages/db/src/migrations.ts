export interface Migration {
  version: number;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        actor TEXT NOT NULL,          -- 'user' | 'ai' | 'plugin:<id>'
        action TEXT NOT NULL,
        detail TEXT,                  -- JSON, jamais de clé API
        undo TEXT                     -- JSON permettant d'annuler l'action
      );
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,           -- person, org, mail, document, event, task, project, topic
        label TEXT NOT NULL,
        props TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE edges (
        src TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        dst TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        rel TEXT NOT NULL,
        PRIMARY KEY (src, dst, rel)
      );
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        text TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id');
      CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
    `,
  },
];
