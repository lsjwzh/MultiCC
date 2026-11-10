'use strict';

// Differential: one Rust owner (`RustTurnProgress` behind
// src/chat/turn-progress.js) against the four frozen pre-migration JS modules
// (tests/helpers/legacy-*.js).
//
//   * both lanes run on the SAME virtual clock, in lock-step steps;
//   * every step compares the returned value, the thrown error, frozenness and
//     the host-port calls each lane made (number of `now` reads, emit lines);
//   * seeded random interleavings cover every public method, then hand-written
//     scenarios pin the intentional differences (bugs 1, 3, 4, 5, 6, 7, 8) and
//     the engine wiring that cannot be compared through a pure module (bug 2).
//
// The heartbeat timer model is intentionally different (bug 4): the legacy code
// arms one setInterval per active entry, the facade keeps ONE timer armed from
// the owner's `nextDue()`. The scheduler below is faithful to both (a fired
// legacy timer repeats, a fired facade timer is cleared and re-armed by the
// facade itself), so the emitted payload sequence stays comparable; only the
// number of live timers and the extra `now` read used to re-arm differ.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const legacyHeartbeat = require('./helpers/legacy-progress-heartbeat');
const legacyTiming = require('./helpers/legacy-turn-timing');
const legacyTimeline = require('./helpers/legacy-turn-timeline');
const legacyProbe = require('./helpers/legacy-delivery-probe');
const progress = require('../src/chat/turn-progress');
const { createStateOwner } = require('../src/state/owner');
const { createChatSessions } = require('../src/chat/sessions');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

// ── deterministic helpers ──────────────────────────────────────────────────

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rnd, list) {
  return list[Math.floor(rnd() * list.length)];
}

function int(rnd, low, high) {
  return low + Math.floor(rnd() * (high - low + 1));
}

// JSON with the values JSON cannot spell kept visible (undefined, NaN, a
// function a prototype lookup leaked into the legacy snapshot, ...).
function canon(value) {
  if (value === undefined) return '<undefined>';
  const text = JSON.stringify(value, (key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) return `#${String(item)}`;
    if (typeof item === 'function') return '#function';
    if (item === undefined) return '#undefined';
    return item;
  });
  return text === undefined ? `#${String(value)}` : text;
}

let sessionSerial = 0;
const uniqueSession = prefix => `${prefix}-${process.pid}-${sessionSerial += 1}`;

// ── virtual clock + timer scheduler ────────────────────────────────────────

function makeSide(label) {
  const side = {
    label,
    clock: null,
    reads: 0,
    log: [],
    timers: new Map(),
    nextId: 1,
    arms: 0,
    now() {
      side.reads += 1;
      return side.clock.t;
    },
    setInterval(fn, delay) {
      const period = Math.max(0, Number(delay) || 0);
      const id = side.nextId;
      side.nextId += 1;
      side.arms += 1;
      side.timers.set(id, { id, due: side.clock.t + period, period, fn });
      return { id, unref() {} };
    },
    clearInterval(handle) {
      if (handle && handle.id != null) side.timers.delete(handle.id);
    },
    peek() {
      let best = null;
      for (const timer of side.timers.values()) {
        if (best == null || timer.due < best.due || (timer.due === best.due && timer.id < best.id)) best = timer;
      }
      return best;
    },
    dueAt(due) {
      return [...side.timers.values()]
        .filter(timer => timer.due === due)
        .sort((left, right) => left.id - right.id);
    },
    fire(timer) {
      // setInterval semantics: reschedule before the callback runs, so a
      // callback that clears its own handle (the facade's `_tick`) still sees
      // exactly one live timer afterwards.
      timer.due += timer.period;
      timer.fn();
    },
  };
  return side;
}

function makePair() {
  const clock = { t: 0 };
  const legacySide = makeSide('legacy');
  const nativeSide = makeSide('native');
  legacySide.clock = clock;
  nativeSide.clock = clock;
  return { clock, sides: [legacySide, nativeSide], legacySide, nativeSide };
}

// Fire every timer at its own due time, oldest due first, on both lanes at the
// same virtual instant. A throwing callback must not stop the interval (the
// legacy bug 3 escaped exactly like this), so the first throw per lane is
// recorded and the scheduler keeps going.
function advance(pair, until) {
  const thrown = {};
  for (let guard = 0; guard < 20000; guard += 1) {
    let due = Infinity;
    for (const side of pair.sides) {
      const next = side.peek();
      if (next && next.due < due) due = next.due;
    }
    if (!Number.isFinite(due) || due > until) return thrown;
    pair.clock.t = Math.max(pair.clock.t, due);
    for (const side of pair.sides) {
      for (const timer of side.dueAt(due)) {
        if (!side.timers.has(timer.id)) continue;
        // setInterval semantics: reschedule before the callback runs.
        timer.due += timer.period;
        try { timer.fn(); } catch (error) {
          if (!thrown[side.label]) thrown[side.label] = `${error && error.name}: ${error && error.message}`;
        }
      }
    }
  }
  throw new Error('heartbeat scheduler did not settle');
}

// Run one step on both lanes at the same virtual time and compare. Any timer
// that came due since the previous step fires at its own due time first, so a
// fake-clock jump can never turn into the legacy "late wake skips a period"
// artefact (bug 4) unless a scenario arranges it deliberately.
function callPair(pair, at, fn, options = {}) {
  advance(pair, at);
  pair.clock.t = at;
  const outcomes = [];
  for (const lane of [pair.legacy, pair.native]) {
    lane.side.reads = 0;
    lane.side.log = [];
    let value;
    let thrown = null;
    try { value = fn(lane); } catch (error) {
      thrown = `${error && error.constructor ? error.constructor.name : typeof error}: ${error && error.message}`;
    }
    outcomes.push({
      reads: lane.side.reads,
      value: canon(value),
      thrown,
      frozen: value && typeof value === 'object' ? Object.isFrozen(value) : null,
      log: lane.side.log.slice(),
    });
  }
  const [legacy, native] = outcomes;
  const label = options.label ? ` (${options.label})` : '';
  assert.equal(native.thrown, legacy.thrown, `thrown${label}`);
  assert.equal(native.value, legacy.value, `return${label}`);
  assert.equal(native.frozen, legacy.frozen, `frozen${label}`);
  if (options.compareLog !== false) assert.deepEqual(native.log, legacy.log, `port calls${label}`);
  if (options.armReads) {
    assert.ok(native.reads === legacy.reads || native.reads === legacy.reads + 1,
      `clock reads${label}: legacy ${legacy.reads}, native ${native.reads}`);
  } else {
    assert.equal(native.reads, legacy.reads, `clock reads${label}`);
  }
  return outcomes;
}

// ── heartbeat ──────────────────────────────────────────────────────────────

function heartbeatPair(intervalMs = 1000) {
  const pair = makePair();
  pair.shared = { onEvent: null };
  pair.legacyEvents = [];
  pair.nativeEvents = [];
  const lane = (side, isLegacy, events) => {
    let instance = null;
    const options = {
      intervalMs,
      now: () => side.now(),
      setInterval: (fn, delay) => side.setInterval(fn, delay),
      clearInterval: handle => side.clearInterval(handle),
      onHeartbeat(event) {
        events.push(canon(event));
        if (typeof pair.shared.onEvent === 'function') pair.shared.onEvent(instance, event);
      },
    };
    if (!isLegacy) {
      options.logWarn = (message, error) => side.log.push(['logWarn', message, error && error.message]);
    }
    instance = isLegacy
      ? new legacyHeartbeat.TurnProgressHeartbeat(options)
      : new progress.TurnProgressHeartbeat(options);
    return { side, isLegacy, events, get instance() { return instance; } };
  };
  pair.legacy = lane(pair.legacySide, true, pair.legacyEvents);
  pair.native = lane(pair.nativeSide, false, pair.nativeEvents);
  return pair;
}

function heartbeatStep(pair, at, method, args, options = {}) {
  return callPair(pair, at, lane => lane.instance[method](...args), options);
}

function sameHeartbeatEvents(pair, label) {
  assert.deepEqual(pair.nativeEvents, pair.legacyEvents, `heartbeat payloads${label ? ` (${label})` : ''}`);
}

test('heartbeat: every method agrees step by step, including status and stopAll', () => {
  const pair = heartbeatPair(1000);
  const start = heartbeatStep(pair, 0, 'start', ['s1', 't1', { phase: 'preparing' }], { armReads: true });
  assert.equal(start[0].frozen, true);
  assert.equal(start[0].value, start[1].value);
  heartbeatStep(pair, 400, 'touchVisible', ['s1', 't1'], { armReads: true });
  heartbeatStep(pair, 700, 'touchActivity', ['s1', 't1']);
  heartbeatStep(pair, 900, 'updatePhase', ['s1', 't1', 'executing', 'bash']);
  heartbeatStep(pair, 900, 'status', ['s1']);
  heartbeatStep(pair, 1200, 'start', ['s2', 't9', { phase: 'tool', safeToolKind: 'edit', toolKind: 'bash' }], { armReads: true });
  // A new turn on an occupied session replaces the predecessor.
  heartbeatStep(pair, 1500, 'start', ['s1', 't2', { phase: 'thinking' }], { armReads: true });
  heartbeatStep(pair, 1500, 'status', ['s1']);
  // Unknown ids and empty ids never read the clock nor touch the state.
  heartbeatStep(pair, 1600, 'touchVisible', ['s1', 'missing']);
  heartbeatStep(pair, 1600, 'touchVisible', ['', 't2']);
  heartbeatStep(pair, 1600, 'touchActivity', [null, 't2']);
  heartbeatStep(pair, 1600, 'updatePhase', ['s1', undefined, 'waiting']);
  heartbeatStep(pair, 1600, 'stop', ['s3', 't3']);
  heartbeatStep(pair, 1600, 'status', ['']);
  heartbeatStep(pair, 1600, 'status', ['unknown']);
  advance(pair, 5000);
  sameHeartbeatEvents(pair, 'after 5s');
  heartbeatStep(pair, 5000, 'status', ['s1']);
  heartbeatStep(pair, 5000, 'status', ['s2']);
  heartbeatStep(pair, 6000, 'stop', ['s2', 't9'], { armReads: true });
  advance(pair, 12000);
  sameHeartbeatEvents(pair, 'after stop');
  heartbeatStep(pair, 12000, 'stopAll', []);
  assert.equal(pair.legacySide.timers.size, 0);
  assert.equal(pair.nativeSide.timers.size, 0);
  sameHeartbeatEvents(pair, 'stopAll');
});

test('heartbeat: ids are trimmed, object updates prefer an own safeToolKind', () => {
  const pair = heartbeatPair(1000);
  const started = heartbeatStep(pair, 0, 'start', ['  s1  ', ' t1 ', { phase: 'EXECUTING', toolKind: 'edit' }], { armReads: true });
  assert.match(started[0].value, /"phase":"tool"/);
  assert.match(started[0].value, /"safeToolKind":"filesystem"/);
  // Update object without an own safeToolKind falls back to toolKind.
  heartbeatStep(pair, 10, 'updatePhase', ['s1', 't1', { phase: 'executing', toolKind: 'bash' }]);
  heartbeatStep(pair, 10, 'status', ['s1']);
  // An array is an object: the object branch wins and both properties miss.
  heartbeatStep(pair, 20, 'updatePhase', ['s1', 't1', ['thinking'], 'bash']);
  heartbeatStep(pair, 20, 'status', ['s1']);
  // A Date has no phase/toolKind either.
  heartbeatStep(pair, 30, 'updatePhase', ['s1', 't1', new Date(1700000000000)]);
  heartbeatStep(pair, 30, 'status', ['s1']);
  // The tool kind is kept only while the phase is `tool`.
  heartbeatStep(pair, 40, 'updatePhase', ['s1', 't1', { phase: 'executing', safeToolKind: 'mcp' }]);
  heartbeatStep(pair, 50, 'updatePhase', ['s1', 't1', 'thinking']);
  heartbeatStep(pair, 50, 'status', ['s1']);
});

test('heartbeat: a throwing clock keeps the documented mutation order', () => {
  const pair = heartbeatPair(1000);
  heartbeatStep(pair, 0, 'start', ['s1', 't1', { phase: 'thinking' }], { armReads: true });
  // start clears the same-session predecessor BEFORE reading the clock.
  const outcome = callPair(pair, 10, lane => {
    const original = lane.side.now;
    lane.side.now = function throwingNow() {
      if (lane.side.reads === 0) { lane.side.reads += 1; throw new RangeError('clock down'); }
      return original.call(lane.side);
    };
    try { return lane.instance.start('s1', 't2', { phase: 'thinking' }); } finally {
      lane.side.now = original;
    }
  }, { armReads: true });
  assert.equal(outcome[0].thrown, 'RangeError: clock down');
  assert.equal(outcome[1].thrown, 'RangeError: clock down');
  // Both lanes forgot the stale predecessor and never inserted the new turn.
  heartbeatStep(pair, 15, 'status', ['s1']);
  assert.equal(pair.legacy.instance.status('s1'), null);
  assert.equal(pair.native.instance.status('s1'), null);
  // updatePhase sets the phase first, then the clock throws.
  callPair(pair, 20, lane => {
    const original = lane.side.now;
    lane.side.now = function throwingNow() {
      lane.side.reads += 1;
      throw new Error('clock down');
    };
    try { return lane.instance.updatePhase('s1', 't1', 'waiting'); } finally {
      lane.side.now = original;
    }
  });
  // A non-finite clock is a TypeError with the legacy message.
  for (const value of [NaN, Infinity]) {
    callPair(pair, 40, lane => {
      const original = lane.side.now;
      lane.side.now = () => value;
      try { return lane.instance.touchVisible('s1', 't1'); } finally { lane.side.now = original; }
    });
  }
  callPair(pair, 50, lane => lane.instance.touchActivity('s1', 't1'));
});

test('heartbeat: seeded interleavings (4 seeds, 150 steps each)', () => {
  const phases = ['starting', 'preparing', 'running', 'thinking', 'reasoning', 'executing',
    'monitoring', 'finalizing', 'recovering', 'mystery', '  Waiting ', ''];
  const kinds = ['bash', 'command', 'edit', 'read', 'find', 'fetch', 'monitor', 'agent',
    'integration', 'other', 'poll_loop', 'file_read', 'https', 'mystery', ''];
  const sessions = ['s1', 's2', 's3'];
  for (const seed of [1, 7, 42, 20261110]) {
    const rnd = mulberry32(seed);
    const pair = heartbeatPair(1000);
    // Deterministic re-entrancy: a payload that has been silent for two
    // periods touches activity from inside the callback (both lanes see the
    // same payload sequence, so the same decision).
    pair.shared.onEvent = (instance, event) => {
      if (event.silentMs >= 2000) instance.touchActivity(event.sessionId, event.turnId);
    };
    let now = 0;
    for (let step = 0; step < 150; step += 1) {
      now += int(rnd, 0, 900);
      const session = pick(rnd, sessions);
      const turn = pick(rnd, ['t1', 't2', 't3']);
      const roll = rnd();
      if (roll < 0.2) {
        const form = rnd();
        let update;
        if (form < 0.4) update = { phase: pick(rnd, phases), safeToolKind: pick(rnd, kinds) };
        else if (form < 0.6) update = { phase: pick(rnd, phases), toolKind: pick(rnd, kinds) };
        else if (form < 0.75) update = pick(rnd, phases);
        else update = { phase: 'tool', safeToolKind: pick(rnd, kinds) };
        heartbeatStep(pair, now, 'start', [session, turn, update], { armReads: true });
      } else if (roll < 0.4) {
        heartbeatStep(pair, now, 'touchVisible', [session, turn], { armReads: true });
      } else if (roll < 0.55) {
        heartbeatStep(pair, now, 'touchActivity', [session, turn]);
      } else if (roll < 0.75) {
        const form = rnd();
        heartbeatStep(pair, now, 'updatePhase', form < 0.5
          ? [session, turn, { phase: pick(rnd, phases), safeToolKind: pick(rnd, kinds) }]
          : [session, turn, pick(rnd, phases), pick(rnd, kinds)]);
      } else if (roll < 0.85) {
        heartbeatStep(pair, now, 'stop', [session, turn], { armReads: true });
      } else if (roll < 0.95) {
        heartbeatStep(pair, now, 'status', [session]);
      } else {
        heartbeatStep(pair, now, 'stopAll', []);
      }
      if (rnd() < 0.4) {
        now += int(rnd, 1, 4000);
        advance(pair, now);
        sameHeartbeatEvents(pair, `seed ${seed} step ${step}`);
      }
    }
    now += 20000;
    advance(pair, now);
    sameHeartbeatEvents(pair, `seed ${seed} tail`);
  }
});

test('intentional difference (bug 1): prototype members are not aliases', () => {
  assert.equal(legacyHeartbeat.sanitizePhase('constructor'), Object);
  assert.equal(legacyHeartbeat.sanitizePhase('__proto__'), Object.prototype);
  assert.equal(progress.sanitizePhase('constructor'), 'running');
  assert.equal(progress.sanitizePhase('__proto__'), 'running');
  assert.equal(legacyHeartbeat.sanitizeToolKind('constructor'), Object);
  assert.equal(legacyHeartbeat.sanitizeToolKind('__proto__'), Object.prototype);
  assert.equal(progress.sanitizeToolKind('constructor'), 'other');
  assert.equal(progress.sanitizeToolKind('__proto__'), 'other');

  const pair = heartbeatPair(1000);
  pair.clock.t = 0;
  // Deliberately NOT through callPair: these inputs diverge by design.
  pair.legacy.instance.start('s1', 't1', 'constructor');
  pair.native.instance.start('s1', 't1', 'constructor');
  assert.equal(typeof pair.legacy.instance.status('s1').phase, 'function');
  assert.equal(pair.native.instance.status('s1').phase, 'running');
  pair.clock.t = 10;
  pair.legacy.instance.start('s1', 't1', { phase: 'executing', safeToolKind: 'constructor' });
  pair.native.instance.start('s1', 't1', { phase: 'executing', safeToolKind: 'constructor' });
  assert.equal(typeof pair.legacy.instance.status('s1').safeToolKind, 'function');
  assert.equal(pair.native.instance.status('s1').safeToolKind, 'other');
  // After the divergent inputs the lanes agree again on the canonical ones.
  pair.clock.t = 20;
  heartbeatStep(pair, 20, 'updatePhase', ['s1', 't1', 'thinking']);
  heartbeatStep(pair, 20, 'status', ['s1']);
});

test('intentional difference (bug 3): a throwing callback is caught and logged', () => {
  const pair = heartbeatPair(1000);
  pair.shared.onEvent = instance => { throw new Error('callback boom'); };
  heartbeatStep(pair, 0, 'start', ['s1', 't1', { phase: 'thinking' }], { armReads: true });
  heartbeatStep(pair, 0, 'start', ['s2', 't1', { phase: 'thinking' }], { armReads: true });
  const thrown = advance(pair, 1000);
  // The legacy throw escapes the interval callback; the owner reports it and
  // keeps firing the other due entries.
  assert.equal(thrown.legacy, 'Error: callback boom');
  assert.equal(thrown.native, undefined);
  sameHeartbeatEvents(pair);
  assert.deepEqual(pair.nativeSide.log, [
    ['logWarn', 'progress_heartbeat_failed', 'callback boom'],
    ['logWarn', 'progress_heartbeat_failed', 'callback boom'],
  ]);
  assert.equal(pair.legacySide.log.length, 0);
});

test('intentional difference (bug 4): one timer re-armed from nextDue', () => {
  const pair = heartbeatPair(1000);
  heartbeatStep(pair, 0, 'start', ['s1', 't1', { phase: 'thinking' }], { armReads: true });
  heartbeatStep(pair, 100, 'start', ['s2', 't1', { phase: 'thinking' }], { armReads: true });
  heartbeatStep(pair, 200, 'start', ['s3', 't1', { phase: 'thinking' }], { armReads: true });
  assert.equal(pair.legacySide.timers.size, 3, 'legacy arms one interval per entry');
  assert.equal(pair.nativeSide.timers.size, 1, 'the facade arms a single timer');
  const thrown = advance(pair, 5000);
  assert.deepEqual(thrown, {});
  sameHeartbeatEvents(pair);
  assert.ok(pair.legacyEvents.length >= 12, 'one payload per silent period per entry');
  // Deterministic due-time ticks: a late wake cannot skip a whole period.
  assert.equal(pair.legacySide.timers.size, 3);
  assert.equal(pair.nativeSide.timers.size, 1);
});

// ── turn timing ────────────────────────────────────────────────────────────

function timingPair() {
  const pair = makePair();
  pair.legacy = {
    side: pair.legacySide,
    instance: legacyTiming.createTurnTimingRecorder({
      now: () => pair.legacySide.now(),
      emit: line => pair.legacySide.log.push(['emit', line]),
    }),
  };
  pair.native = {
    side: pair.nativeSide,
    instance: progress.createTurnTimingRecorder({
      now: () => pair.nativeSide.now(),
      emit: line => pair.nativeSide.log.push(['emit', line]),
    }),
  };
  return pair;
}

function timingStep(pair, at, method, args) {
  return callPair(pair, at, lane => lane.instance[method](...args));
}

test('timing: begin/mark/firstByte/abort/drop agree line for line', () => {
  const pair = timingPair();
  timingStep(pair, 100, 'begin', ['s1', 't1', { t0: 90, cli: 'codex' }]);
  timingStep(pair, 110, 'markSpawned', ['s1', 't1', 105]);
  timingStep(pair, 120, 'markSent', ['s1', 't1', 115]);
  timingStep(pair, 130, 'markSent', ['s1', 't1', 999]); // first mark wins
  timingStep(pair, 140, 'markFirstByte', ['s1', 't1', 135]);
  assert.match(pair.legacySide.log[0][1], /^\[turn-timing\] /);
  assert.match(pair.nativeSide.log[0][1], /^\[turn-timing\] /);
  // A second first byte counts nothing and logs nothing.
  timingStep(pair, 145, 'markFirstByte', ['s1', 't1', 140]);
  // Abort after the success line is a no-op.
  timingStep(pair, 150, 'abort', ['s1', 't1', 'late']);
  timingStep(pair, 150, 'get', ['s1', 't1']);

  timingStep(pair, 200, 'begin', ['s2', 't1']);
  timingStep(pair, 210, 'abort', ['s2', 't1', 'api down']);
  assert.match(pair.legacySide.log[0][1], /^\[turn-timing-abort\] /);
  timingStep(pair, 220, 'markFirstByte', ['s2', 't1', 215]); // t3 after abort: no line
  timingStep(pair, 230, 'abort', ['s2', 't1', 'again']);

  // Reason coercion: String(reason || 'unknown').
  for (const reason of ['', null, 0, { a: 1 }]) {
    timingStep(pair, 300, 'begin', ['s3', `t-${canon(reason)}`]);
    timingStep(pair, 310, 'abort', ['s3', `t-${canon(reason)}`, reason]);
  }
  // Falsy ids are refused and never read the clock.
  timingStep(pair, 400, 'begin', ['', 't1']);
  timingStep(pair, 400, 'begin', ['s4', 0]);
  timingStep(pair, 400, 'markSpawned', ['s4', 't1', 1]); // before begin: dropped
  timingStep(pair, 400, 'markFirstByte', ['s4', 't1', 1]);
  timingStep(pair, 400, 'abort', ['s4', 't1', 'x']);
  timingStep(pair, 400, 'drop', ['s4', 't1']);
  timingStep(pair, 400, 'get', ['s4', 't1']);
  // begin with a non-placeable t0 reads the clock; cli is `cli || null`.
  for (const t0 of [NaN, 'x', undefined, Infinity]) {
    timingStep(pair, 500, 'begin', ['s5', `t-${canon(t0)}`, { t0, cli: '' }]);
  }
  for (const ts of [NaN, '9', undefined]) {
    timingStep(pair, 600, 'markSpawned', ['s5', `t-${canon(ts)}`, ts]);
    timingStep(pair, 600, 'markSent', ['s5', `t-${canon(ts)}`, ts]);
    timingStep(pair, 600, 'markFirstByte', ['s5', `t-${canon(ts)}`, ts]);
  }
});

test('timing: seeded interleavings (4 seeds, 120 steps each)', () => {
  const options = [undefined, {}, { t0: 0 }, { t0: 500 }, { t0: NaN }, { t0: 'x' }];
  const clis = ['claude', 'codex', 'opencode', null, '', 0];
  const clockValues = [0, 100, 250.5, NaN, '7', undefined];
  for (const seed of [3, 11, 99, 2026]) {
    const rnd = mulberry32(seed);
    const pair = timingPair();
    const sessions = ['a', 'b', 'c'];
    const turns = ['x', 'y', 'z'];
    let now = 0;
    for (let step = 0; step < 120; step += 1) {
      now += int(rnd, 0, 60);
      const session = pick(rnd, sessions);
      const turn = pick(rnd, turns);
      const roll = rnd();
      if (roll < 0.25) {
        const option = pick(rnd, options);
        const withCli = option && Object.assign({}, option, { cli: pick(rnd, clis) });
        timingStep(pair, now, 'begin', [session, turn, withCli === undefined ? undefined : withCli]);
      } else if (roll < 0.5) {
        timingStep(pair, now, 'markSpawned', [session, turn, pick(rnd, clockValues)]);
      } else if (roll < 0.7) {
        timingStep(pair, now, 'markSent', [session, turn, pick(rnd, clockValues)]);
      } else if (roll < 0.85) {
        timingStep(pair, now, 'markFirstByte', [session, turn, pick(rnd, clockValues)]);
      } else if (roll < 0.93) {
        timingStep(pair, now, 'abort', [session, turn, pick(rnd, ['timeout', '', null, 7])]);
      } else if (roll < 0.97) {
        timingStep(pair, now, 'drop', [session, turn]);
      } else {
        timingStep(pair, now, 'get', [session, turn]);
      }
    }
    assert.deepEqual(pair.nativeSide.log, pair.legacySide.log, `emitted lines (seed ${seed})`);
  }
});

test('timing: the 512-record eviction keeps only the first logged victim', () => {
  const pair = timingPair();
  for (let index = 0; index < 610; index += 1) {
    const turn = `t${index}`;
    timingStep(pair, index, 'begin', ['s', turn, { t0: index }]);
    if (index % 3 !== 0) timingStep(pair, index, 'markFirstByte', ['s', turn, index + 1]);
  }
  for (const index of [0, 1, 2, 3, 100, 511, 512, 609]) {
    timingStep(pair, 1000, 'get', ['s', `t${index}`]);
  }
});

test('timing: a throwing emit leaves the record logged on both sides', () => {
  const pair = makePair();
  const make = (side, isLegacy) => ({
    side,
    instance: (isLegacy ? legacyTiming.createTurnTimingRecorder : progress.createTurnTimingRecorder)({
      now: () => side.now(),
      emit: () => { throw new RangeError('emit boom'); },
    }),
  });
  pair.legacy = make(pair.legacySide, true);
  pair.native = make(pair.nativeSide, false);
  callPair(pair, 0, lane => lane.instance.begin('s', 't', { t0: 0 }));
  const outcome = callPair(pair, 10, lane => lane.instance.markFirstByte('s', 't', 10));
  assert.equal(outcome[0].thrown, 'RangeError: emit boom');
  assert.equal(outcome[1].thrown, 'RangeError: emit boom');
  callPair(pair, 20, lane => lane.instance.get('s', 't'));
  // The success line never made it out; abort is refused because logged is set.
  callPair(pair, 30, lane => lane.instance.abort('s', 't', 'late'));
});

test('intentional difference (bug 5): no null arithmetic in the persisted field', () => {
  // The pre-fix engine formula (turn-engine.js at HEAD) without null guards.
  function legacyField(recorder, session, turn) {
    const record = recorder.get(session, turn);
    if (!record || record.t3 === null) return undefined;
    return {
      t0: record.t0, t1: record.t1, t2: record.t2, t3: record.t3,
      spawnMs: record.t1 - record.t0,
      sendMs: record.t2 - record.t1,
      firstByteMs: record.t3 - record.t2,
      totalMs: record.t3 - record.t0,
    };
  }
  const pair = timingPair();
  timingStep(pair, 0, 'begin', ['s1', 't1', { t0: 100 }]);
  // No spawned/sent marks at all: first byte straight away.
  timingStep(pair, 300, 'markFirstByte', ['s1', 't1', 300]);
  const legacyValue = legacyField(pair.legacy.instance, 's1', 't1');
  const nativeValue = pair.native.instance.field('s1', 't1');
  assert.deepEqual(legacyValue.spawnMs, -100, 'legacy coerced a null t1 into 0');
  assert.deepEqual(legacyValue.sendMs, 0);
  assert.deepEqual(legacyValue.firstByteMs, 300);
  assert.deepEqual(nativeValue.spawnMs, null);
  assert.deepEqual(nativeValue.sendMs, null);
  assert.deepEqual(nativeValue.firstByteMs, null);
  assert.equal(nativeValue.totalMs, 200);
  assert.deepEqual(Object.keys(nativeValue),
    ['t0', 't1', 't2', 't3', 'spawnMs', 'sendMs', 'firstByteMs', 'totalMs']);

  // t1 known, t2 missing: the first delta is real, the rest is null.
  timingStep(pair, 400, 'begin', ['s2', 't1', { t0: 100 }]);
  timingStep(pair, 410, 'markSpawned', ['s2', 't1', 120]);
  timingStep(pair, 420, 'markFirstByte', ['s2', 't1', 420]);
  const partial = pair.native.instance.field('s2', 't1');
  assert.equal(partial.spawnMs, 20);
  assert.equal(partial.sendMs, null);
  assert.equal(partial.firstByteMs, null);
  assert.equal(partial.totalMs, 320);
  // Unknown/undefined while t3 is missing.
  timingStep(pair, 500, 'begin', ['s3', 't1', { t0: 1 }]);
  assert.deepEqual(pair.native.instance.field('s3', 't1'), undefined);
  assert.deepEqual(pair.legacy.instance.get('s3', 't1').t3, null);
  // The differential-driver comparison still holds for the record itself.
  timingStep(pair, 510, 'get', ['s3', 't1']);
});

// ── turn timeline ──────────────────────────────────────────────────────────

function timelinePair() {
  const pair = makePair();
  const session = uniqueSession('timeline');
  const port = progress.createTurnProgress().timeline;
  return { pair, session, port, legacyCs: {}, nativeCs: {} };
}

function startBoth(world, at, csOptions = {}) {
  for (const target of [world.legacyCs, world.nativeCs]) {
    for (const [name, value] of Object.entries(csOptions)) {
      // Give each lane its own array so a mutating lane cannot affect the other.
      target[name] = Array.isArray(value) ? value.slice() : value;
    }
  }
  const legacyTimelineValue = legacyTimeline.startTurn(world.legacyCs, at);
  const nativeOrigin = world.port.startTurn(world.session, world.nativeCs, at);
  assert.equal(nativeOrigin, legacyTimelineValue ? legacyTimelineValue.origin : null, 'startTurn origin');
  assert.equal('turnTimeline' in world.nativeCs, false, 'no timeline state comes back to Node');
}

function observeBoth(world, at, lane, evt) {
  if (lane === 'claude') {
    legacyTimeline.observeClaude(world.legacyCs, evt, at);
    world.port.observeClaude(world.session, world.nativeCs, evt, at);
  } else {
    legacyTimeline.observeAdapter(world.legacyCs, evt, at);
    world.port.observeAdapter(world.session, world.nativeCs, evt, at);
  }
}

function compareTimeline(world, at, label) {
  const legacySnapshot = legacyTimeline.snapshot(world.legacyCs, at);
  const nativeSnapshot = world.port.snapshot(world.session, world.nativeCs, at);
  assert.deepEqual(nativeSnapshot, legacySnapshot, `snapshot (${label})`);
  assert.deepEqual(world.port.field(world.session, world.nativeCs, at),
    legacyTimeline.field(world.legacyCs, at), `field (${label})`);
  assert.deepEqual(world.port.currentStage(world.session, world.nativeCs, at),
    legacyTimeline.currentStage(world.legacyCs, at), `currentStage (${label})`);
}

const se = (event, extra = {}) => ({ type: 'stream_event', event, parent_tool_use_id: null, ...extra });

test('timeline: claude stream-json parity for every frame variant', () => {
  const world = timelinePair();
  startBoth(world, 1000, { turnStartedAt: 900, cli: 'claude' });
  const frames = [
    null,
    'not an object',
    5,
    { type: 'stream_event', parent_tool_use_id: 'tool-1', event: { type: 'content_block_start', content_block: { type: 'thinking' } } },
    se({ type: 'message_start' }),
    se(null),
    se({ type: 'content_block_start', content_block: null }),
    se({ type: 'content_block_start', content_block: { type: 'thinking' } }),
    se({ type: 'content_block_delta', delta: { type: 'thinking_delta' } }),
    se({ type: 'content_block_delta', delta: { type: 'signature_delta' } }),
    se({ type: 'content_block_stop' }),
    se({ type: 'content_block_delta', delta: { type: 'text_delta' } }),
    se({ type: 'content_block_start', content_block: { type: 'text' } }),
    se({ type: 'content_block_delta', delta: { type: 'input_json_delta' } }),
    se({ type: 'content_block_delta', delta: { type: 'unknown_delta' } }),
    se({ type: 'content_block_delta' }),
    se({ type: 'content_block_stop' }),
    se({ type: 'content_block_start', content_block: { type: 'tool_use' } }),
    se({ type: 'content_block_stop' }),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }, null, { type: 'tool_use', id: 'tool-1' }] } },
    se({ type: 'content_block_start', content_block: { type: 'text' } }),
    se({ type: 'content_block_delta', delta: { type: 'text_delta' } }),
    se({ type: 'content_block_stop' }),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] } },
    { type: 'user', message: { content: 'not an array' } },
    { type: 'assistant', message: null },
    { type: 'result', subtype: 'success' },
    se({ type: 'content_block_start', content_block: { type: 'redacted_thinking' } }),
    se({ type: 'content_block_stop' }),
  ];
  let at = 1200;
  frames.forEach((frame, index) => {
    observeBoth(world, at, 'claude', frame);
    compareTimeline(world, at, `claude frame ${index}`);
    at += 700;
  });
  assert.equal(world.port.snapshot(world.session, world.nativeCs, at).origin, 900);
});

test('timeline: adapter event parity, including tool_update and part_delta', () => {
  const world = timelinePair();
  startBoth(world, 0, { turnStartedAt: 0, cli: 'codex', currentToolCalls: [] });
  const events = [
    null,
    'nope',
    { type: 'thinking' },
    { type: 'assistant_text', text: '' },
    { type: 'assistant_text', text: 'hello' },
    { type: 'tool_start', id: 'a' },
    { type: 'tool_start', id: '' },
    { type: 'tool_start', id: null },
    { type: 'tool_update', id: 'a', completed: false },
    { type: 'tool_update', completed: false },
    { type: 'tool_update', id: 'call_1', completed: true },
    { type: 'tool_result', id: 'a' },
    { type: 'tool_result', id: 'unknown' },
    { type: 'tool_result' },
    { type: 'part_delta', delta: { type: 'reasoning' } },
    { type: 'part_delta', delta: { type: 'text' } },
    { type: 'part_delta', delta: 'string delta' },
    { type: 'part_delta' },
    { type: 'unknown_event' },
  ];
  let at = 100;
  events.forEach((evt, index) => {
    if (index === 9) world.legacyCs.currentToolCalls.push({ id: 'call_1' });
    if (index === 9) world.nativeCs.currentToolCalls.push({ id: 'call_1' });
    observeBoth(world, at, 'adapter', evt);
    compareTimeline(world, at, `adapter event ${index}`);
    at += 400;
  });
  // Same events on a session that never started a turn stay inert.
  const idle = { session: uniqueSession('timeline-idle'), port: world.port };
  assert.equal(world.port.snapshot(idle.session, {}, at), null);
  assert.equal(world.port.currentStage(idle.session, {}, at), null);
  assert.deepEqual(world.port.field(idle.session, {}, at), {});
  // A falsy cs is inert on both lanes.
  observeBoth(world, at, 'claude', se({ type: 'content_block_start' }));
  legacyTimeline.observeClaude(null, se({ type: 'content_block_start', content_block: { type: 'text' } }), at);
  world.port.observeClaude(world.session, null, se({ type: 'content_block_start', content_block: { type: 'text' } }), at);
  world.port.observeAdapter(world.session, null, { type: 'thinking' }, at);
  compareTimeline(world, at, 'falsy cs');
});

test('timeline: origin uses strict Number.isFinite(turnStartedAt)', () => {
  for (const turnStartedAt of [undefined, null, NaN, Infinity, '1000', 1000, 0]) {
    const world = timelinePair();
    startBoth(world, 555, { turnStartedAt });
    assert.equal(legacyTimeline.snapshot(world.legacyCs, 600).origin,
      world.port.snapshot(world.session, world.nativeCs, 600).origin, String(turnStartedAt));
    compareTimeline(world, 600, `origin ${String(turnStartedAt)}`);
    // startTurn with a falsy cs returns null on both lanes.
    assert.equal(legacyTimeline.startTurn(null, 600), null);
    assert.equal(world.port.startTurn(uniqueSession('null-cs'), null, 600), null);
  }
});

test('timeline: seeded interleavings (3 seeds, 200 events each)', () => {
  const sessionNames = ['claude', 'codex', 'opencode'];
  const blockTypes = ['text', 'thinking', 'redacted_thinking', 'tool_use', undefined];
  const deltaTypes = ['text_delta', 'thinking_delta', 'signature_delta', 'input_json_delta', undefined];
  const adapterTypes = ['thinking', 'assistant_text', 'tool_start', 'tool_result',
    'tool_update', 'part_delta', 'unknown'];
  for (const seed of [5, 31, 4096]) {
    const rnd = mulberry32(seed);
    const world = timelinePair();
    startBoth(world, 0, { turnStartedAt: 0, cli: pick(rnd, sessionNames), currentToolCalls: [] });
    let at = 0;
    for (let step = 0; step < 200; step += 1) {
      at += pick(rnd, [0, 1, 10, 400, 1499, 1500, 1501, 4000]);
      if (rnd() < 0.5) {
        const variant = rnd();
        let evt;
        if (variant < 0.3) {
          evt = se({ type: 'content_block_start', content_block: { type: pick(rnd, blockTypes) } });
        } else if (variant < 0.6) {
          evt = se({ type: 'content_block_delta', delta: { type: pick(rnd, deltaTypes) } });
        } else if (variant < 0.7) {
          evt = se({ type: 'content_block_stop' });
        } else if (variant < 0.85) {
          evt = { type: 'assistant', message: { content: [
            { type: 'tool_use', id: pick(rnd, ['t1', 't2', '', null]) },
            pick(rnd, [null, { type: 'text' }]),
          ] } };
        } else {
          evt = { type: 'user', message: { content: [
            { type: 'tool_result', tool_use_id: pick(rnd, ['t1', 't2', 'unknown', null]) },
          ] } };
        }
        if (rnd() < 0.1) evt.parent_tool_use_id = 'sub';
        observeBoth(world, at, 'claude', evt);
      } else {
        const type = pick(rnd, adapterTypes);
        const evt = { type };
        if (type === 'assistant_text') evt.text = pick(rnd, ['', 'x']);
        if (type === 'tool_start' || type === 'tool_result') evt.id = pick(rnd, ['a', 'b', '', null]);
        if (type === 'tool_update') {
          evt.id = pick(rnd, ['a', '', null]);
          evt.completed = rnd() < 0.5;
          if (rnd() < 0.5) {
            const known = { id: pick(rnd, ['a', 'b']) };
            world.legacyCs.currentToolCalls.push(known);
            world.nativeCs.currentToolCalls.push({ id: known.id });
          }
        }
        if (type === 'part_delta') evt.delta = { type: pick(rnd, ['reasoning', 'text', 'other']) };
        observeBoth(world, at, 'adapter', evt);
      }
      if (step % 5 === 0) compareTimeline(world, at, `seed ${seed} step ${step}`);
    }
    compareTimeline(world, at, `seed ${seed} tail`);
    // The session key, not the cs identity, owns the state (decision 1).
    assert.equal(world.port.forget(world.session), true);
    assert.equal(world.port.snapshot(world.session, world.nativeCs, at), null);
    assert.equal(world.port.forget(world.session), false);
  }
});

test('intentional preservation (bug 7): zero-length request spans and the 4000 cap', () => {
  const world = timelinePair();
  startBoth(world, 10, { turnStartedAt: 10 });
  // An instant tool result: the pushed request span has e - s === 0 and is
  // dropped from the snapshot (but still consumes a cap slot).
  observeBoth(world, 10, 'adapter', { type: 'tool_result', id: 'none-open' });
  compareTimeline(world, 10, 'instant request dropped');
  assert.deepEqual(world.port.snapshot(world.session, world.nativeCs, 10).spans, []);
  // A following output frame at the same instant is kept.
  observeBoth(world, 10, 'adapter', { type: 'assistant_text', text: 'x' });
  compareTimeline(world, 10, 'same-instant output kept');
  assert.deepEqual(world.port.snapshot(world.session, world.nativeCs, 10).spans,
    [{ k: 'output', s: 10, e: 10 }]);

  const capped = timelinePair();
  startBoth(capped, 0, { turnStartedAt: 0 });
  let at = 0;
  for (let index = 0; index < 4100; index += 1) {
    at += 2000; // farther than MERGE_GAP: every frame opens its own span
    observeBoth(capped, at, 'adapter', { type: 'assistant_text', text: 'x' });
  }
  const legacyLength = legacyTimeline.snapshot(capped.legacyCs, at).spans.length;
  const nativeLength = capped.port.snapshot(capped.session, capped.nativeCs, at).spans.length;
  assert.equal(nativeLength, legacyLength);
  assert.equal(nativeLength, 4000, 'MAX_SPANS silently drops every further push');
  assert.equal(legacyTimeline.MERGE_GAP_MS, progress.MERGE_GAP_MS);
});

// ── delivery probe ─────────────────────────────────────────────────────────

function probePair(maxIdentities = 3) {
  const pair = makePair();
  pair.legacy = {
    side: pair.legacySide,
    instance: legacyProbe.createDeliveryProbeRegistry({
      maxIdentities,
      now: () => pair.legacySide.now(),
    }),
  };
  pair.native = {
    side: pair.nativeSide,
    instance: progress.createDeliveryProbeRegistry({
      maxIdentities,
      now: () => pair.nativeSide.now(),
    }),
  };
  return pair;
}

function probeStep(pair, at, method, args) {
  return callPair(pair, at, lane => lane.instance[method](...args));
}

test('probe: record/lookup agree, including LRU refresh and eviction', () => {
  const pair = probePair(3);
  probeStep(pair, 1, 'record', ['s1', 'm1', 'd1', { handedOff: false, turnId: 'turn-1' }]);
  probeStep(pair, 2, 'record', ['s1', 'm2', 'd2', { handedOff: true }]);
  probeStep(pair, 3, 'record', ['s1', 'm3', 'd3', {}]);
  probeStep(pair, 4, 'lookup', ['s1', 'm1']);
  // Refresh m1: it moves to the end of the LRU order.
  probeStep(pair, 5, 'record', ['s1', 'm1', null, { handedOff: true, turnId: 'turn-2' }]);
  probeStep(pair, 6, 'record', ['s1', 'm4', null, { handedOff: false }]);
  probeStep(pair, 7, 'lookup', ['s1', 'm1']);
  probeStep(pair, 8, 'lookup', ['s1', 'm2']);
  probeStep(pair, 9, 'lookup', ['s1', 'd1']);
  probeStep(pair, 9, 'lookup', ['s1', 'm3']);
  // Rejected records do not create a session or read the clock.
  probeStep(pair, 10, 'record', ['s2', null, null, {}]);
  probeStep(pair, 10, 'record', ['', 'm', 'd', {}]);
  probeStep(pair, 10, 'lookup', ['', 'm']);
  probeStep(pair, 10, 'lookup', ['s2', 'm']);
  // The duplicate-accepted stamp overwrites turnId with null (bug 8, preserved).
  probeStep(pair, 11, 'record', ['s1', 'm1', 'd1', { handedOff: true }]);
  probeStep(pair, 12, 'lookup', ['s1', 'm1']);
  assert.equal(pair.native.instance.lookup('s1', 'm1').turnId, null);
  assert.equal(pair.legacy.instance.lookup('s1', 'm1').turnId, null);
});

test('probe: seeded interleavings (4 seeds, 150 steps each)', () => {
  for (const seed of [2, 13, 77, 123456]) {
    const rnd = mulberry32(seed);
    const pair = probePair(pick(rnd, [3, 64]));
    const sessions = ['s1', 's2'];
    const identities = ['m1', 'm2', 'm3', 'd1', 'd2'];
    let now = 0;
    for (let step = 0; step < 150; step += 1) {
      now += int(rnd, 0, 5);
      if (rnd() < 0.6) {
        probeStep(pair, now, 'record', [
          pick(rnd, sessions),
          pick(rnd, identities),
          rnd() < 0.5 ? pick(rnd, identities) : null,
          { handedOff: rnd() < 0.5, turnId: rnd() < 0.7 ? `turn-${int(rnd, 0, 3)}` : undefined },
        ]);
      } else {
        probeStep(pair, now, 'lookup', [pick(rnd, sessions), pick(rnd, identities)]);
      }
    }
    for (const session of sessions) {
      for (const identity of identities) probeStep(pair, now, 'lookup', [session, identity]);
    }
  }
});

test('intentional difference (bug 6): empty probe sessions are pruned, no cap spin', () => {
  // Cap 0 empties the table; the Rust owner also drops the empty session slot.
  const zero = progress.createTurnProgress({ maxIdentities: 0 });
  zero.deliveryProbe({ now: () => 5 }).record('s', 'm', 'd', { handedOff: false });
  assert.equal(zero.deliveryProbe({ now: () => 5 }).lookup('s', 'm'), null);
  assert.equal(zero.owner.probeSessionCount(), 0);
  // A negative cap cannot spin (the legacy `while (size > max) delete first`
  // loop never terminates once the table is empty).
  const negative = progress.createTurnProgress({ maxIdentities: -1 });
  negative.deliveryProbe({ now: () => 5 }).record('s', 'm', null, { handedOff: true });
  assert.equal(negative.deliveryProbe({ now: () => 5 }).lookup('s', 'm'), null);
  assert.equal(negative.owner.probeSessionCount(), 0);
  // A throwing clock cannot leave an empty session slot behind either.
  const owner = progress.createTurnProgress();
  const registry = owner.deliveryProbe({ now: () => { throw new Error('clock down'); } });
  assert.throws(() => registry.record('leak', 'm', 'd', {}), /clock down/);
  assert.equal(owner.owner.probeSessionCount(), 0);
  // The legacy registry does leave the slot behind; both reject the lookup.
  const legacyOwner = legacyProbe.createDeliveryProbeRegistry({
    now: () => { throw new Error('clock down'); },
  });
  assert.throws(() => legacyOwner.record('leak', 'm', 'd', {}), /clock down/);
  assert.equal(legacyOwner.lookup('leak', 'm'), null);
});

// ── engine + host wiring ───────────────────────────────────────────────────

test('bug 2: the streaming finalize keeps the heartbeat alive across a scheduled retry', () => {
  const engine = read('src/chat/turn-engine.js');
  const start = engine.indexOf('function finalizeStreamingTurn(');
  assert.ok(start > 0, 'finalizeStreamingTurn exists');
  const branch = engine.indexOf("if (plan.action === 'retry-api')", start);
  assert.ok(branch > start, 'the retry branch exists');
  // The branch ends right before the non-retry path's comment.
  const branchEnd = engine.indexOf('\n    // Not a retry:', branch);
  assert.ok(branchEnd > branch, 'the retry branch returns before the non-retry path');
  // The old bug: a stop before the retry decision killed the retried turn.
  const beforeRetry = engine.slice(start, branch);
  assert.doesNotMatch(beforeRetry, /turnProgressHeartbeat\.stop\(/,
    'no heartbeat stop before the retry decision');
  // The blocked-retry catch is the one terminal stop inside the branch.
  const insideBranch = engine.slice(branch, branchEnd);
  const catchAt = insideBranch.indexOf('catch (error)');
  assert.ok(catchAt > 0, 'the scheduled retry start is wrapped in try/catch');
  const stopsInside = [...insideBranch.matchAll(/turnProgressHeartbeat\.stop\(/g)].map(match => match.index);
  assert.equal(stopsInside.length, 1, 'exactly one terminal stop inside the retry branch');
  assert.ok(stopsInside[0] > catchAt, 'the stop is in the blocked-retry catch, after the failure is known');
  // The non-retry path stops the heartbeat before finalizing.
  const afterBranch = engine.slice(branchEnd);
  assert.match(afterBranch, /turnProgressHeartbeat\.stop\(sessionName, turn\.turnId\)/);
});

test('wiring: one owner behind the heartbeat, the timeline, timing and probes', () => {
  const tp = progress.createTurnProgress({ intervalMs: 100 });
  const owner = tp.owner;
  const clock = { t: 0 };
  const events = [];
  const heartbeat = new progress.TurnProgressHeartbeat({
    owner,
    intervalMs: 100,
    now: () => clock.t,
    setInterval: (fn, delay) => ({ fn, due: clock.t + delay, unref() {} }),
    clearInterval: () => {},
    onHeartbeat: event => events.push(event),
  });
  heartbeat.start('wired', 'turn-1', { phase: 'thinking' });
  assert.equal(owner.heartbeatNextDue(), 100);
  clock.t = 100;
  owner.heartbeatDue(100, {
    now: () => clock.t,
    onHeartbeat: event => events.push(event),
  });
  assert.equal(events.length, 1);
  // The server maps `phase` to the wire key `heartbeatPhase`.
  assert.equal(events[0].phase, 'thinking');
  assert.equal(events[0].turnId, 'turn-1');

  tp.timeline.startTurn('wired', { turnStartedAt: 1 }, 1);
  tp.timeline.observeAdapter('wired', { turnStartedAt: 1 }, { type: 'assistant_text', text: 'x' }, 5);
  const timeline = tp.timeline.field('wired', {}, 6);
  assert.equal(timeline.timeline.spans[0].k, 'request');
  tp.deliveryProbe({ now: () => 9 }).record('wired', 'm1', 'd1', { handedOff: false, turnId: 'turn-1' });
  assert.equal(tp.deliveryProbe({ now: () => 9 }).lookup('wired', 'm1').handedOff, false);

  // The chat-session delete hook drops both name-keyed tables.
  tp.forgetSession('wired');
  assert.equal(tp.timeline.snapshot('wired', {}, 6), null);
  assert.equal(tp.deliveryProbe({ now: () => 9 }).lookup('wired', 'm1'), null);
  assert.equal(owner.probeSessionCount(), 0);
  heartbeat.stopAll();
});

test('wiring: chat-session delete and clear invoke the forget hook', () => {
  const sessions = createChatSessions(createStateOwner());
  const forgotten = [];
  sessions.setForgetHook(name => forgotten.push(name));
  sessions.set('s1', { id: 's1' });
  sessions.set('s2', { id: 's2' });
  assert.equal(sessions.delete('s1'), true);
  assert.deepEqual(forgotten, ['s1']);
  assert.equal(sessions.delete('s1'), false, 'a missing key must not fire the hook');
  sessions.clear();
  assert.deepEqual(forgotten.sort(), ['s1', 's2']);
  // Without a hook the table still behaves like a Map.
  const plain = createChatSessions(createStateOwner());
  plain.set('x', { id: 'x' });
  assert.equal(plain.delete('x'), true);
  assert.equal(plain.size, 0);
});

test('wiring source guard: server.js creates one owner and wires every reader', () => {
  const server = read('server.js');
  assert.match(server, /const turnProgress = createTurnProgress\(\);/);
  assert.match(server, /chatSessions\.setForgetHook\(turnProgress\.forgetSession\)/);
  assert.match(server, /owner: turnProgress\.owner/);
  assert.match(server, /heartbeatPhase/);
  assert.match(server, /type: 'progress_heartbeat'/);
  assert.match(server, /timelineField: turnProgress\.timeline\.field/);
  assert.match(server, /turnTiming: turnProgress\.timing\(\)/);
  assert.match(server, /turnTimeline: turnProgress\.timeline/);
  assert.match(server, /deliveryProbeRegistry: turnProgress\.deliveryProbe\(\)/);
  assert.match(server, /timelineCurrentStage: turnProgress\.timeline\.currentStage/);
  const engine = read('src/chat/turn-engine.js');
  assert.match(engine, /turnTiming: injectedTurnTiming = null/);
  assert.match(engine, /turnTimeline: injectedTurnTimeline = null/);
  assert.match(engine, /deliveryProbeRegistry: injectedDeliveryProbeRegistry = null/);
  // The four legacy modules left production; only the frozen oracles remain.
  for (const gone of ['progress-heartbeat', 'turn-timing', 'turn-timeline', 'delivery-probe']) {
    assert.equal(fs.existsSync(path.join(ROOT, 'src', 'chat', `${gone}.js`)), false, `${gone}.js deleted`);
    assert.equal(fs.existsSync(path.join(ROOT, 'tests', 'helpers', `legacy-${gone}.js`)), true,
      `legacy-${gone}.js frozen oracle`);
  }
  const sources = [
    'server.js', 'src/chat/turn-engine.js', 'src/chat/host-runtime.js', 'src/chat/finalize-host.js',
    'src/codex/usage.js', 'src/liveness/runtime.js',
  ].map(read).join('\n');
  assert.doesNotMatch(sources, /require\(['"]\.\/?(?:progress-heartbeat|turn-timing|turn-timeline|delivery-probe)['"]\)/);
  assert.doesNotMatch(sources, /require\(['"]\.\.\/chat\/(?:progress-heartbeat|turn-timing|turn-timeline|delivery-probe)['"]\)/);
  assert.doesNotMatch(sources, /cs\.turnTimeline\b/);
});
