'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createWorkspaceRuntime } = require('../src/workspace/runtime');

class FakeSocket {
  constructor() {
    this.events = new Map();
    this.messages = [];
    this.closed = false;
    this.isAlive = false;
  }

  on(name, callback) {
    let callbacks = this.events.get(name);
    if (!callbacks) {
      callbacks = [];
      this.events.set(name, callbacks);
    }
    callbacks.push(callback);
  }

  emit(name) {
    for (const callback of this.events.get(name) || []) callback();
  }

  close() {
    this.closed = true;
    this.emit('close');
  }
}

function createHarness(overrides = {}) {
  let now = 1000;
  const records = overrides.records || new Map([
    ['done', { id: 'done', dirId: 'd1', summary: 'finished', summaryTs: 10, taskState: { classifyState: 'D' } }],
    ['working', { id: 'working', dirId: 'd1', taskState: { classifyState: 'P' } }],
    ['plain', { id: 'plain', dirId: 'd2', taskState: {} }],
    ['aux', { id: 'aux', dirId: 'd1', type: 'aux', summary: 'aux summary', taskState: { classifyState: 'D' } }],
  ]);
  const directories = overrides.directories || new Map([
    ['d1', { id: 'd1', label: 'One' }],
    ['d2', { id: 'd2', label: 'Two' }],
  ]);
  const chatSessions = overrides.chatSessions || new Map();
  const taskWrites = [];
  const saves = [];
  const runtime = createWorkspaceRuntime({
    records,
    directories,
    chatSessions,
    workspaceSnapshot: id => [{ id: `session-${id}` }],
    recentEvents: id => [{ id: `event-${id}` }],
    mergeState: (directory, record) => ({ directory: directory?.id, session: record.id }),
    send: (socket, payload) => socket.messages.push(payload),
    broadcastClients: (clients, payload) => {
      for (const socket of clients) socket.messages.push(payload);
    },
    setTaskState: (id, patch, options) => {
      taskWrites.push({ id, patch, options });
      const record = records.get(id);
      if (record) record.taskState = { ...(record.taskState || {}), ...patch };
    },
    saveBestEffort: source => saves.push(source),
    clock: () => ++now,
  });
  return { runtime, records, directories, chatSessions, taskWrites, saves };
}

test('dependency boundary fails closed before allocating runtime state', () => {
  assert.throws(() => createWorkspaceRuntime({}), /records map/);
  const harness = createHarness();
  assert.throws(() => createWorkspaceRuntime({
    records: harness.records,
    directories: harness.directories,
    chatSessions: harness.chatSessions,
  }), /workspaceSnapshot/);
});

test('startup hydration preserves summary and classify-state mapping', () => {
  const { runtime } = createHarness();
  assert.deepEqual(runtime.summaries.get('done'), { summary: 'finished', ts: 10 });
  assert.equal(runtime.summaries.get('aux').summary, 'aux summary');
  assert.equal(runtime.status.get('done').status, 'succeeded');
  assert.equal(runtime.status.get('working').status, 'running');
  assert.equal(runtime.status.has('plain'), false);
  assert.equal(runtime.status.has('aux'), false);
});

test('workspace connection sends snapshot and removes the final client on close', () => {
  const { runtime } = createHarness();
  const missing = new FakeSocket();
  assert.equal(runtime.attachWorkspace(missing, new URL('ws://localhost/ws/workspace?dirId=missing')), false);
  assert.deepEqual(missing.messages, [{ type: 'error', error: 'unknown directory' }]);
  assert.equal(missing.closed, true);

  const socket = new FakeSocket();
  assert.equal(runtime.attachWorkspace(socket, new URL('ws://localhost/ws/workspace?dirId=d1')), true);
  assert.equal(socket.isAlive, true);
  assert.deepEqual(socket.messages[0], {
    type: 'snapshot',
    dirId: 'd1',
    sessions: [{ id: 'session-d1' }],
    events: [{ id: 'event-d1' }],
    queues: [],
  });
  assert.equal(runtime.clients.get('d1').has(socket), true);
  socket.isAlive = false;
  socket.emit('pong');
  assert.equal(socket.isAlive, true);
  socket.close();
  assert.equal(runtime.clients.has('d1'), false);
});

test('workspace events fan out once to directory and fleet subscribers', () => {
  const { runtime } = createHarness();
  const scoped = new FakeSocket();
  const meta = new FakeSocket();
  runtime.attachWorkspace(scoped, new URL('ws://localhost/ws/workspace?dirId=d1'));
  runtime.attachMeta(meta);
  scoped.messages.length = 0;
  meta.messages.length = 0;

  runtime.broadcast('d1', { type: 'event', value: 1 });
  assert.deepEqual(scoped.messages, [{ type: 'event', value: 1 }]);
  assert.deepEqual(meta.messages, [{ type: 'event', value: 1, dirId: 'd1' }]);
  meta.close();
  assert.equal(runtime.metaClients.size, 0);
});

test('meta connection receives a fleet snapshot with directory labels', () => {
  const { runtime } = createHarness();
  const socket = new FakeSocket();
  runtime.attachMeta(socket);
  assert.deepEqual(socket.messages, [{
    type: 'meta_snapshot',
    fleet: [
      { dirId: 'd1', dirLabel: 'One', sessions: [{ id: 'session-d1' }], events: [{ id: 'event-d1' }], queues: [] },
      { dirId: 'd2', dirLabel: 'Two', sessions: [{ id: 'session-d2' }], events: [{ id: 'event-d2' }], queues: [] },
    ],
  }]);
});

test('FIFO projection is bounded, monotonic, directory-scoped, and payload-free', () => {
  const { runtime } = createHarness();
  assert.equal(runtime.hydrateQueueStatuses([
    {
      sessionId: 'done',
      depth: 2,
      state: 'frozen',
      classifyState: 'W',
      updatedAt: 50,
      text: 'must not escape',
      entryId: 'private-entry',
      taskId: 'private-task',
    },
    { sessionId: 'aux', depth: 99, updatedAt: 50 },
  ]), 1);

  const socket = new FakeSocket();
  runtime.attachWorkspace(socket, new URL('ws://localhost/ws/workspace?dirId=d1'));
  assert.deepEqual(socket.messages[0].queues, [{
    sessionId: 'done',
    depth: 2,
    state: 'frozen',
    classifyState: 'W',
    updatedAt: 50,
  }]);
  assert.doesNotMatch(JSON.stringify(socket.messages[0]), /must not escape|private-entry|private-task/);

  socket.messages.length = 0;
  runtime.setQueueStatus('done', {
    depth: 1, state: 'running', classifyState: 'P', updatedAt: 60, text: 'hidden',
  });
  assert.deepEqual(socket.messages, [{
    type: 'session_queue_status',
    sessionId: 'done',
    depth: 1,
    state: 'running',
    classifyState: 'P',
    updatedAt: 60,
  }]);
  runtime.setQueueStatus('done', {
    depth: 9, state: 'frozen', classifyState: 'W', updatedAt: 55,
  });
  assert.equal(runtime.queueStatuses.get('done').depth, 1, 'older events cannot revive stale depth');
  assert.equal(socket.messages.length, 1);
});

test('summary persistence and broadcast preserve legacy ordering and idempotence', () => {
  const { runtime, records, taskWrites, saves } = createHarness();
  const scoped = new FakeSocket();
  const meta = new FakeSocket();
  runtime.attachWorkspace(scoped, new URL('ws://localhost/ws/workspace?dirId=d2'));
  runtime.attachMeta(meta);
  scoped.messages.length = 0;
  meta.messages.length = 0;

  assert.equal(runtime.setSummary('plain', 'new summary'), true);
  assert.equal(records.get('plain').summary, 'new summary');
  assert.equal(taskWrites.length, 1);
  assert.deepEqual(taskWrites[0].options, { save: false });
  assert.deepEqual(saves, ['runtime.session-summary']);
  assert.equal(scoped.messages[0].type, 'summary');
  assert.equal(meta.messages[0].dirId, 'd2');

  runtime.setSummary('plain', 'new summary');
  assert.equal(taskWrites.length, 1, 'same summary and task snapshot do not persist twice');
  assert.equal(saves.length, 1);
  assert.equal(scoped.messages.length, 2, 'legacy clients still receive the repeated summary event');
  assert.equal(runtime.setSummary('aux', 'ignored'), false);
});

test('status transitions coalesce unchanged events and pending dispatch forces waiting', () => {
  const pending = { currentTask: { pendingDispatches: [{ id: 'x' }] } };
  const { runtime } = createHarness({ chatSessions: new Map([['plain', pending]]) });
  const scoped = new FakeSocket();
  const meta = new FakeSocket();
  runtime.attachWorkspace(scoped, new URL('ws://localhost/ws/workspace?dirId=d2'));
  runtime.attachMeta(meta);
  scoped.messages.length = 0;
  meta.messages.length = 0;

  const running = runtime.setStatus('plain', { status: 'running', currentFile: 'a.js' });
  assert.equal(running.status, 'running');
  assert.equal(running.currentFile, 'a.js');
  assert.deepEqual(scoped.messages[0].mergeState, { directory: 'd2', session: 'plain' });
  runtime.setStatus('plain', { status: 'running', currentFile: 'a.js' });
  assert.equal(scoped.messages.length, 1, 'unchanged status/currentFile does not rebroadcast');

  const completed = runtime.setStatus('plain', { status: 'completed', currentFile: null });
  assert.equal(completed.status, 'waiting');
  assert.equal(completed.runEndedAt > completed.runStartedAt, true);
  assert.equal(scoped.messages.length, 2);
  assert.equal(meta.messages[1].dirId, 'd2');
});

test('production composition delegates workspace/meta ownership to the runtime', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const wsRouter = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'ws', 'connection-router.js'),
    'utf8',
  );
  assert.match(source, /createWorkspaceRuntime\s*\(\s*\{/);
  assert.match(source, /mountWsConnectionRouter\(wss,/);
  assert.match(wsRouter, /workspaceRuntime\.attachWorkspace\(ws, urlObj\)/);
  assert.match(wsRouter, /workspaceRuntime\.attachMeta\(ws\)/);
  assert.doesNotMatch(source, /function\s+workspaceBroadcast\s*\(/);
  assert.doesNotMatch(source, /function\s+handleWorkspaceWs\s*\(/);
  assert.doesNotMatch(source, /function\s+handleMetaWs\s*\(/);
  assert.doesNotMatch(source, /_origWorkspaceBroadcast/);
});
