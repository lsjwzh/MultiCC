'use strict';

const { taskHistoryRefusal } = require('../session/task-history-retention');

// Purge-stage refusals that describe a permanent state (evidence retention,
// shared sessions/workspaces): retrying the same DELETE changes nothing, so
// the write barrier rolls back and the card stays operable. Anything else
// (disk, worktree IO) is transient — the barrier stays so a retry resumes the
// same cleanup and no half-deleted task can execute.
const PERMANENT_PURGE_REFUSALS = new Set(['TASK_HISTORY_REFERENCED', 'task_session_shared', 'shell_workspace_referenced',
  'task_workspace_dirty', 'task_workspace_unmerged', 'task_workspace_ignored', 'task_workspace_unverifiable']);

// Lifecycle authority is independent of whether a task's execution is writable.
// A conversation task can be archived/deleted without taking over its session.
function createTaskLifecycle({ getBoard, resolveTask, taskIdentityIds, commit, taskDto,
  notify, taskDirId, activeOperations, assertIdle, preparePurge, purge }) {
  const pending = new Set();
  const fail = (res, code, status = 409, details = {}) => res.status(status).json({ ok: false, error: code, ...details });
  async function deleteById(taskId, options = {}) {
    const task = resolveTask(taskId);
    if (!task) {
      if (getBoard().deletedTaskIds?.includes(taskId)) return { ok: true, deleted: true };
      throw Object.assign(new Error('task_not_found'), { code: 'task_not_found', status: 404 });
    }
    if (pending.has(task.id) || activeOperations.get(task.id)) throw Object.assign(new Error('task_busy'), { code: 'task_busy' });
    pending.add(task.id);
    try {
      await assertIdle(task);
      if (options.expectedRevision != null && task.recordType === 'planned'
          && Number(options.expectedRevision) !== task.planningRevision) {
        throw Object.assign(new Error('revision_conflict'), { code: 'revision_conflict' });
      }
      const ids = taskIdentityIds(task), dirId = taskDirId(task);
      const purgeOptions = { force: options.force === true, ...(options.automatic === true ? { automatic: true } : {}) };
      await preparePurge?.(task, ids, purgeOptions);
      // Retention can lose eligibility (most importantly a new pin) while its
      // asynchronous Git preflight is running. Recheck before the write barrier.
      if (options.guard && !options.guard()) {
        throw Object.assign(new Error('no_longer_eligible'), { code: 'no_longer_eligible' });
      }
      // Persist a write barrier before cleanup. Retrying after a transient
      // failure resumes this same deletion; permanent refusals restore the card.
      let result = commit(board => { for (const id of ids) if (board.tasks[id]) board.tasks[id].deleting = true; return { ok: true }; });
      if (!result.ok) throw Object.assign(new Error(result.error), { code: result.error, status: 500 });
      try { await purge(task, ids, purgeOptions); }
      catch (error) {
        if (PERMANENT_PURGE_REFUSALS.has(error.code)) {
          try { commit(board => { for (const id of ids) if (board.tasks[id]) delete board.tasks[id].deleting; return { ok: true }; }); } catch (_) {}
        }
        throw error;
      }
      result = commit(board => {
        for (const id of ids) delete board.tasks[id];
        board.deletedTaskIds = [...new Set([...(board.deletedTaskIds || []), ...ids])];
        for (const [id, group] of Object.entries(board.taskGroups || {})) {
          group.taskIds = group.taskIds.filter(memberId => !ids.includes(memberId));
          if (group.taskIds.length < 2) delete board.taskGroups[id];
          else if (ids.includes(group.rootTaskId)) group.rootTaskId = group.taskIds[0];
        }
        return { ok: true };
      });
      if (!result.ok) throw Object.assign(new Error(result.error), { code: result.error, status: 500 });
      notify(dirId, ids, 'deleted');
      return { ok: true, deleted: true, taskIds: ids };
    } finally { pending.delete(task.id); }
  }
  async function operate(req, res, action) {
    if (action === 'delete') {
      try {
        return res.json(await deleteById(req.params.taskId, {
          force: req.body?.force === true,
          expectedRevision: req.body?.expectedRevision ?? req.body?.revision,
        }));
      } catch (error) {
        const details = Array.isArray(error.reasons) && error.reasons.length ? { reasons: error.reasons } : {};
        if (Array.isArray(error.tasks) && error.tasks.length) {
          details.tasks = error.tasks;
          details.taskIds = Array.isArray(error.taskIds) ? error.taskIds : error.tasks.map(item => item && item.id).filter(Boolean);
          if (error.code === 'TASK_HISTORY_REFERENCED') details.message = taskHistoryRefusal(error).error;
        }
        return fail(res, error.code || error.message || 'task_lifecycle_failed', error.status || 409, details);
      }
    }
    const task = resolveTask(req.params.taskId);
    if (!task) return fail(res, 'task_not_found', 404);
    if (pending.has(task.id) || activeOperations.get(task.id)) return fail(res, 'task_busy');
    pending.add(task.id);
    try {
      if (task.deleting && action !== 'delete') return fail(res, 'task_deleting');
      await assertIdle(task);
      const expected = req.body?.expectedRevision ?? req.body?.revision;
      if (expected != null && task.recordType === 'planned' && Number(expected) !== task.planningRevision) return fail(res, 'revision_conflict');
      const ids = taskIdentityIds(task), dirId = taskDirId(task);
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
  return { isBusy: id => pending.has(resolveTask(id)?.id || id), deleteById,
    archive: (req, res) => operate(req, res, 'archive'),
    restore: (req, res) => operate(req, res, 'restore'),
    delete: (req, res) => operate(req, res, 'delete') };
}

function createBoardTaskLifecycle({ deps, ...rest }) {
  return createTaskLifecycle({ ...rest, assertIdle: async task => {
    await deps.assertTaskIdle?.(task, rest.taskIdentityIds(task));
  }, preparePurge: async (task, ids, options) => {
    await deps.prepareTaskDelete?.(task, ids, options);
  }, purge: async (task, ids, options) => {
    if (!deps.purgeTaskData) throw Object.assign(new Error('task_delete_unavailable'), { code: 'task_delete_unavailable' });
    await deps.purgeTaskData(task, ids, options);
  } });
}

module.exports = { createTaskLifecycle, createBoardTaskLifecycle };
