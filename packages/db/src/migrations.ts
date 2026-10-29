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
  {
    version: 7,
    sql: `
      ALTER TABLE mails ADD COLUMN analyzed_at INTEGER;
      ALTER TABLE mails ADD COLUMN analysis_error TEXT;
      ALTER TABLE audit_log ADD COLUMN undone_at INTEGER;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        due_at INTEGER,
        priority INTEGER NOT NULL DEFAULT 0,   -- 0 normale, 1 haute
        status TEXT NOT NULL DEFAULT 'open',   -- open | done
        project TEXT,
        labels TEXT NOT NULL DEFAULT '[]',
        parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        recurrence TEXT,                       -- réservé : règle de récurrence
        source_ref TEXT,                       -- JSON {type, id} : lien vers le mail/document d'origine
        ai_added INTEGER NOT NULL DEFAULT 0,
        confidence REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX tasks_status_due ON tasks(status, due_at);
      CREATE TABLE proposals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,                    -- event | task
        status TEXT NOT NULL DEFAULT 'pending',-- pending | accepted | rejected | auto
        title TEXT NOT NULL,
        payload TEXT NOT NULL,                 -- JSON de l'action proposée
        reason TEXT NOT NULL,
        source_ref TEXT,
        source_key TEXT,                       -- expéditeur : sert à apprendre des refus
        confidence REAL NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        result_ref TEXT
      );
      CREATE INDEX proposals_status ON proposals(status, created_at);
      CREATE TABLE agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        trigger TEXT NOT NULL,                 -- schedule | manual
        summary TEXT,
        stats TEXT NOT NULL DEFAULT '{}',
        error TEXT
      );
    `,
  },
  {
    version: 8,
    sql: `
      ALTER TABLE messages ADD COLUMN sources TEXT;            -- JSON : sources citées par l'assistant
      ALTER TABLE conversations ADD COLUMN preset_id TEXT;
      ALTER TABLE edges ADD COLUMN derived INTEGER NOT NULL DEFAULT 1;  -- 0 = créé à la main
      CREATE TABLE presets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        tools TEXT NOT NULL DEFAULT '[]',     -- outils autorisés
        tone TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT '',
        provider TEXT,                        -- vide = route "chat" des réglages
        model TEXT,
        builtin INTEGER NOT NULL DEFAULT 0,
        sort INTEGER NOT NULL DEFAULT 100,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE deadlines (
        id TEXT PRIMARY KEY,
        service TEXT NOT NULL,
        kind TEXT NOT NULL,                   -- invoice | subscription | contract | renewal | warranty | tax | insurance | other
        amount REAL,
        currency TEXT NOT NULL DEFAULT 'EUR',
        periodicity TEXT NOT NULL DEFAULT 'one_off', -- weekly | monthly | quarterly | yearly | one_off
        next_date INTEGER,
        cancel_by INTEGER,
        status TEXT NOT NULL DEFAULT 'active',       -- active | cancelled | paid
        notes TEXT NOT NULL DEFAULT '',
        source_ref TEXT,
        confidence REAL,
        price_history TEXT NOT NULL DEFAULT '[]',
        event_id TEXT,
        task_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX deadlines_next ON deadlines(status, next_date);
      CREATE TABLE deadline_alerts (
        deadline_id TEXT NOT NULL REFERENCES deadlines(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,                   -- due | cancel
        days INTEGER NOT NULL,
        target_date INTEGER NOT NULL,         -- si la date change, l'alerte peut se redéclencher
        fired_at INTEGER NOT NULL,
        PRIMARY KEY (deadline_id, kind, days, target_date)
      );
      CREATE TABLE style_profiles (
        scope TEXT PRIMARY KEY,               -- global | group:<nom> | contact:<adresse>
        profile TEXT NOT NULL,
        source TEXT NOT NULL,                 -- learned | manual
        sample_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE contact_groups (addr TEXT PRIMARY KEY, group_name TEXT NOT NULL);
      CREATE TABLE drafts (
        id TEXT PRIMARY KEY,
        mail_id TEXT NOT NULL REFERENCES mails(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        scope TEXT,
        instruction TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE plugins (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        manifest TEXT NOT NULL,
        dir TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        granted TEXT NOT NULL DEFAULT '[]',   -- permissions accordées par l'utilisateur
        installed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE plugin_storage (
        plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (plugin_id, key)
      );
    `,
  },
  {
    version: 9,
    sql: `
      CREATE TABLE meetings (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source TEXT NOT NULL,                 -- recording | import
        started_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,                 -- recording | transcribing | processing | ready | error
        error TEXT,
        language TEXT,
        audio_kept INTEGER NOT NULL DEFAULT 1,
        transcript TEXT,                      -- JSON [{start,end,speaker?,text}] en ms
        minutes TEXT,                         -- JSON {summary, decisions, actions, nextMeetings}
        document_id TEXT,                     -- compte-rendu indexé comme document (mémoire)
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE meeting_segments (
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        offset_ms INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        file TEXT NOT NULL,
        mime TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',   -- pending | done | error
        error TEXT,
        result TEXT,                          -- JSON {text, segments?}
        PRIMARY KEY (meeting_id, idx)
      );
    `,
  },
  {
    version: 10,
    sql: `
      ALTER TABLE mails ADD COLUMN rfc_id TEXT;                 -- Message-ID RFC 5322 (réponses dans le même fil)
      ALTER TABLE events ADD COLUMN push_error TEXT;            -- échec d'écriture vers l'agenda distant
      ALTER TABLE documents ADD COLUMN source_ref TEXT;         -- JSON {type, id} : mail d'origine d'une pièce jointe
      ALTER TABLE drafts ADD COLUMN sent_at INTEGER;
      ALTER TABLE meeting_segments ADD COLUMN track TEXT NOT NULL DEFAULT 'mic';  -- mic | system (audio des participants)
    `,
  },
];
