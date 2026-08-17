'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { extractArtifactReferences } = require('./artifact-reference');

const SCHEMA_VERSION = 5;
const TERMINAL_EXECUTION_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const ROLE_KINDS = new Set(['main', 'sub', 'aux']);
const USAGE_COVERAGE = new Set(['observed', 'unobservable']);
const USAGE_SOURCES = new Set(['exact', 'reconciled']);
const CLEANUP_STATES = new Set(['deleting', 'done', 'error']);

class TaskRunStoreError extends Error {
  constructor(message, code = 'TASK_RUN_STORE_ERROR', meta = {}) {
    super(message);
    this.name = 'TaskRunStoreError';
    this.code = code;
    Object.assign(this, meta);
  }
}

function requiredString(value, label, max = 256) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new TaskRunStoreError(`${label} is required or invalid`, 'TASK_RUN_INPUT_INVALID');
  }
  return text;
}

function optionalString(value, label, max = 256) {
  if (value == null || value === '') return '';
  const text = String(value).trim();
  if (text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new TaskRunStoreError(`${label} is invalid`, 'TASK_RUN_INPUT_INVALID');
  }
  return text;
}

function timestamp(value, fallback, label) {
  const number = value == null ? Number(fallback()) : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TaskRunStoreError(`${label} must be a non-negative safe integer`, 'TASK_RUN_INPUT_INVALID');
  }
  return number;
}

function tokenCount(value, label) {
  const number = value == null ? 0 : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TaskRunStoreError(`${label} must be a non-negative safe integer`, 'USAGE_EVENT_INVALID');
  }
  return number;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = stableValue(value[key]);
  return result;
}

function stableStringify(value, label = 'value') {
  let text;
  try { text = JSON.stringify(stableValue(value)); } catch (cause) {
    throw new TaskRunStoreError(`${label} must be JSON serializable`, 'TASK_RUN_INPUT_INVALID', { cause });
  }
  if (text === undefined) {
    throw new TaskRunStoreError(`${label} must be JSON serializable`, 'TASK_RUN_INPUT_INVALID');
  }
  return text;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function digest(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function chmodPrivate(fsImpl, file) {
  try { fsImpl.chmodSync(file, 0o600); } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  for (const suffix of ['-wal', '-shm']) {
    try { fsImpl.chmodSync(`${file}${suffix}`, 0o600); } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_run_meta (
      key TEXT PRIMARY KEY,
      value_text TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS task_runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      slot_id TEXT,
      lease_epoch INTEGER NOT NULL UNIQUE CHECK(lease_epoch >= 1),
      execution_status TEXT NOT NULL DEFAULT 'running',
      usage_status TEXT NOT NULL DEFAULT 'collecting',
      outcome_durable INTEGER NOT NULL DEFAULT 0 CHECK(outcome_durable IN (0, 1)),
      producers_drained INTEGER NOT NULL DEFAULT 0 CHECK(producers_drained IN (0, 1)),
      native_transcript_checked INTEGER NOT NULL DEFAULT 0 CHECK(native_transcript_checked IN (0, 1)),
      usage_revision INTEGER NOT NULL DEFAULT 0 CHECK(usage_revision >= 0),
      sealed_revision INTEGER,
      cleanup_state TEXT NOT NULL DEFAULT 'blocked',
      fresh_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(fresh_input_tokens >= 0),
      cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cache_read_tokens >= 0),
      cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cache_write_tokens >= 0),
      output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
      reasoning_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reasoning_tokens >= 0),
      observed_event_count INTEGER NOT NULL DEFAULT 0 CHECK(observed_event_count >= 0),
      unobservable_event_count INTEGER NOT NULL DEFAULT 0 CHECK(unobservable_event_count >= 0),
      started_at INTEGER NOT NULL,
      terminal_at INTEGER,
      sealed_at INTEGER,
      cleanup_updated_at INTEGER,
      cleaned_at INTEGER,
      cleanup_error_code TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_task_runs_task
      ON task_runs(task_id, started_at, run_id);
    CREATE INDEX IF NOT EXISTS idx_task_runs_cleanup
      ON task_runs(cleanup_state, usage_status, sealed_at);

    CREATE TABLE IF NOT EXISTS task_run_slot_leases (
      slot_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE REFERENCES task_runs(run_id) ON DELETE RESTRICT,
      lease_epoch INTEGER NOT NULL CHECK(lease_epoch >= 1),
      state TEXT NOT NULL CHECK(state IN ('active', 'released', 'quarantined')),
      barrier_phase TEXT NOT NULL CHECK(barrier_phase IN ('acquired', 'ready')),
      quarantine_code TEXT,
      acquired_at INTEGER NOT NULL,
      reset_at INTEGER,
      updated_at INTEGER NOT NULL,
      released_at INTEGER
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_task_run_slot_leases_state
      ON task_run_slot_leases(state, updated_at, slot_id);

    CREATE TABLE IF NOT EXISTS task_run_recovery_quarantine (
      run_id TEXT PRIMARY KEY REFERENCES task_runs(run_id) ON DELETE RESTRICT,
      slot_id TEXT NOT NULL,
      error_code TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS task_run_cleanup_manifests (
      run_id TEXT PRIMARY KEY REFERENCES task_runs(run_id) ON DELETE RESTRICT,
      slot_id TEXT NOT NULL,
      lease_epoch INTEGER NOT NULL CHECK(lease_epoch >= 1),
      content_hash TEXT NOT NULL,
      native_refs_json TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS task_run_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES task_runs(run_id) ON DELETE RESTRICT,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      content_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(run_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_messages_order
      ON task_run_messages(run_id, sequence);

    CREATE TABLE IF NOT EXISTS task_run_artifacts (
      run_id TEXT NOT NULL REFERENCES task_runs(run_id) ON DELETE RESTRICT,
      first_message_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(run_id, artifact_id, relative_path)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_task_run_artifacts_id
      ON task_run_artifacts(artifact_id, run_id);

    CREATE TABLE IF NOT EXISTS task_run_answer_receipts (
      run_id TEXT NOT NULL REFERENCES task_runs(run_id) ON DELETE RESTRICT,
      request_id TEXT NOT NULL,
      client_msg_id TEXT NOT NULL,
      answer_hash TEXT NOT NULL
        CHECK(length(answer_hash) = 64 AND answer_hash NOT GLOB '*[^0-9a-f]*'),
      state TEXT NOT NULL CHECK(state IN ('reserved', 'accepted')),
      reserved_at INTEGER NOT NULL,
      accepted_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(run_id, request_id),
      UNIQUE(run_id, client_msg_id),
      CHECK(
        (state = 'reserved' AND accepted_at IS NULL)
        OR (state = 'accepted' AND accepted_at IS NOT NULL)
      )
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS task_run_usage_events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES task_runs(run_id) ON DELETE RESTRICT,
      content_hash TEXT NOT NULL,
      event_revision INTEGER NOT NULL DEFAULT 1,
      source_event_id TEXT,
      occurred_at INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      cli TEXT NOT NULL,
      protocol TEXT NOT NULL,
      model TEXT NOT NULL,
      role_kind TEXT NOT NULL,
      agent_role TEXT NOT NULL,
      route_name TEXT NOT NULL,
      source TEXT NOT NULL,
      coverage TEXT NOT NULL,
      status TEXT NOT NULL,
      fresh_input_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      status_code INTEGER,
      error_code TEXT,
      content_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK(
        (coverage = 'observed'
          AND fresh_input_tokens IS NOT NULL AND cache_read_tokens IS NOT NULL
          AND cache_write_tokens IS NOT NULL AND output_tokens IS NOT NULL
          AND reasoning_tokens IS NOT NULL)
        OR
        (coverage = 'unobservable'
          AND fresh_input_tokens IS NULL AND cache_read_tokens IS NULL
          AND cache_write_tokens IS NULL AND output_tokens IS NULL
          AND reasoning_tokens IS NULL)
      )
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_task_run_usage_events_run
      ON task_run_usage_events(run_id, occurred_at, event_id);

    CREATE TABLE IF NOT EXISTS task_run_usage_dimensions (
      run_id TEXT NOT NULL REFERENCES task_runs(run_id) ON DELETE RESTRICT,
      provider_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      model TEXT NOT NULL,
      role_kind TEXT NOT NULL,
      route_name TEXT NOT NULL,
      fresh_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(fresh_input_tokens >= 0),
      cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cache_read_tokens >= 0),
      cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cache_write_tokens >= 0),
      output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
      reasoning_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reasoning_tokens >= 0),
      observed_event_count INTEGER NOT NULL DEFAULT 0 CHECK(observed_event_count >= 0),
      unobservable_event_count INTEGER NOT NULL DEFAULT 0 CHECK(unobservable_event_count >= 0),
      PRIMARY KEY(run_id, provider_id, model, role_kind, route_name)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_task_run_usage_dimensions_provider
      ON task_run_usage_dimensions(provider_id, model, role_kind, route_name);
  `);
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

function persistArtifactReferences(insert, { runId, messageId, content, createdAt }) {
  for (const reference of extractArtifactReferences(content)) {
    insert.run(runId, messageId, reference.artifactId, reference.relativePath, createdAt);
  }
}

function migrateSchema(db, version) {
  let current = version;
  if (current === 1) {
    db.transaction(() => {
      if (!tableColumns(db, 'task_runs').has('lease_epoch')) {
        db.exec('ALTER TABLE task_runs ADD COLUMN lease_epoch INTEGER');
      }
      const rows = db.prepare(`
        SELECT run_id FROM task_runs ORDER BY started_at, run_id
      `).all();
      const update = db.prepare('UPDATE task_runs SET lease_epoch=? WHERE run_id=? AND lease_epoch IS NULL');
      let next = 0;
      for (const row of rows) {
        next += 1;
        update.run(next, row.run_id);
      }
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_lease_epoch ON task_runs(lease_epoch)');
      db.prepare(`
        INSERT INTO task_run_meta(key, value_text) VALUES ('lease_epoch_counter', ?)
        ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text
      `).run(String(next));
      db.prepare("UPDATE task_run_meta SET value_text='2' WHERE key='schema_version'").run();
    })();
    current = 2;
  }
  if (current === 2) {
    db.transaction(() => {
      const columns = tableColumns(db, 'task_run_slot_leases');
      if (!columns.has('barrier_phase')) {
        db.exec("ALTER TABLE task_run_slot_leases ADD COLUMN barrier_phase TEXT NOT NULL DEFAULT 'acquired' CHECK(barrier_phase IN ('acquired', 'ready'))");
      }
      if (!columns.has('reset_at')) {
        db.exec('ALTER TABLE task_run_slot_leases ADD COLUMN reset_at INTEGER');
      }
      db.prepare("UPDATE task_run_meta SET value_text='3' WHERE key='schema_version'").run();
    })();
    current = 3;
  }
  if (current === 3) {
    db.transaction(() => {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO task_run_artifacts
          (run_id, first_message_id, artifact_id, relative_path, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const selectMessages = db.prepare(`
        SELECT sequence, run_id, message_id, content_json, created_at
        FROM task_run_messages WHERE sequence>? ORDER BY sequence LIMIT 500
      `);
      let afterSequence = 0;
      while (true) {
        const messages = selectMessages.all(afterSequence);
        if (!messages.length) break;
        for (const message of messages) {
          persistArtifactReferences(insert, {
            runId: message.run_id,
            messageId: message.message_id,
            content: JSON.parse(message.content_json),
            createdAt: message.created_at,
          });
        }
        afterSequence = messages.at(-1).sequence;
      }
      db.prepare("UPDATE task_run_meta SET value_text='4' WHERE key='schema_version'").run();
    })();
    current = 4;
  }
  if (current === 4) {
    db.transaction(() => {
      // createSchema runs before migrations and installs the v5 table. Keep the
      // version transition explicit so restored v4 databases cannot silently
      // claim the newer contract without completing a durable open.
      db.prepare("UPDATE task_run_meta SET value_text='5' WHERE key='schema_version'").run();
    })();
    current = 5;
  }
  if (current !== SCHEMA_VERSION) {
    throw new TaskRunStoreError(`unsupported task-run schema version: ${version}`, 'TASK_RUN_SCHEMA_UNSUPPORTED');
  }
}

function normalizeExecutionStatus(value) {
  const raw = requiredString(value, 'executionStatus', 32).toLowerCase();
  const status = raw === 'success' ? 'succeeded'
    : raw === 'failure' ? 'failed'
      : raw === 'canceled' ? 'cancelled'
        : raw;
  if (!TERMINAL_EXECUTION_STATUSES.has(status)) {
    throw new TaskRunStoreError('executionStatus must be succeeded, failed, or cancelled', 'TASK_RUN_INPUT_INVALID');
  }
  return status;
}

function normalizeAnswerReceiptIdentity(input = {}) {
  const answerHash = requiredString(input.answerHash, 'answerHash', 64);
  if (!/^[a-f0-9]{64}$/.test(answerHash)) {
    throw new TaskRunStoreError('answerHash must be a lowercase sha256 digest',
      'TASK_RUN_ANSWER_INPUT_INVALID');
  }
  return {
    runId: requiredString(input.runId, 'runId'),
    requestId: requiredString(input.requestId, 'requestId', 160),
    clientMsgId: requiredString(input.clientMsgId, 'clientMsgId', 160),
    answerHash,
  };
}

function firstValue(object, keys) {
  for (const key of keys) if (object && object[key] != null) return object[key];
  return undefined;
}

function normalizeTokens(raw, coverage) {
  if (coverage === 'unobservable') {
    if (raw != null) {
      throw new TaskRunStoreError('unobservable usage must not contain token counts', 'USAGE_EVENT_INVALID');
    }
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TaskRunStoreError('observed usage requires tokens', 'USAGE_EVENT_INVALID');
  }
  const tokens = {
    freshInput: tokenCount(firstValue(raw, ['freshInput', 'input', 'inputTokens', 'input_tokens']), 'tokens.input'),
    cacheRead: tokenCount(firstValue(raw, ['cacheRead', 'cache_read', 'cache_read_input_tokens', 'cached_input_tokens']), 'tokens.cacheRead'),
    cacheWrite: tokenCount(firstValue(raw, ['cacheWrite', 'cache_write', 'cache_creation_input_tokens']), 'tokens.cacheWrite'),
    output: tokenCount(firstValue(raw, ['output', 'outputTokens', 'output_tokens']), 'tokens.output'),
    reasoning: tokenCount(firstValue(raw, ['reasoning', 'reasoningTokens', 'reasoning_output_tokens']), 'tokens.reasoning'),
  };
  if (tokens.reasoning > tokens.output) {
    throw new TaskRunStoreError('reasoning tokens cannot exceed output tokens', 'USAGE_EVENT_INVALID');
  }
  return tokens;
}

function normalizeUsageEvent(value, runId, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskRunStoreError('usage event must be an object', 'USAGE_EVENT_INVALID');
  }
  const coverage = requiredString(value.coverage, 'coverage', 32).toLowerCase();
  if (!USAGE_COVERAGE.has(coverage)) {
    throw new TaskRunStoreError('coverage must be observed or unobservable', 'USAGE_EVENT_INVALID');
  }
  const source = requiredString(value.source || 'exact', 'source', 32).toLowerCase();
  if (!USAGE_SOURCES.has(source)) {
    throw new TaskRunStoreError('source must be exact or reconciled', 'USAGE_EVENT_INVALID');
  }
  const roleKind = requiredString(value.roleKind || value.role || 'main', 'roleKind', 16).toLowerCase();
  if (!ROLE_KINDS.has(roleKind)) {
    throw new TaskRunStoreError('roleKind must be main, sub, or aux', 'USAGE_EVENT_INVALID');
  }
  const agentRole = roleKind === 'sub'
    ? optionalString(value.agentRole || 'default', 'agentRole', 32).toLowerCase()
    : '';
  const routeName = optionalString(
    value.routeName || (roleKind === 'sub' ? agentRole : roleKind), 'routeName', 64,
  ).toLowerCase();
  if (!routeName || !/^[a-z][a-z0-9_-]{0,63}$/.test(routeName)) {
    throw new TaskRunStoreError('routeName is invalid', 'USAGE_EVENT_INVALID');
  }
  const tokens = normalizeTokens(value.tokens === undefined ? value.usage : value.tokens, coverage);
  const normalized = {
    eventId: requiredString(value.eventId, 'eventId'),
    sourceEventId: optionalString(value.sourceEventId, 'sourceEventId') || null,
    occurredAt: timestamp(value.occurredAt == null ? value.timestamp : value.occurredAt, now, 'occurredAt'),
    runId,
    providerId: requiredString(value.providerId, 'providerId'),
    providerName: optionalString(value.providerName || value.providerId, 'providerName'),
    cli: optionalString(value.cli, 'cli', 32).toLowerCase(),
    protocol: optionalString(value.protocol, 'protocol', 64),
    model: optionalString(value.model, 'model'),
    roleKind,
    agentRole,
    routeName,
    source,
    coverage,
    status: optionalString(value.status || (coverage === 'observed' ? 'success' : 'unobservable'), 'status', 32).toLowerCase(),
    tokens,
    latencyMs: tokenCount(value.latencyMs, 'latencyMs'),
    statusCode: value.statusCode == null ? null : tokenCount(value.statusCode, 'statusCode'),
    errorCode: optionalString(value.errorCode, 'errorCode', 128) || null,
  };
  const contentJson = stableStringify(normalized, 'usage event');
  return Object.freeze({ ...normalized, contentJson, contentHash: digest(contentJson) });
}

function tokensDto(row) {
  const freshInput = Number(row.fresh_input_tokens || 0);
  const cacheRead = Number(row.cache_read_tokens || 0);
  const cacheWrite = Number(row.cache_write_tokens || 0);
  const output = Number(row.output_tokens || 0);
  const reasoning = Number(row.reasoning_tokens || 0);
  const consumedInput = freshInput + cacheRead + cacheWrite;
  return { freshInput, cacheRead, cacheWrite, consumedInput, output, reasoning, total: consumedInput + output };
}

function coverageFor(observed, unobservable) {
  if (observed > 0 && unobservable === 0) return 'observed';
  if (observed > 0) return 'partial';
  return 'unobservable';
}

function createTaskRunStore({ file, now = Date.now, Database = null, fsImpl = fs } = {}) {
  if (!file || !path.isAbsolute(String(file))) {
    throw new TaskRunStoreError('an absolute SQLite file path is required', 'TASK_RUN_STORE_PATH_REQUIRED');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const DatabaseCtor = Database || require('better-sqlite3');
  const dir = path.dirname(file);
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });

  let db;
  try {
    db = new DatabaseCtor(file);
    chmodPrivate(fsImpl, file);
    const journalMode = db.pragma('journal_mode = WAL', { simple: true });
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('secure_delete = ON');
    db.pragma('busy_timeout = 4000');
    db.pragma('wal_autocheckpoint = 1000');
    createSchema(db);
    db.prepare(`
      INSERT INTO task_run_meta(key, value_text) VALUES ('schema_version', ?)
      ON CONFLICT(key) DO NOTHING
    `).run(String(SCHEMA_VERSION));
    let version = Number(db.prepare(
      "SELECT value_text FROM task_run_meta WHERE key = 'schema_version'",
    ).get()?.value_text);
    migrateSchema(db, version);
    version = Number(db.prepare(
      "SELECT value_text FROM task_run_meta WHERE key = 'schema_version'",
    ).get()?.value_text);
    if (version !== SCHEMA_VERSION) {
      throw new TaskRunStoreError(`unsupported task-run schema version: ${version}`, 'TASK_RUN_SCHEMA_UNSUPPORTED');
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_lease_epoch ON task_runs(lease_epoch)');
    const maxLeaseEpoch = Number(db.prepare(
      'SELECT COALESCE(MAX(lease_epoch), 0) AS value FROM task_runs',
    ).get()?.value || 0);
    const storedLeaseEpoch = Number(db.prepare(
      "SELECT value_text FROM task_run_meta WHERE key='lease_epoch_counter'",
    ).get()?.value_text || 0);
    db.prepare(`
      INSERT INTO task_run_meta(key, value_text) VALUES ('lease_epoch_counter', ?)
      ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text
    `).run(String(Math.max(maxLeaseEpoch, storedLeaseEpoch)));
    if (db.pragma('quick_check', { simple: true }) !== 'ok') {
      throw new TaskRunStoreError('task-run SQLite quick_check failed', 'TASK_RUN_STORE_CORRUPT');
    }
    chmodPrivate(fsImpl, file);

    let closed = false;
    const settings = Object.freeze({
      journalMode,
      synchronous: db.pragma('synchronous', { simple: true }),
      foreignKeys: db.pragma('foreign_keys', { simple: true }),
    });
    const insertArtifactReference = db.prepare(`
      INSERT OR IGNORE INTO task_run_artifacts
        (run_id, first_message_id, artifact_id, relative_path, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    function ensureOpen() {
      if (closed || !db || !db.open) {
        throw new TaskRunStoreError('task-run store is closed', 'TASK_RUN_STORE_CLOSED');
      }
    }

    function rowForRun(runId) {
      ensureOpen();
      return db.prepare('SELECT * FROM task_runs WHERE run_id = ?').get(runId) || null;
    }

    function requireRun(runId) {
      const row = rowForRun(requiredString(runId, 'runId'));
      if (!row) throw new TaskRunStoreError('task run not found', 'TASK_RUN_NOT_FOUND', { runId });
      return row;
    }

    function mapRun(row) {
      if (!row) return null;
      return {
        runId: row.run_id,
        taskId: row.task_id,
        attemptId: row.attempt_id,
        slotId: row.slot_id || null,
        leaseEpoch: Number(row.lease_epoch),
        executionStatus: row.execution_status,
        usageStatus: row.usage_status,
        usageRevision: row.usage_revision,
        sealedRevision: row.sealed_revision == null ? null : row.sealed_revision,
        cleanupState: row.cleanup_state,
        startedAt: row.started_at,
        terminalAt: row.terminal_at == null ? null : row.terminal_at,
        sealedAt: row.sealed_at == null ? null : row.sealed_at,
        cleanedAt: row.cleaned_at == null ? null : row.cleaned_at,
        metadata: JSON.parse(row.metadata_json),
      };
    }

    function mapAnswerReceipt(row) {
      if (!row) return null;
      return {
        runId: row.run_id,
        requestId: row.request_id,
        clientMsgId: row.client_msg_id,
        answerHash: row.answer_hash,
        state: row.state,
        reservedAt: Number(row.reserved_at),
        acceptedAt: row.accepted_at == null ? null : Number(row.accepted_at),
        updatedAt: Number(row.updated_at),
      };
    }

    function answerReceiptRow(runId, requestId) {
      ensureOpen();
      return db.prepare(`
        SELECT * FROM task_run_answer_receipts WHERE run_id=? AND request_id=?
      `).get(runId, requestId) || null;
    }

    function assertSameAnswerReceipt(row, identity) {
      if (row.client_msg_id !== identity.clientMsgId
          || row.answer_hash !== identity.answerHash) {
        throw new TaskRunStoreError('answer receipt key is already owned by another payload',
          'TASK_RUN_ANSWER_CONFLICT', {
            runId: identity.runId, requestId: identity.requestId,
          });
      }
    }

    const reserveAnswerReceiptTransaction = db.transaction((input = {}) => {
      const identity = normalizeAnswerReceiptIdentity(input);
      requireRun(identity.runId);
      const existing = answerReceiptRow(identity.runId, identity.requestId);
      if (existing) {
        assertSameAnswerReceipt(existing, identity);
        return { ...mapAnswerReceipt(existing), duplicate: true };
      }
      const clientOwner = db.prepare(`
        SELECT * FROM task_run_answer_receipts WHERE run_id=? AND client_msg_id=?
      `).get(identity.runId, identity.clientMsgId);
      if (clientOwner) {
        throw new TaskRunStoreError('answer client id is already owned by another request',
          'TASK_RUN_ANSWER_CONFLICT', {
            runId: identity.runId, requestId: identity.requestId,
          });
      }
      const at = timestamp(input.reservedAt, now, 'answerReservedAt');
      db.prepare(`
        INSERT INTO task_run_answer_receipts
          (run_id, request_id, client_msg_id, answer_hash, state,
           reserved_at, accepted_at, updated_at)
        VALUES (?, ?, ?, ?, 'reserved', ?, NULL, ?)
      `).run(identity.runId, identity.requestId, identity.clientMsgId,
        identity.answerHash, at, at);
      return {
        ...mapAnswerReceipt(answerReceiptRow(identity.runId, identity.requestId)),
        duplicate: false,
      };
    });

    function reserveAnswerReceipt(input = {}) {
      ensureOpen();
      const result = reserveAnswerReceiptTransaction.immediate(input);
      chmodPrivate(fsImpl, file);
      return result;
    }

    const acceptAnswerReceiptTransaction = db.transaction((input = {}) => {
      const identity = normalizeAnswerReceiptIdentity(input);
      requireRun(identity.runId);
      const existing = answerReceiptRow(identity.runId, identity.requestId);
      if (!existing) {
        throw new TaskRunStoreError('answer receipt must be reserved before acceptance',
          'TASK_RUN_ANSWER_NOT_RESERVED', {
            runId: identity.runId, requestId: identity.requestId,
          });
      }
      assertSameAnswerReceipt(existing, identity);
      if (existing.state === 'accepted') {
        return { ...mapAnswerReceipt(existing), duplicate: true };
      }
      const at = timestamp(input.acceptedAt, now, 'answerAcceptedAt');
      db.prepare(`
        UPDATE task_run_answer_receipts
        SET state='accepted', accepted_at=?, updated_at=?
        WHERE run_id=? AND request_id=? AND state='reserved'
      `).run(at, at, identity.runId, identity.requestId);
      return {
        ...mapAnswerReceipt(answerReceiptRow(identity.runId, identity.requestId)),
        duplicate: false,
      };
    });

    function markAnswerAccepted(input = {}) {
      ensureOpen();
      const result = acceptAnswerReceiptTransaction.immediate(input);
      chmodPrivate(fsImpl, file);
      return result;
    }

    function getAnswerReceipt(input = {}) {
      ensureOpen();
      const runId = requiredString(input.runId, 'runId');
      const requestId = requiredString(input.requestId, 'requestId', 160);
      requireRun(runId);
      return mapAnswerReceipt(answerReceiptRow(runId, requestId));
    }

    function beginRunRecord(input = {}) {
      const runId = requiredString(input.runId, 'runId');
      const taskId = requiredString(input.taskId, 'taskId');
      const attemptId = requiredString(input.attemptId == null ? '1' : input.attemptId, 'attemptId');
      const slotId = optionalString(input.slotId, 'slotId') || null;
      const metadataJson = stableStringify(input.metadata == null ? {} : input.metadata, 'metadata');
      const existing = rowForRun(runId);
      if (existing) {
        if (existing.task_id !== taskId || existing.attempt_id !== attemptId
            || (slotId && (existing.slot_id || null) !== slotId)) {
          throw new TaskRunStoreError('runId is already owned by another task attempt', 'TASK_RUN_CONFLICT', { runId });
        }
        return mapRun(existing);
      }
      const startedAt = timestamp(input.startedAt, now, 'startedAt');
      const counter = Number(db.prepare(
        "SELECT value_text FROM task_run_meta WHERE key='lease_epoch_counter'",
      ).get()?.value_text || 0);
      const leaseEpoch = counter + 1;
      if (!Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1) {
        throw new TaskRunStoreError('task-run lease epoch exhausted', 'TASK_RUN_LEASE_EPOCH_EXHAUSTED');
      }
      db.prepare("UPDATE task_run_meta SET value_text=? WHERE key='lease_epoch_counter'")
        .run(String(leaseEpoch));
      db.prepare(`
        INSERT INTO task_runs(run_id, task_id, attempt_id, slot_id, lease_epoch, started_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(runId, taskId, attemptId, slotId, leaseEpoch, startedAt, metadataJson);
      return mapRun(rowForRun(runId));
    }

    const beginRunTransaction = db.transaction(beginRunRecord);

    function beginRun(input = {}) {
      ensureOpen();
      const result = beginRunTransaction(input);
      chmodPrivate(fsImpl, file);
      return result;
    }

    function mapSlotLease(row) {
      if (!row) return null;
      return {
        slotId: row.slot_id,
        runId: row.run_id,
        leaseEpoch: Number(row.lease_epoch),
        state: row.state,
        phase: row.barrier_phase,
        quarantineCode: row.quarantine_code || null,
      };
    }

    const acquireSlotLeaseTransaction = db.transaction((input = {}) => {
      const runId = requiredString(input.runId, 'runId');
      const slotId = requiredString(input.slotId, 'slotId');
      const run = requireRun(runId);
      const leaseEpoch = Number(input.leaseEpoch == null ? run.lease_epoch : input.leaseEpoch);
      if (!Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1 || leaseEpoch !== run.lease_epoch) {
        throw new TaskRunStoreError('slot lease epoch is stale', 'TASK_RUN_SLOT_LEASE_STALE', {
          runId, slotId, leaseEpoch, expectedLeaseEpoch: run.lease_epoch,
        });
      }
      if (run.execution_status !== 'running' || run.usage_status !== 'collecting'
          || run.cleanup_state !== 'blocked') {
        throw new TaskRunStoreError('task run is not open for slot acquisition',
          'TASK_RUN_SLOT_LEASE_CLOSED', { runId, slotId });
      }
      if (run.slot_id && run.slot_id !== slotId) {
        throw new TaskRunStoreError('task run is already bound to another slot',
          'TASK_RUN_SLOT_CONFLICT', { runId, slotId, ownerSlotId: run.slot_id });
      }
      const owner = db.prepare(`
        SELECT * FROM task_run_slot_leases WHERE slot_id=?
      `).get(slotId);
      if (owner?.state === 'quarantined') {
        throw new TaskRunStoreError('task execution slot is quarantined',
          'TASK_RUN_SLOT_LEASE_QUARANTINED', { runId, slotId, ownerRunId: owner.run_id });
      }
      if (owner?.state === 'active') {
        if (owner.run_id === runId && Number(owner.lease_epoch) === leaseEpoch) {
          return mapSlotLease(owner);
        }
        throw new TaskRunStoreError('task execution slot is already leased',
          'TASK_RUN_SLOT_LEASE_CONFLICT', {
            runId, slotId, ownerRunId: owner.run_id, ownerLeaseEpoch: owner.lease_epoch,
          });
      }
      if (owner && leaseEpoch <= Number(owner.lease_epoch)) {
        throw new TaskRunStoreError('slot lease epoch did not advance',
          'TASK_RUN_SLOT_LEASE_STALE', {
            runId, slotId, leaseEpoch, ownerLeaseEpoch: owner.lease_epoch,
          });
      }
      const runOwner = db.prepare(`
        SELECT * FROM task_run_slot_leases WHERE run_id=? AND slot_id<>?
      `).get(runId, slotId);
      if (runOwner) {
        throw new TaskRunStoreError('task run already owns another slot lease',
          'TASK_RUN_SLOT_CONFLICT', { runId, slotId, ownerSlotId: runOwner.slot_id });
      }
      const at = timestamp(input.at, now, 'slotLeaseAt');
      if (!run.slot_id) {
        const updated = db.prepare('UPDATE task_runs SET slot_id=? WHERE run_id=? AND slot_id IS NULL')
          .run(slotId, runId);
        if (updated.changes !== 1) {
          throw new TaskRunStoreError('task run slot binding raced',
            'TASK_RUN_SLOT_LEASE_CONFLICT', { runId, slotId });
        }
      }
      db.prepare(`
        INSERT INTO task_run_slot_leases
          (slot_id, run_id, lease_epoch, state, barrier_phase, quarantine_code,
           acquired_at, reset_at, updated_at, released_at)
        VALUES (?, ?, ?, 'active', 'acquired', NULL, ?, NULL, ?, NULL)
        ON CONFLICT(slot_id) DO UPDATE SET
          run_id=excluded.run_id,
          lease_epoch=excluded.lease_epoch,
          state='active',
          barrier_phase='acquired',
          quarantine_code=NULL,
          acquired_at=excluded.acquired_at,
          reset_at=NULL,
          updated_at=excluded.updated_at,
          released_at=NULL
      `).run(slotId, runId, leaseEpoch, at, at);
      return mapSlotLease(db.prepare(
        'SELECT * FROM task_run_slot_leases WHERE slot_id=?',
      ).get(slotId));
    });

    function acquireSlotLease(input = {}) {
      ensureOpen();
      const result = acquireSlotLeaseTransaction(input);
      chmodPrivate(fsImpl, file);
      return result;
    }

    function bindRunSlot(input = {}) {
      acquireSlotLease(input);
      return mapRun(requireRun(input.runId));
    }

    function requireSlotLeaseCas(input = {}) {
      const slotId = requiredString(input.slotId, 'slotId');
      const runId = requiredString(input.runId, 'runId');
      const leaseEpoch = Number(input.leaseEpoch);
      if (!Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1) {
        throw new TaskRunStoreError('slot lease epoch is invalid',
          'TASK_RUN_SLOT_LEASE_STALE', { runId, slotId, leaseEpoch });
      }
      const lease = db.prepare('SELECT * FROM task_run_slot_leases WHERE slot_id=?').get(slotId);
      if (!lease || lease.run_id !== runId || Number(lease.lease_epoch) !== leaseEpoch) {
        throw new TaskRunStoreError('slot lease compare-and-swap failed',
          'TASK_RUN_SLOT_LEASE_STALE', {
            runId, slotId, leaseEpoch,
            ownerRunId: lease?.run_id || null,
            ownerLeaseEpoch: lease ? Number(lease.lease_epoch) : null,
          });
      }
      return lease;
    }

    const markSlotLeaseReadyTransaction = db.transaction((input = {}) => {
      const lease = requireSlotLeaseCas(input);
      if (lease.state !== 'active') {
        throw new TaskRunStoreError('only an active slot lease can complete reset',
          'TASK_RUN_SLOT_LEASE_STALE', { runId: lease.run_id, slotId: lease.slot_id });
      }
      if (lease.barrier_phase === 'ready') return mapSlotLease(lease);
      const at = timestamp(input.resetAt == null ? input.at : input.resetAt, now, 'slotResetAt');
      const updated = db.prepare(`
        UPDATE task_run_slot_leases SET barrier_phase='ready', reset_at=?, updated_at=?
        WHERE slot_id=? AND run_id=? AND lease_epoch=?
          AND state='active' AND barrier_phase='acquired'
      `).run(at, at, lease.slot_id, lease.run_id, lease.lease_epoch);
      if (updated.changes !== 1) {
        throw new TaskRunStoreError('slot reset barrier compare-and-swap failed',
          'TASK_RUN_SLOT_LEASE_STALE', { runId: lease.run_id, slotId: lease.slot_id });
      }
      return mapSlotLease(db.prepare(
        'SELECT * FROM task_run_slot_leases WHERE slot_id=?',
      ).get(lease.slot_id));
    });

    function markSlotLeaseReady(input = {}) {
      ensureOpen();
      const result = markSlotLeaseReadyTransaction(input);
      chmodPrivate(fsImpl, file);
      return result;
    }

    const releaseSlotLeaseTransaction = db.transaction((input = {}) => {
      const lease = requireSlotLeaseCas(input);
      if (lease.state === 'released') return mapSlotLease(lease);
      if (lease.state !== 'active') {
        throw new TaskRunStoreError('quarantined slot lease requires explicit recovery',
          'TASK_RUN_SLOT_LEASE_QUARANTINED', { runId: lease.run_id, slotId: lease.slot_id });
      }
      const at = timestamp(input.at, now, 'slotLeaseReleaseAt');
      const updated = db.prepare(`
        UPDATE task_run_slot_leases SET state='released', updated_at=?, released_at=?
        WHERE slot_id=? AND run_id=? AND lease_epoch=? AND state='active'
      `).run(at, at, lease.slot_id, lease.run_id, lease.lease_epoch);
      if (updated.changes !== 1) {
        throw new TaskRunStoreError('slot lease release raced',
          'TASK_RUN_SLOT_LEASE_STALE', { runId: lease.run_id, slotId: lease.slot_id });
      }
      return mapSlotLease(db.prepare(
        'SELECT * FROM task_run_slot_leases WHERE slot_id=?',
      ).get(lease.slot_id));
    });

    function releaseSlotLease(input = {}) {
      ensureOpen();
      const result = releaseSlotLeaseTransaction(input);
      chmodPrivate(fsImpl, file);
      return result;
    }

    const quarantineSlotLeaseTransaction = db.transaction((input = {}) => {
      const lease = requireSlotLeaseCas(input);
      const code = requiredString(input.code || input.errorCode || 'RECOVERY_AMBIGUOUS',
        'quarantineCode', 128);
      if (lease.state === 'released') {
        throw new TaskRunStoreError('released slot lease cannot be quarantined',
          'TASK_RUN_SLOT_LEASE_STALE', { runId: lease.run_id, slotId: lease.slot_id });
      }
      const at = timestamp(input.at, now, 'slotLeaseQuarantineAt');
      db.prepare(`
        UPDATE task_run_slot_leases SET state='quarantined', quarantine_code=?, updated_at=?
        WHERE slot_id=? AND run_id=? AND lease_epoch=?
      `).run(code, at, lease.slot_id, lease.run_id, lease.lease_epoch);
      return mapSlotLease(db.prepare(
        'SELECT * FROM task_run_slot_leases WHERE slot_id=?',
      ).get(lease.slot_id));
    });

    function quarantineSlotLease(input = {}) {
      ensureOpen();
      const result = quarantineSlotLeaseTransaction(input);
      chmodPrivate(fsImpl, file);
      return result;
    }

    function quarantineUnleasedRun(input = {}) {
      ensureOpen();
      const runId = requiredString(input.runId, 'runId');
      const slotId = requiredString(input.slotId, 'slotId');
      const code = requiredString(input.code || input.errorCode || 'TASK_RUN_LEASE_MISSING',
        'quarantineCode', 128);
      const run = requireRun(runId);
      if (run.slot_id !== slotId) {
        throw new TaskRunStoreError('unleased run slot identity mismatch',
          'TASK_RUN_SLOT_CONFLICT', { runId, slotId, ownerSlotId: run.slot_id || null });
      }
      const at = timestamp(input.at, now, 'recoveryQuarantineAt');
      db.prepare(`
        INSERT INTO task_run_recovery_quarantine(run_id, slot_id, error_code, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          slot_id=excluded.slot_id, error_code=excluded.error_code, updated_at=excluded.updated_at
      `).run(runId, slotId, code, at, at);
      chmodPrivate(fsImpl, file);
      return { runId, slotId, code };
    }

    function getSlotLease(slotIdValue) {
      ensureOpen();
      const slotId = requiredString(slotIdValue, 'slotId');
      return mapSlotLease(db.prepare(
        'SELECT * FROM task_run_slot_leases WHERE slot_id=?',
      ).get(slotId));
    }

    function mapCleanupManifest(row) {
      if (!row) return null;
      return deepFreeze({
        runId: row.run_id,
        slotId: row.slot_id,
        leaseEpoch: Number(row.lease_epoch),
        capturedAt: Number(row.captured_at),
        nativeRefs: JSON.parse(row.native_refs_json),
      });
    }

    const saveCleanupManifestTransaction = db.transaction((input = {}) => {
      const runId = requiredString(input.runId, 'runId');
      const slotId = requiredString(input.slotId, 'slotId');
      const leaseEpoch = Number(input.leaseEpoch);
      const lease = requireSlotLeaseCas({ runId, slotId, leaseEpoch });
      if (lease.state !== 'active' || lease.barrier_phase !== 'ready') {
        throw new TaskRunStoreError('cleanup manifest requires a ready active slot lease',
          'TASK_RUN_CLEANUP_MANIFEST_BLOCKED', { runId, slotId });
      }
      const run = requireRun(runId);
      if (run.slot_id !== slotId || Number(run.lease_epoch) !== leaseEpoch) {
        throw new TaskRunStoreError('cleanup manifest run identity mismatch',
          'TASK_RUN_SLOT_LEASE_STALE', { runId, slotId, leaseEpoch });
      }
      if (!input.nativeRefs || typeof input.nativeRefs !== 'object' || Array.isArray(input.nativeRefs)) {
        throw new TaskRunStoreError('nativeRefs must be an object', 'TASK_RUN_INPUT_INVALID');
      }
      const capturedAt = timestamp(input.capturedAt, now, 'capturedAt');
      const nativeRefsJson = stableStringify(input.nativeRefs, 'nativeRefs');
      if (Buffer.byteLength(nativeRefsJson, 'utf8') > 8 * 1024 * 1024) {
        throw new TaskRunStoreError('cleanup manifest is too large', 'TASK_RUN_CLEANUP_MANIFEST_TOO_LARGE');
      }
      const contentHash = digest(stableStringify({
        runId, slotId, leaseEpoch, nativeRefs: JSON.parse(nativeRefsJson),
      }));
      const existing = db.prepare(`
        SELECT * FROM task_run_cleanup_manifests WHERE run_id=?
      `).get(runId);
      if (existing) {
        if (existing.content_hash !== contentHash) {
          throw new TaskRunStoreError('cleanup manifest content conflict',
            'TASK_RUN_CLEANUP_MANIFEST_CONFLICT', { runId });
        }
        return { manifest: mapCleanupManifest(existing), duplicate: true };
      }
      const createdAt = timestamp(null, now, 'manifestCreatedAt');
      db.prepare(`
        INSERT INTO task_run_cleanup_manifests
          (run_id, slot_id, lease_epoch, content_hash, native_refs_json, captured_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(runId, slotId, leaseEpoch, contentHash, nativeRefsJson, capturedAt, createdAt);
      return {
        manifest: mapCleanupManifest(db.prepare(
          'SELECT * FROM task_run_cleanup_manifests WHERE run_id=?',
        ).get(runId)),
        duplicate: false,
      };
    });

    function saveCleanupManifest(input = {}) {
      ensureOpen();
      const result = saveCleanupManifestTransaction(input);
      chmodPrivate(fsImpl, file);
      return Object.freeze({ ...result.manifest, duplicate: result.duplicate });
    }

    function getCleanupManifest(runIdValue) {
      ensureOpen();
      const runId = requiredString(runIdValue, 'runId');
      requireRun(runId);
      return mapCleanupManifest(db.prepare(
        'SELECT * FROM task_run_cleanup_manifests WHERE run_id=?',
      ).get(runId));
    }

    function listSlotLeases(input = {}) {
      ensureOpen();
      const includeReleased = input === true || input?.includeReleased === true;
      return db.prepare(`
        SELECT * FROM task_run_slot_leases
        ${includeReleased ? '' : "WHERE state<>'released'"}
        ORDER BY slot_id
      `).all().map(mapSlotLease);
    }

    function recoveryAction(row) {
      if (row.lease_state === 'quarantined') return 'quarantine';
      if (row.cleanup_state === 'done') return 'release_stale';
      if (TERMINAL_EXECUTION_STATUSES.has(row.execution_status)
          && ['allowed', 'deleting'].includes(row.cleanup_state)
          && row.barrier_phase === 'ready'
          && row.sealed_revision != null
          && Number(row.sealed_revision) === Number(row.usage_revision)) {
        return 'resume_cleanup';
      }
      if (row.execution_status === 'running' && row.usage_status === 'collecting'
          && row.cleanup_state === 'blocked') {
        return row.barrier_phase === 'ready' ? 'restore_projection' : 'reset_barrier';
      }
      return 'quarantine';
    }

    function planSlotLeaseRecovery() {
      ensureOpen();
      const leased = db.prepare(`
        SELECT l.slot_id, l.run_id, l.lease_epoch, l.state AS lease_state,
          l.barrier_phase,
          l.quarantine_code, r.task_id, r.execution_status, r.usage_status,
          r.usage_revision, r.sealed_revision, r.cleanup_state
        FROM task_run_slot_leases l
        JOIN task_runs r ON r.run_id=l.run_id
        WHERE l.state<>'released'
      `).all().map(row => ({
        slotId: row.slot_id,
        runId: row.run_id,
        taskId: row.task_id,
        leaseEpoch: Number(row.lease_epoch),
        leaseState: row.lease_state,
        phase: row.barrier_phase,
        cleanupState: row.cleanup_state,
        executionStatus: row.execution_status,
        usageStatus: row.usage_status,
        quarantineCode: row.quarantine_code || null,
        action: recoveryAction(row),
      }));
      const orphaned = db.prepare(`
        SELECT r.*, q.error_code AS recovery_error_code FROM task_runs r
        LEFT JOIN task_run_recovery_quarantine q ON q.run_id=r.run_id
        WHERE r.slot_id IS NOT NULL AND r.cleanup_state<>'done'
          AND NOT EXISTS (
            SELECT 1 FROM task_run_slot_leases l
            WHERE l.run_id=r.run_id AND l.state<>'released'
          )
      `).all().map(row => ({
        slotId: row.slot_id,
        runId: row.run_id,
        taskId: row.task_id,
        leaseEpoch: Number(row.lease_epoch),
        leaseState: null,
        cleanupState: row.cleanup_state,
        executionStatus: row.execution_status,
        usageStatus: row.usage_status,
        quarantineCode: row.recovery_error_code || 'TASK_RUN_LEASE_MISSING',
        action: 'quarantine_unleased',
      }));
      const combined = [...leased, ...orphaned];
      const slotCounts = new Map();
      for (const item of combined) slotCounts.set(item.slotId, (slotCounts.get(item.slotId) || 0) + 1);
      for (const item of combined) {
        if (slotCounts.get(item.slotId) < 2) continue;
        item.quarantineCode = 'TASK_RUN_SLOT_RECOVERY_AMBIGUOUS';
        if (item.action !== 'quarantine_unleased') item.action = 'quarantine';
      }
      return combined.sort((left, right) => (
        left.slotId.localeCompare(right.slotId) || left.runId.localeCompare(right.runId)
      ));
    }

    function mapMessage(row, duplicate = false) {
      return {
        runId: row.run_id,
        messageId: row.message_id,
        role: row.role,
        kind: row.kind,
        content: JSON.parse(row.content_json),
        metadata: JSON.parse(row.metadata_json),
        createdAt: row.created_at,
        duplicate,
      };
    }

    function appendMessageRecord(input = {}) {
      const runId = requiredString(input.runId, 'runId');
      requireRun(runId);
      const messageId = requiredString(input.messageId, 'messageId');
      const role = requiredString(input.role, 'role', 32).toLowerCase();
      const kind = optionalString(input.kind || 'message', 'kind', 64).toLowerCase();
      const contentJson = stableStringify(input.content, 'content');
      const metadataJson = stableStringify(input.metadata == null ? {} : input.metadata, 'metadata');
      const createdAt = timestamp(input.createdAt, now, 'createdAt');
      const contentHash = digest(stableStringify({ role, kind, content: JSON.parse(contentJson), metadata: JSON.parse(metadataJson), createdAt }));
      const existing = db.prepare(`
        SELECT * FROM task_run_messages WHERE run_id = ? AND message_id = ?
      `).get(runId, messageId);
      if (existing) {
        if (existing.content_hash !== contentHash) {
          throw new TaskRunStoreError('messageId content conflict', 'TASK_RUN_MESSAGE_CONFLICT', { runId, messageId });
        }
        persistArtifactReferences(insertArtifactReference, {
          runId,
          messageId,
          content: JSON.parse(existing.content_json),
          createdAt: existing.created_at,
        });
        return mapMessage(existing, true);
      }
      db.prepare(`
        INSERT INTO task_run_messages
          (run_id, message_id, role, kind, content_json, metadata_json, content_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(runId, messageId, role, kind, contentJson, metadataJson, contentHash, createdAt);
      persistArtifactReferences(insertArtifactReference, {
        runId, messageId, content: JSON.parse(contentJson), createdAt,
      });
      return mapMessage(db.prepare(`
        SELECT * FROM task_run_messages WHERE run_id = ? AND message_id = ?
      `).get(runId, messageId));
    }

    const appendMessageTransaction = db.transaction(appendMessageRecord);

    function appendMessage(input = {}) {
      ensureOpen();
      const result = appendMessageTransaction(input);
      chmodPrivate(fsImpl, file);
      return result;
    }

    const admitRunTransaction = db.transaction((input = {}) => {
      if (!input.run || typeof input.run !== 'object' || Array.isArray(input.run)) {
        throw new TaskRunStoreError('run admission requires a run object', 'TASK_RUN_INPUT_INVALID');
      }
      if (!Array.isArray(input.messages) || input.messages.length > 10_000) {
        throw new TaskRunStoreError('run admission messages are invalid', 'TASK_RUN_INPUT_INVALID');
      }
      const runId = requiredString(input.run.runId, 'runId');
      const created = !rowForRun(runId);
      const run = beginRunRecord(input.run);
      const messages = input.messages.map(message => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          throw new TaskRunStoreError('run admission message is invalid', 'TASK_RUN_INPUT_INVALID');
        }
        if (message.runId != null && String(message.runId).trim() !== runId) {
          throw new TaskRunStoreError('run admission message belongs to another run',
            'TASK_RUN_INPUT_INVALID');
        }
        return appendMessageRecord({
          ...message,
          runId,
          ...(message.atRunStart === true ? { createdAt: run.startedAt } : {}),
        });
      });
      return { run, messages, created };
    });

    function admitRun(input = {}) {
      ensureOpen();
      const result = admitRunTransaction(input);
      chmodPrivate(fsImpl, file);
      return Object.freeze({
        run: result.run,
        messages: Object.freeze(result.messages),
        created: result.created,
      });
    }

    const applyProjection = db.transaction((runId, event, sign) => {
      const run = requireRun(runId);
      const tokens = event.tokens || { freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
      const observedDelta = event.coverage === 'observed' ? sign : 0;
      const unobservableDelta = event.coverage === 'unobservable' ? sign : 0;
      const next = {
        freshInput: run.fresh_input_tokens + sign * tokens.freshInput,
        cacheRead: run.cache_read_tokens + sign * tokens.cacheRead,
        cacheWrite: run.cache_write_tokens + sign * tokens.cacheWrite,
        output: run.output_tokens + sign * tokens.output,
        reasoning: run.reasoning_tokens + sign * tokens.reasoning,
        observed: run.observed_event_count + observedDelta,
        unobservable: run.unobservable_event_count + unobservableDelta,
      };
      if (Object.values(next).some(value => value < 0 || !Number.isSafeInteger(value))) {
        throw new TaskRunStoreError('usage aggregate underflow or overflow', 'TASK_RUN_USAGE_AGGREGATE_INVALID');
      }
      db.prepare(`
        UPDATE task_runs SET fresh_input_tokens=?, cache_read_tokens=?, cache_write_tokens=?,
          output_tokens=?, reasoning_tokens=?, observed_event_count=?, unobservable_event_count=?
        WHERE run_id=?
      `).run(next.freshInput, next.cacheRead, next.cacheWrite, next.output, next.reasoning,
        next.observed, next.unobservable, runId);

      const key = [runId, event.providerId, event.model, event.roleKind, event.routeName];
      const dimension = db.prepare(`
        SELECT * FROM task_run_usage_dimensions
        WHERE run_id=? AND provider_id=? AND model=? AND role_kind=? AND route_name=?
      `).get(...key);
      const dim = {
        freshInput: Number(dimension?.fresh_input_tokens || 0) + sign * tokens.freshInput,
        cacheRead: Number(dimension?.cache_read_tokens || 0) + sign * tokens.cacheRead,
        cacheWrite: Number(dimension?.cache_write_tokens || 0) + sign * tokens.cacheWrite,
        output: Number(dimension?.output_tokens || 0) + sign * tokens.output,
        reasoning: Number(dimension?.reasoning_tokens || 0) + sign * tokens.reasoning,
        observed: Number(dimension?.observed_event_count || 0) + observedDelta,
        unobservable: Number(dimension?.unobservable_event_count || 0) + unobservableDelta,
      };
      if (Object.values(dim).some(value => value < 0 || !Number.isSafeInteger(value))) {
        throw new TaskRunStoreError('usage dimension underflow or overflow', 'TASK_RUN_USAGE_AGGREGATE_INVALID');
      }
      if (dim.observed === 0 && dim.unobservable === 0) {
        db.prepare(`
          DELETE FROM task_run_usage_dimensions
          WHERE run_id=? AND provider_id=? AND model=? AND role_kind=? AND route_name=?
        `).run(...key);
      } else {
        db.prepare(`
          INSERT INTO task_run_usage_dimensions
            (run_id, provider_id, provider_name, model, role_kind, route_name,
             fresh_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
             reasoning_tokens, observed_event_count, unobservable_event_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id, provider_id, model, role_kind, route_name) DO UPDATE SET
            provider_name=excluded.provider_name,
            fresh_input_tokens=excluded.fresh_input_tokens,
            cache_read_tokens=excluded.cache_read_tokens,
            cache_write_tokens=excluded.cache_write_tokens,
            output_tokens=excluded.output_tokens,
            reasoning_tokens=excluded.reasoning_tokens,
            observed_event_count=excluded.observed_event_count,
            unobservable_event_count=excluded.unobservable_event_count
        `).run(...key.slice(0, 2), event.providerName, ...key.slice(2),
          dim.freshInput, dim.cacheRead, dim.cacheWrite, dim.output, dim.reasoning,
          dim.observed, dim.unobservable);
      }
    });

    function eventFromRow(row) {
      return JSON.parse(row.content_json);
    }

    const observeTransaction = db.transaction((runId, rawEvent) => {
      requireRun(runId);
      const event = normalizeUsageEvent(rawEvent, runId, now);
      const existing = db.prepare('SELECT * FROM task_run_usage_events WHERE event_id=?').get(event.eventId);
      if (existing && existing.run_id !== runId) {
        throw new TaskRunStoreError('usage eventId is already owned by another run', 'USAGE_EVENT_RUN_CONFLICT', {
          eventId: event.eventId, runId, ownerRunId: existing.run_id,
        });
      }
      if (existing && existing.content_hash === event.contentHash) {
        return { inserted: false, corrected: false, duplicate: true, eventId: event.eventId,
          revision: requireRun(runId).usage_revision };
      }

      const changedAt = timestamp(null, now, 'updatedAt');
      if (existing) applyProjection(runId, eventFromRow(existing), -1);
      applyProjection(runId, event, 1);
      const tokenValues = event.tokens
        ? [event.tokens.freshInput, event.tokens.cacheRead, event.tokens.cacheWrite,
          event.tokens.output, event.tokens.reasoning]
        : [null, null, null, null, null];
      if (!existing) {
        db.prepare(`
          INSERT INTO task_run_usage_events
            (event_id, run_id, content_hash, source_event_id, occurred_at, provider_id,
             provider_name, cli, protocol, model, role_kind, agent_role, route_name,
             source, coverage, status, fresh_input_tokens, cache_read_tokens,
             cache_write_tokens, output_tokens, reasoning_tokens, latency_ms, status_code,
             error_code, content_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(event.eventId, runId, event.contentHash, event.sourceEventId, event.occurredAt,
          event.providerId, event.providerName, event.cli, event.protocol, event.model,
          event.roleKind, event.agentRole, event.routeName, event.source, event.coverage,
          event.status, ...tokenValues, event.latencyMs, event.statusCode, event.errorCode,
          event.contentJson, changedAt, changedAt);
      } else {
        db.prepare(`
          UPDATE task_run_usage_events SET content_hash=?, event_revision=event_revision+1,
            source_event_id=?, occurred_at=?, provider_id=?, provider_name=?, cli=?, protocol=?,
            model=?, role_kind=?, agent_role=?, route_name=?, source=?, coverage=?, status=?,
            fresh_input_tokens=?, cache_read_tokens=?, cache_write_tokens=?, output_tokens=?,
            reasoning_tokens=?, latency_ms=?, status_code=?, error_code=?, content_json=?, updated_at=?
          WHERE event_id=?
        `).run(event.contentHash, event.sourceEventId, event.occurredAt, event.providerId,
          event.providerName, event.cli, event.protocol, event.model, event.roleKind,
          event.agentRole, event.routeName, event.source, event.coverage, event.status,
          ...tokenValues, event.latencyMs, event.statusCode, event.errorCode, event.contentJson,
          changedAt, event.eventId);
      }

      const run = requireRun(runId);
      const revision = run.usage_revision + 1;
      if (run.cleanup_state === 'done') {
        const nextUsageStatus = coverageFor(run.observed_event_count, run.unobservable_event_count) === 'observed'
          ? 'sealed' : coverageFor(run.observed_event_count, run.unobservable_event_count);
        db.prepare(`
          UPDATE task_runs SET usage_revision=?, sealed_revision=?, usage_status=?, sealed_at=?
          WHERE run_id=?
        `).run(revision, revision, nextUsageStatus, changedAt, runId);
      } else {
        db.prepare(`
          UPDATE task_runs SET usage_revision=?, sealed_revision=NULL, usage_status='collecting',
            sealed_at=NULL, cleanup_state='blocked', cleanup_error_code=NULL
          WHERE run_id=?
        `).run(revision, runId);
      }
      return { inserted: !existing, corrected: !!existing, duplicate: false,
        eventId: event.eventId, revision };
    });

    function observeUsage(input, maybeEvent) {
      ensureOpen();
      const runId = typeof input === 'string' ? input : input && input.runId;
      const event = typeof input === 'string' ? maybeEvent : input && (input.event || input.usageEvent);
      const result = observeTransaction(requiredString(runId, 'runId'), event);
      chmodPrivate(fsImpl, file);
      return result;
    }

    const sealTransaction = db.transaction((input) => {
      const runId = requiredString(input.runId, 'runId');
      const run = requireRun(runId);
      const executionStatus = normalizeExecutionStatus(input.executionStatus);
      const reasons = [];
      if (input.outcomeDurable !== true) reasons.push('outcome_durable');
      if (input.producersDrained !== true) reasons.push('producers_drained');
      if (input.nativeTranscriptChecked !== true) reasons.push('native_transcript_checked');
      if (reasons.length) {
        throw new TaskRunStoreError('usage cannot be sealed before every durability boundary',
          'TASK_RUN_USAGE_SEAL_BLOCKED', { runId, reasons });
      }
      if (run.execution_status !== 'running' && run.execution_status !== executionStatus) {
        throw new TaskRunStoreError('task run already has a different terminal status',
          'TASK_RUN_EXECUTION_STATUS_CONFLICT', { runId });
      }
      if (run.sealed_revision === run.usage_revision
          && ['sealed', 'partial', 'unobservable'].includes(run.usage_status)
          && run.execution_status === executionStatus) {
        return mapRun(run);
      }
      const at = timestamp(input.sealedAt, now, 'sealedAt');
      const coverage = coverageFor(run.observed_event_count, run.unobservable_event_count);
      const usageStatus = coverage === 'observed' ? 'sealed' : coverage;
      db.prepare(`
        UPDATE task_runs SET execution_status=?, usage_status=?, outcome_durable=1,
          producers_drained=1, native_transcript_checked=1, sealed_revision=usage_revision,
          cleanup_state='allowed', terminal_at=COALESCE(terminal_at, ?), sealed_at=?,
          cleanup_error_code=NULL
        WHERE run_id=?
      `).run(executionStatus, usageStatus, at, at, runId);
      return mapRun(requireRun(runId));
    });

    function sealUsage(input = {}) {
      ensureOpen();
      const result = sealTransaction(input);
      chmodPrivate(fsImpl, file);
      return result;
    }

    function getCleanupPermit(runIdValue) {
      const run = requireRun(requiredString(runIdValue, 'runId'));
      if (!TERMINAL_EXECUTION_STATUSES.has(run.execution_status)
          || !['sealed', 'partial', 'unobservable'].includes(run.usage_status)
          || run.sealed_revision == null || run.sealed_revision !== run.usage_revision
          || !run.outcome_durable || !run.producers_drained || !run.native_transcript_checked
          || run.cleanup_state === 'done') return null;
      return Object.freeze({ runId: run.run_id, revision: run.sealed_revision, issuedAt: run.sealed_at });
    }

    const cleanupTransaction = db.transaction((input) => {
      const runId = requiredString(input.runId || input.permit?.runId, 'runId');
      const run = requireRun(runId);
      const permit = input.permit || input;
      const revision = Number(permit.revision);
      if (!Number.isSafeInteger(revision)
          || revision !== run.usage_revision || revision !== run.sealed_revision
          || !['sealed', 'partial', 'unobservable'].includes(run.usage_status)) {
        throw new TaskRunStoreError('cleanup permit is stale', 'TASK_RUN_CLEANUP_PERMIT_STALE', { runId });
      }
      const state = requiredString(input.state, 'state', 32).toLowerCase();
      if (!CLEANUP_STATES.has(state)) {
        throw new TaskRunStoreError('cleanup state must be deleting, done, or error', 'TASK_RUN_INPUT_INVALID');
      }
      if (run.cleanup_state === 'done') {
        if (state === 'done') return mapRun(run);
        throw new TaskRunStoreError('cleanup already completed', 'TASK_RUN_CLEANUP_ALREADY_DONE', { runId });
      }
      const at = timestamp(input.at, now, 'cleanupAt');
      const errorCode = state === 'error'
        ? requiredString(input.errorCode || 'CLEANUP_FAILED', 'errorCode', 128)
        : null;
      db.prepare(`
        UPDATE task_runs SET cleanup_state=?, cleanup_updated_at=?,
          cleaned_at=CASE WHEN ?='done' THEN ? ELSE cleaned_at END,
          cleanup_error_code=? WHERE run_id=?
      `).run(state, at, state, at, errorCode, runId);
      return mapRun(requireRun(runId));
    });

    function markCleanup(input = {}) {
      ensureOpen();
      const result = cleanupTransaction(input);
      chmodPrivate(fsImpl, file);
      return result;
    }

    function getRun(runId) {
      return mapRun(requireRun(runId));
    }

    function listTaskRuns(taskIdValue) {
      ensureOpen();
      const taskId = typeof taskIdValue === 'object' && taskIdValue
        ? taskIdValue.taskId : taskIdValue;
      return db.prepare(`
        SELECT * FROM task_runs WHERE task_id=? ORDER BY started_at, run_id
      `).all(requiredString(taskId, 'taskId')).map(mapRun);
    }

    function getRunMessages(runIdValue) {
      const runId = requiredString(runIdValue, 'runId');
      requireRun(runId);
      return db.prepare(`
        SELECT * FROM task_run_messages WHERE run_id=? ORDER BY sequence
      `).all(runId).map(row => mapMessage(row));
    }

    function mapTaskArtifact(row) {
      return {
        taskId: row.task_id,
        runId: row.run_id,
        messageId: row.first_message_id,
        artifactId: row.artifact_id,
        relativePath: row.relative_path,
        createdAt: Number(row.created_at),
      };
    }

    function listTaskArtifacts(taskIdValue) {
      ensureOpen();
      const taskId = typeof taskIdValue === 'object' && taskIdValue
        ? taskIdValue.taskId : taskIdValue;
      return db.prepare(`
        SELECT r.task_id, a.run_id, a.first_message_id, a.artifact_id,
          a.relative_path, a.created_at
        FROM task_run_artifacts a
        JOIN task_runs r ON r.run_id=a.run_id
        WHERE r.task_id=?
        ORDER BY r.started_at, a.artifact_id, a.relative_path, a.run_id
      `).all(requiredString(taskId, 'taskId')).map(mapTaskArtifact);
    }

    function listPinnedArtifactIds() {
      ensureOpen();
      return db.prepare(`
        SELECT DISTINCT artifact_id FROM task_run_artifacts ORDER BY artifact_id
      `).all().map(row => row.artifact_id);
    }

    function mapDimension(row) {
      return {
        providerId: row.provider_id,
        providerName: row.provider_name,
        model: row.model,
        roleKind: row.role_kind,
        routeName: row.route_name,
        freshInput: Number(row.fresh_input_tokens || 0),
        cacheRead: Number(row.cache_read_tokens || 0),
        cacheWrite: Number(row.cache_write_tokens || 0),
        output: Number(row.output_tokens || 0),
        reasoning: Number(row.reasoning_tokens || 0),
        observedEvents: Number(row.observed_event_count || 0),
        unobservableEvents: Number(row.unobservable_event_count || 0),
      };
    }

    function usageAccountingForRun(run) {
      const events = db.prepare(`
        SELECT cli, role_kind, source, coverage,
          fresh_input_tokens, cache_read_tokens, cache_write_tokens,
          output_tokens, reasoning_tokens
        FROM task_run_usage_events WHERE run_id=?
      `).all(run.run_id);
      const claudeMainIsAggregate = events.some(event => (
        event.coverage === 'observed'
        && event.cli === 'claude'
        && event.role_kind === 'main'
        && event.source === 'reconciled'
      ));
      if (!claudeMainIsAggregate) {
        return {
          tokens: tokensDto(run),
          accountingMode: 'additive',
          breakdownMayOverlapTotal: false,
        };
      }

      // Claude's CLI result usage is an aggregate for the complete native turn,
      // including its native subagents. Keep exact subagent events as an audit
      // breakdown, but do not add them to the authoritative run total again.
      const total = {
        fresh_input_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
      };
      for (const event of events) {
        if (event.cli === 'claude' && event.role_kind === 'sub') continue;
        total.fresh_input_tokens += Number(event.fresh_input_tokens || 0);
        total.cache_read_tokens += Number(event.cache_read_tokens || 0);
        total.cache_write_tokens += Number(event.cache_write_tokens || 0);
        total.output_tokens += Number(event.output_tokens || 0);
        total.reasoning_tokens += Number(event.reasoning_tokens || 0);
      }
      return {
        tokens: tokensDto(total),
        accountingMode: 'claude-main-aggregate',
        breakdownMayOverlapTotal: true,
      };
    }

    function getRunUsage(runIdValue) {
      const run = requireRun(requiredString(runIdValue, 'runId'));
      const observed = run.observed_event_count;
      const unobservable = run.unobservable_event_count;
      const accounting = usageAccountingForRun(run);
      return {
        runId: run.run_id,
        taskId: run.task_id,
        executionStatus: run.execution_status,
        usageStatus: run.usage_status,
        revision: run.usage_revision,
        sealedRevision: run.sealed_revision == null ? null : run.sealed_revision,
        coverage: coverageFor(observed, unobservable),
        hasKnownUsage: observed > 0,
        isLowerBound: observed > 0 && unobservable > 0,
        observedEvents: observed,
        unobservableEvents: unobservable,
        tokens: accounting.tokens,
        accountingMode: accounting.accountingMode,
        breakdownMayOverlapTotal: accounting.breakdownMayOverlapTotal,
        dimensions: db.prepare(`
          SELECT * FROM task_run_usage_dimensions WHERE run_id=?
          ORDER BY provider_id, model, role_kind, route_name
        `).all(run.run_id).map(mapDimension),
      };
    }

    function getTaskUsage(taskIdValue) {
      ensureOpen();
      const taskId = requiredString(taskIdValue, 'taskId');
      const runs = db.prepare('SELECT * FROM task_runs WHERE task_id=?').all(taskId);
      const accountings = runs.map(usageAccountingForRun);
      const aggregate = db.prepare(`
        SELECT COUNT(*) AS run_count,
          COALESCE(SUM(fresh_input_tokens), 0) AS fresh_input_tokens,
          COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
          COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
          COALESCE(SUM(observed_event_count), 0) AS observed_event_count,
          COALESCE(SUM(unobservable_event_count), 0) AS unobservable_event_count
        FROM task_runs WHERE task_id=?
      `).get(taskId);
      const statusRows = db.prepare(`
        SELECT execution_status, COUNT(*) AS count FROM task_runs
        WHERE task_id=? GROUP BY execution_status ORDER BY execution_status
      `).all(taskId);
      const dimensionRows = db.prepare(`
        SELECT d.provider_id, MAX(d.provider_name) AS provider_name, d.model,
          d.role_kind, d.route_name,
          SUM(d.fresh_input_tokens) AS fresh_input_tokens,
          SUM(d.cache_read_tokens) AS cache_read_tokens,
          SUM(d.cache_write_tokens) AS cache_write_tokens,
          SUM(d.output_tokens) AS output_tokens,
          SUM(d.reasoning_tokens) AS reasoning_tokens,
          SUM(d.observed_event_count) AS observed_event_count,
          SUM(d.unobservable_event_count) AS unobservable_event_count
        FROM task_run_usage_dimensions d
        JOIN task_runs r ON r.run_id=d.run_id
        WHERE r.task_id=?
        GROUP BY d.provider_id, d.model, d.role_kind, d.route_name
        ORDER BY d.provider_id, d.model, d.role_kind, d.route_name
      `).all(taskId);
      const observed = Number(aggregate.observed_event_count || 0);
      const unobservable = Number(aggregate.unobservable_event_count || 0);
      const tokenAggregate = {
        fresh_input_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
      };
      for (const accounting of accountings) {
        tokenAggregate.fresh_input_tokens += accounting.tokens.freshInput;
        tokenAggregate.cache_read_tokens += accounting.tokens.cacheRead;
        tokenAggregate.cache_write_tokens += accounting.tokens.cacheWrite;
        tokenAggregate.output_tokens += accounting.tokens.output;
        tokenAggregate.reasoning_tokens += accounting.tokens.reasoning;
      }
      const modes = new Set(accountings.map(accounting => accounting.accountingMode));
      const accountingMode = modes.size <= 1
        ? (modes.values().next().value || 'additive')
        : 'mixed';
      return {
        taskId,
        runCount: Number(aggregate.run_count || 0),
        executionStatuses: Object.fromEntries(statusRows.map(row => [row.execution_status, row.count])),
        coverage: coverageFor(observed, unobservable),
        hasKnownUsage: observed > 0,
        isLowerBound: observed > 0 && unobservable > 0,
        observedEvents: observed,
        unobservableEvents: unobservable,
        tokens: tokensDto(tokenAggregate),
        accountingMode,
        breakdownMayOverlapTotal: accountings.some(accounting => accounting.breakdownMayOverlapTotal),
        dimensions: dimensionRows.map(mapDimension),
      };
    }

    function close() {
      if (closed) return;
      try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) { /* best effort */ }
      db.close();
      closed = true;
      chmodPrivate(fsImpl, file);
    }

    return Object.freeze({
      file,
      settings,
      beginRun,
      admitRun,
      bindRunSlot,
      acquireSlotLease,
      markSlotLeaseReady,
      releaseSlotLease,
      quarantineSlotLease,
      quarantineUnleasedRun,
      getSlotLease,
      listSlotLeases,
      planSlotLeaseRecovery,
      saveCleanupManifest,
      getCleanupManifest,
      appendMessage,
      observeUsage,
      sealUsage,
      getCleanupPermit,
      markCleanup,
      getRun,
      listTaskRuns,
      getRunMessages,
      reserveAnswerReceipt,
      markAnswerAccepted,
      getAnswerReceipt,
      listTaskArtifacts,
      listPinnedArtifactIds,
      getRunUsage,
      getTaskUsage,
      close,
    });
  } catch (cause) {
    if (db) {
      try { db.close(); } catch (_) { /* best effort */ }
    }
    if (cause instanceof TaskRunStoreError) throw cause;
    throw new TaskRunStoreError(`cannot open task-run store: ${cause.message}`, 'TASK_RUN_STORE_OPEN_FAILED', { cause });
  }
}

const open = createTaskRunStore;

module.exports = {
  SCHEMA_VERSION,
  TaskRunStoreError,
  createTaskRunStore,
  extractArtifactReferences,
  open,
};
