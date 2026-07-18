'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createOrchestrationRuntime } = require('../src/orchestration-runtime');

function dataFixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-durable-runtime-data-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return {
    dataDir,
    file: path.join(dataDir, 'orchestration.json'),
    clock: { value: 50_000 },
    history: new Map(),
    deliveries: [],
  };
}

function fakeDetached() {
  const states = new Map();
  const launches = [];
  const cancellations = [];
  return {
    states,
    launches,
    cancellations,
    launch(spec) {
      launches.push({ ...spec });
      if (!states.has(spec.id)) {
        states.set(spec.id, {
          id: spec.id, started: true, running: true, done: false,
          pid: 9000 + launches.length, logPath: `/private/${spec.id}.log`, logTail: '',
        });
      }
      return states.get(spec.id);
    },
    status(id) { return states.get(id) || null; },
    cancel(id) { cancellations.push(id); return { ok: true }; },
  };
}

function buildRuntime(shared, overrides = {}) {
  const runChatTurn = overrides.runChatTurn || (async (sessionId, text, opts) => {
    shared.deliveries.push({ sessionId, text, opts });
    const ids = shared.history.get(sessionId) || new Set();
    ids.add(opts.deliveryId);
    shared.history.set(sessionId, ids);
    return true;
  });
  return createOrchestrationRuntime({
    file: shared.file,
    now: () => ++shared.clock.value,
    runChatTurn,
    isBusy: overrides.isBusy || (() => false),
    hasPersistedDelivery: async (sessionId, deliveryId) => (
      shared.history.get(sessionId)?.has(deliveryId) || false
    ),
    deliverOutbox: overrides.deliverOutbox || null,
    detachedAdapter: overrides.detachedAdapter || null,
    recoverDispatchResult: overrides.recoverDispatchResult || (async () => null),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    workerIntervalMs: 60_000,
    outboxOptions: {
      leaseMs: 100,
      maxAttempts: 4,
      backoff: () => 0,
    },
  });
}

test('detached completion after service crash is reconciled once and delivered after reconstruction', async t => {
  const shared = dataFixture(t);
  const detached = fakeDetached();
  const first = buildRuntime(shared, { detachedAdapter: detached });
  const spec = {
    sessionId: 'parent-A',
    idempotencyKey: 'build-once',
    spec: { command: 'compile', cwd: '/work', label: 'compile' },
  };
  const started = await first.startDetached(spec);
  const duplicate = await first.startDetached(spec);
  assert.equal(duplicate.operation.id, started.operation.id);
  assert.equal(duplicate.idempotent, true);
  assert.equal(detached.launches.length, 1);

  // External wrapper finishes while the MultiCC process is absent. The only
  // evidence available to the replacement runtime is the durable done state.
  detached.states.set(started.operation.externalId, {
    ...detached.states.get(started.operation.externalId),
    running: false, done: true, exitCode: 0, logTail: 'compile complete',
  });
  const rebuilt = buildRuntime(shared, { detachedAdapter: detached });
  await rebuilt.start();

  const recovered = await rebuilt.operations.get(started.operation.id);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.result.logTail, 'compile complete');
  assert.equal(detached.launches.length, 1, 'completed command is never re-launched');
  assert.equal(shared.deliveries.length, 1);
  assert.equal(shared.deliveries[0].sessionId, 'parent-A');
  assert.match(shared.deliveries[0].text, /compile complete/);
  assert.equal(
    (await rebuilt.outbox.get(`operation:${started.operation.id}:result`)).state,
    'delivered',
  );
  await rebuilt.stop();
});

test('dead detached ownership without a done marker fails closed instead of repeating side effects', async t => {
  const shared = dataFixture(t);
  const detached = fakeDetached();
  const first = buildRuntime(shared, { detachedAdapter: detached });
  const started = await first.startDetached({
    sessionId: 'parent', idempotencyKey: 'deploy-once',
    spec: { command: 'deploy', cwd: '/work', label: 'deploy' },
  });
  detached.states.set(started.operation.externalId, {
    ...detached.states.get(started.operation.externalId),
    running: false, done: false, started: true, logTail: 'connection dropped',
  });

  const rebuilt = buildRuntime(shared, { detachedAdapter: detached });
  await rebuilt.start();
  const operation = await rebuilt.operations.get(started.operation.id);
  assert.equal(operation.status, 'interrupted');
  assert.equal(detached.launches.length, 1);
  assert.match(shared.deliveries[0].text, /未自动重跑/);
  await rebuilt.stop();
});

test('dispatch delivery, result return and repeated completion are durable and idempotent', async t => {
  const shared = dataFixture(t);
  const runtime = buildRuntime(shared);
  const spec = {
    ownerSessionId: 'commander', resultSessionId: 'commander',
    idempotencyKey: 'dispatch-one',
    spec: {
      targetId: 'worker', targetLabel: 'Worker', chatId: 'worker-chat',
      message: 'perform review', replyTo: 'commander', gateway: false,
    },
  };
  const admitted = await runtime.admitDispatch(spec);
  const duplicateAdmission = await runtime.admitDispatch(spec);
  assert.equal(duplicateAdmission.id, admitted.id);
  assert.equal(duplicateAdmission.idempotent, true);

  await runtime.tick();
  assert.equal((await runtime.operations.get(admitted.id)).status, 'running');
  assert.deepEqual(shared.deliveries.map(entry => entry.sessionId), ['worker-chat']);
  assert.equal(shared.deliveries[0].opts.originDispatchId, admitted.id);

  const result = { status: 'completed', sessionName: 'worker-chat', text: 'review passed' };
  const completed = await runtime.completeDispatch(admitted.id, result);
  const repeated = await runtime.completeDispatch(admitted.id, result);
  assert.equal(completed.idempotent, false);
  assert.equal(repeated.idempotent, true);
  await assert.rejects(
    runtime.completeDispatch(admitted.id, { ...result, text: 'different result' }),
    error => error.statusCode === 409,
  );
  await runtime.tick();
  assert.deepEqual(shared.deliveries.map(entry => entry.sessionId), ['worker-chat', 'commander']);
  assert.match(shared.deliveries[1].text, /review passed/);
  assert.equal(
    (await runtime.outbox.get(`operation:${admitted.id}:result`)).state,
    'delivered',
  );
});

test('restart recovers a persisted dispatch reply from history before emitting one result', async t => {
  const shared = dataFixture(t);
  const first = buildRuntime(shared);
  const admitted = await first.admitDispatch({
    ownerSessionId: 'parent', resultSessionId: 'parent', idempotencyKey: 'recoverable',
    spec: {
      targetId: 'worker', chatId: 'worker-chat', message: 'work',
      replyTo: 'parent', gateway: false,
    },
  });
  await first.tick();
  assert.equal((await first.operations.get(admitted.id)).status, 'running');

  let recoverCalls = 0;
  const rebuilt = buildRuntime(shared, {
    recoverDispatchResult: async operation => {
      recoverCalls += 1;
      assert.equal(operation.id, admitted.id);
      return { completed: true, text: 'persisted worker reply' };
    },
  });
  await rebuilt.start();
  assert.equal(recoverCalls, 1);
  assert.equal((await rebuilt.operations.get(admitted.id)).status, 'completed');
  assert.equal(shared.deliveries.filter(entry => entry.sessionId === 'worker-chat').length, 1);
  assert.equal(shared.deliveries.filter(entry => entry.sessionId === 'parent').length, 1);
  assert.match(shared.deliveries.find(entry => entry.sessionId === 'parent').text, /persisted worker reply/);
  await rebuilt.stop();
});

test('dispatch inject-to-ack crash recovers history without replaying the target turn', async t => {
  const shared = dataFixture(t);
  const first = buildRuntime(shared);
  const admitted = await first.admitDispatch({
    ownerSessionId: 'parent', resultSessionId: 'parent', idempotencyKey: 'lost-ack',
    spec: {
      targetId: 'worker', chatId: 'worker-chat', message: 'work',
      replyTo: 'parent', gateway: false,
    },
  });
  const requestId = `operation:${admitted.id}:request`;
  const [lostLease] = await first.outbox.claim({ workerId: 'crashed-worker' });
  assert.equal(lostLease.id, requestId);
  shared.history.set('worker-chat', new Set([requestId]));
  shared.clock.value += 101;

  const rebuilt = buildRuntime(shared, {
    recoverDispatchResult: async () => ({ completed: true, text: 'reply already on disk' }),
  });
  await rebuilt.start();
  assert.equal((await rebuilt.operations.get(admitted.id)).status, 'completed');
  assert.equal((await rebuilt.outbox.get(requestId)).state, 'delivered');
  assert.equal(
    shared.deliveries.filter(entry => entry.sessionId === 'worker-chat').length,
    0,
    'persisted target request is acknowledged without a second native turn',
  );
  assert.equal(shared.deliveries.filter(entry => entry.sessionId === 'parent').length, 1);
  assert.match(shared.deliveries[0].text, /reply already on disk/);
  await rebuilt.stop();
});

test('restart marks an unprovable dispatch interrupted and notifies its parent', async t => {
  const shared = dataFixture(t);
  const first = buildRuntime(shared);
  const admitted = await first.admitDispatch({
    ownerSessionId: 'parent', resultSessionId: 'parent', idempotencyKey: 'lost-dispatch',
    spec: {
      targetId: 'worker', chatId: 'worker-chat', message: 'work',
      replyTo: 'parent', gateway: false,
    },
  });
  await first.tick();

  const rebuilt = buildRuntime(shared, {
    recoverDispatchResult: async () => ({ completed: false, lastOutput: 'partial' }),
  });
  await rebuilt.start();
  assert.equal((await rebuilt.operations.get(admitted.id)).status, 'interrupted');
  const notice = shared.deliveries.find(entry => entry.sessionId === 'parent');
  assert.match(notice.text, /分发任务已中断/);
  await rebuilt.stop();
});

test('dispatch requests for different target sessions run concurrently', async t => {
  const shared = dataFixture(t);
  const started = [];
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const runtime = buildRuntime(shared, {
    runChatTurn: async (sessionId, text, opts) => {
      started.push(sessionId);
      if (started.length === 2) release();
      await barrier;
      const ids = shared.history.get(sessionId) || new Set();
      ids.add(opts.deliveryId);
      shared.history.set(sessionId, ids);
      return true;
    },
  });
  for (const target of ['worker-A', 'worker-B']) {
    await runtime.admitDispatch({
      ownerSessionId: 'parent', resultSessionId: 'parent', idempotencyKey: target,
      spec: { targetId: target, chatId: target, message: target, replyTo: 'parent', gateway: false },
    });
  }
  await runtime.tick();
  assert.deepEqual(new Set(started), new Set(['worker-A', 'worker-B']));
});

test('task ledger becomes interrupted on restart and graceful shutdown without claiming process survival', async t => {
  const shared = dataFixture(t);
  const first = buildRuntime(shared);
  await first.observeTask({
    sessionId: 'parent', taskId: 'agent-1', status: 'running',
    detail: { kind: 'agent-task', lastOutput: 'last known line' },
  });

  const rebuilt = buildRuntime(shared);
  await rebuilt.start();
  let tasks = await rebuilt.operations.listTasks({ sessionId: 'parent' });
  assert.equal(tasks[0].status, 'interrupted');
  assert.equal(tasks[0].lastOutput, 'last known line');
  assert.match(shared.deliveries[0].text, /CLI 子进程无法被可靠恢复/);

  await rebuilt.observeTask({ sessionId: 'parent', taskId: 'agent-2', status: 'running' });
  await rebuilt.stop();
  tasks = await rebuilt.operations.listTasks({ sessionId: 'parent' });
  assert.equal(tasks.find(entry => entry.taskId === 'agent-2').status, 'interrupted');
  const snapshot = await rebuilt.store.snapshot();
  assert.equal(
    Object.values(snapshot.outbox).some(item => (
      item.payload.type === 'task.interrupted' && item.payload.taskId === 'agent-2'
    )),
    true,
  );
});

test('session deletion cancels owned operations, task observations and pending deliveries atomically', async t => {
  const shared = dataFixture(t);
  const detached = fakeDetached();
  const runtime = buildRuntime(shared, { detachedAdapter: detached });
  const job = await runtime.startDetached({
    sessionId: 'deleted', idempotencyKey: 'job',
    spec: { command: 'long job', cwd: '/work', label: 'job' },
  });
  await runtime.observeTask({ sessionId: 'deleted', taskId: 'task-1', status: 'running' });
  const dispatch = await runtime.admitDispatch({
    ownerSessionId: 'deleted', resultSessionId: 'deleted', idempotencyKey: 'dispatch',
    spec: {
      targetId: 'worker', chatId: 'worker-chat', message: 'work',
      replyTo: 'deleted', gateway: false,
    },
  });

  const result = await runtime.cancelForSession('deleted');
  assert.equal(result.cancelledOperations, 2);
  assert.equal(result.cancelledTasks, 1);
  assert.deepEqual(detached.cancellations, [job.operation.externalId]);
  assert.equal((await runtime.operations.get(job.operation.id)).status, 'cancelled');
  assert.equal((await runtime.operations.get(dispatch.id)).status, 'cancelled');
  assert.equal(
    (await runtime.outbox.get(`operation:${dispatch.id}:request`)).state,
    'cancelled',
  );
  assert.equal((await runtime.operations.listTasks({ sessionId: 'deleted' }))[0].status, 'cancelled');
});

test('deleting a dispatch target cancels its request and durably notifies the surviving parent', async t => {
  const shared = dataFixture(t);
  const runtime = buildRuntime(shared);
  const dispatch = await runtime.admitDispatch({
    ownerSessionId: 'parent', resultSessionId: 'parent', idempotencyKey: 'target-delete',
    spec: {
      targetId: 'deleted-target', chatId: 'deleted-target', message: 'work',
      replyTo: 'parent', gateway: false,
    },
  });
  const result = await runtime.cancelForSession('deleted-target');
  assert.equal(result.cancelledDeliveries, 1);
  assert.equal((await runtime.operations.get(dispatch.id)).status, 'interrupted');
  assert.equal(
    (await runtime.outbox.get(`operation:${dispatch.id}:request`)).state,
    'cancelled',
  );
  assert.equal(
    (await runtime.outbox.get(`operation:${dispatch.id}:result`)).state,
    'pending',
  );
  await runtime.tick();
  assert.equal(shared.deliveries.length, 1);
  assert.equal(shared.deliveries[0].sessionId, 'parent');
  assert.match(shared.deliveries[0].text, /分发任务已中断/);
});
