'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTaskContextHost } = require('../src/task-context-host');

function fixture() {
  const states = new Map([['worker', { clients: new Set(['client']), _currentTaskId: null }]]);
  const messages = [];
  const events = [];
  const projected = [];
  const deliveries = new Set();
  const board = {
    onMessagePersisted: (sessionId, message) => projected.push({ sessionId, message: { ...message } }),
    routeCommanderInput: async () => ({
      ok: true,
      taskId: 'tsk-command',
      workerSessionId: 'worker',
      operationId: 'op-command',
    }),
  };
  const host = createTaskContextHost({
    getState: sessionId => states.get(sessionId),
    append: (sessionId, message) => {
      messages.push({ sessionId, ...message });
      if (message.clientMsgId) deliveries.add(`${sessionId}:${message.clientMsgId}`);
      return true;
    },
    emitClients: (clients, event) => events.push({ clients, event }),
    getTaskBoard: () => board,
    containsDelivery: (sessionId, id) => deliveries.has(`${sessionId}:${id}`),
    classifyDisplay: state => ({ cardStatus: state === 'D' ? 'completed' : 'running' }),
    randomUUID: () => 'uuid',
  });
  return { host, states, messages, events, projected };
}

test('task boundary and inherited events stay on the current task until a new id arrives', () => {
  const { host, states, messages, events } = fixture();
  const state = states.get('worker');
  const first = host.beginTurn(state, {
    id: 'tsk-one', start: true, source: 'task-board', text: 'one',
  });
  assert.deepEqual(first, { taskId: 'tsk-one', boundaryChanged: true });
  host.appendMessage('worker', { role: 'assistant', content: 'reply' });
  host.broadcast('worker', { type: 'tool_use', name: 'Read' });
  assert.equal(messages[0].taskId, 'tsk-one');
  assert.equal(events[0].event.taskId, 'tsk-one');

  const continuation = host.beginTurn(state, {});
  assert.deepEqual(continuation, { taskId: 'tsk-one', boundaryChanged: false });
  const second = host.beginTurn(state, {
    id: 'tsk-two', start: true, source: 'commander', text: 'two',
  });
  assert.deepEqual(second, { taskId: 'tsk-two', boundaryChanged: true });
});

test('Commander input routes once, persists a standard source message, and emits no assistant copy', async () => {
  const { host, states, messages, events } = fixture();
  const state = { clients: new Set(['commander-client']), _currentTaskId: null };
  states.set('commander', state);
  const input = {
    type: 'user_message',
    text: '完整任务正文',
    clientMsgId: 'client-1',
  };
  assert.equal(await host.handleCommander({
    persisted: { type: 'commander' },
    sessionName: 'commander',
    message: input,
    state,
  }), true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].taskId, 'tsk-command');
  assert.equal(messages[0].taskText, '完整任务正文');
  assert.equal(events.at(-1).event.type, 'result');
  assert.equal(events.some(entry => entry.event.type === 'assistant'), false);

  await host.handleCommander({
    persisted: { type: 'commander' },
    sessionName: 'commander',
    message: input,
    state,
  });
  assert.equal(messages.length, 1, 'replayed client message is not persisted twice');
});
