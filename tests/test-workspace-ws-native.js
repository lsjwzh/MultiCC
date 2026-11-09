'use strict';

// Native /ws/workspace + /ws/meta subscription owner: raw-frame differentials
// against the frozen host, the old heartbeat/backpressure policies, the event
// ring and long randomized connection/event sequences.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createWorkspaceRuntime, prepareFrame } = require('../src/workspace/runtime');
const { createWsEnvelope } = require('../src/api-contract');
const { installWsBackpressure, DEFAULTS } = require('../src/ws-backpressure');
const legacyWorkspace = require('./helpers/legacy-workspace-runtime').createWorkspaceRuntime;
const { createNotesStore } = require('../src/notes-store');

class Socket {
  constructor({ bufferedAmount = 0, failSend = null, correlationId = null } = {}) {
    this.events = new Map();
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
    this._correlationId = correlationId;
  }

  on(name, callback) {
    const callbacks = this.events.get(name) || [];
    callbacks.push(callback);
    this.events.set(name, callbacks);
  }

  emit(name, ...args) {
    for (const callback of this.events.get(name) || []) callback(...args);
  }

  pushFrame(frame) { this.frames.push(frame); }

  send(data, options, callback) {
    if (this.failSend) throw this.failSend;
    this.pushFrame(data);
    if (typeof callback !== 'function') return;
    if (this.autoAck) callback(null);
    else this.pending.push(callback);
  }

  ack(error = null) {
    const callbacks = this.pending.splice(0);
    for (const callback of callbacks) callback(error);
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

function fields(connectionId, pathname, directoryId = null) {
  return { connectionId, path: pathname, sessionId: null, directoryId };
}

function makeRig(factory, overrides = {}) {
  let now = 1000;
  const clock = overrides.clock || (() => ++now);
  const records = new Map([
    ['done', { id: 'done', dirId: 'd1', summary: 'finished', summaryTs: 10, taskState: { classifyState: 'D' } }],
    ['working', { id: 'working', dirId: 'd1', taskState: { classifyState: 'P' } }],
    ['plain', { id: 'plain', dirId: 'd2', taskState: {} }],
    ['aux', { id: 'aux', dirId: 'd1', type: 'aux', summary: 'aux summary', taskState: { classifyState: 'D' } }],
    ['child', { id: 'child', dirId: 'd1' }],
  ]);
  for (const [id, record] of overrides.records || []) records.set(id, record);
  const directories = new Map([
    ['d1', { id: 'd1', label: 'One' }],
    ['d2', { id: 'd2', label: 'Two' }],
  ]);
  const chatSessions = new Map(overrides.chatSessions || []);
  const metrics = [];
  const logs = [];
  const runtime = factory({
    records,
    directories,
    chatSessions,
    workspaceSnapshot: id => [{ id: `session-${id}` }],
    recentEvents: id => [{ id: `event-${id}` }],
    mergeState: (directory, record) => ({ directory: directory?.id, session: record.id }),
    // Frozen-host transport ports; the native owner ignores these and writes
    // the identical bytes through `socket.send`.
    send: (socket, payload) => socket.pushFrame(JSON.stringify(createWsEnvelope(payload))),
    broadcastClients: (clients, payload) => {
      const frame = JSON.stringify(createWsEnvelope(payload));
      for (const socket of clients) socket.pushFrame(frame);
    },
    setTaskState: (id, patch) => {
      const record = records.get(id);
      if (record) record.taskState = { ...(record.taskState || {}), ...patch };
    },
    saveBestEffort: () => {},
    clock,
    metrics: { inc: (name, value = 1) => metrics.push([name, value, 'inc']),
      set: (name, value) => metrics.push([name, value, 'set']) },
    logger: { warn: (event, detail) => logs.push([event, detail]) },
    resolveStateTarget: overrides.resolveStateTarget,
    stateSources: overrides.stateSources,
    sessionView: overrides.sessionView,
  });
  return { runtime, records, directories, chatSessions, metrics, logs, clock };
}

test('raw workspace/meta frames are byte-identical across connect, events, close and reconnect', () => {
  const run = factory => {
    const rig = makeRig(factory);
    const first = new Socket();
    rig.runtime.attachWorkspace(first, new URL('ws://x/ws/workspace?dirId=d1'),
      fields('c1', '/ws/workspace', 'd1'));
    const meta = new Socket();
    rig.runtime.attachMeta(meta, new URL('ws://x/ws/meta'), fields('c2', '/ws/meta'));
    rig.runtime.broadcast('d1', { type: 'event', event: { ts: 1, type: 'x' }, z: 1, a: 2 });
    rig.runtime.setSummary('done', 'wire 中文');
    rig.runtime.setStatus('plain', { status: 'running', currentFile: 'a.js' });
    const second = new Socket();
    rig.runtime.attachWorkspace(second, new URL('ws://x/ws/workspace?dirId=d1'));
    first.close();
    rig.runtime.broadcast('d1', { type: 'status', sessionId: 'done', status: 'succeeded' });
    const other = new Socket();
    rig.runtime.attachWorkspace(other, new URL('ws://x/ws/workspace?dirId=d2'));
    const missing = new Socket();
    rig.runtime.attachWorkspace(missing, new URL('ws://x/ws/workspace?dirId=gone'));
    const meta2 = new Socket();
    rig.runtime.attachMeta(meta2, new URL('ws://x/ws/meta?air=0'));
    return [first, meta, second, other, missing, meta2]
      .map(socket => ({ frames: socket.frames, closed: socket.closed }));
  };
  assert.deepEqual(run(createWorkspaceRuntime), run(legacyWorkspace));
});

test('observers see the same payload stream, including unsubscribe and throwing listeners', () => {
  const run = factory => {
    const rig = makeRig(factory);
    const wire = [];
    const wireOf = payload => JSON.stringify(createWsEnvelope(payload));
    const first = rig.runtime.subscribe((dirId, payload) => wire.push(['a', dirId, wireOf(payload)]));
    let secondCalls = 0;
    const second = rig.runtime.subscribe(() => { secondCalls += 1; });
    rig.runtime.subscribe(() => { throw new Error('observer failure'); });
    rig.runtime.broadcast('d1', { type: 'event', v: 1 });
    first();
    rig.runtime.broadcast('d1', { type: 'event', v: 2 });
    second();
    second();
    rig.runtime.broadcast('d2', { type: 'summary', sessionId: 's', summary: 'x', ts: 2 });
    return { wire, secondCalls };
  };
  assert.deepEqual(run(createWorkspaceRuntime), run(legacyWorkspace));
});

test('directory removal mid-connection keeps the client, reconnect fails closed identically', () => {
  const run = factory => {
    const rig = makeRig(factory);
    const socket = new Socket();
    rig.runtime.attachWorkspace(socket, new URL('ws://x/ws/workspace?dirId=d1'));
    rig.directories.delete('d1');
    socket.frames.length = 0;
    rig.runtime.broadcast('d1', { type: 'event', after: 'delete' });
    rig.runtime.broadcast('d2', { type: 'event', elsewhere: true });
    const reconnect = new Socket();
    const attached = rig.runtime.attachWorkspace(reconnect, new URL('ws://x/ws/workspace?dirId=d1'));
    return { frames: socket.frames, attached, reconnect: reconnect.frames, closed: reconnect.closed };
  };
  assert.deepEqual(run(createWorkspaceRuntime), run(legacyWorkspace));
});

// ---------------------------------------------------------------------------
// Randomized connection/event sequence. Every action is applied to both owners;
// raw frames, observer frames and the read-only views must match after every
// single step.

test('1200-step randomized connection and event sequence matches the frozen host byte for byte', () => {
  const dirs = ['d1', 'd2', 'gone'];
  const types = ['event', 'task_state', 'status', 'summary', 'session_queue_status'];
  const build = seed => {
    let state = seed >>> 0;
    return n => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) >>> 12) % n;
  };
  const payload = (draw, step) => {
    const type = types[draw(types.length)];
    if (type === 'event') {
      return { type, event: { ts: step, type: 'random', detail: step % 3 ? null : '中文' } };
    }
    return { type, sessionId: ['done', 'working', 'plain', 'aux', 'child', 'missing'][draw(6)],
      status: ['idle', 'running', 'completed'][draw(3)],
      classifyState: ['P', 'W', 'D', null][draw(4)], depth: draw(5), updatedAt: step,
      summary: step % 2 ? `summary-${step}` : null, ts: step, value: { step, unicode: '中文\ud800' } };
  };
  const play = factory => {
    const rig = makeRig(factory);
    const draw = build(0x5eed1234);
    const clients = [];
    const observerWire = [];
    const views = [];
    let unsubscribe = () => {};
    for (let step = 0; step < 1200; step += 1) {
      const action = draw(10);
      if (action <= 2) {
        const socket = new Socket();
        const dir = dirs[draw(dirs.length)];
        rig.runtime.attachWorkspace(socket, new URL(`ws://x/ws/workspace?dirId=${dir}`),
          fields(`c${step}`, '/ws/workspace', dir));
        clients.push(socket);
      } else if (action === 3) {
        const socket = new Socket();
        rig.runtime.attachMeta(socket, new URL('ws://x/ws/meta'), fields(`m${step}`, '/ws/meta'));
        clients.push(socket);
      } else if (action === 4 && clients.length > 0) {
        const [socket] = clients.splice(draw(clients.length), 1);
        socket.close(draw(2) ? 1000 : 1006, 'client');
      } else if (action === 5) {
        rig.runtime.broadcast(dirs[draw(2)], payload(draw, step));
      } else if (action === 6) {
        rig.runtime.setSummary(['done', 'working', 'plain', 'aux'][draw(4)], `s-${step}`);
      } else if (action === 7) {
        rig.runtime.setStatus(['done', 'plain', 'child'][draw(3)],
          { status: ['idle', 'running', 'completed'][draw(3)], currentFile: draw(2) ? 'a.js' : null });
      } else if (action === 8) {
        unsubscribe();
        unsubscribe = rig.runtime.subscribe((dirId, event) => {
          observerWire.push([dirId, JSON.stringify(createWsEnvelope(event))]);
        });
      } else {
        unsubscribe();
        unsubscribe = () => {};
      }
      if (clients.length > 12) clients.splice(0, 1)[0].close(1000, 'trim');
      views.push([rig.runtime.clients.size, rig.runtime.metaClients.size,
        rig.runtime.clients.has('d1'), rig.runtime.clients.has('d2')]);
    }
    return {
      clients: clients.map(socket => ({ frames: socket.frames, closed: socket.closed, code: socket.closeCode })),
      observerWire,
      views,
    };
  };
  const native = play(createWorkspaceRuntime);
  const legacy = play(legacyWorkspace);
  assert.deepEqual(native, legacy);
  console.log(`workspace socket randomized differential: 1200 steps, ${native.clients.length} live clients`);
});

// ---------------------------------------------------------------------------
// Heartbeat: native windows vs the frozen router loop.

// The exact loop that lived in the shared router before the native owner.
function legacyHeartbeat(attachmentFields, correlationId, logger) {
  let pendingPong = false;
  let missedPongs = 0;
  let timedOut = false;
  const state = { pings: 0, terminated: false, readyState: 1 };
  return {
    state,
    tick() {
      if (state.readyState !== 1 || timedOut) return;
      if (pendingPong) missedPongs += 1;
      if (missedPongs >= 3) {
        timedOut = true;
        logger.warn('ws_pong_timeout', { ...attachmentFields, correlationId, missedPongs });
        state.terminated = true;
        return;
      }
      pendingPong = true;
      state.pings += 1;
    },
    pong() { pendingPong = false; missedPongs = 0; },
  };
}

test('native heartbeat windows match the frozen router loop, including pong resets and closed sockets', () => {
  const rig = makeRig(createWorkspaceRuntime);
  const legacyLogs = [];
  const legacyLogger = { warn: (event, detail) => legacyLogs.push([event, detail]) };
  const engines = [];
  const sockets = [];
  for (let i = 0; i < 3; i += 1) {
    const socket = new Socket({ correlationId: `corr-${i}` });
    const attachmentFields = fields(`window-${i}`, '/ws/workspace', 'd1');
    rig.runtime.attachWorkspace(socket, new URL('ws://x/ws/workspace?dirId=d1'), attachmentFields);
    sockets.push(socket);
    engines.push(legacyHeartbeat(attachmentFields, `corr-${i}`, legacyLogger));
  }
  const script = [
    [false, false, true],
    [false, true, true],
    [true, false, true],
    [false, false, true],
    [false, false, false],
    [false, false, false],
    [false, false, false],
    [true, true, true],
  ];
  for (const [pong0, pong1, pong2] of script) {
    if (pong0) { sockets[0].emit('pong'); engines[0].pong(); }
    if (pong1) { sockets[1].emit('pong'); engines[1].pong(); }
    if (pong2) { sockets[2].emit('pong'); engines[2].pong(); }
    rig.runtime.tickHeartbeat();
    for (const engine of engines) engine.tick();
    assert.deepEqual(sockets.map(socket => [socket.pings, socket.terminated]),
      engines.map(engine => [engine.state.pings, engine.state.terminated]),
      'heartbeat decisions diverge');
  }
  assert.deepEqual(rig.logs, legacyLogs);

  // A closing socket is skipped by the native owner, exactly like the old loop.
  const closing = new Socket();
  rig.runtime.attachWorkspace(closing, new URL('ws://x/ws/workspace?dirId=d1'), fields('closed', '/ws/workspace'));
  closing.readyState = 3;
  for (let i = 0; i < 5; i += 1) rig.runtime.tickHeartbeat();
  assert.equal(closing.pings, 0);
  assert.equal(closing.terminated, false);
});

// ---------------------------------------------------------------------------
// Backpressure: the native queue vs the frozen `src/ws-backpressure.js` policy.

class NativeQueue {
  constructor() {
    this.now = 1000;
    this.rig = makeRig(createWorkspaceRuntime, { clock: () => this.now });
    this.socket = new Socket({ correlationId: 'queue' });
    this.rig.runtime.attachWorkspace(this.socket, new URL('ws://x/ws/workspace?dirId=d1'),
      fields('queue', '/ws/workspace', 'd1'));
    // Complete the snapshot send so later frames see an idle transport, then
    // hold every completion callback until the test releases it.
    this.socket.ack();
    this.socket.autoAck = false;
    this.socket.frames.length = 0;
    this.rig.metrics.length = 0;
    this.rig.logs.length = 0;
  }

  send(payload) { this.rig.runtime.broadcast('d1', payload); }

  setBuffered(bytes) { this.socket.bufferedAmount = bytes; }

  ack(error = null) { this.socket.ack(error); }

  async runTimers() { await new Promise(resolve => setTimeout(resolve, 60)); }

  snapshot() {
    return {
      sent: this.socket.frames.slice(),
      metrics: this.rig.metrics.map(entry => entry.slice()),
      logs: this.rig.logs.map(entry => entry.slice()),
      close: [this.socket.closeCode, this.socket.closeReason],
    };
  }
}

class FrozenQueue {
  constructor() {
    this.now = 1000;
    this.sent = [];
    this.pending = [];
    this.metrics = [];
    this.logs = [];
    this.timers = [];
    this.closeCode = null;
    this.closeReason = null;
    this.socket = {
      bufferedAmount: 0,
      _correlationId: 'queue',
      on() {},
      once() {},
      send: (data, options, callback) => {
        this.sent.push(data);
        if (typeof callback === 'function') this.pending.push(callback);
      },
      close: (code, reason) => {
        this.closeCode = code;
        this.closeReason = reason;
      },
    };
    installWsBackpressure(this.socket, {
      now: () => this.now,
      schedule: callback => {
        this.timers.push(callback);
        return { unref() {} };
      },
      cancelSchedule: timer => {
        const index = this.timers.indexOf(timer);
        if (index !== -1) this.timers.splice(index, 1);
      },
      onMetric: (name, value, op) => this.metrics.push([name, value, op || 'inc']),
      // The shared router wrapped the frozen policy's log callback with the
      // connection's correlation id; mirror that here.
      onLog: (event, detail) => this.logs.push([event, { ...detail, correlationId: 'queue' }]),
    });
  }

  send(payload) { this.socket.send(prepareFrame(payload).data); }

  setBuffered(bytes) { this.socket.bufferedAmount = bytes; }

  ack(error = null) {
    const callbacks = this.pending.splice(0);
    for (const callback of callbacks) callback(error);
  }

  runTimers() {
    const callbacks = this.timers.splice(0);
    for (const callback of callbacks) callback();
  }

  snapshot() {
    return {
      sent: this.sent.slice(),
      metrics: this.metrics.map(entry => entry.slice()),
      logs: this.logs.map(entry => entry.slice()),
      close: [this.closeCode, this.closeReason],
    };
  }
}

test('native send queue coalesces, flushes and reports the same metrics as the frozen policy', async () => {
  const native = new NativeQueue();
  const frozen = new FrozenQueue();
  native.setBuffered(DEFAULTS.highWaterBytes);
  frozen.setBuffered(DEFAULTS.highWaterBytes);
  const first = { type: 'task_state', sessionId: 's', value: 'first' };
  const second = { type: 'task_state', sessionId: 's', value: 'second' };
  native.send(first);
  frozen.send(first);
  native.send(second);
  frozen.send(second);
  native.setBuffered(0);
  frozen.setBuffered(0);
  await native.runTimers();
  frozen.runTimers();
  native.ack();
  frozen.ack();
  assert.deepEqual(native.snapshot(), frozen.snapshot());
  assert.deepEqual(native.snapshot().sent, [prepareFrame(second).data]);
});

test('native queue byte ceiling and overflow close match the frozen policy', async () => {
  const native = new NativeQueue();
  const frozen = new FrozenQueue();
  native.setBuffered(DEFAULTS.highWaterBytes);
  frozen.setBuffered(DEFAULTS.highWaterBytes);
  const blob = 'x'.repeat(4 * 1024 * 1024);
  for (let i = 0; i < 3; i += 1) {
    const payload = { type: 'event', sessionId: `s${i}`, blob, i };
    native.send(payload);
    frozen.send(payload);
  }
  await native.runTimers();
  frozen.runTimers();
  assert.deepEqual(native.snapshot(), frozen.snapshot());
  assert.equal(native.snapshot().close[0], 1013);
  assert.deepEqual(native.snapshot().sent, []);
});

test('native queue message-count tripwire matches the frozen policy', async () => {
  const native = new NativeQueue();
  const frozen = new FrozenQueue();
  native.setBuffered(DEFAULTS.highWaterBytes);
  frozen.setBuffered(DEFAULTS.highWaterBytes);
  for (let i = 0; i <= DEFAULTS.maxQueueMessages; i += 1) {
    const payload = { type: 'event', sessionId: `s${i}`, i };
    native.send(payload);
    frozen.send(payload);
  }
  await native.runTimers();
  frozen.runTimers();
  assert.deepEqual(native.snapshot(), frozen.snapshot());
  assert.equal(native.snapshot().close[0], 1013);
});

test('native congestion timeout and send errors disconnect exactly like the frozen policy', async () => {
  const congestionNative = new NativeQueue();
  const congestionFrozen = new FrozenQueue();
  congestionNative.setBuffered(DEFAULTS.highWaterBytes);
  congestionFrozen.setBuffered(DEFAULTS.highWaterBytes);
  congestionNative.send({ type: 'event', slow: true });
  congestionFrozen.send({ type: 'event', slow: true });
  congestionNative.now += DEFAULTS.maxCongestionMs;
  congestionFrozen.now += DEFAULTS.maxCongestionMs;
  await congestionNative.runTimers();
  congestionFrozen.runTimers();
  assert.deepEqual(congestionNative.snapshot(), congestionFrozen.snapshot());
  assert.equal(congestionNative.snapshot().logs[0][1].reason, 'high_water_timeout');

  const errorNative = new NativeQueue();
  const errorFrozen = new FrozenQueue();
  errorNative.send({ type: 'event', boom: true });
  errorFrozen.send({ type: 'event', boom: true });
  errorNative.ack(new Error('boom'));
  errorFrozen.ack(new Error('boom'));
  assert.deepEqual(errorNative.snapshot(), errorFrozen.snapshot());
  assert.equal(errorNative.snapshot().logs[0][1].reason, 'send_error');
});

// ---------------------------------------------------------------------------
// Event ring moved into the native owner; notes-store keeps only the JSONL
// adapter and the broadcast.

test('native event ring hydrates the last 200 lines, appends, caps and fans out', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-ws-events-'));
  try {
    const eventsDir = path.join(root, 'events');
    fs.mkdirSync(eventsDir);
    const disk = [];
    for (let i = 0; i < 250; i += 1) disk.push(JSON.stringify({ ts: i, type: 'old', i }));
    fs.writeFileSync(path.join(eventsDir, 'd1.jsonl'), `${disk.join('\n')}\n`);
    const rig = makeRig(createWorkspaceRuntime);
    const store = createNotesStore({
      eventsDir,
      notesFile: path.join(root, 'notes.json'),
      persistedSessions: rig.records,
      directories: rig.directories,
      atomicWriteJson: (file, value) => fs.writeFileSync(file, JSON.stringify(value)),
      ensurePrivateDir: dir => fs.mkdirSync(dir, { recursive: true }),
      getWorkspaceBroadcast: () => (dirId, payload) => rig.runtime.broadcast(dirId, payload),
      getWorkspaceEvents: () => rig.runtime.events,
    });
    const socket = new Socket();
    rig.runtime.attachWorkspace(socket, new URL('ws://x/ws/workspace?dirId=d1'));
    socket.frames.length = 0;

    assert.equal(rig.runtime.events.has('d1'), false);
    const hydrated = store.recentEvents('d1');
    assert.equal(hydrated.length, 200);
    assert.equal(hydrated[0].i, 50);
    assert.equal(hydrated.at(-1).i, 249);
    assert.equal(rig.runtime.events.has('d1'), true);

    store.appendEvent('d1', 'live', 'detail', 'done');
    const after = store.recentEvents('d1');
    assert.equal(after.length, 200);
    assert.equal(after.at(-1).type, 'live');
    const frame = JSON.parse(socket.frames[0]);
    assert.equal(frame.type, 'event');
    assert.equal(frame.event.type, 'live');
    assert.equal(frame.event.sessionId, 'done');

    for (let i = 0; i < 300; i += 1) store.appendEvent('d1', 'bulk', null, null);
    assert.equal(store.recentEvents('d1').length, 200);
    assert.equal(store.recentEvents('d1').at(-1).type, 'bulk');
    assert.equal(store.recentEvents('d2').length, 0, 'directories keep isolated rings');
    const persisted = fs.readFileSync(path.join(eventsDir, 'd1.jsonl'), 'utf8').trim().split('\n');
    assert.equal(persisted.length, 250 + 1 + 300);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
