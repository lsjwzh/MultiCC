'use strict';

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
  deps, taskRuns, isOpenTaskRun,
  resolveTask, taskIdentityIds, taskDirId, commit, notify, taskDto, isBusy,
  logger = console,
}) {
  const { records, directories, relocateSessionWorkspace, gitRelocateWorktree } = deps;
  const relocateShellTask = typeof deps.relocateShellTask === 'function' ? deps.relocateShellTask : null;
  const isOpenRun = id => (taskRuns ? taskRuns.listTaskRuns(id).some(isOpenTaskRun) : false);
  const fail = (res, body, status = 409) => res.status(status).json({ ok: false, ...body });

  async function relocate(req, res) {
    const task = resolveTask(req.params.taskId);
    if (!task) return fail(res, { error: 'task_not_found' }, 404);
    if (task.deleting) return fail(res, { error: 'task_deleting' });
    if (task.status === 'archived') return fail(res, { error: 'task_archived' });
    if (isBusy(task.id)) return fail(res, { error: 'task_busy' });

    const targetDirId = String(req.body?.dirId || '').trim();
    if (!targetDirId) return fail(res, { error: 'dirId required' }, 400);
    const targetDir = directories.get(targetDirId);
    if (!targetDir) return fail(res, { error: 'target directory not found' }, 404);
    const currentDirId = taskDirId(task);
    if (currentDirId === targetDirId) return res.json({ ok: true, unchanged: true, task: taskDto(task) });

    const ids = taskIdentityIds(task);
    if (ids.some(id => isOpenRun(id))) return fail(res, { error: 'task_busy' });
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
        // execution is already excluded by assertIdle/isOpenRun above; what
        // force tears down here is the viewing connection, not a turn.
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

    const result = commit(board => {
      const current = board.tasks[task.id];
      if (!current) return { ok: false, error: 'task_not_found' };
      current.dirId = targetDirId;
      if (record) {
        current.worktreePath = records.get(record.id)?.worktreePath || null;
        current.branch = records.get(record.id)?.branch || null;
      } else if (ledgerMoved) {
        current.worktreePath = ledgerMoved.worktreePath;
        current.branch = ledgerMoved.branch;
      }
      // Refs snapshot the directory each turn ran in; sessions that physically
      // moved with the task (their record now lives in the target) must not
      // keep the task listed in the source directory's views via dirIds.
      for (const ref of current.refs || []) {
        if (ref?.dirId && ref.dirId !== targetDirId && ref.sessionId
          && records.get(ref.sessionId)?.dirId === targetDirId) {
          ref.dirId = targetDirId;
        }
      }
      // Modules are directory-scoped; a module of the source directory can
      // never group the task under the target.
      if (current.moduleId) current.moduleId = null;
      current.updatedAt = Date.now();
      return { ok: true };
    });
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
