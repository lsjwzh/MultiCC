'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createWorkspaceRuntime } = require('../src/workspace/runtime');
const { createWsEnvelope } = require('../src/api-contract');

// The native owner writes serialized WS frames through `socket.send(data,
// options, callback)`; the frozen host wrote payload objects through the
// injected `send`/`broadcastClients` ports. Record both in the same shape so a
// differential can compare them: `frames` keeps the exact bytes, `messages`
// keeps the decoded payload with the envelope's trailing apiVersion removed.
class FakeSocket {
  constructor({ bufferedAmount = 0, failSend = null } = {}) {
    this.events = new Map();
    this.messages = [];
    this.frames = [];
    this.closed = false;
    this.closeCode = null;
    this.closeReason = null;
    this.readyState = 1;
    this.bufferedAmount = bufferedAmount;
    this.pings = 0;
    this.terminated = false;
    this.failSend = failSend;
    this.autoAck = true;
    this.pending = [];
  }

  on(name, callback) {
    let callbacks = this.events.get(name);
    if (!callbacks) {
      callbacks = [];
      this.events.set(name, callbacks);
    }
    callbacks.push(callback);
  }

  emit(name, ...args) {
    for (const callback of this.events.get(name) || []) callback(...args);
  }

  send(data, options, callback) {
    if (this.failSend) throw this.failSend;
    this.frames.push(data);
    const parsed = JSON.parse(data);
    delete parsed.apiVersion;
    this.messages.push(parsed);
    if (typeof callback !== 'function') return;
    if (this.autoAck) callback(null);
    else this.pending.push(callback);
  }

  ackAll() {
    const callbacks = this.pending.splice(0);
    for (const callback of callbacks) callback(null);
  }

  ping() { this.pings += 1; }

  terminate() { this.terminated = true; }

  close(code, reason) {
    this.closed = true;
    this.closeCode = code ?? null;
    this.closeReason = reason ?? null;
    this.emit('close', code, reason);
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
  const runtime = (overrides.factory || createWorkspaceRuntime)({
    records,
    resolveStateTarget: overrides.resolveStateTarget,
    stateSources: overrides.stateSources,
    sessionView: overrides.sessionView,
    directories,
    chatSessions,
    workspaceSnapshot: id => [{ id: `session-${id}` }],
    recentEvents: id => [{ id: `event-${id}` }],
    mergeState: overrides.mergeState || ((directory, record) => ({ directory: directory?.id, session: record.id })),
    // The frozen host handed payload objects to the transport, which then
    // serialized them; `undefined`-valued keys therefore never reached a wire.
    // Round-trip here so payload-level differentials compare wire semantics.
    send: overrides.send || ((socket, payload) => socket.messages.push(JSON.parse(JSON.stringify(payload)))),
    broadcastClients: overrides.broadcastClients || ((clients, payload) => {
      for (const socket of clients) socket.messages.push(JSON.parse(JSON.stringify(payload)));
    }),
    setTaskState: overrides.setTaskState || ((id, patch, options) => {
      taskWrites.push({ id, patch, options });
      const record = records.get(id);
      if (record) record.taskState = { ...(record.taskState || {}), ...patch };
    }),
    saveBestEffort: overrides.saveBestEffort || (source => saves.push(source)),
    clock: overrides.clock || (() => ++now),
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
  assert.deepEqual(socket.messages[0], {
    type: 'snapshot',
    dirId: 'd1',
    sessions: [{ id: 'session-d1' }],
    events: [{ id: 'event-d1' }],
    queues: [],
  });
  assert.equal(runtime.clients.get('d1').has(socket), true);
  // Liveness is owned natively: three missed 30s windows terminate, a pong
  // resets the window counter.
  runtime.tickHeartbeat();
  runtime.tickHeartbeat();
  socket.emit('pong');
  runtime.tickHeartbeat();
  runtime.tickHeartbeat();
  runtime.tickHeartbeat();
  assert.equal(socket.terminated, false, 'pong resets the missed windows');
  runtime.tickHeartbeat();
  assert.equal(socket.terminated, true);
  assert.deepEqual(runtime.socketStats(new FakeSocket()), null);
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

test('status transitions coalesce unchanged events and a pending dispatch forces background', () => {
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
  // The run ended but a dispatch is still outstanding: a background wait, not
  // 「等待回答」 — the user has nothing to answer here.
  assert.equal(completed.status, 'background');
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
  assert.match(wsRouter, /workspaceRuntime\.attachWorkspace\(ws, urlObj, heartbeat\.fields\)/);
  assert.match(wsRouter, /workspaceRuntime\.attachMeta\(ws, urlObj, heartbeat\.fields\)/);
  assert.match(wsRouter, /workspaceRuntime\.ownsSocket\?\.\(urlObj\)/);
  assert.doesNotMatch(source, /function\s+workspaceBroadcast\s*\(/);
  assert.doesNotMatch(source, /function\s+handleWorkspaceWs\s*\(/);
  assert.doesNotMatch(source, /function\s+handleMetaWs\s*\(/);
  assert.doesNotMatch(source, /_origWorkspaceBroadcast/);
});

test('Air 专用 Meta 订阅不接收旧全量快照；观察者解绑与关闭由宿主拥有', () => {
  const { runtime } = createHarness(); const air = new FakeSocket(), legacy = new FakeSocket();
  let attached, closed = 0; const seen = [];
  runtime.setAirSync({ attach: (socket, url) => { attached = [socket, url.searchParams.get('cursor')]; }, close: () => closed++ });
  const unsubscribe = runtime.subscribe((dir, event) => seen.push([dir, event.type]));
  runtime.attachMeta(air, new URL('http://local/ws/meta?air=1&cursor=epoch:1'));
  runtime.attachMeta(legacy, new URL('http://local/ws/meta'));
  assert.deepEqual(attached, [air, 'epoch:1']); assert.deepEqual(air.messages, []);
  assert.equal(legacy.messages[0].type, 'meta_snapshot');
  runtime.setSummary('plain', '索引刷新'); assert.ok(seen.some(([, type]) => type === 'summary'));
  unsubscribe(); const before = seen.length; runtime.setSummary('plain', '不再回调'); assert.equal(seen.length, before);
  runtime.close(); assert.equal(closed, 1);
});


test('workspace snapshots and events project only the current shell execution, including cursor changes', () => {
  let selected = 'child';
  const source = id => ({ executionSessionId: id === 'working' ? selected : id });
  const h = createHarness({ resolveStateTarget: source,
    stateSources: id => selected === id ? ['working'] : [],
    sessionView: id => ({ id, stateSource: source(id), classifyState: selected === 'child' ? 'W' : 'D',
      goal: selected, phase: 'implementing', status: 'waiting' }),
  });
  h.records.set('child', { id: 'child', dirId: 'd1', kind: 'chat' });
  const ws = new FakeSocket();
  h.runtime.attachWorkspace(ws, new URL('http://local/?dirId=d1'));
  ws.messages.length = 0;
  h.runtime.broadcast('d1', { type: 'task_state', sessionId: 'child', classifyState: 'W' });
  assert.equal(ws.messages.find(m => m.type === 'task_state' && m.sessionId === 'working').classifyState, 'W');
  ws.messages.length = 0;
  h.runtime.broadcast('d1', { type: 'task_state', sessionId: 'working', classifyState: 'E' });
  assert.equal(ws.messages.find(m => m.type === 'task_state' && m.sessionId === 'working').classifyState, 'W', 'late historical source event cannot overwrite the selected execution');
  selected = 'working';
  ws.messages.length = 0;
  h.runtime.publishSessionView('working');
  assert.equal(ws.messages.find(m => m.type === 'task_state').classifyState, 'D');
  ws.messages.length = 0;
  h.runtime.broadcast('d1', { type: 'task_state', sessionId: 'child', classifyState: 'P' });
  assert.equal(ws.messages.some(m => m.sessionId === 'working'), false, 'events from a deselected task stay on that task');
  assert.equal(h.taskWrites.length, 0, 'projections never mutate source business state');
});

test('switching execution clears a previous queue and reconnect supplies the same empty view', () => {
  let selected = 'child';
  const target = id => ({ executionSessionId: id === 'working' ? selected : id });
  const h = createHarness({ resolveStateTarget: target,
    stateSources: id => id === selected ? ['working'] : [],
    sessionView: id => ({ id, stateSource: target(id), status: 'idle' }),
  });
  h.records.set('child', { id: 'child', dirId: 'd1' });
  h.runtime.setQueueStatus('child', { depth: 3, state: 'queued', updatedAt: 5000 });
  const ws = new FakeSocket();
  h.runtime.attachWorkspace(ws, new URL('http://local/?dirId=d1'));
  const before = ws.messages[0].queues.find(q => q.sessionId === 'working');
  assert.equal(before.depth, 3);
  selected = 'working';
  ws.messages.length = 0;
  h.runtime.publishSessionView('working');
  const cleared = ws.messages.find(m => m.type === 'session_queue_status');
  assert.equal(cleared.depth, 0);
  assert.ok(cleared.updatedAt > before.updatedAt);
  const reconnect = new FakeSocket();
  h.runtime.attachWorkspace(reconnect, new URL('http://local/?dirId=d1'));
  const snapshot = reconnect.messages[0].queues.find(q => q.sessionId === 'working');
  assert.equal(snapshot.depth, 0);
  assert.ok(snapshot.updatedAt > cleared.updatedAt);
  h.runtime.setQueueStatus('working', { depth: 1, state: 'queued', updatedAt: 50 });
  const latest = ws.messages.filter(m => m.type === 'session_queue_status').at(-1);
  assert.equal(latest.depth, 1);
  assert.ok(latest.updatedAt > snapshot.updatedAt, 'new physical events remain accepted after projection');
});


const legacyWorkspace = require('./helpers/legacy-workspace-runtime').createWorkspaceRuntime;

test('native queue ownership matches the old runtime across updates, cursor switches and reconnects', () => {
  let selected = 'child';
  const target = id => ({ executionSessionId: id === 'working' ? selected : id });
  const make = factory => {
    const h = createHarness({ factory, resolveStateTarget: target,
      stateSources: id => id === selected ? ['working'] : [],
      sessionView: id => ({ stateSource: target(id), status: 'idle', goal: '当前任务' }),
    });
    h.records.set('child', { id: 'child', dirId: 'd1' });
    h.records.set('gateway', { id: 'gateway', dirId: 'd1', type: 'gateway' });
    h.records.set('中文\ud800', { id: '中文\ud800', dirId: 'd2' });
    h.sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
    h.runtime.attachWorkspace(h.sockets[0], new URL('http://local/?dirId=d1'));
    h.runtime.attachWorkspace(h.sockets[1], new URL('http://local/?dirId=d2'));
    h.runtime.attachMeta(h.sockets[2]);
    h.events = []; h.runtime.subscribe((dir, payload) => h.events.push([dir, payload]));
    return h;
  };
  const old = make(legacyWorkspace), next = make(createWorkspaceRuntime);
  let seed = 723;
  const draw = n => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 12) % n;
  const ids = ['working', 'child', 'plain', 'aux', 'gateway', 'missing', '中文\ud800'];
  const states = ['idle', 'starting', 'running', 'assessing', 'frozen', 'queued', 'invalid', null, 0];
  const letters = ['p', 'D', 'W', 'B', 'E', 'C', 'unknown', null];
  const observe = h => ({ messages: h.sockets.map(s => s.messages), events: h.events,
    queues: ids.map(id => h.runtime.queueStatuses.get(id)),
    writes: h.taskWrites, saves: h.saves });
  for (let i = 0; i < 1000; i++) {
    const id = ids[draw(ids.length)];
    const input = { depth: [0, -4, 3.8, '2', NaN, Infinity][draw(6)], state: states[draw(states.length)],
      classifyState: letters[draw(letters.length)], updatedAt: [0, i, 1e6, '42', Infinity][draw(5)],
      text: 'private', taskId: 'private-task' };
    const action = draw(7);
    if (action === 3) selected = selected === 'child' ? 'working' : 'child';
    function apply(h) {
      if (action < 2) return h.runtime.setQueueStatus(id, input, { broadcast: action === 0 });
      if (action === 2) return h.runtime.hydrateQueueStatuses([{ ...input, sessionId: id }, null, { sessionId: 'aux' }]);
      if (action === 3) return h.runtime.publishSessionView('working');
      if (action === 4) {
        const socket = new FakeSocket();
        h.runtime.attachWorkspace(socket, new URL('http://local/?dirId=d1')); socket.close();
        return socket.messages;
      }
      if (action === 5) return h.runtime.broadcast('d1', { type: 'session_queue_status', sessionId: id, ...input });
      h.records.get('child').dirId = i % 2 ? 'd1' : 'd2';
      return h.runtime.setQueueStatus('child', input);
    }
    const a = apply(next), b = apply(old);
    assert.deepEqual(a, b, `return at ${i}/${action}`);
    assert.equal(Object.isFrozen(a), Object.isFrozen(b), `frozen at ${i}`);
    assert.deepEqual(observe(next), observe(old), `effects at ${i}/${action}`);
    for (const h of [next, old]) { h.sockets.forEach(s => s.messages.length = 0); h.events.length = 0; }
  }
  assert.equal(next.runtime.queueStatuses.size, old.runtime.queueStatuses.size);
  console.log('workspace queue lifecycle differential: 1000 operations');
});

test('queue coercions preserve nonfinite values, UTF-16, getters and private fields', () => {
  const values = [undefined, null, false, true, 0, -0, -2.9, 2.9, NaN, Infinity, -Infinity,
    '', '2.75', '0x10', 'bad', [], [2], {}, new Date(42), 9n, Symbol('x'), '中文\ud800'];
  let comparisons = 0;
  for (const field of ['state', 'classifyState', 'depth', 'updatedAt']) {
    for (const value of values) {
      const execute = factory => {
        const h = createHarness({ factory }); const reads = [];
        const input = { state: 'queued', classifyState: 'p', depth: 2, updatedAt: 5 };
        for (const key of Object.keys(input)) {
          const data = key === field ? value : input[key];
          Object.defineProperty(input, key, { enumerable: true, get() { reads.push(key); return data; } });
        }
        Object.defineProperty(input, 'private', { enumerable: true, get() { throw Error('private field read'); } });
        input.cycle = input;
        let result, error;
        try { result = h.runtime.setQueueStatus('plain', input); } catch (e) { error = e.constructor.name; }
        return { result, error, reads, frozen: Object.isFrozen(result), queue: h.runtime.queueStatuses.get('plain') };
      };
      assert.deepEqual(execute(createWorkspaceRuntime), execute(legacyWorkspace), `${field} ${String(value)}`);
      comparisons++;
    }
  }
  for (const value of [undefined, null, 4, 'queued', false, []]) {
    const execute = factory => { const h = createHarness({ factory }); try {
      return { result: h.runtime.setQueueStatus('plain', value) };
    } catch (e) { return { error: e.constructor.name }; } };
    assert.deepEqual(execute(createWorkspaceRuntime), execute(legacyWorkspace)); comparisons++;
  }
  console.log(`workspace queue input differential: ${comparisons} cases`);
});

test('reentrant input readers cannot overwrite a newer queue and failed readers publish nothing', () => {
  function run(factory) {
    const h = createHarness({ factory }); const seen = [];
    h.runtime.subscribe((dir, data) => seen.push([dir, data]));
    const input = { state: 'queued', classifyState: 'W', depth: 1,
      get updatedAt() { h.runtime.setQueueStatus('plain', { depth: 9, state: 'running', updatedAt: 100 }); return 50; } };
    const result = h.runtime.setQueueStatus('plain', input);
    const failing = { get state() { throw new RangeError('broken reader'); } };
    assert.throws(() => h.runtime.setQueueStatus('plain', failing), RangeError);
    return { result, stored: h.runtime.queueStatuses.get('plain'), seen };
  }
  assert.deepEqual(run(createWorkspaceRuntime), run(legacyWorkspace));
});

test('queue projection retains clock evaluation order, errors and reentrant effects', () => {
  function run(factory, mode) {
    let h, now = 0, nesting = false; const reads = [];
    const clock = () => {
      reads.push('clock');
      if (h && !nesting && mode === 'reentrant') {
        nesting = true; h.runtime.broadcast('d2', { type: 'session_queue_status', sessionId: 'plain', updatedAt: 500, depth: 4 }); nesting = false;
      }
      if (h && mode === 'throw') throw new RangeError('clock failure');
      if (h && mode === 'coerce') return { valueOf() { reads.push('clock-number'); return 80; } };
      return ++now;
    };
    h = createHarness({ factory, clock, resolveStateTarget: id => ({ executionSessionId: id }) });
    const seen = []; h.runtime.subscribe((dir, event) => seen.push([dir, event]));
    const input = { type: 'session_queue_status', sessionId: 'plain',
      get state() { reads.push('state'); return 'queued'; },
      get updatedAt() { reads.push('updatedAt'); return 50; },
      get depth() { reads.push('depth'); return 2; } };
    let error;
    try { h.runtime.broadcast('d2', input); } catch (e) { error = e.constructor.name; }
    return { seen, reads, error };
  }
  for (const mode of ['normal', 'reentrant', 'throw', 'coerce']) {
    assert.deepEqual(run(createWorkspaceRuntime, mode), run(legacyWorkspace, mode), mode);
  }
});

test('queue owners are isolated and snapshots are immutable without a mirrored Node Map', () => {
  const a = createHarness(), b = createHarness();
  a.runtime.setQueueStatus('plain', { depth: 3, state: 'queued', updatedAt: 9 });
  assert.equal(b.runtime.queueStatuses.has('plain'), false);
  const snapshot = a.runtime.queueStatuses.get('plain');
  assert.ok(Object.isFrozen(snapshot));
  assert.throws(() => { snapshot.depth = 999; }, TypeError);
  assert.equal(a.runtime.queueStatuses.get('plain').depth, 3);
  assert.equal(typeof a.runtime.queueStatuses.set, 'undefined');
  const source = fs.readFileSync(path.join(__dirname, '../src/workspace/runtime.js'), 'utf8');
  assert.doesNotMatch(source, /queueStatuses = new Map|queueViewTime|function normalizeQueueStatus/);
  assert.match(source, /RustWorkspaceQueues/);
});


test('real WebSocket snapshots, status/summary events, cursor clearing and reconnect match the frozen host', { timeout: 15000 }, async t => {
  const { WebSocketServer, WebSocket } = require('ws');
  const { once } = require('node:events');
  async function exercise(factory) {
    let selected = 'child';
    const target = id => ({ executionSessionId: id === 'working' ? selected : id });
    const h = createHarness({ factory, resolveStateTarget: target,
      stateSources: id => id === selected ? ['working'] : [],
      sessionView: id => ({ stateSource: target(id), status: 'idle', goal: '当前执行' }),
      send: (ws, value) => ws.send(JSON.stringify(createWsEnvelope(value))),
      broadcastClients: (clients, value) => {
        const frame = JSON.stringify(createWsEnvelope(value));
        for (const ws of clients) ws.send(frame);
      },
    });
    h.records.set('child', { id: 'child', dirId: 'd1' });
    h.runtime.hydrateQueueStatuses([{ sessionId: 'child', depth: 2, state: 'queued', updatedAt: 5000, text: 'PRIVATE' }]);
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const sockets = [];
    t.after(async () => { for (const ws of sockets) ws.terminate(); for (const ws of server.clients) ws.terminate(); await new Promise(resolve => server.close(resolve)); });
    server.on('connection', (ws, req) => h.runtime.attachWorkspace(ws, new URL(req.url, 'http://local')));
    await once(server, 'listening');
    function connect() {
      const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/workspace?dirId=d1`);
      sockets.push(ws);
      const messages = [], raw = []; const waiters = [];
      ws.on('message', data => { raw.push(data.toString()); messages.push(JSON.parse(data)); for (const wake of waiters.splice(0)) wake(); });
      async function until(predicate) {
        const started = Date.now();
        while (!predicate(messages)) {
          if (Date.now() - started > 3000) throw Error('queue WS frame timed out');
          await new Promise(resolve => { const timer = setTimeout(resolve, 50); waiters.push(() => { clearTimeout(timer); resolve(); }); });
        }
      }
      return { ws, messages, raw, until };
    }
    const first = connect();
    await first.until(messages => messages.length === 1);
    h.runtime.setQueueStatus('child', { depth: 1, state: 'running', classifyState: 'P', updatedAt: 5001 });
    await first.until(messages => messages.some(m => m.type === 'session_queue_status' && m.sessionId === 'working' && m.depth === 1));
    selected = 'working'; h.runtime.publishSessionView('working');
    await first.until(messages => messages.some(m => m.type === 'session_queue_status' && m.sessionId === 'working' && m.depth === 0));
    const second = connect(); await second.until(messages => messages.length === 1);
    h.runtime.setSummary('done', 'wire summary 中文');
    await first.until(messages => messages.some(m => m.type === 'summary' && m.sessionId === 'done' && m.summary === 'wire summary 中文'));
    h.runtime.setStatus('done', { status: 'running', currentFile: 'wire.js' });
    await first.until(messages => messages.some(m => m.type === 'status' && m.sessionId === 'done' && m.status === 'running'));
    h.runtime.setStatus('done', { status: 'succeeded', currentFile: null });
    await second.until(messages => messages.some(m => m.type === 'status' && m.sessionId === 'done' && m.status === 'succeeded'));
    assert.doesNotMatch(JSON.stringify([first.messages, second.messages]), /PRIVATE/);
    const closing = sockets.map(ws => once(ws, 'close')); sockets.forEach(ws => ws.close());
    await Promise.all(closing);
    // Server-side close events can follow the client close event by one poll.
    for (let i = 0; h.runtime.clients.size && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(h.runtime.clients.size, 0);
    return [first.raw, second.raw];
  }
  assert.deepEqual(await exercise(createWorkspaceRuntime), await exercise(legacyWorkspace));
});


test('native status and summary ownership matches complete lifecycle and persistence effects', () => {
  const make = factory => {
    const h = createHarness({ factory });
    h.records.set('gateway', { id: 'gateway', dirId: 'd2', type: 'gateway' });
    h.records.set('中文\ud800', { id: '中文\ud800', dirId: 'd2' });
    h.events = []; h.runtime.subscribe((dir, event) => h.events.push([dir, event]));
    return h;
  };
  const a = make(createWorkspaceRuntime), b = make(legacyWorkspace);
  const ids = ['done', 'working', 'plain', 'aux', 'gateway', 'missing', '中文\ud800'];
  const statuses = ['idle', 'running', 'thinking', 'editing', 'completed', 'succeeded', 'waiting', 'background', 'error'];
  let seed = 771;
  const draw = n => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 12) % n;
  for (let i = 0; i < 1200; i++) {
    const id = ids[draw(ids.length)], kind = draw(4), status = statuses[draw(statuses.length)];
    const summary = ['', 'same', '内容\ud800😀', 'new '+i, null, false, 42, { value: i }][draw(8)];
    const currentFile = [undefined, null, 'file.js', '中文\ud800', 4, false][draw(6)];
    const pending = draw(3) === 0;
    function run(h) {
      h.chatSessions.set(id, { currentTask: { pendingDispatches: pending ? [1] : [] } });
      if (kind === 0) return h.runtime.setSummary(id, summary);
      if (kind === 1) return h.runtime.setStatus(id, { status, currentFile });
      if (kind === 2) return h.runtime.status.delete(id);
      if (h.records.has(id)) h.records.get(id).dirId = i % 2 ? 'd1' : 'd2';
      return h.runtime.setStatus(id, { status });
    }
    const resultA = run(a), resultB = run(b);
    assert.deepEqual(resultA, resultB, `return ${i}/${kind}`);
    if (resultA && typeof resultA === 'object') assert.deepEqual(Object.keys(resultA), Object.keys(resultB));
    for (const key of ids) {
      const sa = a.runtime.status.get(key), sb = b.runtime.status.get(key);
      assert.deepEqual(sa, sb, `status ${i}/${key}`);
      if (sa) assert.deepEqual(Object.keys(sa), Object.keys(sb));
      assert.deepEqual(a.runtime.summaries.get(key), b.runtime.summaries.get(key));
    }
    assert.deepEqual(a.records, b.records); assert.deepEqual(a.events, b.events);
    assert.deepEqual(a.taskWrites, b.taskWrites); assert.deepEqual(a.saves, b.saves);
    for (const h of [a,b]) { h.events.length = 0; h.taskWrites.length = 0; h.saves.length = 0; }
  }
  console.log('workspace status/summary lifecycle differential: 1200 operations');
});

test('summary and status preserve host failure commit order without lock-held callbacks', () => {
  function run(factory, mode) {
    let h; const seen = []; let nesting = false;
    const fail = name => { seen.push(name); if (name === mode) throw new RangeError(name); };
    h = createHarness({ factory,
      clock: () => { fail('clock'); return 100; },
      setTaskState: (id, patch) => { fail('task'); h.records.get(id).taskState = { ...patch }; },
      saveBestEffort: () => { fail('save'); },
      mergeState: () => { fail('merge'); if (mode === 'reentrant' && !nesting) { nesting = true; h.runtime.setStatus('plain', { status: 'editing' }); nesting = false; } return {}; },
    });
    h.runtime.subscribe((dir, event) => seen.push([dir, event])); seen.length = 0;
    if (mode === 'record') Object.defineProperty(h.records.get('plain'), 'summary', { set() { fail('record'); }, get() { return 'old'; } });
    let summaryError, statusError;
    try { h.runtime.setSummary('plain', 'new'); } catch (e) { summaryError = e.constructor.name; }
    try { h.runtime.setStatus('plain', { status: 'running', currentFile: 'file' }); } catch (e) { statusError = e.constructor.name; }
    return { seen, summaryError, statusError, summary: h.runtime.summaries.get('plain'), status: h.runtime.status.get('plain'),
      record: { summary: h.records.get('plain').summary, taskState: h.records.get('plain').taskState } };
  }
  for (const mode of ['task', 'save', 'record', 'merge', 'reentrant', 'none']) assert.deepEqual(run(createWorkspaceRuntime, mode), run(legacyWorkspace, mode), mode);
});

test('opaque summary and file values preserve identity, cycles and shallow field reads', () => {
  for (const factory of [createWorkspaceRuntime, legacyWorkspace]) {
    const h = createHarness({ factory }); const value = { toJSON() { throw Error('must not serialize internally'); } }; value.self = value;
    Object.defineProperty(value, 'private', { enumerable: true, get() { throw Error('private getter read'); } });
    assert.equal(h.runtime.setSummary('plain', value), true);
    assert.equal(h.runtime.summaries.get('plain').summary, value);
    assert.equal(h.records.get('plain').summary, value);
    h.runtime.setSummary('plain', value); assert.equal(h.saves.length, 1);
    const events = []; h.runtime.subscribe((_, event) => events.push(event));
    h.runtime.setStatus('plain', { status: 'running', currentFile: value });
    h.runtime.setStatus('plain', { status: 'running', currentFile: value });
    assert.equal(h.runtime.status.get('plain').currentFile, value); assert.equal(events.length, 1);
    for (const scalar of [Symbol('file'), 9n, () => 3]) {
      h.runtime.setStatus('plain', { status: 'running', currentFile: scalar });
      assert.equal(h.runtime.status.get('plain').currentFile, scalar);
    }
  }
});

test('hydration preserves classification fallback, unusual summaries and wire field order', () => {
  const cases = ['D','C','P','W','B','E','unknown','toString','__proto__',null,undefined,7,['P']];
  const make = factory => createHarness({ factory, records: new Map(cases.map((state, i) => [String(i), {
    id: String(i), dirId: 'd1', taskState: { classifyState: state }, summary: i % 2 ? 'text\ud800' : { i }, summaryTs: i % 3 ? 9 : 0,
  }])) });
  const a = make(createWorkspaceRuntime), b = make(legacyWorkspace);
  for (let i=0;i<cases.length;i++) {
    const id=String(i), next=a.runtime.status.get(id), old=b.runtime.status.get(id);
    assert.deepEqual(next,old); if(next) assert.deepEqual(Object.keys(next),Object.keys(old));
    assert.deepEqual(a.runtime.summaries.get(id),b.runtime.summaries.get(id));
  }
});


test('native workspace owner releases opaque values and VM cycles', { timeout: 15000 }, () => {
  const { execFileSync } = require('node:child_process');
  const source = `
    const assert = require('node:assert/strict');
    const {createWorkspaceRuntime} = require(${JSON.stringify(path.resolve(__dirname, '../src/workspace/runtime'))});
    function make() {
      return createWorkspaceRuntime({records:new Map([['s',{id:'s',dirId:'d'}]]),directories:new Map([['d',{}]]),chatSessions:new Map(),
        workspaceSnapshot:()=>[],recentEvents:()=>[],mergeState:()=>({}),send:()=>{},broadcastClients:()=>{},setTaskState:()=>{},saveBestEffort:()=>{},clock:()=>10});
    }
    function replaced(runtime) {
      const payload={toJSON(){throw Error('serialize');}};
      runtime.setSummary('s',payload); runtime.setStatus('s',{status:'running',currentFile:payload});
      const weak=new WeakRef(payload);
      runtime.setSummary('s','new'); runtime.setStatus('s',{status:'idle',currentFile:null});
      runtime.status.get('s'); return weak;
    }
    function cycle() {
      const runtime=make(), payload={runtime};
      runtime.setSummary('s',payload); runtime.setStatus('s',{status:'running',currentFile:payload});
      return new WeakRef(runtime);
    }
    async function collected(weak) {
      for(let i=0;i<40;i++){await new Promise(setImmediate);global.gc();if(!weak.deref())return true;}
      return false;
    }
    (async()=>{
      const runtime=make();const old=replaced(runtime), cyclic=cycle();
      assert.equal(await collected(old),true,'replaced payload retained');
      assert.equal(await collected(cyclic),true,'native/host cycle retained');
      assert.equal(runtime.status.get('s').status,'idle');
      console.log('workspace state GC passed');
    })().catch(e=>{console.error(e);process.exitCode=1});
  `;
  assert.match(execFileSync(process.execPath, ['--expose-gc', '-e', source], { encoding: 'utf8', timeout: 10000 }), /workspace state GC passed/);
});

test('status failures before publication preserve old state in both owners', () => {
  function exercise(factory, mode) {
    let armed = false; const chatSessions = new Map();
    const h = createHarness({ factory, chatSessions,
      clock: () => { if(armed && mode==='clock')throw Error('clock'); return 100; },
    });
    h.runtime.setStatus('plain',{status:'idle',currentFile:'old'});
    const socket=new FakeSocket();h.runtime.attachWorkspace(socket,new URL('http://local/?dirId=d2'));
    if(mode==='pending')chatSessions.set('plain',{get currentTask(){throw Error('pending');}});
    const patch={status:'running',currentFile:'new'};
    if(mode==='status')Object.defineProperty(patch,'status',{get(){throw Error('status');}});
    if(mode==='file')Object.defineProperty(patch,'currentFile',{get(){throw Error('file');}});
    armed=true;let error;
    try{h.runtime.setStatus('plain',patch);}catch(e){error=[e.constructor.name,e.message];}
    return {error,state:h.runtime.status.get('plain')};
  }
  for(const mode of ['clock','pending','status','file'])assert.deepEqual(exercise(createWorkspaceRuntime,mode),exercise(legacyWorkspace,mode),mode);
});

test('a transport send throw commits the state, disconnects the slow socket, and never escapes', () => {
  const { runtime } = createHarness();
  const socket = new FakeSocket({ failSend: Error('send exploded') });
  assert.equal(runtime.attachWorkspace(socket, new URL('http://local/?dirId=d2')), true);
  // The snapshot cannot be delivered; the owner treats it as a send error and
  // closes with the slow-client code, exactly like ws-backpressure did.
  assert.equal(socket.closeCode, 1013);
  assert.match(socket.closeReason, /slow client/);
  assert.doesNotThrow(() => runtime.setStatus('plain', { status: 'running', currentFile: 'new' }));
  assert.equal(runtime.status.get('plain').status, 'running');
});

test('hydration closes its record iterator when a field reader throws', () => {
  function exercise(factory, closeThrows) {
    const seen=[];
    const record={id:'s',dirId:'d',get summary(){throw new RangeError('summary getter');}};
    const records={get:()=>record,*[Symbol.iterator](){try{yield ['s',record];}finally{seen.push('closed');if(closeThrows)throw Error('close failure');}}};
    let error;try{createHarness({factory,records});}catch(e){error=[e.constructor.name,e.message];}
    return {seen,error};
  }
  for(const fail of [false,true])assert.deepEqual(exercise(createWorkspaceRuntime,fail),exercise(legacyWorkspace,fail));
});

test('hydration destructures iterable entries and closes them before reading the record', () => {
  function exercise(factory, mode) {
    const seen = [];
    const record = { id: 's', dirId: 'd1', summaryTs: 1, taskState: { classifyState: 'D' },
      get summary() { seen.push('summary'); return 'hello'; } };
    const pair = {
      get 0() { throw Error('numeric entry access'); },
      get 1() { throw Error('numeric entry access'); },
      *[Symbol.iterator]() {
        try {
          if (mode === 'empty') return;
          yield 's';
          if (mode === 'short') return;
          if (mode === 'next throws') throw new RangeError('pair next');
          yield record;
          throw Error('third entry must not be read');
        } finally { seen.push('pair closed'); if (mode === 'close throws') throw new RangeError('pair close'); }
      },
    };
    const records = { get: () => record,
      *[Symbol.iterator]() { try { yield pair; } finally { seen.push('records closed'); } } };
    let summary, status, error;
    try { const h = createHarness({ factory, records }); summary = h.runtime.summaries.get('s'); status = h.runtime.status.get('s'); }
    catch (e) { error = [e.constructor.name, e.message]; }
    return { seen, summary, status, error };
  }
  for (const mode of ['pair', 'empty', 'short', 'next throws', 'close throws']) {
    assert.deepEqual(exercise(createWorkspaceRuntime, mode), exercise(legacyWorkspace, mode), mode);
  }
});
