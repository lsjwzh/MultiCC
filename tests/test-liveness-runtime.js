'use strict';

// Unit tests for the session liveness runtime (src/liveness/runtime.js). All
// signal sources are faked so every branch of the working/idle/stalled verdict
// is pinned deterministically, including the proxy-activity ledger fed from
// cli-provider-router onActivity and the optional process probe.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLivenessRuntime } = require('../src/liveness/runtime');

// A controllable clock so age/silent math is exact.
function clockFrom(start) {
  let t = start;
  const now = () => t;
  now.advance = ms => { t += ms; return t; };
  now.set = v => { t = v; return t; };
  return now;
}

function make({ now, sessions = {}, chat = {}, streamStatus = {}, probeSession, thresholds } = {}) {
  const records = new Map(Object.entries(sessions).map(([id, r]) => [id, { id, ...r }]));
  const chatSessions = new Map(Object.entries(chat));
  return createLivenessRuntime({
    now,
    records,
    chatSessions,
    chatStreamStatus: id => streamStatus[id] || null,
    probeSession,
    thresholds,
  });
}

test('unknown session yields state=unknown', () => {
  const rt = make({ now: clockFrom(1000), sessions: {} });
  assert.deepEqual(rt.verdict('nope'), { state: 'unknown', reason: 'no_such_session' });
});

test('fresh proxy request/first_byte activity => working (most authoritative)', () => {
  const now = clockFrom(100_000);
  const rt = make({ now, sessions: { s1: {} } });
  rt.recordProxyActivity({ sessionId: 's1', phase: 'request', at: now(), role: 'main', providerId: 'p1' });
  let v = rt.verdict('s1');
  assert.equal(v.state, 'working');
  assert.equal(v.reason, 'proxy_request');

  now.advance(500);
  rt.recordProxyActivity({ sessionId: 's1', phase: 'first_byte', at: now() });
  v = rt.verdict('s1');
  assert.equal(v.state, 'working');
  assert.equal(v.reason, 'proxy_first_byte');
});

test('proxy end event does not count as active, but leaves recent-activity for idle', () => {
  const now = clockFrom(100_000);
  const rt = make({ now, sessions: { s1: {} } });
  rt.recordProxyActivity({ sessionId: 's1', phase: 'end', at: now(), role: 'main' });
  const v = rt.verdict('s1');
  assert.equal(v.state, 'idle');
  assert.equal(v.reason, 'recent_activity');
});

test('stale proxy activity (older than proxyActiveMs) no longer means working', () => {
  const now = clockFrom(100_000);
  const rt = make({ now, sessions: { s1: {} }, thresholds: { proxyActiveMs: 90_000 } });
  rt.recordProxyActivity({ sessionId: 's1', phase: 'request', at: now() });
  now.advance(120_000); // past proxyActiveMs
  const v = rt.verdict('s1');
  assert.notEqual(v.state, 'working');
  assert.equal(v.state, 'idle');
});

test('in-flight streaming turn => working with the current phase as reason', () => {
  const now = clockFrom(50_000);
  const rt = make({
    now,
    sessions: { s1: {} },
    chat: { s1: { isStreaming: true, lastStreamAt: now(), currentTask: { phase: 'implementing' } } },
  });
  const v = rt.verdict('s1');
  assert.equal(v.state, 'working');
  assert.equal(v.reason, 'turn_implementing');
});

test('busy chatStream (no cs.isStreaming) still counts as in-flight working', () => {
  const now = clockFrom(50_000);
  const rt = make({
    now,
    sessions: { s1: {} },
    chat: { s1: {} },
    streamStatus: { s1: { busy: true, pid: 4242 } },
  });
  const v = rt.verdict('s1');
  assert.equal(v.state, 'working');
  assert.equal(v.reason, 'in_flight');
  assert.equal(v.pid, 4242);
});

test('in-flight but silent past stallSilentMs with no outbound => stalled', () => {
  const now = clockFrom(0);
  const rt = make({
    now,
    sessions: { s1: {} },
    chat: { s1: { isStreaming: true, heartbeatSilentMs: 200_000 } },
    thresholds: { stallSilentMs: 180_000 },
  });
  const v = rt.verdict('s1', { hasOutboundConnection: false, rolloutGrowing: false });
  assert.equal(v.state, 'stalled');
  assert.match(v.reason, /^silent_\d+s$/);
});

test('in-flight and silent BUT an outbound connection exists => still working, not stalled', () => {
  const now = clockFrom(0);
  const rt = make({
    now,
    sessions: { s1: {} },
    chat: { s1: { isStreaming: true, heartbeatSilentMs: 300_000 } },
    thresholds: { stallSilentMs: 180_000 },
  });
  const v = rt.verdict('s1', { hasOutboundConnection: true });
  assert.equal(v.state, 'working');
  assert.equal(v.reason, 'outbound_connection');
});

test('direct (non-proxy) session with only a live outbound connection => working', () => {
  const now = clockFrom(10_000);
  const rt = make({ now, sessions: { s1: {} }, chat: { s1: {} } });
  const v = rt.verdict('s1', { hasOutboundConnection: true });
  assert.equal(v.state, 'working');
  assert.equal(v.reason, 'outbound_connection');
});

test('rollout growth alone (no turn, no outbound) => working', () => {
  const now = clockFrom(10_000);
  const rt = make({ now, sessions: { s1: {} }, chat: { s1: {} } });
  const v = rt.verdict('s1', { rolloutGrowing: true });
  assert.equal(v.state, 'working');
  assert.equal(v.reason, 'rollout_growing');
});

test('quiet session with no recent activity => idle/no_recent_activity', () => {
  const now = clockFrom(10 * 60_000 + 500_000);
  const rt = make({
    now,
    sessions: { s1: {} },
    chat: { s1: { isStreaming: false, lastStreamAt: 1000 } }, // long ago
  });
  const v = rt.verdict('s1');
  assert.equal(v.state, 'idle');
  assert.equal(v.reason, 'no_recent_activity');
});

test('assess() awaits the injected process probe when opted in', async () => {
  const now = clockFrom(0);
  const calls = [];
  const rt = make({
    now,
    sessions: { s1: {} },
    chat: { s1: { isStreaming: true, heartbeatSilentMs: 999_999 } },
    thresholds: { stallSilentMs: 180_000 },
    probeSession: async (id) => { calls.push(id); return { hasOutboundConnection: true }; },
  });
  const v = await rt.assess('s1');
  assert.deepEqual(calls, ['s1']);
  assert.equal(v.state, 'working'); // probe rescued it from stalled
});

test('a throwing probe is swallowed and assessment still returns', async () => {
  const now = clockFrom(0);
  const rt = make({
    now,
    sessions: { s1: {} },
    chat: { s1: { isStreaming: true, heartbeatSilentMs: 999_999 } },
    thresholds: { stallSilentMs: 180_000 },
    probeSession: async () => { throw new Error('lsof exploded'); },
  });
  const v = await rt.assess('s1');
  assert.equal(v.state, 'stalled'); // no probe corroboration => stalled stands
});

test('recordProxyActivity ignores malformed events and unknown phases', () => {
  const now = clockFrom(1000);
  const rt = make({ now, sessions: { s1: {} } });
  rt.recordProxyActivity(null);
  rt.recordProxyActivity({ phase: 'request' });          // no sessionId
  rt.recordProxyActivity({ sessionId: 's1', phase: 'bogus' });
  assert.equal(rt.signals('s1').proxyPhase, null);
});

test('forget() clears a session ledger entry', () => {
  const now = clockFrom(1000);
  const rt = make({ now, sessions: { s1: {} } });
  rt.recordProxyActivity({ sessionId: 's1', phase: 'request', at: now() });
  assert.equal(rt.verdict('s1').state, 'working');
  rt.forget('s1');
  assert.notEqual(rt.verdict('s1').state, 'working');
});

test('createLivenessRuntime validates its deps', () => {
  assert.throws(() => createLivenessRuntime({}), /records must be/);
  assert.throws(() => createLivenessRuntime({ records: new Map() }), /chatSessions must be/);
});
