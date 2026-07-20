'use strict';
// Unit tests for src/ws-backpressure.js — focused on the reconnect-replay
// regression: a synchronous burst of many small frames (stream replay of an
// in-progress turn) must NOT trip the message-count overflow guard and close
// the socket with 1013, because that caused an infinite reconnect loop
// (reconnect → replay flood → 1013 → reconnect …) on long streaming turns.
//
// Fully deterministic: a manual send-completion queue and an injected scheduler
// mean no real timers/microtasks are left pending, so the process exits cleanly.

const { installWsBackpressure, DEFAULTS } = require('../src/ws-backpressure');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('✅', name); }
  else { fail++; console.log('❌', name); }
}

// Fake ws with a MANUAL send-completion pump: send() records the frame and a
// pending callback; drainSends() fires them synchronously. bufferedAmount is
// settable to simulate a congested (slow) client whose kernel buffer never
// empties.
function makeFakeWs({ bufferedAmount = 0 } = {}) {
  const pending = [];
  const ws = {
    bufferedAmount,
    sent: [],
    closes: [],
    send(data, options, cb) {
      const callback = typeof options === 'function' ? options : cb;
      ws.sent.push(data);
      if (typeof callback === 'function') pending.push(callback);
    },
    close(code, reason) { ws.closes.push({ code, reason: String(reason || '') }); },
    terminate() { ws.closes.push({ code: 'terminate' }); },
    once() {},
    drainSends() { while (pending.length) pending.shift()(); },
  };
  return ws;
}

// Manual scheduler: stores scheduled flushes; runScheduled() fires them.
function makeSched() {
  const jobs = [];
  return {
    schedule: (fn) => { jobs.push(fn); return { unref() {} }; },
    cancelSchedule: () => {},
    runScheduled() { const n = jobs.length; for (let i = 0; i < n; i++) jobs.shift()(); },
    pending: () => jobs.length,
  };
}

// ── defaults sanity: message cap must exceed the server's streamReplay cap (500) ──
ok(DEFAULTS.maxQueueMessages > 500,
  `default maxQueueMessages (${DEFAULTS.maxQueueMessages}) exceeds streamReplay cap (500)`);

// ── regression: a 500-frame replay burst via sendImmediate must NOT disconnect ──
{
  const ws = makeFakeWs();           // not congested → drains as we pump
  const sched = makeSched();
  const api = installWsBackpressure(ws, { limits: { maxQueueMessages: 256 }, ...sched });
  for (let i = 0; i < 500; i++) {
    api.sendImmediate(JSON.stringify({ type: 'assistant_delta', i, text: 'x'.repeat(40) }));
    ws.drainSends();                 // each send completes immediately (fast client)
  }
  ok(ws.closes.length === 0, 'sendImmediate: 500-frame burst does NOT close the socket (even with tiny msg cap)');
  ok(ws.sent.length === 500, 'sendImmediate: all 500 frames sent');
}

// ── contrast: the bounded live path (ws.send) still enforces the message cap ──
{
  const ws = makeFakeWs({ bufferedAmount: 2_000_000 }); // congested: never drains
  const sched = makeSched();
  installWsBackpressure(ws, { limits: { maxQueueMessages: 10, maxQueueBytes: 10_000_000, highWaterBytes: 1_000_000 }, ...sched });
  for (let i = 0; i < 40; i++) ws.send(JSON.stringify({ type: 'live', i }));
  ok(ws.closes.some(c => c.code === 1013), 'bounded ws.send: still disconnects (1013) when a slow client overflows the message cap');
}

// ── byte cap still applies to sendImmediate (memory guard is not bypassed) ──
{
  const ws = makeFakeWs({ bufferedAmount: 2_000_000 }); // congested: never drains
  const sched = makeSched();
  const api = installWsBackpressure(ws, { limits: { maxQueueBytes: 5000, maxQueueMessages: 100000, highWaterBytes: 1_000_000 }, ...sched });
  for (let i = 0; i < 20; i++) api.sendImmediate(JSON.stringify({ type: 'big', pad: 'y'.repeat(1000) }));
  ok(ws.closes.some(c => c.code === 1013), 'sendImmediate: byte cap still enforced (memory guard not bypassed)');
}

// ── congestion timer still fires for a truly slow client on the replay path ──
// Clock starts at a realistic epoch value (not 0): the production `now` is
// Date.now(), and the impl uses `if (!congestedAt) congestedAt = now()` — a
// clock of exactly 0 would be indistinguishable from "not congested", so we
// start at a nonzero base to mirror real runtime.
{
  let clock = 1_000_000;
  const ws = makeFakeWs({ bufferedAmount: 2_000_000 }); // permanently above highWater
  const sched = makeSched();
  const api = installWsBackpressure(ws, {
    limits: { highWaterBytes: 1_000_000, maxCongestionMs: 15_000, maxQueueBytes: 10_000_000, maxQueueMessages: 100000 },
    now: () => clock,
    ...sched,
  });
  api.sendImmediate(JSON.stringify({ type: 'delta', text: 'hi' })); // flush → high water → congestedAt=clock, schedules retry
  clock += 20_000;                                                   // past the 15s window
  sched.runScheduled();                                             // re-run flush → disconnect
  ok(ws.closes.some(c => c.code === 1013), 'congestion timer still disconnects a genuinely stuck client on replay path');
}

console.log(`\n== ws-backpressure unit: ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
