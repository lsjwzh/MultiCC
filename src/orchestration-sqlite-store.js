'use strict';

// SQLite-backed orchestration state.
//
// The JSON store deliberately commits one whole snapshot. That was a useful
// first durability boundary, but at scale every tiny lease/status transition
// paid for cloning, parsing and serialising the entire registry. This backend
// keeps the same immutable read/mutate contract while persisting one bounded
// domain record per row in a single SQLite transaction.

const crypto = require('crypto');
const nodeFs = require('fs');
const nodePath = require('path');
const {
  SCHEMA_VERSION,
  OrchestrationStoreCorruptError,
  _cloneJson: cloneJson,
  _deepFreeze: deepFreeze,
  _initialState: initialState,
  _loadState: loadLegacyState,
  _validateState: validateState,
  _writeAtomic: writeLegacyAtomic,
} = require('./orchestration-store');

const DATABASE_SCHEMA_VERSION = 1;
const COLLECTIONS = Object.freeze([
  'waits',
  'outbox',
  'operations',
  'tasks',
  'sessionSchedules',
]);
const RESERVED_TOP_LEVEL = new Set([
  'schemaVersion',
  'revision',
  'updatedAt',
  'nextOutboxSequence',
  ...COLLECTIONS,
]);

const TABLES = Object.freeze({
  waits: 'orchestration_waits',
  outbox: 'orchestration_outbox',
  operations: 'orchestration_operations',
  tasks: 'orchestration_tasks',
  sessionSchedules: 'orchestration_session_schedules',
});
const REQUIRED_TABLE_COLUMNS = Object.freeze({
  orchestration_meta: ['key', 'value_json'],
  orchestration_extras: ['key', 'data_json'],
  orchestration_waits: ['id', 'data_json', 'session_id', 'status', 'next_at', 'updated_at'],
  orchestration_outbox: [
    'id', 'data_json', 'session_id', 'state', 'sequence', 'available_at', 'leased_until', 'updated_at',
  ],
  orchestration_operations: ['id', 'data_json', 'kind', 'owner_session_id', 'status', 'updated_at'],
  orchestration_tasks: ['id', 'data_json', 'parent_session_id', 'status', 'updated_at'],
  orchestration_session_schedules: ['session_id', 'data_json', 'state', 'updated_at'],
});
const REQUIRED_INDEXES = Object.freeze({
  idx_orchestration_waits_due: { table: 'orchestration_waits', columns: ['status', 'next_at'] },
  idx_orchestration_waits_session: { table: 'orchestration_waits', columns: ['session_id', 'status'] },
  idx_orchestration_outbox_sequence: {
    table: 'orchestration_outbox', columns: ['sequence'], unique: true,
  },
  idx_orchestration_outbox_due: {
    table: 'orchestration_outbox', columns: ['state', 'available_at', 'sequence'],
  },
  idx_orchestration_outbox_session: {
    table: 'orchestration_outbox', columns: ['session_id', 'state', 'sequence'],
  },
  idx_orchestration_operations_owner: {
    table: 'orchestration_operations', columns: ['owner_session_id', 'status', 'kind'],
  },
  idx_orchestration_tasks_parent: {
    table: 'orchestration_tasks', columns: ['parent_session_id', 'status'],
  },
  idx_orchestration_schedules_state: {
    table: 'orchestration_session_schedules', columns: ['state', 'updated_at'],
  },
});

class OrchestrationSqliteError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'OrchestrationSqliteError';
    this.code = 'ORCHESTRATION_SQLITE_ERROR';
    Object.assign(this, meta);
  }
}

class OrchestrationSqliteConflictError extends OrchestrationSqliteError {
  constructor(file, expectedRevision, actualRevision) {
    super(
      `orchestration SQLite revision changed concurrently in ${file} (expected ${expectedRevision}, found ${actualRevision})`,
      { file, expectedRevision, actualRevision },
    );
    this.name = 'OrchestrationSqliteConflictError';
    this.code = 'ORCHESTRATION_SQLITE_CONFLICT';
    this.retryable = true;
  }
}

function loadDatabaseConstructor(requireFn = require) {
  try {
    return requireFn('better-sqlite3');
  } catch (cause) {
    throw new OrchestrationSqliteError(
      'better-sqlite3 is unavailable; run npm install (or npm rebuild better-sqlite3 --foreground-scripts)',
      { cause },
    );
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = stableValue(value[key]);
  return result;
}

function stateDigest(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function chmodPrivate(fsImpl, file) {
  fsImpl.chmodSync(file, 0o600);
  for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
    try { fsImpl.chmodSync(sidecar, 0o600); } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
}

function fsyncDirectory(fsImpl, pathImpl, dir) {
  let fd;
  try {
    fd = fsImpl.openSync(dir, (fsImpl.constants || nodeFs.constants).O_RDONLY);
    try { fsImpl.fsyncSync(fd); } catch (error) {
      if (!error || !['ENOTSUP', 'EINVAL', 'EBADF'].includes(error.code)) throw error;
    }
  } catch (error) {
    if (!error || !['EISDIR', 'EPERM', 'EINVAL', 'EBADF'].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch (_) { /* best effort */ }
    }
  }
}

function createSchema(db) {
  db.exec(`
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
  `);
}

function setMeta(db, key, value) {
  db.prepare(`
    INSERT INTO orchestration_meta(key, value_json) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `).run(key, JSON.stringify(value));
}

function readMeta(db, key) {
  const row = db.prepare('SELECT value_json FROM orchestration_meta WHERE key = ?').get(key);
  if (!row) return undefined;
  try { return JSON.parse(row.value_json); } catch (cause) {
    throw new OrchestrationStoreCorruptError(`invalid SQLite orchestration metadata: ${key}`, { cause });
  }
}

function recordColumns(collection, record) {
  switch (collection) {
    case 'waits':
      return [record.sessionId ?? null, record.status ?? null,
        record.metadata?.nextAt ?? record.metadata?.dueAt ?? record.metadata?.expireAt ?? null,
        record.updatedAt ?? null];
    case 'outbox':
      return [record.sessionId ?? null, record.state ?? null, record.sequence ?? null,
        record.availableAt ?? null, record.leasedUntil ?? null, record.updatedAt ?? null];
    case 'operations':
      return [record.kind ?? null, record.ownerSessionId ?? null,
        record.status ?? null, record.updatedAt ?? null];
    case 'tasks':
      return [record.parentSessionId ?? null, record.status ?? null, record.updatedAt ?? null];
    case 'sessionSchedules':
      return [record.state ?? null, record.updatedAt ?? null];
    default:
      throw new TypeError(`unsupported orchestration collection: ${collection}`);
  }
}

function prepareStatements(db) {
  return {
    upsert: {
      waits: db.prepare(`
        INSERT INTO orchestration_waits(id, data_json, session_id, status, next_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,
          session_id=excluded.session_id, status=excluded.status,
          next_at=excluded.next_at, updated_at=excluded.updated_at
      `),
      outbox: db.prepare(`
        INSERT INTO orchestration_outbox
          (id, data_json, session_id, state, sequence, available_at, leased_until, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,
          session_id=excluded.session_id, state=excluded.state,
          sequence=excluded.sequence, available_at=excluded.available_at,
          leased_until=excluded.leased_until, updated_at=excluded.updated_at
      `),
      operations: db.prepare(`
        INSERT INTO orchestration_operations
          (id, data_json, kind, owner_session_id, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,
          kind=excluded.kind, owner_session_id=excluded.owner_session_id,
          status=excluded.status, updated_at=excluded.updated_at
      `),
      tasks: db.prepare(`
        INSERT INTO orchestration_tasks(id, data_json, parent_session_id, status, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,
          parent_session_id=excluded.parent_session_id, status=excluded.status,
          updated_at=excluded.updated_at
      `),
      sessionSchedules: db.prepare(`
        INSERT INTO orchestration_session_schedules(session_id, data_json, state, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET data_json=excluded.data_json,
          state=excluded.state, updated_at=excluded.updated_at
      `),
    },
    remove: Object.fromEntries(COLLECTIONS.map(collection => [
      collection,
      db.prepare(`DELETE FROM ${TABLES[collection]} WHERE ${collection === 'sessionSchedules' ? 'session_id' : 'id'} = ?`),
    ])),
    upsertExtra: db.prepare(`
      INSERT INTO orchestration_extras(key, data_json) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET data_json=excluded.data_json
    `),
    removeExtra: db.prepare('DELETE FROM orchestration_extras WHERE key = ?'),
  };
}

function writeRecord(statements, collection, key, record) {
  const json = JSON.stringify(record);
  statements.upsert[collection].run(key, json, ...recordColumns(collection, record));
  return Buffer.byteLength(json);
}

function importState(db, state, { sourceDigest = null, migratedAt = 0 } = {}) {
  const statements = prepareStatements(db);
  const transaction = db.transaction(() => {
    for (const collection of COLLECTIONS) {
      for (const [key, record] of Object.entries(state[collection])) {
        writeRecord(statements, collection, key, record);
      }
    }
    for (const [key, value] of Object.entries(state)) {
      if (RESERVED_TOP_LEVEL.has(key)) continue;
      statements.upsertExtra.run(key, JSON.stringify(value));
    }
    setMeta(db, 'databaseSchemaVersion', DATABASE_SCHEMA_VERSION);
    setMeta(db, 'stateSchemaVersion', state.schemaVersion);
    setMeta(db, 'revision', state.revision);
    setMeta(db, 'updatedAt', state.updatedAt);
    setMeta(db, 'nextOutboxSequence', state.nextOutboxSequence);
    if (sourceDigest) setMeta(db, 'legacySourceDigest', sourceDigest);
    if (sourceDigest) setMeta(db, 'legacyMigratedAt', migratedAt);
  });
  transaction.immediate();
}

function parseRow(row, file, collection) {
  try { return JSON.parse(row.data_json); } catch (cause) {
    throw new OrchestrationStoreCorruptError(
      `invalid ${collection} row ${row.record_key} in ${file}`,
      { file, collection, key: row.record_key, cause },
    );
  }
}

function loadDatabaseState(db, file) {
  const databaseSchemaVersion = readMeta(db, 'databaseSchemaVersion');
  if (databaseSchemaVersion !== DATABASE_SCHEMA_VERSION) {
    throw new OrchestrationStoreCorruptError(
      `unsupported orchestration SQLite schema in ${file}: ${databaseSchemaVersion}`,
      { file },
    );
  }
  const state = initialState();
  state.schemaVersion = readMeta(db, 'stateSchemaVersion');
  state.revision = readMeta(db, 'revision');
  state.updatedAt = readMeta(db, 'updatedAt');
  state.nextOutboxSequence = readMeta(db, 'nextOutboxSequence');

  for (const collection of COLLECTIONS) {
    const keyColumn = collection === 'sessionSchedules' ? 'session_id' : 'id';
    const rows = db.prepare(
      `SELECT ${keyColumn} AS record_key, data_json FROM ${TABLES[collection]} ORDER BY ${keyColumn}`,
    ).all();
    for (const row of rows) state[collection][row.record_key] = parseRow(row, file, collection);
  }
  for (const row of db.prepare(
    'SELECT key AS record_key, data_json FROM orchestration_extras ORDER BY key',
  ).all()) {
    state[row.record_key] = parseRow(row, file, 'extras');
  }
  return validateState(state, file);
}

function checkDatabase(db, file) {
  const row = db.prepare('PRAGMA quick_check').get();
  const value = row && Object.values(row)[0];
  if (value !== 'ok') {
    throw new OrchestrationStoreCorruptError(
      `SQLite quick_check failed for ${file}: ${String(value || 'unknown')}`,
      { file },
    );
  }
}

function validateDatabaseSchema(db, file) {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_%'",
  ).all();
  const present = new Set(rows.map(row => row.name));
  for (const [table, requiredColumns] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
    if (!present.has(table)) {
      throw new OrchestrationStoreCorruptError(
        `orchestration SQLite table is missing in ${file}: ${table}`,
        { file, table },
      );
    }
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const missing = requiredColumns.filter(column => !columns.has(column));
    if (missing.length) {
      throw new OrchestrationStoreCorruptError(
        `orchestration SQLite columns are missing in ${file}: ${table}.${missing.join(',')}`,
        { file, table, missingColumns: missing },
      );
    }
  }
  for (const [index, requirement] of Object.entries(REQUIRED_INDEXES)) {
    const listed = db.prepare(`PRAGMA index_list(${requirement.table})`).all()
      .find(row => row.name === index);
    const columns = listed
      ? db.prepare(`PRAGMA index_info(${index})`).all().map(row => row.name)
      : [];
    if (!listed
        || !!listed.unique !== !!requirement.unique
        || columns.join('\u0000') !== requirement.columns.join('\u0000')) {
      throw new OrchestrationStoreCorruptError(
        `orchestration SQLite index is missing or invalid in ${file}: ${index}`,
        { file, index },
      );
    }
  }
}

function createDatabaseFile({
  Database,
  file,
  legacyFile,
  fsImpl,
  pathImpl,
  now,
}) {
  const dir = pathImpl.dirname(file);
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.migrating.${process.pid}.${Number(now())}.${crypto.randomBytes(4).toString('hex')}`;
  let db;
  try {
    db = new Database(temp);
    // Tighten permissions before any legacy payload is imported. Relying on
    // the caller's umask would leave a sensitive-data exposure window.
    fsImpl.chmodSync(temp, 0o600);
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = FULL');
    createSchema(db);

    const legacyPresent = !!legacyFile && fsImpl.existsSync(legacyFile);
    const state = legacyPresent
      ? loadLegacyState({ fsImpl, file: legacyFile })
      : initialState();
    const digest = legacyPresent ? stateDigest(state) : null;
    importState(db, state, { sourceDigest: digest, migratedAt: Number(now()) });
    checkDatabase(db, temp);
    const reconstructed = loadDatabaseState(db, temp);
    if (stateDigest(reconstructed) !== stateDigest(state)) {
      throw new OrchestrationSqliteError(
        `orchestration migration verification failed for ${legacyFile || file}`,
        { file, legacyFile },
      );
    }
    db.close();
    db = null;
    fsImpl.chmodSync(temp, 0o600);
    fsImpl.renameSync(temp, file);
    fsyncDirectory(fsImpl, pathImpl, dir);
    return { migrated: legacyPresent, legacyDigest: digest };
  } catch (cause) {
    if (db) {
      try { db.close(); } catch (_) { /* best effort */ }
    }
    try { fsImpl.unlinkSync(temp); } catch (_) { /* absent after successful rename */ }
    try { fsImpl.unlinkSync(`${temp}-journal`); } catch (_) { /* best effort */ }
    try { fsImpl.unlinkSync(`${temp}-wal`); } catch (_) { /* best effort */ }
    try { fsImpl.unlinkSync(`${temp}-shm`); } catch (_) { /* best effort */ }
    throw cause instanceof OrchestrationStoreCorruptError
      || cause instanceof OrchestrationSqliteError
      ? cause
      : new OrchestrationSqliteError(`cannot create orchestration database ${file}: ${cause.message}`, {
        file, legacyFile, cause,
      });
  }
}

function openDatabase({ Database, file, fsImpl }) {
  let db;
  try {
    chmodPrivate(fsImpl, file);
    db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('secure_delete = ON');
    db.pragma('busy_timeout = 4000');
    db.pragma('wal_autocheckpoint = 1000');
    db.pragma('journal_size_limit = 0');
    checkDatabase(db, file);
    validateDatabaseSchema(db, file);
    chmodPrivate(fsImpl, file);
    return db;
  } catch (cause) {
    if (db) {
      try { db.close(); } catch (_) { /* best effort */ }
    }
    throw cause instanceof OrchestrationStoreCorruptError
      ? cause
      : new OrchestrationSqliteError(`cannot open orchestration database ${file}: ${cause.message}`, {
        file, cause,
      });
  }
}

function currentAtPath(root, path) {
  let value = root;
  for (const part of path) {
    if (!isObject(value)) return undefined;
    value = value[part];
  }
  return value;
}

function jsonEqual(a, b) {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

// Copy-on-write compatibility layer for the existing domain services. Reads
// traverse the frozen snapshot without cloning. The first write to a record
// clones only that record; finish() then reports exactly which rows changed.
function createDraft(base) {
  const recordChanges = Object.fromEntries(COLLECTIONS.map(name => [name, new Map()]));
  const extraChanges = new Map();
  const topChanges = new Map();
  const collectionProxies = new Map();
  const pathProxies = new Map();
  const extraPathProxies = new Map();
  const ownedProxies = new WeakSet();
  let active = true;

  function assertActive() {
    if (!active) throw new TypeError('orchestration draft is no longer active');
  }

  function assignedValue(value) {
    // Preserve ordinary raw-object aliasing inside one transaction: several
    // domain mutators insert a record and then continue editing that same raw
    // object. A draft proxy, however, must be materialised so no proxy becomes
    // part of committed state.
    return isObject(value) && ownedProxies.has(value) ? cloneJson(value) : value;
  }

  function recordValue(collection, key) {
    const entry = recordChanges[collection].get(key);
    if (entry) return entry.deleted ? undefined : entry.value;
    return base[collection][key];
  }

  function ensureRecordCopy(collection, key) {
    const existing = recordChanges[collection].get(key);
    if (existing && !existing.deleted) return existing.value;
    const current = existing?.deleted ? undefined : base[collection][key];
    if (!isObject(current)) throw new TypeError(`cannot mutate missing ${collection} record ${key}`);
    const value = cloneJson(current);
    recordChanges[collection].set(key, { deleted: false, value });
    return value;
  }

  function pathProxy(collection, key, path = []) {
    const cacheKey = `${collection}\u0000${key}\u0000${path.map(String).join('\u0000')}`;
    if (pathProxies.has(cacheKey)) return pathProxies.get(cacheKey);
    const initial = currentAtPath(recordValue(collection, key), path);
    const target = Array.isArray(initial) ? new Array(initial.length) : {};
    const proxy = new Proxy(target, {
      get(_target, prop, receiver) {
        const current = currentAtPath(recordValue(collection, key), path);
        if (!isObject(current)) return undefined;
        const value = Reflect.get(current, prop, receiver);
        return isObject(value) ? pathProxy(collection, key, [...path, prop]) : value;
      },
      set(_target, prop, value) {
        assertActive();
        const copy = ensureRecordCopy(collection, key);
        const container = currentAtPath(copy, path);
        if (!isObject(container)) return false;
        const written = Reflect.set(container, prop, assignedValue(value));
        if (written && Array.isArray(target)) target.length = container.length;
        return written;
      },
      deleteProperty(_target, prop) {
        assertActive();
        const copy = ensureRecordCopy(collection, key);
        const container = currentAtPath(copy, path);
        return isObject(container) ? Reflect.deleteProperty(container, prop) : true;
      },
      has(_target, prop) {
        const current = currentAtPath(recordValue(collection, key), path);
        return isObject(current) && prop in current;
      },
      ownKeys() {
        const current = currentAtPath(recordValue(collection, key), path);
        return isObject(current) ? Reflect.ownKeys(current) : [];
      },
      getOwnPropertyDescriptor(_target, prop) {
        const current = currentAtPath(recordValue(collection, key), path);
        if (!isObject(current)) return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(current, prop);
        if (!descriptor) return undefined;
        if (Array.isArray(target) && prop === 'length') {
          target.length = current.length;
          return Object.getOwnPropertyDescriptor(target, 'length');
        }
        return { ...descriptor, configurable: true };
      },
      getPrototypeOf() {
        const current = currentAtPath(recordValue(collection, key), path);
        return isObject(current) ? Reflect.getPrototypeOf(current) : Object.prototype;
      },
    });
    ownedProxies.add(proxy);
    pathProxies.set(cacheKey, proxy);
    return proxy;
  }

  function collectionProxy(collection) {
    if (collectionProxies.has(collection)) return collectionProxies.get(collection);
    const proxy = new Proxy({}, {
      get(_target, prop) {
        if (typeof prop === 'symbol') return base[collection][prop];
        const value = recordValue(collection, String(prop));
        return isObject(value) ? pathProxy(collection, String(prop)) : value;
      },
      set(_target, prop, value) {
        assertActive();
        recordChanges[collection].set(String(prop), {
          deleted: false,
          value: assignedValue(value),
        });
        return true;
      },
      deleteProperty(_target, prop) {
        assertActive();
        recordChanges[collection].set(String(prop), { deleted: true });
        return true;
      },
      has(_target, prop) {
        return recordValue(collection, String(prop)) !== undefined;
      },
      ownKeys() {
        const keys = new Set(Object.keys(base[collection]));
        for (const [key, entry] of recordChanges[collection]) {
          if (entry.deleted) keys.delete(key); else keys.add(key);
        }
        return [...keys];
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (recordValue(collection, String(prop)) === undefined) return undefined;
        return { configurable: true, enumerable: true, writable: true, value: undefined };
      },
    });
    ownedProxies.add(proxy);
    collectionProxies.set(collection, proxy);
    return proxy;
  }

  function extraValue(key) {
    const entry = extraChanges.get(key);
    if (entry) return entry.deleted ? undefined : entry.value;
    return base[key];
  }

  function ensureExtraCopy(key) {
    const entry = extraChanges.get(key);
    if (entry && !entry.deleted) return entry.value;
    const current = entry?.deleted ? undefined : base[key];
    if (!isObject(current)) throw new TypeError(`cannot mutate missing orchestration extra ${key}`);
    const value = cloneJson(current);
    extraChanges.set(key, { deleted: false, value });
    return value;
  }

  function extraPathProxy(key, path = []) {
    const cacheKey = `${key}\u0000${path.map(String).join('\u0000')}`;
    if (extraPathProxies.has(cacheKey)) return extraPathProxies.get(cacheKey);
    const initial = currentAtPath(extraValue(key), path);
    const target = Array.isArray(initial) ? new Array(initial.length) : {};
    const proxy = new Proxy(target, {
      get(_target, prop, receiver) {
        const current = currentAtPath(extraValue(key), path);
        if (!isObject(current)) return undefined;
        const value = Reflect.get(current, prop, receiver);
        return isObject(value) ? extraPathProxy(key, [...path, prop]) : value;
      },
      set(_target, prop, value) {
        assertActive();
        const container = currentAtPath(ensureExtraCopy(key), path);
        if (!isObject(container)) return false;
        const written = Reflect.set(container, prop, assignedValue(value));
        if (written && Array.isArray(target)) target.length = container.length;
        return written;
      },
      deleteProperty(_target, prop) {
        assertActive();
        const container = currentAtPath(ensureExtraCopy(key), path);
        return isObject(container) ? Reflect.deleteProperty(container, prop) : true;
      },
      has(_target, prop) {
        const current = currentAtPath(extraValue(key), path);
        return isObject(current) && prop in current;
      },
      ownKeys() {
        const current = currentAtPath(extraValue(key), path);
        return isObject(current) ? Reflect.ownKeys(current) : [];
      },
      getOwnPropertyDescriptor(_target, prop) {
        const current = currentAtPath(extraValue(key), path);
        if (!isObject(current)) return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(current, prop);
        if (!descriptor) return undefined;
        if (Array.isArray(target) && prop === 'length') {
          target.length = current.length;
          return Object.getOwnPropertyDescriptor(target, 'length');
        }
        return { ...descriptor, configurable: true };
      },
      getPrototypeOf() {
        const current = currentAtPath(extraValue(key), path);
        return isObject(current) ? Reflect.getPrototypeOf(current) : Object.prototype;
      },
    });
    ownedProxies.add(proxy);
    extraPathProxies.set(cacheKey, proxy);
    return proxy;
  }

  function topValue(prop) {
    if (topChanges.has(prop)) return topChanges.get(prop).deleted
      ? undefined : topChanges.get(prop).value;
    if (extraChanges.has(prop)) return extraChanges.get(prop).deleted
      ? undefined : extraChanges.get(prop).value;
    return base[prop];
  }

  const draft = new Proxy({}, {
    get(_target, prop) {
      if (COLLECTIONS.includes(prop)) return collectionProxy(prop);
      const value = topValue(prop);
      return !RESERVED_TOP_LEVEL.has(String(prop)) && isObject(value)
        ? extraPathProxy(String(prop))
        : value;
    },
    set(_target, prop, value) {
      assertActive();
      const key = String(prop);
      if (COLLECTIONS.includes(key)) throw new TypeError(`cannot replace orchestration collection ${key}`);
      const target = RESERVED_TOP_LEVEL.has(key) ? topChanges : extraChanges;
      target.set(key, { deleted: false, value: assignedValue(value) });
      return true;
    },
    deleteProperty(_target, prop) {
      assertActive();
      const key = String(prop);
      if (RESERVED_TOP_LEVEL.has(key)) throw new TypeError(`cannot delete orchestration field ${key}`);
      extraChanges.set(key, { deleted: true });
      return true;
    },
    has(_target, prop) {
      if (COLLECTIONS.includes(prop)) return true;
      return topValue(prop) !== undefined;
    },
    ownKeys() {
      const keys = new Set(Reflect.ownKeys(base));
      for (const [key, entry] of extraChanges) {
        if (entry.deleted) keys.delete(key); else keys.add(key);
      }
      return [...keys];
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (!(prop in draft)) return undefined;
      return { configurable: true, enumerable: true, writable: true, value: undefined };
    },
  });
  ownedProxies.add(draft);

  function containsOwnedProxy(value, seen = new WeakSet()) {
    if (!isObject(value)) return false;
    if (ownedProxies.has(value)) return true;
    if (seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).some(child => containsOwnedProxy(child, seen));
  }

  function finish({ now }) {
    const next = { ...base };
    const persisted = {
      collections: Object.fromEntries(COLLECTIONS.map(name => [name, new Map()])),
      extras: new Map(),
    };
    let changed = false;

    for (const collection of COLLECTIONS) {
      let nextCollection = base[collection];
      for (const [key, entry] of recordChanges[collection]) {
        const before = base[collection][key];
        if (entry.deleted ? before === undefined : jsonEqual(before, entry.value)) continue;
        if (nextCollection === base[collection]) nextCollection = { ...base[collection] };
        if (entry.deleted) delete nextCollection[key];
        else nextCollection[key] = entry.value;
        persisted.collections[collection].set(key, entry.deleted
          ? { deleted: true, before }
          : { deleted: false, before, value: nextCollection[key] });
        changed = true;
      }
      next[collection] = nextCollection;
    }

    for (const [key, entry] of extraChanges) {
      const before = base[key];
      if (entry.deleted ? before === undefined : jsonEqual(before, entry.value)) continue;
      if (entry.deleted) delete next[key]; else next[key] = entry.value;
      persisted.extras.set(key, entry.deleted
        ? { deleted: true, before }
        : { deleted: false, before, value: next[key] });
      changed = true;
    }

    const requestedSchema = topChanges.get('schemaVersion');
    if (requestedSchema && requestedSchema.value !== SCHEMA_VERSION) {
      throw new OrchestrationStoreCorruptError('mutation attempted to change orchestration schemaVersion');
    }
    const nextSequence = topChanges.has('nextOutboxSequence')
      ? topChanges.get('nextOutboxSequence').value
      : base.nextOutboxSequence;
    if (nextSequence !== base.nextOutboxSequence) changed = true;
    next.nextOutboxSequence = nextSequence;

    if (!changed) {
      active = false;
      return { changed: false, state: base, expectedRevision: base.revision, persisted };
    }
    next.schemaVersion = SCHEMA_VERSION;
    next.revision = base.revision + 1;
    next.updatedAt = Number(now());
    validateState(next, '<orchestration-sqlite-draft>');
    const committed = deepFreeze(next);
    active = false;
    return { changed: true, state: committed, expectedRevision: base.revision, persisted };
  }

  return { draft, finish, containsOwnedProxy };
}

function createOrchestrationSqliteStore({
  file,
  legacyFile = null,
  fsImpl = nodeFs,
  pathImpl = nodePath,
  now = Date.now,
  requireFn = require,
  Database: DatabaseOverride = null,
  hooks = {},
} = {}) {
  if (!file || typeof file !== 'string') {
    throw new TypeError('[orchestration-sqlite-store] create requires an injected { file }');
  }
  if (typeof now !== 'function') throw new TypeError('[orchestration-sqlite-store] now must be a function');
  const Database = DatabaseOverride || loadDatabaseConstructor(requireFn);
  let migration = { migrated: false, legacyDigest: null };
  const migrationStartedAt = process.hrtime.bigint();
  if (!fsImpl.existsSync(file)) {
    migration = createDatabaseFile({ Database, file, legacyFile, fsImpl, pathImpl, now });
  }
  const migrationDurationMs = Number(process.hrtime.bigint() - migrationStartedAt) / 1e6;

  let db = openDatabase({ Database, file, fsImpl });
  let statements = prepareStatements(db);
  let state = deepFreeze(loadDatabaseState(db, file));
  let tail = Promise.resolve();
  let closed = false;
  const counters = {
    mutations: 0,
    noops: 0,
    conflicts: 0,
    dirtyRows: 0,
    serializedBytes: 0,
    redactionCheckpoints: 0,
    commitDurationMs: 0,
    maxCommitDurationMs: 0,
    migrationDurationMs,
  };

  function ensureOpen() {
    if (closed || !db) throw new OrchestrationSqliteError(`orchestration database is closed: ${file}`, { file });
  }

  function enqueue(operation) {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  function persist(change) {
    const startedAt = process.hrtime.bigint();
    let dirtyRows = 0;
    let serializedBytes = 0;
    const transaction = db.transaction(() => {
      const actualRevision = readMeta(db, 'revision');
      if (actualRevision !== change.expectedRevision) {
        throw new OrchestrationSqliteConflictError(
          file,
          change.expectedRevision,
          actualRevision,
        );
      }
      for (const collection of COLLECTIONS) {
        for (const [key, entry] of change.persisted.collections[collection]) {
          dirtyRows += 1;
          if (entry.deleted) statements.remove[collection].run(key);
          else serializedBytes += writeRecord(statements, collection, key, entry.value);
        }
      }
      for (const [key, entry] of change.persisted.extras) {
        dirtyRows += 1;
        if (entry.deleted) statements.removeExtra.run(key);
        else {
          const json = JSON.stringify(entry.value);
          serializedBytes += Buffer.byteLength(json);
          statements.upsertExtra.run(key, json);
        }
      }
      setMeta(db, 'revision', change.state.revision);
      setMeta(db, 'updatedAt', change.state.updatedAt);
      setMeta(db, 'nextOutboxSequence', change.state.nextOutboxSequence);
      if (typeof hooks.beforeCommit === 'function') hooks.beforeCommit({ file, change });
    });
    transaction.immediate();
    const redacted = ['outbox', 'operations'].some(collection => (
      [...change.persisted.collections[collection].values()].some(entry => {
        if (entry.deleted || !entry.value || !entry.before) return false;
        const before = collection === 'outbox' ? entry.before.payload : entry.before.spec;
        const after = collection === 'outbox' ? entry.value.payload : entry.value.spec;
        if (!after?.messageRef) return false;
        return ['message', 'taskText'].some(key => (
          Object.prototype.hasOwnProperty.call(before || {}, key)
          && !Object.prototype.hasOwnProperty.call(after, key)
        ));
      })
    ));
    // Dispatch/user task bodies are intentionally scrubbed after canonical
    // chat persistence. Secure-delete plus a truncating checkpoint prevents an
    // obsolete WAL frame from retaining the removed body indefinitely.
    if (redacted) {
      db.pragma('wal_checkpoint(TRUNCATE)');
      counters.redactionCheckpoints += 1;
      if (typeof hooks.afterRedactionCheckpoint === 'function') {
        hooks.afterRedactionCheckpoint({ file, change });
      }
    }
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    counters.mutations += 1;
    counters.dirtyRows += dirtyRows;
    counters.serializedBytes += serializedBytes;
    counters.commitDurationMs += durationMs;
    counters.maxCommitDurationMs = Math.max(counters.maxCommitDurationMs, durationMs);
    if (typeof hooks.afterCommit === 'function') hooks.afterCommit({ file, change });
  }

  async function applyMutation(mutator) {
    ensureOpen();
    const cow = createDraft(state);
    const rawResult = await mutator(cow.draft);
    const resultUsesDraft = cow.containsOwnedProxy(rawResult);
    const result = resultUsesDraft ? cloneJson(rawResult) : rawResult;
    const change = cow.finish({ now });
    if (!change.changed) {
      counters.noops += 1;
      return resultUsesDraft ? deepFreeze(result) : result;
    }
    try {
      persist(change);
      state = change.state;
      chmodPrivate(fsImpl, file);
    } catch (cause) {
      if (cause?.code === 'ORCHESTRATION_SQLITE_CONFLICT') counters.conflicts += 1;
      // A beforeCommit failure rolls back. An afterCommit failure means the
      // transaction landed but the caller did not observe success. Reloading
      // covers both crash windows and keeps subsequent retries coherent.
      state = deepFreeze(loadDatabaseState(db, file));
      throw cause;
    }
    return resultUsesDraft ? deepFreeze(result) : result;
  }

  function mutate(mutator) {
    if (typeof mutator !== 'function') {
      throw new TypeError('[orchestration-sqlite-store] mutate requires a function');
    }
    return enqueue(() => applyMutation(mutator));
  }

  function mutateIf(predicate, mutator, skippedResult) {
    if (typeof predicate !== 'function' || typeof mutator !== 'function') {
      throw new TypeError('[orchestration-sqlite-store] mutateIf requires predicate and mutator functions');
    }
    return enqueue(async () => {
      ensureOpen();
      if (!predicate(state)) {
        const skipped = typeof skippedResult === 'function' ? skippedResult() : skippedResult;
        return deepFreeze(cloneJson(skipped));
      }
      return applyMutation(mutator);
    });
  }

  function read(selector) {
    if (selector !== undefined && typeof selector !== 'function') {
      throw new TypeError('[orchestration-sqlite-store] read selector must be a function');
    }
    return enqueue(async () => {
      ensureOpen();
      return cloneJson(selector ? await selector(state) : state);
    });
  }

  async function checkpoint() {
    await tail;
    ensureOpen();
    db.pragma('wal_checkpoint(FULL)');
    chmodPrivate(fsImpl, file);
  }

  async function exportLegacy(targetFile = legacyFile) {
    await tail;
    ensureOpen();
    if (!targetFile || typeof targetFile !== 'string') {
      throw new TypeError('[orchestration-sqlite-store] exportLegacy requires a target file');
    }
    let authoritative;
    db.exec('BEGIN');
    try {
      authoritative = deepFreeze(loadDatabaseState(db, file));
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) { /* best effort */ }
      throw error;
    }
    state = authoritative;
    writeLegacyAtomic({
      fsImpl,
      pathImpl,
      file: targetFile,
      state: authoritative,
      now,
      hooks: {},
    });
    return {
      file: targetFile,
      revision: authoritative.revision,
      digest: stateDigest(authoritative),
    };
  }

  async function close({ exportRollback = true } = {}) {
    await tail;
    if (closed) return;
    let exportError = null;
    // A graceful stop refreshes the legacy snapshot once, outside the hot
    // mutation path. That gives an old binary a current rollback source while
    // SQLite remains the sole live authority during normal operation.
    if (legacyFile && exportRollback) {
      try { await exportLegacy(legacyFile); } catch (error) { exportError = error; }
    }
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } finally {
      db = null;
      statements = null;
      closed = true;
      chmodPrivate(fsImpl, file);
    }
    if (exportError) throw exportError;
  }

  function metrics() {
    return {
      multicc_orchestration_sqlite_mutations_total: counters.mutations,
      multicc_orchestration_sqlite_noops_total: counters.noops,
      multicc_orchestration_sqlite_conflicts_total: counters.conflicts,
      multicc_orchestration_sqlite_dirty_rows_total: counters.dirtyRows,
      multicc_orchestration_sqlite_serialized_bytes_total: counters.serializedBytes,
      multicc_orchestration_sqlite_redaction_checkpoints_total: counters.redactionCheckpoints,
      multicc_orchestration_sqlite_commit_ms_total: counters.commitDurationMs,
      multicc_orchestration_sqlite_commit_ms_max: counters.maxCommitDurationMs,
      multicc_orchestration_sqlite_migration_ms: counters.migrationDurationMs,
    };
  }

  return Object.freeze({
    backend: 'sqlite',
    file,
    legacyFile,
    migration: Object.freeze({ ...migration }),
    mutate,
    mutateIf,
    read,
    snapshot: () => read(),
    flush: checkpoint,
    exportLegacy,
    close,
    metrics,
  });
}

module.exports = {
  DATABASE_SCHEMA_VERSION,
  OrchestrationSqliteConflictError,
  OrchestrationSqliteError,
  createOrchestrationSqliteStore,
  _createDraft: createDraft,
  _loadDatabaseState: loadDatabaseState,
  _stateDigest: stateDigest,
};
