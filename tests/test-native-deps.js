'use strict';

const assert = require('assert');
const path = require('path');
const {
  EXIT_BETTER_SQLITE_ONLY,
  EXIT_OK,
  EXIT_OTHER_FAILURE,
  checkNativeDeps,
  formatReport,
} = require('../scripts/check-native-deps');

const runtime = {
  version: 'v25.6.1',
  versions: { modules: '141' },
  platform: 'darwin',
  arch: 'arm64',
};

function fakeRequire({ sqliteError, ptyError, onClose } = {}) {
  return name => {
    if (name === 'better-sqlite3') {
      return class FakeDatabase {
        constructor(filename) {
          assert.strictEqual(filename, ':memory:');
          if (sqliteError) throw sqliteError;
        }

        close() {
          if (onClose) onClose();
        }
      };
    }
    if (name === 'node-pty') {
      if (ptyError) throw ptyError;
      return { spawn() {} };
    }
    throw new Error(`unexpected require: ${name}`);
  };
}

let closed = false;
const success = checkNativeDeps({
  requireFn: fakeRequire({ onClose: () => { closed = true; } }),
  runtime,
  cwd: '/tmp/MultiCC',
});
assert.strictEqual(success.ok, true);
assert.strictEqual(success.exitCode, EXIT_OK);
assert.deepStrictEqual(success.failures, []);
assert.strictEqual(closed, true, 'the in-memory database must be closed');
assert.match(formatReport(success), /Native dependencies OK/);

const bindingError = new Error('Could not locate the bindings file. Tried:\n/path/to/addon.node');
const sqliteFailure = checkNativeDeps({
  requireFn: fakeRequire({ sqliteError: bindingError }),
  runtime,
  cwd: path.join('/tmp', "MultiCC user's copy"),
});
assert.strictEqual(sqliteFailure.ok, false);
assert.strictEqual(sqliteFailure.onlyBetterSqlite, true);
assert.strictEqual(sqliteFailure.exitCode, EXIT_BETTER_SQLITE_ONLY);
assert.deepStrictEqual(sqliteFailure.failures, [{
  dependency: 'better-sqlite3',
  message: 'Could not locate the bindings file. Tried:',
}]);

const sqliteReport = formatReport(sqliteFailure);
assert.match(sqliteReport, /Node v25\.6\.1, ABI 141, darwin\/arm64/);
assert.match(sqliteReport, /better-sqlite3: Could not locate the bindings file/);
assert.match(sqliteReport, /npm rebuild better-sqlite3 --foreground-scripts/);
assert.ok(
  sqliteReport.includes("cd '/tmp/MultiCC user'\"'\"'s copy'"),
  'repair path must be shell quoted'
);

const ptyFailure = checkNativeDeps({
  requireFn: fakeRequire({ ptyError: new Error('native PTY unavailable') }),
  runtime,
  cwd: '/tmp/MultiCC',
});
assert.strictEqual(ptyFailure.ok, false);
assert.strictEqual(ptyFailure.onlyBetterSqlite, false);
assert.strictEqual(ptyFailure.exitCode, EXIT_OTHER_FAILURE);
assert.match(formatReport(ptyFailure), /npm rebuild node-pty --foreground-scripts/);

console.log('Native dependency check tests passed');
