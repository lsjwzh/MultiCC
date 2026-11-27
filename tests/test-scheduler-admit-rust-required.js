'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');
const { createOrchestrationSqliteStore } = require('../src/native/binding').orchestrationSqlite;
const { createSessionWorkScheduler } = require('../src/session-work');

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
  const result = await scheduler.admit({ sessionId: 's', text: 'x'.repeat(4 * 1024 * 1024), idempotencyKey: 'key',
    initialState: { pendingQuestion: null, activeTurn: null, category: null }, expectedVersion: 0 });
  await timer;
  assert.equal(result.ok, true);
  const request = { sessionId: 's', text: 'once', hostAdmission: true,
    options: { idempotencyKey: 'host-key', clientMsgId: 'client-key', deliveryId: 'delivery-key' } };
  const first = await scheduler.admit(request);
  const replay = await scheduler.admit(request);
  const expectedSuffix = require('node:crypto').createHash('sha256')
    .update('s\0key:host-key', 'utf8').digest('hex').slice(0, 40);
  assert.equal(first.entry.id, `session-work:${expectedSuffix}`);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.entry.id, first.entry.id);
  const backfilled = await scheduler.admit({ sessionId: 'backfill', text: 'yes', hostAdmission: true,
    options: { userInputRequestId: 'question', clientMsgId: 'answer' }, expectedVersion: 0,
    initialState: { pendingQuestion: { requestId: 'question', taskId: 'task', resolved: false },
      activeTurn: null, category: 'W' } });
  assert.equal(backfilled.ok, true);
  assert.deepEqual(backfilled.notification,
    { type: 'user_input_resolved', requestId: 'question', taskId: 'task' });
  const backfilledState = await store.sessionWorkState({ action: 'read', sessionId: 'backfill' });
  assert.equal(backfilledState.pendingQuestion.resolved, true);
  assert.deepEqual(backfilledState.pendingQuestion.resolvedNotification, backfilled.notification);
  t.diagnostic(`4 MiB text: zero-delay timer waited ${delay.toFixed(1)} ms`);
});

test('pre-snapshot worker yield can change answer task ownership', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-timing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  async function run(simulatedWorker) {
    const sqlite = createOrchestrationSqliteStore({ file: path.join(dir, `${simulatedWorker}.sqlite`), now: () => 1000 });
    try {
      await sqlite.sessionWorkState({ action: 'readOrInitialize', sessionId: 's', initial: {
        pendingQuestion: { requestId: 'r', taskId: 'task' }, activeTurn: null, category: null,
      } });
      const store = simulatedWorker ? {
        read: (...args) => sqlite.read(...args),
        mutate: (...args) => sqlite.mutate(...args),
        executeScheduleAdmit: async (input, admittedAt) => {
          await new Promise(resolve => setImmediate(resolve));
          return sqlite.executeScheduleAdmit(input, admittedAt);
        },
      } : sqlite;
      const scheduler = createSessionWorkScheduler({ store, now: () => 1000 });
      const request = { sessionId: 's', text: 'answer', hostAdmission: true,
        options: { userInputRequestId: 'r' }, idempotencyKey: 'key' };
      const admission = scheduler.admit(request);
      const changed = Promise.resolve().then(() => sqlite.sessionWorkState({ action: 'write', updates: [{
        sessionId: 's', expectedVersion: 1,
        pendingQuestion: { requestId: 'other', taskId: 'task' }, activeTurn: null, category: null,
      }] })).catch(error => {
        if (!/version conflict/.test(error.message)) throw error;
      });
      const result = await admission;
      await changed;
      const state = await sqlite.snapshot();
      const workState = await sqlite.sessionWorkState({ action: 'read', sessionId: 's' });
      assert.equal(workState.pendingQuestion.requestId, simulatedWorker ? 'other' : 'r');
      assert.equal(workState.pendingQuestion.resolved === true, !simulatedWorker);
      assert.equal(result.answerConsumed?.requestId || null, simulatedWorker ? null : 'r');
      return { taskId: result.entry.payload.taskId, awaiting: state.sessionSchedules.s.awaitingRequestId };
    } finally { await sqlite.close({ exportRollback: false }); }
  }
  assert.deepEqual(await run(false), { taskId: 'task', awaiting: 'r' });
  assert.deepEqual(await run(true), { taskId: null, awaiting: null });
});

test('scheduler admission is a synchronous Rust domain command without Node canonicalization', () => {
  const bridge = fs.readFileSync(path.join(__dirname, '../src/session-work/index.js'), 'utf8');
  assert.match(bridge, /loadLegacyHostApi\('sessionWork'/);
  const owner = fs.readFileSync(path.join(__dirname, '../native/addon/src/session_work_host.rs'), 'utf8');
  assert.match(owner, /session_work_scheduler::session_work_scheduler_api\(env\)/);
  assert.doesNotMatch(bridge, /draft\.|compactJson|admitOutboxItem|stableEntryId/);
  assert.equal(fs.existsSync(path.join(__dirname, '../src/session-work/scheduler.js')), false);
  const command = fs.readFileSync(path.join(__dirname, '../native/addon/src/session_work_scheduler/operations.rs'), 'utf8');
  assert.match(command, /c"executeScheduleAdmit"/);
});
