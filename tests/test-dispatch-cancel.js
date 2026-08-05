'use strict';

// dispatch_cancel + queue-disposition receipts.
//
// The two capabilities pinned here answer the same operational failure:
// re-routing a dispatched task used to mean sending a second copy, because
// the master neither knew where the first one landed (FIFO? running?) nor
// had a way to withdraw it. The receipts must say where the task landed, and
// dispatch_cancel must settle the operation in every disposition — queued,
// running, untracked — without ever letting a bystander session touch it.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createOperationService } = require('../src/operation-service');
const { createOrchestrationStore } = require('../src/orchestration-store');
const { createRouterToolRuntime } = require('../src/router-tool-runtime');

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-dispatch-cancel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createOrchestrationStore({ file: path.join(dir, 'orchestration.json') });
  let sequence = 0;
  const operations = createOperationService({
    store,
    idFactory: () => `op_cancel_${++sequence}`,
  });
  const records = new Map([
    ['caller', { id: 'caller', dirId: 'dir-a', kind: 'chat', type: 'worker' }],
    ['other', { id: 'other', dirId: 'dir-a', kind: 'chat', type: 'worker' }],
    ['worker-a', { id: 'worker-a', dirId: 'dir-a', kind: 'chat', type: 'worker' }],
  ]);
  const calls = {
    cancelQueuedEntry: [],
    cancelActiveTurn: [],
    onDispatchCancelled: [],
    schedulerStatus: [],
  };
  const fakes = {
    // Default: the entry is still pending in the FIFO and removes cleanly.
    cancelQueuedEntry: async (sessionId, entryId, opts) => {
      calls.cancelQueuedEntry.push({ sessionId, entryId, opts });
      return { ok: true };
    },
    schedulerStatus: async (sessionId) => {
      calls.schedulerStatus.push(sessionId);
      return { active: null, queued: [] };
    },
    cancelActiveTurnFn: async (sessionId, opts) => {
      calls.cancelActiveTurn.push({ sessionId, opts });
    },
    onDispatchCancelled: (operationId) => {
      calls.onDispatchCancelled.push(operationId);
    },
  };
  const runtime = createRouterToolRuntime({
    records,
    dispatchToSession: async (targetId, message, opts) => {
      const admitted = await operations.admitDispatch({
        ownerSessionId: opts.ownerSessionId,
        resultSessionId: opts.ownerSessionId,
        idempotencyKey: opts.idempotencyKey,
        spec: {
          targetId,
          targetLabel: targetId,
          chatId: targetId,
          message,
          replyTo: opts.replyTo || null,
          gateway: false,
          oneWay: opts.oneWay,
          resultMode: opts.resultMode,
        },
      });
      return {
        ok: true,
        operationId: admitted.id,
        status: admitted.status,
        duplicate: admitted.idempotent,
        chatId: targetId,
        ...(fakes.queue ? { queue: fakes.queue } : {}),
      };
    },
    operations,
    completeDispatch: (id, result) => operations.completeDispatch(id, result),
    recordUserInput: async () => ({ ok: true, duplicate: false }),
    registerExternalWait: async () => { throw new Error('not used here'); },
    getExternalWait: async () => null,
    listExternalWaits: async () => [],
    cancelExternalWait: async () => ({ ok: true }),
    schedulerStatus: (id) => fakes.schedulerStatus(id),
    cancelQueuedEntry: (id, entryId, opts) => fakes.cancelQueuedEntry(id, entryId, opts),
    cancelActiveTurnFn: (id, opts) => fakes.cancelActiveTurnFn(id, opts),
    onDispatchCancelled: (id) => fakes.onDispatchCancelled(id),
    ...overrides,
  });
  return { calls, fakes, operations, records, runtime, store };
}

async function admitOne(runtime, queue) {
  const capability = runtime.issueContext({ sessionId: 'caller', turnId: 'turn-dispatch' });
  const result = await runtime.execute(capability, 'route_task', {
    target_session_id: 'worker-a',
    message: '翻译 9 张主图',
  });
  assert.equal(result.ok, true);
  return result;
}

test('route_task receipt reports a FIFO landing with position and re-route guidance', async t => {
  const { runtime, fakes } = fixture(t);
  fakes.queue = { state: 'queued', position: 2, length: 3 };
  const result = await admitOne(runtime);
  assert.equal(result.queued, true);
  assert.equal(result.queue_state, 'queued');
  assert.equal(result.queue_position, 2);
  assert.equal(result.queue_length, 3);
  assert.match(result.instruction, /dispatch_cancel/);
});

test('route_task receipt reports an immediate start truthfully', async t => {
  const { runtime, fakes } = fixture(t);
  fakes.queue = { state: 'started' };
  const result = await admitOne(runtime);
  assert.equal(result.queued, false);
  assert.equal(result.queue_state, 'started');
  assert.equal('queue_position' in result, false);
});

test('cancelling a queued dispatch removes it from the FIFO and settles the operation', async t => {
  const { runtime, fakes, operations, calls } = fixture(t);
  fakes.queue = { state: 'queued', position: 1, length: 1 };
  const admitted = await admitOne(runtime);
  const capability = runtime.issueContext({ sessionId: 'caller', turnId: 'turn-cancel' });
  const result = await runtime.execute(capability, 'dispatch_cancel', {
    operation_id: admitted.operation_id,
    reason: '改派到别处',
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.disposition, 'queued');
  assert.deepEqual(calls.cancelQueuedEntry, [{
    sessionId: 'worker-a',
    entryId: `operation:${admitted.operation_id}:request`,
    opts: { actor: 'caller', reason: '改派到别处' },
  }]);
  assert.deepEqual(calls.onDispatchCancelled, [admitted.operation_id]);
  const operation = await operations.get(admitted.operation_id);
  assert.equal(operation.status, 'cancelled');
  assert.equal(operation.result.reason, '改派到别处');
});

test('a second cancel is an idempotent no-op reporting the terminal status', async t => {
  const { runtime, fakes, calls } = fixture(t);
  fakes.queue = { state: 'queued', position: 1, length: 1 };
  const admitted = await admitOne(runtime);
  const capability = runtime.issueContext({ sessionId: 'caller', turnId: 'turn-cancel' });
  await runtime.execute(capability, 'dispatch_cancel', { operation_id: admitted.operation_id });
  const again = await runtime.execute(capability, 'dispatch_cancel', { operation_id: admitted.operation_id });
  assert.equal(again.ok, true);
  assert.equal(again.already_terminal, true);
  assert.equal(again.status, 'cancelled');
  assert.equal(calls.cancelQueuedEntry.length, 1);
});

test('only the dispatching session may cancel its own dispatch', async t => {
  const { runtime, fakes } = fixture(t);
  fakes.queue = { state: 'queued', position: 1, length: 1 };
  const admitted = await admitOne(runtime);
  const stranger = runtime.issueContext({ sessionId: 'other', turnId: 'turn-stranger' });
  await assert.rejects(
    runtime.execute(stranger, 'dispatch_cancel', { operation_id: admitted.operation_id }),
    error => error.code === 'forbidden' && error.statusCode === 403,
  );
});

test('cancelling an unknown operation is a 404', async t => {
  const { runtime } = fixture(t);
  const capability = runtime.issueContext({ sessionId: 'caller', turnId: 'turn-cancel' });
  await assert.rejects(
    runtime.execute(capability, 'dispatch_cancel', { operation_id: 'op_missing' }),
    error => error.code === 'operation_not_found' && error.statusCode === 404,
  );
});

test('a running task refuses cancellation without cancel_running=true', async t => {
  const { runtime, fakes, operations } = fixture(t);
  fakes.queue = { state: 'started' };
  const admitted = await admitOne(runtime);
  fakes.cancelQueuedEntry = async () => ({ ok: false, code: 'queued_entry_already_claimed' });
  fakes.schedulerStatus = async () => ({
    active: { entryId: `operation:${admitted.operation_id}:request` },
    queued: [],
  });
  const capability = runtime.issueContext({ sessionId: 'caller', turnId: 'turn-cancel' });
  await assert.rejects(
    runtime.execute(capability, 'dispatch_cancel', { operation_id: admitted.operation_id }),
    error => error.code === 'already_running' && error.statusCode === 409,
  );
  const operation = await operations.get(admitted.operation_id);
  assert.equal(operation.status, 'admitted');
});

test('cancel_running=true interrupts the running target turn and settles', async t => {
  const { runtime, fakes, operations, calls } = fixture(t);
  fakes.queue = { state: 'started' };
  const admitted = await admitOne(runtime);
  fakes.cancelQueuedEntry = async () => ({ ok: false, code: 'queued_entry_already_claimed' });
  fakes.schedulerStatus = async () => ({
    active: { entryId: `operation:${admitted.operation_id}:request` },
    queued: [],
  });
  const capability = runtime.issueContext({ sessionId: 'caller', turnId: 'turn-cancel' });
  const result = await runtime.execute(capability, 'dispatch_cancel', {
    operation_id: admitted.operation_id,
    cancel_running: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.disposition, 'running');
  assert.deepEqual(calls.cancelActiveTurn, [{
    sessionId: 'worker-a',
    opts: { source: 'dispatch_cancel', reason: 'cancelled by dispatcher' },
  }]);
  const operation = await operations.get(admitted.operation_id);
  assert.equal(operation.status, 'cancelled');
});

test('a task with no queued or running trace settles as untrackable', async t => {
  const { runtime, fakes, operations } = fixture(t);
  fakes.queue = { state: 'unknown' };
  const admitted = await admitOne(runtime);
  fakes.cancelQueuedEntry = async () => ({ ok: false, code: 'queued_entry_not_found' });
  fakes.schedulerStatus = async () => ({ active: null, queued: [] });
  const capability = runtime.issueContext({ sessionId: 'caller', turnId: 'turn-cancel' });
  const result = await runtime.execute(capability, 'dispatch_cancel', { operation_id: admitted.operation_id });
  assert.equal(result.ok, true);
  assert.equal(result.disposition, 'untrackable');
  const operation = await operations.get(admitted.operation_id);
  assert.equal(operation.status, 'cancelled');
});

test('a completion racing the cancel wins, and the caller hears the truth', async t => {
  const { runtime, fakes, operations } = fixture(t);
  fakes.queue = { state: 'queued', position: 1, length: 1 };
  const admitted = await admitOne(runtime);
  // The worker finishes while the cancel is in flight: the FIFO removal fails
  // because the entry is gone, and the operation is already terminal when the
  // settle write arrives.
  fakes.cancelQueuedEntry = async () => {
    await operations.completeDispatch(admitted.operation_id, {
      status: 'completed', text: 'done',
    });
    return { ok: false, code: 'queued_entry_not_found' };
  };
  const capability = runtime.issueContext({ sessionId: 'caller', turnId: 'turn-cancel' });
  const result = await runtime.execute(capability, 'dispatch_cancel', { operation_id: admitted.operation_id });
  assert.equal(result.ok, true);
  assert.equal(result.already_terminal, true);
  assert.equal(result.status, 'completed');
});

test('a completed dispatch reports its terminal status instead of cancelling', async t => {
  const { runtime, fakes, operations, calls } = fixture(t);
  fakes.queue = { state: 'started' };
  const admitted = await admitOne(runtime);
  await operations.completeDispatch(admitted.operation_id, { status: 'completed', text: 'done' });
  const capability = runtime.issueContext({ sessionId: 'caller', turnId: 'turn-cancel' });
  const result = await runtime.execute(capability, 'dispatch_cancel', { operation_id: admitted.operation_id });
  assert.equal(result.ok, true);
  assert.equal(result.already_terminal, true);
  assert.equal(result.status, 'completed');
  assert.equal(calls.cancelQueuedEntry.length, 0);
});
