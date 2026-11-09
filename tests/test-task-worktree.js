'use strict';

// M3 · per-task worktree (docs/chat-view-unification-design.md §3-M3, D2).
// The worktree belongs to the TASK, not to any session: branch
// `multicc/task-<shortCode>`, path `<dir>/.multicc-worktrees/task-<shortCode>`,
// created on demand by ensureForTask and merged back / cleaned up per task.
// A session never owns (and therefore never deletes) a task worktree: the
// legacy slot stamping is gone with the run boundary; destroy is gated by
// slotOwnsWorktree, which stays the ownership predicate for slot records.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  taskWorktreeToken,
  slotOwnsWorktree,
  createTaskWorktreeService,
} = require('../src/task-worktree');

function fixture(overrides = {}) {
  const calls = { add: [], remove: [], merge: [], update: [] };
  const dir = { id: 'dir-1', path: '/repo', baseBranch: 'main' };
  const board = new Map([
    ['tsk-1', { id: 'tsk-1', title: '重构登录页', status: 'active' }],
    ['tsk-bare', { id: 'tsk-bare', title: '无目录任务', status: 'active' }],
  ]);
  const gitWorktreeAdd = overrides.gitWorktreeAdd || (async (dirPath, token, baseBranch) => {
    calls.add.push({ dirPath, token, baseBranch });
    return {
      ok: true,
      worktreePath: path.join(dirPath, '.multicc-worktrees', token),
      branch: `multicc/${token}`,
      existing: calls.add.length > 1,
    };
  });
  const service = createTaskWorktreeService({
    getBoardTask: id => board.get(id) || null,
    updateTask: (id, patch) => {
      calls.update.push({ id, patch: { ...patch } });
      const task = board.get(id);
      if (!task) return;
      if (patch.worktreePath) task.worktreePath = patch.worktreePath;
      else delete task.worktreePath;
      if (patch.branch) task.branch = patch.branch;
      else delete task.branch;
    },
    getDirectory: dirId => (dirId === 'dir-1' ? dir : null),
    taskDirIdOf: task => (task.id === 'tsk-bare' ? 'dir-none' : 'dir-1'),
    gitWorktreeAdd,
    gitWorktreeRemove: overrides.gitWorktreeRemove || (async (dirPath, worktreePath, branch, opts) => {
      calls.remove.push({ dirPath, worktreePath, branch, opts });
      return overrides.removeResult || { ok: true, removed: true };
    }),
    gitMergeBack: overrides.gitMergeBack || (async (targetDir, session) => {
      calls.merge.push({ dir: targetDir.id, session: { ...session } });
      return overrides.mergeResult || { ok: true, merged: true, commits: 2 };
    }),
    existsSync: overrides.existsSync || (p => !String(p).includes('gone')),
    isTaskRunning: overrides.isTaskRunning || (() => false),
    logger: { log: () => {} },
  });
  return { service, calls, board, dir };
}

test('taskWorktreeToken is a stable, filesystem-safe short code per task', () => {
  const expected = 'task-' + crypto.createHash('sha256').update('tsk-1', 'utf8').digest('hex').slice(0, 8);
  assert.equal(taskWorktreeToken('tsk-1'), expected);
  assert.equal(taskWorktreeToken('tsk-1'), taskWorktreeToken('tsk-1'));
  assert.match(taskWorktreeToken('tsk-1'), /^task-[0-9a-f]{8}$/);
  assert.notEqual(taskWorktreeToken('tsk-1'), taskWorktreeToken('tsk-2'));
});

test('slotOwnsWorktree is true only for the slot\'s deterministic own branch', () => {
  assert.equal(slotOwnsWorktree({ id: 'slot-1', branch: 'multicc/slot-1' }), true);
  assert.equal(slotOwnsWorktree({ id: 'slot-1', branch: 'multicc/task-abcd1234' }), false);
  assert.equal(slotOwnsWorktree({ id: 'slot-1' }), false);
  assert.equal(slotOwnsWorktree(null), false);
});

test('createTaskWorktreeService validates its required ports', () => {
  assert.throws(() => createTaskWorktreeService({}), TypeError);
  assert.throws(() => createTaskWorktreeService({
    getBoardTask: () => null, updateTask: () => {}, getDirectory: () => null,
    taskDirIdOf: () => null, gitWorktreeAdd: () => {}, gitWorktreeRemove: () => {},
    // gitMergeBack missing
    existsSync: () => true,
  }), /gitMergeBack/);
});

test('ensureForTask creates the worktree once, records it on the task, and reuses it', async () => {
  const h = fixture();
  const first = await h.service.ensureForTask('tsk-1');
  const token = taskWorktreeToken('tsk-1');
  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  assert.equal(first.worktreePath, '/repo/.multicc-worktrees/' + token);
  assert.equal(first.branch, 'multicc/' + token);
  assert.deepEqual(h.calls.add, [{ dirPath: '/repo', token, baseBranch: 'main' }]);
  assert.deepEqual(h.calls.update, [{ id: 'tsk-1', patch: { worktreePath: first.worktreePath, branch: first.branch } }]);
  assert.equal(h.board.get('tsk-1').worktreePath, first.worktreePath);

  const second = await h.service.ensureForTask('tsk-1');
  assert.equal(second.ok, true);
  assert.equal(second.reused, true, 'gitWorktreeAdd reports the existing worktree');
  assert.equal(second.worktreePath, first.worktreePath);
  assert.equal(h.calls.update.length, 1, 'no redundant task write when the fields already match');

  assert.deepEqual(await h.service.ensureForTask('tsk-missing'), { ok: false, code: 'task_not_found' });
  const bare = await h.service.ensureForTask('tsk-bare');
  assert.equal(bare.ok, false);
  assert.equal(bare.code, 'directory_not_found');
});

test('info resolves the task worktree for parameterized diff/merge routes', async () => {
  const h = fixture();
  assert.equal(h.service.info('tsk-1'), null, 'no worktree until ensured');
  await h.service.ensureForTask('tsk-1');
  const info = h.service.info('tsk-1');
  assert.equal(info.dirId, 'dir-1');
  assert.equal(info.dir.path, '/repo');
  assert.equal(info.branch, 'multicc/' + taskWorktreeToken('tsk-1'));
  assert.equal(info.token, taskWorktreeToken('tsk-1'));
  assert.equal(h.service.info('tsk-missing'), null);
});

test('mergeTask refuses an active run and merges through the task token identity', async () => {
  const busy = fixture({ isTaskRunning: () => true });
  await busy.service.ensureForTask('tsk-1');
  const refused = await busy.service.mergeTask('tsk-1');
  assert.deepEqual(refused, { ok: false, code: 'run_active', blocked: true });
  assert.equal(busy.calls.merge.length, 0);

  const h = fixture();
  const missing = await h.service.mergeTask('tsk-1');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'worktree_not_found');
  await h.service.ensureForTask('tsk-1');
  const merged = await h.service.mergeTask('tsk-1');
  assert.equal(merged.ok, true);
  // gitMergeBack receives a virtual session identified by the task token —
  // exactly the identity its commit message and actor sessionId will carry.
  assert.deepEqual(h.calls.merge, [{
    dir: 'dir-1',
    session: {
      id: taskWorktreeToken('tsk-1'),
      worktreePath: '/repo/.multicc-worktrees/' + taskWorktreeToken('tsk-1'),
      branch: 'multicc/' + taskWorktreeToken('tsk-1'),
    },
  }]);
});

test('cleanupWorktree merges, removes, then clears the task fields — each step retryable', async () => {
  const h = fixture();
  await h.service.ensureForTask('tsk-1');

  // Happy path: merge (which commits all dirty work) → remove → clear.
  const done = await h.service.cleanupWorktree('tsk-1');
  assert.deepEqual(done, { ok: true, removed: true, merged: true });
  assert.equal(h.calls.remove.length, 1);
  assert.deepEqual(h.calls.update.at(-1), { id: 'tsk-1', patch: { worktreePath: null, branch: null } });
  assert.equal(h.board.get('tsk-1').worktreePath, undefined);
  // A second cleanup is an idempotent no-op.
  assert.deepEqual(await h.service.cleanupWorktree('tsk-1'), { ok: true, skipped: true, code: 'worktree_not_found' });

  // Merge conflict: nothing removed, task fields intact — retryable.
  const conflicted = fixture({ mergeResult: { ok: false, conflicts: ['a.js'] } });
  await conflicted.service.ensureForTask('tsk-1');
  const failed = await conflicted.service.cleanupWorktree('tsk-1');
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'merge_failed');
  assert.equal(conflicted.calls.remove.length, 0);
  assert.equal(conflicted.board.get('tsk-1').worktreePath, '/repo/.multicc-worktrees/' + taskWorktreeToken('tsk-1'));

  // Removal refused (still dirty/unmerged after merge): fields intact — retryable.
  const refused = fixture({ removeResult: { ok: false, blocked: true, reasons: ['unmerged'] } });
  await refused.service.ensureForTask('tsk-1');
  const blocked = await refused.service.cleanupWorktree('tsk-1');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'worktree_remove_refused');
  assert.equal(refused.board.get('tsk-1').worktreePath, refused.service.info('tsk-1').worktreePath);

  // Removal succeeded but the ledger write crashed: the follow-up call sees the
  // worktree gone, clears the stale fields, and reports success.
  const crashed = fixture({ existsSync: () => false });
  await crashed.service.ensureForTask('tsk-1');
  const healed = await crashed.service.cleanupWorktree('tsk-1');
  assert.deepEqual(healed, { ok: true, removed: true, alreadyGone: true });
  assert.equal(crashed.calls.merge.length, 0, 'no git work against a missing worktree');
  assert.equal(crashed.board.get('tsk-1').worktreePath, undefined);

  // An active run always refuses.
  const busy = fixture({ isTaskRunning: () => true });
  await busy.service.ensureForTask('tsk-1');
  assert.equal((await busy.service.cleanupWorktree('tsk-1')).code, 'run_active');
});

test('server.js gates session worktree destruction on slot ownership (loaned task worktrees survive)', () => {
  const root = path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(source, /slotOwnsWorktree/, 'guard imported and used');
  const cascade = source.slice(source.indexOf('async function destroySessionCascade'));
  const guardAt = cascade.indexOf('slotOwnsWorktree');
  const removeAt = cascade.indexOf('gitWorktreeRemove(');
  assert.ok(guardAt >= 0 && removeAt > guardAt, 'ownership guard evaluated before worktree removal');
});

const { createSessionHibernationRuntime } = require('../src/session/hibernation');
const { createSessionPersistence } = require('../src/session/persistence');
const { createTaskLifecycleHost } = require('../src/task-board/lifecycle-host');
const { mkRuntime } = require('./helpers/task-board-runtime');
const { recordsOf, resetTaskState } = require('./helpers/session-records');

function cleanupFixture(t, options = {}) {
  const record = { id: 'bound', kind: 'chat', dirId: 'dir-1', taskBoundTaskId: 'tsk-1',
    worktreePath: '/tmp/dir-1/.multicc-worktrees/bound', branch: 'multicc/bound',
    workspaceState: 'awake', cliSessionId: 'native-original' };
  const records = recordsOf([[record.id, record]]);
  let exists = options.exists !== false, busy = false, failSession = false, failBoard = false;
  let removes = 0, merges = 0;
  const persistence = createSessionPersistence({ records, store: { save() {
    if (failSession && records.get('bound').workspaceState === 'hibernated') throw new Error('disk full');
  } } });
  const hibernation = createSessionHibernationRuntime({ records,
    directories: new Map([['dir-1', { id: 'dir-1', path: '/tmp/dir-1' }]]), persistence,
    git: { inspect: async () => ({ pathExists: exists, branchExists: exists, valid: exists }),
      detach: async () => {}, thaw: async () => { exists = true; return {}; } },
    inspectBlockers: async () => busy ? ['workspace_lease'] : [],
    closePersistent: options.closePersistent || (async () => {}),
  });
  let h;
  const hooks = createTaskLifecycleHost({ records, getBoard: () => h.runtime.getBoard(),
    getShell: () => ({ stateTarget: () => ({}) }), getState: () => ({}),
    getRunState: () => 'idle', isSessionBusy: () => busy,
    getHibernation: () => hibernation, resetTaskState: id => resetTaskState(records, id) });
  h = mkRuntime({ records, ...hooks,
    atomicWriteJson: (file, value) => { if (failBoard) throw new Error('disk full'); fs.writeFileSync(file, JSON.stringify(value)); },
    existsSync: () => exists,
    gitWorktreeAdd: async () => ({}),
    gitMergeBack: async (_dir, session, opts) => {
      merges++; assert.equal(session.id, record.id); assert.equal(opts.activeCheck(), false);
      return options.mergeResult || { ok: true, merged: true };
    },
    gitWorktreeRemove: async (_dir, _path, _branch, opts) => {
      removes++; assert.equal(opts.sessionId, record.id); assert.equal(opts.activeCheck(), false);
      if (options.partialRemove) exists = false;
      if (options.removeResult) return options.removeResult;
      exists = false; return { ok: true, removed: true };
    },
  });
  h.runtime.getBoard().tasks['tsk-1'] = { id: 'tsk-1', dirId: 'dir-1', chatSessionId: record.id,
    worktreePath: record.worktreePath, branch: record.branch };
  t.after(async () => { await hibernation.stop(); persistence.stop(); fs.rmSync(path.dirname(h.file), { recursive: true, force: true }); });
  return { ...h, records, hibernation, cleanup: () => h.runtime.taskWorktree.cleanupWorktree('tsk-1'),
    setBusy: value => { busy = value; }, setFailSession: value => { failSession = value; },
    setFailBoard: value => { failBoard = value; }, counts: () => ({ removes, merges }) };
}

test('任务清理同步会话休眠状态并保留会话身份；已消失路径同样修复', async t => {
  for (const exists of [true, false]) {
    const h = cleanupFixture(t, { exists });
    assert.equal((await h.cleanup()).ok, true);
    const record = h.records.get('bound');
    assert.equal(record.workspaceState, 'hibernated');
    assert.equal(record.cliSessionId, 'native-original');
    assert.equal(record.taskBoundTaskId, 'tsk-1');
    assert.equal(record.branch, 'multicc/bound');
    assert.equal(h.runtime.getBoard().tasks['tsk-1'].worktreePath, null);
    assert.deepEqual(h.counts(), { removes: exists ? 1 : 0, merges: exists ? 1 : 0 });
    assert.equal((await h.hibernation.ensureAwake('bound')).ok, true);
    assert.equal(record.workspaceState, 'awake');
  }
});

test('任务清理持久化失败不清账，重试不会重复删除', async t => {
  for (const failure of ['Session', 'Board']) {
    const h = cleanupFixture(t);
    h[`setFail${failure}`](true);
    await assert.rejects(h.cleanup(), error => /PERSISTENCE_FAILED/.test(error.code));
    assert.ok(h.runtime.getBoard().tasks['tsk-1'].worktreePath);
    h[`setFail${failure}`](false);
    assert.equal((await h.cleanup()).ok, true);
    assert.equal(h.records.get('bound').workspaceState, 'hibernated');
    assert.equal(h.runtime.getBoard().tasks['tsk-1'].worktreePath, null);
    assert.deepEqual(h.counts(), { removes: 1, merges: 1 });
  }
});

test('任务清理拒绝占用、错配所有者及共享工作区', async t => {
  const h = cleanupFixture(t);
  h.setBusy(true);
  await assert.rejects(h.cleanup(), error => error.code === 'task_busy');
  h.setBusy(false);
  for (const patch of [{ taskBoundTaskId: 'another' }, { workspaceOwnerSessionId: 'other' }, { branch: 'multicc/other' }]) {
    const original = { ...h.records.get('bound') };
    Object.assign(h.records.get('bound'), patch);
    assert.equal((await h.cleanup()).code, 'workspace_owner_mismatch');
    h.records.set('bound', original);
  }
  assert.deepEqual(h.counts(), { removes: 0, merges: 0 });
  assert.equal(h.records.get('bound').workspaceState, 'awake');
});

test('合并或删除失败保留任务字段并恢复会话原状态', async t => {
  for (const options of [{ mergeResult: { ok: false } }, { removeResult: { ok: false } }]) {
    const h = cleanupFixture(t, options);
    assert.equal((await h.cleanup()).ok, false);
    assert.ok(h.runtime.getBoard().tasks['tsk-1'].worktreePath);
    assert.equal(h.records.get('bound').workspaceState, 'awake');
  }
});

test('清理关闭常驻进程后再次检查占用，且阻止并发唤醒穿过清理锁', async t => {
  let releaseClose;
  const closing = new Promise(resolve => { releaseClose = resolve; });
  const h = cleanupFixture(t, { closePersistent: () => closing });
  const cleanup = h.cleanup();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.records.get('bound').workspaceState, 'hibernating');
  assert.equal(h.hibernation.isLocked('bound'), true);
  let awakened = false;
  const wake = h.hibernation.ensureAwake('bound').then(() => { awakened = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(awakened, false);
  h.setBusy(true); releaseClose();
  assert.equal((await cleanup).code, 'workspace_lease');
  await wake;
  assert.deepEqual(h.counts(), { removes: 0, merges: 0 });
  assert.ok(h.runtime.getBoard().tasks['tsk-1'].worktreePath);
});


test('删除目录后分支清理失败时保留账本并准确标记会话已休眠', async t => {
  const h = cleanupFixture(t, { partialRemove: true, removeResult: { ok: false, reasons: ['unmerged'] } });
  assert.equal((await h.cleanup()).ok, false);
  assert.equal(h.records.get('bound').workspaceState, 'hibernated');
  assert.ok(h.runtime.getBoard().tasks['tsk-1'].worktreePath);
  assert.equal((await h.cleanup()).ok, true);
});
