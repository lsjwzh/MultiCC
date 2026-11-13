'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');
const { createOrchestrationSqliteStore } = require('../src/orchestration/sqlite-store');
const { createSessionWorkScheduler } = require('../src/session-work/scheduler');

// These two tests reproduce the constraints on real SQLite without claiming
// that a simulated worker delay is a production implementation.
test('real SQLite admit exposes the synchronous large-payload cost', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-acceptance-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite') });
  t.after(async () => { await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const scheduler = createSessionWorkScheduler({ store });
  const start = performance.now();
  let delay;
  const timer = new Promise(resolve => setTimeout(() => { delay = performance.now() - start; resolve(); }, 0));
  const result = await scheduler.admit({ sessionId: 's', text: 'x'.repeat(4 * 1024 * 1024), idempotencyKey: 'key' });
  await timer;
  assert.equal(result.ok, true);
  t.diagnostic(`4 MiB text: zero-delay timer waited ${delay.toFixed(1)} ms`);
});

test('pre-snapshot worker yield can change answer task ownership', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-timing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  async function run(simulatedWorker) {
    const sqlite = createOrchestrationSqliteStore({ file: path.join(dir, `${simulatedWorker}.sqlite`), now: () => 1000 });
    try {
      let pending = { requestId: 'r', taskId: 'task' };
      const store = simulatedWorker ? {
        read: (...args) => sqlite.read(...args),
        mutate: async fn => { await new Promise(resolve => setImmediate(resolve)); return sqlite.mutate(fn); },
      } : sqlite;
      const scheduler = createSessionWorkScheduler({ store, now: () => 1000, getPendingUserInput: () => pending });
      const admission = scheduler.admit({ sessionId: 's', text: 'answer', requestId: 'r', idempotencyKey: 'key' });
      queueMicrotask(() => { pending = { requestId: 'other', taskId: 'task' }; });
      const result = await admission;
      const state = await sqlite.snapshot();
      return { taskId: result.entry.payload.taskId, awaiting: state.sessionSchedules.s.awaitingRequestId };
    } finally { await sqlite.close({ exportRollback: false }); }
  }
  assert.deepEqual(await run(false), { taskId: 'task', awaiting: 'r' });
  assert.deepEqual(await run(true), { taskId: null, awaiting: null });
});

test('scheduler admission is a synchronous Rust domain command without Node canonicalization', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/session-work/scheduler.js'), 'utf8');
  const start = source.indexOf('  async function admit(');
  const end = source.indexOf('  async function claim(', start);
  assert.ok(start >= 0 && end > start, 'cannot locate scheduler admission');
  const body = source.slice(start, end);
  assert.equal(/\b(?:compactJson|admitOutboxItem|stableEntryId)\s*\(|\b(?:schedule|payload|item)(?:\.[\w$]+|\[[^\]]+\])+\s*=(?!=)/.test(body), false,
    'scheduler.admit still canonicalizes and owns schedule/outbox state in Node; synchronous N-API migration alone would retain unbounded large-payload work');
  assert.match(body, /(?:getNative\(\)\.scheduleAdmit\w*\(|store\.executeScheduleAdmit\()/,
    'scheduler.admit must call a Rust domain command');
  assert.match(body, /(?:store\.mutateSync\(|store\.executeScheduleAdmit\()/,
    'the admitted schedule and outbox must commit in one synchronous host callback');
});
