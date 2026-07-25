'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createOrchestrationStore } = require('../src/orchestration-store');
const { createOutbox } = require('../src/outbox');
const {
  createSessionWorkScheduler,
  runStateForFreezeReason,
} = require('../src/session-work-scheduler');

test('runStateForFreezeReason maps each freeze reason to a truthful runState', () => {
  // User / external hand-off → waiting (the only reasons that mean "act now").
  assert.equal(runStateForFreezeReason('awaiting_user_input'), 'waiting');
  assert.equal(runStateForFreezeReason('awaiting_callback'), 'waiting');
  assert.equal(runStateForFreezeReason('waiting'), 'waiting');
  // Faults / interruptions → error, NOT a false "waiting on you".
  assert.equal(runStateForFreezeReason('error'), 'error');
  assert.equal(runStateForFreezeReason('classification_error'), 'error');
  assert.equal(runStateForFreezeReason('unknown_interruption'), 'error');
  assert.equal(runStateForFreezeReason('legacy_unresolved'), 'error');
  // Live work the scheduler will drive forward → running.
  assert.equal(runStateForFreezeReason('delivery_recovery'), 'running');
  assert.equal(runStateForFreezeReason('continuation_ready'), 'running');
  assert.equal(runStateForFreezeReason('incomplete_requires_resume'), 'running');
  // Deferred claim → queued.
  assert.equal(runStateForFreezeReason('prelaunch_deferred'), 'queued');
  // Unknown reason falls back to the legacy heuristic (safe backstop).
  assert.equal(runStateForFreezeReason('some_future_error_state'), 'error');
  assert.equal(runStateForFreezeReason('something_new'), 'waiting');
  assert.equal(runStateForFreezeReason(null), 'waiting');
  assert.equal(runStateForFreezeReason(undefined), 'waiting');
});

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
  assert.deepEqual(
    (await h.scheduler.status('s1')).queued.map(item => item.text),
    ['second', 'third'],
  );
  assert.deepEqual(
    h.events.find(event => event.entryId === third.entry.id)?.queuedItems.map(item => item.text),
    ['second', 'third'],
  );
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

test('legacy classifier waiting is released, while structured wait and error remain frozen', async t => {
  const waiting = fixture(t);
  await waiting.scheduler.admit({
    sessionId: 'waiting', text: 'active', idempotencyKey: 'active',
  });
  await startClaim(waiting, await claimOne(waiting, 'waiting'));
  await waiting.scheduler.admit({
    sessionId: 'waiting',
    text: '<img src=x onerror=alert(1)>\nqueued body',
    idempotencyKey: 'queued',
  });
  await waiting.scheduler.freeze('waiting', 'waiting');
  await waiting.scheduler.recover({
    isBusy: () => false,
    stateForSession: () => ({ classifyState: 'W' }),
  });
  const released = await waiting.scheduler.status('waiting');
  assert.equal(released.state, 'idle');
  assert.equal(released.active, null);
  assert.equal(released.queued[0].text, '<img src=x onerror=alert(1)>\nqueued body');
  assert.ok(await claimOne(waiting, 'waiting'));

  const callback = fixture(t);
  await callback.scheduler.admit({
    sessionId: 'callback', text: 'active', idempotencyKey: 'active',
  });
  await startClaim(callback, await claimOne(callback, 'callback'));
  await callback.scheduler.admit({
    sessionId: 'callback', text: 'future', idempotencyKey: 'future',
  });
  await callback.scheduler.freeze('callback', 'awaiting_callback');
  await callback.scheduler.recover({
    isBusy: () => false,
    hasPendingWait: () => true,
  });
  assert.equal((await callback.scheduler.status('callback')).state, 'frozen');
  assert.equal(await claimOne(callback, 'callback'), null);

  const failed = fixture(t);
  await failed.scheduler.admit({
    sessionId: 'failed', text: 'active', idempotencyKey: 'active',
  });
  await startClaim(failed, await claimOne(failed, 'failed'));
  await failed.scheduler.admit({
    sessionId: 'failed', text: 'future', idempotencyKey: 'future',
  });
  await failed.scheduler.freeze('failed', 'error');
  await failed.scheduler.recover({ isBusy: () => false });
  const frozen = await failed.scheduler.status('failed');
  assert.equal(frozen.state, 'frozen');
  assert.equal(frozen.freezeReason, 'error');
  assert.equal(await claimOne(failed, 'failed'), null);
});

test('chat input takes over post-turn assessing before older queued work without consuming that queue', async t => {
  const h = fixture(t);
  await h.scheduler.admit({
    sessionId: 's1', text: 'active', idempotencyKey: 'active',
  });
  await startClaim(h, await claimOne(h));
  const queued = await h.scheduler.admit({
    sessionId: 's1', text: 'already queued', idempotencyKey: 'queued',
  });
  await h.scheduler.turnEnded('s1');
  const next = await h.scheduler.admit({
    sessionId: 's1', text: 'next user message', idempotencyKey: 'next',
  });
  assert.equal(next.schedule.state, 'idle');
  assert.equal(next.schedule.active, null);
  assert.equal(next.schedule.lastDecision.action, 'supersede');
  assert.equal(next.schedule.lastDecision.reason, 'direct-user-message');
  assert.deepEqual(next.schedule.queued.map(item => item.text), ['already queued']);
  const takeover = await claimOne(h);
  assert.equal(takeover.id, next.entry.id);
  await startClaim(h, takeover);
  assert.deepEqual((await h.scheduler.status('s1')).queued.map(item => item.text), ['already queued']);
  assert.equal(await claimOne(h), null, 'older queue remains paused behind the direct takeover');
  assert.equal((await h.scheduler.complete('s1')).ok, true);
  assert.equal((await claimOne(h)).id, queued.entry.id);
});

test('direct takeover releases legacy waiting but preserves correlated input and callbacks', async t => {
  const waiting = fixture(t);
  await waiting.scheduler.admit({
    sessionId: 'waiting', text: 'active', idempotencyKey: 'active',
  });
  await startClaim(waiting, await claimOne(waiting, 'waiting'));
  await waiting.scheduler.freeze('waiting', 'awaiting_user_input');
  const resumed = await waiting.scheduler.admit({
    sessionId: 'waiting', text: 'plain user follow-up', idempotencyKey: 'follow-up',
  });
  assert.equal(resumed.schedule.state, 'idle',
    'legacy W without a structured request id is immediately taken over');
  assert.equal((await claimOne(waiting, 'waiting')).id, resumed.entry.id);

  const structured = fixture(t);
  await structured.scheduler.admit({
    sessionId: 'structured', text: 'active', idempotencyKey: 'active',
  });
  await startClaim(structured, await claimOne(structured, 'structured'));
  await structured.scheduler.freeze('structured', 'awaiting_user_input', { requestId: 'question-1' });
  await structured.scheduler.admit({
    sessionId: 'structured', text: 'uncorrelated follow-up', idempotencyKey: 'follow-up',
  });
  assert.equal((await structured.scheduler.status('structured')).state, 'frozen');
  assert.equal(await claimOne(structured, 'structured'), null,
    'a structured question still requires its correlated answer path');

  const callback = fixture(t);
  await callback.scheduler.admit({
    sessionId: 'callback', text: 'active', idempotencyKey: 'active',
  });
  await startClaim(callback, await claimOne(callback, 'callback'));
  await callback.scheduler.freeze('callback', 'awaiting_callback');
  await callback.scheduler.admit({
    sessionId: 'callback', text: 'unrelated follow-up', idempotencyKey: 'follow-up',
  });
  assert.equal((await callback.scheduler.status('callback')).state, 'frozen');
  assert.equal(await claimOne(callback, 'callback'), null);
});

test('a pending queued entry can be cancelled individually but a leased entry cannot', async t => {
  const h = fixture(t);
  await h.scheduler.admit({
    sessionId: 's1', text: 'active', idempotencyKey: 'active',
  });
  await startClaim(h, await claimOne(h));
  const first = await h.scheduler.admit({
    sessionId: 's1', text: 'cancel me', idempotencyKey: 'cancel-me',
  });
  const second = await h.scheduler.admit({
    sessionId: 's1', text: 'keep me', idempotencyKey: 'keep-me',
  });

  const cancelled = await h.scheduler.cancelQueued('s1', first.entry.id, {
    actor: 'test',
    reason: 'no longer needed',
  });
  assert.equal(cancelled.ok, true);
  assert.deepEqual(cancelled.schedule.queued.map(item => item.text), ['keep me']);
  assert.equal((await h.outbox.get(first.entry.id)).state, 'cancelled');
  assert.equal(h.events.at(-1).type, 'queued_cancelled');

  assert.equal((await h.scheduler.complete('s1')).ok, true);
  const [leased] = await h.outbox.claim({
    workerId: 'race-worker',
    limit: 1,
    selectSessionItem: h.scheduler.selectSessionItem,
  });
  assert.equal(leased.id, second.entry.id);
  const tooLate = await h.scheduler.cancelQueued('s1', second.entry.id);
  assert.equal(tooLate.ok, false);
  assert.equal(tooLate.code, 'queued_entry_already_claimed');
});

test('plain user-input waiting never gates queued work: the pump releases it and starts the FIFO head', async t => {
  const h = fixture(t);
  await h.scheduler.admit({ sessionId: 's1', text: 'active', idempotencyKey: 'active' });
  await startClaim(h, await claimOne(h));
  // A dispatch-like (non-direct) message admitted while running is queued.
  const dispatched = await h.scheduler.admit({
    sessionId: 's1', text: 'dispatched', source: 'operation', idempotencyKey: 'dispatched',
  });
  assert.equal(dispatched.queued, true);
  // The turn ends and a legacy plain-W freeze (no requestId) is on record.
  await h.scheduler.freeze('s1', 'awaiting_user_input');
  // The next pump must release the finished turn and lease the queued head —
  // without any new admission and without a restart (the staging regression).
  const claim = await claimOne(h);
  assert.ok(claim, 'queued work must start once the plain wait is released');
  assert.equal(claim.id, dispatched.entry.id);
  const status = await h.scheduler.status('s1');
  assert.equal(status.state, 'starting');
  assert.equal(status.freezeReason, null);
  assert.equal(status.lastDecision?.reason, 'queued_work_release');
  await startClaim(h, claim);
  assert.equal((await h.scheduler.status('s1')).state, 'running');
});

test('structured questions and real errors still gate the queue despite the plain-W release', async t => {
  const structured = fixture(t);
  await structured.scheduler.admit({ sessionId: 's1', text: 'active', idempotencyKey: 'active' });
  await startClaim(structured, await claimOne(structured));
  await structured.scheduler.admit({ sessionId: 's1', text: 'queued', idempotencyKey: 'queued' });
  await structured.scheduler.freeze('s1', 'awaiting_user_input', { requestId: 'question-1' });
  assert.equal(await claimOne(structured), null, 'a requestId question keeps the queue staged');
  assert.equal((await structured.scheduler.status('s1')).freezeReason, 'awaiting_user_input');

  const errored = fixture(t);
  await errored.scheduler.admit({ sessionId: 's1', text: 'active', idempotencyKey: 'active' });
  await startClaim(errored, await claimOne(errored));
  await errored.scheduler.admit({ sessionId: 's1', text: 'queued', idempotencyKey: 'queued' });
  await errored.scheduler.freeze('s1', 'error');
  assert.equal(await claimOne(errored), null, 'an error freeze keeps the queue staged');
});
