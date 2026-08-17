'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { reconcileTaskRunSlotLeases } = require('../src/task-run-recovery');

function lease(overrides = {}) {
  return {
    slotId: 'slot-1', runId: 'run-1', taskId: 'task-1', leaseEpoch: 3,
    action: 'restore_projection', cleanupState: 'blocked',
    leaseState: 'active', phase: 'ready',
    ...overrides,
  };
}

function fixture(plan) {
  const calls = [];
  const leaseStates = new Map(plan.map(item => [item.slotId, { ...item, state: 'active' }]));
  const runs = new Map(plan.map(item => [item.runId, {
    runId: item.runId, cleanupState: item.cleanupState || 'blocked',
  }]));
  const store = {
    planSlotLeaseRecovery: () => plan.map(item => ({ ...item })),
    getSlotLease: slotId => leaseStates.get(slotId) || null,
    getRun: runId => runs.get(runId),
    releaseSlotLease(input) {
      calls.push(['release', input]);
      const current = leaseStates.get(input.slotId);
      leaseStates.set(input.slotId, { ...current, state: 'released' });
      return leaseStates.get(input.slotId);
    },
    quarantineSlotLease(input) {
      calls.push(['quarantine', input]);
      const current = leaseStates.get(input.slotId);
      leaseStates.set(input.slotId, { ...current, state: 'quarantined' });
      return leaseStates.get(input.slotId);
    },
    markSlotLeaseReady(input) {
      calls.push(['ready', input]);
      const current = leaseStates.get(input.slotId);
      leaseStates.set(input.slotId, { ...current, phase: 'ready' });
      return leaseStates.get(input.slotId);
    },
    quarantineUnleasedRun(input) { calls.push(['quarantine-unleased', input]); },
  };
  const records = new Map(plan.map(item => [item.slotId, {
    id: item.slotId, taskExecutionSlot: true,
  }]));
  return { store, records, calls, runs, leaseStates };
}

test('startup reconciliation restores active SQLite leases into session projections', async () => {
  const h = fixture([lease()]);
  const persisted = [];
  const result = await reconcileTaskRunSlotLeases({
    store: h.store,
    records: h.records,
    persistRecords: source => persisted.push(source),
  });
  assert.deepEqual(h.records.get('slot-1').taskRunLease, { runId: 'run-1', leaseEpoch: 3 });
  assert.deepEqual(result, {
    restored: 1, reset: 0, released: 0, resumed: 0, terminalRecovered: 0,
    quarantined: 0, changed: true,
  });
  assert.deepEqual(persisted, ['task-run-lease-recovery']);
});

test('startup reconciliation releases a lease left behind after durable cleanup', async () => {
  const h = fixture([lease({ action: 'release_stale', cleanupState: 'done' })]);
  h.records.get('slot-1').taskRunLease = { runId: 'run-1', leaseEpoch: 3 };
  const result = await reconcileTaskRunSlotLeases({
    store: h.store, records: h.records, persistRecords: () => {},
  });
  assert.equal(result.released, 1);
  assert.equal(h.records.get('slot-1').taskRunLease, undefined);
  assert.deepEqual(h.calls[0], ['release', {
    slotId: 'slot-1', runId: 'run-1', leaseEpoch: 3,
  }]);
});

test('startup reconciliation reruns the fresh reset barrier before projecting an acquired lease', async () => {
  const h = fixture([lease({ action: 'reset_barrier' })]);
  const resets = [];
  const result = await reconcileTaskRunSlotLeases({
    store: h.store,
    records: h.records,
    persistRecords: () => {},
    resetSlot: async item => resets.push(item.slotId),
  });
  assert.deepEqual(resets, ['slot-1']);
  assert.deepEqual(h.calls[0], ['ready', {
    slotId: 'slot-1', runId: 'run-1', leaseEpoch: 3,
  }]);
  assert.deepEqual(h.records.get('slot-1').taskRunLease, { runId: 'run-1', leaseEpoch: 3 });
  assert.equal(result.restored, 1);
  assert.equal(result.reset, 1);
});

test('an acquired lease without a reset port is quarantined rather than projected', async () => {
  const h = fixture([lease({ action: 'reset_barrier' })]);
  const result = await reconcileTaskRunSlotLeases({
    store: h.store, records: h.records, persistRecords: () => {},
  });
  assert.equal(result.quarantined, 1);
  assert.equal(h.records.get('slot-1').taskRunLease, undefined);
  assert.equal(h.records.get('slot-1').taskRunQuarantined, true);
});

test('startup reconciliation resumes deleting cleanup before releasing its CAS lease', async () => {
  const h = fixture([lease({ action: 'resume_cleanup', cleanupState: 'deleting' })]);
  const resumed = [];
  const result = await reconcileTaskRunSlotLeases({
    store: h.store,
    records: h.records,
    persistRecords: () => {},
    resumeCleanup: async item => {
      resumed.push(item);
      h.runs.get(item.runId).cleanupState = 'done';
    },
  });
  assert.equal(result.resumed, 1);
  assert.equal(result.released, 1);
  assert.equal(resumed.length, 1);
  assert.equal(h.leaseStates.get('slot-1').state, 'released');
});

test('ambiguous or record-only leases are durably quarantined and never restored', async () => {
  const h = fixture([
    lease({ action: 'quarantine', slotId: 'slot-a', runId: 'run-a', leaseEpoch: 4 }),
    lease({ action: 'quarantine_unleased', slotId: 'slot-b', runId: 'run-b', leaseEpoch: 5 }),
  ]);
  h.records.get('slot-a').taskRunLease = { runId: 'other-run', leaseEpoch: 9 };
  h.records.set('slot-record-only', {
    id: 'slot-record-only', taskExecutionSlot: true,
    taskRunLease: { runId: 'record-only', leaseEpoch: 8 },
  });
  const result = await reconcileTaskRunSlotLeases({
    store: h.store, records: h.records, persistRecords: () => {},
  });
  assert.equal(result.quarantined, 3);
  assert.equal(h.records.get('slot-a').taskRunQuarantined, true);
  assert.equal(h.records.get('slot-b').taskRunQuarantined, true);
  assert.equal(h.records.get('slot-record-only').taskRunQuarantined, true);
  assert.equal(h.calls.some(call => call[0] === 'quarantine-unleased'), true);
});

test('a projection left after authoritative release is cleared when cleanup is durably done', async () => {
  const h = fixture([]);
  h.leaseStates.set('slot-1', {
    slotId: 'slot-1', runId: 'run-1', leaseEpoch: 3, state: 'released',
  });
  h.runs.set('run-1', { runId: 'run-1', cleanupState: 'done' });
  h.records.set('slot-1', {
    id: 'slot-1', taskExecutionSlot: true,
    taskRunLease: { runId: 'run-1', leaseEpoch: 3 },
  });

  const result = await reconcileTaskRunSlotLeases({
    store: h.store, records: h.records, persistRecords: () => {},
  });
  assert.equal(h.records.get('slot-1').taskRunLease, undefined);
  assert.equal(h.records.get('slot-1').taskRunQuarantined, undefined);
  assert.equal(result.quarantined, 0);
  assert.equal(result.changed, true);
});

test('cleanup resume that does not reach durable done is quarantined fail-closed', async () => {
  const h = fixture([lease({ action: 'resume_cleanup', cleanupState: 'deleting' })]);
  const result = await reconcileTaskRunSlotLeases({
    store: h.store,
    records: h.records,
    persistRecords: () => {},
    resumeCleanup: async () => {},
  });
  assert.equal(result.resumed, 0);
  assert.equal(result.released, 0);
  assert.equal(result.quarantined, 1);
  assert.equal(h.leaseStates.get('slot-1').state, 'quarantined');
});

test('startup recovery replays an exact durable D or E terminal decision after the scheduler commit crash window', async () => {
  for (const classifyState of ['D', 'E']) {
    const h = fixture([lease()]);
    const recovered = [];
    const result = await reconcileTaskRunSlotLeases({
      store: h.store,
      records: h.records,
      persistRecords: () => true,
      getSchedulerStatus: async slotId => ({
        sessionId: slotId,
        active: null,
        classifyState,
        lastDecision: {
          action: 'complete',
          reason: `classified_${classifyState}`,
          entryId: 'entry-1',
          taskId: 'task-1',
          taskRunId: 'run-1',
          leaseEpoch: 3,
          at: 1234,
        },
      }),
      recoverTerminal: async event => {
        recovered.push(event);
        return { ok: true, runId: event.taskRunId };
      },
    });
    assert.equal(result.terminalRecovered, 1, classifyState);
    assert.deepEqual(recovered, [{
      type: 'completed',
      sessionId: 'slot-1',
      entryId: 'entry-1',
      taskId: 'task-1',
      taskRunId: 'run-1',
      leaseEpoch: 3,
      classifyState,
      turnOutcome: classifyState === 'D' ? 'succeeded' : 'failed',
      reason: `classified_${classifyState}`,
      attemptOutcome: null,
      at: 1234,
      recovered: true,
    }]);
    assert.equal(h.records.get('slot-1').taskRunQuarantined, undefined);
  }
});

test('startup recovery never terminal-finalizes retained W or B TaskRun boundaries', async () => {
  for (const classifyState of ['W', 'B']) {
    const h = fixture([lease()]);
    let recovered = 0;
    const result = await reconcileTaskRunSlotLeases({
      store: h.store,
      records: h.records,
      persistRecords: () => true,
      getSchedulerStatus: async slotId => ({
        sessionId: slotId,
        active: null,
        classifyState,
        lastDecision: {
          action: 'complete', taskId: 'task-1', taskRunId: 'run-1', leaseEpoch: 3,
        },
      }),
      recoverTerminal: async () => { recovered += 1; return { ok: true }; },
    });
    assert.equal(recovered, 0, classifyState);
    assert.equal(result.terminalRecovered, 0, classifyState);
    assert.equal(result.quarantined, 0, classifyState);
    assert.deepEqual(h.records.get('slot-1').taskRunLease, {
      runId: 'run-1', leaseEpoch: 3,
    });
  }
});

test('a terminal scheduler decision for the wrong TaskRun lease quarantines without cleanup', async () => {
  for (const lastDecision of [
    { taskRunId: 'run-other', leaseEpoch: 3 },
    { taskRunId: 'run-1', leaseEpoch: 99 },
  ]) {
    const h = fixture([lease()]);
    let recovered = 0;
    const result = await reconcileTaskRunSlotLeases({
      store: h.store,
      records: h.records,
      persistRecords: () => true,
      getSchedulerStatus: async slotId => ({
        sessionId: slotId,
        active: null,
        classifyState: 'D',
        lastDecision: { action: 'complete', taskId: 'task-1', ...lastDecision },
      }),
      recoverTerminal: async () => { recovered += 1; return { ok: true }; },
    });
    assert.equal(recovered, 0);
    assert.equal(result.terminalRecovered, 0);
    assert.equal(result.quarantined, 1);
    assert.equal(h.records.get('slot-1').taskRunQuarantined, true);
    assert.equal(h.calls.some(call => call[0] === 'quarantine'
      && call[1].code === 'TASK_RUN_SCHEDULER_LEASE_MISMATCH'), true);
  }
});

test('a retained or active scheduler boundary for another lease also quarantines fail-closed', async () => {
  for (const status of [
    {
      sessionId: 'slot-1', active: null, classifyState: 'W',
      lastDecision: {
        action: 'complete', taskRunId: 'run-other', leaseEpoch: 3,
      },
    },
    {
      sessionId: 'slot-1', classifyState: 'P',
      active: { taskRunId: 'run-1', leaseEpoch: 99 },
    },
  ]) {
    const h = fixture([lease()]);
    let recovered = 0;
    const result = await reconcileTaskRunSlotLeases({
      store: h.store,
      records: h.records,
      persistRecords: () => true,
      getSchedulerStatus: async () => status,
      recoverTerminal: async () => { recovered += 1; return { ok: true }; },
    });
    assert.equal(recovered, 0);
    assert.equal(result.quarantined, 1);
    assert.equal(h.records.get('slot-1').taskRunQuarantined, true);
  }
});
