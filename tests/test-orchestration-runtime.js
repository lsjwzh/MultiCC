'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createOrchestrationRuntime } = require('../src/orchestration-runtime');

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-orchestration-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'orchestration.json');
  const clock = overrides.clock || { value: 10_000 };
  const history = overrides.history || new Map();
  const injections = overrides.injections || [];
  let scheduled = null;
  const runChatTurn = overrides.runChatTurn || (async (sessionId, text, opts) => {
    injections.push({ sessionId, text, opts });
    const ids = history.get(sessionId) || new Set();
    ids.add(opts.deliveryId);
    history.set(sessionId, ids);
    return true;
  });
  const runtime = createOrchestrationRuntime({
    file,
    now: () => clock.value,
    runChatTurn,
    isBusy: overrides.isBusy || (() => false),
    hasPersistedDelivery: async (sessionId, deliveryId) => (
      history.get(sessionId)?.has(deliveryId) || false
    ),
    probe: overrides.probe || (async () => ''),
    getSessionRecoveryState: overrides.getSessionRecoveryState || (() => null),
    setIntervalFn(fn) {
      scheduled = fn;
      return { unref() {} };
    },
    clearIntervalFn() { scheduled = null; },
    outboxOptions: {
      leaseMs: 100,
      maxAttempts: 4,
      backoff: () => 0,
      ...(overrides.outboxOptions || {}),
    },
    waitOptions: overrides.waitOptions || {},
  });
  return { dir, file, clock, history, injections, runtime, scheduled: () => scheduled };
}

test('callback resolution is durable, private and payload-idempotent', async t => {
  const { file, runtime, injections } = fixture(t);
  await runtime.start();
  const registered = await runtime.register({ session: 'A', mode: 'callback' });
  assert.equal(registered.status, 'pending');
  assert.equal(runtime.hasPending('A'), true);
  assert.equal(fs.readFileSync(file, 'utf8').includes(registered.token), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const first = await runtime.resolveCallback(registered.id, registered.token, { b: 2, a: 1 });
  const duplicate = await runtime.resolveCallback(registered.id, registered.token, { a: 1, b: 2 });
  const conflict = await runtime.resolveCallback(registered.id, registered.token, { a: 9, b: 2 });
  assert.equal(first.ok, true);
  assert.equal(first.idempotent, false);
  assert.equal(first.status, 'resolved');
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.idempotent, true);
  assert.equal(conflict.code, 'payload_conflict');
  assert.equal(conflict.statusCode, 409);
  assert.equal(runtime.hasPending('A'), false);

  await runtime.tick();
  assert.equal(injections.length, 1);
  assert.equal(injections[0].opts.deliveryId, `wait:${registered.id}`);
  assert.equal(injections[0].opts.clientMsgId, `wait:${registered.id}`);
  assert.match(injections[0].text, /^\[等待的数据已返回\]\n/);
  assert.equal((await runtime.outbox.get(`wait:${registered.id}`)).state, 'delivered');
  await runtime.stop();
});

test('runtime wires canonical pending input into option and free-text answer admission', async t => {
  for (const [suffix, text] of [
    ['option', '生产环境'],
    ['free-text', '请改成下周一发布'],
  ]) {
    const requestId = `usrq-${suffix}`;
    const taskId = `task-${suffix}`;
    const { runtime, injections } = fixture(t, {
      getSessionRecoveryState: () => ({
        // Deliberately stale scheduler/classify projection: the unresolved
        // request is the correlation proof that must keep the answer viable.
        classifyState: 'D',
        pendingUserInput: { requestId, taskId, resolved: false },
      }),
    });
    const admitted = await runtime.sessionScheduler.admit({
      sessionId: `session-${suffix}`,
      text,
      workKind: 'answer',
      requestId,
      idempotencyKey: `answer-${suffix}`,
    });
    assert.equal(admitted.ok, true, suffix);
    await runtime.tick();
    assert.equal(injections.length, 1, suffix);
    assert.equal(injections[0].text, text, suffix);
    assert.equal(injections[0].opts.userInputRequestId, requestId, suffix);
    assert.equal(injections[0].opts.taskId, taskId, suffix);
    await runtime.stop();
  }
});

test('reconstruction closes resolve-to-inject crash and inject-to-ack crash windows', async t => {
  const sharedHistory = new Map();
  const clock = { value: 20_000 };
  const first = fixture(t, { clock, history: sharedHistory });
  const registered = await first.runtime.register({ session: 'A', mode: 'callback' });
  await first.runtime.resolveCallback(registered.id, registered.token, 'ready');

  // Simulate a process dying after runChatTurn durably wrote the user message,
  // but before the worker acknowledged its claim.
  const [lostClaim] = await first.runtime.outbox.claim({
    workerId: 'crashed-process',
    selectSessionItem: first.runtime.sessionScheduler.selectSessionItem,
  });
  assert.equal(lostClaim.id, `wait:${registered.id}`);
  assert.equal((await first.runtime.sessionScheduler.claim(lostClaim)).ok, true);
  sharedHistory.set('A', new Set([lostClaim.id]));

  clock.value += 101;
  const replayedInjections = [];
  const rebuilt = createOrchestrationRuntime({
    file: first.file,
    now: () => clock.value,
    runChatTurn: async (...args) => { replayedInjections.push(args); return true; },
    hasPersistedDelivery: async (sessionId, deliveryId) => sharedHistory.get(sessionId)?.has(deliveryId) || false,
    getSessionRecoveryState: () => ({ classifyState: 'D', endedAt: 20_050 }),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    outboxOptions: { leaseMs: 100, maxAttempts: 4, backoff: () => 0 },
  });
  await rebuilt.start();
  assert.equal(replayedInjections.length, 0, 'persisted delivery is not injected twice');
  assert.equal((await rebuilt.outbox.get(lostClaim.id)).state, 'delivered');
  assert.equal(rebuilt.hasPending('A'), false);
  assert.equal((await rebuilt.sessionScheduler.status('A')).state, 'idle');
  await rebuilt.stop();
});

test('dispatch delivery carries canonical task metadata into runChatTurn', async t => {
  const { runtime, injections } = fixture(t);
  await runtime.admitDispatch({
    ownerSessionId: 'commander',
    resultSessionId: 'commander',
    idempotencyKey: 'task-delivery-1',
    spec: {
      targetId: 'worker',
      chatId: 'worker',
      message: '【任务：新任务】\n执行正文',
      oneWay: true,
      taskId: 'tsk-delivery',
      taskStart: true,
      taskSource: 'commander',
      taskText: '执行正文',
    },
  });
  await runtime.tick();
  assert.equal(injections.length, 1);
  assert.deepEqual(
    {
      taskId: injections[0].opts.taskId,
      taskStart: injections[0].opts.taskStart,
      taskSource: injections[0].opts.taskSource,
      taskText: injections[0].opts.taskText,
    },
    {
      taskId: 'tsk-delivery',
      taskStart: true,
      taskSource: 'commander',
      taskText: '执行正文',
    },
  );
  await runtime.stop();
});

test('busy and rejected delivery defer transport without changing the classify gate', async t => {
  let busy = true;
  let accept = false;
  const calls = [];
  const history = new Map();
  const { runtime } = fixture(t, {
    history,
    isBusy: () => busy,
    runChatTurn: async (sessionId, text, opts) => {
      calls.push({ sessionId, text, opts });
      if (!accept) return false;
      history.set(sessionId, new Set([opts.deliveryId]));
      return true;
    },
  });
  const registered = await runtime.register({ session: 'A', mode: 'callback' });
  await runtime.resolveCallback(registered.id, registered.token, 'result');

  await runtime.tick();
  assert.equal(calls.length, 0);
  assert.equal((await runtime.outbox.get(`wait:${registered.id}`)).state, 'pending');
  assert.equal((await runtime.outbox.get(`wait:${registered.id}`)).attempts, 0,
    'expected busy contention must not consume the durable retry budget');

  busy = false;
  await runtime.tick();
  assert.equal(calls.length, 1);
  assert.equal((await runtime.outbox.get(`wait:${registered.id}`)).state, 'pending');
  const afterReject = await runtime.sessionScheduler.status('A');
  assert.equal(afterReject.state, 'idle');
  assert.equal(afterReject.active, null);

  accept = true;
  await runtime.tick();
  assert.equal(calls.length, 2);
  assert.match(calls[1].text, /^\[等待的数据已返回\]/);
  assert.equal((await runtime.outbox.get(`wait:${registered.id}`)).state, 'delivered');
});

test('direct messages and dispatch requests share one success-gated FIFO', async t => {
  const { runtime, injections } = fixture(t);
  const first = await runtime.admitSessionWork({
    sessionId: 'worker',
    text: 'direct one',
    options: { clientMsgId: 'browser-direct-1' },
    idempotencyKey: 'direct-1',
  });
  assert.equal(first.ok, true);
  assert.deepEqual(injections.map(entry => entry.text), ['direct one']);
  assert.equal(injections[0].opts.clientMsgId, 'browser-direct-1',
    'the committed message must reconcile the browser optimistic bubble');
  assert.equal(injections[0].opts.directUserInput, true,
    'typed input must remain distinguishable from automatic continuations');
  assert.match(injections[0].opts.deliveryId, /^session-work:/,
    'durable delivery identity remains owned by the scheduler');

  await runtime.admitSessionWork({
    sessionId: 'worker',
    text: 'direct two',
    idempotencyKey: 'direct-2',
  });
  await runtime.admitDispatch({
    ownerSessionId: 'commander',
    resultSessionId: 'commander',
    idempotencyKey: 'dispatch-3',
    spec: {
      targetId: 'worker',
      chatId: 'worker',
      message: 'dispatch three',
      oneWay: true,
      taskId: 'task-three',
      taskStart: true,
      taskSource: 'commander',
      taskText: 'dispatch three',
    },
  });
  await runtime.tick();
  assert.deepEqual(injections.map(entry => entry.text), ['direct one']);

  await runtime.sessionScheduler.complete('worker');
  await runtime.tick();
  assert.deepEqual(injections.map(entry => entry.text), ['direct one', 'direct two']);
  assert.equal(injections[1].opts.clientMsgId, injections[1].opts.deliveryId,
    'legacy/session work without a browser correlation key keeps the durable fallback');
  await runtime.sessionScheduler.complete('worker');
  await runtime.tick();
  assert.deepEqual(injections.map(entry => entry.text), [
    'direct one', 'direct two', 'dispatch three',
  ]);
});

test('different sessions deliver concurrently while one session remains ordered', async t => {
  const history = new Map();
  const started = [];
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const { runtime } = fixture(t, {
    history,
    runChatTurn: async (sessionId, text, opts) => {
      started.push(sessionId);
      if (started.length === 2) release();
      await barrier;
      const ids = history.get(sessionId) || new Set();
      ids.add(opts.deliveryId);
      history.set(sessionId, ids);
      return true;
    },
  });
  const a = await runtime.register({ session: 'A', mode: 'callback' });
  const b = await runtime.register({ session: 'B', mode: 'callback' });
  await runtime.resolveCallback(a.id, a.token, 'A1');
  await runtime.resolveCallback(b.id, b.token, 'B1');
  await runtime.tick();
  assert.deepEqual(new Set(started), new Set(['A', 'B']));
  assert.equal((await runtime.outbox.get(`wait:${a.id}`)).state, 'delivered');
  assert.equal((await runtime.outbox.get(`wait:${b.id}`)).state, 'delivered');
});

test('durable poll resolution and timeout use the outbox delivery path', async t => {
  const clock = { value: 30_000 };
  let probeOutput = 'not yet';
  const { runtime, injections } = fixture(t, {
    clock,
    probe: async () => probeOutput,
  });
  const matched = await runtime.register({
    session: 'P', mode: 'poll', pollCmd: 'status', untilContains: 'DONE', intervalSec: 3, maxChecks: 2,
  });
  clock.value += 3000;
  await runtime.tick();
  assert.equal(runtime.hasPending('P'), true);
  probeOutput = 'DONE: 42';
  clock.value += 3000;
  await runtime.tick();
  assert.equal(runtime.hasPending('P'), false);
  assert.equal(injections.length, 1);
  assert.match(injections[0].text, /DONE: 42/);
  assert.equal((await runtime.outbox.get(`wait:${matched.id}`)).state, 'delivered');

  const timed = await runtime.register({
    session: 'T', mode: 'poll', pollCmd: 'status', untilContains: 'NEVER', intervalSec: 3, maxChecks: 1,
  });
  probeOutput = 'still waiting';
  clock.value += 3000;
  await runtime.tick();
  assert.equal(runtime.hasPending('T'), false);
  assert.match(injections[1].text, /^\[轮询超时\]/);
  assert.equal((await runtime.outbox.get(`wait:${timed.id}`)).state, 'delivered');
});

test('startup recovers an expired lease and stop clears the worker timer', async t => {
  const { runtime, clock, scheduled } = fixture(t, {
    getSessionRecoveryState: () => ({ classifyState: 'D' }),
  });
  const registered = await runtime.register({ session: 'A', mode: 'callback' });
  await runtime.resolveCallback(registered.id, registered.token, 'ready');
  const [claim] = await runtime.outbox.claim({ workerId: 'lost' });
  clock.value += 101;
  await runtime.start();
  assert.equal((await runtime.outbox.get(claim.id)).state, 'delivered');
  assert.equal(typeof scheduled(), 'function');
  await runtime.stop();
  assert.equal(scheduled(), null);
});

test('session teardown atomically cancels pending waits and admitted deliveries', async t => {
  const { runtime } = fixture(t);
  const pending = await runtime.register({ session: 'A', mode: 'callback' });
  const resolved = await runtime.register({ session: 'A', mode: 'callback' });
  await runtime.resolveCallback(resolved.id, resolved.token, 'ready');

  const result = await runtime.cancelForSession('A');
  assert.deepEqual(result, {
    ok: true,
    cancelled: 1,
    cancelledDeliveries: 1,
    cancelledOperations: 0,
    cancelledTasks: 0,
  });
  assert.equal((await runtime.waits.get(pending.id)).status, 'cancelled');
  assert.equal((await runtime.outbox.get(`wait:${resolved.id}`)).state, 'cancelled');
  assert.equal(runtime.hasPending('A'), false);
});
