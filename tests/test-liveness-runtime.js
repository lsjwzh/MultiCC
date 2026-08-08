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

function make({ now, sessions = {}, chat = {}, streamStatus = {}, probeSession, thresholds, turnHeartbeatStatus } = {}) {
  const records = new Map(Object.entries(sessions).map(([id, r]) => [id, { id, ...r }]));
  const chatSessions = new Map(Object.entries(chat));
  return createLivenessRuntime({
    now,
    records,
    chatSessions,
    chatStreamStatus: id => streamStatus[id] || null,
    probeSession,
    thresholds,
    turnHeartbeatStatus,
  });
}

test('unknown session yields state=unknown', () => {
  const rt = make({ now: clockFrom(1000), sessions: {} });
  assert.deepEqual(rt.verdict('nope'), { state: 'unknown', reason: 'no_such_session' });
  assert.deepEqual(rt.ownership('nope'), { state: 'unknown', reason: 'no_such_session' });
});

test('classify ownership uses structured runner facts and fails closed on contradictions', () => {
  const now = clockFrom(1000);
  const liveChild = { killed: false, exitCode: null, signalCode: null };
  const exitedChild = { killed: false, exitCode: 0, signalCode: null };
  const rt = make({
    now,
    sessions: {
      openLive: { cli: 'opencode' },
      openDead: { cli: 'opencode' },
      openGap: { cli: 'opencode' },
      claudeBusy: { cli: 'claude' },
      claudeIdle: { cli: 'claude' },
    },
    chat: {
      openLive: { cli: 'opencode', isStreaming: false, claudeProc: liveChild },
      openDead: { cli: 'opencode', isStreaming: true, claudeProc: exitedChild },
      openGap: { cli: 'opencode', isStreaming: true, claudeProc: null },
      claudeBusy: { cli: 'claude', isStreaming: true },
      claudeIdle: { cli: 'claude', isStreaming: true },
    },
    streamStatus: {
      claudeBusy: { busy: true, alive: true },
      claudeIdle: { busy: false, alive: true },
    },
  });
  assert.equal(rt.ownership('openLive').state, 'active');
  assert.equal(rt.ownership('openDead').state, 'inactive');
  assert.equal(rt.ownership('openGap').state, 'unknown');
  assert.equal(rt.ownership('claudeBusy').state, 'active');
  assert.equal(rt.ownership('claudeIdle').state, 'inactive');
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

test('live heartbeat phase overrides the stale classify goal phase (starting vs turn_done)', () => {
  // Reproduces the codex starting-stall incident: cs.currentTask.phase still
  // held the PREVIOUS turn's "done" while the turn-progress heartbeat was in
  // "starting", so liveness said reason=turn_done while heartbeats said
  // phase=starting. signals/verdict must now report the heartbeat's phase.
  const now = clockFrom(500_000);
  const rt = make({
    now,
    sessions: { s1: {} },
    chat: {
      s1: {
        isStreaming: true,
        lastStreamAt: now() - 20_000,
        currentTask: { phase: 'done' }, // stale classify goal phase
      },
    },
    turnHeartbeatStatus: () => ({
      sessionId: 's1', turnId: 't1', phase: 'starting',
      safeToolKind: null, startedAt: now() - 25_000, silentMs: 20_000,
    }),
  });
  const s = rt.signals('s1');
  assert.equal(s.phase, 'starting');
  assert.equal(s.heartbeatSilentMs, 20_000, 'silence comes from the live heartbeat');
  const v = rt.verdict('s1');
  assert.equal(v.state, 'working');
  assert.equal(v.reason, 'turn_starting', 'reason must not contradict the heartbeat');
});

test('heartbeat silence feeds the stalled verdict when past threshold', () => {
  const now = clockFrom(1_000_000);
  const rt = make({
    now,
    sessions: { s1: {} },
    chat: { s1: { isStreaming: true, lastStreamAt: now() - 300_000 } },
    thresholds: { stallSilentMs: 180_000 },
    turnHeartbeatStatus: () => ({
      sessionId: 's1', turnId: 't1', phase: 'starting',
      safeToolKind: null, startedAt: now() - 310_000, silentMs: 300_000,
    }),
  });
  const v = rt.verdict('s1', { hasOutboundConnection: false, rolloutGrowing: false });
  assert.equal(v.state, 'stalled');
  assert.equal(v.reason, 'silent_300s');
  assert.equal(v.phase, 'starting');
});

test('a throwing or null heartbeat status falls back to prior behavior', () => {
  const now = clockFrom(500_000);
  const throwing = make({
    now,
    sessions: { s1: {} },
    chat: { s1: { isStreaming: true, lastStreamAt: now(), currentTask: { phase: 'implementing' } } },
    turnHeartbeatStatus: () => { throw new Error('heartbeat exploded'); },
  });
  let v = throwing.verdict('s1');
  assert.equal(v.reason, 'turn_implementing', 'falls back to currentTask.phase');

  const absent = make({
    now,
    sessions: { s1: {} },
    chat: { s1: { isStreaming: true, lastStreamAt: now() - 10_000 } },
    turnHeartbeatStatus: () => null, // heartbeat has no active turn entry
  });
  v = absent.verdict('s1');
  assert.equal(v.state, 'working');
  assert.equal(v.reason, 'in_flight');
  assert.equal(v.heartbeatSilentMs, 10_000, 'falls back to lastStreamAt-derived silence');
});

test('explicit cs.heartbeatSilentMs still wins over the live heartbeat', () => {
  const now = clockFrom(1_000_000);
  const rt = make({
    now,
    sessions: { s1: {} },
    chat: { s1: { isStreaming: true, heartbeatSilentMs: 7_000, lastStreamAt: now() - 90_000 } },
    thresholds: { stallSilentMs: 180_000 },
    turnHeartbeatStatus: () => ({
      sessionId: 's1', turnId: 't1', phase: 'thinking',
      safeToolKind: null, startedAt: now() - 100_000, silentMs: 90_000,
    }),
  });
  const v = rt.verdict('s1');
  assert.equal(v.state, 'working', 'host-provided 7s silence is authoritative');
  assert.equal(v.reason, 'turn_thinking');
});
