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
    },
  });
  let snapshot = await store.snapshot();
  assert.equal(snapshot.operations[admitted.id].requestOutboxId, `operation:${admitted.id}:request`);
  assert.equal(snapshot.outbox[`operation:${admitted.id}:request`].payload.type, 'dispatch.request');

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
  assert.equal(before.schemaVersion, 2);
  assert.equal(before.waits.old.id, 'old');
  assert.deepEqual(before.operations, {});
  await store.mutate(draft => { draft.migrated = true; });
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.schemaVersion, 2);
  assert.equal(disk.outbox.old.id, 'old');
});
