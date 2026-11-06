'use strict';

// Rust owns connections, bindings, SQL execution, prepared-statement cache and
// transaction/savepoint completion. This file only adapts the existing Node API.
// Legacy synchronous callbacks must remain synchronous until the business ports
// become explicit async commands. No automatic fallback after a failed write.
const path = require('node:path');
const DEFAULT_TIMEOUT_MS = 5000;
let native;

// better-sqlite3 exposed `SQLITE_*` codes; callers (and the CLI provider
// router) branch on the textual form, so map the numeric extended code back.
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
function normalizeNodeError(error) {
  if (!error || typeof error !== 'object') return error;
  if (typeof error.errcode !== 'number') return error;
  if (typeof error.code === 'string' && error.code.startsWith('SQLITE_')) return error;
  const mapped = SQLITE_CODE_BY_EXTENDED.get(error.errcode)
    || SQLITE_CODE_BY_PRIMARY.get(error.errcode & 0xff)
    || 'SQLITE_ERROR';
  try {
    error.nodeCode = error.code;
    error.code = mapped;
  } catch (_) { /* frozen error objects keep Node's code */ }
  return error;
}

class SqliteUnavailableError extends Error {
  constructor(cause) {
    super('Rust SQLite 模块不可用；请安装与平台和架构匹配的完整 MultiCC 包，源码运行请先执行 npm run build:rust 并设置 MULTICC_RUST_PREBUILT_DIR。');
    this.code = 'SQLITE_RUNTIME_UNAVAILABLE';
    this.name = 'SqliteUnavailableError';
    if (cause) this.cause = cause;
  }
}
function loadSqliteModule() {
  if (native) return native;
  const root = process.env.MULTICC_RUST_PREBUILT_DIR || path.resolve(__dirname, '../../native/prebuilt');
  const file = process.env.MULTICC_RUST_ADDON || path.join(root, `${process.platform}-${process.arch}`, 'multicc_core.node');
  try {
    const addon = require(file);
    if (addon.protocolVersion?.() !== 1 || typeof addon.RustDatabase !== 'function') throw new Error('rust_sqlite_protocol_mismatch');
    native = addon;
    return native;
  } catch (cause) { throw new SqliteUnavailableError(cause); }
}
function normalizeError(error) {
  const match = error?.message?.match(/^MULTICC_SQLITE:(\d+):([\s\S]*)$/);
  if (match) {
    error.errcode = Number(match[1]);
    error.message = match[2];
    error.code = 'ERR_SQLITE_ERROR';
  }
  if (error?.errcode === 25) { error.nodeCode = error.code; error.code = 'SQLITE_RANGE'; return error; }
  return normalizeNodeError(error);
}
function call(fn) { try { return fn(); } catch (error) { throw normalizeError(error); } }
function plain(value) {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}
function paramsFor(params) {
  const args = [...params];
  const named = plain(args[0]) ? Object.fromEntries(Object.entries(args.shift()).map(([k, v]) => [k, v ?? null])) : {};
  return [args.map(v => v ?? null), named];
}
class CompatStatement {
  constructor(database, sql) {
    this._database = database;
    this.sourceSQL = sql;
    this._raw = false;
    this.columns(); // Fail at prepare time, not at the first write.
  }
  _query(mode, params) {
    const [positional, named] = paramsFor(params);
    return call(() => this._database._handle().query(this.sourceSQL, positional, named, mode));
  }
  _rows(result) {
    return this._raw ? result.rows : result.rows.map(values => Object.fromEntries(result.columns.map((name, i) => [name, values[i]])));
  }
  run(...params) {
    const { changes, lastInsertRowid } = this._query(0, params);
    return { changes, lastInsertRowid };
  }
  get(...params) { return this._rows(this._query(1, params))[0]; }
  all(...params) { return this._rows(this._query(2, params)); }
  // Current stores use get/all. This compatibility iterator materializes rows;
  // it must not be used for unbounded bulk export (use an explicit Rust command).
  iterate(...params) { return this.all(...params)[Symbol.iterator](); }
  raw(enabled = true) { this._raw = !!enabled; return this; }
  columns() { return call(() => this._database._handle().columns(this.sourceSQL)); }
}
function transaction(database, fn, mode) {
  return function (...args) {
    const handle = database._handle();
    const id = call(() => handle.begin(mode));
    let result;
    try {
      result = fn.apply(this, args);
      if (result && typeof result.then === 'function') throw new TypeError('transaction functions must be synchronous');
    } catch (error) {
      try { handle.finish(id, false); } catch (_) { /* preserve the original failure */ }
      throw normalizeError(error);
    }
    call(() => handle.finish(id, true)); // Rust rolls back even if COMMIT fails.
    return result;
  };
}
class CompatDatabase {
  constructor(file, options = {}) {
    options ||= {};
    this.name = file;
    this.readonly = !!(options.readOnly ?? options.readonly);
    const timeout = Number.isFinite(options.timeout) ? options.timeout : DEFAULT_TIMEOUT_MS;
    if (timeout < 0 || timeout > 2147483647) throw new RangeError('invalid SQLite busy timeout');
    const { RustDatabase } = loadSqliteModule();
    this._handleRef = call(() => new RustDatabase(file, this.readonly, !!options.fileMustExist, Math.trunc(timeout)));
  }
  _handle() {
    if (!this._handleRef) throw new Error('database connection is not open');
    return this._handleRef;
  }
  get backend() { return 'rust'; }
  get open() { return !!this._handleRef; }
  get inTransaction() { return this.open && this._handle().isTransaction; }
  prepare(sql) { return new CompatStatement(this, sql); }
  exec(sql) { call(() => this._handle().exec(sql)); }
  pragma(source, options = {}) {
    const rows = this.prepare(`PRAGMA ${source}`).all();
    return options?.simple ? (rows.length ? Object.values(rows[0])[0] : undefined) : rows;
  }
  transaction(fn) {
    if (typeof fn !== 'function') throw new TypeError('transaction() expects a function');
    const deferred = transaction(this, fn, '');
    deferred.default = deferred;
    deferred.deferred = deferred;
    deferred.immediate = transaction(this, fn, 'IMMEDIATE');
    deferred.exclusive = transaction(this, fn, 'EXCLUSIVE');
    return deferred;
  }
  close() {
    if (this._handleRef) call(() => this._handleRef.close());
    this._handleRef = null;
    return this;
  }
  unwrap() { return this._handle(); }
}
function databaseConstructor() {
  return CompatDatabase;
}
function isSqliteAvailable() {
  try { const Database = databaseConstructor(); const db = new Database(':memory:'); db.close(); return true; }
  catch (_) { return false; }
}
module.exports = { CompatDatabase, CompatStatement, DEFAULT_TIMEOUT_MS, SqliteUnavailableError,
  databaseConstructor, isSqliteAvailable, loadSqliteModule, normalizeError };
