'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createOrchestrationRuntime } = require('../src/orchestration-runtime');
const { reconcileTaskRunSlotLeases } = require('../src/task-run-recovery');

function withTimeout(promise, ms, message) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => { if (timer !== null) clearTimeout(timer); });
}

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
  const logs = overrides.logs || [];
  const runtime = createOrchestrationRuntime({
    file,
    now: () => clock.value,
    runChatTurn,
    log: message => logs.push(message),
    isBusy: overrides.isBusy || (() => false),
    ...(overrides.isDeliveryLocked ? { isDeliveryLocked: overrides.isDeliveryLocked } : {}),
    ...(overrides.deliveryWatchdogMs !== undefined
      ? { deliveryWatchdogMs: overrides.deliveryWatchdogMs } : {}),
    hasPersistedDelivery: async (sessionId, deliveryId) => (
      history.get(sessionId)?.has(deliveryId) || false
    ),
    probe: overrides.probe || (async () => ''),
    getSessionRecoveryState: overrides.getSessionRecoveryState || (() => null),
    beforeFirstTick: overrides.beforeFirstTick,
    beforeDeliver: overrides.beforeDeliver,
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
    storeOptions: overrides.storeOptions || {},
  });
  return { dir, file, clock, history, injections, logs, runtime, scheduled: () => scheduled };
}

test('task-run dispatch crosses a fresh-run barrier before native delivery', async t => {
  const order = [];
  const { runtime, injections } = fixture(t, {
    isBusy: (sessionId, item) => {
      assert.equal(sessionId, 'slot-1');
      assert.equal(item.payload.taskRunId, 'run-1');
      assert.equal(item.payload.leaseEpoch, 3);
      return false;
    },
    beforeDeliver: async descriptor => {
      order.push(`barrier:${descriptor.taskRunId}:${descriptor.leaseEpoch}`);
    },
    runChatTurn: async (sessionId, text, opts) => {
      order.push(`turn:${opts.taskRunId}:${opts.leaseEpoch}`);
      injections.push({ sessionId, text, opts });
      return true;
    },
  });
  await runtime.admitDispatch({
    operationId: 'run-1',
    ownerSessionId: 'commander',
    resultSessionId: 'commander',
    idempotencyKey: 'run-1',
    spec: {
      targetId: 'slot-1', chatId: 'slot-1', message: 'execute', oneWay: true,
      taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 3,
      taskStart: true, taskSource: 'task-board', taskText: 'execute',
    },
  });
  await runtime.tick();
  assert.deepEqual(order, ['barrier:run-1:3', 'turn:run-1:3']);
  assert.equal(injections[0].opts.isFirstTurn, true);
  assert.equal(injections[0].opts.taskRunId, 'run-1');
  assert.equal(injections[0].opts.leaseEpoch, 3);
  await runtime.stop();
});

test('hibernation activity view allows static W but blocks queued durable work', async t => {
  const h = fixture(t);
  await h.runtime.admitSessionWork({
    sessionId: 'bound-1', text: 'question', idempotencyKey: 'question-1', options: {},
  });
  assert.equal(await h.runtime.hasSessionActivity('bound-1'), true);
  await h.runtime.tick();
  await h.runtime.sessionScheduler.freeze('bound-1', 'classify_waiting', { classifyState: 'W' });
  assert.equal(await h.runtime.hasSessionActivity('bound-1'), false);
  await h.runtime.admitSessionWork({
    sessionId: 'bound-1', text: 'queued', idempotencyKey: 'queued-1', options: {},
  });
  assert.equal(await h.runtime.hasSessionActivity('bound-1'), true);
  await h.runtime.stop();
});

test('delivery guard settles once with durable truth and also releases on rejection', async t => {
  const outcomes = [];
  const accepted = fixture(t, {
    beforeDeliver: async () => ({ complete: async outcome => outcomes.push(outcome) }),
  });
  await accepted.runtime.admitSessionWork({
    sessionId: 'bound-ok', text: 'go', idempotencyKey: 'guard-ok', options: {},
  });
  await accepted.runtime.tick();
  assert.deepEqual(outcomes, [{ accepted: true, durable: true }]);
  await accepted.runtime.stop();

  const rejected = fixture(t, {
    beforeDeliver: async () => ({ complete: async outcome => outcomes.push(outcome) }),
    runChatTurn: async () => false,
  });
  await rejected.runtime.admitSessionWork({
    sessionId: 'bound-fail', text: 'go', idempotencyKey: 'guard-fail', options: {},
  });
  await rejected.runtime.tick();
  assert.deepEqual(outcomes.at(-1), { accepted: false, durable: false });
  assert.equal((await rejected.runtime.stats()).pendingDeliveries, 1,
    'a rejected delivery remains durable and retryable');
  await rejected.runtime.stop();
});

test('delivery preparation failure runs no chat turn and preserves the outbox retry', async t => {
  let turns = 0;
  const h = fixture(t, {
    beforeDeliver: async () => { throw Object.assign(new Error('thaw refused'), { code: 'thaw_failed' }); },
    runChatTurn: async () => { turns += 1; return true; },
  });
  await h.runtime.admitSessionWork({
    sessionId: 'bound-cold', text: 'due callback', idempotencyKey: 'cold-retry', options: {},
  });
  await h.runtime.tick();
  assert.equal(turns, 0);
  assert.equal((await h.runtime.stats()).pendingDeliveries, 1);
  await h.runtime.stop();
});

test('startup awaits lease reconciliation after scheduler recovery and before first delivery', async t => {
  const order = [];
  const { runtime } = fixture(t, {
    beforeFirstTick: async ({ sessionScheduler }) => {
      assert.ok(sessionScheduler);
      order.push('lease-reconcile:start');
      await Promise.resolve();
      order.push('lease-reconcile:done');
    },
    runChatTurn: async () => { order.push('delivery'); return true; },
  });
  const wait = await runtime.register({ session: 'slot-1', mode: 'callback' });
  await runtime.resolveCallback(wait.id, wait.token, 'ready');

  await runtime.start();
  assert.deepEqual(order, ['lease-reconcile:start', 'lease-reconcile:done', 'delivery']);
  await runtime.stop();
});

test('startup exposes the durable terminal decision to TaskRun recovery before the first tick', async t => {
  const first = fixture(t);
  await first.runtime.admitSessionWork({
    sessionId: 'slot-1',
    text: 'execute',
    idempotencyKey: 'run-1',
    options: { taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 3 },
  });
  await first.runtime.sessionScheduler.complete('slot-1', {
    expectedTaskId: 'task-1', classifyState: 'D', reason: 'classified_D',
  });
  await first.runtime.dispose();

  const records = new Map([['slot-1', {
    id: 'slot-1', taskExecutionSlot: true,
    taskRunLease: { runId: 'run-1', leaseEpoch: 3 },
  }]]);
  const durableLease = {
    slotId: 'slot-1', runId: 'run-1', leaseEpoch: 3,
    state: 'active', phase: 'ready',
  };
  const recovered = [];
  const taskRunStore = {
    planSlotLeaseRecovery: () => [{
      ...durableLease,
      leaseState: 'active',
      taskId: 'task-1',
      action: 'restore_projection',
      cleanupState: 'blocked',
    }],
    getSlotLease: () => ({ ...durableLease }),
    getRun: () => ({
      runId: 'run-1', taskId: 'task-1', slotId: 'slot-1', leaseEpoch: 3,
      executionStatus: 'running', usageStatus: 'collecting', cleanupState: 'blocked',
    }),
    releaseSlotLease: () => {},
    quarantineSlotLease: () => {},
  };
  const rebuilt = createOrchestrationRuntime({
    file: first.file,
    runChatTurn: async () => true,
    getSessionRecoveryState: () => ({ classifyState: 'D' }),
    beforeFirstTick: ({ sessionScheduler }) => reconcileTaskRunSlotLeases({
      store: taskRunStore,
      records,
      persistRecords: () => true,
      getSchedulerStatus: slotId => sessionScheduler.status(slotId),
      recoverTerminal: async event => { recovered.push(event); return { ok: true }; },
    }),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  await rebuilt.start();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].taskRunId, 'run-1');
  assert.equal(recovered[0].leaseEpoch, 3);
  assert.equal(recovered[0].classifyState, 'D');
  assert.equal(recovered[0].recovered, true);
  await rebuilt.dispose();
});

test('a background callback resumes the retained TaskRun instead of starting anonymous work', async t => {
  const { runtime, injections } = fixture(t, {
    isBusy: (_sessionId, item) => item?.payload?.type === 'wait.result'
      && item?.turnLineage?.taskRunId !== 'run-1',
  });
  await runtime.admitSessionWork({
    sessionId: 'slot-1',
    text: 'start',
    idempotencyKey: 'run-1',
    options: { taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 5 },
  });
  await runtime.tick();
  await runtime.sessionScheduler.turnEnded('slot-1');
  await runtime.sessionScheduler.complete('slot-1', {
    expectedTaskId: 'task-1', classifyState: 'B',
  });
  const wait = await runtime.register({
    id: 'run-1-wait',
    session: 'slot-1',
    mode: 'callback',
    taskId: 'task-1',
    taskRunId: 'run-1',
    leaseEpoch: 5,
  });
  await runtime.resolveCallback(wait.id, wait.token, 'background done');
  await runtime.tick();
  assert.equal(injections.length, 2);
  assert.equal(injections[1].opts.taskId, 'task-1');
  assert.equal(injections[1].opts.taskRunId, 'run-1');
  assert.equal(injections[1].opts.leaseEpoch, 5);
  assert.equal(injections[1].opts.isFirstTurn, undefined);
  await runtime.stop();
});

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

test('an immediate replacement turn retains the dispatch operation and task lineage', async t => {
  const { runtime, injections } = fixture(t);
  const dispatch = await runtime.admitDispatch({
    ownerSessionId: 'commander',
    resultSessionId: 'commander',
    idempotencyKey: 'replace-live-dispatch',
    spec: {
      targetId: 'worker',
      chatId: 'worker',
      message: 'original dispatch',
      resultMode: 'sync',
      taskId: 'task-live',
      taskStart: true,
      taskSource: 'commander',
      taskText: 'original dispatch',
    },
  });
  await runtime.tick();
  assert.equal(injections[0].opts.originDispatchId, dispatch.id);

  const replacement = await runtime.sessionScheduler.admit({
    sessionId: 'worker',
    text: '立即继续',
    idempotencyKey: 'immediate-replacement',
  });
  const inserted = await runtime.sessionScheduler.insertQueued(
    'worker',
    replacement.entry.id,
  );
  assert.equal(inserted.inserted.inheritedLineage, true);
  await runtime.sessionScheduler.complete('worker', { classifyState: 'E' });
  await runtime.tick();

  assert.equal(injections.length, 2);
  assert.equal(injections[1].opts.taskId, 'task-live');
  assert.equal(injections[1].opts.originDispatchId, dispatch.id);
  assert.equal(injections[1].opts.originContinue, true);
  assert.equal(injections[1].opts.schedulerWorkKind, 'continuation');
  assert.equal((await runtime.operations.get(dispatch.id)).status, 'running');
  await runtime.stop();
});

test('legacy continuation lineage recovers only from one unique live dispatch task match', async t => {
  const unique = fixture(t);
  const dispatch = await unique.runtime.admitDispatch({
    ownerSessionId: 'commander',
    resultSessionId: 'commander',
    idempotencyKey: 'unique-live-dispatch',
    spec: {
      targetId: 'worker', chatId: 'worker', message: 'work',
      resultMode: 'sync', taskId: 'task-unique', taskStart: true,
      taskSource: 'commander', taskText: 'work',
    },
  });
  await unique.runtime.tick();
  await unique.runtime.sessionScheduler.complete('worker', { classifyState: 'D' });
  await unique.runtime.admitSessionWork({
    sessionId: 'worker',
    text: 'legacy continuation',
    workKind: 'continuation',
    options: { taskId: 'task-unique' },
    idempotencyKey: 'legacy-continuation',
  });
  assert.equal(unique.injections.length, 2);
  assert.equal(unique.injections[1].opts.originDispatchId, dispatch.id);
  assert.match(unique.logs.join('\n'), /dispatch_lineage_recovered/);
  await unique.runtime.stop();

  const ambiguous = fixture(t);
  const first = await ambiguous.runtime.admitDispatch({
    ownerSessionId: 'one', resultSessionId: 'one', idempotencyKey: 'ambiguous-one',
    spec: {
      targetId: 'worker', chatId: 'worker', message: 'one',
      resultMode: 'sync', taskId: 'task-shared', taskStart: true,
      taskSource: 'commander', taskText: 'one',
    },
  });
  await ambiguous.runtime.tick();
  const second = await ambiguous.runtime.admitDispatch({
    ownerSessionId: 'two', resultSessionId: 'two', idempotencyKey: 'ambiguous-two',
    spec: {
      targetId: 'worker', chatId: 'worker', message: 'two',
      resultMode: 'sync', taskId: 'task-shared', taskStart: true,
      taskSource: 'commander', taskText: 'two',
    },
  });
  await ambiguous.runtime.operations.markRunning(second.id);
  await ambiguous.runtime.sessionScheduler.complete('worker', { classifyState: 'D' });
  await ambiguous.runtime.admitSessionWork({
    sessionId: 'worker',
    text: 'ambiguous continuation',
    workKind: 'continuation',
    options: { taskId: 'task-shared' },
    idempotencyKey: 'ambiguous-continuation',
  });
  const delivered = ambiguous.injections.find(entry => entry.text === 'ambiguous continuation');
  assert.ok(delivered);
  assert.equal(delivered.opts.originDispatchId, undefined);
  assert.match(ambiguous.logs.join('\n'), /dispatch_lineage_ambiguous/);
  assert.equal((await ambiguous.runtime.operations.get(first.id)).status, 'running');
  assert.equal((await ambiguous.runtime.operations.get(second.id)).status, 'running');
  await ambiguous.runtime.stop();
});

test('interruptDispatch settles a live operation once and preserves an existing terminal result', async t => {
  const { runtime } = fixture(t);
  const dispatch = await runtime.admitDispatch({
    ownerSessionId: 'commander', resultSessionId: 'commander',
    idempotencyKey: 'interrupt-live',
    spec: {
      targetId: 'worker', chatId: 'worker', message: 'work',
      resultMode: 'sync', taskId: 'task-interrupt', taskStart: true,
      taskSource: 'commander', taskText: 'work',
    },
  });
  await runtime.operations.markRunning(dispatch.id);
  const first = await runtime.interruptDispatch(dispatch.id, { reason: 'manual stop' });
  const repeat = await runtime.interruptDispatch(dispatch.id, { reason: 'different retry text' });
  assert.equal(first.ok, true);
  assert.equal(first.operation.status, 'interrupted');
  assert.equal(repeat.ok, true);
  assert.equal(repeat.idempotent, true);
  assert.equal(repeat.status, 'interrupted');
  assert.equal((await runtime.operations.get(dispatch.id)).result.error, 'manual stop');
  await runtime.stop();
});

test('a queue notice that fails cannot falsify a durable dispatch admission', async t => {
  // Two writes make one admitted dispatch: the operation and its outbox request
  // land first, then the scheduler's queue notice records the wake-up. Only the
  // second one is failed here. noteQueued is a notice, not the commitment — so
  // reporting "not admitted" because it failed would be a false negative, and a
  // voice caller acting on it would submit work that is already committed twice.
  let queueNoticeArmed = true;
  const { runtime, injections } = fixture(t, {
    storeOptions: {
      hooks: {
        beforeRename: ({ state }) => {
          // The admission's own write carries no session schedule; the queue
          // notice's write is the one that creates it.
          if (!queueNoticeArmed || !Object.keys(state.sessionSchedules || {}).length) return;
          queueNoticeArmed = false;
          throw new Error('scheduler unavailable');
        },
      },
    },
  });
  const admitted = await runtime.admitDispatch({
    ownerSessionId: 'commander',
    resultSessionId: 'commander',
    idempotencyKey: 'task-wakeup-1',
    spec: { targetId: 'worker', chatId: 'worker', message: '执行正文', oneWay: true },
  });

  assert.equal(typeof admitted.id, 'string', 'the admission still has its operation id');
  assert.equal(admitted.status, 'admitted');
  assert.equal(admitted.wakeupError, 'scheduler unavailable', 'the lost wake-up is reported alongside it');

  // And it really is durable: the next scheduler pass delivers it, exactly once.
  await runtime.tick();
  assert.equal(injections.length, 1);
  assert.equal(injections[0].sessionId, 'worker');
  await runtime.tick();
  assert.equal(injections.length, 1, 'a deferred wake-up does not duplicate the delivery');
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

test('durable delay survives runtime reconstruction and delivers exactly once when due', async t => {
  const clock = { value: 40_000 };
  const first = fixture(t, { clock });
  const registered = await first.runtime.register({
    id: 'wait-delay-restart',
    session: 'D',
    mode: 'delay',
    delaySeconds: 30,
    reason: '重新检查部署状态',
  });
  assert.equal(registered.dueAt, 70_000);
  assert.equal(first.runtime.hasPending('D'), true);

  clock.value = 70_000;
  const injections = [];
  const history = new Map();
  const rebuilt = createOrchestrationRuntime({
    file: first.file,
    now: () => clock.value,
    runChatTurn: async (sessionId, text, opts) => {
      injections.push({ sessionId, text, opts });
      history.set(sessionId, new Set([opts.deliveryId]));
      return true;
    },
    hasPersistedDelivery: async (sessionId, deliveryId) => (
      history.get(sessionId)?.has(deliveryId) || false
    ),
    getSessionRecoveryState: () => ({ classifyState: 'D' }),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  await rebuilt.start();
  assert.equal(rebuilt.hasPending('D'), false);
  assert.equal(injections.length, 1);
  assert.match(injections[0].text, /延迟条件已到.*重新检查部署状态/);
  assert.equal(injections[0].opts.deliveryId, `wait:${registered.id}`);
  assert.equal((await rebuilt.outbox.get(`wait:${registered.id}`)).state, 'delivered');

  await rebuilt.tick();
  assert.equal(injections.length, 1, 'resolved delay is never delivered twice');
  await rebuilt.stop();
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

// The operation + request outbox row land in one atomic write; that write is the
// admission commit point. Refreshing the queue projection afterwards is an
// observer of already-durable work, so its failure may degrade the queue view
// but must never be reported to the caller as "not submitted".
test('a failed queue projection does not un-admit a durably committed dispatch', async t => {
  let writes = 0;
  const { logs, runtime } = fixture(t, {
    storeOptions: {
      hooks: {
        // Write #1 is the atomic admission; write #2 is the projection refresh
        // inside noteQueued. Fail only the observer.
        beforeRename: () => {
          writes += 1;
          if (writes === 2) throw new Error('projection write failed');
        },
      },
    },
  });
  const spec = {
    ownerSessionId: 'owner',
    resultSessionId: 'owner',
    idempotencyKey: 'projection-degraded-1',
    spec: { targetId: 'B', chatId: 'B', message: 'do the work', oneWay: true },
  };

  const admitted = await runtime.admitDispatch(spec);
  assert.equal(admitted.status, 'admitted');
  assert.ok(admitted.id, 'the caller still receives its operation id');

  const stored = await runtime.operations.get(admitted.id);
  assert.equal(stored.status, 'admitted', 'the admission is durable on disk');
  assert.equal(
    (await runtime.outbox.get(admitted.requestOutboxId)).state,
    'pending',
    'the request row survives for the worker tick to pick up',
  );
  assert.equal(
    logs.some(line => line.includes('admission_queue_projection_degraded')
      && line.includes(admitted.id)),
    true,
    'the degraded projection is reported as a structured warning',
  );

  // The same request must still deduplicate onto the same durable operation —
  // a lost projection cannot cause the caller to submit the work twice.
  const replay = await runtime.admitDispatch(spec);
  assert.equal(replay.id, admitted.id);
  assert.equal(replay.idempotent, true);
});

// Regression: the worker froze for every session because one delivery never
// settled. A task-bound admission holds the session's workspace key for the
// whole admission and awaits runtime.tick() from inside it; the tick claimed
// that same session's item and then blocked in beforeDeliver waiting for the
// very key its caller was holding. Since every tick chains onto tickTail, that
// one stuck promise stopped delivery — and lease recovery — process-wide.
test('an admission holding the session key does not deadlock the worker tick', async t => {
  let keyHeld = false;
  let releaseKey = null;
  const keyFree = new Promise(resolve => { releaseKey = resolve; });
  const h = fixture(t, {
    isDeliveryLocked: sessionId => sessionId === 'bound-1' && keyHeld,
    // Mirrors acquireDelivery: it blocks until the workspace key is free.
    beforeDeliver: async () => { if (keyHeld) await keyFree; },
  });

  keyHeld = true;
  const admitted = await withTimeout(h.runtime.admitSessionWork({
    sessionId: 'bound-1', text: 'release 1.6.1', idempotencyKey: 'task-start-1', options: {},
  }), 2000, 'admitSessionWork deadlocked on the session workspace key');
  assert.equal(admitted.ok, true);
  assert.equal(h.injections.length, 0, 'the locked session must not be delivered yet');

  keyHeld = false;
  releaseKey();
  await h.runtime.tick();
  assert.equal(h.injections.length, 1, 'the item delivers on the next tick once the key is free');
  assert.equal(h.injections[0].sessionId, 'bound-1');
  await h.runtime.stop();
});

test('a delivery that never settles releases the tick instead of freezing the worker', async t => {
  let unblock = null;
  const stuck = new Promise(resolve => { unblock = resolve; });
  let firstDelivery = true;
  const h = fixture(t, {
    deliveryWatchdogMs: 50,
    beforeDeliver: async () => {
      if (!firstDelivery) return;
      firstDelivery = false;
      await stuck;
    },
  });

  await h.runtime.admitSessionWork({
    sessionId: 'stuck-1', text: 'hangs', idempotencyKey: 'hangs-1', options: {},
  });
  // Without the watchdog this tick — and every tick chained behind it — never
  // returns, so the second session below could never be delivered.
  await withTimeout(h.runtime.tick(), 2000, 'the worker tick was frozen by a stuck delivery');

  await withTimeout(h.runtime.admitSessionWork({
    sessionId: 'other-1', text: 'unrelated', idempotencyKey: 'unrelated-1', options: {},
  }), 2000, 'a stuck delivery froze admission for an unrelated session');
  assert.ok(
    h.injections.some(injection => injection.sessionId === 'other-1'),
    'an unrelated session keeps being delivered while one delivery hangs',
  );
  assert.ok(
    h.logs.some(message => /still unsettled after 50ms/.test(message)),
    'the watchdog reports which delivery it released the tick from',
  );

  // The parked item must not be re-delivered while its original attempt is
  // still running, even after its lease expires.
  h.clock.value += 10_000;
  await withTimeout(h.runtime.tick(), 2000, 'the worker tick was frozen by a stuck delivery');
  assert.equal(
    h.injections.filter(injection => injection.sessionId === 'stuck-1').length, 0,
    'an unsettled delivery is never claimed a second time',
  );

  unblock();
  await h.runtime.stop();
});
