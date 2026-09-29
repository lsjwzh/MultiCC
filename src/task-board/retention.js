'use strict';

const { isOpenRunState } = require('../classify/vocab');
const { MAX_TASKS_PER_DIRECTORY } = require('../task-shell/capacity');
const MAX_BATCH_DELETE = 100;

function timestamp(value) {
  if (value instanceof Date) return timestamp(value.getTime());
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value === 'string') return Date.parse(value) || 0;
  return 0;
}

function lastInteraction(task, record) {
  const messageRefs = (Array.isArray(task.refs) ? task.refs : [])
    .filter(ref => ref.sessionId === record.id && (ref.userMsgId || ref.assistantMsgId));
  if (!messageRefs.length) return 0;
  const latest = Math.max(...messageRefs.map(ref => timestamp(ref.ts)));
  return latest || timestamp(record.lastWorkAt);
}

function retentionCandidates({ board, shellTasks, dirId, records, pinnedIds, excludedIds = [],
  getRunState, isSessionBusy = () => false, taskDirId, taskLineageIds }) {
  if (!Array.isArray(pinnedIds)) throw new Error('air pins unavailable');
  const pinned = new Set(pinnedIds);
  const excluded = new Set(excludedIds.filter(Boolean));
  const candidates = [];
  for (const shellTask of shellTasks) {
    if (shellTask.dirId !== dirId || !shellTask.ready || excluded.has(shellTask.id)) continue;
    const task = board.tasks?.[shellTask.id];
    if (!task || taskDirId(task) !== dirId || task.deleting || task.mergedIntoTaskId
        || !(task.status === 'done' || (task.status === 'archived' && task.archivedFromStatus === 'done'))) continue;
    const lineage = taskLineageIds(task);
    if (lineage.length !== 1 || lineage.some(id => pinned.has(id))) continue;
    const record = records.get(shellTask.sessionId);
    // Only a dedicated execution can be removed without affecting another
    // task's conversation. Legacy shared shells are never automatic victims.
    if (!record || record.taskBoundTaskId !== task.id || record.dirId !== dirId
        || record.workspaceOwnerSessionId) continue;
    const runState = getRunState(record.id);
    if (!runState || isOpenRunState(runState) || isSessionBusy(record.id)) continue;
    const at = lastInteraction(task, record);
    if (at > 0) candidates.push({ id: task.id, sessionId: record.id, at });
  }
  return candidates.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

function createTaskRetention(deps) {
  const flights = new Map();
  function candidates(dirId, listShellTasks, excludedIds = [], ignoreTaskBusy = false) {
    return retentionCandidates({ board: deps.getBoard(), shellTasks: listShellTasks(), dirId,
      records: deps.records, pinnedIds: deps.getPinnedTaskIds(), excludedIds,
      getRunState: deps.getRunState, isSessionBusy: deps.isSessionBusy,
      taskDirId: deps.taskDirId, taskLineageIds: deps.taskLineageIds })
      .filter(item => ignoreTaskBusy || !deps.isTaskBusy?.(item.id));
  }
  async function preview(dirId, listShellTasks) {
    const safe = [];
    for (const candidate of candidates(dirId, listShellTasks)) {
      const task = deps.getBoard().tasks?.[candidate.id];
      if (!task) continue;
      try { await deps.prepareDelete(task, [task.id], { force: false, automatic: true }); }
      catch (_) { continue; }
      // The read-only Git check can yield; a pin or run may have changed.
      if (!candidates(dirId, listShellTasks).some(item => item.id === candidate.id)) continue;
      safe.push({ id: task.id, title: task.title || task.id, lastInteractionAt: candidate.at });
      if (safe.length === MAX_BATCH_DELETE) break;
    }
    return { limit: MAX_TASKS_PER_DIRECTORY, count: listShellTasks().filter(task => task.dirId === dirId).length,
      maxBatch: MAX_BATCH_DELETE, tasks: safe };
  }
  async function deleteSelected(dirId, listShellTasks, ids) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_BATCH_DELETE
        || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id)) {
      throw Object.assign(new Error('Select 1–100 distinct tasks from the preview'), { code: 'invalid_selection', status: 400 });
    }
    const previous = flights.get(dirId);
    let release;
    const current = new Promise(resolve => { release = resolve; });
    flights.set(dirId, current);
    if (previous) await previous;
    const deleted = [], skipped = [];
    try {
      for (const id of ids) {
        // Recheck the complete predicate, including Git and ignored files, at
        // execution time. Never turn a refusal into a force delete.
        const item = candidates(dirId, listShellTasks).find(value => value.id === id);
        const task = item && deps.getBoard().tasks?.[id];
        if (!task) { skipped.push({ id, reason: 'no_longer_eligible' }); continue; }
        try {
          await deps.prepareDelete(task, [id], { force: false, automatic: true });
          if (!candidates(dirId, listShellTasks).some(value => value.id === id)) {
            skipped.push({ id, reason: 'no_longer_eligible' }); continue;
          }
          await deps.deleteById(id, { force: false, automatic: true,
            guard: () => candidates(dirId, listShellTasks, [], true).some(value => value.id === id) });
          deleted.push(id);
        } catch (error) { skipped.push({ id, reason: error.code || 'delete_failed' }); }
      }
      return { deleted, skipped, count: listShellTasks().filter(task => task.dirId === dirId).length, limit: MAX_TASKS_PER_DIRECTORY };
    } finally {
      release();
      if (flights.get(dirId) === current) flights.delete(dirId);
    }
  }
  async function evict(dirId, listShellTasks, atCapacity, excludedIds = []) {
    // Serialize evictions per directory, then re-read both stores. A second
    // creator must not delete another old task on a stale count.
    const previous = flights.get(dirId);
    let release;
    const current = new Promise(resolve => { release = resolve; });
    flights.set(dirId, current);
    if (previous) await previous;
    try {
      if (!atCapacity()) return { evicted: false };
      for (const candidate of candidates(dirId, listShellTasks, excludedIds)) {
        if (!atCapacity()) return { evicted: false };
        const task = deps.getBoard().tasks?.[candidate.id];
        if (!task || task.deleting) continue;
        try { await deps.prepareDelete(task, [task.id], { force: false, automatic: true }); }
        catch (_) { continue; } // An unsafe candidate is never force-deleted.
        const pinnedNow = deps.getPinnedTaskIds();
        if (!Array.isArray(pinnedNow)) throw new Error('air pins unavailable');
        if (deps.taskLineageIds(task).some(id => pinnedNow.includes(id))) continue;
        if (isOpenRunState(deps.getRunState(candidate.sessionId)) || deps.isSessionBusy?.(candidate.sessionId)) continue;
        // The lifecycle repeats idle/Git/reference checks after its write
        // barrier; a failed second check aborts this admission, not safety.
        try { await deps.deleteById(task.id, { force: false, automatic: true,
          guard: () => candidates(dirId, listShellTasks, excludedIds, true).some(value => value.id === task.id) }); }
        catch (error) {
          if (['no_longer_eligible', 'task_busy', 'task_session_shared', 'shell_workspace_referenced', 'TASK_HISTORY_REFERENCED',
            'task_workspace_dirty', 'task_workspace_unmerged', 'task_workspace_ignored',
            'task_workspace_unverifiable'].includes(error.code)) continue;
          throw error;
        }
        if (!atCapacity()) return { evicted: true, taskId: task.id };
        break;
      }
      const error = new Error('No safely removable completed task is available');
      error.code = 'task_shell_task_limit'; error.status = 409;
      throw error;
    } finally {
      release();
      if (flights.get(dirId) === current) flights.delete(dirId);
    }
  }
  return { evict, preview, deleteSelected };
}

module.exports = { lastInteraction, retentionCandidates, createTaskRetention };
