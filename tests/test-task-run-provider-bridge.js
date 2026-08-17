'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createTaskRunProviderBridge } = require('../src/task-run-provider-bridge');

function fixture() {
  const calls = [];
  const microtasks = [];
  const records = new Map([['slot-1', {
    taskRunLease: { runId: 'run-1', leaseEpoch: 4 },
  }]]);
  const bridge = createTaskRunProviderBridge({
    records,
    recordActivity: event => calls.push(['activity', event.phase]),
    recordLegacyUsage: event => { calls.push(['legacy', event.eventId]); return true; },
    recordTaskRunUsage: event => { calls.push(['run', event]); return { ok: true }; },
    scheduleMicrotask: fn => microtasks.push(fn),
  });
  return { bridge, calls, records, microtasks };
}

test('provider request captures its explicit run lease instead of consulting a later slot owner', () => {
  const h = fixture();
  h.bridge.onActivity({ sessionId: 'slot-1', phase: 'request' });
  h.records.get('slot-1').taskRunLease = { runId: 'run-2', leaseEpoch: 1 };
  h.bridge.onUsageObserved({ sessionId: 'slot-1', eventId: 'usage-1' });
  const forwarded = h.calls.find(call => call[0] === 'run')[1];
  assert.equal(forwarded.taskRunId, 'run-1');
  assert.equal(forwarded.leaseEpoch, 4);
  assert.deepEqual(forwarded.taskRunLease, { runId: 'run-1', leaseEpoch: 4 });
});

test('native subagent routing identity survives lease capture into the TaskRun usage sink', () => {
  const h = fixture();
  h.bridge.onActivity({
    sessionId: 'slot-1', phase: 'request', role: 'sub',
    providerId: 'provider-sub', providerName: 'Provider Sub',
  });
  h.bridge.onUsageObserved({
    eventId: 'usage-sub-1', occurredAt: 100, sessionId: 'slot-1',
    providerId: 'provider-sub', providerName: 'Provider Sub',
    roleKind: 'sub', agentRole: 'worker', routeName: 'worker',
    protocol: 'openai-responses', model: 'model-sub', source: 'exact',
    coverage: 'observed', status: 'success',
    tokens: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1 },
  });
  const forwarded = h.calls.find(call => call[0] === 'run')[1];
  assert.deepEqual({
    sessionId: forwarded.sessionId,
    taskRunId: forwarded.taskRunId,
    leaseEpoch: forwarded.leaseEpoch,
    providerId: forwarded.providerId,
    providerName: forwarded.providerName,
    roleKind: forwarded.roleKind,
    agentRole: forwarded.agentRole,
    routeName: forwarded.routeName,
    model: forwarded.model,
  }, {
    sessionId: 'slot-1', taskRunId: 'run-1', leaseEpoch: 4,
    providerId: 'provider-sub', providerName: 'Provider Sub',
    roleKind: 'sub', agentRole: 'worker', routeName: 'worker', model: 'model-sub',
  });
});

test('end keeps the binding through the current microtask for codex end-before-usage ordering', () => {
  const h = fixture();
  h.bridge.onActivity({ sessionId: 'slot-1', phase: 'request' });
  h.bridge.onActivity({ sessionId: 'slot-1', phase: 'end' });
  h.bridge.onUsageObserved({ sessionId: 'slot-1', eventId: 'usage-1' });
  assert.equal(h.calls.filter(call => call[0] === 'run').length, 1);
  h.microtasks.splice(0).forEach(fn => fn());
  h.bridge.onUsageObserved({ sessionId: 'slot-1', eventId: 'late' });
  assert.equal(h.calls.filter(call => call[0] === 'run').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'legacy').length, 2);
});

test('a request without a run lease never borrows a lease installed later', () => {
  const h = fixture();
  delete h.records.get('slot-1').taskRunLease;
  h.bridge.onActivity({ sessionId: 'slot-1', phase: 'request' });
  h.records.get('slot-1').taskRunLease = { runId: 'run-2', leaseEpoch: 1 };
  h.bridge.onUsageObserved({ sessionId: 'slot-1', eventId: 'usage-1' });
  assert.equal(h.calls.filter(call => call[0] === 'run').length, 0);
  assert.equal(h.calls.filter(call => call[0] === 'legacy').length, 1);
});

test('the singleton aux session stays global and cannot borrow an unrelated TaskRun slot lease', () => {
  const h = fixture();
  h.records.set('aux', { id: 'aux', type: 'aux' });
  h.bridge.onActivity({ sessionId: 'aux', phase: 'request', role: 'aux' });
  h.bridge.onUsageObserved({
    eventId: 'usage-aux-1', sessionId: 'aux', roleKind: 'aux',
    providerId: 'provider-aux', model: 'model-aux',
  });
  assert.equal(h.calls.filter(call => call[0] === 'run').length, 0);
  assert.equal(h.calls.filter(call => call[0] === 'legacy').length, 1);
});

test('concurrent requests for one run retain the captured binding until every request ends', () => {
  const h = fixture();
  h.bridge.onActivity({ sessionId: 'slot-1', phase: 'request' });
  h.bridge.onActivity({ sessionId: 'slot-1', phase: 'request' });
  h.bridge.onActivity({ sessionId: 'slot-1', phase: 'end' });
  h.microtasks.splice(0).forEach(fn => fn());
  h.bridge.onUsageObserved({ sessionId: 'slot-1', eventId: 'usage-1' });
  assert.equal(h.calls.filter(call => call[0] === 'run').length, 1);
  h.bridge.onActivity({ sessionId: 'slot-1', phase: 'end' });
  h.microtasks.splice(0).forEach(fn => fn());
  h.bridge.onUsageObserved({ sessionId: 'slot-1', eventId: 'late' });
  assert.equal(h.calls.filter(call => call[0] === 'run').length, 1);
});

test('drainState fences finalization until every request for the exact run has ended', () => {
  const h = fixture();
  assert.deepEqual(h.bridge.drainState('slot-1', { runId: 'run-1', leaseEpoch: 4 }), {
    drained: true, active: 0, ambiguous: false,
  });
  h.bridge.onActivity({ sessionId: 'slot-1', phase: 'request' });
  assert.deepEqual(h.bridge.drainState('slot-1', { runId: 'run-1', leaseEpoch: 4 }), {
    drained: false, active: 1, ambiguous: false,
  });
  assert.deepEqual(h.bridge.drainState('slot-1', { runId: 'run-2', leaseEpoch: 1 }), {
    drained: false, active: 1, ambiguous: true,
  });
  h.bridge.onActivity({ sessionId: 'slot-1', phase: 'end' });
  assert.deepEqual(h.bridge.drainState('slot-1', { runId: 'run-1', leaseEpoch: 4 }), {
    drained: true, active: 0, ambiguous: false,
  });
});

test('waitForDrain joins lease-scoped provider requests and times out fail-closed', async () => {
  const h = fixture();
  h.bridge.onActivity({ sessionId: 'slot-1', phase: 'request' });
  const joined = h.bridge.waitForDrain('slot-1', { runId: 'run-1', leaseEpoch: 4 }, {
    timeoutMs: 100,
    pollMs: 1,
  });
  setTimeout(() => h.bridge.onActivity({ sessionId: 'slot-1', phase: 'end' }), 5);
  assert.deepEqual(await joined, { drained: true, active: 0, ambiguous: false });

  h.bridge.onActivity({ sessionId: 'slot-1', phase: 'request' });
  await assert.rejects(
    h.bridge.waitForDrain('slot-1', { runId: 'run-1', leaseEpoch: 4 }, {
      timeoutMs: 5,
      pollMs: 1,
    }),
    error => error && error.code === 'TASK_RUN_PRODUCERS_DRAIN_TIMEOUT',
  );
  h.bridge.onActivity({ sessionId: 'slot-1', phase: 'end' });
});

test('waitForDrain rejects an ambiguous lease immediately', async () => {
  const h = fixture();
  h.bridge.onActivity({ sessionId: 'slot-1', phase: 'request' });
  await assert.rejects(
    h.bridge.waitForDrain('slot-1', { runId: 'run-other', leaseEpoch: 1 }),
    error => error && error.code === 'TASK_RUN_PRODUCERS_DRAIN_AMBIGUOUS',
  );
});
