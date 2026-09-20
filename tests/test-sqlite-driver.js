'use strict';

// Storage moved off the compiled `better-sqlite3` addon and onto the SQLite
// inside Node (`node:sqlite`). src/sqlite/driver.js is the compatibility layer
// that keeps every call site unchanged, so these tests pin the exact slice of
// the old API the server depends on — and, where the addon is still installed
// (it is a devDependency), run the same statements through both drivers and
// compare the results. A silent divergence here is a corrupt-state bug in
// production, which is why the oracle is worth the extra dependency.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CompatDatabase,
  SqliteUnavailableError,
  databaseConstructor,
  isSqliteAvailable,
  normalizeError,
} = require('../src/sqlite/driver');

let OracleDatabase = null;
try {
  OracleDatabase = require('better-sqlite3');
} catch (_) {
  OracleDatabase = null;
}

function temporaryFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-sqlite-driver-'));
  return path.join(dir, name);
}

function open(Database, file = ':memory:') {
  const db = new Database(file);
  return db;
}

// assert.throws() only returns undefined, so the error object has to be caught
// by hand when the assertion is about its fields.
function catchError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

test('the driver is the SQLite that ships inside Node, and reports its absence', () => {
  assert.equal(typeof databaseConstructor(), 'function');
  assert.equal(isSqliteAvailable(), true);
  // 22.16 is the floor package.json declares: `node:sqlite` landed in 22.5 and
  // had its experimental warning removed in 22.13.
  assert.match(new SqliteUnavailableError().message, /Node 22\.16 or newer/);
  assert.equal(new SqliteUnavailableError().code, 'SQLITE_RUNTIME_UNAVAILABLE');
  assert.ok(new CompatDatabase(':memory:') instanceof CompatDatabase);
});

test('db.open is a boolean that flips on close, because stores branch on it', () => {
  const db = open(CompatDatabase);
  assert.equal(db.open, true);
  db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)');
  db.close();
  assert.equal(db.open, false, 'task-run/store.js throws CLOSED when db.open is falsy');
  db.close();
  assert.equal(db.open, false, 'a second close must not throw');
});

test('statements keep the run/get/all/iterate/columns surface call sites use', () => {
  const db = open(CompatDatabase);
  db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT, c INTEGER)');
  const insert = db.prepare('INSERT INTO t (b, c) VALUES (?, ?)');
  const first = insert.run('x', 1);
  assert.deepEqual({ changes: first.changes, lastInsertRowid: Number(first.lastInsertRowid) }, { changes: 1, lastInsertRowid: 1 });
  insert.run('y', null);

  assert.deepEqual(db.prepare('SELECT b, c FROM t ORDER BY a').get(), { b: 'x', c: 1 });
  assert.deepEqual(db.prepare('SELECT b FROM t ORDER BY a').all(), [{ b: 'x' }, { b: 'y' }]);
  assert.throws(() => db.prepare('SELECT b FROM t ORDER BY a').get('extra'),
    /column index out of range|Too many parameter values|range/i,
    'binding a positional value the statement has no slot for fails loud, as better-sqlite3 did');
  assert.deepEqual([...db.prepare('SELECT b FROM t ORDER BY a').iterate()].map(row => row.b), ['x', 'y']);
  const columns = db.prepare('SELECT a, b AS renamed FROM t').columns();
  if (columns.length) assert.deepEqual(columns.map(c => c.name ?? c.column ?? c), ['a', 'renamed']);
  assert.match(db.prepare('SELECT 1').sourceSQL, /SELECT 1/);
  db.close();
});

test('undefined binds as NULL: the whole reason this adapter exists', () => {
  const db = open(CompatDatabase);
  db.exec('CREATE TABLE t (a TEXT, b TEXT)');
  db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(undefined, 'kept');
  db.prepare('INSERT INTO t (a, b) VALUES (@a, @b)').run({ a: undefined, b: 'named' });
  assert.deepEqual(db.prepare('SELECT a, b FROM t ORDER BY b').all(),
    [{ a: null, b: 'kept' }, { a: null, b: 'named' }]);
  db.close();
});

test('named parameters the statement does not declare are ignored, not fatal', () => {
  const db = open(CompatDatabase);
  db.exec('CREATE TABLE t (a TEXT)');
  const statement = db.prepare('INSERT INTO t (a) VALUES (@a)');
  // better-sqlite3 ignores extra keys; node:sqlite rejects them, so the driver
  // learns the offending name once and retries. Two calls prove it sticks.
  statement.run({ a: 'first', b: 'unused' });
  statement.run({ a: 'second', b: 'unused' });
  assert.deepEqual(db.prepare('SELECT a FROM t ORDER BY a').all(), [{ a: 'first' }, { a: 'second' }]);
  db.close();
});

test('nested transactions become savepoints so an inner rollback spares the outer work', () => {
  const db = open(CompatDatabase);
  db.exec('CREATE TABLE t (a TEXT)');
  const write = db.transaction(value => db.prepare('INSERT INTO t (a) VALUES (?)').run(value));
  const outer = db.transaction(() => {
    write('outer-before');
    try {
      db.transaction(() => {
        write('inner');
        throw new Error('inner failure');
      })();
    } catch (error) {
      assert.equal(error.message, 'inner failure');
    }
    write('outer-after');
  });
  outer();
  assert.deepEqual(db.prepare('SELECT a FROM t ORDER BY a').all(),
    [{ a: 'outer-after' }, { a: 'outer-before' }],
    'the inner savepoint rolled back and the outer transaction still committed');

  assert.throws(() => db.transaction(() => {
    write('doomed');
    throw new Error('outer failure');
  })(), /outer failure/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 2, 'outer rollback undid everything');
  assert.equal(db.inTransaction, false);
  db.close();
});

test('every transaction mode is callable and rejects an async body', () => {
  const db = open(CompatDatabase);
  db.exec('CREATE TABLE t (a TEXT)');
  const insert = db.transaction(value => db.prepare('INSERT INTO t (a) VALUES (?)').run(value));
  insert.immediate('immediate');
  insert.exclusive('exclusive');
  insert.deferred('deferred');
  insert('default');
  assert.throws(() => db.transaction(async () => 'later')(), TypeError);
  assert.equal(db.inTransaction, false, 'a rejected async body must not leave a transaction open');
  assert.deepEqual(db.prepare('SELECT a FROM t ORDER BY a').all().map(row => row.a).sort(),
    ['default', 'deferred', 'exclusive', 'immediate']);
  db.close();
});

test('pragma() keeps both the row list and the { simple } scalar form', () => {
  const file = temporaryFile('pragma.sqlite');
  const db = open(CompatDatabase, file);
  assert.equal(db.pragma('journal_mode = WAL', { simple: true }), 'wal');
  // node:sqlite turns FK enforcement on where better-sqlite3 inherited SQLite's
  // off; the schemas that declare REFERENCES set the pragma themselves either
  // way, and the value here proves it is live and settable.
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.pragma('foreign_keys = ON');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.ok(Array.isArray(db.pragma('journal_mode')));
  db.close();
});

test('SQLite errors keep the SQLITE_* codes callers branch on', () => {
  const db = open(CompatDatabase);
  db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT UNIQUE)');
  db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(1, 'x');

  const unique = catchError(() => db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(2, 'x'));
  assert.equal(unique.code, 'SQLITE_CONSTRAINT_UNIQUE');
  assert.equal(unique.nodeCode, 'ERR_SQLITE_ERROR', 'the original node:sqlite code stays readable');
  const primary = catchError(() => db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(1, 'y'));
  assert.equal(primary.code, 'SQLITE_CONSTRAINT_PRIMARYKEY');
  const syntax = catchError(() => db.prepare('SELECT nope FROM missing'));
  assert.match(String(syntax.code), /^SQLITE_/);
  // Text-only errors (no numeric errcode) must pass through untouched.
  const plain = new Error('not sqlite');
  assert.equal(normalizeError(plain), plain);
  db.close();
});

test('fileMustExist fails closed instead of creating an empty database', () => {
  const missing = temporaryFile('absent.sqlite');
  assert.equal(fs.existsSync(missing), false);
  const error = catchError(() => new CompatDatabase(missing, { fileMustExist: true }));
  // The file the caller asked to read is not a file we may invent: the export
  // and CC-Switch paths both pass this flag, and both must see CANTOPEN.
  assert.equal(error.code, 'SQLITE_CANTOPEN');
  assert.equal(fs.existsSync(missing), false, 'no empty database was left behind');

  const file = temporaryFile('present.sqlite');
  const created = open(CompatDatabase, file);
  created.close();
  const readOnly = new CompatDatabase(file, { readonly: true, fileMustExist: true, timeout: 4000 });
  assert.equal(readOnly.readonly, true);
  assert.throws(() => readOnly.exec('CREATE TABLE nope (a)'), /readonly|read-only|not authorized|attempt to write/i);
  readOnly.close();
});

test('the addon is an oracle, not a dependency: identical results, statement for statement', {
  skip: OracleDatabase ? false : 'better-sqlite3 (devDependency) is not installed here',
}, () => {
  const script = [
    { op: 'exec', sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, note TEXT, amount REAL)' },
    { op: 'run', sql: 'INSERT INTO t (name, note, amount) VALUES (?, ?, ?)', params: ['alpha', undefined, 1.5] },
    { op: 'run', sql: 'INSERT INTO t (name, note, amount) VALUES (@name, @note, @amount)', params: { name: 'beta', note: null, amount: -2.25, extra: 'ignored' } },
    { op: 'all', sql: 'SELECT id, name, note, amount FROM t ORDER BY id' },
    { op: 'all', sql: 'SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM t' },
    { op: 'all', sql: 'SELECT name FROM t WHERE amount > ? ORDER BY name', params: [0] },
    { op: 'get', sql: 'SELECT COUNT(*) AS n FROM t WHERE note IS NULL' },
  ];

  const run = (Database, file) => {
    const db = new Database(file);
    const output = [];
    for (const entry of script) {
      if (entry.op === 'exec') { db.exec(entry.sql); continue; }
      const statement = db.prepare(entry.sql);
      const bound = entry.params === undefined
        ? []
        : (Array.isArray(entry.params) ? entry.params : [entry.params]);
      const result = statement[entry.op](...bound);
      if (entry.op === 'run') output.push({ changes: result.changes, id: Number(result.lastInsertRowid) });
      else output.push(result);
    }
    db.close();
    return output;
  };

  const viaCompat = run(CompatDatabase, temporaryFile('compat.sqlite'));
  const viaAddon = run(OracleDatabase, temporaryFile('addon.sqlite'));
  assert.deepEqual(viaCompat, viaAddon);
});
