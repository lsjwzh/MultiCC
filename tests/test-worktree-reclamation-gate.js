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
    fs.writeFileSync(path.join(unsafeAdded.worktreePath, '.env'), 'MUST_NOT_BE_DELETED=1\n');
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
    assert.equal(fs.readFileSync(path.join(unsafe.worktreePath, '.env'), 'utf8'), 'MUST_NOT_BE_DELETED=1\n');
    assert.equal(safe.workspaceState, 'hibernated',
      'the automatic sweep must continue past the unsafe oldest checkout');
    assert.equal(fs.existsSync(safe.worktreePath), false);

    assert.equal((await runtime.ensureAwake(safe.id)).ok, true);
    assert.equal(safe.workspaceState, 'awake');
    assert.equal(fs.readFileSync(path.join(safe.worktreePath, 'tracked.txt'), 'utf8'), 'preserved by snapshot\n');
    assert.equal(fs.readFileSync(path.join(safe.worktreePath, 'draft.txt'), 'utf8'), 'also preserved\n');
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
