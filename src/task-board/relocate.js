'use strict';

const { getNative, assignHostProperty } = require('../native/binding');

// Task-level relocate (Air 任务「移动」). Moves a board task to another
// directory: the bound chat session's worktree is relocated through the
// session-lifecycle runtime with carry, so uncommitted changes (tracked diff
// + untracked files) travel into the fresh worktree in the target repo; the
// task-shell store and the board record follow in one commit each.
//
// Refusals surface as { ok:false, status, body } so the route can pass them
// through unchanged: task_busy / task_archived / task_deleting (lifecycle),
// blocked reasons from the workspace move (active / unmerged /
// carry_apply_failed …), task_shell_shared (a non-standalone shell owns other
// tasks and cannot change directory).

function createTaskRelocate({
  deps,
  resolveTask, taskIdentityIds, taskDirId, commit, notify, taskDto, isBusy,
  logger = console,
}) {
  const { records, directories, relocateSessionWorkspace, gitRelocateWorktree } = deps;
  const relocateShellTask = typeof deps.relocateShellTask === 'function' ? deps.relocateShellTask : null;
  const fail = (res, body, status = 409) => res.status(status).json({ ok: false, ...body });

  const policy = { resolveTask, taskDirId, isBusy, directories };
  async function relocate(req, res) {
    const plan = getNative().taskRelocatePlan(policy, req);
    if (plan.status) return fail(res, plan.body, plan.status);
    if (plan.unchanged) return res.json({ ok: true, unchanged: true, task: taskDto(plan.task) });
    const { task, targetDirId, targetDir, currentDirId } = plan;
    const ids = taskIdentityIds(task);
    try { await deps.assertTaskIdle?.(task, ids); }
    catch (error) { return fail(res, { error: error.code || 'task_busy' }); }

    const record = task.chatSessionId ? records.get(task.chatSessionId) : null;
    const recordWorktreeBefore = record?.worktreePath || null;
    const oldDir = currentDirId ? directories.get(currentDirId) : null;

    // The shell store follows the task across directories; a shell shared with
    // other tasks can never move. Check before any git mutation.
    if (relocateShellTask) {
      const check = relocateShellTask(task.id, targetDirId, { dryRun: true });
      if (!check.ok) return fail(res, { error: check.code || 'task_shell_shared' });
    }

    let carried = null;
    let cwd = targetDir.path;
    let ledgerMoved = null;
    try {
      if (record) {
        // force: the Air detail page holds a WS client on the task's chat, so
        // the session is always "active" while the user looks at it. Real
        // execution is already excluded by assertIdle above; what force tears
        // down here is the viewing connection, not a turn.
        const result = await relocateSessionWorkspace(record.id, targetDirId, { force: true, carry: true });
        if (!result.ok) return res.status(result.status || 500).json(result.body);
        carried = result.carried || null;
        cwd = result.cwd || cwd;
      }
      // Legacy planned tasks can own a worktree directly, without a dedicated
      // chat session. Move it too when it is not the session's own worktree.
      if (task.worktreePath && task.branch && oldDir && task.worktreePath !== recordWorktreeBefore) {
        const moved = await gitRelocateWorktree(oldDir, targetDir,
          { id: task.id, worktreePath: task.worktreePath, branch: task.branch },
          { carry: true });
        if (!moved.ok) return fail(res, moved, moved.blocked ? 409 : 500);
        ledgerMoved = moved;
        carried = carried || moved.carried || null;
      }
    } catch (error) {
      logger.warn?.('task_relocate_failed', { taskId: task.id, error: error.message });
      return fail(res, { error: error.code || 'task_relocate_failed' }, error.status || 500);
    }

    const result = commit(board => getNative().taskRelocateCommit(board, plan, records, record, ledgerMoved, assignHostProperty));
    if (!result.ok) return fail(res, { error: result.error || 'persistence_failed' }, 500);
    relocateShellTask?.(task.id, targetDirId);
    notify(currentDirId, ids, 'relocated');
    notify(targetDirId, ids, 'relocated');
    return res.json({ ok: true, task: taskDto(resolveTask(task.id)), dirId: targetDirId,
      cwd, carried, planned: !recordWorktreeBefore && !ledgerMoved });
  }

  return { relocate };
}

module.exports = { createTaskRelocate };
