'use strict';
// Differential test: the Rust WS host (addon + native-queue patch) vs the
// frozen JavaScript oracle (tests/helpers/legacy-ws-backpressure.js, the byte
// copy of the deleted src/ws-backpressure.js) plus a line-for-line simulator
// of the deleted connection-router heartbeat loop.
//
// Comparison contract — three separate streams, each compared byte for byte:
//   transport: frames/closes/terminates/pings at the FakeSocket boundary
//   effects:   metrics, logs, schedules, cancels, heartbeat timeouts
//   callbacks: producer send-callback invocations (index -> error message)
// The streams are separate because the native architecture applies queue
// effects after the synchronous transport call, while the old wrapper ran the
// send callback before flushing the next frame. That interleaving difference
// is reviewed and accepted (the only production send callback is the machines
// bridge fail(), which is idempotent); everything INSIDE each stream must be
// identical. One further accepted difference is pinned explicitly by the
// detach test: a completion arriving after detach no longer invokes the
// producer callback (the old lexical closure still did; unreachable for the
// machines bridge because its close handling is idempotent).

const crypto = require('node:crypto');
const assert = require('node:assert');
const { installWsBackpressure } = require('./helpers/legacy-ws-backpressure');
const { installNativeQueue } = require('../src/ws/native-queue');
const { getNative } = require('../src/native/binding');

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('✅', name); }
  else {
    fail++;
    console.log('❌', name);
    if (detail) console.log(detail);
  }
}

function compareStreams(name, legacy, nativeSide) {
  for (const stream of ['transport', 'effects', 'callbacks']) {
    const left = JSON.stringify(legacy[stream]);
    const right = JSON.stringify(nativeSide[stream]);
    ok(left === right, `${name}: ${stream} stream is byte-identical`,
      left === right ? undefined
        : `  legacy: ${left.slice(0, 600)}\n  native: ${right.slice(0, 600)}`);
  }
}

function shaOf(data) {
  let bytes;
  if (typeof data === 'string') bytes = Buffer.from(data, 'utf8');
  else if (Buffer.isBuffer(data)) bytes = data;
  else if (ArrayBuffer.isView(data)) bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  else if (data instanceof ArrayBuffer) bytes = Buffer.from(data);
  else bytes = Buffer.from(String(data), 'utf8');
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

class FakeSocket {
  constructor(mode = 'manual') {
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.mode = mode; // 'manual': explicit drain ops; 'auto': synchronous completion
    this.pending = [];
    this.throwQueue = 0;
    this.closeThrows = false;
    this.closeListeners = [];
    this.wire = null;
  }
  send(data, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (this.throwQueue > 0) {
      // ws throws during validation, before the frame touches the transport.
      this.throwQueue -= 1;
      throw new Error('sync-throw');
    }
    this.wire.push({
      e: 'send',
      sha: shaOf(data),
      options: options === undefined ? null : { binary: options.binary === true },
    });
    if (this.mode === 'auto') {
      callback(null);
      return;
    }
    this.pending.push(callback);
  }
  close(code, reason) {
    this.wire.push({ e: 'close', code, reason: String(reason) });
    if (this.closeThrows) throw new Error('close-throw');
  }
  terminate() { this.wire.push({ e: 'terminate' }); }
  ping() { this.wire.push({ e: 'ping' }); }
  once(event, fn) { if (event === 'close') this.closeListeners.push(fn); }
  emitClose() { for (const fn of this.closeListeners.splice(0)) fn(1000, Buffer.from('')); }
  drain(error) {
    const callback = this.pending.shift();
    if (!callback) return false;
    callback(error || null);
    return true;
  }
}

function materialize(spec) {
  if (spec.kind === 'text') return spec.value;
  const bytes = Buffer.from(spec.value, 'utf8');
  if (spec.kind === 'buffer') return bytes;
  if (spec.kind === 'view') return new Uint8Array(bytes);
  if (spec.kind === 'arraybuffer') return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
  if (spec.kind === 'dataview') return new DataView(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  throw new Error(`unknown payload kind ${spec.kind}`);
}

function makeLegacy(mode) {
  const ws = new FakeSocket(mode);
  const side = {
    ws,
    transport: [], effects: [], callbacks: [],
    timers: [], timerSeq: 0,
    clock: 1_000,
    hb: { pendingPong: false, missedPongs: 0, timedOut: false },
  };
  ws.wire = side.transport;
  const api = installWsBackpressure(ws, {
    onMetric: (name, amount, op) => side.effects.push({ e: 'metric', name, amount, op: op === 'set' ? 'set' : 'inc' }),
    onLog: (event, fields) => side.effects.push({ e: 'log', event, ...fields }),
    now: () => side.clock,
    schedule: (fn, ms) => {
      const timer = { id: ++side.timerSeq, fn, ms };
      side.timers.push(timer);
      side.effects.push({ e: 'schedule', ms });
      return timer;
    },
    cancelSchedule: timer => {
      const index = side.timers.indexOf(timer);
      if (index !== -1) side.timers.splice(index, 1);
      side.effects.push({ e: 'cancel' });
    },
  });
  side.api = api;
  side.send = (data, options, callback) => ws.send(data, options, callback);
  side.sendImmediate = (data, options, callback) => api.sendImmediate(data, options, callback);
  side.stats = () => {
    const s = api.stats();
    return { queueBytes: s.queueBytes, queueMessages: s.queueMessages,
      sending: s.sending, congested: s.congestedAt !== 0, closed: s.closed };
  };
  side.flush = () => api.flush();
  side.fireTimer = () => {
    const timer = side.timers.shift();
    if (timer) timer.fn();
  };
  side.pong = () => {
    side.hb.pendingPong = false;
    side.hb.missedPongs = 0;
  };
  // Line-for-line the heartbeat loop that was deleted from
  // src/ws/connection-router.js when the registry moved to Rust.
  side.tick = () => {
    if (ws.readyState !== 1 || side.hb.timedOut) return;
    if (side.hb.pendingPong) side.hb.missedPongs += 1;
    if (side.hb.missedPongs >= 3) {
      side.hb.timedOut = true;
      side.effects.push({ e: 'hbTimeout', missedPongs: side.hb.missedPongs });
      ws.terminate();
      return;
    }
    side.hb.pendingPong = true;
    ws.ping();
  };
  side.detach = () => ws.emitClose();
  return side;
}

function makeNative(mode) {
  const ws = new FakeSocket(mode);
  // Same anchor pinning as the connection router: the native side holds the
  // anchor weakly, so the instance must keep it alive.
  const wsHostAnchor = {};
  const host = new (getNative().RustWsHost)(wsHostAnchor);
  Object.defineProperty(host, Symbol('ws host anchor'), { value: wsHostAnchor });
  const side = {
    ws, host,
    transport: [], effects: [], callbacks: [],
    timers: [], timerSeq: 0,
    clock: 1_000,
    connPortsById: new Map(),
  };
  ws.wire = side.transport;
  const ports = {
    ping: socket => socket.ping(),
    terminate: socket => socket.terminate(),
    close: (socket, code, reason) => socket.close(code, reason),
    schedule: (id, ms) => {
      const timer = { id: ++side.timerSeq, connId: id, ms };
      side.timers.push(timer);
      side.effects.push({ e: 'schedule', ms });
      return timer;
    },
    cancelSchedule: timer => {
      const index = side.timers.indexOf(timer);
      if (index !== -1) side.timers.splice(index, 1);
      side.effects.push({ e: 'cancel' });
    },
    metric: (name, amount, op) => side.effects.push({ e: 'metric', name, amount, op: op === 'set' ? 'set' : 'inc' }),
    backpressureLog: (socket, event, fields) => side.effects.push({ e: 'log', event, ...fields }),
    heartbeatTimeout: (fields, socket, missedPongs) => side.effects.push({ e: 'hbTimeout', missedPongs }),
    now: () => side.clock,
  };
  side.ports = ports;
  side.id = host.attach(ws, { path: '/ws/test' }, false, side.clock);
  side.api = installNativeQueue(ws, host, side.id, ports, side.connPortsById);
  side.send = (data, options, callback) => ws.send(data, options, callback);
  side.sendImmediate = (data, options, callback) => side.api.sendImmediate(data, options, callback);
  side.stats = () => side.api.stats();
  side.flush = () => side.api.flush();
  side.fireTimer = () => {
    const timer = side.timers.shift();
    if (timer) host.flushClient(timer.connId, side.connPortsById.get(timer.connId));
  };
  side.pong = () => host.onPong(side.id);
  side.tick = () => host.tick(ports);
  side.detach = () => {
    host.detach(side.id, ports);
    side.connPortsById.delete(side.id);
  };
  return side;
}

function runOps(name, ops, mode = 'manual') {
  const legacy = makeLegacy(mode);
  const nativeSide = makeNative(mode);
  const statsLog = { legacy: [], native: [] };
  let callbackSeq = 0;
  const execute = (side, op, cbIndex) => {
    switch (op.op) {
      case 'send':
      case 'sendImmediate': {
        const data = materialize(op.data);
        const fn = op.op === 'send' ? side.send : side.sendImmediate;
        const callback = op.callback
          ? err => side.callbacks.push([cbIndex, err ? String((err && err.message) || err) : null])
          : undefined;
        if (op.callbackAsOptions) fn(data, callback);
        else fn(data, op.options === undefined ? undefined : { ...op.options }, callback);
        break;
      }
      case 'drain': side.ws.drain(null); break;
      case 'drainErr': side.ws.drain(new Error(op.message)); break;
      case 'buffered': side.ws.bufferedAmount = op.bytes; break;
      case 'advance': side.clock += op.ms; break;
      case 'fireTimer': side.fireTimer(); break;
      case 'throwNext': side.ws.throwQueue += 1; break;
      case 'closeThrows': side.ws.closeThrows = op.on !== false; break;
      case 'readyState': side.ws.readyState = op.state; break;
      case 'pong': side.pong(); break;
      case 'tick': side.tick(); break;
      case 'flush': side.flush(); break;
      case 'stats':
        statsLog[side.kind].push(side.stats());
        break;
      case 'detach': side.detach(); break;
      default: throw new Error(`unknown op ${op.op}`);
    }
  };
  // Both sides need a `kind` for the stats log.
  legacy.kind = 'legacy';
  nativeSide.kind = 'native';
  for (const op of ops) {
    const cbIndex = op.callback ? ++callbackSeq : 0;
    execute(legacy, op, cbIndex);
    execute(nativeSide, op, cbIndex);
  }
  compareStreams(name, legacy, nativeSide);
  const legacyStats = JSON.stringify(statsLog.legacy);
  const nativeStats = JSON.stringify(statsLog.native);
  ok(legacyStats === nativeStats, `${name}: stats history is identical`,
    legacyStats === nativeStats ? undefined
      : `  legacy: ${legacyStats}\n  native: ${nativeStats}`);
  return { legacy, native: nativeSide };
}

// ── Directed cases ──

{
  const text = value => ({ kind: 'text', value });
  runOps('basic text sends with synchronous completion', [
    { op: 'send', data: text('{"type":"hello"}') },
    { op: 'send', data: text('plain frame'), callback: true },
    { op: 'send', data: text('options position callback'), callback: true, callbackAsOptions: true },
    { op: 'send', data: { kind: 'buffer', value: 'binary-payload' }, options: { binary: true }, callback: true },
    { op: 'send', data: { kind: 'view', value: 'view-payload' }, options: { binary: true } },
    { op: 'send', data: { kind: 'arraybuffer', value: 'ab-payload' } },
    { op: 'send', data: { kind: 'dataview', value: 'dv-payload' } },
    { op: 'stats' },
  ], 'auto');
}

{
  runOps('manual completion, errors, and mid-flight stats', [
    { op: 'send', data: { kind: 'text', value: 'a' }, callback: true },
    { op: 'send', data: { kind: 'text', value: 'b' }, callback: true },
    { op: 'stats' },
    { op: 'drain' },
    { op: 'stats' },
    { op: 'drainErr', message: 'net-fail-1' },
    { op: 'stats' },
    { op: 'send', data: { kind: 'text', value: 'after close' }, callback: true },
  ]);
}

{
  // Coalescing: a second task_state for the same session replaces the first.
  const state = (n, session = 's1') => ({ kind: 'text',
    value: JSON.stringify({ type: 'task_state', sessionId: session, n, pad: 'x'.repeat(64) }) });
  runOps('coalescing replaces the queued frame by key', [
    { op: 'send', data: state(1) },
    { op: 'send', data: state(2) },
    { op: 'send', data: state(3, 's2') }, // different key: queues separately
    { op: 'send', data: { kind: 'text', value: JSON.stringify({ type: 'chat', text: 'no key' }) } },
    { op: 'stats' },
    { op: 'drain' }, { op: 'drain' }, { op: 'drain' }, { op: 'drain' },
    { op: 'stats' },
  ]);
}

{
  // Byte-cap overflow: one frame beyond maxFrameBytes disconnects with 1013.
  runOps('oversize frame trips the byte cap with the 1013 close', [
    { op: 'send', data: { kind: 'text', value: 'y'.repeat(9 * 1024 * 1024) }, callback: true },
    { op: 'stats' },
    { op: 'send', data: { kind: 'text', value: 'closed transport' }, callback: true },
  ]);
}

{
  // The message-count tripwire is bounded-only: 4096 bounded sends fill the
  // queue to the cap, a replay-burst frame on top of that is still admitted
  // (its exemption is exactly the pre-push `queue.len() >= max` check it
  // skips), and the next bounded send overflows. The socket is held at the
  // high water mark so nothing flushes out of the queue.
  const ops = [{ op: 'buffered', bytes: 2 * 1024 * 1024 }];
  for (let i = 0; i < 4096; i += 1) {
    ops.push({ op: 'send', data: { kind: 'text', value: `frame-${i}` } });
  }
  ops.push({ op: 'sendImmediate', data: { kind: 'text', value: 'replay-tail' } }); // 4097th, exempt
  ops.push({ op: 'stats' });
  ops.push({ op: 'send', data: { kind: 'text', value: 'one-too-many' }, callback: true }); // overflow
  ops.push({ op: 'stats' });
  runOps('message-count tripwire spares the replay burst only', ops);
}

{
  // Congestion: at the high water mark the queue waits out the 15s window and
  // then disconnects a genuinely stuck client.
  runOps('congestion timer disconnects after the 15s window', [
    { op: 'buffered', bytes: 1536 * 1024 },
    { op: 'send', data: { kind: 'text', value: 'stuck-frame' }, callback: true },
    { op: 'stats' },
    { op: 'advance', ms: 5_000 },
    { op: 'fireTimer' },
    { op: 'stats' },
    { op: 'advance', ms: 11_000 }, // 16s past the congestion start
    { op: 'fireTimer' },
    { op: 'stats' },
  ]);
}

{
  // A synchronous transport throw disconnects as send_throw; when ws.close
  // also throws the wrapper terminates.
  runOps('synchronous send throw, then close failure falls back to terminate', [
    { op: 'throwNext' },
    { op: 'closeThrows', on: true },
    { op: 'send', data: { kind: 'text', value: 'boom' }, callback: true },
    { op: 'stats' },
  ]);
}

{
  // Heartbeat: pongs keep the window clean; three missed windows terminate.
  runOps('heartbeat windows, pongs, and the three-miss terminate', [
    { op: 'tick' },                       // window 1: ping
    { op: 'pong' },
    { op: 'tick' },                       // window 2: ping
    { op: 'tick' },                       // missed 1
    { op: 'tick' },                       // missed 2
    { op: 'pong' },                       // reset
    { op: 'tick' },                       // ping again
    { op: 'tick' },                       // missed 1
    { op: 'tick' },                       // missed 2
    { op: 'tick' },                       // missed 3 -> timeout + terminate
    { op: 'tick' },                       // timed out: idle
    { op: 'readyState', state: 3 },       // closing: skipped entirely
    { op: 'tick' },
  ]);
}

{
  // Detach with a frame in flight. The accepted difference is pinned by the
  // per-side assertions below: the legacy closure still invokes the producer
  // callback for the late completion; the native host has already released
  // the connection and does not. The machines bridge (only production
  // callback) is idempotent, so both reach the same wire state.
  const legacy = makeLegacy('manual');
  const nativeSide = makeNative('manual');
  const cbLog = { legacy: [], native: [] };
  const wire = { legacy: legacy.transport, native: nativeSide.transport };
  for (const [kind, side] of [['legacy', legacy], ['native', nativeSide]]) {
    side.send('in-flight', undefined, err => cbLog[kind].push(err ? String(err.message) : null));
    side.detach();
    side.ws.drain(null); // the completion the transport owed
  }
  assert.deepEqual(wire.legacy, wire.native, 'detach: transport stream matches');
  ok(true, 'detach with in-flight send: transport stream matches');
  ok(JSON.stringify(cbLog.legacy) === JSON.stringify([null])
    && JSON.stringify(cbLog.native) === JSON.stringify([]),
    'detach with in-flight send: pinned accepted callback difference',
    `  legacy: ${JSON.stringify(cbLog.legacy)}\n  native: ${JSON.stringify(cbLog.native)}`);
  // Sends after detach report the closed transport through the callback on
  // both sides.
  for (const [kind, side] of [['legacy', legacy], ['native', nativeSide]]) {
    const after = [];
    side.send('post-close', undefined, err => after.push(err ? String(err.message) : null));
    assert.deepEqual(after, ['WebSocket backpressure transport closed'],
      `${kind}: post-detach send reports the closed transport`);
  }
  ok(true, 'post-detach sends report the closed transport on both sides');
  // Stats after detach: the native surface answers with the closed tombstone,
  // the legacy surface with its emptied queue — both read as a dead, empty
  // queue to the remote-screen consumer.
  const legacyStats = legacy.stats();
  const nativeStats = nativeSide.stats();
  ok(legacyStats.queueBytes === 0 && legacyStats.closed === true
    && nativeStats.queueBytes === 0 && nativeStats.closed === true,
    'post-detach stats read as an empty closed queue on both sides');
}

// ── Randomized differential fuzzing ──

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomOps(seed, count) {
  const rand = lcg(seed);
  const pick = items => items[Math.floor(rand() * items.length)];
  const ops = [];
  const coalesceTypes = ['snapshot', 'meta_snapshot', 'task_state', 'provider_token_stats',
    'role_token_stats', 'aux_init', 'aux_history', 'session_status'];
  for (let i = 0; i < count; i += 1) {
    const roll = rand();
    if (roll < 0.34) {
      // send with a random payload shape
      const shape = rand();
      let value;
      if (shape < 0.5) {
        value = JSON.stringify({
          type: pick(coalesceTypes),
          sessionId: `s${Math.floor(rand() * 3)}`,
          payload: 'x'.repeat(Math.floor(rand() * 200)),
        });
      } else {
        value = `plain-${Math.floor(rand() * 1000)}-${'y'.repeat(Math.floor(rand() * 120))}`;
      }
      const kind = shape < 0.75 ? 'text' : shape < 0.9 ? 'buffer' : 'view';
      const op = { op: 'send', data: { kind, value }, callback: rand() < 0.5 };
      if (rand() < 0.2) op.options = { binary: rand() < 0.7 };
      else if (rand() < 0.1) op.callbackAsOptions = op.callback;
      ops.push(op);
    } else if (roll < 0.40) {
      ops.push({ op: 'sendImmediate',
        data: { kind: 'text', value: `replay-${Math.floor(rand() * 100)}` }, callback: rand() < 0.4 });
    } else if (roll < 0.55) {
      ops.push({ op: 'drain' });
    } else if (roll < 0.60) {
      ops.push({ op: 'drainErr', message: `net-fail-${Math.floor(rand() * 5)}` });
    } else if (roll < 0.70) {
      ops.push({ op: 'buffered',
        bytes: pick([0, 256 * 1024, 1024 * 1024 - 1, 1024 * 1024, 1536 * 1024, 3 * 1024 * 1024]) });
    } else if (roll < 0.78) {
      ops.push({ op: 'advance', ms: pick([10, 25, 100, 1_000, 8_000, 16_000]) });
    } else if (roll < 0.83) {
      ops.push({ op: 'fireTimer' });
    } else if (roll < 0.86) {
      ops.push({ op: 'throwNext' });
    } else if (roll < 0.88) {
      ops.push({ op: 'closeThrows', on: rand() < 0.5 });
    } else if (roll < 0.93) {
      ops.push({ op: 'pong' });
    } else if (roll < 0.97) {
      ops.push({ op: 'tick' });
    } else {
      ops.push({ op: 'stats' });
    }
  }
  return ops;
}

let fuzzFailures = 0;
for (let seed = 1; seed <= 40; seed += 1) {
  const ops = randomOps(seed, 200);
  const legacy = makeLegacy('manual');
  const nativeSide = makeNative('manual');
  legacy.kind = 'legacy';
  nativeSide.kind = 'native';
  let callbackSeq = 0;
  const execute = (side, op, cbIndex) => {
    switch (op.op) {
      case 'send':
      case 'sendImmediate': {
        const data = materialize(op.data);
        const fn = op.op === 'send' ? side.send : side.sendImmediate;
        const callback = op.callback
          ? err => side.callbacks.push([cbIndex, err ? String((err && err.message) || err) : null])
          : undefined;
        if (op.callbackAsOptions) fn(data, callback);
        else fn(data, op.options === undefined ? undefined : { ...op.options }, callback);
        break;
      }
      case 'drain': side.ws.drain(null); break;
      case 'drainErr': side.ws.drain(new Error(op.message)); break;
      case 'buffered': side.ws.bufferedAmount = op.bytes; break;
      case 'advance': side.clock += op.ms; break;
      case 'fireTimer': side.fireTimer(); break;
      case 'throwNext': side.ws.throwQueue += 1; break;
      case 'closeThrows': side.ws.closeThrows = op.on !== false; break;
      case 'pong': side.pong(); break;
      case 'tick': side.tick(); break;
      case 'stats': side.lastStats = side.stats(); break;
      default: throw new Error(`unknown op ${op.op}`);
    }
  };
  try {
    for (const op of ops) {
      const cbIndex = op.callback ? ++callbackSeq : 0;
      execute(legacy, op, cbIndex);
      execute(nativeSide, op, cbIndex);
    }
    for (const stream of ['transport', 'effects', 'callbacks']) {
      assert.deepEqual(nativeSide[stream], legacy[stream], `seed ${seed} ${stream}`);
    }
    assert.deepEqual(nativeSide.stats(), legacy.stats(), `seed ${seed} final stats`);
  } catch (error) {
    fuzzFailures += 1;
    console.log(`❌ seed ${seed}: ${error.message}`);
    console.log('  legacy transport tail:', JSON.stringify(legacy.transport.slice(-4)));
    console.log('  native transport tail:', JSON.stringify(nativeSide.transport.slice(-4)));
    console.log('  legacy effects tail:', JSON.stringify(legacy.effects.slice(-4)));
    console.log('  native effects tail:', JSON.stringify(nativeSide.effects.slice(-4)));
    console.log('  legacy callbacks tail:', JSON.stringify(legacy.callbacks.slice(-4)));
    console.log('  native callbacks tail:', JSON.stringify(nativeSide.callbacks.slice(-4)));
  }
}
ok(fuzzFailures === 0, 'randomized differential: 40 seeds x 200 ops all byte-identical');

console.log(`\n== ws-host differential: ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
