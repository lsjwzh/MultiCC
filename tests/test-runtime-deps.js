'use strict';

const assert = require('node:assert/strict');
const {
  EXIT_RUNTIME_FAILURE,
  EXIT_SQLITE_UNAVAILABLE,
  checkRuntimeDeps,
  formatReport,
} = require('../scripts/check-runtime-deps');

const runtime = {
  version: 'v22.12.0',
  versions: { modules: '127' },
  platform: 'linux',
  arch: 'x64',
};

class FakeDatabase {
  close() {}
}

function fakeRequire({ cprApi = '1.1.0', cprError = null, ciaoError = null, ciaoApi = true } = {}) {
  return name => {
    if (name === 'cli-provider-router') {
      if (cprError) throw cprError;
      return { API_VERSION: cprApi };
    }
    if (name === 'cli-provider-router/package.json') return { version: '0.3.0' };
    if (name === '@homebridge/ciao') {
      if (ciaoError) throw ciaoError;
      return ciaoApi ? { getResponder() {} } : {};
    }
    if (name === '@homebridge/ciao/package.json') return { version: '1.3.10' };
    throw new Error(`unexpected require: ${name}`);
  };
}

const success = checkRuntimeDeps({ requireFn: fakeRequire(), loadDatabase: () => FakeDatabase, runtime });
assert.equal(success.ok, true);
assert.equal(success.providerRouter.version, '0.3.0');
assert.match(formatReport(success), /CPR 0\.3\.0 \/ API 1\.1\.0/);
assert.equal(success.lanDiscovery.version, '1.3.10');
assert.match(formatReport(success), /mDNS ciao 1\.3\.10/);

for (const cprApi of [null, '0.9.0', '2.0.0']) {
  const result = checkRuntimeDeps({ requireFn: fakeRequire({ cprApi }), loadDatabase: () => FakeDatabase, runtime });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, EXIT_RUNTIME_FAILURE);
  assert.match(formatReport(result), /cli-provider-router: expected CPR API major 1/);
}

const missing = checkRuntimeDeps({
  requireFn: fakeRequire({ cprError: new Error('Cannot find module cli-provider-router') }),
  loadDatabase: () => FakeDatabase,
  runtime,
});
assert.equal(missing.exitCode, EXIT_RUNTIME_FAILURE);
assert.match(formatReport(missing), /npm install/);

for (const options of [
  { ciaoError: new Error('Cannot find module @homebridge/ciao') },
  { ciaoApi: false },
]) {
  const result = checkRuntimeDeps({ requireFn: fakeRequire(options), loadDatabase: () => FakeDatabase, runtime });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, EXIT_RUNTIME_FAILURE);
  assert.equal(result.failures.at(-1).dependency, '@homebridge/ciao');
  assert.match(formatReport(result), /@homebridge\/ciao/);
  assert.match(formatReport(result), /npm install/);
}

// A runtime that cannot open a database is the one failure that means "your
// Node is too old", so it carries its own exit code and names the floor.
const noSqlite = checkRuntimeDeps({
  requireFn: fakeRequire(),
  loadDatabase: () => { throw new Error("Cannot find module 'node:sqlite'"); },
  runtime,
});
assert.equal(noSqlite.ok, false);
assert.equal(noSqlite.sqliteOnly, true);
assert.equal(noSqlite.exitCode, EXIT_SQLITE_UNAVAILABLE);
assert.match(formatReport(noSqlite), /node:sqlite: Cannot find module/);
assert.match(formatReport(noSqlite), /Node 22\.16 or newer/);

console.log('Runtime dependency check tests passed');
