'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createStalledTurnRecovery,
  STALLED_RECOVERY_CONFIRMATIONS,
} = require('../src/chat/stalled-turn-recovery');

// Isolated tests for the stalled-turn recovery executor. The liveness verdict
// itself is covered by tests/test-liveness-runtime.js and the cancel→E→release
// chain it fires is covered by tests/test-cancel-state-flow.js; here we pin the
// gating/confirmation/cooldown logic that decides WHEN to fire.

function fixture(options = {}) {
  let at = options.at ?? 1_000_000;
  const startedAt = at;
  const silentFor = options.silentFor ?? 400_000; // well past the 180s standard
  const record = {
    id: 's1',
    kind: options.kind ?? 'chat',
    type: options.type ?? 'chat',
    taskState: {
      classifyState: options.classifyState ?? 'P',
      cancelledAt: options.cancelledAt ?? null,
    },
  };
  const cancelCalls = [];
  let assessCalls = 0;
  // Scriptable verdict: options.verdict or options.verdicts (array consumed in order).
  const verdicts = options.verdicts || null;
  const singleVerdict = options.verdict !== undefined
    ? options.verdict
    : { state: 'stalled', reason: 'silent_400s' };
  const recovery = createStalledTurnRecovery({
    listRecords: () => new Map([['s1', record]]).entries(),
    getTaskState: value => value.taskState,
    getChatSession: () => options.chat === null ? null : {
      isStreaming: options.isStreaming ?? true,
      lastStreamAt: startedAt - silentFor, // fixed anchor: silence grows with advance()
    },
    getStreamStatus: () => options.stream || null,
    assessLiveness: async () => {
      assessCalls += 1;
      if (verdicts) return verdicts[Math.min(assessCalls - 1, verdicts.length - 1)];
      return singleVerdict;
    },
    cancelTurn: async (id, cancelOptions) => {
      cancelCalls.push([id, cancelOptions]);
      return { ok: true, code: 'cancelled' };
    },
    getTurnStatus: options.turnStatus === undefined ? null : () => options.turnStatus,
    now: () => at,
    stallSilentMs: options.stallSilentMs ?? 180_000,
    startingGraceMs: options.startingGraceMs,
    confirmations: options.confirmations ?? STALLED_RECOVERY_CONFIRMATIONS,
    cooldownMs: options.cooldownMs ?? 120_000,
    logger: { warn() {} },
  });
  return {
    recovery,
    cancelCalls,
    record,
    advance(ms) { at += ms; },
    assessCallCount: () => assessCalls,
  };
}

test('persistent stalled verdict across consecutive sweeps cancels via the manual-cancel path', async () => {
  const h = fixture();
  let result = await h.recovery.sweep();
  assert.equal(result.results[0].action, 'confirming');
  assert.deepEqual(h.cancelCalls, []);

  h.advance(30_000);
  result = await h.recovery.sweep();
  assert.equal(result.results[0].action, 'cancelled');
  assert.equal(h.cancelCalls.length, 1);
  const [sessionId, cancelOptions] = h.cancelCalls[0];
  assert.equal(sessionId, 's1');
  // Same canonical E transition as user cancel / dead-runner watchdog, with its
  // own attribution so cancelSource can tell recovery from a manual stop.
  assert.equal(cancelOptions.source, 'stalled_recovery');
  assert.equal(cancelOptions.killReason, 'stalled_recovery');
  assert.equal(cancelOptions.reason, 'stalled_silent_400s');
});

test('silence alone never kills: corroborating activity keeps the turn alive', async () => {
  // Silent 400s, but the full assess sees a live outbound connection → working.
  const outbound = fixture({ verdict: { state: 'working', reason: 'outbound_connection' } });
  let result = await outbound.recovery.sweep();
  assert.equal(result.results[0].action, 'watching');
  result = await outbound.recovery.sweep();
  assert.equal(result.results[0].action, 'watching');
  assert.deepEqual(outbound.cancelCalls, []);

  // Silent 400s, but the rollout file is still growing → working.
  const rollout = fixture({ verdict: { state: 'working', reason: 'rollout_growing' } });
  result = await rollout.recovery.sweep();
  assert.equal(result.results[0].action, 'watching');
  assert.deepEqual(rollout.cancelCalls, []);
});

test('an intermittent working verdict resets the confirmation count', async () => {
  const h = fixture({
    verdicts: [
      { state: 'stalled', reason: 'silent_400s' },
      { state: 'working', reason: 'outbound_connection' },
      { state: 'stalled', reason: 'silent_430s' },
    ],
  });
  let result = await h.recovery.sweep();          // count 1
  assert.equal(result.results[0].action, 'confirming');
  h.advance(30_000);
  result = await h.recovery.sweep();               // activity → reset
  assert.equal(result.results[0].action, 'watching');
  h.advance(30_000);
  result = await h.recovery.sweep();               // count 1 again, not 2
  assert.equal(result.results[0].action, 'confirming');
  assert.deepEqual(h.cancelCalls, []);
});

test('below the existing stall threshold the cheap pre-filter skips the probe entirely', async () => {
  const h = fixture({ silentFor: 30_000 }); // 30s < 180s
  const result = await h.recovery.sweep();
  assert.equal(result.results[0].reason, 'below_stall_threshold');
  assert.equal(h.assessCallCount(), 0); // no lsof probe cost
  assert.deepEqual(h.cancelCalls, []);
});

test('non-P, already-cancelled and non-in-flight sessions are never touched', async () => {
  for (const opts of [
    { classifyState: 'W' },
    { classifyState: 'E' },
    { cancelledAt: 123 },
    { isStreaming: false },
    { chat: null },
  ]) {
    const h = fixture(opts);
    const result = await h.recovery.sweep();
    assert.equal(result.results[0].action, 'skip', JSON.stringify(opts));
    assert.equal(h.assessCallCount(), 0, JSON.stringify(opts));
    assert.deepEqual(h.cancelCalls, [], JSON.stringify(opts));
  }
});

test('busy persistent stream counts as in-flight even without cs.isStreaming', async () => {
  const h = fixture({ isStreaming: false, stream: { busy: true } });
  let result = await h.recovery.sweep();
  assert.equal(result.results[0].action, 'confirming');
  h.advance(30_000);
  result = await h.recovery.sweep();
  assert.equal(result.results[0].action, 'cancelled');
  assert.equal(h.cancelCalls.length, 1);
});

test('after firing, a cooldown suppresses refire until it expires', async () => {
  const h = fixture({ cooldownMs: 120_000 });
  await h.recovery.sweep();
  h.advance(30_000);
  await h.recovery.sweep(); // fires
  assert.equal(h.cancelCalls.length, 1);

  h.advance(30_000);
  let result = await h.recovery.sweep();
  assert.equal(result.results[0].reason, 'recovery_cooldown');
  assert.equal(h.cancelCalls.length, 1);

  h.advance(120_001); // cooldown over; a genuinely still-stalled session may recover again
  result = await h.recovery.sweep();
  assert.equal(result.results[0].action, 'confirming');
  h.advance(30_000);
  result = await h.recovery.sweep();
  assert.equal(result.results[0].action, 'cancelled');
  assert.equal(h.cancelCalls.length, 2);
});

test('aux/gateway and non-chat records are ignored', async () => {
  for (const opts of [{ type: 'aux' }, { type: 'gateway' }, { kind: 'task' }]) {
    const h = fixture(opts);
    const result = await h.recovery.sweep();
    assert.deepEqual(result.results, [], JSON.stringify(opts));
    assert.equal(h.assessCallCount(), 0);
  }
});

test('an assess failure skips this sweep without poisoning the suspect count', async () => {
  let assessCalls = 0;
  const cancelCalls = [];
  let at = 1_000_000;
  const recovery = createStalledTurnRecovery({
    listRecords: () => new Map([['s1', {
      id: 's1', kind: 'chat', type: 'chat',
      taskState: { classifyState: 'P', cancelledAt: null },
    }]]).entries(),
    getTaskState: value => value.taskState,
    getChatSession: () => ({ isStreaming: true, lastStreamAt: at - 400_000 }),
    getStreamStatus: () => null,
    assessLiveness: async () => {
      assessCalls += 1;
      if (assessCalls === 1) throw new Error('probe exploded');
      return { state: 'stalled', reason: 'silent_400s' };
    },
    cancelTurn: async (id, opts) => { cancelCalls.push([id, opts]); return { ok: true }; },
    now: () => at,
    logger: { warn() {} },
  });
  let result = await recovery.sweep();
  assert.equal(result.results[0].reason, 'assess_failed');
  assert.deepEqual(cancelCalls, []);
  at += 30_000;
  result = await recovery.sweep();
  assert.equal(result.results[0].action, 'confirming');
  at += 30_000;
  result = await recovery.sweep();
  assert.equal(result.results[0].action, 'cancelled');
  assert.equal(cancelCalls.length, 1);
});

test('the starting phase gets extra grace before recovery may fire', async () => {
  // Silent 250s: past the 180s stall standard but inside starting grace
  // (180s + default 120s). MCP handshake + rollout load + first token all
  // happen in this phase, so a kill here would be a false positive.
  const h = fixture({ silentFor: 250_000, turnStatus: { phase: 'starting' } });
  let result = await h.recovery.sweep();
  assert.equal(result.results[0].action, 'skip');
  assert.equal(result.results[0].reason, 'starting_grace');
  assert.equal(h.assessCallCount(), 0, 'grace skips before the probe');
  assert.deepEqual(h.cancelCalls, []);

  // Past grace the normal multi-signal chain applies.
  h.advance(60_000); // silentFor now 310s > 180s + 120s
  result = await h.recovery.sweep();
  assert.equal(result.results[0].action, 'confirming');
  h.advance(30_000);
  result = await h.recovery.sweep();
  assert.equal(result.results[0].action, 'cancelled');
  assert.equal(h.cancelCalls.length, 1);
});

test('starting grace is configurable and zero disables it', async () => {
  const custom = fixture({
    silentFor: 200_000,
    turnStatus: { phase: 'starting' },
    startingGraceMs: 10_000, // 180s + 10s = 190s < 200s silent
  });
  let result = await custom.recovery.sweep();
  assert.equal(result.results[0].action, 'confirming');

  const zero = fixture({
    silentFor: 200_000,
    turnStatus: { phase: 'starting' },
    startingGraceMs: 0,
  });
  result = await zero.recovery.sweep();
  assert.equal(result.results[0].action, 'confirming');
});

test('non-starting phases keep the original threshold and a throwing status fn is tolerated', async () => {
  for (const phase of ['thinking', 'tool', 'finalizing']) {
    const h = fixture({ silentFor: 250_000, turnStatus: { phase } });
    const result = await h.recovery.sweep();
    assert.equal(result.results[0].action, 'confirming', phase);
  }

  let assessCalls = 0;
  const recovery = createStalledTurnRecovery({
    listRecords: () => new Map([['s1', {
      id: 's1', kind: 'chat', type: 'chat',
      taskState: { classifyState: 'P', cancelledAt: null },
    }]]).entries(),
    getTaskState: value => value.taskState,
    getChatSession: () => ({ isStreaming: true, lastStreamAt: 600_000 }),
    getStreamStatus: () => null,
    assessLiveness: async () => { assessCalls += 1; return { state: 'stalled', reason: 'silent_400s' }; },
    getTurnStatus: () => { throw new Error('heartbeat exploded'); },
    cancelTurn: async () => ({ ok: true }),
    now: () => 1_000_000,
    logger: { warn() {} },
  });
  const result = await recovery.sweep();
  assert.equal(result.results[0].action, 'confirming', 'status failure falls back to base threshold');
  assert.equal(assessCalls, 1);
});

test('without a getTurnStatus dep the recovery behaves exactly as before', async () => {
  const h = fixture({ silentFor: 250_000 }); // no turnStatus → getTurnStatus null
  let result = await h.recovery.sweep();
  assert.equal(result.results[0].action, 'confirming');
  h.advance(30_000);
  result = await h.recovery.sweep();
  assert.equal(result.results[0].action, 'cancelled');
});
