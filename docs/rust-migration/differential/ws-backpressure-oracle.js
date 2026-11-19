'use strict';

// Freeze the observable decisions of the live WebSocket send wrapper
// (src/ws-backpressure.js, byte-copied to tests/helpers/legacy-ws-backpressure.js)
// so native/core/src/ws_backpressure.rs can be compared against them.
//
//   node docs/rust-migration/differential/ws-backpressure-oracle.js > \
//     docs/rust-migration/differential/ws-backpressure-golden.json
//
// Every frame is identified by the SHA-256 of its exact bytes, so an 8 MiB
// case costs one hash in the corpus instead of eight megabytes of JSON. The
// clock, the retry timer and `bufferedAmount` are all driven by the op list:
// nothing here depends on wall time.
const { createHash } = require('node:crypto');

const { installWsBackpressure, DEFAULTS } = require('../../../tests/helpers/legacy-ws-backpressure');

/** Build the exact bytes a payload spec stands for. */
function materialize(spec) {
  if (spec.kind === 'text') {
    return spec.fill !== undefined ? spec.fill.repeat(spec.length) : spec.value;
  }
  const source = spec.fill !== undefined
    ? Buffer.from(spec.fill.repeat(spec.length))
    : Buffer.from(spec.value);
  return spec.kind === 'view' ? new Uint8Array(source) : source;
}

function digest(data) {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8')
    : Buffer.isBuffer(data) ? data
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

const text = value => ({ kind: 'text', value });
const json = value => ({ kind: 'text', value: JSON.stringify(value) });
const filled = (length, fill = 'x') => ({ kind: 'text', fill, length });
const buffer = (length, fill = 'b') => ({ kind: 'buffer', fill, length });

const send = (data, extra = {}) => ({ op: 'send', data, bounded: true, callback: true, ...extra });
// The machine bridge and the task-shell host both send with `{ binary }`, and
// `ws.send(data, callback)` is the two-argument form the wrapper re-splits.
const binarySend = data => ({ op: 'send', data, bounded: true, callback: true, options: { binary: true } });
const callbackAsOptions = data => ({ op: 'send', data, bounded: true, callback: true, callbackAsOptions: true });
const immediate = data => ({ op: 'send', data, bounded: false, callback: true });
const complete = (error = null) => ({ op: 'complete', error });
const buffered = bytes => ({ op: 'buffered', bytes });
const advance = ms => ({ op: 'advance', ms });
const timer = () => ({ op: 'timer' });
const stats = () => ({ op: 'stats' });
const closeThrows = () => ({ op: 'closeThrows' });

const SNAPSHOT = { type: 'snapshot', dirId: 'd1', value: 1 };
const CASES = [
  {
    name: 'one frame flushes, drains and reports depth',
    ops: [send(text('hello')), stats(), complete(), stats()],
  },
  {
    name: 'a second frame waits for the in-flight callback',
    ops: [send(text('one')), send(text('two')), stats(), complete(), complete(), stats()],
  },
  {
    name: 'coalescing replaces a queued snapshot in place',
    ops: [
      send(text('lead')),
      send(json(SNAPSHOT)),
      send(json({ type: 'snapshot', dirId: 'd1', value: 2 })),
      send(json({ type: 'snapshot', dirId: 'd2', value: 3 })),
      stats(),
      complete(), complete(), complete(),
    ],
  },
  {
    name: 'coalescing keys fall back through sessionId, role and empty',
    ops: [
      send(text('lead')),
      send(json({ type: 'task_state', sessionId: 's1' })),
      send(json({ type: 'role_token_stats', role: 'main' })),
      send(json({ type: 'aux_init' })),
      send(json({ type: 'task_state', sessionId: 's1', again: true })),
      send(json({ type: 'aux_init', again: true })),
      stats(),
    ],
  },
  {
    name: 'non-coalescing payloads keep their own slots',
    ops: [
      send(text('lead')),
      send(json({ type: 'chat_delta', dirId: 'd1' })),
      send(text('{not json')),
      send(json({ dirId: 'd1' })),
      send(buffer(8, 'q')),
      send({ kind: 'view', fill: 'v', length: 8 }),
      stats(),
    ],
  },
  {
    name: 'a numeric coalescing field stringifies like the template literal',
    ops: [
      send(text('lead')),
      send(json({ type: 'snapshot', dirId: 7 })),
      send(json({ type: 'snapshot', dirId: 7, newer: true })),
      send(json({ type: 'snapshot', dirId: '7' })),
      stats(),
    ],
  },
  {
    name: 'a single frame over maxFrameBytes disconnects with 1013',
    ops: [send(text('lead')), send(filled(DEFAULTS.maxFrameBytes + 1)), stats(), send(text('after'))],
  },
  {
    name: 'accumulated bytes over the ceiling disconnect',
    ops: [
      send(text('lead')),
      send(filled(DEFAULTS.maxFrameBytes)),
      send(filled(DEFAULTS.maxQueueBytes)),
      send(text('tip')),
      stats(),
    ],
  },
  {
    name: 'the message count cap applies to live sends only',
    limits: { maxQueueMessages: 3 },
    ops: [send(text('lead')), send(text('a')), send(text('b')), send(text('c')), stats()],
  },
  {
    name: 'sendImmediate skips the count cap but not the byte cap',
    limits: { maxQueueMessages: 2 },
    ops: [
      send(text('lead')),
      immediate(text('a')), immediate(text('b')), immediate(text('c')),
      stats(),
      immediate(filled(DEFAULTS.maxFrameBytes + 1)),
      stats(),
    ],
  },
  {
    name: 'high water retries then disconnects on the congestion timeout',
    ops: [
      send(text('lead')), complete(),
      buffered(DEFAULTS.highWaterBytes),
      send(text('queued')),
      timer(),
      advance(DEFAULTS.maxCongestionMs - 1), timer(),
      advance(1), timer(),
      stats(),
    ],
  },
  {
    name: 'dropping below high water resumes and clears the congestion mark',
    ops: [
      send(text('lead')), complete(),
      buffered(DEFAULTS.highWaterBytes + 10),
      send(text('queued')),
      advance(5), timer(),
      buffered(0),
      timer(),
      stats(), complete(), stats(),
    ],
  },
  {
    name: 'a send error disconnects and reports it to the caller',
    ops: [send(text('lead')), complete('boom'), stats(), send(text('after'))],
  },
  {
    name: 'a throwing transport disconnects as send_throw',
    ops: [{ op: 'throwNext', message: 'socket gone' }, send(text('lead')), stats()],
  },
  {
    name: 'the close event clears the queue without a 1013',
    ops: [
      send(text('lead')), send(text('queued')),
      { op: 'closeEvent' },
      stats(),
      send(text('after')),
      timer(),
    ],
  },
  {
    name: 'send options ride the queue to the transport',
    ops: [
      send(text('lead')),
      binarySend(buffer(4, 'z')),
      binarySend(json({ type: 'snapshot', dirId: 'd9' })),
      send(json({ type: 'snapshot', dirId: 'd9', newer: true })),
      stats(),
      complete(), complete(), complete(),
    ],
  },
  {
    name: 'the two-argument send form treats options as the callback',
    ops: [callbackAsOptions(text('two-arg')), complete('late failure'), stats()],
  },
  {
    name: 'a disconnect cancels the pending retry timer',
    ops: [
      send(text('lead')), complete(),
      buffered(DEFAULTS.highWaterBytes),
      send(text('queued')),
      stats(),
      send(filled(DEFAULTS.maxFrameBytes + 1)),
      stats(),
    ],
  },
  {
    name: 'a throwing close falls back to terminate',
    ops: [closeThrows(), send(text('lead')), complete('boom'), stats()],
  },
  {
    name: 'coalescing an oversize frame into a queued slot still overflows',
    ops: [
      send(text('lead')),
      send(json(SNAPSHOT)),
      send({ kind: 'text', value: `{"type":"snapshot","dirId":"d1","pad":"${'p'.repeat(64)}"}` }),
      stats(),
    ],
  },
];

function runCase(spec) {
  const effects = [];
  let clock = 1_000;
  let pending = null;
  let throwNext = null;
  let scheduled = null;
  let closeThrows = false;
  let ordinal = -1;
  const callbacks = new Map();

  const ws = {
    bufferedAmount: 0,
    send(data, options, callback) {
      effects.push({
        e: 'send',
        bytes: typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength ?? data.length,
        sha: digest(data),
        options: options === undefined ? null : typeof options === 'function' ? 'function' : options,
      });
      if (throwNext !== null) {
        const message = throwNext;
        throwNext = null;
        throw new Error(message);
      }
      pending = callback;
    },
    close(code, reason) {
      effects.push({ e: 'close', code, reason });
      if (closeThrows) throw new Error('close threw');
    },
    terminate() { effects.push({ e: 'terminate' }); },
    once(event, handler) { if (event === 'close') ws._onClose = handler; },
  };

  const api = installWsBackpressure(ws, {
    limits: spec.limits || {},
    now: () => clock,
    schedule: (fn, ms) => {
      effects.push({ e: 'schedule', ms });
      scheduled = fn;
      return { unref() {} };
    },
    cancelSchedule: () => { effects.push({ e: 'cancel' }); scheduled = null; },
    onMetric: (name, amount, op) => effects.push({ e: 'metric', name, amount, set: op === 'set' }),
    onLog: (event, fields) => effects.push({ e: 'log', event, ...fields }),
  });

  for (const op of spec.ops) {
    if (op.op === 'send') {
      const index = ++ordinal;
      const data = materialize(op.data);
      const callback = op.callback
        ? error => effects.push({ e: 'callback', index, error: error ? error.message : null })
        : undefined;
      if (op.callbackAsOptions) ws.send(data, callback);
      else if (op.bounded) ws.send(data, op.options, callback);
      else api.sendImmediate(data, op.options, callback);
    } else if (op.op === 'complete') {
      const callback = pending;
      pending = null;
      if (callback) callback(op.error ? new Error(op.error) : undefined);
    } else if (op.op === 'throwNext') {
      throwNext = op.message;
    } else if (op.op === 'closeThrows') {
      closeThrows = true;
    } else if (op.op === 'timer') {
      const fn = scheduled;
      scheduled = null;
      if (fn) fn();
    } else if (op.op === 'buffered') {
      ws.bufferedAmount = op.bytes;
    } else if (op.op === 'advance') {
      clock += op.ms;
    } else if (op.op === 'closeEvent') {
      if (ws._onClose) ws._onClose();
    } else if (op.op === 'stats') {
      const value = api.stats();
      effects.push({
        e: 'stats',
        queueBytes: value.queueBytes,
        queueMessages: value.queueMessages,
        sending: value.sending,
        congested: value.congestedAt !== 0,
        closed: value.closed,
      });
    } else {
      throw new Error(`unknown op ${op.op}`);
    }
  }
  return effects;
}

const corpus = {
  defaults: DEFAULTS,
  coalesceTypes: [...require('../../../tests/helpers/legacy-ws-backpressure').COALESCE_TYPES].sort(),
  cases: CASES.map(spec => ({
    name: spec.name,
    limits: spec.limits || {},
    ops: spec.ops,
    effects: runCase(spec),
  })),
};
process.stdout.write(`${JSON.stringify(corpus, null, 2)}\n`);
