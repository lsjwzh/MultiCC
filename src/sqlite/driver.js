'use strict';

// The one place MultiCC opens a SQLite database.
//
// This used to be `better-sqlite3` — a compiled addon, and therefore the one
// dependency a "no Node, no compiler, no Homebrew" bundle cannot afford: its
// prebuilt binary is ABI- and CPU-specific, so every desktop/portable build had
// to fetch (or compile) a binary matching the runtime it ships, and
// `install.sh` needed a `npm rebuild better-sqlite3` escape hatch for the
// machines where no prebuild exists.
//
// Node >= 22.16 ships SQLite in core (`node:sqlite`), so the server, the
// Electron desktop build and the portable bundle all need zero compiled
// dependencies for storage. The bundled runtime is verified by
// scripts/portable-bundle.js, which boots `node:sqlite` out of the shipped
// binary instead of loading an addon.
//
// The surface below mirrors the small slice of better-sqlite3 the call sites
// actually use, so none of them had to be rewritten:
//
//   db.pragma(sql[, { simple: true }])   db.transaction(fn)[.immediate()|.deferred()|.exclusive()]
//   db.prepare(sql) → stmt.run/get/all/iterate/raw   db.exec(sql)   db.open (boolean)   db.close()
//
// Divergences from better-sqlite3, all deliberately fail-loud:
//   - integers above Number.MAX_SAFE_INTEGER throw instead of losing precision;
//   - BLOB columns read back as Uint8Array, not Buffer (no store writes BLOBs);
//   - binding a boolean depends on the Node release (rejected on 22.x, coerced
//     on 26.x), exactly like better-sqlite3 rejects it everywhere;
//   - FOREIGN KEY enforcement follows node:sqlite and is ON by default, where
//     better-sqlite3 inherited SQLite's OFF. Every schema here that declares a
//     REFERENCES clause also runs `PRAGMA foreign_keys = ON` itself, so this
//     only closes the door on writing an orphan row.

const fs = require('node:fs');

const DEFAULT_TIMEOUT_MS = 5000;

const SQLITE_CODE_BY_EXTENDED = new Map([
  [1555, 'SQLITE_CONSTRAINT_PRIMARYKEY'],
  [2067, 'SQLITE_CONSTRAINT_UNIQUE'],
  [787, 'SQLITE_CONSTRAINT_FOREIGNKEY'],
  [1299, 'SQLITE_CONSTRAINT_NOTNULL'],
  [275, 'SQLITE_CONSTRAINT_CHECK'],
  [1811, 'SQLITE_CONSTRAINT_TRIGGER'],
  [2579, 'SQLITE_CONSTRAINT_DATATYPE'],
  [531, 'SQLITE_CONSTRAINT_ROWID'],
]);

const SQLITE_CODE_BY_PRIMARY = new Map([
  [1, 'SQLITE_ERROR'],
  [3, 'SQLITE_INTERNAL'],
  [4, 'SQLITE_PERM'],
  [5, 'SQLITE_BUSY'],
  [6, 'SQLITE_LOCKED'],
  [7, 'SQLITE_NOMEM'],
  [8, 'SQLITE_READONLY'],
  [9, 'SQLITE_INTERRUPT'],
  [10, 'SQLITE_IOERR'],
  [11, 'SQLITE_CORRUPT'],
  [12, 'SQLITE_NOTFOUND'],
  [13, 'SQLITE_FULL'],
  [14, 'SQLITE_CANTOPEN'],
  [15, 'SQLITE_PROTOCOL'],
  [17, 'SQLITE_SCHEMA'],
  [18, 'SQLITE_TOOBIG'],
  [19, 'SQLITE_CONSTRAINT'],
  [20, 'SQLITE_MISMATCH'],
  [21, 'SQLITE_MISUSE'],
  [22, 'SQLITE_NOLFS'],
  [23, 'SQLITE_AUTH'],
  [26, 'SQLITE_NOTADB'],
]);

let cachedModule = null;

class SqliteUnavailableError extends Error {
  constructor(cause) {
    super('SQLite is unavailable in this Node.js runtime. MultiCC needs Node 22.16 or newer '
      + `(node:sqlite ships in core from 22.5). Running: ${process.version}`);
    this.name = 'SqliteUnavailableError';
    this.code = 'SQLITE_RUNTIME_UNAVAILABLE';
    if (cause) this.cause = cause;
  }
}

// Lazy on purpose: `node:sqlite` prints an ExperimentalWarning when it loads, so
// a process that never touches a database never pays for the module.
function loadSqliteModule() {
  if (cachedModule) return cachedModule;
  try {
    cachedModule = require('node:sqlite');
  } catch (cause) {
    throw new SqliteUnavailableError(cause);
  }
  if (!cachedModule || typeof cachedModule.DatabaseSync !== 'function') {
    throw new SqliteUnavailableError();
  }
  return cachedModule;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function unprefixed(key) {
  const first = key[0];
  return first === ':' || first === '@' || first === '$' ? key.slice(1) : key;
}

// better-sqlite3 binds `undefined` as NULL; node:sqlite refuses it. Call sites
// legitimately pass optional columns straight through, so normalize here rather
// than at every call site (that normalization is the whole reason this adapter
// exists rather than a straight swap).
function normalizeNamedParams(value, ignored) {
  const keys = Object.keys(value);
  let needsCopy = false;
  for (const key of keys) {
    if (value[key] === undefined) { needsCopy = true; break; }
    if (ignored && (ignored.has(key) || ignored.has(unprefixed(key)))) { needsCopy = true; break; }
  }
  if (!needsCopy) return value;
  const out = {};
  for (const key of keys) {
    if (ignored && (ignored.has(key) || ignored.has(unprefixed(key)))) continue;
    out[key] = value[key] === undefined ? null : value[key];
  }
  return out;
}

function normalizeParams(params, ignored) {
  if (params.length === 0) return params;
  let changed = false;
  const out = new Array(params.length);
  for (let i = 0; i < params.length; i += 1) {
    const value = params[i];
    if (value === undefined) { out[i] = null; changed = true; continue; }
    if (!isPlainObject(value)) { out[i] = value; continue; }
    const normalized = normalizeNamedParams(value, ignored);
    out[i] = normalized;
    if (normalized !== value) changed = true;
  }
  return changed ? out : params;
}

function unknownNamedParameter(error) {
  const message = error && error.message ? String(error.message) : '';
  const match = message.match(/Unknown named parameter ['"](.+?)['"]/);
  return match ? unprefixed(match[1]) : null;
}

// better-sqlite3 exposed `SQLITE_*` codes; node:sqlite reports the same
// conditions as generic `ERR_SQLITE_ERROR` plus the numeric errcode. Callers
// (and the CLI provider router) branch on the textual form, so restore it.
function normalizeError(error) {
  if (!error || typeof error !== 'object') return error;
  if (typeof error.errcode !== 'number') return error;
  if (typeof error.code === 'string' && error.code.startsWith('SQLITE_')) return error;
  const extended = SQLITE_CODE_BY_EXTENDED.get(error.errcode);
  const mapped = extended
    || SQLITE_CODE_BY_PRIMARY.get(error.errcode & 0xff)
    || 'SQLITE_ERROR';
  try {
    error.nodeCode = error.code;
    error.code = mapped;
  } catch (_) { /* frozen error objects keep Node's code */ }
  return error;
}

// node:sqlite hands back rows with a null prototype; better-sqlite3 returned
// ordinary objects. Callers spread them, pass them to JSON.Stringify and compare
// them with deep-equality helpers, so restore the ordinary object (and leave
// `raw()` rows alone — those are arrays on purpose).
function plainRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  return Object.getPrototypeOf(row) === Object.prototype ? row : Object.assign({}, row);
}

class CompatStatement {
  constructor(statement) {
    this._statement = statement;
    this._ignored = null;
  }

  _bind(params) {
    return normalizeParams(params, this._ignored);
  }

  _call(method, params) {
    let bound = this._bind(params);
    try {
      return this._statement[method](...bound);
    } catch (error) {
      // node:sqlite < 22.19 rejects object keys the statement does not declare,
      // while better-sqlite3 ignores them. Learn the offending key once and
      // retry — the bind failed, so nothing has executed yet.
      const unknown = unknownNamedParameter(error);
      if (!unknown || !isPlainObject(bound[0])) throw normalizeError(error);
      this._ignored = this._ignored || new Set();
      this._ignored.add(unknown);
      bound = this._bind(params);
      try {
        return this._statement[method](...bound);
      } catch (retryError) {
        throw normalizeError(retryError);
      }
    }
  }

  run(...params) { return this._call('run', params); }
  get(...params) { return plainRow(this._call('get', params)); }
  all(...params) { return this._call('all', params).map(plainRow); }

  iterate(...params) {
    const iterator = this._call('iterate', params);
    const step = result => (result.done ? result : { done: false, value: plainRow(result.value) });
    return {
      next: (...args) => step(iterator.next(...args)),
      return: (...args) => (typeof iterator.return === 'function' ? iterator.return(...args) : { done: true }),
      throw: (...args) => (typeof iterator.throw === 'function' ? iterator.throw(...args) : { done: true }),
      [Symbol.iterator]() { return this; },
    };
  }

  raw(enabled = true) {
    if (typeof this._statement.setReturnArrays === 'function') {
      this._statement.setReturnArrays(!!enabled);
      return this;
    }
    if (!enabled) return this;
    throw new SqliteUnavailableError(
      new Error('stmt.raw() needs StatementSync.setReturnArrays (Node 22.23+)'),
    );
  }

  columns() {
    return typeof this._statement.columns === 'function' ? this._statement.columns() : [];
  }

  get sourceSQL() { return this._statement.sourceSQL; }
}

function beginTransaction(db, mode) {
  db.exec(mode ? `BEGIN ${mode}` : 'BEGIN');
}

function commitTransaction(db) {
  db.exec('COMMIT');
}

function savepointName(database) {
  database._savepointSeq += 1;
  return `multicc_sp_${database._savepointSeq}`;
}

function createTransactionRunner(database, fn, mode) {
  const run = (...args) => {
    const handle = database._handle();
    const nested = typeof handle.isTransaction === 'boolean'
      ? handle.isTransaction
      : database._depth > 0;
    const name = nested ? savepointName(database) : null;
    if (nested) handle.exec(`SAVEPOINT ${name}`);
    else beginTransaction(handle, mode);
    database._depth += 1;
    let result;
    try {
      result = fn(...args);
      if (result && typeof result.then === 'function') {
        throw new TypeError('transaction functions must be synchronous');
      }
    } catch (error) {
      database._depth -= 1;
      try {
        if (nested) { handle.exec(`ROLLBACK TO ${name}`); handle.exec(`RELEASE ${name}`); }
        else handle.exec('ROLLBACK');
      } catch (_) { /* the transaction may already be gone */ }
      throw normalizeError(error);
    }
    database._depth -= 1;
    if (nested) handle.exec(`RELEASE ${name}`);
    else commitTransaction(handle);
    return result;
  };
  return run;
}

// Shaped like the error node:sqlite raises for an unopenable path, so
// normalizeError maps it to the SQLITE_CANTOPEN callers already branch on.
function missingFileError(file) {
  const error = new Error(`unable to open database file: ${file}`);
  error.code = 'ERR_SQLITE_ERROR';
  error.errcode = 14;
  return error;
}

class CompatDatabase {
  constructor(file, options = {}) {
    this._file = file;
    this._connectOptions = options || {};
    this._handleRef = null;
    this._depth = 0;
    this._savepointSeq = 0;
    this._open();
  }

  _open() {
    const { DatabaseSync } = loadSqliteModule();
    const options = this._connectOptions;
    const readOnly = options.readOnly !== undefined ? options.readOnly : options.readonly;
    const connect = {};
    if (readOnly !== undefined) connect.readOnly = !!readOnly;
    const timeout = Number.isFinite(options.timeout) ? options.timeout : DEFAULT_TIMEOUT_MS;
    connect.timeout = timeout;
    // node:sqlite has no `fileMustExist`, and without it a read-only caller that
    // lost its file would silently get a fresh empty database. Emulate the flag
    // so the failure looks like better-sqlite3's SQLITE_CANTOPEN.
    if (options.fileMustExist && this._file !== ':memory:' && !fs.existsSync(this._file)) {
      throw normalizeError(missingFileError(this._file));
    }
    try {
      this._handleRef = new DatabaseSync(this._file, connect);
    } catch (error) {
      throw normalizeError(error);
    }
    // node:sqlite only grew the `timeout` connect option recently; setting the
    // pragma keeps the busy-timeout guarantee independent of the Node release.
    try {
      if (timeout > 0) this._handleRef.exec(`PRAGMA busy_timeout = ${Math.trunc(timeout)}`);
    } catch (_) { /* read-only connections may refuse; the option above covers it */ }
    return this;
  }

  _handle() {
    if (!this._handleRef) {
      throw normalizeError(new Error(`the database connection is not open: ${this._file}`));
    }
    return this._handleRef;
  }

  get inTransaction() {
    const handle = this._handleRef;
    if (handle && typeof handle.isTransaction === 'boolean') return handle.isTransaction;
    return this._depth > 0;
  }
  get name() { return this._file; }
  get readonly() { return !!this._connectOptions.readOnly || !!this._connectOptions.readonly; }

  pragma(source, options = {}) {
    const rows = this._handle().prepare(`PRAGMA ${source}`).all();
    if (options && options.simple) {
      const row = rows.length ? rows[0] : null;
      return row ? Object.values(row)[0] : undefined;
    }
    return rows;
  }

  prepare(sql) {
    try {
      return new CompatStatement(this._handle().prepare(sql));
    } catch (error) {
      throw normalizeError(error);
    }
  }

  exec(sql) {
    try {
      return this._handle().exec(sql);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  transaction(fn) {
    if (typeof fn !== 'function') throw new TypeError('transaction() expects a function');
    const deferred = createTransactionRunner(this, fn, null);
    const immediate = createTransactionRunner(this, fn, 'IMMEDIATE');
    const exclusive = createTransactionRunner(this, fn, 'EXCLUSIVE');
    deferred.default = deferred;
    deferred.deferred = deferred;
    deferred.immediate = immediate;
    deferred.exclusive = exclusive;
    return deferred;
  }

  // better-sqlite3 exposes a boolean `db.open`, and stores rely on exactly that
  // shape: `if (db.open) db.close()` and `if (!db.open) throw CLOSED`. A method
  // here would be permanently truthy and would quietly disarm both guards.
  get open() { return !!this._handleRef; }

  close() {
    this._depth = 0;
    const handle = this._handleRef;
    this._handleRef = null;
    if (handle) handle.close();
    return this;
  }

  // Escape hatch for the few places that need the raw node:sqlite handle.
  unwrap() { return this._handle(); }
}

function databaseConstructor() {
  return CompatDatabase;
}

function isSqliteAvailable() {
  try {
    loadSqliteModule();
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  CompatDatabase,
  CompatStatement,
  DEFAULT_TIMEOUT_MS,
  SqliteUnavailableError,
  databaseConstructor,
  isSqliteAvailable,
  loadSqliteModule,
  normalizeError,
};
