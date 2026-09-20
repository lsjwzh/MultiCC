'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  RUNTIME_REQUIREMENT,
  createSqliteRuntime,
} = require('../src/sqlite-runtime');

const DB_PATH = '/tmp/cc-switch.db';
const RAW_RUNTIME_ERROR = 'No such built-in module: node:sqlite (from /Users/private/project/server.js)';

test('a runtime that cannot open a database is reported as unavailable', () => {
  let loadCalls = 0;
  class BrokenDatabase {
    constructor() { throw new Error(RAW_RUNTIME_ERROR); }
  }
  const runtime = createSqliteRuntime({
    loadDatabase: () => { loadCalls += 1; return BrokenDatabase; },
    existsSync: () => true,
  });

  const status = runtime.getStatus(DB_PATH);
  assert.equal(loadCalls, 1, 'the JavaScript package loaded successfully');
  assert.deepEqual(
    { available: status.available, dbFound: status.dbFound, reason: status.reason },
    { available: false, dbFound: true, reason: 'native-runtime-unavailable' },
  );
  assert.match(status.message, new RegExp(RUNTIME_REQUIREMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(status.message, /No such built-in module|\/Users\/private/);
});

test('a failed runtime probe is retried and can recover without process restart', () => {
  let broken = true;
  let loadCalls = 0;
  let closes = 0;
  class RetryDatabase {
    constructor(filename) {
      assert.equal(filename, ':memory:');
      if (broken) throw new Error(RAW_RUNTIME_ERROR);
    }
    close() { closes += 1; }
  }
  const runtime = createSqliteRuntime({
    loadDatabase: () => { loadCalls += 1; return RetryDatabase; },
    existsSync: () => true,
  });

  assert.equal(runtime.getStatus(DB_PATH).available, false);
  broken = false;
  assert.equal(runtime.getStatus(DB_PATH).available, true);
  assert.equal(loadCalls, 2, 'failure was not cached');
  assert.equal(closes, 1, 'successful probe was closed');
});

test('missing database is distinct and does not load the runtime', () => {
  let loadCalls = 0;
  const runtime = createSqliteRuntime({
    loadDatabase: () => { loadCalls += 1; throw new Error('should not load'); },
    existsSync: () => false,
  });

  const status = runtime.getStatus(DB_PATH);
  assert.equal(status.available, false);
  assert.equal(status.dbFound, false);
  assert.equal(status.dbPath, DB_PATH);
  assert.equal(status.reason, 'database-not-found');
  assert.equal(loadCalls, 0);
});

test('openReadonly hides raw runtime errors and names the Node requirement', () => {
  class BrokenDatabase {
    constructor() { throw new Error(RAW_RUNTIME_ERROR); }
  }
  const runtime = createSqliteRuntime({
    loadDatabase: () => BrokenDatabase,
    existsSync: () => true,
  });

  assert.throws(
    () => runtime.openReadonly(DB_PATH),
    error => {
      assert.equal(error.code, 'SQLITE_NATIVE_RUNTIME_UNAVAILABLE');
      assert.equal(error.reason, 'native-runtime-unavailable');
      assert.match(error.message, new RegExp(RUNTIME_REQUIREMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(error.message, /No such built-in module|\/Users\/private/);
      return true;
    },
  );
});

test('openReadonly probes the runtime and opens the requested file read-only', () => {
  const opened = [];
  class WorkingDatabase {
    constructor(filename, options) {
      this.filename = filename;
      this.options = options;
      opened.push(this);
    }
    close() { this.closed = true; }
  }
  const runtime = createSqliteRuntime({
    loadDatabase: () => WorkingDatabase,
    existsSync: () => true,
  });

  const db = runtime.openReadonly(DB_PATH);
  assert.equal(db.filename, DB_PATH);
  assert.equal(db.options.readonly, true);
  assert.equal(db.options.fileMustExist, true);
  assert.equal(db.options.timeout, 4000);
  assert.equal(opened.filter(item => item.filename === ':memory:').length, 2);
  assert.ok(opened.filter(item => item.filename === ':memory:').every(item => item.closed));
  assert.equal(db.closed, undefined, 'caller owns the returned database');
});

