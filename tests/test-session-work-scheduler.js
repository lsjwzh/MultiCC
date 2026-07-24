'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createOrchestrationStore } = require('../src/orchestration-store');
const { createOutbox } = require('../src/outbox');
const { createSessionWorkScheduler } = require('../src/session-work-scheduler');

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-session-scheduler-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = options.now || 1_000;
  const store = createOrchestrationStore({
    file: path.join(dir, 'orchestration.json'),
    now: () => clock,
  });
  const outbox = createOutbox({
    store,
    now: () => clock,
    leaseTokenFactory: (() => {
      let sequence = 0;
      return () => `lease-${++sequence}`;
    })(),
  });
  const events = [];
  const scheduler = createSessionWorkScheduler({
    store,
    now: () => clock,
    onEvent: event => events.push(event),
  });
  return {
    store,
    outbox,
    scheduler,
    events,
    advance(ms = 1) { clock += ms; },
  };
}

async function claimOne(harness, sessionId = 's1') {
  const claims = await harness.outbox.claim({
    workerId: 'test-worker',
    limit: 8,
    selectSessionItem: harness.scheduler.selectSessionItem,
  });
  const item = claims.find(candidate => candidate.sessionId === sessionId) || null;
  if (!item) return null;
  const claimed = await harness.scheduler.claim(item);
  assert.equal(claimed.ok, true);
  return item;
}

async function startClaim(harness, item) {
  assert.equal((await harness.outbox.ack(item.id, item.leaseToken)).ok, true);
  assert.equal((await harness.scheduler.started(item)).ok, true);
}

test('idle starts one item and running work keeps later messages in strict FIFO order', async t => {
  const h = fixture(t);
  const first = await h.scheduler.admit({
    sessionId: 's1', text: 'first', idempotencyKey: 'first',
  });
  const firstClaim = await claimOne(h);
  assert.equal(firstClaim.id, first.entry.id);
  await startClaim(h, firstClaim);

  const second = await h.scheduler.admit({
    sessionId: 's1', text: 'second', idempotencyKey: 'second',
  });
  const third = await h.scheduler.admit({
    sessionId: 's1', text: 'third', idempotencyKey: 'third',
  });
  assert.equal(h.events.find(event => event.entryId === second.entry.id)?.schedulerState, 'running');
  assert.equal(await claimOne(h), null, 'an active task closes normal delivery admission');

  assert.equal((await h.scheduler.complete('s1')).ok, true);
  const secondClaim = await claimOne(h);
  assert.equal(secondClaim.id, second.entry.id);
  await startClaim(h, secondClaim);
  assert.equal(await claimOne(h), null);

  assert.equal((await h.scheduler.complete('s1')).ok, true);
  const thirdClaim = await claimOne(h);
  assert.equal(thirdClaim.id, third.entry.id);
});

test('error and user-input waiting freeze future work while a correlated control resumes active', async t => {
  const h = fixture(t);
  const active = await h.scheduler.admit({
    sessionId: 's1',
    text: 'active',
    options: { taskId: 'task-a' },
    idempotencyKey: 'active',
  });
  const activeClaim = await claimOne(h);
  await startClaim(h, activeClaim);
  const future = await h.scheduler.admit({
    sessionId: 's1', text: 'future', idempotencyKey: 'future',
  });

  await h.scheduler.freeze('s1', 'error');
  assert.equal(await claimOne(h), null);
  const retry = await h.scheduler.resolve('s1', {
    action: 'retry',
    text: 'retry active',
    idempotencyKey: 'retry-a',
  });
  assert.equal(retry.ok, true);
  const retryClaim = await claimOne(h);
  assert.equal(retryClaim.payload.workKind, 'retry');
  assert.notEqual(retryClaim.id, future.entry.id);
  await startClaim(h, retryClaim);

  await h.scheduler.freeze('s1', 'awaiting_user_input', {
    requestId: 'question-1',
    expectedTaskId: 'task-a',
  });
  const wrong = await h.scheduler.admit({
    sessionId: 's1',
    text: 'wrong answer',
    workKind: 'answer',
    requestId: 'question-2',
    activeEntryId: active.entry.id,
    idempotencyKey: 'wrong',
  });
  assert.equal(wrong.code, 'request_id_mismatch');
  const answer = await h.scheduler.admit({
    sessionId: 's1',
    text: 'approved',
    workKind: 'answer',
    requestId: 'question-1',
    activeEntryId: active.entry.id,
    idempotencyKey: 'answer',
  });
  assert.equal(answer.ok, true);
  assert.equal(h.events.find(event => event.entryId === answer.entry.id)?.schedulerState, 'frozen');
  const answerClaim = await claimOne(h);
  assert.equal(answerClaim.payload.workKind, 'answer');
  await startClaim(h, answerClaim);

  await h.scheduler.complete('s1', { expectedTaskId: 'task-a' });
  assert.equal((await claimOne(h)).id, future.entry.id);
});

test('idempotency keys deduplicate admission and concurrent completion cannot double-claim', async t => {
  const h = fixture(t);
  const first = await h.scheduler.admit({
    sessionId: 's1', text: 'same', idempotencyKey: 'stable-key',
  });
  const duplicate = await h.scheduler.admit({
    sessionId: 's1', text: 'same', idempotencyKey: 'stable-key',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.entry.id, first.entry.id);

  const firstClaim = await claimOne(h);
  await startClaim(h, firstClaim);
  await Promise.all([
    h.scheduler.admit({ sessionId: 's1', text: 'next', idempotencyKey: 'next' }),
    h.scheduler.complete('s1'),
    h.scheduler.complete('s1'),
  ]);
  const claims = await Promise.all([claimOne(h), claimOne(h)]);
  assert.equal(claims.filter(Boolean).length, 1);
});

test('identical messages without an idempotency key remain distinct FIFO entries', async t => {
  const h = fixture(t);
  const first = await h.scheduler.admit({ sessionId: 's1', text: 'same body' });
  const second = await h.scheduler.admit({ sessionId: 's1', text: 'same body' });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, false);
  assert.notEqual(first.entry.id, second.entry.id);
  assert.deepEqual(
    (await h.scheduler.status('s1')).queued.map(item => item.entryId),
    [first.entry.id, second.entry.id],
  );
});

test('restart freezes an unproven active run and legacy unresolved state conservatively', async t => {
  const h = fixture(t);
  await h.scheduler.admit({
    sessionId: 's1', text: 'active', idempotencyKey: 'active',
  });
  const activeClaim = await claimOne(h);
  await startClaim(h, activeClaim);
  await h.scheduler.admit({
    sessionId: 's1', text: 'queued', idempotencyKey: 'queued',
  });

  const recovered = await h.scheduler.recover({
    isBusy: () => false,
    stateForSession: () => ({ classifyState: 'P' }),
  });
  assert.equal(recovered.changes, 1);
  const state = await h.scheduler.status('s1');
  assert.equal(state.state, 'frozen');
  assert.equal(state.freezeReason, 'unknown_interruption');
  assert.equal(await claimOne(h), null);

  const h2 = fixture(t);
  await h2.scheduler.admit({
    sessionId: 'legacy', text: 'queued legacy', idempotencyKey: 'legacy',
  });
  await h2.store.mutate(draft => {
    delete draft.sessionSchedules.legacy;
  });
  await h2.scheduler.recover({
    isBusy: () => false,
    stateForSession: () => ({ classifyState: 'W', startedAt: 10 }),
  });
  const legacy = await h2.scheduler.status('legacy');
  assert.equal(legacy.state, 'frozen');
  assert.equal(legacy.freezeReason, 'awaiting_user_input');

  const h3 = fixture(t);
  await h3.outbox.enqueue({
    id: 'legacy-pending',
    sessionId: 'unknown-legacy',
    payload: { type: 'legacy.message', message: 'old pending work' },
  });
  await h3.scheduler.recover({
    isBusy: () => false,
    stateForSession: () => ({ classifyState: null }),
  });
  const unknownLegacy = await h3.scheduler.status('unknown-legacy');
  assert.equal(unknownLegacy.state, 'frozen');
  assert.equal(unknownLegacy.freezeReason, 'legacy_unresolved');
  assert.equal(await claimOne(h3, 'unknown-legacy'), null);
});

test('restart advances only when the active run has timestamped structured success', async t => {
  const h = fixture(t);
  const active = await h.scheduler.admit({
    sessionId: 's1',
    text: 'active',
    options: { taskId: 'task-active' },
    idempotencyKey: 'active',
  });
  const activeClaim = await claimOne(h);
  await startClaim(h, activeClaim);
  h.advance();
  const queued = await h.scheduler.admit({
    sessionId: 's1',
    text: 'queued',
    options: { taskId: 'task-queued' },
    idempotencyKey: 'queued',
  });

  const recovered = await h.scheduler.recover({
    isBusy: () => false,
    stateForSession: () => ({
      classifyState: 'D',
      taskId: 'task-active',
      endedAt: 1_001,
    }),
  });
  assert.equal(recovered.changes, 1);
  const state = await h.scheduler.status('s1');
  assert.equal(state.state, 'idle');
  assert.equal(state.active, null);
  assert.equal(h.events.some(event => (
    event.type === 'completed'
      && event.entryId === active.entry.id
      && event.recovered === true
  )), true);
  assert.equal((await claimOne(h)).id, queued.entry.id);

  const stale = fixture(t);
  await stale.scheduler.admit({
    sessionId: 's2',
    text: 'new task',
    options: { taskId: 'task-new' },
    idempotencyKey: 'new-task',
  });
  const staleClaim = await claimOne(stale, 's2');
  await startClaim(stale, staleClaim);
  await stale.scheduler.recover({
    isBusy: () => false,
    stateForSession: () => ({
      classifyState: 'D',
      taskId: 'task-old',
      endedAt: 2_000,
    }),
  });
  const staleState = await stale.scheduler.status('s2');
  assert.equal(staleState.state, 'frozen');
  assert.equal(staleState.freezeReason, 'unknown_interruption');
});
