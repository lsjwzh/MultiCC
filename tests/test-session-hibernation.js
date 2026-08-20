'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_HIBERNATE_BATCH_SIZE,
  DEFAULT_HIBERNATE_IDLE_MS,
  createSessionHibernationRuntime,
  evaluateSessionEligibility,
  inferLastWorkAt,
  initializeSessionWorktrees,
  resolveSessionCwd,
} = require('../src/session-hibernation');

const DAY = 24 * 60 * 60 * 1000;
const iso = value => new Date(value).toISOString();

function harness(overrides = {}) {
  let nowMs = overrides.nowMs ?? 20 * DAY;
  const records = overrides.records || new Map();
  const directories = overrides.directories || new Map([
    ['dir-1', { id: 'dir-1', path: '/repo', baseBranch: 'main' }],
  ]);
  const writes = [];
  const events = [];
  const timers = [];
  const git = {
    inspect: async (_dir, record) => ({
      pathExists: record._pathExists !== false,
      branchExists: record._branchExists !== false,
      valid: record._valid !== false,
    }),
    detach: async (_dir, record) => {
      if (record._detachError) throw Object.assign(new Error('detach failed'), { code: record._detachError });
      record._pathExists = false;
      return { ok: true, snapshot: 'abc123' };
    },
    thaw: async (_dir, record) => {
      if (record._thawError) throw Object.assign(new Error('thaw failed'), { code: record._thawError });
      record._pathExists = true;
      return { ok: true, worktreePath: `/repo/.multicc-worktrees/${record.id}`, branch: record.branch };
    },
    ...overrides.git,
  };
  const runtime = createSessionHibernationRuntime({
    records,
    directories,
    persistence: overrides.persistence || {
      mutate(source, fn) {
        const value = fn(records);
        writes.push({ source, records: structuredClone([...records.values()]) });
        return value;
      },
    },
    git,
    loadHistory: overrides.loadHistory || (() => []),
    inspectBlockers: overrides.inspectBlockers || (async () => []),
    closePersistent: overrides.closePersistent || (async () => ({ closed: true })),
    updateChatCwd: overrides.updateChatCwd || (() => {}),
    now: () => nowMs,
    setTimeoutFn: fn => { const timer = { fn, unref() {}, cleared: false }; timers.push(timer); return timer; },
    clearTimeoutFn: timer => { timer.cleared = true; },
    onEvent: event => events.push(event),
    idleMs: overrides.idleMs,
    intervalMs: overrides.intervalMs,
    startupDelayMs: overrides.startupDelayMs,
    batchSize: overrides.batchSize,
  });
  return { runtime, records, directories, writes, events, timers, git, setNow: n => { nowMs = n; } };
}

function bound(id, lastWorkAt = iso(10 * DAY), extra = {}) {
  return {
    id, dirId: 'dir-1', kind: 'chat', taskBoundTaskId: `task-${id}`,
    branch: `multicc/${id}`, worktreePath: `/repo/.multicc-worktrees/${id}`,
    createdAt: iso(DAY), workspaceState: 'awake', lastWorkAt, ...extra,
  };
}

test('eligibility starts at the exact seven-day edge and uses a conservative exclusion table', () => {
  const now = 20 * DAY;
  assert.equal(DEFAULT_HIBERNATE_IDLE_MS, 7 * DAY);
  assert.equal(DEFAULT_HIBERNATE_BATCH_SIZE, 5);
  assert.equal(evaluateSessionEligibility(bound('edge', iso(now - 7 * DAY)), { nowMs: now }).eligible, true);
  assert.equal(evaluateSessionEligibility(bound('fresh', iso(now - 7 * DAY + 1)), { nowMs: now }).eligible, false);
  const excluded = [
    { kind: 'terminal' }, { taskBoundTaskId: null }, { taskExecutionSlot: true },
    { ephemeral: true }, { experimentalMode: 'tui' }, { type: 'commander' },
    { type: 'gateway' }, { type: 'worker' }, { type: 'aux' }, { type: 'system' },
    { loginFlow: 'codex-login' }, { triggers: [{ enabled: true }] },
    { workspaceState: 'hibernated' }, { rebaseInProgress: true }, { mergeInProgress: true },
  ];
  for (const patch of excluded) {
    assert.equal(evaluateSessionEligibility(bound('x', iso(now - 8 * DAY), patch), { nowMs: now }).eligible, false, JSON.stringify(patch));
  }
  assert.equal(evaluateSessionEligibility(bound('waiting', iso(now - 8 * DAY), {
    taskState: { classifyState: 'W' },
  }), { nowMs: now }).eligible, true, 'waiting for user is static and may hibernate');
  assert.equal(evaluateSessionEligibility(bound('blocked', iso(now - 8 * DAY)), {
    nowMs: now, blockers: ['scheduler_queue'],
  }).eligible, false);
});

test('legacy lastWorkAt backfill ignores lastActivity and interim rows but includes durable transcript and task times', () => {
  const record = {
    createdAt: iso(DAY),
    lastActivity: iso(19 * DAY),
    taskState: { runStartedAt: 4 * DAY, updatedAt: 5 * DAY },
  };
  const history = [
    { role: 'assistant', ts: 9 * DAY, _interim: true },
    { role: 'assistant', ts: 7 * DAY },
    { role: 'user', ts: 6 * DAY },
  ];
  assert.equal(inferLastWorkAt(record, history), iso(7 * DAY));
  assert.equal(inferLastWorkAt({ createdAt: iso(DAY), lastActivity: iso(19 * DAY) }, []), iso(DAY));
});

test('startup persists legacy lastWorkAt backfill before scanning', async () => {
  const record = bound('legacy', undefined, { lastWorkAt: null, createdAt: iso(DAY) });
  const h = harness({
    records: new Map([[record.id, record]]),
    loadHistory: () => [
      { role: 'assistant', ts: 8 * DAY, interim: true },
      { role: 'user', ts: 6 * DAY },
    ],
  });
  await h.runtime.reconcileStartup();
  assert.equal(record.lastWorkAt, iso(6 * DAY));
  assert.ok(h.writes.some(write => write.source === 'startup.hibernate-last-work-backfill'));
});

test('sweep is oldest-first, capped at five and non-reentrant', async () => {
  const records = new Map();
  for (let i = 0; i < 7; i += 1) records.set(`s${i}`, bound(`s${i}`, iso((i + 1) * DAY)));
  let gateResolve;
  const gate = new Promise(resolve => { gateResolve = resolve; });
  let detaches = 0;
  const h = harness({ records, git: { detach: async (_dir, record) => {
    detaches += 1;
    if (detaches === 1) await gate;
    record._pathExists = false;
    return { ok: true, snapshot: record.id };
  } } });
  const first = h.runtime.sweep();
  const joined = h.runtime.sweep();
  assert.equal(first, joined, 'concurrent sweeps join the same promise');
  gateResolve();
  const result = await first;
  assert.equal(result.hibernated, 5);
  assert.deepEqual([...records.values()].filter(r => r.workspaceState === 'hibernated').map(r => r.id), ['s0', 's1', 's2', 's3', 's4']);
});

test('hibernate is idempotent, uses required transitions and records safe failure codes', async () => {
  const records = new Map([
    ['ok', bound('ok', iso(DAY))],
    ['bad', bound('bad', iso(DAY), { _detachError: 'GIT_REFUSED' })],
  ]);
  const h = harness({ records });
  assert.equal((await h.runtime.hibernate('ok')).ok, true);
  assert.equal(records.get('ok').workspaceState, 'hibernated');
  assert.ok(records.get('ok').hibernatedAt);
  assert.equal((await h.runtime.hibernate('ok')).already, true);
  const failed = await h.runtime.hibernate('bad');
  assert.equal(failed.ok, false);
  assert.equal(records.get('bad').workspaceState, 'awake');
  assert.equal(records.get('bad').workspaceStateErrorCode, 'GIT_REFUSED');
  assert.ok(h.writes.some(write => write.source === 'runtime.hibernate.preparing'));
  assert.ok(h.writes.some(write => write.source === 'runtime.hibernate.failed'));
});

test('concurrent admission thaws once, admits after path restore, then persists lastWorkAt', async () => {
  const record = bound('sleeping', iso(DAY), { workspaceState: 'hibernated', _pathExists: false, hibernatedAt: iso(10 * DAY) });
  const records = new Map([[record.id, record]]);
  let thaws = 0;
  const order = [];
  const h = harness({ records, git: { thaw: async (_dir, current) => {
    thaws += 1; order.push('thaw'); current._pathExists = true;
    return { ok: true, worktreePath: `/repo/.multicc-worktrees/${current.id}`, branch: current.branch };
  } } });
  const admit = async () => { order.push('admit'); return { ok: true, queued: false }; };
  const [a, b] = await Promise.all([
    h.runtime.admit(record.id, admit),
    h.runtime.admit(record.id, admit),
  ]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(thaws, 1);
  assert.deepEqual(order, ['thaw', 'admit', 'admit']);
  assert.equal(record.workspaceState, 'awake');
  assert.equal(record.hibernatedAt, null);
  assert.equal(record.lastWorkAt, iso(20 * DAY));
});

test('thaw failure admits nothing, persists error, and never falls back to another cwd', async () => {
  const record = bound('missing', iso(DAY), {
    workspaceState: 'hibernated', _pathExists: false, _branchExists: false,
  });
  const h = harness({ records: new Map([[record.id, record]]) });
  let admitted = 0;
  const result = await h.runtime.admit(record.id, async () => { admitted += 1; return { ok: true }; });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'hibernate_branch_missing');
  assert.equal(result.workspaceUnavailable, true);
  assert.equal(admitted, 0);
  assert.equal(record.workspaceState, 'hibernated');
  assert.equal(record.workspaceStateErrorCode, 'hibernate_branch_missing');
  assert.throws(() => h.runtime.assertAwake(record.id), error => error.code === 'SESSION_HIBERNATED');
});

test('required persistence failure stops before detach or admission', async () => {
  const awake = bound('persist-hibernate', iso(DAY));
  let detaches = 0;
  const failPersistence = { mutate() { const error = new Error('EIO'); error.code = 'SESSION_PERSISTENCE_FAILED'; throw error; } };
  const hibernateHarness = harness({
    records: new Map([[awake.id, awake]]), persistence: failPersistence,
    git: { detach: async () => { detaches += 1; return { ok: true }; } },
  });
  await assert.rejects(hibernateHarness.runtime.hibernate(awake.id), /EIO/);
  assert.equal(detaches, 0);
  assert.equal(awake.workspaceState, 'awake');

  const sleeping = bound('persist-thaw', iso(DAY), { workspaceState: 'hibernated', _pathExists: false });
  const thawHarness = harness({ records: new Map([[sleeping.id, sleeping]]), persistence: failPersistence });
  let admissions = 0;
  await assert.rejects(thawHarness.runtime.admit(sleeping.id, async () => { admissions += 1; return { ok: true }; }), /EIO/);
  assert.equal(admissions, 0);
  assert.equal(sleeping.workspaceState, 'hibernated');

  await assert.rejects(thawHarness.runtime.acquireDelivery(sleeping.id), /EIO/);
  assert.equal(thawHarness.runtime.status().activeOperations, 0);
  await thawHarness.runtime.stop();
});

test('cwd resolution is fail-closed and never falls back to the base repository', () => {
  const directories = new Map([['dir-1', { id: 'dir-1', path: '/repo/main' }]]);
  const cwd = resolveSessionCwd({
    id: 'bound-cold', dirId: 'dir-1', kind: 'chat', workspaceState: 'hibernated',
    worktreePath: '/repo/.multicc-worktrees/bound-cold',
  }, {
    directories, dataRoot: '/private/data', existsSync: () => false, homeDir: () => '/home/user',
  });
  assert.equal(cwd, '/private/data/unavailable-workspaces/bound-cold');
  assert.notEqual(cwd, '/repo/main');
  assert.notEqual(cwd, '/home/user');
});

test('startup worktree initialization skips sleeping records and requires retained task branches', async () => {
  const records = new Map([
    ['sleeping', bound('sleeping', iso(DAY), { workspaceState: 'hibernated' })],
    ['bound-awake', bound('bound-awake', iso(DAY))],
    ['ordinary', { id: 'ordinary', dirId: 'dir-1', kind: 'chat', createdAt: iso(DAY) }],
  ]);
  const calls = [];
  const invalidSessions = new Map();
  const result = await initializeSessionWorktrees({
    records,
    directories: new Map([['dir-1', { id: 'dir-1', path: '/repo', baseBranch: 'main' }]]),
    invalidSessions,
    realPathOf: value => value,
    isHomeOrAbove: () => false,
    ensureDirGitReady: async () => ({ ok: true }),
    addWorktree: async (_path, id, _base, options) => {
      calls.push({ id, options });
      return { worktreePath: `/repo/.multicc-worktrees/${id}`, branch: `multicc/${id}` };
    },
    existsSync: () => false,
    tmuxHasSession: async () => false,
    tmuxKillSession: async () => {},
    saveDirectories: () => {},
    saveSessions: () => {},
    auxSessionId: '__aux__',
    log: { log() {} },
  });
  assert.equal(result.built, 2);
  assert.deepEqual(calls.map(call => call.id), ['bound-awake', 'ordinary']);
  assert.equal(calls[0].options.requireExistingBranch, true);
  assert.equal(calls[1].options.requireExistingBranch, undefined);
  assert.equal(records.get('sleeping').worktreePath.includes('sleeping'), true);
});

test('startup reconcile implements the crash matrix without creating a branch', async () => {
  const cases = [
    bound('hp', iso(DAY), { workspaceState: 'hibernating', _pathExists: true }),
    bound('hm', iso(DAY), { workspaceState: 'hibernating', _pathExists: false }),
    bound('tp', iso(DAY), { workspaceState: 'thawing', _pathExists: true }),
    bound('tm', iso(DAY), { workspaceState: 'thawing', _pathExists: false }),
    bound('surprise', iso(DAY), { workspaceState: 'hibernated', _pathExists: true }),
    bound('lost', iso(DAY), { workspaceState: 'hibernated', _pathExists: false, _branchExists: false }),
  ];
  const h = harness({ records: new Map(cases.map(record => [record.id, record])) });
  await h.runtime.reconcileStartup();
  assert.equal(cases[0].workspaceState, 'awake');
  assert.equal(cases[1].workspaceState, 'hibernated');
  assert.equal(cases[2].workspaceState, 'awake');
  assert.equal(cases[3].workspaceState, 'hibernated');
  assert.equal(cases[4].workspaceState, 'awake');
  assert.equal(cases[5].workspaceState, 'hibernated');
  assert.equal(cases[5].workspaceStateErrorCode, 'hibernate_branch_missing');
});

test('delivery lease holds the keyed lock through durable admission and touch', async () => {
  const record = bound('due', iso(DAY), { workspaceState: 'hibernated', _pathExists: false });
  const h = harness({ records: new Map([[record.id, record]]) });
  const lease = await h.runtime.acquireDelivery(record.id);
  let swept = false;
  const pendingSweep = h.runtime.hibernate(record.id).then(() => { swept = true; });
  await Promise.resolve();
  assert.equal(swept, false);
  await lease.complete({ accepted: true, durable: true });
  await pendingSweep;
  assert.equal(record.lastWorkAt, iso(20 * DAY));
});

test('non-interim terminal outcomes touch under the session lock and interim events do not', async () => {
  const record = bound('terminal-touch', iso(DAY));
  const h = harness({ records: new Map([[record.id, record]]) });
  assert.equal(await h.runtime.touchTerminal(record.id, { status: 'running', interim: true }), false);
  assert.equal(record.lastWorkAt, iso(DAY));
  assert.equal(await h.runtime.touchTerminal(record.id, { status: 'failed' }), true);
  assert.equal(record.lastWorkAt, iso(20 * DAY));
  assert.ok(h.writes.some(write => write.source === 'runtime.hibernate.terminal'));
});

test('start schedules bounded sweeps and stop clears timers then joins in-flight work', async () => {
  const record = bound('slow', iso(DAY));
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const h = harness({
    records: new Map([[record.id, record]]), startupDelayMs: 10, intervalMs: 20,
    git: { detach: async (_dir, current) => {
      entered();
      await new Promise(resolve => { release = resolve; });
      current._pathExists = false;
      return { ok: true, snapshot: 'x' };
    } },
  });
  h.runtime.start();
  assert.equal(h.timers.length, 1);
  const running = h.timers[0].fn();
  await started;
  const stopping = h.runtime.stop();
  assert.equal(h.timers[0].cleared, true);
  release();
  await Promise.all([running, stopping]);
  assert.equal(h.runtime.status().stopped, true);
});
