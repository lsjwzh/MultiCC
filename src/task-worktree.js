'use strict';

// M3 · per-task worktree (docs/chat-view-unification-design.md §3-M3, D2).
// The worktree belongs to the TASK, not the pooled slot that happens to run
// it: branch `multicc/task-<shortCode>`, path
// `<dir>/.multicc-worktrees/task-<shortCode>`, stable across runs and slots.
//
// Slot integration reuses two fields the session record already persists:
// at a run boundary the slot's worktreePath/branch are re-pointed at the task
// worktree (cwdForSession already prefers them, and resetSlot restarts the
// resident CLI at the same boundary, so the next spawn picks up the new cwd —
// invariant I6, one worktree per run). When the run finalizes the fields are
// restored to the slot's own deterministic values, recomputed from the
// gitWorktreeAdd contract instead of a persisted backup, so a crash mid-run
// cannot strand a slot on a foreign worktree it no longer owns.
//
// Ownership rule: a session only ever deletes a worktree it owns
// (`multicc/<sessionId>`). A slot deleted while stamped keeps the task
// worktree alive — cleanup is the task's one-click action (merge → remove →
// clear ledger fields), never a slot side effect.

const crypto = require('crypto');
const path = require('path');

const WORKTREE_SUBDIR = '.multicc-worktrees';

// Short, stable, filesystem-safe token per task. Eight hex chars keep the
// branch/worktree names readable in `git worktree list` while making
// collisions across a board irrelevant (the task id remains the key).
function taskWorktreeToken(taskId) {
  const digest = crypto.createHash('sha256')
    .update(String(taskId || ''), 'utf8')
    .digest('hex');
  return `task-${digest.slice(0, 8)}`;
}

// A record owns its worktree only when the branch matches its own id — the
// invariant every session creation path establishes via gitWorktreeAdd. A
// stamped slot (branch `multicc/task-…`) does NOT own its current worktree.
function slotOwnsWorktree(record) {
  return !!(record && record.branch === `multicc/${record.id}`);
}

function createTaskWorktreeService(options = {}) {
  const {
    getBoardTask,
    updateTask,
    getDirectory,
    taskDirIdOf,
    gitWorktreeAdd,
    gitWorktreeRemove,
    gitMergeBack,
    existsSync = p => require('fs').existsSync(p),
    isTaskRunning = null,
    beginTaskOperation = null,
    logger = console,
  } = options;
  for (const [name, value] of Object.entries({
    getBoardTask, updateTask, getDirectory, taskDirIdOf,
    gitWorktreeAdd, gitWorktreeRemove, gitMergeBack, existsSync,
  })) {
    if (typeof value !== 'function') throw new TypeError(`[task-worktree] ${name} port required`);
  }
  if (isTaskRunning != null && typeof isTaskRunning !== 'function') {
    throw new TypeError('[task-worktree] isTaskRunning port must be a function');
  }
  if (beginTaskOperation != null && typeof beginTaskOperation !== 'function') {
    throw new TypeError('[task-worktree] beginTaskOperation port must be a function');
  }

  function hold(taskId) {
    return beginTaskOperation ? beginTaskOperation(taskId) : () => {};
  }

  function refuseWhileRunning(taskId) {
    if (isTaskRunning && isTaskRunning(taskId)) {
      return { ok: false, code: 'run_active', blocked: true };
    }
    return null;
  }

  async function ensureForTask(taskId) {
    const id = String(taskId || '').trim();
    const release = hold(id);
    try {
      const task = getBoardTask(id);
      if (!task) return { ok: false, code: 'task_not_found' };
      const dir = getDirectory(taskDirIdOf(task));
      if (!dir || !dir.path) return { ok: false, code: 'directory_not_found' };
      const token = taskWorktreeToken(id);
      // Idempotent by construction: an existing directory is reused and the
      // branch re-checked (git.js gitWorktreeAdd). Same task → same token →
      // same worktree across every run and slot (design D2).
      const created = await gitWorktreeAdd(dir.path, token, dir.baseBranch);
      if (task.worktreePath !== created.worktreePath || task.branch !== created.branch) {
        updateTask(id, { worktreePath: created.worktreePath, branch: created.branch });
      }
      return {
        ok: true,
        worktreePath: created.worktreePath,
        branch: created.branch,
        dirId: dir.id,
        reused: created.existing === true,
      };
    } catch (error) {
      logger.log(`[multicc/taskworktree] ensure failed for ${id}: ${error?.message || error}`);
      return { ok: false, code: 'worktree_create_failed', error: error?.message || String(error) };
    } finally {
      release();
    }
  }

  // Run-boundary entry (task-run-host beforeDeliver): make sure the task
  // worktree exists, then stamp the slot record onto it. Called once per
  // delivery attempt; safe to repeat for the same task.
  async function prepareForRun({ record, taskId } = {}) {
    if (!record) return { ok: false, code: 'slot_not_found' };
    const ensured = await ensureForTask(taskId);
    if (!ensured.ok) return ensured;
    if (record.branch !== ensured.branch || record.worktreePath !== ensured.worktreePath) {
      record.worktreePath = ensured.worktreePath;
      record.branch = ensured.branch;
    }
    return ensured;
  }

  // Run-boundary exit (task-run-host finalizeTerminal): restore the slot's
  // own deterministic worktree identity. Returns false when there is nothing
  // to restore (already slot-owned or directory unknown).
  function releaseSlot({ record } = {}) {
    if (!record || slotOwnsWorktree(record)) return false;
    const dir = getDirectory(record.dirId);
    if (!dir || !dir.path) return false;
    record.worktreePath = path.join(dir.path, WORKTREE_SUBDIR, record.id);
    record.branch = `multicc/${record.id}`;
    return true;
  }

  // Resolution used by the parameterized diff/merge routes.
  function info(taskId) {
    const id = String(taskId || '').trim();
    const task = getBoardTask(id);
    if (!task || !task.worktreePath || !task.branch) return null;
    const dir = getDirectory(taskDirIdOf(task));
    if (!dir) return null;
    return {
      dirId: dir.id,
      dir,
      worktreePath: task.worktreePath,
      branch: task.branch,
      token: taskWorktreeToken(id),
    };
  }

  async function mergeTask(taskId) {
    const release = hold(taskId);
    try {
      const resolved = info(taskId);
      if (!resolved) return { ok: false, code: 'worktree_not_found' };
      const busy = refuseWhileRunning(taskId);
      if (busy) return busy;
      // gitMergeBack commits all dirty work in the worktree first, then merges
      // through an integration worktree with syntax validation — the same
      // semantics the session merge button relies on.
      return await gitMergeBack(resolved.dir, {
        id: resolved.token,
        worktreePath: resolved.worktreePath,
        branch: resolved.branch,
      });
    } finally {
      release();
    }
  }

  // One-click detail-page action (D2): merge back, then remove the worktree
  // and branch, then clear the ledger fields. Each step is idempotent and the
  // ledger is only cleared after the removal succeeded, so any failure leaves
  // a retryable state — never a half-deleted worktree.
  async function cleanupWorktree(taskId, opts = {}) {
    const id = String(taskId || '').trim();
    const release = hold(id);
    try {
      const task = getBoardTask(id);
      if (!task) return { ok: false, code: 'task_not_found' };
      if (!task.worktreePath || !task.branch) {
        return { ok: true, skipped: true, code: 'worktree_not_found' };
      }
      const busy = refuseWhileRunning(id);
      if (busy) return busy;
      const dir = getDirectory(taskDirIdOf(task));
      if (!dir) return { ok: false, code: 'directory_not_found' };
      if (!existsSync(task.worktreePath)) {
        // Removal succeeded but the ledger write was lost (crash between the
        // two): heal by clearing the stale fields without touching git.
        updateTask(id, { worktreePath: null, branch: null });
        return { ok: true, removed: true, alreadyGone: true };
      }
      const merged = await gitMergeBack(dir, {
        id: taskWorktreeToken(id),
        worktreePath: task.worktreePath,
        branch: task.branch,
      });
      if (!merged.ok) return { ok: false, code: 'merge_failed', merge: merged };
      const removal = await gitWorktreeRemove(dir.path, task.worktreePath, task.branch, {
        sessionId: taskWorktreeToken(id),
        baseBranch: dir.baseBranch,
        force: opts.force === true,
      });
      if (!removal.ok) {
        return { ok: false, code: 'worktree_remove_refused', merge: merged, removal };
      }
      updateTask(id, { worktreePath: null, branch: null });
      return { ok: true, removed: true, merged: merged.merged === true };
    } finally {
      release();
    }
  }

  return Object.freeze({
    ensureForTask,
    prepareForRun,
    releaseSlot,
    info,
    mergeTask,
    cleanupWorktree,
  });
}

module.exports = {
  WORKTREE_SUBDIR,
  taskWorktreeToken,
  slotOwnsWorktree,
  createTaskWorktreeService,
};
