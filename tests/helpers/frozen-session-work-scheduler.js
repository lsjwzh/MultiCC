'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Freeze the four still-JavaScript transitions before migrating them. Compile
// with their original virtual filename so their relative imports keep working;
// the actual source is a checked-in snapshot, never read from the live file.
function loadDomainMigrationOracle(mutate = source => source) {
  const Module = require('node:module');
  const filename = path.resolve(__dirname, '../../src/session-work/scheduler.js');
  const snapshot = fs.readFileSync(path.join(__dirname, 'scheduler-before-domain-migration.js.txt'), 'utf8');
  const digest = require('node:crypto').createHash('sha256').update(snapshot).digest('hex');
  assert.equal(digest, 'f2d34115aa9f3dff98bd49c19ad5d34f30a9fbeb3735b524ddf069eb0b32dbb9');
  const oracle = new Module(filename, module);
  oracle.filename = filename;
  oracle.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = oracle.require.bind(oracle);
  oracle.require = id => {
    if (id === './user-input') return require('./legacy-session-work-user-input');
    if (id === '../outbox') return require('./frozen-e960f6eb/outbox');
    return originalRequire(id);
  };
  oracle._compile(mutate(snapshot), filename);
  return oracle.exports.createSessionWorkScheduler;
}

module.exports = loadDomainMigrationOracle;
