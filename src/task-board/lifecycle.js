'use strict';

const { taskHistoryRefusal } = require('../session/task-history-retention');

// Purge-stage refusals that describe a permanent state (evidence retention,
// shared sessions/workspaces): retrying the same DELETE changes nothing, so
// the write barrier rolls back and the card stays operable. Anything else
// (disk, worktree IO) is transient — the barrier stays so a retry resumes the
// same cleanup and no half-deleted task can execute.
const PERMANENT_PURGE_REFUSALS = new Set(['TASK_HISTORY_REFERENCED', 'task_session_shared', 'shell_workspace_referenced']);

// Lifecycle authority is independent of whether a task's execution is writable.
// A conversation task can be archived/deleted without taking over its session.
function createTaskLifecycle({ getBoard, resolveTask, taskIdentityIds, commit, taskDto,
  notify, taskDirId, activeOperations, assertIdle, preparePurge, purge }) {
  const pending = new Set();
  const fail = (res, code, status = 409, details = {}) => res.status(status).json({ ok: false, error: code, ...details });
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
        const options = { force: req.body?.force === true };
        await preparePurge?.(task, ids, options);
        // Persist the write barrier before any asynchronous cleanup. On
        // transient failure the barrier stays: DELETE retries the same cleanup
        // and no half-deleted task can execute. On a permanent refusal the
        // barrier rolls back so the card never wedges in "deleting" forever.
        let result = commit(board => { for (const id of ids) if (board.tasks[id]) board.tasks[id].deleting = true; return { ok: true }; });
        if (!result.ok) return fail(res, result.error, 500);
        try {
          await purge(task, ids, options);
        } catch (error) {
          if (PERMANENT_PURGE_REFUSALS.has(error.code)) {
            try { commit(board => { for (const id of ids) if (board.tasks[id]) delete board.tasks[id].deleting; return { ok: true }; }); } catch (_) {}
          }
          throw error;
        }
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
      // Legacy /status callers also reach archive/restore here; neither releases a session.
      return res.json({ ok: true, releasedSession: false, releasedSessions: 0,
        task: taskDto(resolveTask(task.id)), revision: getBoard().revision });
    } catch (error) {
      const details = Array.isArray(error.reasons) && error.reasons.length ? { reasons: error.reasons } : {};
      if (Array.isArray(error.tasks) && error.tasks.length) {
        details.tasks = error.tasks;
        details.taskIds = Array.isArray(error.taskIds) ? error.taskIds : error.tasks.map(item => item && item.id).filter(Boolean);
        // A retention refusal must reach the UI as a readable sentence naming
        // the tasks, not the bare TASK_HISTORY_REFERENCED code; `error` stays
        // the machine code for clients that switch on it.
        if (error.code === 'TASK_HISTORY_REFERENCED') details.message = taskHistoryRefusal(error).error;
      }
      return fail(res, error.code || error.message || 'task_lifecycle_failed', 409, details);
    }
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
  }, preparePurge: async (task, ids, options) => {
    for (const id of ids) taskRuns?.assertTaskPurgeable(id);
    await deps.prepareTaskDelete?.(task, ids, options);
  }, purge: async (task, ids, options) => {
    if (!deps.purgeTaskData) throw Object.assign(new Error('task_delete_unavailable'), { code: 'task_delete_unavailable' });
    await deps.purgeTaskData(task, ids, options);
    for (const id of ids) taskRuns?.purgeTask(id);
  } });
}

module.exports = { createTaskLifecycle, createBoardTaskLifecycle };
