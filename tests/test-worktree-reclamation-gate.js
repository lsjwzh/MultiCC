'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSessionHibernationRuntime } = require('../src/session/hibernation');
const { createWorkspaceAdmission } = require('../src/workspace/admission');
const {
  gitWorktreeAdd,
  gitWorktreeDetach,
  gitWorktreeValidate,
} = require('../src/git/service');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-20T00:00:00.000Z');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRepo(root, name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'gate@example.invalid']);
  git(repo, ['config', 'user.name', 'Worktree Reclamation Gate']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\nnode_modules/\n');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'base']);
  return repo;
}

function record(id, dirId, added, extra = {}) {
  return {
    id,
    dirId,
    kind: 'chat',
    taskBoundTaskId: `task-${id}`,
    branch: added.branch,
    worktreePath: added.worktreePath,
    createdAt: new Date(NOW - 4 * DAY_MS).toISOString(),
    lastWorkAt: new Date(NOW - 2 * DAY_MS).toISOString(),
    workspaceState: 'awake',
    ...extra,
  };
}

function hibernationRuntime(records, directories, options = {}) {
  return createSessionHibernationRuntime({
    records,
    directories,
    persistence: { mutate: (_source, mutate) => mutate(records) },
    git: {
      inspect: (directory, current) => gitWorktreeValidate(
        directory.path, current.worktreePath, current.branch, { sessionId: current.id },
      ),
      detach: (directory, current) => gitWorktreeDetach(
        directory.path, current.worktreePath, current.branch, { sessionId: current.id },
      ),
      thaw: (directory, current) => gitWorktreeAdd(
        directory.path, current.id, directory.baseBranch,
        { sessionId: current.id, requireExistingBranch: true },
      ),
    },
    closePersistent: async () => ({ closed: true }),
    now: () => NOW,
    idleMs: DAY_MS,
    intervalMs: options.intervalMs,
    startupDelayMs: options.startupDelayMs,
    batchSize: options.batchSize || 16,
    setTimeoutFn: options.setTimeoutFn,
    clearTimeoutFn: options.clearTimeoutFn,
    logger: { warn() {} },
  });
}

test('reclamation gate: scheduled proactive sweep skips unsafe worktrees, reclaims a safe one and can thaw it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-reclaim-gate-sweep-'));
  let runtime;
  try {
    const repo = createRepo(root, 'repo');
    const unsafeAdded = await gitWorktreeAdd(repo, 'unsafe-oldest', 'main');
    const safeAdded = await gitWorktreeAdd(repo, 'safe-younger', 'main');
    // Unsafe = an in-progress merge (HIBERNATE_GIT_OPERATION_ACTIVE): detach
    // must refuse and the sweep must move on to the next candidate.
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'main change\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'main change']);
    fs.writeFileSync(path.join(unsafeAdded.worktreePath, 'tracked.txt'), 'unsafe change\n');
    git(unsafeAdded.worktreePath, ['add', '.']);
    git(unsafeAdded.worktreePath, ['commit', '-m', 'unsafe change']);
    try { git(unsafeAdded.worktreePath, ['merge', 'main']); } catch (_) { /* conflict expected */ }
    // Unknown ignored files (.env) no longer block reclamation: they are
    // deleted with an audit manifest persisted on the session record.
    fs.writeFileSync(path.join(safeAdded.worktreePath, '.env'), 'DISPOSABLE=1\n');
    fs.writeFileSync(path.join(safeAdded.worktreePath, 'tracked.txt'), 'preserved by snapshot\n');
    fs.writeFileSync(path.join(safeAdded.worktreePath, 'draft.txt'), 'also preserved\n');

    const unsafe = record('unsafe-oldest', 'dir-a', unsafeAdded, {
      lastWorkAt: new Date(NOW - 3 * DAY_MS).toISOString(),
    });
    const safe = record('safe-younger', 'dir-a', safeAdded);
    const records = new Map([[unsafe.id, unsafe], [safe.id, safe]]);
    const directories = new Map([['dir-a', { id: 'dir-a', path: repo, baseBranch: 'main' }]]);
    const timers = [];
    runtime = hibernationRuntime(records, directories, {
      batchSize: 1,
      intervalMs: 60 * 60 * 1000,
      startupDelayMs: 25,
      setTimeoutFn: (fn, delay) => {
        const timer = { fn, delay, cleared: false, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearTimeoutFn: timer => { timer.cleared = true; },
    });

    assert.equal(runtime.start(), true);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 25);
    await timers[0].fn();
    assert.equal(unsafe.workspaceState, 'awake');
    assert.equal(fs.existsSync(unsafe.worktreePath), true);
    assert.equal(safe.workspaceState, 'hibernated',
      'the automatic sweep must continue past the unsafe oldest checkout');
    assert.equal(fs.existsSync(safe.worktreePath), false);
    assert.ok(safe.hibernateRemovedIgnored?.entries?.some(entry => entry.path === '.env'),
      'the deleted unknown ignored file is recorded in the audit manifest');

    assert.equal((await runtime.ensureAwake(safe.id)).ok, true);
    assert.equal(safe.workspaceState, 'awake');
    assert.equal(fs.readFileSync(path.join(safe.worktreePath, 'tracked.txt'), 'utf8'), 'preserved by snapshot\n');
    assert.equal(fs.readFileSync(path.join(safe.worktreePath, 'draft.txt'), 'utf8'), 'also preserved\n');
    assert.equal(fs.existsSync(path.join(safe.worktreePath, '.env')), false,
      'deleted ignored files are not restored by thaw');
  } finally {
    await runtime?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reclamation gate: manual reclaim honours the idle threshold, force and the directory scope', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-reclaim-gate-manual-'));
  let runtime;
  try {
    const repoA = createRepo(root, 'repo-a');
    const repoB = createRepo(root, 'repo-b');
    const aged = await gitWorktreeAdd(repoA, 'aged', 'main');
    const fresh = await gitWorktreeAdd(repoA, 'fresh', 'main');
    const otherAged = await gitWorktreeAdd(repoB, 'other-aged', 'main');
    const records = new Map([
      ['aged', record('aged', 'dir-a', aged, { lastWorkAt: new Date(NOW - 3 * DAY_MS).toISOString() })],
      // 刚用过一小时：没到闲置阈值，默认那条路不该碰它。
      ['fresh', record('fresh', 'dir-a', fresh, { lastWorkAt: new Date(NOW - 60 * 60 * 1000).toISOString() })],
      ['other-aged', record('other-aged', 'dir-b', otherAged, { lastWorkAt: new Date(NOW - 3 * DAY_MS).toISOString() })],
    ]);
    const directories = new Map([
      ['dir-a', { id: 'dir-a', path: repoA, baseBranch: 'main' }],
      ['dir-b', { id: 'dir-b', path: repoB, baseBranch: 'main' }],
    ]);
    runtime = hibernationRuntime(records, directories);

    // 「现在回收」默认只收过了闲置阈值的：dir-a 里那条旧的下去，另一条不动，别的目录
    // 一点都不碰（一个目录的容量债不该让邻居付）。
    const scoped = await runtime.reclaim({ dirId: 'dir-a' });
    assert.equal(scoped.ok, true);
    assert.equal(scoped.hibernated, 1);
    assert.equal(scoped.idleMs, DAY_MS, '回执报的是这次真正用的阈值，不是 0');
    assert.equal(records.get('aged').workspaceState, 'hibernated');
    assert.equal(fs.existsSync(aged.worktreePath), false);
    assert.equal(records.get('fresh').workspaceState, 'awake');
    assert.equal(fs.existsSync(fresh.worktreePath), true);
    assert.equal(records.get('other-aged').workspaceState, 'awake');

    // 剩下的都没到阈值：considered 是 0，不是「收了但跳过」。只有这样面板才敢把
    // 「没有可回收的」和「要不要连最近用过的也收」分成两句话（后者要用户点头）。
    const nothingIdle = await runtime.reclaim({ dirId: 'dir-a' });
    assert.equal(nothingIdle.considered, 0);
    assert.equal(nothingIdle.hibernated, 0);
    assert.equal(records.get('fresh').workspaceState, 'awake');

    // force = 用户明确说了「连最近用过的也一起收」。已经睡下的那条不该被重复算进
    // considered（它没有活可干），所以这里正好是 1 条。
    const forced = await runtime.reclaim({ dirId: 'dir-a', force: true });
    assert.equal(forced.considered, 1);
    assert.equal(forced.hibernated, 1);
    assert.equal(forced.idleMs, 0, 'force 才轮到 0（不等闲置）');
    assert.equal(records.get('fresh').workspaceState, 'hibernated');
    assert.equal(fs.existsSync(fresh.worktreePath), false);

    const otherDirectory = await runtime.reclaim({ dirId: 'dir-b' });
    assert.equal(otherDirectory.hibernated, 1, 'each directory pays its own debt');
    assert.equal(records.get('other-aged').workspaceState, 'hibernated');

    // 不认识的目录、以及停掉之后再来一次：都不该 throw（面板按钮不该变成 500）。
    const unknownDirectory = await runtime.reclaim({ dirId: 'dir-nope' });
    assert.equal(unknownDirectory.ok, true);
    assert.equal(unknownDirectory.considered, 0);

    // 面板照着 policy() 说话：阈值和间隔都由运行时给，客户端不猜默认值；两个里
    // 任何一个被关掉（<= 0），「自动回收」那一档才算关（手动那条路照旧能用）。
    const policy = runtime.policy();
    assert.equal(policy.idleMs, DAY_MS);
    assert.equal(policy.intervalMs, 15 * 60 * 1000);
    assert.equal(policy.enabled, true);
    const disabled = hibernationRuntime(records, directories, { intervalMs: 0 });
    assert.equal(disabled.policy().enabled, false, '关掉自动扫描不等于把「现在回收」也关了');
    assert.equal((await disabled.reclaim({ dirId: 'dir-nope' })).ok, true);
    await disabled.stop();

    await runtime.stop();
    const afterStop = await runtime.reclaim({});
    assert.equal(afterStop.ok, false);
    assert.equal(afterStop.code, 'hibernation_stopped');
  } finally {
    await runtime?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reclamation gate: a full directory reclaims its own LRU workspace and admits the waiting task', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-reclaim-gate-capacity-'));
  let runtime, admission, guard;
  try {
    const repoA = createRepo(root, 'repo-a');
    const repoB = createRepo(root, 'repo-b');
    const victimAdded = await gitWorktreeAdd(repoA, 'victim-a', 'main');
    const otherAdded = await gitWorktreeAdd(repoB, 'resident-b', 'main');
    const victim = record('victim-a', 'dir-a', victimAdded, {
      lastWorkAt: new Date(NOW).toISOString(),
    });
    const other = record('resident-b', 'dir-b', otherAdded, {
      lastWorkAt: new Date(NOW - 3 * DAY_MS).toISOString(),
    });
    const target = {
      id: 'target-a', dirId: 'dir-a', kind: 'chat', taskBoundTaskId: 'task-target-a',
      branch: 'multicc/target-a', worktreePath: path.join(repoA, '.multicc-worktrees', 'target-a'),
      createdAt: new Date(NOW).toISOString(), lastWorkAt: new Date(NOW).toISOString(),
      workspaceState: 'planned',
    };
    const records = new Map([[victim.id, victim], [other.id, other], [target.id, target]]);
    const directories = new Map([
      ['dir-a', { id: 'dir-a', path: repoA, baseBranch: 'main' }],
      ['dir-b', { id: 'dir-b', path: repoB, baseBranch: 'main' }],
    ]);
    const persistence = { mutate: (_source, mutate) => mutate(records) };
    runtime = hibernationRuntime(records, directories);
    admission = createWorkspaceAdmission({
      file: path.join(root, 'task-shells.sqlite'),
      records,
      directories,
      persistence,
      ensureDir: async () => ({ ok: true }),
      addWorktree: (repo, id, base) => gitWorktreeAdd(repo, id, base),
      validate: (repo, worktree, branch, options) => gitWorktreeValidate(repo, worktree, branch, options),
      getState: () => null,
      hibernation: () => runtime,
      hasBackground: () => false,
      streamBusy: () => false,
      closePersistent: async () => ({ closed: true }),
      updateCwd: () => {},
      pendingInput: () => null,
      loadHistory: () => [],
      budgets: { executionLimit: 4, residentLimit: 1, restoreLimit: 2, residencyReclaimMs: 0 },
      log: () => {},
    });
    admission.initialize();

    assert.equal(admission.capacityReason(admission.identify(target.id).id), 'workspace_resident_capacity');
    guard = await admission.beforeDeliver({
      sessionId: target.id,
      item: { id: 'capacity-gate-delivery' },
      opts: { deliveryId: 'capacity-gate-delivery' },
    });

    assert.equal(victim.workspaceState, 'hibernated', 'capacity pressure ignores the normal idle grace');
    assert.equal(fs.existsSync(victim.worktreePath), false);
    assert.equal(target.workspaceState, 'awake');
    assert.equal(fs.existsSync(target.worktreePath), true);
    assert.equal(other.workspaceState, 'awake', 'another directory never pays this directory capacity debt');
    assert.equal(fs.existsSync(other.worktreePath), true);
    assert.equal(admission.snapshot().budgets.residentLimitScope, 'directory');
  } finally {
    await guard?.complete({ accepted: false, durable: false });
    admission?.close();
    await runtime?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
