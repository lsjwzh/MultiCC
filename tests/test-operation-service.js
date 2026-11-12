'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createOperationService, OperationConflictError } = require('../src/operation-service');
const { createOrchestrationStore } = require('../src/orchestration/store');

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
      taskId: 'task-1',
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
  // The result runs as the dispatcher's own turn; carrying the worker task's
  // identity here pinned the worker card to 执行中 and wedged the dispatcher.
  assert.equal(outboxEntry.payload.taskId, undefined);
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

test('recovery references omit message and result bodies while public operation reads remain isolated', async t => {
  const { service } = fixture(t);
  const message = 'large-dispatch-body:'.repeat(4096);
  const operation = await service.admitDispatch({ ownerSessionId: 'parent', idempotencyKey: 'private-key',
    spec: { chatId: 'child', targetId: 'target', taskId: 'task', message, resultMode: 'sync', oneWay: true } });
  await service.completeDispatch(operation.id, { status: 'completed', text: message, detail: { value: 7 } });
  const [reference] = await service.listReferences({ kind: 'dispatch', ownerSessionId: 'parent' });
  assert.equal(reference.id, operation.id);
  assert.deepEqual(reference.spec, { chatId: 'child', targetId: 'target', taskId: 'task', resultMode: 'sync', oneWay: true });
  assert.equal('result' in reference, false);
  assert.equal('idempotencyKeyHash' in reference, false);
  assert.equal(typeof reference.completedAt, 'number');
  assert.equal(typeof reference.updatedAt, 'number');
  assert.deepEqual(await service.listReferences({ statuses: ['completed'], excludeTerminal: true }), []);
  const full = await service.get(operation.id);
  assert.equal(full.spec.message, message);
  assert.equal(full.result.text, message);
  assert.equal('requestHash' in full, false);
  full.spec.message = 'changed by reader';
  full.result.detail.value = 8;
  const [listed] = await service.list({ ownerSessionId: 'parent' });
  assert.equal(listed.spec.message, message);
  assert.equal(listed.result.detail.value, 7);
  listed.result.detail.value = 9;
  assert.equal((await service.get(operation.id)).result.detail.value, 7);
});

test('native recovery references never access heavy bodies and still exclude requested terminal states', async () => {
  const body = { chatId: 'child', targetId: 'target', taskId: 'task', resultMode: 'sync', oneWay: false };
  Object.defineProperty(body, 'message', { enumerable: true, get() { throw new Error('read dispatch body'); } });
  const rows = [
    { id: 'active', kind: 'dispatch', ownerSessionId: 'parent', status: 'running', createdAt: 2, spec: body },
    { id: 'finished', kind: 'dispatch', ownerSessionId: 'parent', status: 'completed', createdAt: 1, spec: body },
  ];
  for (const row of rows) Object.defineProperty(row, 'result', { enumerable: true, get() { throw new Error('read result body'); } });
  const service = createOperationService({ store: {
    mutate() { throw new Error('unexpected write'); }, read() { throw new Error('full collection read'); },
    async select(collection, { fields }) {
      assert.equal(collection, 'operations');
      return rows.map(row => {
        const result = {};
        for (const field of fields) {
          const [root, child] = field.split('.');
          if (child) (result[root] ||= {})[child] = row[root]?.[child];
          else result[root] = row[root];
        }
        return result;
      });
    },
  } });
  assert.deepEqual((await service.listReferences({ statuses: ['running', 'completed'], excludeTerminal: true }))
    .map(row => row.id), ['active']);
});

test('startup task interruption uses indexed active rows without enumerating terminal history', async () => {
  const active = { id: 'live', taskId: 'cli-task', parentSessionId: 'parent', status: 'running' };
  const history = new Proxy({}, { ownKeys() { throw new Error('enumerated historical tasks'); } });
  const draft = { tasks: history, outbox: {}, nextOutboxSequence: 1,
    select(collection, { where }) {
      assert.equal(collection, 'tasks');
      assert.deepEqual(where.status.$nin, ['completed', 'failed', 'interrupted', 'cancelled']);
      return [active];
    } };
  const service = createOperationService({ now: () => 100, store: {
    mutate: async fn => fn(draft), read: async fn => fn(draft),
  } });
  assert.equal((await service.interruptActiveTasks())[0].status, 'interrupted');
  assert.equal(draft.outbox['task:live:interrupted'].payload.taskId, 'cli-task');
  assert.equal(active.completedAt, 100);
});
