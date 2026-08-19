'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createTaskRunHost } = require('../src/task-run-host');

function fixture(overrides = {}) {
  const calls = [];
  const observed = [];
  const observedIds = new Set();
  const run = {
    runId: 'run-1', taskId: 'task-1', slotId: null,
    executionStatus: 'running', usageStatus: 'collecting', cleanupState: 'blocked',
  };
  const usage = { observedEvents: 0, unobservableEvents: 0, dimensions: [] };
  const messages = [{ messageId: 'admission:run-1', role: 'user', kind: 'admission' }];
  const store = {
    getRun(id) { assert.equal(id, 'run-1'); return { ...run }; },
    bindRunSlot({ runId, slotId }) { calls.push(`bind:${runId}:${slotId}`); run.slotId = slotId; return { ...run }; },
    getRunMessages: () => messages.slice(),
    appendMessage(message) { calls.push(`message:${message.role}:${message.messageId}`); messages.push(message); return message; },
    getRunUsage: () => ({ ...usage }),
    observeUsage({ runId, event }) {
      calls.push(`usage:${event.coverage}`);
      observed.push({ runId, event });
      const duplicate = observedIds.has(event.eventId);
      observedIds.add(event.eventId);
      if (!duplicate && event.coverage === 'unobservable') usage.unobservableEvents += 1;
      if (!duplicate && event.coverage === 'observed') usage.observedEvents += 1;
      if (!duplicate) {
        const dimension = usage.dimensions.find(item => item.roleKind === event.roleKind
          && item.providerId === event.providerId && item.model === event.model
          && item.routeName === event.routeName);
        if (dimension) {
          if (event.coverage === 'observed') dimension.observedEvents += 1;
          else dimension.unobservableEvents += 1;
        } else {
          usage.dimensions.push({
            providerId: event.providerId, model: event.model,
            roleKind: event.roleKind, routeName: event.routeName,
            observedEvents: event.coverage === 'observed' ? 1 : 0,
            unobservableEvents: event.coverage === 'unobservable' ? 1 : 0,
          });
        }
      }
      return {
        ok: true,
        inserted: !duplicate,
        duplicate,
        corrected: false,
        eventId: event.eventId,
        revision: observedIds.size,
      };
    },
    sealUsage(input) { calls.push(`seal:${input.executionStatus}`); run.executionStatus = input.executionStatus; run.cleanupState = 'allowed'; return { ...run }; },
    getCleanupPermit: () => ({ runId: 'run-1', revision: 1 }),
    markCleanup({ state }) { calls.push(`cleanup:${state}`); run.cleanupState = state; return { ...run }; },
  };
  if (overrides.storePorts) Object.assign(store, overrides.storePorts(store, calls, run));
  const records = new Map([['slot-1', {
    id: 'slot-1', cli: 'codex', provider: 'provider-a', model: 'model-a',
    taskExecutionSlot: true, cliSessionId: 'native-old',
  }]]);
  const host = createTaskRunHost({
    store,
    records,
    closeNative: async id => calls.push(`close:${id}`),
    clearNativeState: record => { calls.push(`clear:${record.id}`); record.cliSessionId = null; },
    deleteChatHistory: id => calls.push(`history:${id}`),
    resetChatState: id => calls.push(`chat:${id}`),
    resetRoleUsage: id => calls.push(`role:${id}`),
    persistRecords: source => {
      calls.push(`persist:${source}`);
      return overrides.persistResult === undefined ? true : overrides.persistResult;
    },
    providerSnapshot: () => ({ providerId: 'provider-a', providerName: 'Provider A', cli: 'codex', model: 'model-a' }),
    finalizeRun: overrides.finalizeRun || (async input => {
      calls.push(`finalize:${input.runId}`);
      return {
        outcomeDurable: true,
        producersDrained: true,
        nativeTranscriptChecked: true,
        nativeRefs: { runId: input.runId, files: [] },
      };
    }),
    cleanupRun: overrides.cleanupRun,
    prepareTaskWorktree: overrides.prepareTaskWorktree,
    releaseTaskWorktree: overrides.releaseTaskWorktree,
    onRunUpdated: overrides.onRunUpdated,
    getTaskState: overrides.getTaskState,
    onRunFailed: overrides.onRunFailed,
    log: () => {},
  });
  return { host, calls, records, store, usage, messages, run, observed };
}

function observedEvent(overrides = {}) {
  return {
    occurredAt: 100,
    sessionId: 'slot-1',
    providerId: 'provider-a',
    providerName: 'Provider A',
    cli: 'codex',
    roleKind: 'sub',
    agentRole: 'worker',
    routeName: 'worker',
    source: 'exact',
    coverage: 'observed',
    status: 'success',
    protocol: 'openai-responses',
    model: 'model-a',
    tokens: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1 },
    taskId: 'task-1',
    taskRunId: 'run-1',
    leaseEpoch: 2,
    ...overrides,
  };
}

function activateRun(h, leaseEpoch = 2) {
  h.run.slotId = 'slot-1';
  h.run.leaseEpoch = leaseEpoch;
  h.records.get('slot-1').taskRunLease = { runId: 'run-1', leaseEpoch };
}

test('a fresh slot barrier scrubs a stale apiError left by a prior failed run', async () => {
  const h = fixture();
  h.records.get('slot-1').taskState = {
    apiError: { category: 'rate_limit', code: 'rate_limited', retryable: true },
  };
  await h.host.beforeDeliver({
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  });
  assert.equal(h.records.get('slot-1').taskState.apiError, null,
    'a reused execution slot must not misattribute the previous run\'s failure to the next one');
});

test('fresh-run barrier binds then clears an internal slot exactly once', async () => {
  const h = fixture();
  const descriptor = { sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2 };
  await h.host.beforeDeliver(descriptor);
  assert.deepEqual(h.calls, [
    'bind:run-1:slot-1', 'close:slot-1', 'clear:slot-1', 'history:slot-1',
    'chat:slot-1', 'role:slot-1', 'persist:task-run-slot-lease',
  ]);
  assert.deepEqual(h.records.get('slot-1').taskRunLease, { runId: 'run-1', leaseEpoch: 2 });
  await h.host.beforeDeliver(descriptor);
  assert.equal(h.calls.filter(call => call === 'history:slot-1').length, 1);
});

test('a normal visible session can never acquire a TaskRun lease or have its history cleared', async () => {
  let acquireCalls = 0;
  const h = fixture({
    storePorts: () => ({
      acquireSlotLease() { acquireCalls += 1; throw new Error('must not acquire'); },
    }),
  });
  h.records.get('slot-1').taskExecutionSlot = false;
  await assert.rejects(h.host.beforeDeliver({
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  }), error => error?.code === 'TASK_RUN_SLOT_REQUIRED');
  assert.equal(acquireCalls, 0);
  assert.equal(h.run.slotId, null);
  assert.equal(h.records.get('slot-1').cliSessionId, 'native-old');
  assert.deepEqual(h.calls, []);
});

test('an unsupported hidden-slot CLI is rejected before acquiring or projecting a lease', async () => {
  let acquireCalls = 0;
  const h = fixture({
    storePorts: () => ({
      acquireSlotLease() { acquireCalls += 1; throw new Error('must not acquire'); },
    }),
  });
  h.records.get('slot-1').cli = 'opencode';
  await assert.rejects(h.host.beforeDeliver({
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  }), error => error?.code === 'TASK_RUN_CLI_UNSUPPORTED');
  assert.equal(acquireCalls, 0);
  assert.equal(h.run.slotId, null);
  assert.equal(h.records.get('slot-1').taskRunLease, undefined);
  assert.equal(h.records.get('slot-1').taskRunQuarantined, undefined);
  assert.deepEqual(h.calls, []);
});

test('authoritative fresh barrier resets acquired leases before marking them ready', async () => {
  let phase = 'acquired';
  const h = fixture({
    storePorts: (_store, calls, run) => ({
      acquireSlotLease(input) {
        calls.push(`acquire:${input.leaseEpoch}`);
        run.slotId = input.slotId;
        return { ...input, phase };
      },
      markSlotLeaseReady(input) {
        calls.push(`ready:${input.leaseEpoch}`);
        phase = 'ready';
        return { ...input, phase };
      },
    }),
  });
  h.run.leaseEpoch = 2;
  const descriptor = {
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  };
  await h.host.beforeDeliver(descriptor);
  assert.deepEqual(h.calls, [
    'acquire:2', 'close:slot-1', 'clear:slot-1', 'history:slot-1',
    'chat:slot-1', 'role:slot-1', 'ready:2', 'persist:task-run-slot-lease',
  ]);
  h.calls.length = 0;
  assert.deepEqual(await h.host.beforeDeliver(descriptor), { ok: true, duplicate: true });
  assert.deepEqual(h.calls, ['acquire:2', 'persist:task-run-slot-lease']);
});

test('fresh barrier quarantines a ready lease when its session projection is not durable', async () => {
  const h = fixture({
    persistResult: false,
    storePorts: (_store, calls, run) => ({
      acquireSlotLease(input) {
        calls.push('acquire');
        run.slotId = input.slotId;
        return { ...input, phase: 'acquired' };
      },
      markSlotLeaseReady: input => ({ ...input, phase: 'ready' }),
      quarantineSlotLease(input) {
        calls.push(`quarantine:${input.code}`);
        return { ...input, state: 'quarantined', phase: 'ready' };
      },
    }),
  });
  h.run.leaseEpoch = 2;
  await assert.rejects(h.host.beforeDeliver({
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  }), error => error?.code === 'TASK_RUN_SLOT_PROJECTION_PERSIST_FAILED');
  assert.equal(h.records.get('slot-1').taskRunQuarantined, true);
  assert.equal(h.calls.includes('quarantine:TASK_RUN_SLOT_PROJECTION_PERSIST_FAILED'), true);
});

test('run-owned transcript skips the admission duplicate and persists assistant output', () => {
  const h = fixture();
  activateRun(h);
  h.host.recordMessage('slot-1', {
    id: 'worker-user', role: 'user', content: 'execute', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, taskStart: true, ts: 10,
  });
  h.host.recordMessage('slot-1', {
    id: 'assistant-1', role: 'assistant', content: 'done', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, ts: 20,
  });
  assert.deepEqual(h.calls.filter(call => call.startsWith('message:')), ['message:assistant:assistant-1']);
});

test('run-owned transcript keeps later user answers while skipping only the task-start echo', () => {
  const h = fixture();
  activateRun(h);
  h.host.recordMessage('slot-1', {
    id: 'worker-start', role: 'user', content: 'rendered task context', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, taskStart: true, ts: 10,
  });
  h.host.recordMessage('slot-1', {
    id: 'assistant-question', role: 'assistant', content: 'approve?', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, ts: 20,
  });
  h.host.recordMessage('slot-1', {
    id: 'user-answer', role: 'user', content: 'approved', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, taskStart: false, ts: 30,
  });
  assert.deepEqual(h.calls.filter(call => call.startsWith('message:')), [
    'message:assistant:assistant-question', 'message:user:user-answer',
  ]);
});

test('run transcript persists the sending clientMsgId so a task chat view can commit staged bubbles', () => {
  const h = fixture();
  activateRun(h);
  h.host.recordMessage('slot-1', {
    id: 'user-answer-2', role: 'user', content: 'approved', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, ts: 30, clientMsgId: 'client-42',
  });
  const recorded = h.messages.find(m => m.messageId === 'user-answer-2');
  assert.equal(recorded.metadata.clientMsgId, 'client-42', 'ledger metadata carries the idempotency key');
});

test('TaskRun transcript rejects stale epochs, wrong slots, and terminal late output', () => {  const h = fixture();
  activateRun(h);
  assert.throws(() => h.host.recordMessage('slot-1', {
    id: 'late-old-epoch', role: 'assistant', content: 'old', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 1, ts: 10,
  }), error => error?.code === 'TASK_RUN_MESSAGE_LEASE_STALE');

  h.records.set('slot-2', {
    id: 'slot-2', taskExecutionSlot: true,
    taskRunLease: { runId: 'run-1', leaseEpoch: 2 },
  });
  assert.throws(() => h.host.recordMessage('slot-2', {
    id: 'wrong-slot', role: 'assistant', content: 'wrong', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, ts: 11,
  }), error => error?.code === 'TASK_RUN_MESSAGE_SLOT_MISMATCH');

  h.run.executionStatus = 'succeeded';
  h.run.usageStatus = 'sealed';
  h.run.cleanupState = 'done';
  assert.throws(() => h.host.recordMessage('slot-1', {
    id: 'terminal-late', role: 'assistant', content: 'late', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, ts: 12,
  }), error => error?.code === 'TASK_RUN_MESSAGE_CLOSED');
  assert.equal(h.messages.length, 1);
});

test('completion records unknown usage, seals it, cleans the slot and releases the lease', async () => {
  const h = fixture();
  await h.host.beforeDeliver({
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  });
  h.calls.length = 0;
  await h.host.onSchedulerEvent({
    type: 'completed', sessionId: 'slot-1', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, turnOutcome: 'succeeded',
  });
  assert.deepEqual(h.calls, [
    'finalize:run-1', 'usage:unobservable', 'seal:succeeded', 'cleanup:deleting',
    'close:slot-1', 'clear:slot-1', 'history:slot-1', 'chat:slot-1',
    'role:slot-1', 'cleanup:done', 'persist:task-run-slot-release',
  ]);
  assert.equal(h.records.get('slot-1').taskRunLease, undefined);
  assert.equal(h.host.isSlotUnavailable('slot-1'), false);
});

test('concurrent terminal events join one finalizer and one cleanup claimant', async () => {
  let releaseFinalizer;
  const gate = new Promise(resolve => { releaseFinalizer = resolve; });
  let finalizeCalls = 0;
  let cleanupCalls = 0;
  const h = fixture({
    finalizeRun: async ({ runId }) => {
      finalizeCalls += 1;
      await gate;
      return {
        outcomeDurable: true,
        producersDrained: true,
        nativeTranscriptChecked: true,
        nativeRefs: { runId, files: [] },
      };
    },
    cleanupRun: async ({ nativeRefs }) => {
      cleanupCalls += 1;
      assert.deepEqual(nativeRefs, { runId: 'run-1', files: [] });
      h.store.markCleanup({ state: 'deleting' });
      h.store.markCleanup({ state: 'done' });
    },
  });
  await h.host.beforeDeliver({
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  });
  h.calls.length = 0;
  const event = {
    type: 'completed', sessionId: 'slot-1', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, turnOutcome: 'succeeded',
  };
  const first = h.host.onSchedulerEvent(event);
  const second = h.host.onSchedulerEvent(event);
  releaseFinalizer();
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left, right);
  assert.equal(finalizeCalls, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(h.calls.filter(call => call.startsWith('seal:')).length, 1);
  assert.equal(h.records.get('slot-1').taskRunLease, undefined);
});

test('recovered terminal replay is idempotent after the exact lease was already cleaned', async () => {
  let durableLease = {
    slotId: 'slot-1', runId: 'run-1', leaseEpoch: 2,
    state: 'active', phase: 'ready',
  };
  let finalizeCalls = 0;
  const h = fixture({
    finalizeRun: async ({ runId }) => {
      finalizeCalls += 1;
      return {
        outcomeDurable: true,
        producersDrained: true,
        nativeTranscriptChecked: true,
        nativeRefs: { runId, files: [] },
      };
    },
    storePorts: () => ({
      getSlotLease: () => ({ ...durableLease }),
      releaseSlotLease(input) {
        assert.deepEqual(input, { slotId: 'slot-1', runId: 'run-1', leaseEpoch: 2 });
        durableLease = { ...durableLease, state: 'released' };
        return { ...durableLease };
      },
    }),
  });
  activateRun(h);
  const event = {
    type: 'completed', sessionId: 'slot-1', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, classifyState: 'D', recovered: true,
  };
  assert.deepEqual(await h.host.recoverTerminal(event), { ok: true, runId: 'run-1' });
  assert.deepEqual(await h.host.recoverTerminal(event), {
    ok: true, duplicate: true, runId: 'run-1',
  });
  assert.deepEqual(await h.host.recoverTerminal({
    ...event, classifyState: 'E', turnOutcome: 'failed',
  }), { ok: false, code: 'TASK_RUN_EXECUTION_STATUS_CONFLICT' });
  assert.equal(finalizeCalls, 1);
  assert.equal(durableLease.state, 'released');
});

test('never-delivered queued cancellation seals an unbound run without native or lease side effects', async () => {
  let acquireCalls = 0;
  let leaseReadCalls = 0;
  const h = fixture({
    storePorts: () => ({
      acquireSlotLease() { acquireCalls += 1; throw new Error('must not acquire'); },
      getSlotLease() { leaseReadCalls += 1; throw new Error('must not read a slot lease'); },
    }),
  });
  h.run.leaseEpoch = 2;
  const input = {
    taskId: 'task-1', runId: 'run-1', leaseEpoch: 2, neverDelivered: true,
  };

  assert.deepEqual(await h.host.cancelRun(input), { ok: true, runId: 'run-1' });
  assert.equal(h.run.executionStatus, 'cancelled');
  assert.equal(h.run.cleanupState, 'done');
  assert.equal(h.run.slotId, null);
  assert.deepEqual(h.calls, [
    'usage:observed', 'seal:cancelled', 'cleanup:deleting', 'cleanup:done',
  ]);
  assert.deepEqual(h.observed[0].event, {
    eventId: 'usage-not-started:run-1',
    sourceEventId: null,
    occurredAt: 0,
    providerId: 'not-started',
    providerName: 'Not started',
    cli: '',
    protocol: '',
    model: '',
    roleKind: 'main',
    routeName: 'main',
    source: 'reconciled',
    coverage: 'observed',
    status: 'cancelled',
    tokens: { freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
  });
  assert.equal(acquireCalls, 0);
  assert.equal(leaseReadCalls, 0);

  const callsAfterFirst = h.calls.slice();
  assert.deepEqual(await h.host.terminateRun(input), {
    ok: true, duplicate: true, runId: 'run-1',
  });
  assert.deepEqual(h.calls, callsAfterFirst);

  await assert.rejects(h.host.beforeDeliver({
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  }), error => error?.code === 'TASK_RUN_CLOSED');
  assert.equal(acquireCalls, 0);
  assert.equal(leaseReadCalls, 0);
  assert.deepEqual(h.calls, callsAfterFirst);
  assert.equal(h.records.get('slot-1').cliSessionId, 'native-old');
  assert.equal(h.records.get('slot-1').taskRunLease, undefined);
});

test('an unbound run requires explicit proof that delivery was durably prevented first', async () => {
  const h = fixture();
  h.run.leaseEpoch = 2;
  assert.deepEqual(await h.host.terminateRun({
    taskId: 'task-1', runId: 'run-1', leaseEpoch: 2,
  }), { ok: false, code: 'TASK_RUN_NEVER_DELIVERED_PROOF_REQUIRED' });
  assert.equal(h.run.executionStatus, 'running');
  assert.equal(h.run.cleanupState, 'blocked');
  assert.deepEqual(h.calls, []);
});

test('explicit termination releases an exact W, B, or queued hidden-slot lease and replays idempotently', async () => {
  for (const boundary of ['W', 'B', 'queued']) {
    let durableLease = {
      slotId: 'slot-1', runId: 'run-1', leaseEpoch: 2,
      state: 'active', phase: 'ready',
    };
    let finalizeCalls = 0;
    const h = fixture({
      finalizeRun: async ({ runId, event }) => {
        finalizeCalls += 1;
        assert.equal(event.attemptOutcome, 'cancelled');
        assert.equal(event.reason, 'user_cancelled');
        return {
          outcomeDurable: true,
          producersDrained: true,
          nativeTranscriptChecked: true,
          nativeRefs: { runId, files: [] },
        };
      },
      storePorts: (_store, calls) => ({
        getSlotLease: () => ({ ...durableLease }),
        releaseSlotLease(input) {
          calls.push(`release:${input.runId}:${input.leaseEpoch}`);
          durableLease = { ...durableLease, state: 'released' };
          return { ...durableLease };
        },
      }),
    });
    activateRun(h);
    h.records.get('slot-1').taskState = boundary === 'queued'
      ? { queueState: 'queued' }
      : { classifyState: boundary };
    h.calls.length = 0;
    const input = {
      taskId: 'task-1', runId: 'run-1', slotId: 'slot-1', leaseEpoch: 2,
    };
    const first = boundary === 'W'
      ? await h.host.cancelRun(input)
      : await h.host.terminateRun(input);
    assert.deepEqual(first, { ok: true, runId: 'run-1' }, boundary);
    assert.equal(h.run.executionStatus, 'cancelled', boundary);
    assert.equal(h.run.cleanupState, 'done', boundary);
    assert.equal(durableLease.state, 'released', boundary);
    assert.equal(h.records.get('slot-1').taskRunLease, undefined, boundary);
    assert.equal(h.calls.includes('seal:cancelled'), true, boundary);
    assert.equal(h.calls.includes('release:run-1:2'), true, boundary);
    const callsAfterFirst = h.calls.slice();
    assert.deepEqual(await h.host.terminateRun(input), {
      ok: true, duplicate: true, runId: 'run-1',
    }, boundary);
    assert.deepEqual(h.calls, callsAfterFirst, boundary);
    assert.equal(finalizeCalls, 1, boundary);
  }
});

test('explicit termination with a stale epoch cannot finalize or clear the next slot lease', async () => {
  const nextProjection = { runId: 'run-next', leaseEpoch: 3 };
  const h = fixture({
    storePorts: () => ({
      getSlotLease: () => ({
        slotId: 'slot-1', runId: 'run-next', leaseEpoch: 3,
        state: 'active', phase: 'ready',
      }),
      releaseSlotLease() { throw new Error('must not release'); },
    }),
  });
  h.run.slotId = 'slot-1';
  h.run.leaseEpoch = 2;
  h.records.get('slot-1').taskRunLease = { ...nextProjection };
  const result = await h.host.cancelRun({
    taskId: 'task-1', runId: 'run-1', slotId: 'slot-1', leaseEpoch: 2,
  });
  assert.deepEqual(result, { ok: false, code: 'stale_task_run_lease' });
  assert.deepEqual(h.records.get('slot-1').taskRunLease, nextProjection);
  assert.equal(h.run.executionStatus, 'running');
  assert.equal(h.run.cleanupState, 'blocked');
  assert.deepEqual(h.calls, []);
});

test('a cancelled-run replay fails closed after the slot has moved to a newer lease', async () => {
  const nextProjection = { runId: 'run-next', leaseEpoch: 3 };
  const h = fixture({
    storePorts: () => ({
      getSlotLease: () => ({
        slotId: 'slot-1', ...nextProjection, state: 'active', phase: 'ready',
      }),
      releaseSlotLease() { throw new Error('must not release'); },
    }),
  });
  h.run.slotId = 'slot-1';
  h.run.leaseEpoch = 2;
  h.run.executionStatus = 'cancelled';
  h.run.usageStatus = 'sealed';
  h.run.cleanupState = 'done';
  h.records.get('slot-1').taskRunLease = { ...nextProjection };
  const result = await h.host.terminateRun({
    taskId: 'task-1', runId: 'run-1', slotId: 'slot-1', leaseEpoch: 2,
  });
  assert.deepEqual(result, { ok: false, code: 'stale_task_run_lease' });
  assert.deepEqual(h.records.get('slot-1').taskRunLease, nextProjection);
  assert.deepEqual(h.calls, []);
});

test('an in-flight success finalizer cannot be silently joined as an explicit cancellation', async () => {
  let releaseFinalizer;
  const gate = new Promise(resolve => { releaseFinalizer = resolve; });
  let durableLease = {
    slotId: 'slot-1', runId: 'run-1', leaseEpoch: 2,
    state: 'active', phase: 'ready',
  };
  const h = fixture({
    finalizeRun: async ({ runId }) => {
      await gate;
      return {
        outcomeDurable: true, producersDrained: true,
        nativeTranscriptChecked: true, nativeRefs: { runId, files: [] },
      };
    },
    storePorts: () => ({
      getSlotLease: () => ({ ...durableLease }),
      releaseSlotLease() {
        durableLease = { ...durableLease, state: 'released' };
        return { ...durableLease };
      },
    }),
  });
  activateRun(h);
  const success = h.host.onSchedulerEvent({
    type: 'completed', sessionId: 'slot-1', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, classifyState: 'D',
  });
  assert.deepEqual(await h.host.cancelRun({
    taskId: 'task-1', runId: 'run-1', slotId: 'slot-1', leaseEpoch: 2,
  }), { ok: false, code: 'TASK_RUN_EXECUTION_STATUS_CONFLICT' });
  releaseFinalizer();
  await success;
  assert.equal(h.run.executionStatus, 'succeeded');
});

test('failed producer drain quarantines the slot before seal or deletion', async () => {
  const updates = [];
  const h = fixture({
    finalizeRun: async () => {
      throw Object.assign(new Error('provider still active'), {
        code: 'TASK_RUN_PRODUCERS_DRAIN_TIMEOUT',
      });
    },
    onRunUpdated: update => updates.push(update),
  });
  await h.host.beforeDeliver({
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  });
  h.calls.length = 0;
  const result = await h.host.onSchedulerEvent({
    type: 'completed', sessionId: 'slot-1', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, turnOutcome: 'succeeded',
  });
  assert.deepEqual(result, { ok: false, code: 'TASK_RUN_PRODUCERS_DRAIN_TIMEOUT' });
  assert.equal(h.records.get('slot-1').taskRunQuarantined, true);
  assert.equal(h.calls.some(call => call.startsWith('seal:')), false);
  assert.equal(h.calls.some(call => call.startsWith('cleanup:')), false);
  assert.deepEqual(updates, [{
    runId: 'run-1', taskId: 'task-1', executionStatus: 'succeeded',
    cleanupState: 'error', quarantined: true,
    errorCode: 'TASK_RUN_PRODUCERS_DRAIN_TIMEOUT',
  }]);
});

test('durable cleanup emits one task-scoped projection update without owning UI code', async () => {
  const updates = [];
  const h = fixture({ onRunUpdated: update => updates.push(update) });
  await h.host.beforeDeliver({
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  });
  await h.host.onSchedulerEvent({
    type: 'completed', sessionId: 'slot-1', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, turnOutcome: 'succeeded',
  });
  assert.deepEqual(updates, [{
    runId: 'run-1', taskId: 'task-1', executionStatus: 'succeeded',
    cleanupState: 'done', quarantined: false,
  }]);
});

test('waitForFinalizers joins an in-flight terminal barrier', async () => {
  let releaseFinalizer;
  const gate = new Promise(resolve => { releaseFinalizer = resolve; });
  const h = fixture({
    finalizeRun: async ({ runId }) => {
      await gate;
      return { outcomeDurable: true, producersDrained: true,
        nativeTranscriptChecked: true, nativeRefs: { runId, files: [] } };
    },
  });
  await h.host.beforeDeliver({
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  });
  const terminal = h.host.onSchedulerEvent({
    type: 'completed', sessionId: 'slot-1', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, turnOutcome: 'succeeded',
  });
  let drained = false;
  const joined = h.host.waitForFinalizers().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  releaseFinalizer();
  await Promise.all([terminal, joined]);
  assert.equal(drained, true);
});

test('completion records main as unobservable when only sub usage was observed', async () => {
  const h = fixture();
  await h.host.beforeDeliver({
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  });
  assert.equal(h.host.recordObservedUsage(observedEvent()).ok, true);
  h.calls.length = 0;

  await h.host.onSchedulerEvent({
    type: 'completed', sessionId: 'slot-1', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, turnOutcome: 'succeeded',
  });

  assert.deepEqual(h.calls.slice(0, 3), [
    'finalize:run-1', 'usage:unobservable', 'seal:succeeded',
  ]);
  assert.equal(h.observed.at(-1).event.roleKind, 'main');
  assert.equal(h.observed.at(-1).event.coverage, 'unobservable');
  assert.equal(h.usage.observedEvents, 1);
  assert.equal(h.usage.unobservableEvents, 1);
});

test('a stale completion cannot clean the slot owned by a newer lease', async () => {
  const h = fixture();
  h.records.get('slot-1').taskRunLease = { runId: 'run-2', leaseEpoch: 1 };
  const result = await h.host.onSchedulerEvent({
    type: 'completed', sessionId: 'slot-1', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, turnOutcome: 'succeeded',
  });
  assert.equal(result.code, 'stale_task_run_lease');
  assert.equal(h.calls.length, 0);
});

test('sub and aux UsageObserved events are archived under their explicit matching lease', () => {
  const h = fixture();
  h.run.slotId = 'slot-1';
  h.records.get('slot-1').taskRunLease = { runId: 'run-1', leaseEpoch: 2 };

  const first = h.host.recordObservedUsage(observedEvent());
  const repeated = h.host.recordObservedUsage(observedEvent());
  assert.equal(first.ok, true);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.duplicate, true);
  assert.match(first.eventId, /^uo_[a-f0-9]{32}$/);
  assert.equal(repeated.eventId, first.eventId);
  assert.equal(h.observed.length, 2);
  assert.deepEqual(h.observed[0], {
    runId: 'run-1',
    event: {
      eventId: first.eventId,
      sourceEventId: null,
      occurredAt: 100,
      providerId: 'provider-a',
      providerName: 'Provider A',
      cli: 'codex',
      protocol: 'openai-responses',
      model: 'model-a',
      roleKind: 'sub',
      agentRole: 'worker',
      routeName: 'worker',
      source: 'exact',
      coverage: 'observed',
      status: 'success',
      tokens: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1, reasoning: 0 },
    },
  });

  const aux = h.host.recordObservedUsage(observedEvent({
    occurredAt: 101,
    roleKind: 'aux',
    agentRole: null,
    routeName: 'aux',
  }));
  assert.equal(aux.ok, true);
  assert.equal(h.observed[2].event.roleKind, 'aux');
});

test('main usage remains owned by chat finalization and is never double-counted', () => {
  const h = fixture();
  h.records.get('slot-1').taskRunLease = { runId: 'run-1', leaseEpoch: 2 };
  const result = h.host.recordObservedUsage(observedEvent({
    roleKind: 'main', agentRole: null, routeName: 'main',
  }));
  assert.deepEqual(result, { ok: true, skipped: true, code: 'main_usage_owned_by_chat_final' });
  assert.equal(h.observed.length, 0);
});

test('usage without explicit run lineage cannot borrow the slot current lease', () => {
  const h = fixture();
  h.records.get('slot-1').taskRunLease = { runId: 'run-1', leaseEpoch: 2 };
  const event = observedEvent();
  delete event.taskRunId;
  delete event.leaseEpoch;
  const result = h.host.recordObservedUsage(event);
  assert.deepEqual(result, { ok: false, code: 'task_run_usage_lease_required' });
  assert.equal(h.observed.length, 0);
});

test('late and lease-mismatched usage fails closed instead of entering a newer run', () => {
  const h = fixture();
  h.records.get('slot-1').taskRunLease = { runId: 'run-2', leaseEpoch: 3 };
  assert.deepEqual(h.host.recordObservedUsage(observedEvent()), {
    ok: false, code: 'stale_task_run_lease',
  });
  delete h.records.get('slot-1').taskRunLease;
  assert.deepEqual(h.host.recordObservedUsage(observedEvent()), {
    ok: false, code: 'stale_task_run_lease',
  });
  h.records.get('slot-1').taskRunLease = { runId: 'run-1', leaseEpoch: 2 };
  h.run.slotId = 'slot-1';
  h.run.executionStatus = 'succeeded';
  h.run.usageStatus = 'sealed';
  h.run.cleanupState = 'allowed';
  assert.deepEqual(h.host.recordObservedUsage(observedEvent()), {
    ok: false, code: 'task_run_usage_closed',
  }, 'a retained lease cannot reopen a sealed run while cleanup is in flight');
  assert.equal(h.observed.length, 0);
});

test('a provider usage persistence failure fences cleanup even if the store later recovers', async () => {
  const h = fixture();
  await h.host.beforeDeliver({
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  });
  h.run.slotId = 'slot-1';
  const observeUsage = h.store.observeUsage;
  h.store.observeUsage = () => { throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' }); };
  assert.deepEqual(h.host.recordObservedUsage(observedEvent()), {
    ok: false, code: 'SQLITE_FULL',
  });
  assert.deepEqual(h.records.get('slot-1').taskRunUsageError, {
    runId: 'run-1', leaseEpoch: 2, code: 'SQLITE_FULL',
  });
  h.store.observeUsage = observeUsage;
  h.calls.length = 0;
  const finalized = await h.host.onSchedulerEvent({
    type: 'completed', sessionId: 'slot-1', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, turnOutcome: 'succeeded',
  });
  assert.equal(finalized.ok, false);
  assert.equal(finalized.code, 'TASK_RUN_USAGE_PERSIST_FAILED');
  assert.equal(h.records.get('slot-1').taskRunQuarantined, true);
  assert.equal(h.calls.some(call => call.startsWith('seal:')), false);
  assert.equal(h.calls.some(call => call.startsWith('cleanup:')), false);
});

test('a terminal TaskRun can never be rebound to a slot by an admission replay', async () => {
  const h = fixture();
  h.run.executionStatus = 'failed';
  h.run.usageStatus = 'sealed';
  h.run.cleanupState = 'done';
  await assert.rejects(h.host.beforeDeliver({
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  }), error => error && error.code === 'TASK_RUN_CLOSED');
  assert.equal(h.calls.length, 0);
  assert.equal(h.records.get('slot-1').taskRunLease, undefined);
});

test('waiting-user and waiting-background boundaries keep the run lease and native context', async () => {
  for (const classifyState of ['W', 'B']) {
    const h = fixture();
    await h.host.beforeDeliver({
      sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
    });
    h.calls.length = 0;
    const result = await h.host.onSchedulerEvent({
      type: 'completed', sessionId: 'slot-1', taskId: 'task-1',
      taskRunId: 'run-1', leaseEpoch: 2, classifyState,
    });
    assert.deepEqual(result, { ok: true, waiting: true, runId: 'run-1' });
    assert.deepEqual(h.records.get('slot-1').taskRunLease, { runId: 'run-1', leaseEpoch: 2 });
    assert.equal(h.host.isSlotUnavailable('slot-1'), true);
    assert.equal(h.host.isSlotUnavailable('slot-1', { taskRunId: 'run-1', leaseEpoch: 2 }), false);
    assert.equal(h.host.isSlotUnavailable('slot-1', { taskRunId: 'run-2', leaseEpoch: 1 }), true);
    assert.equal(h.calls.some(call => call.startsWith('seal:') || call.startsWith('cleanup:')), false);
  }
});

test('run-owned transcript preserves the partial checkpoint flag', () => {
  const h = fixture();
  activateRun(h);
  h.host.recordMessage('slot-1', {
    id: 'partial-1', role: 'assistant', content: '半截输出', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, partial: true, ts: 20,
  });
  h.host.recordMessage('slot-1', {
    id: 'final-1', role: 'assistant', content: '完整输出', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, ts: 30,
  });
  const partial = h.messages.find(message => message.messageId === 'partial-1');
  const final = h.messages.find(message => message.messageId === 'final-1');
  assert.equal(partial.metadata.partial, true, 'partial checkpoints keep their draft flag');
  assert.equal(final.metadata.partial, undefined, 'final output is never flagged partial');
});

test('a failed completion writes one error ledger entry and fires onRunFailed exactly once', async () => {
  const failures = [];
  const getTaskStateArgs = [];
  const h = fixture({
    getTaskState: id => {
      getTaskStateArgs.push(id);
      return {
        apiError: {
          category: 'rate_limit', code: 'rate_limited', retryable: true,
          userAction: '等待服务端限流窗口结束',
        },
      };
    },
    onRunFailed: async info => { failures.push(info); },
  });
  await h.host.beforeDeliver({
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  });
  h.calls.length = 0;
  const event = {
    type: 'completed', sessionId: 'slot-1', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, turnOutcome: 'failed', classifyState: 'E',
  };
  await h.host.onSchedulerEvent(event);
  const errors = h.messages.filter(message => message.kind === 'error');
  assert.equal(errors.length, 1, 'a terminal failure leaves exactly one error ledger entry');
  assert.equal(errors[0].role, 'system');
  assert.equal(errors[0].metadata.code, 'rate_limited');
  assert.equal(errors[0].metadata.category, 'rate_limit');
  assert.equal(errors[0].metadata.retryable, true);
  assert.match(String(errors[0].content), /限流/);
  assert.ok(h.calls.includes('seal:failed'));
  assert.ok(getTaskStateArgs.includes('slot-1'),
    'the failure lookup must pass the slot session id — the production port is id-keyed');
  assert.equal(getTaskStateArgs.some(arg => typeof arg === 'object'), false,
    'passing the record object instead of the id silently breaks the apiError lookup');
  assert.deepEqual(failures, [{
    runId: 'run-1', taskId: 'task-1', slotId: 'slot-1',
    code: 'rate_limited', retryable: true,
  }]);

  await h.host.onSchedulerEvent(event);
  assert.equal(h.messages.filter(message => message.kind === 'error').length, 1,
    'a terminal replay never double-writes the error entry');
  assert.equal(failures.length, 1, 'a terminal replay never re-fires onRunFailed');
});

test('a failed completion without structured evidence is recorded non-retryable', async () => {
  const failures = [];
  const h = fixture({ onRunFailed: async info => { failures.push(info); } });
  await h.host.beforeDeliver({
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  });
  await h.host.onSchedulerEvent({
    type: 'completed', sessionId: 'slot-1', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, turnOutcome: 'failed', classifyState: 'E',
  });
  const errors = h.messages.filter(message => message.kind === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].metadata.code, 'TURN_FAILED');
  assert.equal(errors[0].metadata.retryable, false);
  assert.deepEqual(failures, [{
    runId: 'run-1', taskId: 'task-1', slotId: 'slot-1',
    code: 'TURN_FAILED', retryable: false,
  }]);
});

test('a succeeded completion writes no error entry and never fires onRunFailed', async () => {
  const failures = [];
  const h = fixture({ onRunFailed: async info => { failures.push(info); } });
  await h.host.beforeDeliver({
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  });
  await h.host.onSchedulerEvent({
    type: 'completed', sessionId: 'slot-1', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, turnOutcome: 'succeeded',
  });
  assert.equal(h.messages.filter(message => message.kind === 'error').length, 0);
  assert.equal(failures.length, 0);
});

test('a cancelled completion writes no error entry and never fires onRunFailed', async () => {
  const failures = [];
  const h = fixture({ onRunFailed: async info => { failures.push(info); } });
  await h.host.beforeDeliver({
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  });
  await h.host.onSchedulerEvent({
    type: 'completed', sessionId: 'slot-1', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, attemptOutcome: 'cancelled', reason: 'cancelled',
  });
  assert.equal(h.messages.filter(message => message.kind === 'error').length, 0,
    'a user cancel is not a failure');
  assert.equal(failures.length, 0);
});

// ── per-task worktree ports (M3) ────────────────────────────────────────────

test('a fresh run boundary prepares the task worktree before the lease projection is durable', async () => {
  const annotated = [];
  const h = fixture({
    prepareTaskWorktree: async ({ record, taskId, runId }) => {
      h.calls.push(`prepare:${taskId}:${runId}`);
      record.worktreePath = '/repo/.multicc-worktrees/task-token';
      record.branch = 'multicc/task-token';
      return { ok: true, worktreePath: record.worktreePath, branch: record.branch };
    },
    storePorts: () => ({
      annotateRun: (runId, patch) => { annotated.push({ runId, patch }); return true; },
    }),
  });
  await h.host.beforeDeliver({
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  });
  const prepareAt = h.calls.indexOf('prepare:task-1:run-1');
  const persistAt = h.calls.indexOf('persist:task-run-slot-lease');
  assert.ok(prepareAt >= 0, 'prepare port ran');
  assert.ok(persistAt > prepareAt, 'the stamp is durable inside the lease projection persist');
  assert.deepEqual(annotated, [{
    runId: 'run-1',
    patch: { worktreePath: '/repo/.multicc-worktrees/task-token', branch: 'multicc/task-token' },
  }], 'the actual cwd is recorded on the run for observability');
});

test('task worktree preparation failure quarantines the slot and fails the delivery visibly', async () => {
  const h = fixture({
    prepareTaskWorktree: async () => ({ ok: false, code: 'worktree_create_failed' }),
  });
  await assert.rejects(
    h.host.beforeDeliver({
      sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
    }),
    error => error.code === 'TASK_WORKTREE_PREPARE_FAILED',
    'the delivery never runs in the wrong cwd',
  );
  assert.equal(h.records.get('slot-1').taskRunQuarantined, true);
});

test('finalization restores the slot worktree before cleanup runs and survives a restore failure', async () => {
  const h = fixture({
    prepareTaskWorktree: async ({ record }) => {
      record.worktreePath = '/repo/.multicc-worktrees/task-token';
      record.branch = 'multicc/task-token';
      return { ok: true, worktreePath: record.worktreePath, branch: record.branch };
    },
    releaseTaskWorktree: ({ record }) => {
      h.calls.push(`release:${record.id}`);
      record.worktreePath = '/repo/.multicc-worktrees/slot-1';
      record.branch = 'multicc/slot-1';
      return true;
    },
    cleanupRun: async () => {
      h.calls.push('cleanup-run');
      h.store.markCleanup({ state: 'deleting' });
      h.store.markCleanup({ state: 'done' });
    },
  });
  await h.host.beforeDeliver({
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  });
  assert.equal(h.records.get('slot-1').branch, 'multicc/task-token');
  h.calls.length = 0;
  await h.host.onSchedulerEvent({
    type: 'completed', sessionId: 'slot-1', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, turnOutcome: 'succeeded',
  });
  // Restore happens before cleanup so worktree inspection sees the slot's own
  // (clean) worktree, never the task's expectedly-dirty one.
  assert.ok(h.calls.indexOf('release:slot-1') >= 0
    && h.calls.indexOf('release:slot-1') < h.calls.indexOf('cleanup-run'));
  assert.equal(h.records.get('slot-1').branch, 'multicc/slot-1');

  const failing = fixture({
    prepareTaskWorktree: async ({ record }) => {
      record.branch = 'multicc/task-token';
      return { ok: true, branch: 'multicc/task-token', worktreePath: '/w' };
    },
    releaseTaskWorktree: () => { throw new Error('restore boom'); },
    cleanupRun: async () => {
      failing.calls.push('cleanup-run');
      failing.store.markCleanup({ state: 'deleting' });
      failing.store.markCleanup({ state: 'done' });
    },
  });
  await failing.host.beforeDeliver({
    sessionId: 'slot-1', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 2,
  });
  const result = await failing.host.onSchedulerEvent({
    type: 'completed', sessionId: 'slot-1', taskId: 'task-1',
    taskRunId: 'run-1', leaseEpoch: 2, turnOutcome: 'succeeded',
  });
  assert.deepEqual(result, { ok: true, runId: 'run-1' },
    'a restore failure never fails run finalization');
  assert.ok(failing.calls.includes('cleanup-run'));
  assert.ok(failing.calls.includes('persist:task-run-slot-release'));
});

