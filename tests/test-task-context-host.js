'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createTaskContextHost } = require('../src/task-context-host');

function fixture(overrides = {}) {
  const states = new Map([['worker', { clients: new Set(['client']), _currentTaskId: null }]]);
  const messages = [];
  const events = [];
  const projected = [];
  const deliveries = new Set();
  const runTurns = [];
  const taskRunMessages = [];
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
    classifyDisplay: state => ({ cardStatus: state === 'D' ? 'succeeded' : 'running' }),
    randomUUID: () => 'uuid',
    getRecord: sessionId => records.get(sessionId),
    runTurn: (sessionId, text, options) => {
      runTurns.push({ sessionId, text, options });
      return true;
    },
    recordTaskRunMessage: (sessionId, message) => taskRunMessages.push({ sessionId, message: { ...message } }),
    ...overrides,
  });
  return { host, states, messages, events, projected, runTurns, records, taskRunMessages };
}

test('durably appended task-run messages are copied into the run-owned transcript', () => {
  const { host, states, taskRunMessages } = fixture();
  host.beginTurn(states.get('worker'), {
    id: 'task-1', runId: 'run-1', leaseEpoch: 2,
    start: true, source: 'task-board', text: 'execute',
  });
  host.appendMessage('worker', { id: 'assistant-1', role: 'assistant', content: 'done', ts: 10 });
  assert.equal(taskRunMessages.length, 1);
  assert.equal(taskRunMessages[0].message.taskRunId, 'run-1');
  assert.equal(taskRunMessages[0].message.leaseEpoch, 2);
});

test('task-run ledger is committed before the disposable slot history', () => {
  const order = [];
  const { host, states, messages } = fixture({
    append: (sessionId, message) => {
      order.push('chat');
      messages.push({ sessionId, ...message });
      return true;
    },
    recordTaskRunMessage: () => {
      order.push('ledger');
      return true;
    },
  });
  host.beginTurn(states.get('worker'), {
    id: 'task-1', runId: 'run-1', leaseEpoch: 2,
    start: true, source: 'task-board', text: 'execute',
  });
  assert.equal(host.appendMessage('worker', {
    id: 'assistant-1', role: 'assistant', content: 'done', ts: 10,
  }), true);
  assert.deepEqual(order, ['ledger', 'chat']);
  assert.equal(messages.length, 1);
});

test('task-run ledger failure blocks the disposable slot history write', () => {
  const { host, states, messages } = fixture({
    recordTaskRunMessage: () => false,
  });
  host.beginTurn(states.get('worker'), {
    id: 'task-1', runId: 'run-1', leaseEpoch: 2,
    start: true, source: 'task-board', text: 'execute',
  });
  assert.equal(host.appendMessage('worker', {
    id: 'assistant-1', role: 'assistant', content: 'done', ts: 10,
  }), false);
  assert.equal(messages.length, 0);
});

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

test('production gives every new untracked user/dispatch turn a provisional taskId', () => {
  const turnEngine = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'chat', 'turn-engine.js'),
    'utf8',
  );
  assert.match(turnEngine,
    /const provisionalAdmission = !requestedTask\.id && !reexecutePersistedDelivery\s*&& \(!originContinue \|\| directUserInput\)/);
  assert.match(turnEngine, /beginTurn\(cs,\s*requestedTask,\s*\{\s*provisional:\s*provisionalAdmission\s*\}\)/);
  assert.match(turnEngine, /messageMetadata\(messageTask,\s*nextTaskId,\s*\{\s*detached:\s*taskDetached\s*\}\)/);
});

test('a provisional admission replaces an unfinished prior task immediately', () => {
  const { host, states } = fixture();
  const state = states.get('worker');
  state._currentTaskId = 'tsk-prior';
  assert.deepEqual(host.beginTurn(state, {}, { provisional: true }), {
    taskId: 'tsk_uuid', boundaryChanged: true, detached: false,
  });
  assert.equal(state._currentTaskId, 'tsk_uuid');
});

test('ordinary chat gets a canonical task id on its first turn', () => {
  const { host, states } = fixture();
  const state = states.get('worker');
  assert.deepEqual(host.beginTurn(state, {}), {
    taskId: 'tsk_uuid', boundaryChanged: true, detached: false,
  });
  assert.equal(state._currentTaskId, 'tsk_uuid');
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

test('canonical session ingress runs both ordinary and Commander sessions through runTurn', async () => {
  const { host, states, runTurns } = fixture();
  states.set('commander', { clients: new Set(['commander-client']), _currentTaskId: null });

  const ordinary = await host.deliverSessionMessage('worker', '普通消息', {
    clientMsgId: 'ordinary-1',
  });
  assert.equal(ordinary.ok, true);
  assert.equal(ordinary.handled, false);
  assert.equal(runTurns.length, 1);
  assert.equal(runTurns[0].sessionId, 'worker');

  // Commander goes through the same runTurn path and may route through MCP.
  const commander = await host.deliverSessionMessage('commander', '派给工程师改 README', {
    clientMsgId: 'commander-1',
    taskSource: 'task-board',
  });
  assert.equal(commander.ok, true);
  assert.equal(commander.handled, false);
  assert.equal(runTurns.length, 2, 'Commander must start a model turn like any other session');
  assert.equal(runTurns[1].sessionId, 'commander');
  assert.equal(runTurns[1].text, '派给工程师改 README');
});

test('production wires task board and WebSocket chat to the same session ingress', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const turnEngine = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'chat', 'turn-engine.js'),
    'utf8',
  );
  assert.match(source,
    /sendSessionMessage:\s*\(\.\.\.args\)\s*=>\s*taskContextHost\.deliverSessionMessage\(\.\.\.args\)/);
  assert.match(turnEngine,
    /const deliver\s*=\s*\(\)\s*=>\s*taskContextHost\.deliverSessionMessage\(sessionName,\s*msg\.text,\s*turnOpts\)/);
  assert.match(turnEngine, /else await deliver\(\)/);
});
