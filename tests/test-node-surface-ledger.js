'use strict';

// The ledger must stay reconciled with the runtime capture. The negative cases
// prove the checker is not vacuous: each way the ledger can go stale is
// injected into a copy and must be reported.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseInventory, reconcile, fileMatches } = require('../scripts/check-node-surface-ledger');

const root = path.join(__dirname, '..');
const ledger = JSON.parse(fs.readFileSync(path.join(root, 'docs/rust-migration/node-surface-ledger.json'), 'utf8'));
const inventory = parseInventory(fs.readFileSync(path.join(root, 'docs/backend-runtime-inventory.md'), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));

assert.deepEqual(reconcile(ledger, inventory), [], 'the committed ledger matches the committed capture');
assert.equal(inventory.routes.length, ledger.capture.routes);
assert.equal(inventory.layers.length, ledger.middleware.total);

// A cluster that miscounts its routes.
{
  const broken = clone(ledger);
  broken.clusters[0].routes += 1;
  const problems = reconcile(broken, inventory);
  assert.ok(problems.some(p => p.includes(`cluster ${broken.clusters[0].id}`)), problems.join('\n'));
}
// A route nobody claims (a new Node route appears).
{
  const grown = clone(inventory);
  grown.routes.push({ source: 'src/routes/brand-new.js', methods: 'GET', route: '/api/brand-new' });
  const problems = reconcile(ledger, grown);
  assert.ok(problems.some(p => p.includes('not claimed by any cluster: src/routes/brand-new.js')), problems.join('\n'));
}
// A route claimed twice.
{
  const broken = clone(ledger);
  broken.clusters[1].files.push(broken.clusters[2].files[0]);
  const problems = reconcile(broken, inventory);
  assert.ok(problems.some(p => p.includes('claimed by 2 clusters')), problems.join('\n'));
}
// A middleware layer that appears but is not placed.
{
  const grown = clone(inventory);
  grown.layers.push({ position: 999, name: 'newLayer', key: 'newLayer@/#1' });
  const problems = reconcile(ledger, grown);
  assert.ok(problems.some(p => p.includes('not placed in any group: newLayer@/#1')), problems.join('\n'));
}
// A middleware position in two groups.
{
  const broken = clone(ledger);
  broken.middleware.groups[1].layers.push(broken.middleware.groups[0].layers[0]);
  const problems = reconcile(broken, inventory);
  assert.ok(problems.some(p => p.includes('is in two groups')), problems.join('\n'));
}
// A migrated route disappears from the capture: the stale ledger must complain.
{
  const shrunk = clone(inventory);
  shrunk.routes = shrunk.routes.filter(route => route.source !== 'src/routes/voice.js');
  const problems = reconcile(ledger, shrunk);
  assert.ok(problems.some(p => p.includes('cluster router-tools')), problems.join('\n'));
}
// Positions are volatile: shifting every layer position (as happens when any layer is
// added or removed earlier in the chain) must not be reported as drift.
{
  const shifted = clone(inventory);
  shifted.layers = shifted.layers.map(layer => ({ ...layer, position: layer.position + 7 }));
  assert.deepEqual(reconcile(ledger, shifted), [], 'a pure position shift is not drift');
}
assert.equal(fileMatches('src/routes/*-host.js', 'src/routes/scan-history-host.js'), true);
assert.equal(fileMatches('src/routes/*-host.js', 'src/routes/sub/x-host.js'), false);

console.log(`node surface ledger: ${inventory.routes.length} routes / ${inventory.layers.length} middleware layers reconciled; 6 drift cases rejected, position shift tolerated`);
