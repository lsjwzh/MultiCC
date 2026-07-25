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
    setPending(value) { pending = value; },
    setPendingWait(value) { pendingWait = value; },
  };
}

test('durable provider completion pauses in assessing until Aux explicitly classifies D', async () => {
  const h = fixture();
  const closing = h.host.turnSucceeded('s1');
  const classification = h.host.classifyTransition('s1', 'task-1', { state: 'completed' });
  const result = await closing;
  assert.equal(result.ok, true);
  assert.equal(h.calls.some(call => call[0] === 'assessing'), true);

  await classification;
  assert.deepEqual(h.calls.find(call => call[0] === 'complete'), [
    'complete', { expectedTaskId: 'task-1', reason: 'classified_complete' },
  ]);
  assert.equal(h.calls.some(call => call[0] === 'tick'), true);
});

test('chat admission waits for the closing turn to land in assessing', async () => {
  const h = fixture();
  const closing = h.host.turnSucceeded('s1');
  const admitted = h.host.admit('s1', 'new direct message', { clientMsgId: 'client-1' });
  await Promise.all([closing, admitted]);
  const assessingIndex = h.calls.findIndex(call => call[0] === 'assessing');
  const admitIndex = h.calls.findIndex(call => call[0] === 'admit');
  assert.ok(assessingIndex >= 0 && admitIndex > assessingIndex);
  assert.equal(h.calls[admitIndex][1].source, 'direct');
});

test('W, structured user input, explicit callback waits and real failures freeze', async () => {
  const waiting = fixture();
  await waiting.host.turnSucceeded('s1');
  await waiting.host.classifyTransition('s1', 'task-1', { state: 'waiting' });
  assert.deepEqual(waiting.calls.find(call => call[0] === 'freeze'), [
    'freeze', 'awaiting_user_input', { expectedTaskId: 'task-1' },
  ]);

  const userInput = fixture();
  userInput.setPending({ requestId: 'request-1', resolved: false });
  await userInput.host.turnSucceeded('s1');
  assert.deepEqual(userInput.calls.find(call => call[0] === 'freeze'), [
    'freeze', 'awaiting_user_input', { requestId: 'request-1' },
  ]);

  const callback = fixture();
  callback.setPendingWait(true);
  await callback.host.turnSucceeded('s1');
  assert.deepEqual(callback.calls.find(call => call[0] === 'freeze'), [
    'freeze', 'awaiting_callback', {},
  ]);

  const failed = fixture();
  await failed.host.turnFailed('s1', 'error');
  assert.deepEqual(failed.calls.find(call => call[0] === 'freeze'), [
    'freeze', 'error', {},
  ]);

  const unavailable = fixture();
  await unavailable.host.turnSucceeded('s1');
  await unavailable.host.classifyUnavailable('s1', 'task-1', 'aux down');
  assert.deepEqual(unavailable.calls.find(call => call[0] === 'freeze'), [
    'freeze', 'classification_error', { expectedTaskId: 'task-1' },
  ]);
});
