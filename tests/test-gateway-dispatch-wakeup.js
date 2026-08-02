'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createGatewayHost } = require('../src/dispatch/gateway-host');

function hostFixture({ busy = false, tickError = null } = {}) {
  const records = new Map([
    ['commander', {
      id: 'commander', dirId: 'dir-a', kind: 'chat', type: 'commander',
    }],
    ['fresh-worker', {
      id: 'fresh-worker', dirId: 'dir-a', kind: 'chat', type: 'worker',
      cli: 'codex', cliSessionId: null,
    }],
  ]);
  const directories = new Map([['dir-a', { id: 'dir-a', path: '/tmp' }]]);
  const admissions = [];
  let tickCalls = 0;
  let releaseTick;
  const tickGate = new Promise(resolve => { releaseTick = resolve; });
  const runtime = {
    admitDispatch: async spec => {
      admissions.push(spec);
      return {
        id: 'op-fresh-worker',
        status: 'admitted',
        createdAt: 10,
        idempotent: false,
      };
    },
    tick: async () => {
      tickCalls += 1;
      if (tickError) throw tickError;
      await tickGate;
    },
  };
  const warnings = [];
  const host = createGatewayHost({
    persistedSessions: records,
    chatSessions: new Map(),
    directories,
    logger: { warn: (event, fields) => warnings.push({ event, fields }) },
    getChatHistoryService: () => ({ replace() {} }),
    appendEvent() {},
    getSessionDelivery: () => ({ deliverContinuation() {}, deliverSystem() {} }),
    normalizeEffort: value => value,
    dispatchTargetHintFor: () => '',
    cwdForSession: record => record.worktreePath || '/tmp',
    getSetSessionStatus: () => () => {},
    isTargetBusy: () => busy,
    getOrchestrationRuntime: () => runtime,
    getTaskContextHost: () => ({ dispatchSpec: options => options }),
    getCreateSessionRecord: () => async () => {
      throw new Error('an existing fresh chat must not be recreated');
    },
    appendChatMessage() {},
    chatBroadcast() {},
    loadChatHistory: () => [],
  });
  return {
    admissions,
    host,
    releaseTick,
    tickCalls: () => tickCalls,
    warnings,
  };
}

test('dispatch admission awaits one scheduler pass before reporting a fresh chat accepted', async () => {
  const fixture = hostFixture();
  let settled = false;
  const pending = fixture.host.dispatchToSession('fresh-worker', 'do the work', {
    ownerSessionId: 'commander',
    oneWay: true,
    requireIdle: false,
    idempotencyKey: 'fresh-route-1',
  }).then(result => {
    settled = true;
    return result;
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.admissions.length, 1, 'the durable operation is admitted first');
  assert.equal(fixture.tickCalls(), 1, 'the canonical dispatcher owns the scheduler wake-up');
  assert.equal(settled, false, 'route_task cannot acknowledge before the first scheduler pass');

  fixture.releaseTick();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.chatId, 'fresh-worker');
});

test('running targets keep the same admission path and remain scheduler-owned', async () => {
  const fixture = hostFixture({ busy: true });
  const pending = fixture.host.dispatchToSession('fresh-worker', 'queue this work', {
    ownerSessionId: 'commander',
    oneWay: true,
    requireIdle: false,
    idempotencyKey: 'busy-route-1',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.admissions.length, 1);
  assert.equal(fixture.tickCalls(), 1);
  fixture.releaseTick();
  assert.equal((await pending).ok, true);
});

// The wake-up runs after the durable admission, so it is an observer: a failing
// tick only delays the first delivery attempt, which the periodic worker tick
// and startup recovery retry from the same outbox row. Reporting a failure here
// would tell the caller its task was never submitted when in fact it is queued.
test('a failing scheduler wake-up degrades the tick, not the admission', async () => {
  const fixture = hostFixture({ tickError: new Error('scheduler unavailable') });
  const result = await fixture.host.dispatchToSession('fresh-worker', 'do the work', {
    ownerSessionId: 'commander',
    oneWay: true,
    requireIdle: false,
    idempotencyKey: 'wakeup-failure-1',
  });

  assert.equal(fixture.admissions.length, 1, 'the dispatch is still admitted durably');
  assert.equal(fixture.tickCalls(), 1);
  assert.equal(result.ok, true, 'admission is not reported as a failure');
  assert.equal(result.operationId, 'op-fresh-worker', 'the caller keeps its operation id');
  assert.equal(result.status, 'admitted');
  assert.equal(result.wakeupError, 'scheduler unavailable', 'the degraded wake-up is stated, not hidden');
  assert.deepEqual(
    fixture.warnings.map(entry => entry.event),
    ['dispatch_wakeup_deferred'],
  );
  assert.equal(fixture.warnings[0].fields.operationId, 'op-fresh-worker');
  assert.equal(fixture.warnings[0].fields.error, 'scheduler unavailable');
});

test('a successful wake-up carries no degraded marker', async () => {
  const fixture = hostFixture();
  const pending = fixture.host.dispatchToSession('fresh-worker', 'do the work', {
    ownerSessionId: 'commander',
    oneWay: true,
    requireIdle: false,
    idempotencyKey: 'wakeup-ok-1',
  });
  fixture.releaseTick();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal('wakeupError' in result, false);
  assert.deepEqual(fixture.warnings, []);
});
