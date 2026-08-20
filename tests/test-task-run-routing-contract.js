'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

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

// #38 · the pooled router that owned this constant is retired; the query
// service contract below still has to hold for ordinary worker records.
const WORKER_TYPE = 'worker';

function worker(id, overrides = {}) {
  return {
    id, dirId: 'fleet', kind: 'chat', type: WORKER_TYPE,
    label: id, rolePrompt: 'worker', cli: 'claude',
    ...overrides,
  };
}

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
