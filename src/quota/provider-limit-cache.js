'use strict';
// Provider limit/usage cache — the durable complement to usage-limit-poller's
// in-memory TTL cache, now backed by a real SQLite database.
//
// The poller keeps the last-fetched window/balance DTO for a few minutes in
// memory, but the moment the server restarts that freshness is gone: quota bars
// render from "no data" until the next poll/route fetch happens to land. This
// module gives every provider identity a last-known-good limit snapshot that
// survives restarts, so the Web/App provider pickers can show a comparable
// summary + "last updated" even before the first live fetch of a fresh boot.
//
// Storage: a dedicated SQLite file (`provider-limit-cache.db`, per-install,
// chmod 0600) with one row per (app_type, provider_id). The database is the
// sole live authority — the previous state-store JSON file is imported once
// (idempotently) and then archived to `<file>.migrated`; it is never written
// again. See src/paths.js (providerLimitDbFile / providerLimitCacheFile).
//
// Contract:
//   - key = `<appType>:<providerId>` (stable provider identity) → idempotent
//     upsert on the composite PRIMARY KEY; renames create a new key and the old
//     entry is pruned on the next snapshot sweep (see prune()).
//   - A SUCCESSFUL fetch overwrites the entry. A FAILED fetch never overwrites
//     the last good data — it only records a diagnostic `lastError` /
//     `lastErrorAt` / `lastAttemptAt` alongside the still-valid summary.
//   - No credentials, API keys, or raw token values are ever stored — only the
//     normalized window/balance summary and its compact bar text.
//   - Schema version lives in the `provider_limit_meta` table and is validated
//     on open; an unsupported version fails closed rather than silently reading
//     a foreign layout.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, recoverFromBackup } = require('../state-store');

const STALE_MS_DEFAULT = 10 * 60 * 1000; // bar freshness threshold for "过期" UI
const DATABASE_SCHEMA_VERSION = 1;

function loadDatabaseConstructor(requireFn = require) {
  return requireFn('better-sqlite3');
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
    fd = fsImpl.openSync(dir, (fsImpl.constants || fs.constants).O_RDONLY);
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
    CREATE TABLE IF NOT EXISTS provider_limit_meta (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS provider_limit_cache (
      app_type TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      kind TEXT,
      status TEXT,
      summary_json TEXT,
      summary_text TEXT,
      bar_text TEXT,
      fetched_at INTEGER,
      updated_at INTEGER,
      last_error TEXT,
      last_error_code TEXT,
      last_error_at INTEGER,
      last_attempt_at INTEGER,
      PRIMARY KEY (app_type, provider_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_provider_limit_updated
      ON provider_limit_cache(updated_at);
  `);
}

function setMeta(db, key, value) {
  db.prepare(`
    INSERT INTO provider_limit_meta(key, value_json) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `).run(key, JSON.stringify(value));
}

function readMeta(db, key) {
  const row = db.prepare('SELECT value_json FROM provider_limit_meta WHERE key = ?').get(key);
  if (!row) return undefined;
  return JSON.parse(row.value_json);
}

// ── legacy JSON migration ──────────────────────────────────────────────────
//
// The pre-SQLite implementation wrote { entries, updatedAt } through
// state-store's envelope ({ __multiccSchema: {...}, data: {...} }) with rolling
// .bak1..N backups. We read through state-store's readJson/recoverFromBackup so
// a corrupt primary still falls back to the last good backup. An unreadable
// legacy file is a warning, not a brick — the cache is non-critical — and the
// file is left untouched for manual inspection (never archived).

function readLegacyEntries(file, fsImpl) {
  if (!file || !fsImpl.existsSync(file)) return null;
  let result;
  try { result = readJson(file, { legacyIsArray: false }); }
  catch (_) {
    try { result = recoverFromBackup(file, { legacyIsArray: false }); }
    catch (_) { return null; }
  }
  if (!result || !result.present) return null;
  const data = result.data;
  const entries = data && typeof data.entries === 'object' && data.entries ? data.entries : {};
  return { entries, updatedAt: data && data.updatedAt ? data.updatedAt : 0 };
}

// Canonical 13-field entry shape used to compare the legacy source against the
// reconstructed rows. rowToEntry() always emits every field (missing ones as
// null), while a hand-written legacy JSON may omit optional fields — normalize
// both sides so the migration digest compares like for like.
function canonicalEntry(e) {
  return {
    appType: e.appType ?? null,
    providerId: e.providerId ?? null,
    kind: e.kind ?? null,
    status: e.status ?? null,
    summary: e.summary ?? null,
    summaryText: e.summaryText ?? '',
    barText: e.barText ?? null,
    fetchedAt: e.fetchedAt ?? null,
    updatedAt: e.updatedAt ?? 0,
    lastError: e.lastError ?? null,
    lastErrorCode: e.lastErrorCode ?? null,
    lastErrorAt: e.lastErrorAt ?? null,
    lastAttemptAt: e.lastAttemptAt ?? null,
  };
}

function canonicalEntries(entries) {
  const result = {};
  for (const [key, e] of Object.entries(entries)) result[key] = canonicalEntry(e);
  return result;
}

function legacyEntriesToRows(entries) {
  const rows = [];
  for (const [key, e] of Object.entries(entries)) {
    if (!e || typeof e !== 'object') continue;
    const sep = key.indexOf(':');
    const appType = sep >= 0 ? key.slice(0, sep) : (e.appType || 'claude');
    const providerId = sep >= 0 ? key.slice(sep + 1) : (e.providerId || key);
    rows.push({
      appType: String(appType),
      providerId: String(providerId),
      kind: e.kind != null ? String(e.kind) : null,
      status: e.status != null ? String(e.status) : null,
      summary: e.summary != null ? e.summary : null,
      summaryText: e.summaryText != null ? String(e.summaryText) : '',
      barText: e.barText != null ? String(e.barText) : null,
      fetchedAt: e.fetchedAt != null ? Math.trunc(e.fetchedAt) : null,
      updatedAt: e.updatedAt != null ? Math.trunc(e.updatedAt) : 0,
      lastError: e.lastError != null ? String(e.lastError) : null,
      lastErrorCode: e.lastErrorCode != null ? String(e.lastErrorCode) : null,
      lastErrorAt: e.lastErrorAt != null ? Math.trunc(e.lastErrorAt) : null,
      lastAttemptAt: e.lastAttemptAt != null ? Math.trunc(e.lastAttemptAt) : null,
    });
  }
  return rows;
}

// Build a fresh database from the legacy JSON (or empty), verify it round-trips,
// then atomically rename it into place. The legacy file is archived only after
// the database rename succeeds, so there is never a window where both sources
// are gone.
function createDatabaseFile({
  Database,
  file,
  legacyJsonFile,
  fsImpl,
  pathImpl,
  now,
  logger,
}) {
  const dir = pathImpl.dirname(file);
  const temp = `${file}.migrating.${process.pid}.${Number(now())}.${crypto.randomBytes(4).toString('hex')}`;
  let db;
  try {
    db = new Database(temp);
    fsImpl.chmodSync(temp, 0o600);
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = FULL');
    createSchema(db);
    setMeta(db, 'databaseSchemaVersion', DATABASE_SCHEMA_VERSION);

    const legacy = readLegacyEntries(legacyJsonFile, fsImpl);
    let imported = 0;
    const insert = db.prepare(`
      INSERT INTO provider_limit_cache
        (app_type, provider_id, kind, status, summary_json, summary_text, bar_text,
         fetched_at, updated_at, last_error, last_error_code, last_error_at, last_attempt_at)
      VALUES (@appType, @providerId, @kind, @status, @summaryJson, @summaryText, @barText,
              @fetchedAt, @updatedAt, @lastError, @lastErrorCode, @lastErrorAt, @lastAttemptAt)
    `);
    const importRows = legacy ? legacyEntriesToRows(legacy.entries) : [];
    if (importRows.length) {
      const tx = db.transaction(() => {
        for (const row of importRows) insert.run(toRowParams(row));
      });
      tx.immediate();
      imported = importRows.length;
    }
    setMeta(db, 'migratedFromJson', !!legacy);
    setMeta(db, 'legacyEntryCount', imported);
    setMeta(db, 'migratedAt', Number(now()));

    if (legacy) {
      const reconstructed = readAllEntries(db);
      if (stateDigest(canonicalEntries(legacy.entries)) !== stateDigest(canonicalEntries(reconstructed.entries))) {
        throw new Error(`[provider-limit-cache] migration verification failed for ${legacyJsonFile}`);
      }
    }

    db.close();
    db = null;
    fsImpl.chmodSync(temp, 0o600);
    fsImpl.renameSync(temp, file);
    fsyncDirectory(fsImpl, pathImpl, dir);

    const archived = legacy ? archiveLegacy(legacyJsonFile, fsImpl) : null;
    if (legacy && logger && logger.log) {
      logger.log(`[multicc/provider-limit-cache] migrated ${imported} entries from ${legacyJsonFile} → ${file} (legacy archived to ${archived})`);
    }
    return {
      migrated: !!legacy,
      legacyEntryCount: imported,
      archivedJsonFile: archived,
      created: true,
    };
  } catch (cause) {
    if (db) {
      try { db.close(); } catch (_) { /* best effort */ }
    }
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { fsImpl.unlinkSync(`${temp}${suffix}`); } catch (_) { /* absent */ }
    }
    throw new Error(`[provider-limit-cache] cannot create database ${file}: ${cause.message}`, { cause });
  }
}

// Archive the legacy JSON so it is unambiguous that SQLite is now authoritative.
// Never deletes user data — renames to <file>.migrated (with a numeric suffix if
// that name is taken). Idempotent: no-op when the legacy file is already gone.
function archiveLegacy(legacyJsonFile, fsImpl) {
  if (!legacyJsonFile || !fsImpl.existsSync(legacyJsonFile)) return null;
  let target = `${legacyJsonFile}.migrated`;
  let n = 2;
  while (fsImpl.existsSync(target)) target = `${legacyJsonFile}.migrated.${n++}`;
  fsImpl.renameSync(legacyJsonFile, target);
  return target;
}

function toRowParams(row) {
  return {
    appType: row.appType,
    providerId: row.providerId,
    kind: row.kind,
    status: row.status,
    summaryJson: row.summary != null ? JSON.stringify(row.summary) : null,
    summaryText: row.summaryText,
    barText: row.barText,
    fetchedAt: row.fetchedAt,
    updatedAt: row.updatedAt,
    lastError: row.lastError,
    lastErrorCode: row.lastErrorCode,
    lastErrorAt: row.lastErrorAt,
    lastAttemptAt: row.lastAttemptAt,
  };
}

function rowToEntry(row) {
  if (!row) return null;
  return {
    appType: row.app_type,
    providerId: row.provider_id,
    kind: row.kind,
    status: row.status,
    summary: row.summary_json != null ? JSON.parse(row.summary_json) : null,
    summaryText: row.summary_text != null ? row.summary_text : '',
    barText: row.bar_text,
    fetchedAt: row.fetched_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
    lastErrorCode: row.last_error_code,
    lastErrorAt: row.last_error_at,
    lastAttemptAt: row.last_attempt_at,
  };
}

function readAllEntries(db) {
  const rows = db.prepare(
    'SELECT * FROM provider_limit_cache ORDER BY app_type, provider_id',
  ).all();
  const entries = {};
  for (const row of rows) entries[`${row.app_type}:${row.provider_id}`] = rowToEntry(row);
  return { entries };
}

function checkDatabase(db, file) {
  const row = db.prepare('PRAGMA quick_check').get();
  const value = row && Object.values(row)[0];
  if (value !== 'ok') {
    throw new Error(`[provider-limit-cache] quick_check failed for ${file}: ${String(value || 'unknown')}`);
  }
}

function validateDatabaseSchema(db, file) {
  const version = readMeta(db, 'databaseSchemaVersion');
  if (version !== DATABASE_SCHEMA_VERSION) {
    throw new Error(
      `[provider-limit-cache] unsupported schema version ${version} in ${file} (expected ${DATABASE_SCHEMA_VERSION})`,
    );
  }
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_limit_cache'",
  ).all();
  if (!tables.length) {
    throw new Error(`[provider-limit-cache] table provider_limit_cache missing in ${file}`);
  }
  const required = ['app_type', 'provider_id', 'summary_json', 'summary_text', 'fetched_at', 'updated_at'];
  const columns = new Set(db.prepare(`PRAGMA table_info(provider_limit_cache)`).all().map(r => r.name));
  const missing = required.filter(c => !columns.has(c));
  if (missing.length) {
    throw new Error(`[provider-limit-cache] missing columns in ${file}: ${missing.join(',')}`);
  }
}

function openDatabase({ Database, file, fsImpl }) {
  let db;
  try {
    chmodPrivate(fsImpl, file);
    db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('secure_delete = ON');
    db.pragma('busy_timeout = 4000');
    db.pragma('wal_autocheckpoint = 1000');
    checkDatabase(db, file);
    validateDatabaseSchema(db, file);
    chmodPrivate(fsImpl, file);
    return db;
  } catch (cause) {
    if (db) {
      try { db.close(); } catch (_) { /* best effort */ }
    }
    throw new Error(`[provider-limit-cache] cannot open database ${file}: ${cause.message}`, { cause });
  }
}

function prepareStatements(db) {
  const upsert = db.prepare(`
    INSERT INTO provider_limit_cache
      (app_type, provider_id, kind, status, summary_json, summary_text, bar_text,
       fetched_at, updated_at, last_error, last_error_code, last_error_at, last_attempt_at)
    VALUES (@appType, @providerId, @kind, @status, @summaryJson, @summaryText, @barText,
            @fetchedAt, @updatedAt, @lastError, @lastErrorCode, @lastErrorAt, @lastAttemptAt)
    ON CONFLICT(app_type, provider_id) DO UPDATE SET
      kind=excluded.kind, status=excluded.status, summary_json=excluded.summary_json,
      summary_text=excluded.summary_text, bar_text=excluded.bar_text,
      fetched_at=excluded.fetched_at, updated_at=excluded.updated_at,
      last_error=excluded.last_error, last_error_code=excluded.last_error_code,
      last_error_at=excluded.last_error_at, last_attempt_at=excluded.last_attempt_at
  `);
  const insertIgnore = db.prepare(`
    INSERT OR IGNORE INTO provider_limit_cache
      (app_type, provider_id, kind, status, summary_json, summary_text, bar_text,
       fetched_at, updated_at, last_error, last_error_code, last_error_at, last_attempt_at)
    VALUES (@appType, @providerId, @kind, @status, @summaryJson, @summaryText, @barText,
            @fetchedAt, @updatedAt, @lastError, @lastErrorCode, @lastErrorAt, @lastAttemptAt)
  `);
  const get = db.prepare(
    'SELECT * FROM provider_limit_cache WHERE app_type = ? AND provider_id = ?',
  );
  const selectAll = db.prepare('SELECT * FROM provider_limit_cache ORDER BY app_type, provider_id');
  const selectKeys = db.prepare('SELECT app_type, provider_id FROM provider_limit_cache');
  const remove = db.prepare('DELETE FROM provider_limit_cache WHERE app_type = ? AND provider_id = ?');
  return { upsert, insertIgnore, get, selectAll, selectKeys, remove };
}

function createProviderLimitCache({
  file,
  legacyJsonFile = null,
  now = Date.now,
  logger = console,
  requireFn = require,
  Database: DatabaseOverride = null,
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  if (!file || typeof file !== 'string') {
    throw new TypeError('[provider-limit-cache] createProviderLimitCache requires { file }');
  }
  const Database = DatabaseOverride || loadDatabaseConstructor(requireFn);
  const dir = pathImpl.dirname(file);
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const dbExists = fsImpl.existsSync(file);
  const migration = dbExists
    ? { migrated: false, legacyEntryCount: 0, archivedJsonFile: null, created: false }
    : createDatabaseFile({ Database, file, legacyJsonFile, fsImpl, pathImpl, now, logger });

  const db = openDatabase({ Database, file, fsImpl });
  const statements = prepareStatements(db);
  let closed = false;

  // Catch-up import: the DB already exists but the legacy JSON is still present
  // (crash between DB rename and archive, or a restored JSON). Legacy only fills
  // gaps — it never overwrites newer rows — then the JSON is archived.
  const legacy = dbExists ? readLegacyEntries(legacyJsonFile, fsImpl) : null;
  if (legacy && Object.keys(legacy.entries).length) {
    const rows = legacyEntriesToRows(legacy.entries);
    const tx = db.transaction(() => {
      for (const row of rows) statements.insertIgnore.run(toRowParams(row));
    });
    tx.immediate();
    migration.migrated = true;
    migration.legacyEntryCount = rows.length;
    migration.archivedJsonFile = archiveLegacy(legacyJsonFile, fsImpl);
    if (logger && logger.log) {
      logger.log(`[multicc/provider-limit-cache] caught up ${rows.length} legacy entries into ${file}; archived ${legacyJsonFile}`);
    }
  } else if (legacy && fsImpl.existsSync(legacyJsonFile) && !Object.keys(legacy.entries).length) {
    // Present but empty legacy file — archive it (nothing to import).
    migration.archivedJsonFile = archiveLegacy(legacyJsonFile, fsImpl);
  }

  function ensureOpen() {
    if (closed || !db) throw new Error(`[provider-limit-cache] database is closed: ${file}`);
  }

  function key(appType, id) {
    return `${String(appType)}:${String(id)}`;
  }

  function get(appType, id) {
    ensureOpen();
    return rowToEntry(statements.get.get(String(appType), String(id)));
  }

  // Record a successful limit fetch. Idempotent upsert; entry.fetchedAt is the
  // time the data was actually produced (may differ from now when replaying a
  // DTO that carries its own observedAt).
  function record(appType, id, entry) {
    if (!entry || typeof entry !== 'object') return null;
    ensureOpen();
    const prev = get(appType, id);
    const nowMs = now();
    const next = {
      appType: String(appType),
      providerId: String(id),
      kind: entry.kind || (prev ? prev.kind : 'quota'),
      status: 'ok',
      summary: entry.summary != null ? entry.summary : (prev ? prev.summary : null),
      summaryText: typeof entry.summaryText === 'string' ? entry.summaryText : (prev ? prev.summaryText : ''),
      barText: typeof entry.barText === 'string' ? entry.barText : (prev ? prev.barText : null),
      fetchedAt: entry.fetchedAt != null ? Math.trunc(entry.fetchedAt) : nowMs,
      updatedAt: nowMs,
      lastError: null,
      lastErrorCode: null,
      lastErrorAt: null,
      lastAttemptAt: nowMs,
    };
    const tx = db.transaction(() => statements.upsert.run(toRowParams(next)));
    tx.immediate();
    return next;
  }

  // Record that a fetch failed. Never touches an existing successful entry —
  // it only stamps diagnostics so the UI can distinguish "stale but last known
  // good" from "never fetched".
  function recordFailure(appType, id, meta = {}) {
    ensureOpen();
    const prev = get(appType, id);
    const nowMs = now();
    const next = prev ? { ...prev } : {
      appType: String(appType),
      providerId: String(id),
      kind: 'unknown',
      status: 'error',
      summary: null,
      summaryText: '',
      barText: null,
      fetchedAt: null,
      updatedAt: nowMs,
    };
    next.lastError = meta.error ? String(meta.error) : null;
    next.lastErrorCode = meta.code ? String(meta.code) : null;
    next.lastErrorAt = nowMs;
    next.lastAttemptAt = nowMs;
    const tx = db.transaction(() => statements.upsert.run(toRowParams(next)));
    tx.immediate();
    return next;
  }

  // Copy-on-read snapshot for API/UI. The shape stays stable across versions so
  // old clients ignore extra fields.
  function snapshot() {
    ensureOpen();
    const entries = {};
    let updatedAt = 0;
    for (const row of statements.selectAll.all()) {
      entries[key(row.app_type, row.provider_id)] = rowToEntry(row);
      if (row.updated_at > updatedAt) updatedAt = row.updated_at;
    }
    return { entries, updatedAt };
  }

  // Drop entries whose provider identity no longer exists (deleted / renamed
  // provider). Called on /api/providers so the database doesn't grow orphans.
  function prune(liveKeys) {
    ensureOpen();
    const removeTx = db.transaction((removed) => {
      for (const row of statements.selectKeys.all()) {
        const k = key(row.app_type, row.provider_id);
        if (!liveKeys.has(k)) {
          statements.remove.run(row.app_type, row.provider_id);
          removed += 1;
        }
      }
      return removed;
    });
    return removeTx.immediate(liveKeys && liveKeys.size ? 0 : 0);
  }

  function close() {
    if (closed) return;
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) { /* best effort */ }
    try { db.close(); } catch (_) { /* best effort */ }
    closed = true;
  }

  return Object.freeze({
    record,
    recordFailure,
    get,
    snapshot,
    prune,
    key,
    file,
    legacyJsonFile,
    migration: Object.freeze({ ...migration }),
    close,
  });
}

module.exports = {
  createProviderLimitCache,
  STALE_MS_DEFAULT,
  DATABASE_SCHEMA_VERSION,
  _rowToEntry: rowToEntry,
  _readLegacyEntries: readLegacyEntries,
};
