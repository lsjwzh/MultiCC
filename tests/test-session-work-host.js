'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSessionWorkHost } = require('../src/session-work-host');

function fixture(options = {}) {
  const calls = [];
  let pending = null;
  let pendingWait = false;
  let schedulerState = 'running';
  let releaseTurnEnded = options.releaseTurnEnded || null;
  const record = { taskState: {}, ...(options.record || {}) };
  const chatState = options.chatState === undefined ? {} : options.chatState;
  const scheduler = {
    status: async () => ({
      state: schedulerState,
      active: schedulerState === 'idle' ? null : { entryId: 'entry-1' },
    }),
    complete: async (_sessionId, options) => {
      calls.push(['complete', options]);
      schedulerState = 'idle';
      return { ok: true };
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
      return { ok: true, entry: { id: 'entry-new' } };
    },
  };
  const host = createSessionWorkHost({
    runtime: () => runtime,
    getRecord: () => record,
    getChatSession: () => chatState,
    getTaskState: value => value?.taskState || {},
    pendingUserInput: () => pending,
    recordUserInput: () => ({ ok: true }),
    broadcast: (...args) => calls.push(['broadcast', ...args]),
    setTaskState: (sessionId, patch) => {
      record.taskState = { ...record.taskState, ...patch };
      calls.push(['task-state', sessionId, patch]);
    },
    onTaskBoardQueueEvent() {},
    classifyDisplay: () => ({ cardStatus: 'running' }),
    // classify is the only writer of business state; the host merely submits.
    dispatchStateAction: (result, ctx) => calls.push(['dispatch', result, ctx]),
    reconcileTaskProjection: (...args) => calls.push(['reconcile', ...args]),
    cancelClassify() {},
    assignKillReason() {},
    appendMessage: (...args) => calls.push(['append-message', ...args]),
    cancelPreparation: (...args) => calls.push(['cancel-preparation', ...args]),
    chatStream: { isAlive: () => false, cancel() {} },
    zcodeAuth: options.zcodeAuth || { ensureZcodeAuth: () => ({ ok: true }) },
    runnerStopTimeoutMs: options.runnerStopTimeoutMs,
    log: { warn: (...args) => calls.push(['warn', ...args]) },
  });
  return {
    calls,
    host,
    forceState,
    setClassifyState(value) { record.taskState.classifyState = value; },
    setCancelledAt(value) { record.taskState.cancelledAt = value; },
    setPending(value) { pending = value; },
    setPendingWait(value) { pendingWait = value; },
  };
}

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

function cancelFixture(overrides = {}, fixtureOptions = {}) {
  const child = {
    pid: 123,
    exitCode: null,
    signalCode: null,
    kills: 0,
    kill(signal) { this.kills += 1; this.signal = signal; },
  };
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

test('chat admission waits for the closing turn to enter classify assessment', async () => {
  const h = fixture();
  const closing = h.host.turnSucceeded('s1');
  const admitted = h.host.admit('s1', 'new direct message', { clientMsgId: 'client-1' });
  await Promise.all([closing, admitted]);
  const assessingIndex = h.calls.findIndex(call => call[0] === 'assessing');
  const admitIndex = h.calls.findIndex(call => call[0] === 'admit');
  assert.ok(assessingIndex >= 0 && admitIndex > assessingIndex);
  assert.equal(h.calls[admitIndex][1].source, 'direct');
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

test('only classify P stages direct input; every non-P state continues immediately', async () => {
  for (const classifyState of ['D', 'W', 'B', 'E', null]) {
    const h = fixture();
    h.setClassifyState(classifyState);
    await h.host.admit('s1', `direct ${classifyState}`, {
      clientMsgId: `client-${classifyState}`,
    });
    const admission = h.calls.find(call => call[0] === 'admit')[1];
    assert.equal(admission.source, 'direct');
    assert.equal(admission.workKind, 'continuation', `classify ${classifyState}`);
    assert.equal(admission.activeEntryId, 'entry-1', `classify ${classifyState}`);
  }

  const processing = fixture();
  processing.setClassifyState('P');
  await processing.host.admit('s1', 'stage during process', { clientMsgId: 'client-p' });
  const staged = processing.calls.find(call => call[0] === 'admit')[1];
  assert.equal(staged.source, 'direct');
  assert.equal(staged.workKind, null);
  assert.equal(staged.activeEntryId, null);
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

test('a released W turn admits its correlated structured answer as a new control entry', async () => {
  const h = fixture();
  h.forceState('idle');
  h.setClassifyState('W');
  h.setPending({
    requestId: 'usrq-1',
    taskId: 'task-1',
    resolved: false,
  });

  const result = await h.host.admit('s1', '继续', {
    userInputRequestId: 'usrq-1',
    clientMsgId: 'client-answer',
  });
  assert.equal(result.ok, true);
  const admission = h.calls.find(call => call[0] === 'admit')[1];
  assert.equal(admission.workKind, 'answer');
  assert.equal(admission.requestId, 'usrq-1');
  assert.equal(admission.activeEntryId, null);
  assert.equal(admission.options.taskId, 'task-1');
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

test('queued insert events preserve the scheduler state in queue projections', () => {
  const h = fixture();
  h.host.onSchedulerEvent({
    type: 'queued_inserted',
    sessionId: 's1',
    entryId: 'queued-2',
    schedulerState: 'frozen',
    queued: 2,
    queuedItems: [{ entryId: 'queued-2' }, { entryId: 'queued-1' }],
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
});
