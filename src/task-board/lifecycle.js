'use strict';

// Lifecycle authority is independent of whether a task's execution is writable.
// A conversation task can be archived/deleted without taking over its session.
function createTaskLifecycle({ getBoard, resolveTask, taskIdentityIds, commit, taskDto,
  notify, taskDirId, activeOperations, assertIdle, preparePurge, purge }) {
  const pending = new Set();
  const fail = (res, code, status = 409) => res.status(status).json({ ok: false, error: code });
  async function operate(req, res, action) {
    const task = resolveTask(req.params.taskId);
    if (!task) return action === 'delete' && getBoard().deletedTaskIds?.includes(req.params.taskId)
      ? res.json({ ok: true, deleted: true }) : fail(res, 'task_not_found', 404);
    if (pending.has(task.id) || activeOperations.get(task.id)) return fail(res, 'task_busy');
    pending.add(task.id);
    try {
      if (task.deleting && action !== 'delete') return fail(res, 'task_deleting');
      await assertIdle(task);
      const expected = req.body?.expectedRevision ?? req.body?.revision;
      if (expected != null && task.recordType === 'planned' && Number(expected) !== task.planningRevision) return fail(res, 'revision_conflict');
      const ids = taskIdentityIds(task), dirId = taskDirId(task);
      if (action === 'delete') {
        await preparePurge?.(task, ids);
        // Persist the write barrier before any asynchronous cleanup. On failure,
        // DELETE retries the same cleanup; no half-deleted task can execute.
        let result = commit(board => { for (const id of ids) if (board.tasks[id]) board.tasks[id].deleting = true; return { ok: true }; });
        if (!result.ok) return fail(res, result.error, 500);
        await purge(task, ids);
        result = commit(board => {
          for (const id of ids) delete board.tasks[id];
          // IDs alone prevent delayed receipts/backfill from recreating erased
          // tasks. No task content is retained in this suppression set.
          board.deletedTaskIds = [...new Set([...(board.deletedTaskIds || []), ...ids])];
          for (const [id, group] of Object.entries(board.taskGroups || {})) {
            group.taskIds = group.taskIds.filter(id => !ids.includes(id));
            if (group.taskIds.length < 2) delete board.taskGroups[id];
            else if (ids.includes(group.rootTaskId)) group.rootTaskId = group.taskIds[0];
          }
          return { ok: true };
        });
        if (!result.ok) return fail(res, result.error, 500);
        notify(dirId, ids, 'deleted');
        return res.json({ ok: true, deleted: true, taskIds: ids });
      }
      const status = action === 'archive' ? 'archived' : task.archivedFromStatus || 'active';
      const result = commit(board => {
        const current = board.tasks[task.id];
        if (action === 'archive' && current.status !== 'archived') current.archivedFromStatus = current.status;
        current.status = status; current.updatedAt = Date.now();
        if (current.recordType === 'planned') current.planningRevision = (current.planningRevision || 1) + 1;
        return { ok: true };
      });
      if (!result.ok) return fail(res, result.error, 500);
      notify(dirId, ids);
      return res.json({ ok: true, task: taskDto(resolveTask(task.id)), revision: getBoard().revision });
    } catch (error) { return fail(res, error.code || error.message || 'task_lifecycle_failed'); }
    finally { pending.delete(task.id); }
  }
  return { isBusy: id => pending.has(resolveTask(id)?.id || id), archive: (req, res) => operate(req, res, 'archive'),
    restore: (req, res) => operate(req, res, 'restore'),
    delete: (req, res) => operate(req, res, 'delete') };
}

function createBoardTaskLifecycle({ deps, taskRuns, isOpenTaskRun, ...options }) {
  return createTaskLifecycle({ ...options, assertIdle: async task => {
    const ids = options.taskIdentityIds(task);
    if (ids.some(id => taskRuns?.listTaskRuns(id).some(isOpenTaskRun))) throw Object.assign(new Error('task_busy'), { code: 'task_busy' });
    await deps.assertTaskIdle?.(task, ids);
  }, preparePurge: async (task, ids) => {
    for (const id of ids) taskRuns?.assertTaskPurgeable(id);
    await deps.prepareTaskDelete?.(task, ids);
  }, purge: async (task, ids) => {
    if (!deps.purgeTaskData) throw Object.assign(new Error('task_delete_unavailable'), { code: 'task_delete_unavailable' });
    await deps.purgeTaskData(task, ids);
    for (const id of ids) taskRuns?.purgeTask(id);
  } });
}

module.exports = { createTaskLifecycle, createBoardTaskLifecycle };
