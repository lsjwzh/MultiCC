'use strict';

// Isolated differential test for the Rust transaction. Production continues
// to use the host transaction until stopped-writer fencing is migrated.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getNative } = require('../src/native/runtime');
const { createTaskShellStore } = require('../src/task-shell/store');
const { createDeliveryEvidence } = require('../src/task-routing/evidence');
const { createDeliveryEvidence: createLegacyDeliveryEvidence } = require('./helpers/legacy-delivery-evidence');
const { databaseConstructor } = require('../src/sqlite/driver');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-finalize-diff-'));
  const a = path.join(dir, 'host.sqlite'), b = path.join(dir, 'rust.sqlite');
  const left = createTaskShellStore(a), right = createTaskShellStore(b);
  const evidence = createLegacyDeliveryEvidence(left, { now: () => 12345 });
  const seed = createDeliveryEvidence(right, { now: () => 12345 });
  const raw = new (getNative().RustTaskStore)(b);
  const invoke = args => JSON.parse(raw.run(JSON.stringify({ op: 'finalizeDelivery', now: 12345, ...args })));
  t.after(() => { raw.run('{"op":"close"}'); left.close(); right.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const begin = () => {
    for (const e of [evidence, seed]) {
      e.begin({ sessionId: 's', turnId: 'turn-1', taskId: 'task-1', receiptId: 'receipt-1',
        workspaceId: 'w', workspacePath: '/fixture/workspace', baseRef: 'main', startCodeRevision: 'start' });
      e.attempt('turn-1', 'attempt-1');
    }
  };
  const rows = store => Object.fromEntries(['delivery:run', 'delivery:attempt', 'delivery:latest',
    'task-first:run-result', 'task-first:integration', 'task-first:writer-barrier'].map(kind => [kind, store.list(kind)]));
  return { a, b, left, right, evidence, seed, invoke, begin, rows };
}
const base = { attemptId: 'attempt-1', outcome: 'succeeded', resultDurable: true, usageDurable: true, pendingInput: false };
const code = { revision: 'revision-1', head: 'head-1', repoId: 'repo-1', dirty: true };

test('an absent run remains a no-op, even when its id is not a valid fact id', async t => {
  const f = fixture(t);
  assert.equal(await f.evidence.finalize('invalid id', base, { code, error: null }), null);
  assert.equal(f.invoke({ turnId: 'invalid id', result: base, code, error: null }), null);
  assert.deepEqual(f.rows(f.right), f.rows(f.left));
});

for (const [name, result, observed, error] of [
  ['success', base, code, null],
  ['failed', { ...base, outcome: 'failed' }, code, null],
  ['cancelled', { ...base, outcome: 'cancelled' }, code, null],
  ['waiting', { ...base, outcome: 'waiting', pendingInput: true }, code, null],
  ['non-durable', { ...base, usageDurable: false }, code, null],
  ['observation failure', base, null, 'code_observation_failed'],
]) test(`native result transaction matches host: ${name}`, async t => {
  const f = fixture(t); f.begin();
  const expected = await f.evidence.finalize('turn-1', result, { code: observed, error });
  const actual = f.invoke({ turnId: 'turn-1', result, code: observed, error });
  assert.deepEqual(actual, expected);
  assert.deepEqual(f.rows(f.right), f.rows(f.left));
  assert.deepEqual(f.invoke({ turnId: 'turn-1', result, code: observed, error }), expected, 'idempotent replay');
});

test('native finalization correlates the most recent matching integration journal', async t => {
  const f = fixture(t); f.begin();
  const journal = { id: 'merge-1', state: 'published', sessionId: 's', repoId: 'repo-1', baseRef: 'main',
    sourceRevision: 'revision-1', publishedRevision: 'published-1', sourceHead: 'head-1', integrationHead: 'head-main' };
  f.left.set('delivery:merge', journal.id, journal); f.right.set('delivery:merge', journal.id, journal);
  const expected = await f.evidence.finalize('turn-1', base, { code, error: null });
  assert.deepEqual(f.invoke({ turnId: 'turn-1', result: base, code, error: null }), expected);
  assert.deepEqual(f.rows(f.right), f.rows(f.left));
});

test('native finalization rejects stale attempts without writing', async t => {
  const f = fixture(t); f.begin();
  const stale = { ...base, attemptId: 'old-attempt' };
  await assert.rejects(f.evidence.finalize('turn-1', stale, { code, error: null }), /final_attempt_mismatch/);
  assert.throws(() => f.invoke({ turnId: 'turn-1', result: stale, code, error: null }), /final_attempt_mismatch/);
  assert.deepEqual(f.rows(f.right), f.rows(f.left));
});

test('native finalization rejects a superseded run without writing', async t => {
  const f = fixture(t); f.begin();
  for (const store of [f.left, f.right]) store.set('delivery:latest', 's', { runId: 'new-turn' });
  await assert.rejects(f.evidence.finalize('turn-1', base, { code, error: null }), /final_attempt_mismatch/);
  assert.throws(() => f.invoke({ turnId: 'turn-1', result: base, code, error: null }), /final_attempt_mismatch/);
  assert.deepEqual(f.rows(f.right), f.rows(f.left));
  assert.equal(f.right.get('delivery:run', 'turn-1').state, 'running');
});

test('native finalization preserves unicode attempt keys and updates another connection epoch', async t => {
  const f = fixture(t); f.begin();
  const attempt = '重试-😀-"-\\';
  for (const evidence of [f.evidence, f.seed]) evidence.attempt('turn-1', attempt);
  const result = { ...base, attemptId: attempt };
  const epoch = f.right.epoch(['task-first:run-result']);
  const expected = await f.evidence.finalize('turn-1', result, { code, error: null });
  assert.deepEqual(f.invoke({ turnId: 'turn-1', result, code, error: null }), expected);
  assert.notEqual(f.right.epoch(['task-first:run-result']), epoch);
  assert.deepEqual(f.right.list('task-first:run-result'), [expected]);
  assert.deepEqual(f.rows(f.right), f.rows(f.left));
});

test('a conflicting immutable integration rolls back the native result transaction', async t => {
  const f = fixture(t); f.begin();
  const journal = { id: 'merge-1', state: 'published', sessionId: 's', repoId: 'repo-1', baseRef: 'main',
    sourceRevision: 'revision-1', publishedRevision: 'published-1', sourceHead: 'head-1', integrationHead: 'head-main' };
  const { createHash } = require('node:crypto');
  const id = 'integration_' + createHash('sha256').update(JSON.stringify(['turn-1', 'attempt-1', journal.id])).digest('hex');
  for (const store of [f.left, f.right]) {
    store.set('delivery:merge', journal.id, journal);
    store.set('task-first:integration', id, { id, conflicting: true });
  }
  await assert.rejects(f.evidence.finalize('turn-1', base, { code, error: null }), /immutable_fact_conflict/);
  assert.throws(() => f.invoke({ turnId: 'turn-1', result: base, code, error: null }), /immutable_fact_conflict/);
  assert.deepEqual(f.rows(f.right), f.rows(f.left));
  assert.equal(f.right.get('task-first:run-result', 'turn-1'), null);
});

for (const missing of ['id', 'sourceHead', 'integrationHead']) test(`an integration journal without ${missing} cannot create a fabricated receipt`, async t => {
  const f = fixture(t); f.begin();
  const journal = { id: 'merge-legacy', state: 'published', sessionId: 's', repoId: 'repo-1', baseRef: 'main',
    sourceRevision: 'revision-1', sourceHead: 'head-1', integrationHead: 'head-main' };
  delete journal[missing];
  for (const store of [f.left, f.right]) store.set('delivery:merge', 'merge-legacy', journal);
  await assert.rejects(f.evidence.finalize('turn-1', base, { code, error: null }), /invalid_record_value/);
  assert.throws(() => f.invoke({ turnId: 'turn-1', result: base, code, error: null }), /invalid_record_value/);
  assert.deepEqual(f.rows(f.right), f.rows(f.left));
  assert.equal(f.right.get('task-first:run-result', 'turn-1'), null);
});

test('a historical run without an attempt id cannot create a result fact', async t => {
  const f = fixture(t); f.begin();
  for (const store of [f.left, f.right]) {
    const run = store.get('delivery:run', 'turn-1');
    delete run.attemptId;
    store.set('delivery:run', 'turn-1', run);
  }
  const result = { ...base };
  delete result.attemptId;
  await assert.rejects(f.evidence.finalize('turn-1', result, { code, error: null }), /invalid_record_value/);
  assert.throws(() => f.invoke({ turnId: 'turn-1', result, code, error: null }), /invalid_record_value/);
  assert.deepEqual(f.rows(f.right), f.rows(f.left));
});

test('a missing attempt id is distinct from an explicit null', async t => {
  const f = fixture(t); f.begin();
  for (const store of [f.left, f.right]) {
    const run = store.get('delivery:run', 'turn-1');
    delete run.attemptId;
    store.set('delivery:run', 'turn-1', run);
  }
  const result = { ...base, attemptId: null };
  await assert.rejects(f.evidence.finalize('turn-1', result, { code, error: null }), /final_attempt_mismatch/);
  assert.throws(() => f.invoke({ turnId: 'turn-1', result, code, error: null }), /final_attempt_mismatch/);
  assert.deepEqual(f.rows(f.right), f.rows(f.left));
});

test('an observation without an error field cannot silently record null', async t => {
  const f = fixture(t); f.begin();
  await assert.rejects(f.evidence.finalize('turn-1', base, { code }), /invalid_record_value/);
  assert.throws(() => f.invoke({ turnId: 'turn-1', result: base, code }), /invalid_record_value/);
  assert.deepEqual(f.rows(f.right), f.rows(f.left));
});

test('native finalization rolls the entire transaction back after an SQLite failure', t => {
  const f = fixture(t); f.begin();
  const db = new (databaseConstructor())(f.b);
  db.exec("CREATE TRIGGER reject_attempt BEFORE INSERT ON shell_records WHEN NEW.kind = 'delivery:attempt' BEGIN SELECT RAISE(ABORT, 'injected_failure'); END;");
  try {
    assert.throws(() => f.invoke({ turnId: 'turn-1', result: base, code, error: null }), /injected_failure/);
    assert.equal(f.right.get('delivery:run', 'turn-1').state, 'running');
    assert.equal(f.right.get('task-first:run-result', 'turn-1'), null);
    assert.deepEqual(f.rows(f.right), f.rows(f.left));
  } finally { db.close(); }
});

test('stopped delivery persists the result and barrier in one lease-checked transaction', async t => {
  const f = fixture(t); f.begin();
  const lease = { id: 'lease-1', workspaceId: 'w', sessionId: 's', epoch: 'epoch-1', generation: 1, state: 'running' };
  f.right.set('workspace:lease', 'w', lease);
  const expected = await f.evidence.finalize('turn-1', base, { code, error: null });
  const barrier = f.evidence.recordWriterBarrier({ sessionId: 's', turnId: 'turn-1', workspaceId: 'w',
    leaseId: lease.id, generation: lease.generation, code });
  const result = f.invoke({ op: 'finalizeStoppedDelivery', turnId: 'turn-1', sessionId: 's', workspaceId: 'w',
    leaseId: lease.id, generation: lease.generation, epoch: lease.epoch, result: base, code, error: null });
  assert.deepEqual(result, { run: expected, barrier, barrierError: null });
  assert.deepEqual(f.rows(f.right), f.rows(f.left));
});

test('stale lease and failed barrier write never publish partial result evidence', t => {
  const f = fixture(t); f.begin();
  const lease = { id: 'lease-1', workspaceId: 'w', sessionId: 's', epoch: 'epoch-1', generation: 1, state: 'running' };
  f.right.set('workspace:lease', 'w', lease);
  const input = { op: 'finalizeStoppedDelivery', turnId: 'turn-1', sessionId: 's', workspaceId: 'w',
    leaseId: lease.id, generation: 1, epoch: lease.epoch, result: base, code, error: null };
  assert.throws(() => f.invoke({ ...input, generation: 2 }), /workspace_lease_stale/);
  const db = new (databaseConstructor())(f.b);
  db.exec("CREATE TRIGGER reject_barrier BEFORE INSERT ON shell_records WHEN NEW.kind = 'task-first:writer-barrier' BEGIN SELECT RAISE(ABORT, 'barrier_failure'); END;");
  try {
    assert.throws(() => f.invoke(input), /barrier_failure/);
    assert.equal(f.right.get('delivery:run', 'turn-1').state, 'running');
    assert.equal(f.right.get('task-first:run-result', 'turn-1'), null);
    assert.equal(f.right.list('task-first:writer-barrier').length, 0);
  } finally { db.close(); }
});

test('failed observation persists an unverified result without a fabricated barrier', async t => {
  const f = fixture(t); f.begin();
  const lease = { id: 'lease-1', workspaceId: 'w', sessionId: 's', epoch: 'epoch-1', generation: 1, state: 'running' };
  f.right.set('workspace:lease', 'w', lease);
  const expected = await f.evidence.finalize('turn-1', base, { code: null, error: 'code_observation_failed' });
  const result = f.invoke({ op: 'finalizeStoppedDelivery', turnId: 'turn-1', sessionId: 's', workspaceId: 'w',
    leaseId: lease.id, generation: 1, epoch: lease.epoch, result: base, code: null, error: 'code_observation_failed' });
  assert.deepEqual(result, { run: expected, barrier: null, barrierError: 'barrier_code_changed' });
  assert.equal(result.run.endCodeRevision, null);
  assert.equal(f.right.list('task-first:writer-barrier').length, 0);
});
