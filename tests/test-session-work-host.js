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
    cancelClassify() {},
    assignKillReason() {},
    appendMessage() {},
    cancelPreparation: (...args) => calls.push(['cancel-preparation', ...args]),
    chatStream: { isAlive: () => false, cancel() {} },
    zcodeAuth: options.zcodeAuth || { ensureZcodeAuth: () => ({ ok: true }) },
    log: { warn: (...args) => calls.push(['warn', ...args]) },
  });
  return {
    calls,
    host,
    forceState,
    setClassifyState(value) { record.taskState.classifyState = value; },
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

test('cancel publishes classify E before scheduler I/O and ends the active turn', async () => {
  const child = {
    pid: 123,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill(signal) { this.killed = true; this.signal = signal; },
  };
  const state = {
    cli: 'codex',
    claudeProc: child,
    isStreaming: true,
    currentAssistantText: '',
    currentToolCalls: [],
    streamReplay: ['partial'],
    _activeRunner: {},
  };
  const h = fixture({ chatState: state });
  // The E write occurs synchronously before cancelActiveTurn reaches its first
  // scheduler await.
  const cancellation = h.host.cancelActiveTurn('s1');
  const immediate = h.calls.find(call => call[0] === 'task-state');
  assert.equal(immediate[2].classifyState, 'E');
  assert.equal(immediate[2].cancelReason, 'user_cancelled');
  assert.ok(Number.isFinite(immediate[2].cancelledAt));
  assert.deepEqual(h.calls.find(call => call[0] === 'cancel-preparation'), [
    'cancel-preparation', 's1', 'user_cancelled',
  ]);
  assert.equal(child.signal, 'SIGTERM');
  assert.equal(state.isStreaming, false);
  assert.deepEqual(state.streamReplay, []);

  const result = await cancellation;
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.find(call => call[0] === 'complete'), [
    'complete', { reason: 'user_cancelled', classifyState: 'E' },
  ]);
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
