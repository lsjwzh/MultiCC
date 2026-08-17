'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const {
  normalizeTurnRequest,
  createTurnLifecycle,
  bindTurnUsageAttribution,
  createRunnerOwnership,
  createChatHostRuntime,
} = require('../src/chat');
const { createTaskRunStore } = require('../src/task-run-store');
const { createTaskRunHost } = require('../src/task-run-host');

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-task-run-main-'));
  const store = createTaskRunStore({
    file: path.join(dir, 'task-runs.sqlite'),
    now: () => 1_800_000_000_000,
    Database,
  });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  store.beginRun({
    runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', slotId: 'slot-1',
  });
  return store;
}

function admittedTurn() {
  const request = normalizeTurnRequest({
    sessionId: 'slot-1', text: 'finish task', cli: 'codex',
    taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 4, taskSource: 'task-board',
  });
  const turn = createTurnLifecycle(request, { turnId: 'turn-1' });
  bindTurnUsageAttribution(turn, {
    providerId: 'provider-a', providerName: 'Provider A', cli: 'codex',
    protocol: 'openai-responses', model: 'model-a', roleKind: 'main', routeName: 'main',
  });
  const runner = createRunnerOwnership(turn, { runnerId: 'runner-1', kind: 'process' });
  return { turn, runner };
}

function createFencedHost(store, records) {
  return createTaskRunHost({
    store,
    records,
    closeNative: async () => {},
    clearNativeState: () => {},
    deleteChatHistory: () => {},
    resetChatState: () => {},
    resetRoleUsage: () => {},
    persistRecords: () => true,
    providerSnapshot: () => ({}),
    log: () => {},
  });
}

function createRuntime(store, acks, terminalEvents, options = {}) {
  const owned = admittedTurn();
  const state = {
    _activeTurn: owned.turn,
    _activeRunner: owned.runner,
    // These deliberately disagree with the admitted binding. Completion must
    // never attribute usage to a provider selected for a later slot occupant.
    cli: 'claude', providerId: 'provider-later', providerName: 'Provider Later',
    model: 'model-later',
  };
  const records = options.records || new Map([['slot-1', {
    id: 'slot-1', taskExecutionSlot: true,
    taskRunLease: { runId: 'run-1', leaseEpoch: 4 },
  }]]);
  const taskRunHost = options.taskRunHost || createFencedHost(store, records);
  const runtime = createChatHostRuntime({
    appendMessage: () => true,
    persistUsage: () => true,
    persistTaskRunUsage: payload => {
      options.payloads?.push(payload);
      const result = taskRunHost.recordMainUsage(payload);
      acks.push(result);
      return result;
    },
    afterUsageCommit: () => {},
    getSessionState: () => state,
    consumeHandoff: () => {},
    emitTurnComplete: () => terminalEvents.push('turn-complete'),
    emitDispatchComplete: () => terminalEvents.push('dispatch-complete'),
    emitGatewayComplete: () => terminalEvents.push('gateway-complete'),
    logSuppressed: detail => terminalEvents.push(`suppressed:${detail.reason}`),
  });
  assert.equal(runtime.persistFinalAssistantResult(
    'slot-1', state, owned.turn, owned.runner,
    { role: 'assistant', content: 'done' }, { resultEvent: true },
  ), true);
  return { ...owned, state, runtime, records, taskRunHost };
}

test('normalized task turn writes exactly one main event and accepts inserted/duplicate/corrected store ACKs', t => {
  const store = tempStore(t);
  const acks = [];
  const terminalEvents = [];
  const payloads = [];

  const first = createRuntime(store, acks, terminalEvents, { payloads });
  assert.equal(first.runtime.recordDurableTurnUsage(
    'slot-1', first.runner, { input_tokens: 10, output_tokens: 3 }, { occurredAt: 1234 },
  ), true);
  assert.equal(first.runtime.recordDurableTurnUsage(
    'slot-1', first.runner, { input_tokens: 999, output_tokens: 999 }, { occurredAt: 9999 },
  ), true, 'same runner is claimed exactly once');

  const replay = createRuntime(store, acks, terminalEvents, {
    payloads, records: first.records, taskRunHost: first.taskRunHost,
  });
  assert.equal(replay.runtime.recordDurableTurnUsage(
    'slot-1', replay.runner, { input_tokens: 10, output_tokens: 3 }, { occurredAt: 1234 },
  ), true, 'a store duplicate is a durable success');

  const correction = createRuntime(store, acks, terminalEvents, {
    payloads, records: first.records, taskRunHost: first.taskRunHost,
  });
  assert.equal(correction.runtime.recordDurableTurnUsage(
    'slot-1', correction.runner, { input_tokens: 12, output_tokens: 4 }, { occurredAt: 1234 },
  ), true, 'a store correction is a durable success');
  assert.equal(correction.runtime.runDurablePostTurn(
    'slot-1', correction.state, { type: 'worker' }, correction.turn, correction.runner, 'done', {},
  ), true);

  assert.deepEqual(acks.map(ack => ({
    inserted: ack.inserted, duplicate: ack.duplicate, corrected: ack.corrected,
  })), [
    { inserted: true, duplicate: false, corrected: false },
    { inserted: false, duplicate: true, corrected: false },
    { inserted: false, duplicate: false, corrected: true },
  ]);
  assert.equal(payloads.every(payload => payload.leaseEpoch === 4), true);
  assert.equal(payloads.every(payload => Object.isFrozen(payload.providerBinding)), true);
  assert.deepEqual({ ...payloads[0].providerBinding }, {
    sessionId: 'slot-1', cli: 'codex', providerId: 'provider-a', model: 'model-a',
    roleKind: 'main', agentRole: null, routeName: 'main',
  });
  const usage = store.getRunUsage('run-1');
  assert.equal(usage.observedEvents, 1);
  assert.deepEqual(usage.tokens, {
    freshInput: 12, cacheRead: 0, cacheWrite: 0, consumedInput: 12,
    output: 4, reasoning: 0, total: 16,
  });
  assert.deepEqual(usage.dimensions.map(item => ({
    providerId: item.providerId, providerName: item.providerName,
    model: item.model, roleKind: item.roleKind, routeName: item.routeName,
  })), [{
    providerId: 'provider-a', providerName: 'Provider A', model: 'model-a',
    roleKind: 'main', routeName: 'main',
  }]);
  assert.deepEqual(terminalEvents, ['turn-complete']);
});

test('wrong or late main usage epoch fails closed and cannot borrow a newer slot lease', t => {
  const store = tempStore(t);
  const acks = [];
  const terminalEvents = [];
  const owned = createRuntime(store, acks, terminalEvents);
  owned.records.get('slot-1').taskRunLease = { runId: 'run-1', leaseEpoch: 5 };

  assert.equal(owned.runtime.recordDurableTurnUsage(
    'slot-1', owned.runner, { input_tokens: 10 }, { occurredAt: 1234 },
  ), false);
  assert.equal(store.getRunUsage('run-1').observedEvents, 0);
  assert.deepEqual(acks, [{ ok: false, code: 'stale_task_run_lease' }]);
  assert.equal(owned.runtime.runDurablePostTurn(
    'slot-1', owned.state, { type: 'worker' }, owned.turn, owned.runner, 'done', {},
  ), false);
  assert.deepEqual(terminalEvents, ['suppressed:task_run_usage_not_durable']);
});

test('main usage keeps the provider binding frozen at admission when mutable session selection changes', t => {
  const store = tempStore(t);
  const payloads = [];
  const owned = createRuntime(store, [], [], { payloads });
  owned.state.providerId = 'provider-after-admission';
  owned.state.providerName = 'Provider After Admission';
  owned.state.model = 'model-after-admission';

  assert.equal(owned.runtime.recordDurableTurnUsage(
    'slot-1', owned.runner, { input_tokens: 2, output_tokens: 1 }, { occurredAt: 1234 },
  ), true);
  assert.equal(payloads[0].event.providerId, 'provider-a');
  assert.equal(payloads[0].event.model, 'model-a');
  assert.equal(payloads[0].providerBinding.providerId, 'provider-a');
  assert.equal(payloads[0].providerBinding.model, 'model-a');
});

test('a real TaskRun store failure suppresses post-turn completion', t => {
  const store = tempStore(t);
  const terminalEvents = [];
  const owned = createRuntime(store, [], terminalEvents);
  store.close();
  assert.equal(owned.runtime.recordDurableTurnUsage(
    'slot-1', owned.runner, { input_tokens: 1 }, { occurredAt: 1234 },
  ), false);
  assert.equal(owned.runtime.runDurablePostTurn(
    'slot-1', owned.state, { type: 'worker' }, owned.turn, owned.runner, 'done', {},
  ), false);
  assert.deepEqual(terminalEvents, ['suppressed:task_run_usage_not_durable']);
});
