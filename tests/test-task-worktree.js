'use strict';

// M3 · per-task worktree (docs/chat-view-unification-design.md §3-M3, D2).
// The worktree belongs to the TASK, not the pooled slot: branch
// `multicc/task-<shortCode>`, path `<dir>/.multicc-worktrees/task-<shortCode>`,
// stable across runs. At a run boundary the slot's existing worktreePath/branch
// fields are re-pointed at the task worktree (cwdForSession already prefers
// them) and restored to the slot's deterministic own values when the run ends —
// no new persisted session fields. A slot never owns (and therefore never
// deletes) a task worktree: destroy is gated by slotOwnsWorktree.

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

function ownWorktree(dirPath, slotId) {
  return { worktreePath: path.join(dirPath, '.multicc-worktrees', slotId), branch: `multicc/${slotId}` };
}

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

test('prepareForRun stamps the slot record and releaseSlot restores its own worktree deterministically', async () => {
  const h = fixture();
  const record = { id: 'slot-9', dirId: 'dir-1', ...ownWorktree('/repo', 'slot-9') };
  const prepared = await h.service.prepareForRun({ record, taskId: 'tsk-1' });
  assert.equal(prepared.ok, true);
  assert.equal(record.branch, 'multicc/' + taskWorktreeToken('tsk-1'));
  assert.equal(record.worktreePath, '/repo/.multicc-worktrees/' + taskWorktreeToken('tsk-1'));
  assert.equal(slotOwnsWorktree(record), false, 'stamped slot does not own the task worktree');

  // Idempotent re-stamp for the same task (duplicate delivery path).
  const again = await h.service.prepareForRun({ record, taskId: 'tsk-1' });
  assert.equal(again.ok, true);
  assert.equal(record.branch, 'multicc/' + taskWorktreeToken('tsk-1'));

  // Run boundary ends: restore recomputes the slot's own values — no persisted
  // backup field, so the restore survives crashes and reloads.
  assert.equal(h.service.releaseSlot({ record }), true);
  assert.deepEqual(
    { worktreePath: record.worktreePath, branch: record.branch },
    ownWorktree('/repo', 'slot-9'),
  );
  assert.equal(slotOwnsWorktree(record), true);
  // Restoring an unstamped slot is a no-op.
  assert.equal(h.service.releaseSlot({ record }), false);
});

test('a second task on the same slot restamps at its own run boundary (no cross-task cwd)', async () => {
  const h = fixture();
  h.board.set('tsk-2', { id: 'tsk-2', title: '第二任务', status: 'active' });
  const record = { id: 'slot-9', dirId: 'dir-1', ...ownWorktree('/repo', 'slot-9') };
  await h.service.prepareForRun({ record, taskId: 'tsk-1' });
  const firstPath = record.worktreePath;
  assert.equal(h.service.releaseSlot({ record }), true);
  await h.service.prepareForRun({ record, taskId: 'tsk-2' });
  assert.equal(record.worktreePath, '/repo/.multicc-worktrees/' + taskWorktreeToken('tsk-2'));
  assert.notEqual(record.worktreePath, firstPath);
  await h.service.releaseSlot({ record });
  assert.deepEqual(
    { worktreePath: record.worktreePath, branch: record.branch },
    ownWorktree('/repo', 'slot-9'),
  );
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
