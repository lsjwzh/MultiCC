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
    ...overrides,
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

test('a post-append projection exception cannot erase a confirmed history write', () => {
  for (const failingBoard of [
    () => { throw new Error('sensitive board error'); },
    () => ({ onMessagePersisted() { throw new Error('sensitive projection error'); } }),
  ]) {
    let writes = 0;
    const { host } = fixture({
      append: () => { writes++; return true; },
      getTaskBoard: failingBoard,
    });
    const originalWarn = console.warn;
    const warnings = [];
    try {
      console.warn = message => warnings.push(message);
      assert.equal(host.appendMessage('worker', { role: 'assistant', content: 'done' }), true);
    } finally { console.warn = originalWarn; }
    assert.equal(writes, 1);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /sensitive/);
  }
  const { host } = fixture({ append: () => { throw new Error('not persisted'); } });
  assert.throws(() => host.appendMessage('worker', { role: 'assistant' }), /not persisted/);
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

test('unattended arming rides the first message and only real human text pauses it', async () => {
  const armed = [];
  const noted = [];
  const { host, runTurns } = fixture({
    armUnattended: (id, spec, text) => armed.push({ id, spec, text }),
    noteUnattendedUserMessage: id => noted.push(id),
  });
  const first = await host.deliverSessionMessage('worker', 'ship it', {
    clientMsgId: 'unattended-1',
    unattended: { maxRounds: 5 },
  });
  assert.equal(first.ok, true);
  assert.deepEqual(armed, [{ id: 'worker', spec: { maxRounds: 5 }, text: 'ship it' }]);
  assert.deepEqual(noted, [], 'the first message arms the supervisor; it must not pause its own start');

  // Every host-authored class must NOT pause the supervisor:
  // supervisor answer (unattendedSystem), system delivery (🔇), marker-carrying
  // text, continuation/trigger admissions and an explicit system flag.
  await host.deliverSessionMessage('worker', 'B', {
    clientMsgId: 'unattended-2',
    userInputRequestId: 'usrq-1',
    unattendedSystem: true,
  });
  await host.deliverSessionMessage('worker', '🔇[background] done', { clientMsgId: 'unattended-3' });
  await host.deliverSessionMessage('worker', '[无人值守 Unattended] do X', { clientMsgId: 'unattended-4' });
  await host.deliverSessionMessage('worker', 'continue the task', { clientMsgId: 'unattended-5', originContinue: true });
  await host.deliverSessionMessage('worker', 'cron fired', { clientMsgId: 'unattended-6', originTrigger: true });
  assert.deepEqual(noted, [], 'no system-injected message pauses the supervisor');

  // A system-flagged supervisor delivery leaves with the 🔇 prefix.
  await host.deliverSessionMessage('worker', '[无人值守 Unattended] B', {
    clientMsgId: 'unattended-7',
    userInputRequestId: 'usrq-2',
    unattendedSystem: true,
    system: true,
  });
  assert.equal(runTurns.at(-1).text, '🔇[无人值守 Unattended] B');
  assert.deepEqual(noted, []);

  // A real human message is delivered unchanged and pauses.
  await host.deliverSessionMessage('worker', '取个新方向', { clientMsgId: 'unattended-8' });
  assert.equal(runTurns.at(-1).text, '取个新方向');
  assert.deepEqual(noted, ['worker']);
});

test('production wires task board and WebSocket chat to the same session ingress', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const turnEngine = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'chat', 'turn-engine.js'),
    'utf8',
  );
  assert.match(source,
    /sendSessionMessage:\s*\(\.\.\.args\)\s*=>\s*taskContextHost\.deliverSessionMessage\(\.\.\.args\)/);
  // Chat WS messages and task-board HTTP sends converge on the same ingress
  // call. Since the queued-turn refactor, auto-provider/memory admission prep
  // no longer lives inline in the WS handler; it is centralized in the reusable
  // prepareQueuedTurn hook wired as beforeDeliver so both entrypoints (and a
  // post-restart replay of the same queue record) prepare identically.
  assert.match(turnEngine,
    /await taskContextHost\.deliverSessionMessage\(sessionName,\s*msg\.text,\s*turnOpts\)/);
  assert.doesNotMatch(turnEngine,
    /const deliver\s*=\s*\(\)\s*=>\s*taskContextHost\.deliverSessionMessage\(sessionName,\s*msg\.text,\s*turnOpts\)/,
    'admission prep must live in the shared prepareQueuedTurn hook, not inline in the WS handler');
  assert.match(turnEngine,
    /prepareQueuedTurn:\s*createQueuedTurnPreparation\(\{/);
  assert.match(source,
    /beforeDeliver:\s*async descriptor\s*=>\s*\{\s*await chatTurnEngine\.prepareQueuedTurn\(descriptor\);[\s\S]*?return workspaceAdmission\.beforeDeliver\(descriptor\);?\s*\}/);
});
