'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createOrchestrationRuntime } = require('../src/orchestration/host');

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
    databaseFile: overrides.databaseFile,
    probe: overrides.probe,
    onSchedulerEvent: overrides.onSchedulerEvent,
    now: () => ++shared.clock.value,
    runChatTurn,
    isBusy: overrides.isBusy || (() => false),
    hasPersistedDelivery: async (sessionId, deliveryId) => (
      shared.history.get(sessionId)?.has(deliveryId) || false
    ),
    deliverOutbox: overrides.deliverOutbox || null,
    detachedAdapter: overrides.detachedAdapter || null,
    recoverDispatchResult: overrides.recoverDispatchResult || (async () => null),
    replayRecoveredDispatchEffects: overrides.replayRecoveredDispatchEffects || (async () => {}),
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

for (const backend of ['json', 'sqlite']) {
  test(`detached result confirmation survives recovery and withdraws only its own wake-up (${backend})`, async t => {
    const shared = dataFixture(t);
    const detached = fakeDetached();
    const events = [];
    const options = {
      detachedAdapter: detached, isBusy: () => true,
      databaseFile: backend === 'sqlite' ? path.join(shared.dataDir, 'state.sqlite') : null,
      onSchedulerEvent: event => events.push(event),
    };
    const first = buildRuntime(shared, options);
    let current = first;
    try {
      const start = async label => (await first.startDetached({
        sessionId: 'owner', spec: { command: label, label },
      })).operation;
      const observed = await start('first-build');
      const unseen = await start('second-build');
      const inspect = version => first.sessionScheduler.detachedResult('owner', observed.id, version);
      assert.equal((await inspect()).result_version, undefined);
      assert.equal((await inspect('0'.repeat(64))).code, 'detached_result_not_ready');
      for (const [job, exitCode] of [[observed, 1], [unseen, 0]]) {
        detached.states.set(job.externalId, {
          ...detached.states.get(job.externalId), running: false, done: true, exitCode, logTail: job.spec.label,
        });
      }
      await first.tick();
      const read = await inspect();
      assert.equal(read.status, 'failed');
      assert.equal(read.result.exitCode, 1);
      assert.match(read.result_version, /^[a-f0-9]{64}$/);
      assert.equal((await inspect('0'.repeat(64))).code, 'detached_result_version_mismatch');
      assert.equal((await first.sessionScheduler.status('owner')).queued.length, 2);
      const confirmations = await Promise.all([inspect(read.result_version), inspect(read.result_version)]);
      assert.deepEqual(confirmations.map(row => row.notification), ['withdrawn', 'withdrawn']);
      assert.equal(events.filter(event => event.type === 'queued_cancelled').length, 1);
      assert.equal((await first.sessionScheduler.status('owner')).queued.length, 1);
      await first.dispose();
      current = buildRuntime(shared, { ...options, isBusy: () => false });
      await current.start();
      assert.deepEqual(shared.deliveries.map(row => row.opts.deliveryId), [`operation:${unseen.id}:result`]);
      assert.deepEqual(await current.sessionScheduler.detachedResult('owner', observed.id), read);
      const replay = await current.sessionScheduler.detachedResult('owner', observed.id, read.result_version);
      assert.equal(replay.notification, 'withdrawn');
      const delivered = await current.sessionScheduler.detachedResult('owner', unseen.id);
      assert.equal((await current.sessionScheduler.detachedResult('owner', unseen.id, delivered.result_version)).notification,
        'delivered');
    } finally {
      await current.dispose();
    }
  });
}

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

test('restart replays recovered Commander fan-out before completing the parent dispatch', async t => {
  const shared = dataFixture(t);
  const first = buildRuntime(shared);
  const admitted = await first.admitDispatch({
    ownerSessionId: 'task-board', resultSessionId: 'task-board', idempotencyKey: 'commander-recovery',
    spec: {
      targetId: 'commander', chatId: 'commander-chat', message: 'route work',
      replyTo: null, gateway: true,
    },
  });
  await first.tick();

  const marker = '<<dispatch target="worker">recovered work</dispatch>>';
  let rebuilt;
  const replayed = [];
  rebuilt = buildRuntime(shared, {
    recoverDispatchResult: async () => ({ completed: true, text: marker }),
    replayRecoveredDispatchEffects: async (operation, recovered) => {
      assert.equal((await rebuilt.operations.get(operation.id)).status, 'running');
      replayed.push({ operationId: operation.id, text: recovered.text });
    },
  });
  await rebuilt.start();
  assert.deepEqual(replayed, [{ operationId: admitted.id, text: marker }]);
  assert.equal((await rebuilt.operations.get(admitted.id)).status, 'completed');
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

for (const backend of ['json', 'sqlite']) {
  function fixture(t) {
    let rt;
    t.after(() => rt?.dispose());
    const shared = dataFixture(t);
    const detached = fakeDetached();
    const events = [];
    let busy = true;
    rt = buildRuntime(shared, {
      databaseFile: backend === 'sqlite' ? path.join(shared.dataDir, 'state.sqlite') : null,
      detachedAdapter: detached, isBusy: () => busy, onSchedulerEvent: event => events.push(event),
      probe: m => detached.status(m.detachedTaskId)?.done ? 'READY' : 'running',
    });
    const turn = entryId => rt.store.mutate(draft => {
      draft.sessionSchedules.owner = { sessionId: 'owner', state: entryId ? 'running' : 'idle',
        active: entryId ? { entryId, deliveryId: entryId } : null, updatedAt: shared.clock.value };
    });
    const start = async label => (await rt.startDetached({
      sessionId: 'owner', spec: { command: label, label },
    })).operation;
    const poll = (target, opts) => rt.register({ session: 'owner', mode: 'poll',
      pollUrl: '/api/detached/' + target, untilContains: 'READY', intervalSec: 3, ...opts });
    const finish = op => Object.assign(detached.status(op.externalId),
      { running: false, done: true, exitCode: 0, logTail: 'finished' });
    const queue = async () => (await rt.sessionScheduler.status('owner')).queued.map(row => row.entryId);
    return { rt, shared, events, turn, start, poll, finish, queue, idle() { busy = false; } };
  }

  for (const triggered of [false, true]) {
    test(`same-turn progress withdraws a finished task and its ${triggered ? 'queued' : 'pending'} poll (${backend})`, async t => {
      const { rt, shared, events, turn, start, poll, finish, queue } = fixture(t);
      await turn('entry-1');
      const first = await start('first');
      const old = await poll(first.externalId);
      const parallel = await start('parallel');
      const keep = await poll(parallel.externalId, {
        pollUrl: null, pollCmd: 'curl /api/detached/' + parallel.externalId,
      });
      assert.equal((await rt.waits.get(old.id)).status, 'pending');
      assert.equal((await rt.waits.get(keep.id)).metadata.detachedTaskId, parallel.externalId);
      assert.equal((await rt.operations.get(first.id)).metadata.createdInEntryId, 'entry-1');
      assert.equal((await rt.waits.get(old.id)).metadata.createdInEntryId, 'entry-1');
      finish(first);
      if (triggered) {
        shared.clock.value += 3000;
        await rt.tick();
        assert.deepEqual(new Set(await queue()), new Set(['wait:' + old.id, 'operation:' + first.id + ':result']));
      }
      const next = await start('next');
      const newest = await poll(next.externalId);
      const notice = await rt.outbox.get('operation:' + first.id + ':result');
      assert.equal(notice.state, 'cancelled');
      assert.equal(notice.lastError, 'superseded_in_same_turn');
      if (triggered) {
        assert.equal((await rt.outbox.get('wait:' + old.id)).state, 'cancelled');
        assert.equal(events.filter(e => e.type === 'queued_cancelled' && e.entryId === 'wait:' + old.id).length, 1);
      } else {
        assert.equal((await rt.waits.get(old.id)).status, 'cancelled');
        assert.equal(await rt.outbox.get('wait:' + old.id), null);
      }
      assert.deepEqual(await queue(), []);
      assert.equal((await rt.waits.get(keep.id)).status, 'pending');
      assert.equal((await rt.waits.get(newest.id)).status, 'pending');
    });
  }

  test(`registering a wait also advances the active turn and removes terminal wake-ups (${backend})`, async t => {
    const { rt, turn, start, poll, finish, queue } = fixture(t);
    await turn('active');
    const first = await start('done before next poll');
    const old = await poll(first.externalId);
    finish(first);
    const next = await poll('next-monitor');
    assert.equal((await rt.waits.get(old.id)).status, 'cancelled');
    assert.equal((await rt.waits.get(next.id)).status, 'pending');
    assert.equal((await rt.outbox.get('operation:' + first.id + ':result')).state, 'cancelled');
    assert.deepEqual(await queue(), []);
  });

  test(`slot replacement is atomic and scoped to its session; last wake-up still delivers (${backend})`, async t => {
    const { rt, shared, turn, poll, queue, idle } = fixture(t);
    const slot = session => rt.register({ session, mode: 'callback', dedupeKey: '  watch-main  ' });
    await turn('entry-one');
    const old = await slot('owner');
    await assert.rejects(rt.register({ session: 'owner', mode: 'callback', dedupeKey: 'x'.repeat(257) }),
      /dedupeKey/);
    const other = await slot('other');
    const p = await poll('unrelated-a');
    const q = await poll('unrelated-b');
    assert.equal(old.dedupeKey, 'watch-main');
    await rt.resolveCallback(old.id, old.token, 'obsolete');
    assert.deepEqual(await queue(), ['wait:' + old.id]);
    const replacements = await Promise.all([slot('owner'), slot('owner')]);
    const statuses = await Promise.all(replacements.map(w => rt.waits.get(w.id)));
    assert.deepEqual(statuses.map(w => w.status).sort(), ['cancelled', 'pending']);
    assert.equal((await rt.outbox.get('wait:' + old.id)).lastError, 'superseded_by_dedupe_key');
    for (const w of [other, p, q]) assert.equal((await rt.waits.get(w.id)).status, 'pending');
    const last = replacements.find(w => statuses.some(row => row.id === w.id && row.status === 'pending'));
    await rt.resolveCallback(last.id, last.token, 'last result');
    assert.deepEqual(await queue(), ['wait:' + last.id]);
    await turn(null);
    idle();
    await rt.tick();
    assert.deepEqual(shared.deliveries.map(row => row.opts.deliveryId), ['wait:' + last.id]);
    assert.deepEqual(await rt.cancel(last.id), { ok: false, code: 'not_pending', status: 'resolved' });
  });

  test(`claim protects delivery while acknowledgement still retires its bound poll (${backend})`, async t => {
    const { rt, start, poll, finish } = fixture(t);
    const job = await start('leased');
    const bound = await poll(job.externalId, { intervalSec: 300 });
    finish(job);
    await rt.tick();
    const [leased] = await rt.outbox.claim({ workerId: 'consumer' });
    assert.equal(leased.id, 'operation:' + job.id + ':result');
    const inspect = version => rt.sessionScheduler.detachedResult('owner', job.id, version);
    const read = await inspect();
    assert.equal((await inspect(read.result_version)).notification, 'leased');
    assert.equal((await rt.outbox.get(leased.id)).state, 'leased');
    assert.equal((await rt.waits.get(bound.id)).status, 'cancelled');
    assert.equal(rt.hasPending('owner'), false);
    const waiting = await rt.register({ session: 'second', mode: 'callback' });
    await rt.resolveCallback(waiting.id, waiting.token, 'ready');
    const [claimed] = await rt.outbox.claim({ workerId: 'other-consumer' });
    assert.equal(claimed.id, 'wait:' + waiting.id);
    assert.deepEqual(await rt.cancel(waiting.id), { ok: false, code: 'not_pending', status: 'resolved' });
  });

  test(`a new turn preserves earlier waits; only verified acknowledgement withdraws bound waits (${backend})`, async t => {
    const { rt, shared, turn, start, poll, finish, queue } = fixture(t);
    await turn('entry-1');
    const job = await start('observed');
    const old = await poll(job.externalId);
    const late = await poll(job.externalId, { intervalSec: 300 });
    finish(job);
    shared.clock.value += 3000;
    await rt.tick();
    await turn('entry-2');
    const keep = await poll('unrelated');
    const entry = 'wait:' + old.id;
    const inspect = version => rt.sessionScheduler.detachedResult('owner', job.id, version);
    // A pre-upgrade wait has the poll target but no structured binding yet.
    await rt.store.mutate(draft => {
      delete draft.waits[late.id].metadata.detachedTaskId;
      delete draft.waits[late.id].metadata.createdInEntryId;
    });
    const read = await inspect();
    assert.equal((await inspect('wrong')).code, 'detached_result_version_mismatch');
    assert.equal((await rt.sessionScheduler.detachedResult('other', job.id, read.result_version)).ok, false);
    assert.deepEqual(new Set(await queue()), new Set([entry, 'operation:' + job.id + ':result']));
    assert.equal((await rt.waits.get(late.id)).status, 'pending');
    assert.equal((await inspect(read.result_version)).notification, 'withdrawn');
    assert.deepEqual(await queue(), []);
    assert.equal((await rt.waits.get(late.id)).status, 'cancelled');
    assert.equal((await rt.waits.get(keep.id)).status, 'pending');
    // The notification may already be withdrawn when another bound wait is registered.
    const retry = await poll(job.externalId);
    assert.equal((await inspect(read.result_version)).notification, 'withdrawn');
    assert.equal((await rt.waits.get(retry.id)).status, 'cancelled');
    assert.equal((await rt.outbox.get(entry)).state, 'cancelled');
  });
}
