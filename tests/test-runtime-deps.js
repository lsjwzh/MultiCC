'use strict';

const assert = require('node:assert/strict');
const {
  EXIT_RUNTIME_FAILURE,
  checkRuntimeDeps,
  formatReport,
} = require('../scripts/check-runtime-deps');

const runtime = {
  version: 'v22.12.0',
  versions: { modules: '127' },
  platform: 'linux',
  arch: 'x64',
};

function fakeRequire({ cprApi = '1.1.0', cprError = null, ciaoError = null, ciaoApi = true } = {}) {
  return name => {
    if (name === 'better-sqlite3') {
      return class FakeDatabase { close() {} };
    }
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

const success = checkRuntimeDeps({ requireFn: fakeRequire(), runtime, cwd: '/tmp/MultiCC' });
assert.equal(success.ok, true);
assert.equal(success.providerRouter.version, '0.3.0');
assert.match(formatReport(success), /CPR 0\.3\.0 \/ API 1\.1\.0/);
assert.equal(success.lanDiscovery.version, '1.3.10');
assert.match(formatReport(success), /mDNS ciao 1\.3\.10/);

for (const cprApi of [null, '0.9.0', '2.0.0']) {
  const result = checkRuntimeDeps({ requireFn: fakeRequire({ cprApi }), runtime, cwd: '/tmp/MultiCC' });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, EXIT_RUNTIME_FAILURE);
  assert.match(formatReport(result), /cli-provider-router: expected CPR API major 1/);
}

const missing = checkRuntimeDeps({
  requireFn: fakeRequire({ cprError: new Error('Cannot find module cli-provider-router') }),
  runtime,
  cwd: '/tmp/MultiCC',
});
assert.equal(missing.exitCode, EXIT_RUNTIME_FAILURE);
assert.match(formatReport(missing), /npm install/);

for (const options of [
  { ciaoError: new Error('Cannot find module @homebridge/ciao') },
  { ciaoApi: false },
]) {
  const result = checkRuntimeDeps({ requireFn: fakeRequire(options), runtime, cwd: '/tmp/MultiCC' });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, EXIT_RUNTIME_FAILURE);
  assert.equal(result.failures.at(-1).dependency, '@homebridge/ciao');
  assert.match(formatReport(result), /@homebridge\/ciao/);
  assert.match(formatReport(result), /npm install/);
}

console.log('Runtime dependency check tests passed');
