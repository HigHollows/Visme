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
  {
    version: 2,
    sql: `
      CREATE TABLE usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        task TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        usd REAL NOT NULL
      );
      CREATE INDEX usage_log_at ON usage_log(at);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,           -- user | assistant
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        model TEXT
      );
      CREATE INDEX messages_conv ON messages(conversation_id, id);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        ext TEXT NOT NULL,
        size INTEGER NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,         -- indexing | ready | error
        error TEXT,
        warnings TEXT NOT NULL DEFAULT '[]',
        summary TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        entities TEXT NOT NULL DEFAULT '[]',
        dates TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        indexed_at INTEGER
      );
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,           -- google | microsoft | imap
        email TEXT NOT NULL,
        tokens TEXT NOT NULL,             -- JSON ; la base entière est chiffrée (SQLCipher)
        history_id TEXT,
        status TEXT NOT NULL DEFAULT 'ok',      -- ok | reauth
        sync_status TEXT NOT NULL DEFAULT 'idle', -- idle | syncing | error
        sync_error TEXT,
        last_sync_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (provider, email)
      );
      CREATE TABLE mails (
        id TEXT PRIMARY KEY,              -- <account_id>:<remote_id>
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        remote_id TEXT NOT NULL,
        thread_id TEXT,
        subject TEXT NOT NULL,
        from_name TEXT NOT NULL,
        from_addr TEXT NOT NULL,
        to_addrs TEXT NOT NULL,
        date INTEGER NOT NULL,
        snippet TEXT NOT NULL,
        body TEXT NOT NULL,
        labels TEXT NOT NULL DEFAULT '[]',
        attachments TEXT NOT NULL DEFAULT '[]',
        category TEXT,
        summary TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX mails_account_date ON mails(account_id, date DESC);
      CREATE VIRTUAL TABLE mails_fts USING fts5(subject, from_name, from_addr, body, content='mails', content_rowid='rowid');
      CREATE TRIGGER mails_ai AFTER INSERT ON mails BEGIN
        INSERT INTO mails_fts(rowid, subject, from_name, from_addr, body) VALUES (new.rowid, new.subject, new.from_name, new.from_addr, new.body);
      END;
      CREATE TRIGGER mails_ad AFTER DELETE ON mails BEGIN
        INSERT INTO mails_fts(mails_fts, rowid, subject, from_name, from_addr, body) VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_addr, old.body);
      END;
      CREATE TRIGGER mails_au AFTER UPDATE ON mails BEGIN
        INSERT INTO mails_fts(mails_fts, rowid, subject, from_name, from_addr, body) VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_addr, old.body);
        INSERT INTO mails_fts(rowid, subject, from_name, from_addr, body) VALUES (new.rowid, new.subject, new.from_name, new.from_addr, new.body);
      END;
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
        calendar_id TEXT,
        remote_id TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        start_at INTEGER NOT NULL,
        end_at INTEGER NOT NULL,
        all_day INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,             -- google | local | ai
        source_ref TEXT,                  -- JSON {type, id} : lien cliquable vers le mail/document d'origine
        confidence REAL,
        ai_added INTEGER NOT NULL DEFAULT 0,
        link TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (account_id, calendar_id, remote_id)
      );
      CREATE INDEX events_range ON events(start_at, end_at);
      CREATE TABLE calendar_sync (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        sync_token TEXT,
        status TEXT NOT NULL DEFAULT 'idle',   -- idle | syncing | error
        error TEXT,
        last_sync_at INTEGER
      );
    `,
  },
];
