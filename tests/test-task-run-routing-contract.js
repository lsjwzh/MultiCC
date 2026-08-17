'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createCommanderRouter, WORKER_TYPE } = require('../src/commander-router');
const { normalizeTurnRequest } = require('../src/chat/turn-request');
const { createOperationService } = require('../src/operation-service');
const { createSessionQueryService } = require('../src/session/query-service');

function memoryStore() {
  const state = {
    operations: {}, outbox: {}, tasks: {}, waits: {}, sessionSchedules: {},
    nextOutboxSequence: 1, revision: 0, updatedAt: 0,
  };
  return {
    state,
    async mutate(fn) { return fn(state); },
    async read(fn) { return fn(state); },
  };
}

function worker(id, overrides = {}) {
  return {
    id, dirId: 'fleet', kind: 'chat', type: WORKER_TYPE,
    label: id, rolePrompt: 'worker', cli: 'claude',
    ...overrides,
  };
}

test('task-run dispatch creates and reuses only bounded internal execution slots', async () => {
  const records = new Map([
    ['commander', { id: 'commander', dirId: 'fleet', kind: 'chat', type: 'commander' }],
    ['visible-worker', worker('visible-worker')],
  ]);
  const busy = new Set();
  const creates = [];
  const dispatches = [];
  const router = createCommanderRouter({
    records,
    isBusy: id => busy.has(id),
    maxElasticWorkers: 2,
    stampWorker() { throw new Error('legacy workers are irrelevant to task-run pool'); },
    createWorker({ commander, ordinal, rolePrompt, taskExecutionSlot }) {
      const record = worker(`slot-${ordinal}`, {
        dirId: commander.dirId,
        rolePrompt,
        ephemeral: true,
        elasticWorker: true,
        taskExecutionSlot,
      });
      records.set(record.id, record);
      creates.push(record);
      return { ok: true, id: record.id, session: record };
    },
    async dispatchOneWay(target, message, options) {
      dispatches.push({ target, message, options });
      return { ok: true, operationId: options.taskRunId, status: 'admitted' };
    },
    logger: { warn() {} },
  });

  const first = await router.route({
    commanderId: 'commander', message: 'first', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 1,
  });
  assert.equal(first.targetSessionId, 'slot-1');
  assert.equal(creates[0].taskExecutionSlot, true);
  assert.notEqual(first.targetSessionId, 'visible-worker');
  busy.add(first.targetSessionId);

  const second = await router.route({
    commanderId: 'commander', message: 'second', taskId: 'task-2',
    taskRunId: 'run-2', leaseEpoch: 1,
  });
  assert.equal(second.targetSessionId, 'slot-2');
  busy.add(second.targetSessionId);

  const third = await router.route({
    commanderId: 'commander', message: 'third', taskId: 'task-3',
    taskRunId: 'run-3', leaseEpoch: 1,
  });
  assert.equal(third.queued, true);
  assert.equal(creates.length, 2, 'pool cap prevents unbounded session/worktree growth');
  assert.equal(dispatches[2].options.taskRunId, 'run-3');
  assert.equal(dispatches[2].options.leaseEpoch, 1);
});

test('task-run routing refuses CLIs without an exact native transcript cleanup adapter', async () => {
  const records = new Map([
    ['commander', {
      id: 'commander', dirId: 'fleet', kind: 'chat', type: 'commander', cli: 'qoder',
    }],
    ['visible-qoder', worker('visible-qoder', { cli: 'qoder' })],
  ]);
  let creates = 0;
  let dispatches = 0;
  const router = createCommanderRouter({
    records,
    isBusy: () => false,
    maxElasticWorkers: 2,
    stampWorker() {},
    createWorker() { creates += 1; return { ok: false }; },
    async dispatchOneWay() { dispatches += 1; return { ok: true }; },
    logger: { warn() {} },
  });

  const result = await router.route({
    commanderId: 'commander', message: 'must remain durable', taskId: 'task-unsupported',
    taskRunId: 'run-unsupported', leaseEpoch: 1,
  });

  assert.deepEqual(result, { ok: false, code: 'task_run_cli_unsupported' });
  assert.equal(creates, 0, 'an unsupported slot must not be created and later partially cleaned');
  assert.equal(dispatches, 0);
});

test('quarantined slots count against the cap but can never receive another run', async () => {
  const records = new Map([
    ['commander', { id: 'commander', dirId: 'fleet', kind: 'chat', type: 'commander' }],
    ['slot-1', worker('slot-1', { taskExecutionSlot: true, taskRunQuarantined: true })],
    ['slot-2', worker('slot-2', { taskExecutionSlot: true, taskRunQuarantined: true })],
  ]);
  let creates = 0;
  let dispatches = 0;
  const router = createCommanderRouter({
    records,
    isBusy: () => false,
    maxElasticWorkers: 2,
    stampWorker() {},
    createWorker() { creates += 1; return { ok: false }; },
    async dispatchOneWay() { dispatches += 1; return { ok: true }; },
    logger: { warn() {} },
  });
  const result = await router.route({
    commanderId: 'commander', message: 'must not run', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 1,
  });
  assert.equal(result.code, 'worker_unavailable');
  assert.equal(creates, 0, 'quarantined capacity cannot cause unbounded replacement slots');
  assert.equal(dispatches, 0);
});

test('task-run identity survives dispatch operation and outbox persistence', async () => {
  const store = memoryStore();
  const operations = createOperationService({ store, now: () => 100, idFactory: () => 'op-generated' });
  const admitted = await operations.admitDispatch({
    operationId: 'run-1',
    ownerSessionId: 'commander',
    idempotencyKey: 'task-run-1',
    spec: {
      targetId: 'slot-1', chatId: 'slot-1', message: 'execute',
      taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 7,
      taskStart: true, taskSource: 'task-board', taskText: 'original',
    },
  });
  assert.equal(admitted.id, 'run-1');
  const item = store.state.outbox['operation:run-1:request'];
  assert.equal(item.payload.taskRunId, 'run-1');
  assert.equal(item.payload.leaseEpoch, 7);
  assert.equal(store.state.operations['run-1'].spec.taskRunId, 'run-1');
});

test('turn request carries task-run fencing and forces fresh native history', () => {
  const request = normalizeTurnRequest({
    sessionId: 'slot-1', text: 'execute', cli: 'codex', turnCount: 12,
    hasNativeSession: true, forceFirstTurn: true,
    originDispatchId: 'run-1', taskId: 'task-1', taskRunId: 'run-1',
    leaseEpoch: 4, taskStart: true, taskSource: 'task-board', taskText: 'execute',
  });
  assert.equal(request.task.id, 'task-1');
  assert.equal(request.task.runId, 'run-1');
  assert.equal(request.task.leaseEpoch, 4);
  assert.equal(request.execution.historyIntent, 'first');
  assert.equal(request.execution.resume, false);

  assert.throws(() => normalizeTurnRequest({
    sessionId: 'slot-1', text: 'bad', cli: 'codex', turnCount: 0,
    taskRunId: 'run-orphan', leaseEpoch: 1,
  }), /taskRunId requires taskId/);
});

test('internal task execution slots are absent from ordinary session queries', () => {
  const records = [
    worker('visible-worker'),
    worker('slot-1', { taskExecutionSlot: true, ephemeral: true }),
  ];
  const service = createSessionQueryService({
    records: {
      list: () => records,
      get: id => records.find(record => record.id === id),
    },
    runtime: { read: () => ({ active: false, clients: 0 }) },
  });
  assert.deepEqual(service.list().map(session => session.id), ['visible-worker']);
  assert.equal(service.get('slot-1'), null);
  assert.equal(service.get('slot-1', { includeHidden: true }), null);
  assert.equal(
    service.get('slot-1', { includeTaskExecutionSlots: true }).id,
    'slot-1',
  );
});
