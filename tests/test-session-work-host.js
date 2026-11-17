'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionWorkHost } = require('../src/session-work/host');
const { createShellWorkspaceHost } = require('../src/task-shell/workspace');
const { createOrchestrationSqliteStore } = require('../src/orchestration/sqlite-store');
const { createSessionWorkScheduler } = require('../src/session-work/scheduler');
const { createProductionQuestionHost, createProductionWorkHost } = require('../src/session-work/production-question-host');

function fixture(options = {}) {
  const calls = [];
  let pending = null;
  let pendingWait = false;
  let schedulerState = 'running';
  let settledClassify = null;
  let queuedItems = Array.isArray(options.queued) ? [...options.queued] : [];
  let releaseTurnEnded = options.releaseTurnEnded || null;
  const record = { taskState: {}, ...(options.record || {}) };
  const chatState = options.chatState === undefined ? {} : options.chatState;
  const scheduler = {
    status: async () => ({
      state: schedulerState,
      freezeReason: schedulerState === 'frozen' ? options.freezeReason || null : null,
      classifyState: settledClassify,
      queued: queuedItems,
      active: schedulerState === 'idle'
        ? null
        : {
          entryId: options.activeEntryId || 'entry-1',
          ...(options.activeTaskId ? { taskId: options.activeTaskId } : {}),
          ...(options.activeOriginDispatchId
            ? { originDispatchId: options.activeOriginDispatchId }
            : {}),
          ...(options.supersededByEntryId
            ? {
              supersededByEntryId: options.supersededByEntryId,
              supersededLineageTransferred: options.supersededLineageTransferred === true
                || options.supersededOriginTransferred === true,
              supersededOriginTransferred: options.supersededOriginTransferred === true,
            }
            : {}),
        },
    }),
    complete: async (_sessionId, completeOptions) => {
      calls.push(['complete', completeOptions]);
      schedulerState = 'idle';
      settledClassify = completeOptions?.classifyState || null;
      return { ok: true };
    },
    // resolve({action:'retry'}) is the manual-「重试」 channel: admission of the
    // retry entry claims the idle slot immediately, like the production owner.
    resolve: async (_sessionId, resolveOptions) => {
      calls.push(['resolve', resolveOptions]);
      schedulerState = 'running';
      settledClassify = null;
      return { ok: true, entry: { id: 'entry-retry' } };
    },
    turnEnded: async () => {
      if (releaseTurnEnded) await releaseTurnEnded;
      calls.push(['assessing']);
      schedulerState = 'assessing';
      return { ok: true, schedule: { state: 'assessing' } };
    },
    freeze: async (_sessionId, reason, options) => {
      calls.push(['freeze', reason, options || {}]);
      schedulerState = 'frozen';
      return { ok: true };
    },
  };
  const forceState = value => { schedulerState = value; };
  const runtime = {
    sessionScheduler: scheduler,
    hasPending: () => pendingWait,
    tick: async () => { calls.push(['tick']); },
    admitSessionWork: async input => {
      calls.push(['admit', input]);
      if (options.admitSessionWork) return options.admitSessionWork(input);
      return { ok: true, entry: { id: 'entry-new' } };
    },
    interruptDispatch: async (operationId, input) => {
      calls.push(['interrupt-dispatch', operationId, input]);
      return { ok: true, operation: { id: operationId, status: 'interrupted' } };
    },
  };
  const owned = options.ownerStore ? createProductionQuestionHost({ getStore: () => options.ownerStore,
    getSession: () => chatState, getState: () => ({ ...record.taskState, pendingUserInput: pending }),
    setState: (_id, patch) => { record.taskState = { ...record.taskState, ...patch }; } }).host : null;
  const hostDeps = {
    runtime: () => runtime,
    getRecord: () => record,
    getChatSession: () => chatState,
    getTaskState: value => value?.taskState || {},
    pendingUserInput: () => pending,
    userInputSignalHost: options.userInputSignalHost,
    moveUserInput: options.moveUserInput,
    getTurnLiveness: () => options.liveness || { state: 'inactive' },
    recordUserInput: () => ({ ok: true }),
    resolveUserInput: (sessionId, requestId) => {
      calls.push(['resolve-user-input', sessionId, requestId]);
      if (!pending || pending.requestId !== requestId) {
        return { ok: false, code: pending ? 'request_id_mismatch' : 'no_pending_request' };
      }
      if (pending.resolved === true) return { ok: true, duplicate: true };
      pending = { ...pending, resolved: true };
      return { ok: true, duplicate: false };
    },
    broadcast: (...args) => calls.push(['broadcast', ...args]),
    setTaskState: (sessionId, patch) => {
      record.taskState = { ...record.taskState, ...patch };
      calls.push(['task-state', sessionId, patch]);
    },
    onTaskBoardQueueEvent() {},
    onWorkspaceQueueStatus: (sessionId, status) =>
      calls.push(['workspace-queue', sessionId, status]),
    classifyDisplay: options.classifyDisplay || (() => ({ cardStatus: 'running' })),
    // classify is the only writer of business state; the host merely submits.
    dispatchStateAction: (result, ctx) => calls.push(['dispatch', result, ctx]),
    reconcileTaskProjection: (...args) => calls.push(['reconcile', ...args]),
    cancelClassify() {},
    cancelSessionClassifyJobs: sessionId => calls.push(['cancel-classify-jobs', sessionId]),
    assignKillReason() {},
    finishProviderAttempt: (attempt, facts) => calls.push(['finish-provider-attempt', attempt, facts]),
    appendMessage: (...args) => calls.push(['append-message', ...args]),
    cancelPreparation: (...args) => calls.push(['cancel-preparation', ...args]),
    stopBackgroundForInsert: sessionId => calls.push(['stop-background', sessionId]),
    chatStream: options.chatStream || { isAlive: () => false, cancel() {} },
    zcodeAuth: options.zcodeAuth || { ensureZcodeAuth: () => ({ ok: true }) },
    runnerStopTimeoutMs: options.runnerStopTimeoutMs,
    runnerKillGraceMs: options.runnerKillGraceMs,
    log: { warn: (...args) => calls.push(['warn', ...args]) },
  };
  const host = owned ? createProductionWorkHost(hostDeps, owned) : createSessionWorkHost(hostDeps);
  return {
    calls,
    host,
    owned,
    forceState,
    setClassifyState(value) { record.taskState.classifyState = value; },
    setCancelledAt(value) { record.taskState.cancelledAt = value; },
    setPending(value) { pending = value; },
    setPendingWait(value) { pendingWait = value; },
  };
}

// Admission cases exercise the same Rust owner and SQLite transaction used by
// production. Initial facts are explicit test inputs, not scheduler callbacks.
async function nativeAdmissionFixture(t, { classifyState = null, pending = null,
  state = 'running', record = {}, useOwned = false, ...options } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-host-admit-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite') });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await store.sessionWorkState({ action: 'readOrInitialize', sessionId: 's1', initial: {
    pendingQuestion: pending, activeTurn: null,
    category: { classifyState, unattended: record.unattended || null },
  } });
  await store.mutate(draft => {
    draft.sessionSchedules.s1 = {
      sessionId: 's1', state, classifyState,
      active: state === 'idle' ? null : { entryId: options.activeEntryId || 'entry-1',
        ...(options.activeTaskId ? { taskId: options.activeTaskId } : {}) },
      freezeReason: null, awaitingRequestId: null,
    };
  });
  const nativeScheduler = createSessionWorkScheduler({ store });
  const hostFixture = fixture({ ...options, record, ...(useOwned ? { ownerStore: store } : {}),
    admitSessionWork: input => nativeScheduler.admit(input) });
  hostFixture.forceState(state);
  hostFixture.setClassifyState(classifyState);
  hostFixture.setPending(pending);
  return { ...hostFixture, store };
}

test('first production-style admission backfills and settles the existing question', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-host-first-admit-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite') });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const scheduler = createSessionWorkScheduler({ store });
  const h = fixture({ ownerStore: store, admitSessionWork: input => scheduler.admit(input) });
  h.setClassifyState('W');
  h.setPending({ requestId: 'question', taskId: 'task', turnId: 'turn', resolved: false });

  // Exercise the same host inputs as production: no test-side initialization
  // of the new Rust store and no caller-supplied initialState.
  const result = await h.host.admit('s1', 'answer', { userInputRequestId: 'question' });
  assert.equal(result.ok, true);
  assert.equal(result.answerConsumed.requestId, 'question');
  assert.equal(result.entry.payload.taskId, 'task');
  assert.equal((await store.sessionWorkState({ action: 'read', sessionId: 's1' })).pendingQuestion.resolved, true);
  assert.equal(h.host.recoveryState('s1').pendingUserInput, null);
});

test('admission logs the owner and error code without logging the message', async () => {
  const failure = Object.assign(new Error('private user content'), { code: 'SESSION_WORK_OWNER_UNAVAILABLE' });
  const h = fixture({ admitSessionWork: async () => { throw failure; } });
  await assert.rejects(h.host.admit('s1', 'private user content'), error => error === failure);
  const warning = h.calls.find(call => call[0] === 'warn');
  assert.deepEqual(warning, ['warn', 'session_work_admission_failed', {
    sessionId: 's1', code: 'SESSION_WORK_OWNER_UNAVAILABLE', questionOwner: 'legacy',
  }]);
});

test('a question changed after initialization is answered using the live question owner', async t => {
  const h = await nativeAdmissionFixture(t, { state: 'idle', classifyState: 'W', pending: {
    requestId: 'old-question', taskId: 'old-task', resolved: false,
  }, chatState: { _activeTurn: { turnId: 'turn' }, isStreaming: true, _currentTaskId: 'new-task' }, useOwned: true });
  await h.owned.resolveAsync('s1', 'old-question');
  await h.owned.activateTurnAsync('s1');
  assert.equal((await h.host.recordInput({ sessionId: 's1', turnId: 'turn', requestId: 'new-question', question: 'new' })).ok, true);
  const result = await h.host.admit('s1', 'answer', { userInputRequestId: 'new-question', clientMsgId: 'new-answer' });
  assert.equal(result.ok, true);
  assert.equal(result.answerConsumed?.requestId, 'new-question');
  assert.equal(result.entry.payload.taskId, 'new-task');
  const state = await h.store.sessionWorkState({ action: 'read', sessionId: 's1' });
  assert.equal(state.pendingQuestion.requestId, 'new-question');
  assert.equal(state.pendingQuestion.resolved, true);
});

test('question transfer awaits the owner and refuses a replaced request', async () => {
  const calls = [];
  const h = fixture({ userInputSignalHost: {
    async pendingAsync(id) { calls.push(['read', id]); return { requestId: 'old', taskId: 't', turnId: 'turn' }; },
    async moveAsync(source, target, options) {
      calls.push(['move', source, target, options]);
      return { ok: false, code: 'request_id_mismatch' };
    },
  } });
  const result = await h.host.moveInput('s1', 's2', { turnId: 'turn', taskId: 'next' });
  assert.deepEqual(result, { ok: false, code: 'request_id_mismatch' });
  assert.deepEqual(calls, [['read', 's1'], ['move', 's1', 's2', {
    turnId: 'turn', taskId: 'next', expectedRequestId: 'old',
  }]]);
  assert.equal(h.calls.some(call => call[0] === 'dispatch' || call[0] === 'broadcast'), false);
});

test('dismissal uses the ordered question owner and does not classify a replaced question', async () => {
  const calls = [];
  const h = fixture({ userInputSignalHost: {
    async pendingAsync(id) { calls.push(['read', id]); return { requestId: 'old', taskId: 'task' }; },
    async resolveAsync(id, requestId, options) {
      calls.push(['resolve', id, requestId, options]);
      return { ok: false, code: 'request_id_mismatch' };
    },
  } });
  h.forceState('idle');
  assert.deepEqual(await h.host.dismissUserInput('s1', 'old'), { ok: false, code: 'request_id_mismatch' });
  assert.deepEqual(calls, [['read', 's1'], ['resolve', 's1', 'old', { dismissed: true }]]);
  assert.equal(h.calls.some(call => call[0] === 'dispatch'), false);
});

test('restart recovery reads the ordered question owner before submitting a verdict', async () => {
  const h = fixture({ freezeReason: 'classify_running', userInputSignalHost: {
    async pendingAsync() { return { requestId: 'owned', taskId: 'task', resolved: false }; },
  } });
  h.forceState('frozen');
  assert.equal((await h.host.settleRecoveredQuestion('s1')).ok, true);
  const verdict = h.calls.find(call => call[0] === 'dispatch');
  assert.equal(verdict[1].requestId, 'owned');
  assert.equal(verdict[1].state, 'W');
});

test('ZCode admission passes the full session to auth and provider-backed sessions can bypass native auth', async () => {
  let checked = null;
  const record = { cli: 'zcode', provider: 'provider-one' };
  const h = fixture({
    record,
    zcodeAuth: {
      ensureZcodeAuth(session) {
        checked = session;
        return session.provider ? { ok: true, source: 'multicc_provider' } : { ok: false };
      },
    },
  });
  const result = await h.host.admit('s1', 'hello');
  assert.equal(result.ok, true);
  assert.equal(checked.cli, record.cli);
  assert.equal(checked.provider, record.provider);
  assert.equal(h.calls.some(call => call[0] === 'admit'), true);
});

test('provider-less ZCode keeps the actionable native configuration gate', async () => {
  const h = fixture({
    record: { cli: 'zcode', provider: null },
    zcodeAuth: {
      ensureZcodeAuth: () => ({
        ok: false,
        code: 'configuration_required',
        message: 'configure native ZCode',
      }),
    },
  });
  const result = await h.host.admit('s1', 'hello');
  assert.deepEqual(result, {
    ok: false,
    code: 'configuration_required',
    message: 'configure native ZCode',
  });
  assert.equal(h.calls.some(call => call[0] === 'admit'), false);
  assert.deepEqual(h.calls.find(call => call[0] === 'broadcast').slice(1), [
    's1',
    { type: 'error', error: 'configure native ZCode', code: 'configuration_required' },
  ]);
});

// A child process that only dies on the signal it is configured to respect —
// `diesOn: null` models the CLI that ignores everything short of SIGKILL's
// kernel-level stop. `signalCode` + the 'exit' event are how Node reports a
// death, and they are what the host reads to tell "asked to stop" from "stopped".
function fakeChild(diesOn = 'SIGTERM') {
  const exitListeners = [];
  return {
    pid: 123,
    exitCode: null,
    signalCode: null,
    kills: 0,
    signals: [],
    once(event, fn) { if (event === 'exit') exitListeners.push(fn); },
    kill(signal) {
      this.kills += 1;
      this.signal = signal;
      this.signals.push(signal);
      if (!diesOn || signal !== diesOn) return;
      this.signalCode = signal;
      exitListeners.splice(0).forEach(fn => fn(null, signal));
    },
  };
}

function cancelFixture(overrides = {}, fixtureOptions = {}) {
  const child = fakeChild(fixtureOptions.diesOn === undefined ? 'SIGTERM' : fixtureOptions.diesOn);
  const state = {
    cli: 'codex',
    claudeProc: child,
    isStreaming: true,
    currentAssistantText: '',
    currentToolCalls: [],
    streamReplay: ['partial'],
    _activeRunner: {},
    _currentTaskId: 'task-1',
    ...overrides,
  };
  if (fixtureOptions.stuckRunner) {
    // A runner that ignores the stop request: isStreaming never clears.
    Object.defineProperty(state, 'isStreaming', {
      get() { return true; },
      set() { /* the runner wins */ },
    });
  }
  return { child, state, h: fixture({ ...fixtureOptions, chatState: state }) };
}

test('cancel stops the runner and submits one structured E result to classify — it never writes state itself', async () => {
  const { child, state, h } = cancelFixture();
  const result = await h.host.cancelActiveTurn('s1', { operationId: 'op-1' });

  // Runner side effects: process/transport only.
  assert.deepEqual(h.calls.find(call => call[0] === 'cancel-preparation'), [
    'cancel-preparation', 's1', 'user_cancelled',
  ]);
  assert.equal(child.signal, 'SIGTERM');
  assert.equal(state.isStreaming, false);
  assert.deepEqual(state.streamReplay, []);

  // The controller/host performs NO direct business-state write. The only
  // task-state writes allowed are the scheduler's queue projections; classify
  // owns classifyState/cancelledAt.
  const directWrites = h.calls.filter(call => call[0] === 'task-state'
    && ('classifyState' in call[2] || 'cancelledAt' in call[2]));
  assert.deepEqual(directWrites, []);

  // Exactly one structured result reaches classify, carrying the cancel envelope.
  const dispatches = h.calls.filter(call => call[0] === 'dispatch');
  assert.equal(dispatches.length, 1);
  const [, verdict, ctx] = dispatches[0];
  assert.equal(verdict.state, 'E');
  assert.equal(verdict.cancel.source, 'manual_cancel');
  assert.equal(verdict.cancel.operationId, 'op-1');
  assert.equal(verdict.cancel.reason, 'user_cancelled');
  assert.equal(verdict.cancel.runnerStopped, true);
  assert.equal(verdict.cancel.taskId, 'task-1');
  assert.ok(Number.isFinite(verdict.cancel.requestedAt));
  assert.ok(verdict.cancel.at >= verdict.cancel.requestedAt);
  assert.equal(ctx.sessionName, 's1');

  // Ordering proof: stop → turn boundary (assessing) → classify → reconcile.
  const order = h.calls.map(call => call[0]);
  assert.ok(order.indexOf('cancel-preparation') < order.indexOf('assessing'));
  assert.ok(order.indexOf('assessing') < order.indexOf('dispatch'));
  assert.ok(order.indexOf('dispatch') < order.indexOf('reconcile'));

  // Formal projection re-publish, not a hand-assembled second broadcast.
  assert.deepEqual(h.calls.find(call => call[0] === 'reconcile'), [
    'reconcile', 'task-1', { classifyState: 'E', reason: 'user_cancelled' },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.classifyState, 'E');
  assert.equal(result.operationId, 'op-1');
});

test('cancelling the only dispatch-owned turn settles its durable operation as interrupted', async () => {
  const { h } = cancelFixture({}, {
    activeTaskId: 'task-1',
    activeOriginDispatchId: 'dispatch-live',
  });
  const result = await h.host.cancelActiveTurn('s1', { source: 'manual_cancel' });
  const settlement = h.calls.find(call => call[0] === 'interrupt-dispatch');
  assert.deepEqual(settlement, [
    'interrupt-dispatch',
    'dispatch-live',
    {
      reason: 'dispatch target turn interrupted: user_cancelled',
      source: 'manual_cancel',
    },
  ]);
  assert.equal(result.originDispatchId, 'dispatch-live');
  assert.equal(result.dispatchSettlement.operation.status, 'interrupted');
});

test('an immediate same-task successor keeps the dispatch live and marks only the old attempt superseded', async () => {
  const { h } = cancelFixture({}, {
    activeTaskId: 'task-1',
    activeOriginDispatchId: 'dispatch-live',
    supersededByEntryId: 'entry-next',
    supersededOriginTransferred: true,
  });
  const result = await h.host.cancelActiveTurn('s1', { source: 'insert_queued' });
  assert.equal(h.calls.some(call => call[0] === 'interrupt-dispatch'), false);
  const verdict = h.calls.find(call => call[0] === 'dispatch')[1];
  assert.equal(verdict.cancel.superseded, true);
  assert.equal(verdict.cancel.supersededByEntryId, 'entry-next');
  assert.equal(verdict.cancel.reason, 'superseded_by_immediate_insert');
  assert.equal(verdict.cancel.originDispatchId, 'dispatch-live');
  assert.equal(verdict.cancel.successorRetainsDispatch, true);
  assert.equal(result.superseded, true);
  assert.equal(result.successorRetainsDispatch, true);
  assert.equal(result.dispatchSettlement, null);
});

test('an immediate insert stops background tasks before the runner; a manual cancel does not', async () => {
  const inserted = cancelFixture();
  await inserted.h.host.cancelActiveTurn('s1', { source: 'insert_queued' });
  const names = inserted.h.calls.map(call => call[0]);
  assert.deepEqual(inserted.h.calls.filter(call => call[0] === 'stop-background'), [['stop-background', 's1']]);
  assert.ok(names.indexOf('stop-background') < names.indexOf('dispatch'));
  const manual = cancelFixture();
  await manual.h.host.cancelActiveTurn('s1', { source: 'manual_cancel' });
  assert.equal(manual.h.calls.some(call => call[0] === 'stop-background'), false);
});

test('a partial assistant reply is persisted once, and a cancel never advances the FIFO', async () => {
  const { h } = cancelFixture({
    currentAssistantText: 'half an answer',
    currentToolCalls: [{ name: 'Read' }],
  });
  await h.host.cancelActiveTurn('s1');
  const appended = h.calls.filter(call => call[0] === 'append-message');
  assert.equal(appended.length, 1);
  assert.equal(appended[0][2].cancelled, true);
  assert.equal(appended[0][2].content, 'half an answer');
  // tick() is the FIFO drain. A cancel must not trigger it; only a classify D
  // verdict does, and that decision lives in the state machine + scheduler.
  assert.equal(h.calls.some(call => call[0] === 'tick'), false);
});

test('process cancellation terminalizes the detached provider attempt before the next turn', async () => {
  const providerAttempt = Object.freeze({
    runtimeEpoch: 'epoch-1', turnId: 'turn-1', routeAttemptId: 'attempt-1',
    routeGeneration: 1, providerId: 'provider-a',
  });
  const { h } = cancelFixture({ _activeRunner: { providerAttempt } });
  await h.host.cancelActiveTurn('s1');
  assert.deepEqual(h.calls.find(call => call[0] === 'finish-provider-attempt'), [
    'finish-provider-attempt',
    providerAttempt,
    { outcome: 'failed', errorCategory: 'cancelled', reasonCode: 'user_cancel' },
  ]);
});

test('concurrent and repeated cancels collapse into exactly one effective transition', async () => {
  const { child, h } = cancelFixture();
  const [first, second] = await Promise.all([
    h.host.cancelActiveTurn('s1', { operationId: 'op-1' }),
    h.host.cancelActiveTurn('s1', { operationId: 'op-2' }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.deduplicated, true);
  assert.equal(second.operationId, 'op-1', 'the retry joins the running operation');
  assert.equal(h.calls.filter(call => call[0] === 'dispatch').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'append-message').length, 0);
  assert.equal(child.kills, 1, 'no duplicate kill');

  // A later click, after classify has persisted the cancel, re-publishes the
  // projection (repairing a stale card) without a second kill or verdict.
  h.setClassifyState('E');
  h.setCancelledAt(Date.now());
  const repeat = await h.host.cancelActiveTurn('s1');
  assert.equal(repeat.ok, true);
  assert.equal(repeat.alreadyCancelled, true);
  assert.equal(h.calls.filter(call => call[0] === 'dispatch').length, 1);
  assert.deepEqual(h.calls.filter(call => call[0] === 'reconcile').pop(), [
    'reconcile', 'task-1', { classifyState: 'E', reason: 'cancel_repeat' },
  ]);
});

test('a repeat cancel still closes a superseded scheduler entry stuck on running', async () => {
  // Production wedge: the record already carried E/cancelledAt (restart-
  // interrupted task) while a recovery notice was the scheduler's active
  // entry; "insert now" superseded it, but the repeat-cancel early return
  // skipped the turn close, leaving state 'running' so every delivery
  // deferred on run_active and the inserted message never ran.
  const h = fixture({ record: { taskState: { classifyState: 'E', cancelledAt: 1 } } });
  // Fixture scheduler starts in 'running' with a superseded active entry.
  const result = await h.host.cancelActiveTurn('s1', { source: 'insert_queued' });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyCancelled, true);
  assert.equal(h.calls.some(call => call[0] === 'dispatch'), false,
    'no second verdict — the record is already terminal');
  assert.equal(h.calls.some(call => call[0] === 'assessing'), true,
    'the stuck running boundary must be closed through turnEnded');
  const complete = h.calls.find(call => call[0] === 'complete');
  assert.ok(complete, 'the superseded active entry must be completed');
  assert.equal(complete[1].classifyState, 'E');
  assert.equal(h.calls.some(call => call[0] === 'tick'), true,
    'releasing the slot re-drives the FIFO so the priority insert can claim it');
});

test('a repeat cancel closes a cross-task dispatch entry that supersedes this session\'s own task', async () => {
  // Production wedge: the active scheduler slot is held by a "回投" delivery
  // whose taskId belongs to ANOTHER task than the one bound to this session
  // (_currentTaskId). The repeat-cancel recovery path must close the slot's
  // ACTUAL owner, not assert the session's own taskId as expected — asserting
  // the wrong taskId trips active_task_mismatch and silently fails to release
  // the slot, wedging the FIFO for every subsequent delivery (including a
  // priority "insert now" message, which is then never claimed).
  const h = fixture({
    record: { taskState: { classifyState: 'E', cancelledAt: 1 } },
    chatState: { _currentTaskId: 'task-own' },
    activeTaskId: 'task-other',
  });
  const result = await h.host.cancelActiveTurn('s1', { source: 'insert_queued' });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyCancelled, true);
  assert.equal(h.calls.some(call => call[0] === 'warn'
    && call[1] === 'session_cancel_repeat_close_failed'), false,
    'the mismatch guard must not reject closing the slot\'s real owner');
  const complete = h.calls.find(call => call[0] === 'complete');
  assert.ok(complete, 'the cross-task active entry must actually be completed, not silently skipped');
  assert.equal(complete[1].expectedTaskId, 'task-other',
    'expectedTaskId must target the slot\'s actual owner, not the session\'s own bound task');
  assert.equal(h.calls.some(call => call[0] === 'tick'), true,
    'releasing the slot re-drives the FIFO so the priority insert can claim it');
  // The session's own task projection is still reconciled against its own id.
  assert.deepEqual(h.calls.find(call => call[0] === 'reconcile'), [
    'reconcile', 'task-own', { classifyState: 'E', reason: 'cancel_repeat' },
  ]);
});

test('a runner that refuses to stop reports an explicit failure instead of pretending it cancelled', async () => {
  const { h } = cancelFixture({}, { runnerStopTimeoutMs: 0, stuckRunner: true });
  const result = await h.host.cancelActiveTurn('s1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'runner_stop_timeout');
  assert.equal(result.classifyState, 'E');
  assert.equal(result.cancelReason, 'cancel_stop_timeout');
  const verdict = h.calls.find(call => call[0] === 'dispatch')[1];
  assert.equal(verdict.state, 'E');
  assert.equal(verdict.cancel.runnerStopped, false);
  assert.equal(verdict.cancel.reason, 'cancel_stop_timeout');
});

function siblingWorkspace(state) {
  return createShellWorkspaceHost({
    records: new Map([
      ['s1', { id: 's1' }],
      ['s2', { id: 's2', workspaceOwnerSessionId: 's1' }],
    ]),
    getChatState: id => id === 's1' ? state : null,
    getWorkHost: () => null,
  });
}

test('confirmed cancellation releases the workspace for the next sibling task', async () => {
  const { state, h } = cancelFixture();
  const workspace = siblingWorkspace(state);
  assert.equal(workspace.busy('s2'), true);
  assert.equal((await h.host.cancelActiveTurn('s1')).ok, true);
  assert.equal(workspace.busy('s2'), false);
});

test('SDK cancellation waits for the turn to drain while allowing the native process to remain alive', async () => {
  let busy = true, interrupted = false;
  const state = { cli: 'claude-exp', isStreaming: true, _activeRunner: {} };
  const h = fixture({ chatState: state, runnerStopTimeoutMs: 2000,
    chatStream: {
      isAlive: () => true,
      status: () => ({ busy }),
      cancel() { interrupted = true; setTimeout(() => { busy = false; }, 20); },
    },
  });
  const result = await h.host.cancelActiveTurn('s1');
  assert.equal(result.ok, true);
  assert.equal(interrupted, true);
  assert.equal(busy, false, 'runner stop must wait for the SDK result/interrupt boundary');
  assert.equal(state._activeRunner, null);
});

test('a failed cancellation retains the runner claim and blocks sibling tasks', async () => {
  const { state, h } = cancelFixture({}, { diesOn: null, runnerStopTimeoutMs: 0 });
  const runner = state._activeRunner;
  assert.equal((await h.host.cancelActiveTurn('s1')).ok, false);
  assert.equal(state._activeRunner, runner);
  assert.equal(siblingWorkspace(state).busy('s2'), true);
});

test('cancellation never clears a replacement runner installed while the old process exits', async () => {
  const { child, state, h } = cancelFixture();
  const replacement = {};
  child.once('exit', () => { state._activeRunner = replacement; });
  assert.equal((await h.host.cancelActiveTurn('s1')).ok, true);
  assert.equal(state._activeRunner, replacement);
  assert.equal(siblingWorkspace(state).busy('s2'), true);
});

test('a runner that ignores SIGTERM is escalated to SIGKILL rather than left running', async () => {
  const { child, state, h } = cancelFixture({}, {
    diesOn: 'SIGKILL',
    runnerKillGraceMs: 10,
    runnerStopTimeoutMs: 2_000,
  });
  const result = await h.host.cancelActiveTurn('s1');

  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  // The escalation is loud: a CLI that had to be killed is worth a log line.
  assert.equal(h.calls.some(call => call[0] === 'warn' && call[1] === 'session_cancel_runner_force_kill'), true);
  // Dead is dead — the cancel succeeds, and the handle kept for the liveness
  // check is released by the process's own exit event.
  assert.equal(state._cancelledProc, null);
  assert.equal(result.ok, true);
  const verdict = h.calls.find(call => call[0] === 'dispatch')[1];
  assert.equal(verdict.cancel.runnerStopped, true);
  assert.equal(verdict.cancel.reason, 'user_cancelled');
});

test('a process surviving SIGKILL is reported as a failed stop, not a successful cancel', async () => {
  const { child, h } = cancelFixture({}, {
    diesOn: null,
    runnerKillGraceMs: 5,
    runnerStopTimeoutMs: 60,
  });
  const result = await h.host.cancelActiveTurn('s1');

  // Both signals were actually tried before giving up.
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'runner_stop_timeout');
  assert.equal(result.cancelReason, 'cancel_stop_timeout');
  // Detaching claudeProc used to be read as "stopped": the wait must not be
  // satisfied by the bookkeeping that hides the process from the turn.
  assert.equal(h.calls.some(call => call[0] === 'warn' && call[1] === 'session_cancel_runner_stop_timeout'), true);
});

test('cancel drops this session\'s queued and in-flight classify jobs before submitting its own verdict', async () => {
  const { h } = cancelFixture();
  await h.host.cancelActiveTurn('s1');
  const dropped = h.calls.filter(call => call[0] === 'cancel-classify-jobs');
  assert.deepEqual(dropped, [['cancel-classify-jobs', 's1']]);
  // Ordering: the stale judgement is dropped as part of stopping the runner, so
  // the only classify input left for this turn is the cancel verdict itself.
  const order = h.calls.map(call => call[0]);
  assert.ok(order.indexOf('cancel-classify-jobs') < order.indexOf('dispatch'));
});

test('cancel with no active scheduler entry still republishes the canonical snapshot', async () => {
  const { h } = cancelFixture();
  h.forceState('idle');
  const result = await h.host.cancelActiveTurn('s1');
  assert.equal(result.ok, true);
  assert.equal(result.alreadyIdle, true);
  // The silence in this branch is exactly how a card stayed on `running`.
  assert.equal(h.calls.filter(call => call[0] === 'dispatch').length, 1);
  assert.equal(h.calls.some(call => call[0] === 'reconcile'), true);
});

test('turn boundary parks FIFO until classify D is the sole completion verdict', async () => {
  const h = fixture();
  const closing = h.host.turnSucceeded('s1');
  const result = await closing;
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.find(call => call[0] === 'assessing'), ['assessing']);
  assert.equal(h.calls.some(call => call[0] === 'complete'), false);
  assert.equal(h.calls.some(call => call[0] === 'tick'), false);

  const classification = await h.host.classifyTransition(
    's1', 'task-1', { state: 'D' },
  );
  assert.equal(classification.ok, true);
  assert.deepEqual(h.calls.find(call => call[0] === 'complete'), [
    'complete', { expectedTaskId: 'task-1', reason: 'classified_D', classifyState: 'D' },
  ]);
  assert.equal(h.calls.some(call => call[0] === 'tick'), true);
  assert.equal(h.calls.some(call => call[0] === 'freeze'), false);
});

test('a slot claimed by a dispatch result closes on the owner session\'s own verdict', async () => {
  // Legacy persisted slot: the dispatch.result lent the DISPATCHED task's id as
  // lineage. The owner's turn-end verdict names its own task; rejecting it as
  // active_task_mismatch left the slot 'assessing' forever (dispatcher wedged,
  // worker card stuck 「执行中」).
  const h = fixture({ activeEntryId: 'operation:op-1:result', activeTaskId: 'tsk-worker' });
  await h.host.turnSucceeded('s1');
  const classification = await h.host.classifyTransition('s1', 'tsk-owner', { state: 'D' });
  assert.equal(classification.ok, true);
  assert.deepEqual(h.calls.find(call => call[0] === 'complete'), [
    'complete', { expectedTaskId: 'tsk-worker', reason: 'classified_D', classifyState: 'D' },
  ]);

  // Ordinary entries keep the mismatch guard.
  const guarded = fixture({ activeTaskId: 'tsk-worker' });
  await guarded.host.turnSucceeded('s1');
  const rejected = await guarded.host.classifyTransition('s1', 'tsk-owner', { state: 'D' });
  assert.equal(rejected.code, 'active_task_mismatch');
});

test('inactive classify scan repairs a missing turn boundary before applying its verdict', async () => {
  const h = fixture();
  const classification = await h.host.classifyTransition(
    's1',
    'task-1',
    { state: 'W' },
    { recoverMissingBoundary: true, livenessReason: 'owned_process_exited' },
  );
  assert.equal(classification.ok, true);
  const assessingIndex = h.calls.findIndex(call => call[0] === 'assessing');
  const completeIndex = h.calls.findIndex(call => call[0] === 'complete');
  assert.ok(assessingIndex >= 0 && completeIndex > assessingIndex);
  assert.deepEqual(h.calls[completeIndex], [
    'complete', { expectedTaskId: 'task-1', reason: 'classified_W', classifyState: 'W' },
  ]);
});

test('classify cannot repair a running scheduler without trusted inactive liveness', async () => {
  const h = fixture();
  const classification = await h.host.classifyTransition(
    's1', 'task-1', { state: 'D' },
  );
  assert.deepEqual(classification, { ok: false, code: 'stale_classification' });
  assert.equal(h.calls.some(call => call[0] === 'assessing'), false);
  assert.equal(h.calls.some(call => call[0] === 'complete'), false);
});

test('lost-boundary recovery rejects a stale task before mutating the active scheduler', async () => {
  const h = fixture({ activeTaskId: 'task-current' });
  const classification = await h.host.classifyTransition(
    's1',
    'task-stale',
    { state: 'D' },
    { recoverMissingBoundary: true, livenessReason: 'owned_process_exited' },
  );
  assert.deepEqual(classification, { ok: false, code: 'active_task_mismatch' });
  assert.equal(h.calls.some(call => call[0] === 'assessing'), false);
  assert.equal(h.calls.some(call => call[0] === 'complete'), false);
});

test('chat admission waits for the closing turn to enter classify assessment', async t => {
  const h = await nativeAdmissionFixture(t);
  const closing = h.host.turnSucceeded('s1');
  const admitted = h.host.admit('s1', 'new direct message', { clientMsgId: 'client-1' });
  const [, result] = await Promise.all([closing, admitted]);
  const assessingIndex = h.calls.findIndex(call => call[0] === 'assessing');
  const admitIndex = h.calls.findIndex(call => call[0] === 'admit');
  assert.ok(assessingIndex >= 0 && admitIndex > assessingIndex);
  assert.equal(result.entry.payload.source, 'direct');
});

test('failed turn closure is serialized before its classify verdict', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = fixture({ releaseTurnEnded: gate });
  const closing = h.host.turnFailed('s1', 'provider_error');
  const classification = h.host.classifyTransition(
    's1', 'task-1', { state: 'E' },
  );
  await Promise.resolve();
  assert.equal(h.calls.some(call => call[0] === 'freeze'), false);

  release();
  await Promise.all([closing, classification]);
  const assessingIndex = h.calls.findIndex(call => call[0] === 'assessing');
  // No classify-driven freeze anymore: every verdict (incl. E) releases the
  // active slot via complete(). The failed turn's closure still serializes
  // before its verdict, so complete lands after assessing.
  const completeIndex = h.calls.findIndex(call => call[0] === 'complete');
  assert.ok(assessingIndex >= 0 && completeIndex > assessingIndex);
  assert.equal(h.calls.some(call => call[0] === 'freeze'), false);
});

test('only classify P stages direct input; every non-P state continues immediately', async t => {
  for (const classifyState of ['D', 'W', 'B', 'E', null]) {
    const h = await nativeAdmissionFixture(t, { classifyState });
    const result = await h.host.admit('s1', `direct ${classifyState}`, {
      clientMsgId: `client-${classifyState}`,
    });
    const admission = result.entry.payload;
    assert.equal(admission.source, 'direct');
    assert.equal(admission.workKind, 'continuation', `classify ${classifyState}`);
    assert.equal(admission.activeEntryId, 'entry-1', `classify ${classifyState}`);
  }

  const processing = await nativeAdmissionFixture(t, { classifyState: 'P' });
  const staged = (await processing.host.admit('s1', 'stage during process', { clientMsgId: 'client-p' })).entry.payload;
  assert.equal(staged.source, 'direct');
  assert.equal(staged.workKind, 'task');
  assert.equal(staged.activeEntryId, null);
});

test('waiting direct input has the same immediate continuation contract for every chat CLI', async t => {
  for (const cli of ['claude', 'codex', 'opencode']) {
    const h = await nativeAdmissionFixture(t, { record: { cli }, classifyState: 'W' });
    const result = await h.host.admit('s1', `waiting reply for ${cli}`, {
      clientMsgId: `waiting-${cli}`,
    });
    const admission = result.entry.payload;
    assert.equal(admission.source, 'direct');
    assert.equal(admission.workKind, 'continuation', cli);
    assert.equal(admission.activeEntryId, 'entry-1', cli);
  }
});

test('queued projection does not make its own outbox delivery look busy', () => {
  const h = fixture();
  h.host.onSchedulerEvent({
    type: 'queued',
    sessionId: 's1',
    schedulerState: 'idle',
    queuedItems: [],
    at: 10,
  });
  assert.equal(h.host.getRunState('s1'), 'queued');
  assert.equal(h.host.isRunActive('s1'), false);

  h.host.onSchedulerEvent({
    type: 'started',
    sessionId: 's1',
    schedulerState: 'running',
    queuedItems: [],
    at: 11,
  });
  assert.equal(h.host.isRunActive('s1'), true);
});

test('editing a staged message broadcasts the new body without inventing a session state', () => {
  const h = fixture();
  h.host.onSchedulerEvent({
    type: 'queued_edited',
    sessionId: 's1',
    entryId: 'entry-1',
    schedulerState: 'running',
    queuedItems: [
      { entryId: 'entry-1', state: 'pending', position: 1, text: '改过的正文' },
    ],
    at: 30,
  });
  const broadcast = h.calls.filter(call => call[0] === 'broadcast').at(-1);
  assert.equal(broadcast[2].type, 'session_queue');
  assert.equal(broadcast[2].event, 'queued_edited');
  // The event name is bookkeeping, not a session state: clients switch on this.
  assert.equal(broadcast[2].state, 'running');
  assert.equal(broadcast[2].items[0].text, '改过的正文');
  const patch = h.calls.filter(call => call[0] === 'task-state').at(-1)[2];
  assert.equal(patch.queueState, 'running');
  assert.equal(h.host.getRunState('s1'), 'running');
});

test('a live queue outranks the stale classify verdict left by the previous turn', () => {
  const h = fixture({
    classifyDisplay: state => ({
      cardStatus: state === 'D' ? 'succeeded' : state === 'W' ? 'waiting' : 'running',
    }),
  });
  // The last turn closed with a D verdict (执行成功)...
  h.setClassifyState('D');
  assert.equal(h.host.getRunState('s1'), 'succeeded');

  // ...then a follow-up starts: the queue goes live, but classify only
  // re-fires at turn end / scan, so the verdict is stale for the whole turn.
  h.host.onSchedulerEvent({
    type: 'started',
    sessionId: 's1',
    schedulerState: 'running',
    queuedItems: [],
    at: 20,
  });
  assert.equal(h.host.getRunState('s1'), 'running');
  assert.equal(h.host.isRunActive('s1'), true);

  // A queued follow-up likewise outranks the stale verdict.
  h.host.onSchedulerEvent({
    type: 'queued',
    sessionId: 's1',
    schedulerState: 'idle',
    queuedItems: [],
    at: 21,
  });
  assert.equal(h.host.getRunState('s1'), 'queued');

  // Once the queue drains back to idle, the verdict is authoritative again.
  h.host.onSchedulerEvent({
    type: 'idle',
    sessionId: 's1',
    schedulerState: 'idle',
    queuedItems: [],
    at: 22,
  });
  assert.equal(h.host.getRunState('s1'), 'succeeded');
});

test('a released W turn admits its correlated structured answer as a new control entry', async t => {
  const h = await nativeAdmissionFixture(t, { state: 'idle', classifyState: 'W', pending: {
    requestId: 'usrq-1',
    taskId: 'task-1',
    resolved: false,
  } });

  const result = await h.host.admit('s1', '继续', {
    userInputRequestId: 'usrq-1',
    clientMsgId: 'client-answer',
  });
  assert.equal(result.ok, true);
  const admission = result.entry.payload;
  assert.equal(admission.workKind, 'answer');
  assert.equal(admission.requestId, 'usrq-1');
  assert.equal(admission.activeEntryId, null);
  assert.equal(admission.options.taskId, 'task-1');
  const persisted = (await h.store.sessionWorkState({ action: 'read', sessionId: 's1' })).pendingQuestion;
  assert.equal(persisted.resolved, true);
  assert.deepEqual(persisted.resolvedNotification,
    { type: 'user_input_resolved', requestId: 'usrq-1', taskId: 'task-1' });
  assert.deepEqual(result.notification, persisted.resolvedNotification);
  assert.equal(result.answerConsumed.requestId, 'usrq-1');
  assert.equal(h.calls.some(call => call[0] === 'resolve-user-input'), false);
  assert.deepEqual(h.calls.find(call => call[0] === 'broadcast' && call[2]?.type === 'user_input_resolved')?.slice(1),
    ['s1', { type: 'user_input_resolved', requestId: 'usrq-1', taskId: 'task-1' }]);
  const replay = await h.host.admit('s1', '继续', {
    userInputRequestId: 'usrq-1', clientMsgId: 'client-answer',
  });
  assert.equal(replay.duplicate, true);
  assert.equal(h.calls.filter(call => call[0] === 'broadcast' && call[2]?.type === 'user_input_resolved').length, 1);
});

test('a running turn durably consumes its structured answer without ordinary queue semantics', async t => {
  const h = await nativeAdmissionFixture(t, { classifyState: 'P', pending: {
    requestId: 'usrq-running',
    taskId: 'task-running',
    resolved: false,
  } });

  const result = await h.host.admit('s1', '选项 A', {
    userInputRequestId: 'usrq-running',
    clientMsgId: 'client-running-answer',
  });
  assert.equal(result.ok, true);
  const admission = result.entry.payload;
  assert.equal(admission.workKind, 'answer');
  assert.equal(admission.requestId, 'usrq-running');
  assert.equal(admission.options.taskId, 'task-running');
  const persisted = (await h.store.sessionWorkState({ action: 'read', sessionId: 's1' })).pendingQuestion;
  assert.equal(persisted.resolved, true);
  assert.deepEqual(persisted.resolvedNotification,
    { type: 'user_input_resolved', requestId: 'usrq-running', taskId: 'task-running' });
  assert.deepEqual(result.notification, persisted.resolvedNotification);
  assert.equal(result.answerConsumed.requestId, 'usrq-running');
  assert.equal(h.calls.some(call => call[0] === 'resolve-user-input'), false);
  assert.deepEqual(h.calls.find(call => call[0] === 'broadcast' && call[2]?.type === 'user_input_resolved')?.slice(1),
    ['s1', { type: 'user_input_resolved', requestId: 'usrq-running', taskId: 'task-running' }]);
});

test('unattended input stays in FIFO through processing, wait and fault without consuming a question', async t => {
  for (const [classifyState, source] of ['P', 'D', 'W', 'E'].flatMap(state =>
    ['direct', 'task-shell'].map(source => [state, source]))) {
    const h = await nativeAdmissionFixture(t, { record: { unattended: { status: 'active' } },
      classifyState, pending: { requestId: 'auto-question', resolved: false } });
    const result = await h.host.admit('s1', '下一项工作', {
      userInputRequestId: 'auto-question', clientMsgId: `queued-${classifyState}`,
      taskSource: source,
      ...(source === 'task-shell' ? { originContinue: true, taskShellControl: { intent: 'answer' } } : {}),
    });
    assert.equal(result.ok, true);
    const admission = result.entry.payload;
    assert.equal(admission.workKind, 'task', `${source}/${classifyState}`);
    assert.equal(admission.requestId, null, classifyState);
    assert.equal(admission.activeEntryId, null, classifyState);
    assert.equal('userInputRequestId' in admission.options, false);
    assert.equal('taskShellControl' in admission.options, false);
    assert.equal(h.calls.some(call => call[0] === 'resolve-user-input'), false);
    assert.equal((await h.store.sessionWorkState({ action: 'read', sessionId: 's1' })).pendingQuestion.resolved, false);
  }
});

test('a stale picker correlation degrades to ordinary input instead of blocking send', async t => {
  const h = await nativeAdmissionFixture(t, { state: 'idle', classifyState: 'W', pending: {
    requestId: 'usrq-current',
    taskId: 'task-current',
    resolved: false,
  } });

  const result = await h.host.admit('s1', '旧选择仍作为文字发送', {
    userInputRequestId: 'usrq-stale',
    clientMsgId: 'client-stale-answer',
  });
  assert.equal(result.ok, true);
  const admission = result.entry.payload;
  assert.equal(admission.workKind, 'task');
  assert.equal(admission.requestId, null);
  assert.equal(admission.activeEntryId, null);
  assert.equal('userInputRequestId' in admission.options, false);
});

test('recovery state exposes only unresolved request correlation to the scheduler', () => {
  const h = fixture();
  h.setPending({
    requestId: 'usrq-recovery',
    taskId: 'task-1',
    question: 'must stay in task state',
    options: ['yes', 'no'],
    resolved: false,
  });
  assert.deepEqual(h.host.recoveryState('s1').pendingUserInput, {
    requestId: 'usrq-recovery',
    taskId: 'task-1',
    resolved: false,
  });
  h.setPending({ requestId: 'usrq-recovery', taskId: 'task-1', resolved: true });
  assert.equal(h.host.recoveryState('s1').pendingUserInput, null);
});

test('gateway recovery projects a durable ended P turn to D, but never invents an unproven end', () => {
  const durable = fixture({
    record: {
      type: 'gateway',
      taskState: { classifyState: 'P', startedAt: 100, endedAt: 200 },
    },
    chatState: { _currentTaskId: 'gateway-task' },
  });
  assert.deepEqual(durable.host.recoveryState('s1'), {
    classifyState: 'D',
    unattended: null,
    // Run-liveness proof for the native selector's dead-letter rule: this
    // fixture's run is still live, so a stale P letter must fail closed.
    runActive: true,
    startedAt: 100,
    endedAt: 200,
    taskId: 'gateway-task',
    pendingUserInput: null,
  });

  const interrupted = fixture({
    record: { type: 'gateway', taskState: { classifyState: 'P', startedAt: 100 } },
  });
  assert.equal(interrupted.host.recoveryState('s1').classifyState, 'P');

  const ordinary = fixture({
    record: { type: 'worker', taskState: { classifyState: 'P', startedAt: 100, endedAt: 200 } },
  });
  assert.equal(ordinary.host.recoveryState('s1').classifyState, 'P');
});

test('classify W/B/E release the active slot (no freeze); unavailable leaves assessment pending', async () => {
  // Queue rule (T1): every turn-end verdict releases the active slot via
  // complete(). FIFO draining is D-only and lives in selectSessionItem, not
  // here. W/B/E never freeze the queue anymore.
  const waiting = fixture();
  waiting.forceState('assessing');
  await waiting.host.classifyTransition('s1', 'task-1', { state: 'W' });
  assert.deepEqual(waiting.calls.find(call => call[0] === 'complete'), [
    'complete', { expectedTaskId: 'task-1', reason: 'classified_W', classifyState: 'W' },
  ]);
  assert.equal(waiting.calls.some(call => call[0] === 'freeze'), false);

  const structured = fixture();
  structured.setPending({
    requestId: 'usrq-1',
    taskId: 'task-1',
    resolved: false,
  });
  structured.forceState('assessing');
  await structured.host.classifyTransition('s1', 'task-1', { state: 'W' });
  assert.deepEqual(structured.calls.find(call => call[0] === 'complete'), [
    'complete', {
      expectedTaskId: 'task-1',
      reason: 'classified_W',
      classifyState: 'W',
      awaitingRequestId: 'usrq-1',
    },
  ]);

  const assessingError = fixture();
  assessingError.forceState('assessing');
  await assessingError.host.classifyTransition('s1', 'task-1', { state: 'E' });
  assert.deepEqual(assessingError.calls.find(call => call[0] === 'complete'), [
    'complete', { expectedTaskId: 'task-1', reason: 'classified_E', classifyState: 'E' },
  ]);
  assert.equal(assessingError.calls.some(call => call[0] === 'freeze'), false);

  const callback = fixture();
  callback.setPendingWait(true);
  callback.forceState('assessing');
  await callback.host.classifyTransition('s1', 'task-1', {
    state: 'B',
  });
  assert.deepEqual(callback.calls.find(call => call[0] === 'complete'), [
    'complete', { expectedTaskId: 'task-1', reason: 'classified_B', classifyState: 'B' },
  ]);
  assert.equal(callback.calls.some(call => call[0] === 'freeze'), false);

  const failed = fixture();
  await failed.host.turnFailed('s1', 'error');
  assert.deepEqual(failed.calls.find(call => call[0] === 'assessing'), ['assessing']);
  assert.equal(failed.calls.some(call => call[0] === 'freeze'), false);

  const unavailable = fixture();
  await unavailable.host.turnSucceeded('s1');
  const unavail = await unavailable.host.classifyUnavailable('s1', 'task-1', 'aux down');
  assert.equal(unavail.code, 'classification_deferred');
  assert.equal(unavailable.calls.some(call => call[0] === 'freeze'), false);
});

test('a watchdog-killed turn re-admits one continuation through the manual retry channel', async () => {
  // Production gap (task-fa4f22a3, 2026-11-18): a server crash killed the
  // Auto-handoff continuation turn; the watchdog settled the orphaned P entry
  // as E, but the Auto provider handoff only exists for turns that died WITH
  // an apiErrorDecision — so the promised 🔇 continuation sat in the history
  // and never ran. The watchdog settle must re-admit one continuation itself.
  const h = fixture();
  await h.host.turnSucceeded('s1');
  const classification = await h.host.classifyTransition('s1', 'task-1', {
    state: 'E',
    cancel: { source: 'process_watchdog', reason: 'process_watchdog', runnerStopped: true },
  });
  assert.equal(classification.ok, true);
  assert.deepEqual(h.calls.find(call => call[0] === 'complete'), [
    'complete', { expectedTaskId: 'task-1', reason: 'classified_E', classifyState: 'E' },
  ]);
  const retries = h.calls.filter(call => call[0] === 'resolve');
  assert.equal(retries.length, 1);
  assert.deepEqual(retries[0][1], {
    action: 'retry',
    actor: 'process_watchdog',
    reason: 'dead_runner_auto_retry',
    idempotencyKey: 'watchdog-retry:entry-1',
  });
  assert.equal(h.calls.some(call => call[0] === 'warn'
    && call[1] === 'session_scheduler_dead_runner_auto_retry'), true);
});

test('a manual cancel or an ordinary error verdict never triggers a dead-runner retry', async () => {
  const manual = fixture();
  await manual.host.turnSucceeded('s1');
  await manual.host.classifyTransition('s1', 'task-1', {
    state: 'E',
    cancel: { source: 'manual_cancel', reason: 'user_cancelled', runnerStopped: true },
  });
  assert.equal(manual.calls.some(call => call[0] === 'resolve'), false);

  const ordinary = fixture();
  await ordinary.host.turnSucceeded('s1');
  await ordinary.host.classifyTransition('s1', 'task-1', { state: 'E' });
  assert.equal(ordinary.calls.some(call => call[0] === 'resolve'), false);
});

test('a dead-runner retry yields to work that was queued while the cancel settled', async () => {
  // An Auto handoff 🔇 message (or a fresh user message) admitted while the
  // watchdog cancel was in flight already owns the continuation — retrying
  // behind it would double the work.
  const h = fixture({ queued: [{ entryId: 'entry-handoff' }] });
  await h.host.turnSucceeded('s1');
  await h.host.classifyTransition('s1', 'task-1', {
    state: 'E',
    cancel: { source: 'process_watchdog', reason: 'process_watchdog', runnerStopped: true },
  });
  assert.equal(h.calls.some(call => call[0] === 'resolve'), false);
});

test('dead-runner retries are capped per session and a D verdict resets the streak', async () => {
  const h = fixture();
  // Each cycle models one real turn: admitted (running) → ended (assessing) →
  // the runner's corpse found by the watchdog → settled E.
  const killCycle = async () => {
    h.forceState('running');
    await h.host.turnSucceeded('s1');
    await h.host.classifyTransition('s1', 'task-1', {
      state: 'E',
      cancel: { source: 'process_watchdog', reason: 'process_watchdog', runnerStopped: true },
    });
  };
  await killCycle();
  await killCycle();
  assert.equal(h.calls.filter(call => call[0] === 'resolve').length, 2);
  await killCycle();
  assert.equal(h.calls.filter(call => call[0] === 'resolve').length, 2,
    'a crash loop must not spin: the third consecutive dead runner is not retried');
  assert.equal(h.calls.some(call => call[0] === 'warn'
    && call[1] === 'session_scheduler_dead_runner_retry_exhausted'), true);

  // A completed (D) turn proves the lane is healthy again: the streak resets.
  h.forceState('running');
  await h.host.turnSucceeded('s1');
  await h.host.classifyTransition('s1', 'task-1', { state: 'D' });
  await killCycle();
  assert.equal(h.calls.filter(call => call[0] === 'resolve').length, 3);
});

test('the persisted watchdog cancel stamp arms the retry only while fresh', async () => {
  // Fallback attribution: an E settle that arrives without the cancel payload
  // still retries when the state machine persisted the watchdog's cancelSource
  // moments ago. cancelSource is never cleared by later turns, so a stale
  // stamp from an old cancel must NOT retry whatever happens to settle now.
  const fresh = fixture({
    record: { taskState: { cancelSource: 'process_watchdog', cancelledAt: Date.now() } },
  });
  await fresh.host.turnSucceeded('s1');
  await fresh.host.classifyTransition('s1', 'task-1', { state: 'E' });
  assert.equal(fresh.calls.filter(call => call[0] === 'resolve').length, 1);

  const stale = fixture({
    record: { taskState: { cancelSource: 'process_watchdog', cancelledAt: Date.now() - 120_000 } },
  });
  await stale.host.turnSucceeded('s1');
  await stale.host.classifyTransition('s1', 'task-1', { state: 'E' });
  assert.equal(stale.calls.some(call => call[0] === 'resolve'), false);
});

test('queued insert events preserve the scheduler state in queue projections', () => {
  const h = fixture();
  h.host.onSchedulerEvent({
    type: 'queued_inserted',
    sessionId: 's1',
    entryId: 'queued-2',
    schedulerState: 'frozen',
    queued: 2,
    queuedItems: [{ entryId: 'queued-2' }, { entryId: 'queued-1' }],
    queueSummary: {
      sessionId: 's1',
      depth: 2,
      state: 'frozen',
      classifyState: 'W',
      updatedAt: 120,
    },
    at: 123,
  });
  const projected = h.calls.find(call => call[0] === 'task-state');
  assert.deepEqual(projected, [
    'task-state',
    's1',
    {
      queueState: 'frozen',
      queueFreezeReason: null,
      queueUpdatedAt: 123,
    },
  ]);
  assert.deepEqual(h.calls.find(call => call[0] === 'workspace-queue'), [
    'workspace-queue',
    's1',
    {
      sessionId: 's1',
      depth: 2,
      state: 'frozen',
      classifyState: 'W',
      updatedAt: 120,
    },
  ]);
});

// ── replayState: user-input reconnect replay ────────────────────────────────
// user_input_resolved only reaches sockets online at answer time, so a client
// that reconnects later must get the settlement replayed — otherwise its stale
// choice card stays on screen forever (the reported app bug).

function collectReplay(h) {
  const sent = [];
  h.host.replayState('s1', msg => sent.push(msg));
  return sent;
}

test('replayState re-sends an unanswered card as user_input_required', () => {
  const h = fixture();
  h.setPending({
    requestId: 'usrq-open', question: '选哪个？', reason: '', options: ['A', 'B'],
    allowMultiple: false, taskId: 'task-9', resolved: false,
  });
  const sent = collectReplay(h);
  const required = sent.find(msg => msg.type === 'user_input_required');
  assert.ok(required);
  assert.equal(required.requestId, 'usrq-open');
  assert.deepEqual(required.options, ['A', 'B']);
  assert.ok(!sent.some(msg => msg.type === 'user_input_resolved'));
});

test('replayState re-sends the settlement for an already-resolved card', () => {
  const h = fixture({
    record: { taskState: { lastResolvedUserInput: { requestId: 'usrq-done', at: 5, taskId: 'task-2' } } },
  });
  const sent = collectReplay(h);
  const resolved = sent.find(msg => msg.type === 'user_input_resolved');
  assert.ok(resolved, 'late reconnect must learn the card was settled');
  assert.equal(resolved.requestId, 'usrq-done');
  assert.equal(resolved.replay, true);
  assert.ok(!sent.some(msg => msg.type === 'user_input_required'));
});

test('replayState falls back to a legacy resolved pending object', () => {
  const h = fixture();
  h.setPending({ requestId: 'usrq-legacy', taskId: 'task-3', resolved: true });
  const sent = collectReplay(h);
  const resolved = sent.find(msg => msg.type === 'user_input_resolved');
  assert.ok(resolved);
  assert.equal(resolved.requestId, 'usrq-legacy');
});

test('replayState flags superseded settlements so clients can render them', () => {
  const h = fixture({
    record: { taskState: { lastResolvedUserInput: { requestId: 'usrq-sup', at: 5, superseded: true } } },
  });
  const resolved = collectReplay(h).find(msg => msg.type === 'user_input_resolved');
  assert.equal(resolved.superseded, true);
});

test('replayState sends no user-input events when no card ever existed', () => {
  const h = fixture();
  const sent = collectReplay(h);
  assert.ok(!sent.some(msg => msg.type === 'user_input_required'));
  assert.ok(!sent.some(msg => msg.type === 'user_input_resolved'));
});


test('manual dismissal consumes only the matching wait and submits a structured verdict without an AI turn', async () => {
  const h = fixture({ record: { id: 's1', kind: 'chat', taskState: { classifyState: 'W' } } });
  h.forceState('idle');
  h.setPending({ requestId: 'old', taskId: 'task-1' });
  assert.equal((await h.host.dismissUserInput('s1', 'wrong')).code, 'request_id_mismatch');
  assert.equal(h.calls.length, 0);
  assert.equal((await h.host.dismissUserInput('s1', 'old')).ok, true);
  const verdict = h.calls.find(c => c[0] === 'dispatch');
  assert.equal(verdict[1].state, 'D');
  assert.equal(verdict[1].evidence, 'user_dismissed_question');
  assert.equal(verdict[2].taskId, 'task-1');
  assert.equal(h.calls.some(c => ['admit', 'tick', 'cancel-preparation'].includes(c[0])), false);
  assert.equal((await h.host.dismissUserInput('s1', 'old')).duplicate, true);
  assert.equal(h.calls.filter(c => c[0] === 'dispatch').length, 1);
});

test('manual dismissal rejects running turns, uncertain owners, and external waits', async () => {
  for (const options of [{ chatState: { isStreaming: true } }, { liveness: { state: 'unknown' } }, { external: true }]) {
    const h = fixture(options);
    h.forceState('idle');
    h.setPending({ requestId: 'old' });
    if (options.external) h.setPendingWait(true);
    assert.equal((await h.host.dismissUserInput('s1', 'old')).ok, false);
    assert.equal(h.calls.some(c => c[0] === 'resolve-user-input'), false);
  }
});

test('a restart-orphaned P turn with a pending question settles as W on that question', async () => {
  // recover() leaves the dead turn frozen/classify_running; without this the
  // card showed 执行中 forever although the session was waiting on the user.
  const h = fixture({
    record: { id: 's1', kind: 'chat', taskState: { classifyState: 'P', goal: 'g' } },
    freezeReason: 'classify_running',
    activeTaskId: 'task-1',
  });
  h.forceState('frozen');
  h.setPending({ requestId: 'usrq-1', taskId: 'task-1' });
  const result = await h.host.settleRecoveredQuestion('s1');
  assert.equal(result.ok, true);
  const verdict = h.calls.find(c => c[0] === 'dispatch');
  assert.equal(verdict[1].state, 'W');
  assert.equal(verdict[1].requestId, 'usrq-1');
  assert.equal(verdict[2].taskId, 'task-1');
  assert.equal(verdict[2].liveness.state, 'inactive');
  assert.equal(h.calls.some(c => c[0] === 'resolve-user-input'), false);
});

test('recovered-question settlement leaves other turns to the dead-runner path', async () => {
  const noQuestion = fixture({ freezeReason: 'classify_running' });
  noQuestion.forceState('frozen');
  assert.equal((await noQuestion.host.settleRecoveredQuestion('s1')).code, 'no_pending_request');
  const answered = fixture({ freezeReason: 'classify_running' });
  answered.forceState('frozen');
  answered.setPending({ requestId: 'usrq-1', resolved: true });
  assert.equal((await answered.host.settleRecoveredQuestion('s1')).code, 'no_pending_request');
  const otherFreeze = fixture({ freezeReason: 'incomplete_requires_resume' });
  otherFreeze.forceState('frozen');
  otherFreeze.setPending({ requestId: 'usrq-1' });
  assert.equal((await otherFreeze.host.settleRecoveredQuestion('s1')).code, 'not_recovered_turn');
  for (const h of [noQuestion, answered, otherFreeze]) {
    assert.equal(h.calls.some(c => c[0] === 'dispatch'), false);
  }
});

test('a provider-error stop kills the wedged child without detaching the turn', () => {
  const kills = [];
  let onExit = null;
  const proc = {
    pid: 4242,
    kill(signal) { kills.push(signal); },
    once(event, handler) { if (event === 'exit') onExit = handler; },
  };
  const chatState = { cli: 'opencode', claudeProc: proc, _activeRunner: {}, isStreaming: true };
  const h = fixture({ chatState, runnerKillGraceMs: 60_000 });
  const result = h.host.stopActiveTurnForProviderError('s1', {
    reason: 'provider_log_error',
    source: 'opencode_log_watchdog',
  });
  assert.deepEqual(result, { ok: true, pid: 4242 });
  assert.deepEqual(kills, ['SIGTERM']);
  // turn-engine's close handler keys off `claudeProc === proc` and the runner;
  // detaching either (as a cancel does) skips API-error classification, so the
  // provider-error stop must leave both in place.
  assert.equal(chatState.claudeProc, proc);
  assert.equal(chatState._activeRunner.killReason, undefined);
  // No cancel-chain side effects: no preparation/classify teardown, no scheduler
  // boundary close — the close handler owns the ending.
  assert.equal(h.calls.some(call => call[0] === 'cancel-preparation'), false);
  assert.equal(h.calls.some(call => call[0] === 'assessing'), false);
  assert.equal(typeof onExit, 'function');
  if (onExit) onExit();
});

test('a provider-error stop with no live process reports no_live_runner', () => {
  const h = fixture({ chatState: { cli: 'opencode', claudeProc: null } });
  assert.equal(h.host.stopActiveTurnForProviderError('s1').code, 'no_live_runner');
});

test('a provider-error cancel request takes the non-detaching stop path', async () => {
  const kills = [];
  const proc = { pid: 77, kill(signal) { kills.push(signal); }, once() {} };
  const chatState = { cli: 'opencode', claudeProc: proc, _activeRunner: {}, isStreaming: true };
  const h = fixture({ chatState, runnerKillGraceMs: 60_000 });
  const result = await h.host.cancelActiveTurn('s1', {
    reason: 'provider_log_error',
    source: 'opencode_log_watchdog',
    providerError: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.providerErrorStop, true);
  assert.deepEqual(kills, ['SIGTERM']);
  assert.equal(chatState.claudeProc, proc, 'runner stays attached for close-time finalization');
  // The cancel chain must not run: no E verdict, no scheduler boundary close.
  assert.equal(h.calls.some(call => call[0] === 'assessing'), false);
  assert.equal(h.calls.some(call => call[0] === 'dispatch'), false);
});

test('a provider-error cancel request with no live process falls back to the cancel chain', async () => {
  const h = fixture({ chatState: { cli: 'opencode', claudeProc: null } });
  const result = await h.host.cancelActiveTurn('s1', { providerError: true, source: 'opencode_log_watchdog' });
  assert.equal(result.ok, true);
  assert.equal(result.providerErrorStop, undefined);
  assert.equal(h.calls.some(call => call[0] === 'assessing'), true);
});
