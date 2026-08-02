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
  assert.equal(runStateForFreezeReason('classify_waiting'), 'waiting');
  assert.equal(runStateForFreezeReason('classify_background'), 'waiting');
  assert.equal(runStateForFreezeReason('classify_error'), 'error');
  assert.equal(runStateForFreezeReason('classify_running'), 'running');
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
    getClassifyState: options.getClassifyState,
    getPendingUserInput: options.getPendingUserInput,
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

test('claim release publishes the same bounded FIFO summary used by snapshots', async t => {
  const h = fixture(t);
  await h.scheduler.admit({
    sessionId: 's1',
    text: 'sensitive delivery body',
    options: { taskId: 'private-task' },
    idempotencyKey: 'release-me',
  });
  const item = await claimOne(h);
  h.advance();
  const released = await h.scheduler.releaseClaim(item, 'delivery_deferred');
  assert.equal(released.ok, true);
  const event = h.events.at(-1);
  assert.equal(event.type, 'claim_released');
  assert.deepEqual(event.queueSummary, (await h.scheduler.queueSummaries(['s1']))[0]);
  assert.equal(event.queueSummary.state, 'idle');
  assert.equal(event.queueSummary.depth, 1);
  assert.doesNotMatch(
    JSON.stringify(event.queueSummary),
    /sensitive delivery body|private-task|entryId|taskId|source/,
  );
});

test('direct input staged during P starts as soon as classify leaves P', async t => {
  const h = fixture(t);
  // A is active (P).
  const a = await h.scheduler.admit({ sessionId: 's1', text: 'A', idempotencyKey: 'A' });
  const aClaim = await claimOne(h);
  assert.equal(aClaim.id, a.entry.id);
  await startClaim(h, aClaim);
  // B is durably staged behind A while P is still running.
  const b = await h.scheduler.admit({ sessionId: 's1', text: 'B', idempotencyKey: 'B' });
  assert.equal(b.queued, true);
  assert.equal(await claimOne(h), null);

  // A leaves P for W. B is a user message, so it starts a fresh native turn;
  // the released -p process is not an admission gate.
  await h.scheduler.complete('s1', { classifyState: 'W' });
  const bClaim = await claimOne(h);
  assert.equal(bClaim && bClaim.id, b.entry.id);
});

test('released W keeps ordinary FIFO staged but runs a correlated answer control entry', async t => {
  const h = fixture(t);
  const active = await h.scheduler.admit({
    sessionId: 's1',
    text: 'ask',
    options: { taskId: 'task-a' },
    idempotencyKey: 'ask',
  });
  await startClaim(h, await claimOne(h));
  const future = await h.scheduler.admit({
    sessionId: 's1',
    text: 'future queued task',
    source: 'operation',
    idempotencyKey: 'future',
  });

  await h.scheduler.complete('s1', {
    classifyState: 'W',
    awaitingRequestId: 'usrq-1',
  });
  const waiting = await h.scheduler.status('s1');
  assert.equal(waiting.active, null);
  assert.equal(waiting.awaitingRequestId, 'usrq-1');
  assert.equal(await claimOne(h), null, 'ordinary queued work stays gated by W');

  const answer = await h.scheduler.admit({
    sessionId: 's1',
    text: 'approved',
    workKind: 'answer',
    requestId: 'usrq-1',
    options: { taskId: 'task-a' },
    idempotencyKey: 'answer',
  });
  assert.equal(answer.ok, true);
  assert.equal(answer.queued, false);
  const answerClaim = await claimOne(h);
  assert.equal(answerClaim.id, answer.entry.id);
  assert.equal(answerClaim.payload.workKind, 'answer');
  assert.equal(answerClaim.payload.activeEntryId, null);
  await startClaim(h, answerClaim);

  await h.scheduler.complete('s1', { classifyState: 'D' });
  const futureClaim = await claimOne(h);
  assert.equal(futureClaim.id, future.entry.id);
  assert.notEqual(futureClaim.id, active.entry.id);
});

test('async dispatch result waits during P then wakes D/W/E without manufacturing B', async t => {
  for (const classifyState of ['D', 'W', 'E']) {
    const h = fixture(t);
    await h.scheduler.admit({ sessionId: 's1', text: 'active', idempotencyKey: 'active' });
    await startClaim(h, await claimOne(h));
    await h.scheduler.admit({
      sessionId: 's1', text: 'ordinary queued task', source: 'operation',
      idempotencyKey: 'ordinary',
    });
    const callback = await h.outbox.enqueue({
      id: 'operation:dispatch-1:result',
      sessionId: 's1',
      payload: {
        type: 'dispatch.result', operationId: 'dispatch-1',
        deliveryText: 'worker result', result: { status: 'completed', text: 'done' },
      },
      source: { type: 'operation', kind: 'dispatch', operationId: 'dispatch-1' },
    });
    assert.equal(await claimOne(h), null, `callback cannot interrupt classify P (${classifyState})`);

    await h.scheduler.complete('s1', { classifyState });
    const claim = await claimOne(h);
    assert.equal(claim.id, callback.id, `dispatch result must wake classify ${classifyState}`);
    assert.equal(claim.payload.type, 'dispatch.result');
    assert.notEqual((await h.scheduler.status('s1')).classifyState, 'B');
  }
});

test('an early structured answer stays off the public FIFO then runs first after the asking turn releases', async t => {
  const h = fixture(t);
  const asking = await h.scheduler.admit({
    sessionId: 's1',
    text: 'ask',
    options: { taskId: 'task-a' },
    idempotencyKey: 'asking',
  });
  await startClaim(h, await claimOne(h));
  const ordinary = await h.scheduler.admit({
    sessionId: 's1',
    text: 'ordinary future work',
    source: 'operation',
    idempotencyKey: 'ordinary',
  });
  const answer = await h.scheduler.admit({
    sessionId: 's1',
    text: 'answer before stream_end',
    workKind: 'answer',
    requestId: 'usrq-early',
    activeEntryId: asking.entry.id,
    idempotencyKey: 'answer-early',
  });
  assert.equal(answer.ok, true);
  assert.equal(answer.queued, false);
  assert.deepEqual(
    answer.schedule.queued.map(item => item.entryId),
    [ordinary.entry.id],
    'the crash-safe answer hand-off is not projected as ordinary staged work',
  );
  assert.equal(await claimOne(h), null, 'the answer does not overlap the live asking process');

  await h.scheduler.complete('s1', {
    classifyState: 'W',
    awaitingRequestId: 'usrq-early',
  });
  const answerClaim = await claimOne(h);
  assert.equal(answerClaim.id, answer.entry.id);
  assert.equal(answerClaim.payload.activeEntryId, null);
  await startClaim(h, answerClaim);

  await h.scheduler.complete('s1', { classifyState: 'D' });
  assert.equal((await claimOne(h)).id, ordinary.entry.id);
});

test('structured input remains deliverable even when its old request correlation is stale', async t => {
  const h = fixture(t);
  await h.scheduler.admit({ sessionId: 's1', text: 'ask', idempotencyKey: 'ask' });
  await startClaim(h, await claimOne(h));
  await h.scheduler.complete('s1', {
    classifyState: 'E',
    awaitingRequestId: 'usrq-e',
  });
  const answer = await h.scheduler.admit({
    sessionId: 's1',
    text: 'repair choice',
    workKind: 'answer',
    requestId: 'usrq-e',
    idempotencyKey: 'answer-e',
  });
  assert.equal(answer.ok, true);
  assert.equal((await claimOne(h)).id, answer.entry.id);

  const done = fixture(t);
  await done.scheduler.admit({ sessionId: 's2', text: 'done', idempotencyKey: 'done' });
  await startClaim(done, await claimOne(done, 's2'));
  await done.scheduler.complete('s2', {
    classifyState: 'D',
    awaitingRequestId: 'usrq-stale',
  });
  const late = await done.scheduler.admit({
    sessionId: 's2',
    text: 'late answer',
    workKind: 'answer',
    requestId: 'usrq-stale',
    idempotencyKey: 'late',
  });
  assert.equal(late.ok, true);
  assert.equal(late.queued, false);
  assert.equal((await claimOne(done, 's2')).id, late.entry.id);
});

test('canonical pending request admits option and free-text answers despite a stale idle scheduler mirror', async t => {
  for (const [suffix, text] of [
    ['option', '生产环境'],
    ['free-text', '请改为下周一发布'],
  ]) {
    const requestId = `usrq-${suffix}`;
    const taskId = `task-${suffix}`;
    const h = fixture(t, {
      // Reproduces the field split from the bug: the task-state owner has an
      // unresolved request, while the scheduler mirror has no active entry and
      // still reads D.
      getClassifyState: () => 'D',
      getPendingUserInput: () => ({ requestId, taskId, resolved: false }),
    });
    const answer = await h.scheduler.admit({
      sessionId: `s-${suffix}`,
      text,
      workKind: 'answer',
      requestId,
      idempotencyKey: `answer-${suffix}`,
    });
    assert.equal(answer.ok, true, suffix);
    assert.equal(answer.queued, false, suffix);
    assert.equal(answer.entry.payload.taskId, taskId, suffix);
    assert.equal(answer.entry.payload.requestId, requestId, suffix);
    const claim = await claimOne(h, `s-${suffix}`);
    assert.equal(claim.id, answer.entry.id, suffix);
    assert.equal(claim.payload.workKind, 'answer', suffix);
  }
});

test('stale answer correlation never rejects or drops the user message', async t => {
  const h = fixture(t, {
    getClassifyState: () => 'W',
    getPendingUserInput: () => ({
      requestId: 'usrq-current',
      taskId: 'task-current',
      resolved: false,
    }),
  });
  const stale = await h.scheduler.admit({
    sessionId: 's1',
    text: 'stale choice',
    workKind: 'answer',
    requestId: 'usrq-old',
    idempotencyKey: 'stale-answer',
  });
  assert.equal(stale.ok, true);
  assert.equal(stale.entry.payload.taskId, null);
  assert.equal((await claimOne(h)).id, stale.entry.id);
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

test('public FIFO exposes every pending kind and insertQueued marks exactly one direct run', async t => {
  const h = fixture(t);
  const active = await h.scheduler.admit({
    sessionId: 's1', text: 'active', idempotencyKey: 'active',
  });
  await startClaim(h, await claimOne(h));
  const first = await h.scheduler.admit({
    sessionId: 's1', text: 'first normal', idempotencyKey: 'first',
  });
  const control = await h.scheduler.admit({
    sessionId: 's1',
    text: 'related continuation',
    workKind: 'continuation',
    activeEntryId: active.entry.id,
    idempotencyKey: 'control',
  });
  const last = await h.scheduler.admit({
    sessionId: 's1', text: 'last normal', idempotencyKey: 'last',
  });

  assert.deepEqual(
    (await h.scheduler.status('s1')).queued.map(item => [item.text, item.workKind]),
    [
      ['first normal', 'task'],
      ['related continuation', 'continuation'],
      ['last normal', 'task'],
    ],
  );
  const inserted = await h.scheduler.insertQueued('s1', last.entry.id);
  assert.equal(inserted.ok, true);
  assert.deepEqual(inserted.schedule.queued.map(item => item.entryId), [
    last.entry.id, first.entry.id, control.entry.id,
  ]);
  assert.equal(inserted.schedule.queued[0].priority, true);
  assert.equal((await h.outbox.get(last.entry.id)).directRun, true);
  assert.equal(await claimOne(h), null, 'the route must release the active turn first');

  await h.scheduler.complete('s1', {
    reason: 'user_cancelled_for_immediate_insert',
    classifyState: 'E',
  });
  assert.equal((await claimOne(h)).id, last.entry.id);
});

test('restart rebuilds the FIFO gate only from the recovered classify state', async t => {
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
  assert.equal(state.freezeReason, 'classify_running');
  assert.equal(state.classifyState, 'P');
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
  assert.equal(legacy.freezeReason, 'classify_waiting');
  assert.equal(legacy.classifyState, 'W');

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
  assert.equal(unknownLegacy.state, 'idle');
  assert.equal(unknownLegacy.active, null);
  assert.equal(unknownLegacy.freezeReason, null);
  assert.equal((await claimOne(h3, 'unknown-legacy')).id, 'legacy-pending');
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
  assert.equal(staleState.state, 'assessing');
  assert.equal(staleState.freezeReason, null);
  assert.equal(staleState.classifyState, 'P');
});

test('persisted-delivery settlement uses only recovered classify and otherwise reassesses', async t => {
  const waiting = fixture(t);
  await waiting.scheduler.admit({
    sessionId: 'waiting',
    text: 'persisted waiting work',
    idempotencyKey: 'persisted-waiting',
  });
  const waitingClaim = await claimOne(waiting, 'waiting');
  const waitingResult = await waiting.scheduler.settlePersistedDelivery(
    waitingClaim,
    { classifyState: 'W' },
  );
  assert.equal(waitingResult.ok, true);
  const waitingState = await waiting.scheduler.status('waiting');
  // T1: recovery follows the live path — W releases the active slot via
  // complete() (no freeze). FIFO is left untouched.
  assert.equal(waitingState.state, 'idle');
  assert.equal(waitingState.classifyState, 'W');
  assert.equal(waitingState.freezeReason, null);

  const staleDone = fixture(t);
  await staleDone.scheduler.admit({
    sessionId: 'stale',
    text: 'persisted work with stale D',
    idempotencyKey: 'persisted-stale',
  });
  const staleClaim = await claimOne(staleDone, 'stale');
  const staleResult = await staleDone.scheduler.settlePersistedDelivery(
    staleClaim,
    { classifyState: 'D', endedAt: 999 },
  );
  assert.equal(staleResult.ok, true);
  const staleState = await staleDone.scheduler.status('stale');
  // A recovered D completes the active slot (drains FIFO); it no longer
  // re-assesses, because D is terminal.
  assert.equal(staleState.state, 'idle');
  assert.equal(staleState.classifyState, 'D');
  assert.equal(staleState.freezeReason, null);
});

test('W/B/E classifications remain the only gates until a matching control or D', async t => {
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
  const held = await waiting.scheduler.status('waiting');
  assert.equal(held.state, 'frozen');
  assert.ok(held.active);
  assert.equal(held.classifyState, 'W');
  assert.equal(held.queued[0].text, '<img src=x onerror=alert(1)>\nqueued body');
  const summaries = await waiting.scheduler.queueSummaries(['waiting', 'missing']);
  assert.equal(summaries[0].depth, 1);
  assert.equal(summaries[0].state, 'frozen');
  assert.equal(summaries[0].classifyState, 'W');
  assert.equal(summaries[1].depth, 0);
  assert.deepEqual(waiting.events.at(-1).queueSummary, summaries[0]);
  assert.doesNotMatch(
    JSON.stringify(summaries),
    /queued body|entryId|taskId|source|priority|position/,
  );
  assert.equal(await claimOne(waiting, 'waiting'), null);

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
  assert.equal(frozen.freezeReason, 'classify_error');
  assert.equal(await claimOne(failed, 'failed'), null);
});

test('direct input cannot bypass assessing and remains behind older FIFO work until classify D', async t => {
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
  assert.equal(next.schedule.state, 'assessing');
  assert.ok(next.schedule.active);
  assert.deepEqual(next.schedule.queued.map(item => item.text), [
    'already queued', 'next user message',
  ]);
  assert.equal(await claimOne(h), null);
  assert.equal((await h.scheduler.complete('s1')).ok, true);
  assert.equal((await claimOne(h)).id, queued.entry.id);
});

test('classify W permits a related continuation but never an unrelated queued task', async t => {
  const waiting = fixture(t);
  const active = await waiting.scheduler.admit({
    sessionId: 'waiting', text: 'active', idempotencyKey: 'active',
  });
  await startClaim(waiting, await claimOne(waiting, 'waiting'));
  await waiting.scheduler.freeze('waiting', 'classify_waiting', { classifyState: 'W' });
  const unrelated = await waiting.scheduler.admit({
    sessionId: 'waiting', text: 'unrelated task', idempotencyKey: 'unrelated',
  });
  assert.equal(await claimOne(waiting, 'waiting'), null);
  const resumed = await waiting.scheduler.admit({
    sessionId: 'waiting',
    text: 'user follow-up',
    source: 'direct',
    workKind: 'continuation',
    activeEntryId: active.entry.id,
    idempotencyKey: 'follow-up',
  });
  const resumedClaim = await claimOne(waiting, 'waiting');
  assert.equal(resumedClaim.id, resumed.entry.id);
  assert.notEqual(resumedClaim.id, unrelated.entry.id);
});

test('canonical classify makes only P stage direct chat input', async t => {
  const classify = new Map([['s1', 'D']]);
  const h = fixture(t, {
    getClassifyState: sessionId => classify.get(sessionId) || null,
  });
  const active = await h.scheduler.admit({
    sessionId: 's1', text: 'active', idempotencyKey: 'active',
  });
  await startClaim(h, await claimOne(h));
  classify.set('s1', 'P');
  const staged = await h.scheduler.admit({
    sessionId: 's1', text: 'typed during process', source: 'direct',
    idempotencyKey: 'staged',
  });
  assert.equal(staged.queued, true);
  assert.equal(await claimOne(h), null);

  // The scheduler's persisted mirror is still P here. Canonical E must win and
  // make the newly typed continuation immediately deliverable.
  classify.set('s1', 'E');
  const immediate = await h.scheduler.admit({
    sessionId: 's1',
    text: 'typed after API error',
    source: 'direct',
    workKind: 'continuation',
    activeEntryId: active.entry.id,
    idempotencyKey: 'direct-error',
  });
  assert.equal(immediate.queued, false);
  const immediateEvent = h.events.find(event => event.entryId === immediate.entry.id);
  assert.equal(immediateEvent.queued, false);
  assert.equal(
    immediateEvent.queuedItems.some(item => item.entryId === immediate.entry.id),
    false,
  );
  const claim = await claimOne(h);
  assert.equal(claim.id, immediate.entry.id);
  assert.notEqual(claim.id, staged.entry.id);
});

test('manual retry is admitted only for classify E', async t => {
  const waiting = fixture(t);
  await waiting.scheduler.admit({
    sessionId: 'waiting', text: 'active', idempotencyKey: 'active',
  });
  await startClaim(waiting, await claimOne(waiting, 'waiting'));
  await waiting.scheduler.freeze('waiting', 'classify_waiting', { classifyState: 'W' });
  const rejected = await waiting.scheduler.resolve('waiting', {
    action: 'retry',
    idempotencyKey: 'retry-waiting',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'active_task_not_retryable');

  const failed = fixture(t);
  await failed.scheduler.admit({
    sessionId: 'failed',
    text: 'active',
    options: { taskId: 'task-failed' },
    idempotencyKey: 'active',
  });
  await startClaim(failed, await claimOne(failed, 'failed'));
  await failed.scheduler.complete('failed', { classifyState: 'E' });
  assert.equal((await failed.scheduler.status('failed')).active, null);
  const admitted = await failed.scheduler.resolve('failed', {
    action: 'retry',
    idempotencyKey: 'retry-error',
  });
  assert.equal(admitted.ok, true);
  const retry = await claimOne(failed, 'failed');
  assert.equal(retry.payload.workKind, 'retry');
  assert.equal(retry.payload.taskId, 'task-failed');
});

test('host API recovery options become a retry work item after classify E', async t => {
  const h = fixture(t);
  await h.scheduler.admit({
    sessionId: 's1',
    text: 'original task',
    idempotencyKey: 'original',
  });
  await startClaim(h, await claimOne(h));
  await h.scheduler.complete('s1', { classifyState: 'E' });

  const recovery = await h.scheduler.admit({
    sessionId: 's1',
    text: 'provider recovered',
    source: 'api_recovery',
    options: {
      originContinue: true,
      retry: true,
    },
    idempotencyKey: 'api-recovery:s1:1000',
  });
  assert.equal(recovery.entry.payload.workKind, 'retry');
  assert.equal(recovery.entry.payload.source, 'api_recovery');
  const claim = await claimOne(h);
  assert.equal(claim.id, recovery.entry.id);
  assert.equal(claim.payload.workKind, 'retry');
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

test('classify W gates normal queued work until classify D completes the active entry', async t => {
  const h = fixture(t);
  await h.scheduler.admit({ sessionId: 's1', text: 'active', idempotencyKey: 'active' });
  await startClaim(h, await claimOne(h));
  // A dispatch-like (non-direct) message admitted while running is queued.
  const dispatched = await h.scheduler.admit({
    sessionId: 's1', text: 'dispatched', source: 'operation', idempotencyKey: 'dispatched',
  });
  assert.equal(dispatched.queued, true);
  await h.scheduler.freeze('s1', 'classify_waiting', { classifyState: 'W' });
  assert.equal(await claimOne(h), null);
  await h.scheduler.complete('s1', { reason: 'classified_complete' });
  const claim = await claimOne(h);
  assert.ok(claim);
  assert.equal(claim.id, dispatched.entry.id);
  const status = await h.scheduler.status('s1');
  assert.equal(status.state, 'starting');
  assert.equal(status.freezeReason, null);
});

test('structured questions and classify errors keep normal FIFO work staged', async t => {
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
