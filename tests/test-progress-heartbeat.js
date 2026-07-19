'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_INTERVAL_MS,
  TurnProgressHeartbeat,
} = require('../src/chat/progress-heartbeat');

function createClock(startedAt = 0) {
  let now = startedAt;
  let sequence = 0;
  let unrefCalls = 0;
  const timers = new Map();

  function setIntervalFake(callback, intervalMs) {
    const handle = {
      id: ++sequence,
      unref() { unrefCalls += 1; },
    };
    timers.set(handle, { callback, intervalMs, nextAt: now + intervalMs });
    return handle;
  }

  function clearIntervalFake(handle) {
    timers.delete(handle);
  }

  function advance(ms) {
    const target = now + ms;
    while (true) {
      let dueAt = Infinity;
      for (const timer of timers.values()) dueAt = Math.min(dueAt, timer.nextAt);
      if (dueAt > target) break;
      now = dueAt;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.nextAt === dueAt);
      for (const [handle, timer] of due) {
        if (!timers.has(handle)) continue;
        timer.nextAt += timer.intervalMs;
        timer.callback();
      }
    }
    now = target;
  }

  return {
    now: () => now,
    setInterval: setIntervalFake,
    clearInterval: clearIntervalFake,
    advance,
    get activeTimers() { return timers.size; },
    get unrefCalls() { return unrefCalls; },
  };
}

function createHeartbeat(clock, heartbeats, overrides = {}) {
  return new TurnProgressHeartbeat({
    intervalMs: 30_000,
    now: clock.now,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    onHeartbeat: heartbeat => heartbeats.push(heartbeat),
    ...overrides,
  });
}

test('uses the 30 second default and emits deterministic, minimal heartbeat data', () => {
  const clock = createClock(1_000);
  const heartbeats = [];
  const manager = new TurnProgressHeartbeat({
    now: clock.now,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    onHeartbeat: heartbeat => heartbeats.push(heartbeat),
  });

  assert.equal(manager.intervalMs, DEFAULT_INTERVAL_MS);
  manager.start('session-1', 'turn-1', { phase: 'thinking' });
  assert.equal(clock.unrefCalls, 1, 'the interval does not keep Node alive');
  clock.advance(29_999);
  assert.equal(heartbeats.length, 0);
  clock.advance(1);
  assert.deepEqual(heartbeats, [{
    sessionId: 'session-1',
    turnId: 'turn-1',
    elapsedMs: 30_000,
    silentMs: 30_000,
    phase: 'thinking',
    toolKind: null,
    activityAgeMs: 30_000,
  }]);

  clock.advance(30_000);
  assert.equal(heartbeats.length, 2, 'a later silent period emits one fresh heartbeat');
  assert.equal(heartbeats[1].silentMs, 60_000);
});

test('touchVisible resets and realigns the silent window', () => {
  const clock = createClock();
  const heartbeats = [];
  const manager = createHeartbeat(clock, heartbeats);
  manager.start('s', 't');

  clock.advance(20_000);
  assert.equal(manager.touchVisible('s', 't'), true);
  assert.equal(clock.activeTimers, 1, 'reset replaces rather than duplicates the timer');
  clock.advance(29_999);
  assert.equal(heartbeats.length, 0);
  clock.advance(1);
  assert.equal(heartbeats.length, 1);
  assert.equal(heartbeats[0].elapsedMs, 50_000);
  assert.equal(heartbeats[0].silentMs, 30_000);
  assert.equal(heartbeats[0].activityAgeMs, 30_000);
});

test('activity and phase updates preserve silence while exposing only safe categories', () => {
  const clock = createClock(500);
  const heartbeats = [];
  const manager = createHeartbeat(clock, heartbeats);
  manager.start('s', 't', {
    phase: 'prompt: reveal this',
    toolKind: 'rm -rf /; secret output',
    prompt: 'must never be emitted',
  });

  clock.advance(10_000);
  assert.equal(manager.updatePhase('s', 't', {
    phase: 'executing',
    safeToolKind: 'bash',
    command: 'print-secret',
    output: 'secret-result',
  }), true);
  clock.advance(5_000);
  assert.equal(manager.touchActivity('s', 't'), true);
  clock.advance(15_000);

  assert.deepEqual(heartbeats, [{
    sessionId: 's',
    turnId: 't',
    elapsedMs: 30_000,
    silentMs: 30_000,
    phase: 'tool',
    toolKind: 'process',
    activityAgeMs: 15_000,
  }]);
  const serialized = JSON.stringify(heartbeats[0]);
  assert.equal(serialized.includes('print-secret'), false);
  assert.equal(serialized.includes('secret-result'), false);
  assert.equal(serialized.includes('reveal this'), false);

  manager.updatePhase('s', 't', 'thinking');
  clock.advance(30_000);
  assert.equal(heartbeats[1].phase, 'thinking');
  assert.equal(heartbeats[1].toolKind, null, 'leaving the tool phase clears stale tool metadata');
});

test('does not emit twice for the same silent period', () => {
  const clock = createClock();
  const heartbeats = [];
  let scheduledCallback;
  const manager = createHeartbeat(clock, heartbeats, {
    setInterval(callback) {
      scheduledCallback = callback;
      return { unref() {} };
    },
    clearInterval() {},
  });
  manager.start('s', 't');
  clock.advance(30_000);
  scheduledCallback();
  scheduledCallback();
  assert.equal(heartbeats.length, 1);
});

test('stop and stopAll clear timers and suppress stale callbacks', () => {
  const clock = createClock();
  const heartbeats = [];
  const manager = createHeartbeat(clock, heartbeats);
  manager.start('s1', 't1');
  manager.start('s2', 't2');
  assert.equal(clock.activeTimers, 2);
  assert.equal(manager.stop('s1', 't1'), true);
  assert.equal(manager.stop('s1', 't1'), false);
  assert.equal(clock.activeTimers, 1);
  clock.advance(30_000);
  assert.deepEqual(heartbeats.map(item => item.sessionId), ['s2']);
  assert.equal(manager.stopAll(), 1);
  assert.equal(manager.stopAll(), 0);
  assert.equal(clock.activeTimers, 0);
  clock.advance(60_000);
  assert.equal(heartbeats.length, 1);
});

test('a newer turn replaces a stale heartbeat for the same session', () => {
  const clock = createClock();
  const heartbeats = [];
  const manager = createHeartbeat(clock, heartbeats);
  manager.start('s1', 'old');
  clock.advance(10_000);
  manager.start('s1', 'new', { phase: 'tool', safeToolKind: 'wait_agent' });
  assert.equal(clock.activeTimers, 1);
  clock.advance(30_000);
  assert.deepEqual(heartbeats.map(item => [item.turnId, item.toolKind]), [['new', 'subagent']]);
});

test('validates required dependencies and injected clock values', () => {
  assert.throws(() => new TurnProgressHeartbeat(), /onHeartbeat is required/);
  assert.throws(() => new TurnProgressHeartbeat({
    onHeartbeat() {}, intervalMs: 0,
  }), /positive finite/);

  const manager = new TurnProgressHeartbeat({
    onHeartbeat() {},
    now: () => NaN,
    setInterval() { return 1; },
    clearInterval() {},
  });
  assert.throws(() => manager.start('s', 't'), /now must return a finite number/);
});
