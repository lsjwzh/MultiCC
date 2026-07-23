'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createTaskContextHost } = require('../src/task-context-host');

function fixture() {
  const states = new Map([['worker', { clients: new Set(['client']), _currentTaskId: null }]]);
  const messages = [];
  const events = [];
  const projected = [];
  const deliveries = new Set();
  const runTurns = [];
  const records = new Map([
    ['worker', { id: 'worker', kind: 'chat', type: 'worker' }],
    ['commander', { id: 'commander', kind: 'chat', type: 'commander' }],
  ]);
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
    getRecord: sessionId => records.get(sessionId),
    runTurn: (sessionId, text, options) => {
      runTurns.push({ sessionId, text, options });
      return true;
    },
  });
  return { host, states, messages, events, projected, runTurns, records };
}

test('task boundary and inherited events stay on the current task until a new id arrives', () => {
  const { host, states, messages, events } = fixture();
  const state = states.get('worker');
  const first = host.beginTurn(state, {
    id: 'tsk-one', start: true, source: 'task-board', text: 'one',
  });
  assert.deepEqual(first, { taskId: 'tsk-one', boundaryChanged: true, detached: false });
  host.appendMessage('worker', { role: 'assistant', content: 'reply' });
  host.broadcast('worker', { type: 'tool_use', name: 'Read' });
  assert.equal(messages[0].taskId, 'tsk-one');
  assert.equal(events[0].event.taskId, 'tsk-one');

  const continuation = host.beginTurn(state, {});
  assert.deepEqual(continuation, { taskId: 'tsk-one', boundaryChanged: false, detached: false });
  const second = host.beginTurn(state, {
    id: 'tsk-two', start: true, source: 'commander', text: 'two',
  });
  assert.deepEqual(second, { taskId: 'tsk-two', boundaryChanged: true, detached: false });
});

test('an untracked dispatch detaches from the prior task and survives history restore', () => {
  const { host, states, messages } = fixture();
  const state = states.get('worker');
  host.beginTurn(state, {
    id: 'tsk-board', start: true, source: 'task-board', text: 'board task',
  });
  host.appendMessage('worker', {
    role: 'user',
    content: 'board task',
    ...host.messageMetadata({
      id: 'tsk-board', start: true, source: 'task-board', text: 'board task',
    }, 'tsk-board'),
  });

  const detached = host.beginTurn(state, {}, { detach: true });
  assert.deepEqual(detached, { taskId: null, boundaryChanged: true, detached: true });
  host.appendMessage('worker', {
    role: 'user',
    content: 'A marker dispatch',
    ...host.messageMetadata({}, null, { detached: true }),
  });
  host.appendMessage('worker', { role: 'assistant', content: 'A result' });

  assert.equal(state._currentTaskId, null);
  assert.equal(messages.at(-2).taskDetached, true);
  assert.equal(messages.at(-2).taskId, undefined);
  assert.equal(messages.at(-1).taskId, undefined);
  assert.equal(host.restore(messages), null,
    'restart must not revive the task that preceded an untracked dispatch');
});

test('production detaches only dispatch requests that carry no canonical taskId', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /const detachTaskContext = !!originDispatchId && !requestedTask\.id/);
  assert.match(source, /beginTurn\(cs,\s*requestedTask,\s*\{\s*detach:\s*detachTaskContext\s*\}\)/);
  assert.match(source, /messageMetadata\(requestedTask,\s*nextTaskId,\s*\{\s*detached:\s*taskDetached\s*\}\)/);
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

test('task-board Commander ingress persists and broadcasts the original source exactly once', () => {
  const { host, states, messages, events } = fixture();
  states.set('commander', { clients: new Set(['commander-client']), _currentTaskId: null });
  const input = {
    sessionName: 'commander',
    text: '从任务板发来的完整正文',
    clientMsgId: 'board-client-1',
    taskId: 'tsk-board-1',
    taskStart: true,
    taskSource: 'task-board',
    taskText: '从任务板发来的完整正文',
    workerSessionId: 'worker',
    operationId: 'op-board',
  };

  assert.deepEqual(host.recordCommanderRoute(input), { ok: true, deduplicated: false });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sessionId, 'commander');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, input.text);
  assert.equal(messages[0].taskId, input.taskId);
  assert.equal(messages[0].taskStart, true);
  assert.equal(messages[0].taskSource, 'task-board');
  assert.equal(events.at(-1).event.type, 'result');
  assert.equal(events.at(-1).event.targetSessionId, 'worker');
  assert.equal(events.some(entry => entry.event.type === 'assistant'), false);

  assert.deepEqual(host.recordCommanderRoute(input), { ok: true, deduplicated: true });
  assert.equal(messages.length, 1, 'same board client id must not append twice');
});

test('canonical session ingress runs ordinary sessions and force-routes Commander sessions', async () => {
  const { host, states, messages, runTurns } = fixture();
  states.set('commander', { clients: new Set(['commander-client']), _currentTaskId: null });

  const ordinary = await host.deliverSessionMessage('worker', '普通消息', {
    clientMsgId: 'ordinary-1',
  });
  assert.equal(ordinary.ok, true);
  assert.equal(ordinary.handled, false);
  assert.equal(runTurns.length, 1);
  assert.equal(runTurns[0].sessionId, 'worker');

  const commander = await host.deliverSessionMessage('commander', '强制转发任务', {
    clientMsgId: 'commander-1',
    taskSource: 'task-board',
  });
  assert.equal(commander.ok, true);
  assert.equal(commander.handled, true);
  assert.equal(runTurns.length, 1, 'Commander must never start an ordinary model turn');
  assert.equal(messages.at(-1).sessionId, 'commander');
  assert.equal(messages.at(-1).content, '强制转发任务');
  assert.equal(messages.at(-1).taskSource, 'task-board');
});

test('production wires task board and WebSocket chat to the same session ingress', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source,
    /sendSessionMessage:\s*\(\.\.\.args\)\s*=>\s*taskContextHost\.deliverSessionMessage\(\.\.\.args\)/);
  assert.match(source,
    /const deliver\s*=\s*\(\)\s*=>\s*taskContextHost\.deliverSessionMessage\(sessionName,\s*msg\.text,\s*turnOpts\)/);
  assert.match(source, /else await deliver\(\)/);
});
