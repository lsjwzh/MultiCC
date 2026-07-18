'use strict';

const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const inventory = require('../governance/runtime-write-inventory.json');
const { assertTestDir, createPaths } = require('../src/paths');
const { validateInventory } = require('../scripts/check-runtime-write-inventory');

test('runtime write inventory is current and every exception has ownership and a migration strategy', () => {
  assert.deepEqual(validateInventory(inventory), []);
  for (const entry of inventory.entries) {
    assert.ok(entry.owner);
    assert.ok(entry.rationale);
    assert.ok(entry.migrationStrategy);
  }
});

test('artifacts and detached paths resolve beneath MULTICC_DATA_DIR', (t) => {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-runtime-root-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = createPaths({ dataDir: root });
  assert.equal(paths.artifactsDir, path.join(root, 'artifacts'));
  assert.equal(paths.detachedDir, path.join(root, 'detached'));

  const script = [
    "const a=require('./src/artifacts')",
    "const d=require('./src/detached')",
    "process.stdout.write(JSON.stringify({artifacts:a.ARTIFACTS_DIR,detached:d.BASE_DIR,env:process.env.MULTICC_ARTIFACTS_DIR}))",
  ].join(';');
  const result = childProcess.execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, MULTICC_DATA_DIR: root },
    encoding: 'utf8',
  });
  const resolved = JSON.parse(result);
  assert.deepEqual(resolved, { artifacts: paths.artifactsDir, detached: paths.detachedDir, env: paths.artifactsDir });
});
