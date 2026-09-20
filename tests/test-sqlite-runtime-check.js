'use strict';

// The startup/install gate for storage. SQLite is no longer a compiled addon,
// so the only failure mode left is a Node too old to have `node:sqlite` — and
// the check must say exactly that instead of leaking a module-not-found trace
// into install.sh output.

const assert = require('node:assert');
const {
  EXIT_OK,
  EXIT_SQLITE_UNAVAILABLE,
  REQUIREMENT,
  checkSqliteRuntime,
  formatReport,
} = require('../scripts/check-sqlite-runtime');

const runtime = {
  version: 'v22.23.2',
  versions: { modules: '127' },
  platform: 'darwin',
  arch: 'x64',
};

function fakeDatabase({ openError, onClose } = {}) {
  return class FakeDatabase {
    constructor(filename) {
      assert.strictEqual(filename, ':memory:');
      if (openError) throw openError;
    }

    close() {
      if (onClose) onClose();
    }
  };
}

let closed = false;
const success = checkSqliteRuntime({
  loadDatabase: () => fakeDatabase({ onClose: () => { closed = true; } }),
  runtime,
});
assert.strictEqual(success.ok, true);
assert.strictEqual(success.exitCode, EXIT_OK);
assert.deepStrictEqual(success.failures, []);
assert.strictEqual(closed, true, 'the in-memory database must be closed');
assert.match(formatReport(success), /SQLite runtime OK/);
assert.match(formatReport(success), /Node v22\.23\.2, darwin\/x64/);

const missing = checkSqliteRuntime({
  loadDatabase: () => { throw new Error("Cannot find module 'node:sqlite'\nRequire stack:\n- /app/server.js"); },
  runtime,
});
assert.strictEqual(missing.ok, false);
assert.strictEqual(missing.exitCode, EXIT_SQLITE_UNAVAILABLE);
assert.deepStrictEqual(missing.failures, [{
  dependency: 'node:sqlite',
  message: "Cannot find module 'node:sqlite'",
}]);
const report = formatReport(missing);
assert.match(report, /Runtime: Node v22\.23\.2, ABI 127, darwin\/x64/);
assert.match(report, /node:sqlite: Cannot find module/);
assert.ok(report.includes(REQUIREMENT), 'the report must name the Node floor');
assert.doesNotMatch(report, /npm rebuild/, 'nothing to rebuild: SQLite ships inside Node');

console.log('SQLite runtime check tests passed');
