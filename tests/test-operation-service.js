'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createOperationService, OperationConflictError } = require('../src/operation-service');
const { createOrchestrationStore } = require('../src/orchestration-store');

function fixture(t, { hooks = {}, clock = { value: 1_000 } } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-operation-data-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'orchestration.json');
  const store = createOrchestrationStore({ file, now: () => ++clock.value, hooks });
  let sequence = 0;
  const service = createOperationService({
    store,
    now: () => ++clock.value,
    idFactory: () => `op_test_${++sequence}`,
  });
  return { dataDir, file, store, service, clock };
}

test('detached admission stores only an idempotency hash and rejects key reuse with different content', async t => {
  const { file, service } = fixture(t);
  const spec = { command: 'build --safe', cwd: '/tmp/project', label: 'build' };
  const first = await service.admitDetached({
    sessionId: 'parent-A',
    idempotencyKey: 'raw-detached-secret',
    spec,
  });
  const duplicate = await service.admitDetached({
    sessionId: 'parent-A',
    idempotencyKey: 'raw-detached-secret',
    spec: { label: 'build', cwd: '/tmp/project', command: 'build --safe' },
  });

  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.idempotent, true);
  assert.equal(first.externalId.startsWith('d_'), true);
  await assert.rejects(
    service.admitDetached({
      sessionId: 'parent-A',
      idempotencyKey: 'raw-detached-secret',
      spec: { ...spec, command: 'deploy --unsafe' },
    }),
    error => error instanceof OperationConflictError && error.statusCode === 409,
  );

  const disk = fs.readFileSync(file, 'utf8');
  assert.equal(disk.includes('raw-detached-secret'), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('detached completion and result delivery survive an after-rename crash as one mutation', async t => {
  let crashAfterRename = false;
  const { file, service } = fixture(t, {
    hooks: {
      afterRename() {
        if (crashAfterRename) throw new Error('simulated crash after rename');
      },
    },
  });
  const admitted = await service.admitDetached({
    sessionId: 'parent-A',
    spec: { command: 'compile', cwd: '/tmp', label: 'compile' },
  });

  crashAfterRename = true;
  await assert.rejects(
    service.completeDetached(admitted.id, { exitCode: 0, logTail: 'DONE' }),
    /simulated crash after rename/,
  );
  crashAfterRename = false;

  const rebuiltStore = createOrchestrationStore({ file });
  const rebuilt = createOperationService({ store: rebuiltStore });
  const operation = await rebuilt.get(admitted.id);
  const snapshot = await rebuiltStore.snapshot();
  assert.equal(operation.status, 'completed');
  assert.equal(operation.result.exitCode, 0);
  assert.equal(snapshot.outbox[`operation:${admitted.id}:result`].state, 'pending');
  assert.equal(snapshot.outbox[`operation:${admitted.id}:result`].sessionId, 'parent-A');
});

test('dispatch request/result outboxes are atomic and duplicate results are payload-idempotent', async t => {
  const { store, service } = fixture(t);
  const admitted = await service.admitDispatch({
    ownerSessionId: 'commander',
    resultSessionId: 'commander',
    idempotencyKey: 'dispatch-42',
    spec: {
      targetId: 'worker',
      targetLabel: 'Worker',
      chatId: 'worker-chat',
      message: 'inspect module',
      replyTo: 'commander',
      gateway: false,
      taskId: 'tsk-stable',
      taskStart: true,
      taskSource: 'task-board',
      taskText: '完整真实正文',
    },
  });
  let snapshot = await store.snapshot();
  assert.equal(snapshot.operations[admitted.id].requestOutboxId, `operation:${admitted.id}:request`);
  assert.equal(snapshot.outbox[`operation:${admitted.id}:request`].payload.type, 'dispatch.request');
  assert.deepEqual(
    {
      taskId: snapshot.outbox[`operation:${admitted.id}:request`].payload.taskId,
      taskStart: snapshot.outbox[`operation:${admitted.id}:request`].payload.taskStart,
      taskSource: snapshot.outbox[`operation:${admitted.id}:request`].payload.taskSource,
      taskText: snapshot.outbox[`operation:${admitted.id}:request`].payload.taskText,
    },
    {
      taskId: 'tsk-stable',
      taskStart: true,
      taskSource: 'task-board',
      taskText: '完整真实正文',
    },
  );

  const first = await service.completeDispatch(admitted.id, {
    status: 'completed', text: 'all clear', details: { b: 2, a: 1 },
  });
  const duplicate = await service.completeDispatch(admitted.id, {
    details: { a: 1, b: 2 }, text: 'all clear', status: 'completed',
  });
  assert.equal(first.idempotent, false);
  assert.equal(duplicate.idempotent, true);
  await assert.rejects(
    service.completeDispatch(admitted.id, { status: 'completed', text: 'different' }),
    error => error instanceof OperationConflictError && error.statusCode === 409,
  );

  snapshot = await store.snapshot();
  assert.deepEqual(
    Object.keys(snapshot.outbox).filter(id => id.includes(admitted.id)).sort(),
    [`operation:${admitted.id}:request`, `operation:${admitted.id}:result`],
  );
});

test('one-way Commander dispatch completes durably without a result outbox', async t => {
  const { store, service } = fixture(t);
  const admitted = await service.admitDispatch({
    ownerSessionId: 'commander',
    resultSessionId: 'commander',
    idempotencyKey: 'one-way-1',
    spec: {
      targetId: 'worker', chatId: 'worker', message: 'implement',
      replyTo: null, gateway: false, oneWay: true,
    },
  });
  const completed = await service.completeDispatch(admitted.id, {
    status: 'completed', text: 'done',
  });
  assert.equal(completed.ok, true);
  const operation = await service.get(admitted.id);
  const snapshot = await store.snapshot();
  assert.equal(operation.status, 'completed');
  assert.equal(operation.resultOutboxId, null);
  assert.equal(snapshot.outbox[`operation:${admitted.id}:request`].payload.type, 'dispatch.request');
  assert.equal(snapshot.outbox[`operation:${admitted.id}:result`], undefined);
});

test('async dispatch completes durably and emits a backflow outbox entry', async t => {
  const { store, service } = fixture(t);
  const admitted = await service.admitDispatch({
    ownerSessionId: 'master',
    resultSessionId: 'master',
    idempotencyKey: 'async-return-1',
    spec: {
      targetId: 'worker', chatId: 'worker', message: 'implement',
      replyTo: 'master', gateway: false, oneWay: false, resultMode: 'async',
      taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 8,
    },
  });
  await service.completeDispatch(admitted.id, {
    status: 'completed', text: 'done', source: 'dispatch_slave',
  });
  const operation = await service.get(admitted.id);
  const snapshot = await store.snapshot();
  assert.equal(operation.status, 'completed');
  assert.equal(operation.result.text, 'done');
  const outboxEntry = snapshot.outbox[`operation:${admitted.id}:result`];
  assert.ok(outboxEntry, 'backflow outbox entry must exist for resultMode=async');
  assert.equal(outboxEntry.payload.type, 'dispatch.result');
  assert.equal(outboxEntry.payload.taskId, 'task-1');
  assert.equal(outboxEntry.payload.taskRunId, 'run-1');
  assert.equal(outboxEntry.payload.leaseEpoch, 8);
  assert.match(outboxEntry.payload.deliveryText, /📜 dispatch 结果回流/);
  assert.match(outboxEntry.payload.deliveryText, /done/);
});

test('sync dispatch completes durably without inserting a result message', async t => {
  const { store, service } = fixture(t);
  const admitted = await service.admitDispatch({
    ownerSessionId: 'master',
    resultSessionId: 'master',
    idempotencyKey: 'sync-return-1',
    spec: {
      targetId: 'worker', chatId: 'worker', message: 'implement',
      replyTo: 'master', gateway: false, oneWay: false, resultMode: 'sync',
    },
  });
  await service.completeDispatch(admitted.id, {
    status: 'completed', text: 'inline result', source: 'post_turn',
  });
  const operation = await service.get(admitted.id);
  const snapshot = await store.snapshot();
  assert.equal(operation.result.text, 'inline result');
  assert.equal(operation.resultOutboxId, null);
  assert.equal(snapshot.outbox[`operation:${admitted.id}:result`], undefined);
});

test('an unleased TaskRun dispatch can be cancelled atomically before first delivery', async t => {
  const { store, service } = fixture(t);
  const admitted = await service.admitDispatch({
    operationId: 'run-queued',
    ownerSessionId: 'commander',
    resultSessionId: 'commander',
    idempotencyKey: 'queued-run',
    spec: {
      targetId: 'slot-1', chatId: 'slot-1', message: 'execute later',
      oneWay: true, taskId: 'task-1', taskRunId: 'run-queued', leaseEpoch: 7,
    },
  });
  assert.equal(admitted.status, 'admitted');

  assert.deepEqual(await service.cancelUndeliveredDispatch('run-queued', {
    taskRunId: 'another-run',
  }), { ok: false, code: 'task_run_mismatch' });

  const cancelled = await service.cancelUndeliveredDispatch('run-queued', {
    taskRunId: 'run-queued', reason: 'task marked done before start',
  });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.neverDelivered, true);
  assert.equal(cancelled.idempotent, false);

  let snapshot = await store.snapshot();
  assert.equal(snapshot.operations['run-queued'].status, 'cancelled');
  assert.equal(snapshot.operations['run-queued'].result.disposition, 'never_delivered');
  assert.equal(snapshot.outbox['operation:run-queued:request'].state, 'cancelled');
  assert.equal(snapshot.outbox['operation:run-queued:request'].lastError,
    'task marked done before start');
  assert.equal(snapshot.outbox['operation:run-queued:request'].payload.message, undefined);
  assert.deepEqual(snapshot.outbox['operation:run-queued:request'].payload.messageRef,
    { taskRunId: 'run-queued' });
  assert.equal(snapshot.operations['run-queued'].spec.message, undefined);

  const replay = await service.cancelUndeliveredDispatch('run-queued', {
    taskRunId: 'run-queued', reason: 'different retry wording',
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.neverDelivered, true);
  assert.equal(replay.idempotent, true);
  snapshot = await store.snapshot();
  assert.equal(snapshot.outbox['operation:run-queued:request'].state, 'cancelled');
});

test('TaskRun pre-delivery cancellation fails closed after the outbox item is leased', async t => {
  const { store, service } = fixture(t);
  await service.admitDispatch({
    operationId: 'run-leased',
    ownerSessionId: 'commander',
    spec: {
      targetId: 'slot-1', chatId: 'slot-1', message: 'execute now',
      oneWay: true, taskId: 'task-1', taskRunId: 'run-leased', leaseEpoch: 8,
    },
  });
  await store.mutate(draft => {
    const item = draft.outbox['operation:run-leased:request'];
    item.state = 'leased';
    item.leaseOwner = 'worker';
    item.leasedAt = 10;
    item.leasedUntil = 20;
    item.leaseTokenHash = 'a'.repeat(64);
  });

  assert.deepEqual(await service.cancelUndeliveredDispatch('run-leased', {
    taskRunId: 'run-leased',
  }), { ok: false, code: 'dispatch_delivery_in_progress' });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.operations['run-leased'].status, 'admitted');
  assert.equal(snapshot.outbox['operation:run-leased:request'].state, 'leased');
});

test('task ledger records terminal output and interrupts only unproven active tasks', async t => {
  const { store, service } = fixture(t);
  await service.observeTask({
    sessionId: 'parent', taskId: 'done-1', status: 'running',
    detail: { kind: 'agent-task', description: 'finished task' },
  });
  await service.observeTask({
    sessionId: 'parent', taskId: 'done-1', status: 'completed',
    detail: { lastOutput: 'verified output' },
  });
  await service.observeTask({
    sessionId: 'parent', taskId: 'done-1', status: 'failed',
    detail: { error: 'late contradictory event' },
  });
  await service.observeTask({
    sessionId: 'parent', taskId: 'live-1', status: 'running',
    detail: { kind: 'background-task', description: 'unproven task' },
  });

  const interrupted = await service.interruptActiveTasks();
  assert.deepEqual(interrupted.map(entry => entry.taskId), ['live-1']);
  const tasks = await service.listTasks({ sessionId: 'parent' });
  assert.equal(tasks.find(entry => entry.taskId === 'done-1').status, 'completed');
  assert.equal(tasks.find(entry => entry.taskId === 'done-1').lastOutput, 'verified output');
  assert.equal(tasks.find(entry => entry.taskId === 'done-1').error, null);
  assert.equal(tasks.find(entry => entry.taskId === 'live-1').status, 'interrupted');

  const snapshot = await store.snapshot();
  const notifications = Object.values(snapshot.outbox)
    .filter(item => item.payload.type === 'task.interrupted');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].sessionId, 'parent');
});

test('schema v1 wait/outbox state migrates without losing existing records', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-operation-v1-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'orchestration.json');
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    revision: 3,
    updatedAt: 10,
    nextOutboxSequence: 2,
    waits: { old: { id: 'old' } },
    outbox: { old: { id: 'old' } },
  }), { mode: 0o600 });

  const store = createOrchestrationStore({ file });
  const before = await store.snapshot();
  assert.equal(before.schemaVersion, 3);
  assert.equal(before.waits.old.id, 'old');
  assert.deepEqual(before.operations, {});
  assert.deepEqual(before.sessionSchedules, {});
  await store.mutate(draft => { draft.migrated = true; });
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.schemaVersion, 3);
  assert.equal(disk.outbox.old.id, 'old');
});
