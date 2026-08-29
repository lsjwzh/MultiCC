'use strict';

// L0 regression (M3, docs/chat-page-architecture-review.md 五节): admitChatWork
// returning { ok:false, code:'scheduler_not_ready' } was completely ignored by
// callers - the WS handler dropped the value, so the user's message vanished
// with zero feedback: no turn, no error, nothing. The other admission failures
// (auth gates, 消息入队失败) already broadcast their own error frames from
// session-work-host; scheduler_not_ready is the silent one, so this boundary
// emits the error frame itself.
//
// Drives the REAL turn-engine factory with a minimal dep set (only the ports
// touched by admitChatWork plus the construction-time port assertions).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatTurnEngine, deliverAfterPendingMemory } = require('../src/chat/turn-engine');

const noop = () => {};

function makeEngine({ hostAdmit } = {}) {
  const broadcasts = [];
  const warns = [];
  const engine = createChatTurnEngine({
    getExperimentalTuiChatRuntime: () => null,
    persistedSessions: new Map([['s1', { id: 'x', kind: 'chat', cli: 'codex' }]]),
    chatSessions: new Map(),
    getSessionWorkHost: () => ({ admit: hostAdmit }),
    logger: { warn: (...args) => warns.push(args), info: noop, error: noop },
    chatBroadcast: (id, payload) => broadcasts.push({ id, payload }),
    // Construction-time port assertions only; never reached by these tests.
    cancelClassify: noop, emitTurnOutcome: noop, classifyTurnEnd: noop,
  });
  return { engine, broadcasts, warns };
}

test('admitChatWork with no work host emits an error frame and returns scheduler_not_ready', async () => {
  const broadcasts = [];
  const engine = createChatTurnEngine({
    getExperimentalTuiChatRuntime: () => null,
    persistedSessions: new Map([['s1', { id: 'x', kind: 'chat', cli: 'codex' }]]),
    chatSessions: new Map(),
    getSessionWorkHost: () => null,
    logger: { warn: noop, info: noop, error: noop },
    chatBroadcast: (id, payload) => broadcasts.push({ id, payload }),
    cancelClassify: noop, emitTurnOutcome: noop, classifyTurnEnd: noop,
  });
  const result = await engine.admitChatWork('s1', 'hello', {});
  assert.deepEqual(result, { ok: false, code: 'scheduler_not_ready' });
  const errorFrames = broadcasts.filter(b => b.payload.type === 'error');
  assert.equal(errorFrames.length, 1, 'exactly one error frame reaches the frontend');
  assert.equal(errorFrames[0].id, 's1');
  assert.equal(errorFrames[0].payload.code, 'scheduler_not_ready');
  assert.ok(errorFrames[0].payload.error, 'the frame carries a human-readable message');
});

test('admitChatWork surfaces the work host\'s own silent scheduler_not_ready', async () => {
  // session-work-host returns this shape when its scheduler runtime is not
  // wired - equally silent, so the engine boundary must cover it too.
  const { engine, broadcasts } = makeEngine({
    hostAdmit: async () => ({ ok: false, code: 'scheduler_not_ready' }),
  });
  const result = await engine.admitChatWork('s1', 'hello', {});
  assert.equal(result.code, 'scheduler_not_ready');
  assert.equal(broadcasts.filter(b => b.payload.type === 'error').length, 1,
    'the host-internal not-ready path also reaches the frontend');
});

test('admitChatWork stays silent for admissions the host already reported', async () => {
  // 消息入队失败 / auth-gate failures broadcast their own error frame from
  // session-work-host; a second generic frame here would double the user-facing
  // error. Only scheduler_not_ready is this boundary's responsibility.
  const { engine, broadcasts } = makeEngine({
    hostAdmit: async () => ({ ok: false, code: 'configuration_required' }),
  });
  const result = await engine.admitChatWork('s1', 'hello', {});
  assert.equal(result.code, 'configuration_required');
  assert.equal(broadcasts.filter(b => b.payload.type === 'error').length, 0,
    'no duplicate error frame for self-reporting admission failures');
});

test('admitChatWork passes a successful admission through untouched', async () => {
  const { engine, broadcasts } = makeEngine({
    hostAdmit: async () => ({ ok: true, entryId: 'e-1' }),
  });
  const result = await engine.admitChatWork('s1', 'hello', {});
  assert.deepEqual(result, { ok: true, entryId: 'e-1' });
  assert.equal(broadcasts.length, 0, 'no error frame on the happy path');
});

test('pending memory reports progress before delivery and then delivers exactly once', async () => {
  let resolveMemory;
  const pendingMemory = new Promise(resolve => { resolveMemory = resolve; });
  const progress = [];
  let deliveries = 0;
  const resultPromise = deliverAfterPendingMemory(
    pendingMemory,
    event => progress.push(event),
    async () => { deliveries += 1; return { ok: true }; },
  );

  await Promise.resolve();
  assert.deepEqual(progress, [{ state: 'waiting', reason: 'memory_distill_pending' }]);
  assert.equal(deliveries, 0, 'delivery waits until memory distillation settles');
  resolveMemory({ updated: true });
  assert.deepEqual(await resultPromise, { ok: true });
  assert.deepEqual(progress, [
    { state: 'waiting', reason: 'memory_distill_pending' },
    { state: 'ready' },
  ]);
  assert.equal(deliveries, 1);
});

test('failed or skipped memory distillation remains visible and never eats the message', async t => {
  const cases = [
    { name: 'resolved error', pending: Promise.resolve({ updated: false, error: '502' }), reason: 'memory_distill_failed' },
    { name: 'rejected promise', pending: Promise.reject(new Error('offline')), reason: 'memory_distill_failed' },
    { name: 'explicit skip', pending: Promise.resolve({ updated: false, skipped: 'aux unhealthy' }), reason: 'memory_distill_skipped' },
  ];
  for (const current of cases) {
    await t.test(current.name, async () => {
      const progress = [];
      let deliveries = 0;
      await deliverAfterPendingMemory(current.pending, event => progress.push(event), async () => { deliveries += 1; });
      assert.equal(deliveries, 1);
      assert.deepEqual(progress.at(-1), {
        state: 'skipped',
        reason: current.reason,
        ...(current.name === 'resolved error' ? { rootCause: '502' } : {}),
        ...(current.name === 'rejected promise' ? { rootCause: 'offline' } : {}),
      });
    });
  }
});

test('delivery failure replaces loading with a terminal admission state', async () => {
  const progress = [];
  await assert.rejects(
    deliverAfterPendingMemory(
      Promise.resolve({ updated: true }),
      event => progress.push(event),
      async () => { throw new Error('scheduler unavailable'); },
    ),
    /scheduler unavailable/,
  );
  assert.deepEqual(progress.at(-1), {
    state: 'failed',
    reason: 'message_delivery_failed',
    rootCause: 'scheduler unavailable',
  });
});

test('a rejected admission result also replaces loading with a terminal state', async () => {
  const progress = [];
  const result = await deliverAfterPendingMemory(
    Promise.resolve({ updated: true }),
    event => progress.push(event),
    async () => ({ ok: false, code: 'session_not_found' }),
  );
  assert.deepEqual(result, { ok: false, code: 'session_not_found' });
  assert.deepEqual(progress.at(-1), {
    state: 'failed', reason: 'message_delivery_rejected', code: 'session_not_found',
  });
});
