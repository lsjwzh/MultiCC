'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSessionWorkHost } = require('../src/session-work-host');

function fixture() {
  const calls = [];
  let pending = null;
  let pendingWait = false;
  let schedulerState = 'running';
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
    getRecord: () => ({ taskState: {} }),
    getChatSession: () => ({}),
    getTaskState: () => ({}),
    pendingUserInput: () => pending,
    recordUserInput: () => ({ ok: true }),
    broadcast() {},
    setTaskState() {},
    onTaskBoardQueueEvent() {},
    classifyDisplay: () => ({ cardStatus: 'running' }),
    cancelClassify() {},
    assignKillReason() {},
    appendMessage() {},
    chatStream: { isAlive: () => false, cancel() {} },
    log: { warn: (...args) => calls.push(['warn', ...args]) },
  });
  return {
    calls,
    host,
    forceState,
    setPending(value) { pending = value; },
    setPendingWait(value) { pendingWait = value; },
  };
}

test('durable provider completion advances the FIFO at the turn boundary; Aux classification never gates it', async () => {
  const h = fixture();
  const closing = h.host.turnSucceeded('s1');
  const result = await closing;
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.find(call => call[0] === 'complete'), [
    'complete', { reason: 'durable_turn_completed' },
  ]);
  assert.equal(h.calls.some(call => call[0] === 'tick'), true);

  // Classification arrives after the turn boundary completed the session: it
  // sees an idle scheduler and must not re-freeze it, whatever the letter.
  for (const state of ['completed', 'waiting', 'continue']) {
    const classification = await h.host.classifyTransition('s1', 'task-1', { state });
    assert.equal(classification.code, 'stale_classification', state);
  }
  assert.equal(h.calls.some(call => call[0] === 'freeze'), false);
});

test('chat admission waits for the closing turn to complete', async () => {
  const h = fixture();
  const closing = h.host.turnSucceeded('s1');
  const admitted = h.host.admit('s1', 'new direct message', { clientMsgId: 'client-1' });
  await Promise.all([closing, admitted]);
  const completeIndex = h.calls.findIndex(call => call[0] === 'complete');
  const admitIndex = h.calls.findIndex(call => call[0] === 'admit');
  assert.ok(completeIndex >= 0 && admitIndex > completeIndex);
  assert.equal(h.calls[admitIndex][1].source, 'direct');
});

test('plain W completes the turn boundary; structured requests, callbacks and real failures freeze', async () => {
  // Plain classify W against a turn still parked in assessing completes it:
  // W means the reply ended and the queue head is exactly the next message.
  const waiting = fixture();
  waiting.forceState('assessing');
  await waiting.host.classifyTransition('s1', 'task-1', { state: 'waiting' });
  assert.deepEqual(waiting.calls.find(call => call[0] === 'complete'), [
    'complete', { expectedTaskId: 'task-1', reason: 'classified_waiting_turn_boundary' },
  ]);
  assert.equal(waiting.calls.some(call => call[0] === 'freeze'), false);

  // A genuine classifier failure from assessing still freezes as an error.
  const assessingError = fixture();
  assessingError.forceState('assessing');
  await assessingError.host.classifyTransition('s1', 'task-1', { state: 'waiting', error: true });
  assert.deepEqual(assessingError.calls.find(call => call[0] === 'freeze'), [
    'freeze', 'error', { expectedTaskId: 'task-1' },
  ]);

  // Structured request_user_input freezes with its requestId (answer routing).
  const userInput = fixture();
  userInput.setPending({ requestId: 'request-1', resolved: false });
  await userInput.host.turnSucceeded('s1');
  assert.deepEqual(userInput.calls.find(call => call[0] === 'freeze'), [
    'freeze', 'awaiting_user_input', { requestId: 'request-1' },
  ]);

  // Explicit wait/callback still freezes.
  const callback = fixture();
  callback.setPendingWait(true);
  await callback.host.turnSucceeded('s1');
  assert.deepEqual(callback.calls.find(call => call[0] === 'freeze'), [
    'freeze', 'awaiting_callback', {},
  ]);

  // Real failures still freeze.
  const failed = fixture();
  await failed.host.turnFailed('s1', 'error');
  assert.deepEqual(failed.calls.find(call => call[0] === 'freeze'), [
    'freeze', 'error', {},
  ]);

  // Aux unavailability after a completed turn boundary is a no-op, not a freeze.
  const unavailable = fixture();
  await unavailable.host.turnSucceeded('s1');
  const unavail = await unavailable.host.classifyUnavailable('s1', 'task-1', 'aux down');
  assert.equal(unavail.code, 'stale_classification');
  assert.equal(unavailable.calls.some(call => call[0] === 'freeze'), false);
});
