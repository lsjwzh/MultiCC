pub const SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS orchestration_meta (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS orchestration_extras (
      key TEXT PRIMARY KEY,
      data_json TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS orchestration_waits (
      id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      session_id TEXT,
      status TEXT,
      next_at INTEGER,
      updated_at INTEGER
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_orchestration_waits_due
      ON orchestration_waits(status, next_at);
    CREATE INDEX IF NOT EXISTS idx_orchestration_waits_session
      ON orchestration_waits(session_id, status);

    CREATE TABLE IF NOT EXISTS orchestration_outbox (
      id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      session_id TEXT,
      state TEXT,
      sequence INTEGER,
      available_at INTEGER,
      leased_until INTEGER,
      updated_at INTEGER
    ) WITHOUT ROWID;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestration_outbox_sequence
      ON orchestration_outbox(sequence);
    CREATE INDEX IF NOT EXISTS idx_orchestration_outbox_due
      ON orchestration_outbox(state, available_at, sequence);
    CREATE INDEX IF NOT EXISTS idx_orchestration_outbox_session
      ON orchestration_outbox(session_id, state, sequence);

    CREATE TABLE IF NOT EXISTS orchestration_operations (
      id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      kind TEXT,
      owner_session_id TEXT,
      status TEXT,
      updated_at INTEGER
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_orchestration_operations_owner
      ON orchestration_operations(owner_session_id, status, kind);

    CREATE TABLE IF NOT EXISTS orchestration_tasks (
      id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      parent_session_id TEXT,
      status TEXT,
      updated_at INTEGER
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_orchestration_tasks_parent
      ON orchestration_tasks(parent_session_id, status);

    CREATE TABLE IF NOT EXISTS orchestration_session_schedules (
      session_id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      state TEXT,
      updated_at INTEGER
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_orchestration_schedules_state
      ON orchestration_session_schedules(state, updated_at);
"#;
