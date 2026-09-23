'use strict';

// The resident pool is the only thing that retires a warm child for CAPACITY
// reasons. These tests pin the three properties that make that safe: a claimed
// lease (busy/queued) is never retired, a child that still delivers something is
// never retired, and retirement is a boundary-respecting request that the lane may
// place later — never a kill.

const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_LIMIT, createResidentPool, selectEvictions } = require('../src/chat/resident-pool');
const { createResidentPoolComposition } = require('../src/chat/resident-composition');
const { createStreamRouter } = require('../src/chat/stream-router');

// Only the ORDER of lastUsedAt matters to the policy, so the tests use one base
// and express age as an offset from it.
const BASE = 1_000_000;

function resident(name, lastUsedAt, extra = {}) {
  return { name, mode: 'legacy', busy: false, queued: 0, lastUsedAt, ...extra };
}

test('a pool under its cap retires nothing', () => {
  assert.deepEqual(selectEvictions({ residents: [], limit: 3 }), []);
  assert.deepEqual(selectEvictions({
    residents: [resident('a', BASE - 5), resident('b', BASE - 4), resident('c', BASE - 3)],
    limit: 3,
  }), []);
  assert.deepEqual(selectEvictions({ residents: [resident('a', BASE)], limit: 3 }), []);
});

test('over the cap the least-recently-used child gives up its place first', () => {
  const retired = selectEvictions({
    residents: [
      resident('newest', BASE - 1), resident('oldest', BASE - 900),
      resident('middle', BASE - 500), resident('second', BASE - 700),
    ],
    limit: 2,
  });
  // Exactly the excess (4 - 2), oldest use first — a sweep never over-retires.
  assert.deepEqual(retired.map(item => item.name), ['oldest', 'second']);
  assert.deepEqual(retired.map(item => item.reason), ['resident_pool_evict', 'resident_pool_evict']);
});

test('a claimed lease is never retired, however old it is', () => {
  const retired = selectEvictions({
    residents: [
      resident('busy-oldest', BASE - 900, { busy: true }),
      resident('queued-oldest', BASE - 800, { queued: 2 }),
      resident('idle-a', BASE - 700), resident('idle-b', BASE - 600),
    ],
    limit: 2,
  });
  // The two idle children fill the two places; the busy and queued ones keep
  // theirs because a turn is in flight on them.
  assert.deepEqual(retired.map(item => item.name), ['idle-a', 'idle-b']);
});

test('a child that still delivers something keeps its place', () => {
  const retired = selectEvictions({
    residents: [
      resident('has-background-task', BASE - 900), resident('has-lease', BASE - 800),
      resident('free-a', BASE - 700), resident('free-b', BASE - 600),
    ],
    limit: 2,
    blocked: name => (name === 'has-background-task' ? 'background_task'
      : name === 'has-lease' ? 'workspace_lease' : null),
  });
  assert.deepEqual(retired.map(item => item.name), ['free-a', 'free-b']);
});

test('an unreachable cap retires what it can and leaves the rest for a later sweep', () => {
  // Six warm children, cap 3, four of them mid-turn: only two can go, and the cap
  // stays unreachable rather than queuing a reclaim that would land mid-turn.
  const residents = [
    resident('a', BASE - 900, { busy: true }), resident('b', BASE - 800, { busy: true }),
    resident('c', BASE - 700, { busy: true }), resident('d', BASE - 600, { queued: 1 }),
    resident('e', BASE - 500), resident('f', BASE - 400),
  ];
  assert.deepEqual(selectEvictions({ residents, limit: 3 }).map(item => item.name), ['e', 'f']);
  // Nothing retirable at all is not an error.
  assert.deepEqual(selectEvictions({ residents: residents.slice(0, 4), limit: 1 }), []);
});

test('a disabled pool is a no-op, not an unbounded sweep', () => {
  const residents = [resident('a', BASE - 900), resident('b', BASE - 800)];
  assert.deepEqual(selectEvictions({ residents, limit: 0 }), []);
});

test('ties break on name so two sweeps of the same state agree', () => {
  const residents = [resident('z', BASE - 100), resident('a', BASE - 100), resident('m', BASE - 100)];
  const first = selectEvictions({ residents, limit: 1 }).map(item => item.name);
  const second = selectEvictions({ residents: [...residents].reverse(), limit: 1 }).map(item => item.name);
  assert.deepEqual(first, ['a', 'm']);
  assert.deepEqual(second, first);
});

test('a sweep retires through the reclaim port, never by killing the child itself', async () => {
  const calls = [];
  const pool = createResidentPool({
    residents: () => [resident('old', 10), resident('new', 20), resident('newest', 30)],
    reclaim: (name, reason) => { calls.push([name, reason]); return { ok: true, applied: 'now' }; },
    limit: 2,
  });
  const result = await pool.sweep();
  assert.deepEqual(calls, [['old', 'resident_pool_evict']]);
  assert.deepEqual(result, { ok: true, warm: 3, reclaimed: [{ name: 'old', applied: 'now' }] });
});

test('a reclaim placed at the next turn boundary still counts as done', async () => {
  const pool = createResidentPool({
    residents: () => [resident('old', 10), resident('new', 20), resident('newest', 30)],
    reclaim: () => ({ ok: true, applied: 'deferred-boundary' }),
    limit: 2,
  });
  const result = await pool.sweep();
  assert.deepEqual(result.reclaimed, [{ name: 'old', applied: 'deferred-boundary' }]);
});

test('a lane that cannot place the reclaim is reported, and the sweep carries on', async () => {
  const events = [];
  const attempted = [];
  const pool = createResidentPool({
    residents: () => [resident('a', 1), resident('b', 2), resident('c', 3), resident('d', 4)],
    reclaim: name => {
      attempted.push(name);
      if (name === 'a') return { ok: false, applied: 'kill-failed' };
      if (name === 'b') throw new Error('lane went away');
      return { ok: true, applied: 'unknown-session' };
    },
    limit: 1,
    onEvent: event => events.push(event),
  });
  const result = await pool.sweep();
  // The three excess children are attempted one by one; none of the three ways a
  // request can fail to land (refused, thrown, unknown session) aborts the rest,
  // and a sweep that placed nothing still resolves as a completed sweep.
  assert.deepEqual(attempted, ['a', 'b', 'c']);
  assert.deepEqual(result, { ok: true, warm: 4, reclaimed: [] });
  assert.deepEqual(events, [], 'nothing is announced as reclaimed unless it landed');
});

test('an unreachable backend cannot silence every later sweep', async () => {
  const pool = createResidentPool({
    residents: () => { throw new Error('router gone'); },
    reclaim: () => ({ ok: true, applied: 'now' }),
    limit: 1,
    logger: { warn: () => {} },
  });
  const result = await pool.sweep();
  assert.equal(result.ok, false);
  assert.deepEqual(result.reclaimed, []);
});

test('concurrent sweeps share one pass', async () => {
  let calls = 0;
  const pool = createResidentPool({
    residents: () => [resident('old', 1), resident('new', 2)],
    reclaim: () => { calls += 1; return { ok: true, applied: 'now' }; },
    limit: 1,
  });
  await Promise.all([pool.sweep(), pool.sweep()]);
  assert.equal(calls, 1);
});

test('the pool reports the cap it enforces and refuses to run without its ports', () => {
  const pool = createResidentPool({ residents: () => [resident('a', 1)], reclaim: () => {}, limit: 4 });
  assert.deepEqual(pool.policy(), { limit: 4, sweepMs: 300000, enabled: true });
  const status = pool.status();
  assert.equal(status.limit, 4);
  assert.equal(status.warm, 1);
  assert.ok(status.oldestIdleMs > 0, 'the pool reports how long its least recently used child has been idle');
  assert.equal(createResidentPool({ residents: () => [], reclaim: () => {} }).policy().limit, DEFAULT_LIMIT);
  assert.throws(() => createResidentPool({ reclaim: () => {} }), /residents port is required/);
  assert.throws(() => createResidentPool({ residents: () => [] }), /reclaim port is required/);
});

test('the host composition holds back a child that still has work to deliver', async () => {
  const reclaimed = [];
  const warm = [
    { name: 'bg-task', mode: 'legacy', busy: false, queued: 0, lastUsedAt: 10 },
    { name: 'running-slot', mode: 'app-server', busy: false, queued: 0, lastUsedAt: 20 },
    { name: 'free-a', mode: 'sdk', busy: false, queued: 0, lastUsedAt: 30 },
    { name: 'free-b', mode: 'legacy', busy: false, queued: 0, lastUsedAt: 40 },
  ];
  const pool = createResidentPoolComposition({
    chatStream: { residents: () => warm, recycle: (name, reason) => { reclaimed.push([name, reason]); return { ok: true, applied: 'now' }; } },
    backgroundTaskRuntime: { hasLiveBackgroundTasks: id => id === 'bg-task' },
    getWorkspaceAdmission: () => ({ hasActiveLease: () => false }),
    sessionWorkHost: { isRunActive: id => id === 'running-slot' },
    logger: { info: () => {}, warn: () => {} },
  });
  assert.equal(pool.policy().limit, DEFAULT_LIMIT);
  const tight = createResidentPool({
    residents: () => warm,
    reclaim: (name, reason) => { reclaimed.push([name, reason]); return { ok: true, applied: 'now' }; },
    blocked: id => (id === 'bg-task' ? 'background_task' : id === 'running-slot' ? 'running_task' : null),
    limit: 2,
  });
  await tight.sweep();
  assert.deepEqual(reclaimed, [['free-a', 'resident_pool_evict'], ['free-b', 'resident_pool_evict']]);
});

test('the router reports every warm child a lane still holds, and forgets the rest', async () => {
  const calls = [];
  const lane = (label) => {
    const live = new Map();
    return {
      ensure: name => { live.set(name, { busy: false, queued: 0 }); },
      send: () => Promise.resolve(),
      close: name => { live.delete(name); },
      closeAndWait: name => { live.delete(name); return Promise.resolve({ closed: true }); },
      status: name => live.get(name) || null,
      recycle: (name, reason) => { calls.push([label, name, reason]); return { ok: true, applied: 'now' }; },
    };
  };
  const legacy = lane('legacy'); const sdk = lane('sdk');
  const router = createStreamRouter(legacy, sdk);

  router.ensure('plain', {});
  router.ensure('sdk-session', { sdkOptions: { pathToClaudeCodeExecutable: '/x' } });
  await router.send('sdk-session', 'hello');
  const warm = router.residents();
  assert.deepEqual(warm.map(entry => [entry.name, entry.mode]).sort(), [['plain', 'legacy'], ['sdk-session', 'sdk']]);
  for (const entry of warm) assert.ok(entry.lastUsedAt > 0, 'usage is stamped for the LRU order');
  assert.deepEqual(warm.find(entry => entry.name === 'plain').busy, false);

  // A child the lane no longer reports (reaped, closed by a lifecycle caller)
  // drops out here instead of being tracked, and the router forgets it.
  legacy.close('plain');
  assert.deepEqual(router.residents().map(entry => entry.name), ['sdk-session']);

  // And the pool's request reaches the lane that owns the child, with the reason.
  await createResidentPool({ residents: () => router.residents(), reclaim: (name, reason) => router.recycle(name, reason), limit: 0 }).sweep();
  assert.deepEqual(calls, [], 'a disabled pool asks for nothing');
  await createResidentPool({
    residents: () => [...router.residents(), { name: 'ghost', mode: 'legacy', busy: false, queued: 0, lastUsedAt: 0 }],
    reclaim: (name, reason) => router.recycle(name, reason), limit: 1,
  }).sweep();
  assert.deepEqual(calls, [['legacy', 'ghost', 'resident_pool_evict']]);

  await router.closeAndWait('sdk-session');
  assert.deepEqual(router.residents(), []);
});
