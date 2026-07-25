'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSessionWorkHost } = require('../src/session-work-host');

function fixture() {
  const calls = [];
  let pending = null;
  let pendingWait = false;
  const scheduler = {
    status: async () => ({ state: 'running', active: { entryId: 'entry-1' } }),
    complete: async (_sessionId, options) => {
      calls.push(['complete', options]);
      return { ok: true };
    },
    freeze: async (_sessionId, reason, options) => {
      calls.push(['freeze', reason, options || {}]);
      return { ok: true };
    },
  };
  const runtime = {
    sessionScheduler: scheduler,
    hasPending: () => pendingWait,
    tick: async () => { calls.push(['tick']); },
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

test('durable provider completion advances FIFO without consulting Aux classification', async () => {
  const h = fixture();
  h.host.classifyTransition('s1', 'task-1', { state: 'waiting' });
  h.host.classifyUnavailable('s1', 'task-1', 'classification_error');
  assert.equal(h.calls.some(call => call[0] === 'freeze'), false);
  assert.equal(h.calls.some(call => call[0] === 'complete'), false);

  const result = await h.host.turnSucceeded('s1');
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.find(call => call[0] === 'complete'), [
    'complete', { reason: 'durable_turn_completed' },
  ]);
  assert.equal(h.calls.some(call => call[0] === 'tick'), true);
});

test('only structured user input, explicit callback waits and real failures freeze', async () => {
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
});
