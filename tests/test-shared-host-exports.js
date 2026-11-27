'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const binding = require('../src/native/binding');
const reference = require('./helpers/shared-hosts-d6430f13.json');
const { observe } = require('./helpers/shared-host-probe.cjs');

// Each observation was captured in a separate process loading d6430f13's
// CommonJS sources and its own compiled addon. Keep export order and arity.
for (const [name, { entry, bootstrap, ...expected }] of Object.entries(reference)) {
  test(`d6430f13 shared host contract: ${entry}`, () => {
    const legacyPath = require(path.resolve(__dirname, '..', entry));
    assert.equal(legacyPath, binding[name]);
    assert.deepEqual(observe(name, binding[name]), expected);
  });
}

test('loading and calling shared entry points before the addon is installed', () => {
  const { execFileSync } = require('node:child_process');
  const result = execFileSync(process.execPath, [
    require.resolve('./helpers/shared-host-probe.cjs'), require.resolve('./helpers/shared-hosts-d6430f13.json'),
  ], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', env: {
    ...process.env, MULTICC_RUST_ADDON: path.join(__dirname, 'fixtures', 'absent-shared-host-addon.node'),
  } });
  const observed = JSON.parse(result);
  for (const [name, row] of Object.entries(reference)) assert.deepEqual(observed[name], row.bootstrap, name);
});
