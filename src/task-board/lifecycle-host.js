'use strict';
const { gitWorktreeMergeState, gitWorktreeRemove } = require('../git/service');
const { taskDirId } = require('./core');

function createTaskLifecycleHost({ records, getBoard, getShell, getHistory, getState,
  getRunState, getHistoryService, destroySession, directories, persist, mutate,
  workspaceBroadcast, chatBroadcast }) {
  function worktrees(ids) {
    return Object.values(getBoard().tasks).filter(t => ids.includes(t.id) && t.worktreePath && t.branch);
  }
  function removalFailure(result, fallback) {
    const reasons = (result.reasons || []).map(reason => reason === 'dirty' ? 'task_workspace_dirty'
      : reason === 'unmerged' ? 'task_workspace_unmerged' : reason);
    const code = result.code || reasons[0] || fallback;
    return Object.assign(new Error(code), { code, ...(reasons.length ? { reasons } : {}) });
  }
  async function assertWorkspaceSafe(dir, record) {
    if (!dir) throw Object.assign(new Error('directory_not_found'), { code: 'directory_not_found' });
    const safety = await gitWorktreeMergeState(dir, record);
    const reasons = [];
    if (safety.dirty) reasons.push('task_workspace_dirty');
    if (safety.ahead > 0) reasons.push('task_workspace_unmerged');
    if (reasons.length) throw Object.assign(new Error(reasons[0]), { code: reasons[0], reasons });
  }
  function sessions(task, ids) {
    const tasks = Object.values(getBoard().tasks).filter(t => ids.includes(t.id));
    return [...records.values()].filter(record => ids.includes(record.taskBoundTaskId)
      || ids.includes(record.taskState?.taskId) || record.id === task.chatSessionId
      || tasks.some(t => t.chatSessionId === record.id || (t.refs || []).some(ref => ref.sessionId === record.id)));
  }
  function assertTaskIdle(task, ids) {
    for (const record of sessions(task, ids)) {
      const dedicated = ids.includes(record.taskBoundTaskId);
      const selected = ids.includes(getShell().stateTarget(record.id).taskId);
      const current = ids.includes(record.taskState?.taskId) || ids.includes(getState(record.id)?._currentTaskId);
      if ((dedicated || selected || current) && ['running', 'queued', 'waiting'].includes(getRunState(record.id))) {
        throw Object.assign(new Error('task_busy'), { code: 'task_busy' });
      }
    }
  }
  async function prepareTaskDelete(task, ids, options = {}) {
    assertTaskIdle(task, ids);
    const targets = sessions(task, ids);
    const otherTasks = Object.values(getBoard().tasks).filter(t => !ids.includes(t.id));
    // No parent shell or another task's conversation is disposed here.
    for (const record of targets) {
      if (ids.includes(record.taskBoundTaskId) && otherTasks.some(t => t.chatSessionId === record.id || (t.refs || []).some(r => r.sessionId === record.id))) {
        throw Object.assign(new Error('task_session_shared'), { code: 'task_session_shared' });
      }
      if (ids.includes(record.taskBoundTaskId) && (record.retiredWorktrees?.length || [...records.values()].some(r => r.workspaceOwnerSessionId === record.id))) {
        throw Object.assign(new Error('shell_workspace_referenced'), { code: 'shell_workspace_referenced' });
      }
      if (!options.force && ids.includes(record.taskBoundTaskId) && record.worktreePath && !record.workspaceOwnerSessionId) {
        await assertWorkspaceSafe(directories.get(record.dirId), record);
      }
    }
    for (const member of worktrees(ids)) {
      if (otherTasks.some(t => t.worktreePath === member.worktreePath)) {
        throw Object.assign(new Error('shell_workspace_referenced'), { code: 'shell_workspace_referenced' });
      }
      if (!options.force) await assertWorkspaceSafe(directories.get(taskDirId(getBoard(), member)), member);
    }
  }
  async function purgeTaskData(task, ids, options = {}) {
    await prepareTaskDelete(task, ids, options);
    const targets = sessions(task, ids);
    const otherTasks = Object.values(getBoard().tasks).filter(t => !ids.includes(t.id));
    const ownedRefs = Object.values(getBoard().tasks).filter(t => ids.includes(t.id)).flatMap(t => t.refs || []);
    // Legacy planned tasks can own a worktree directly, without a dedicated chat.
    for (const member of worktrees(ids)) {
      if (targets.some(r => ids.includes(r.taskBoundTaskId) && !r.workspaceOwnerSessionId && r.worktreePath === member.worktreePath)) continue;
      const dir = directories.get(taskDirId(getBoard(), member));
      const result = await gitWorktreeRemove(dir.path, member.worktreePath, member.branch, {
        baseBranch: dir.baseBranch, force: !!options.force,
      });
      if (!result.ok) throw removalFailure(result, 'worktree_remove_refused');
    }
    getShell().purgeTasks(ids);
    for (const record of targets) {
      const sharedIds = new Set(otherTasks.flatMap(t => (t.refs || []).filter(r => r.sessionId === record.id)
        .flatMap(r => [r.userMsgId, r.assistantMsgId]).filter(Boolean)));
      const ownedIds = new Set(ownedRefs.filter(r => r.sessionId === record.id)
        .flatMap(r => [r.userMsgId, r.assistantMsgId]).filter(Boolean));
      const history = getHistory(record.id);
      const sharedHistory = otherTasks.some(t => (t.refs || []).some(r => r.sessionId === record.id && !r.userMsgId && !r.assistantMsgId));
      const kept = history.filter(m => sharedHistory || sharedIds.has(m.id) || (!ids.includes(m.taskId) && !ownedIds.has(m.id)));
      if (kept.length !== history.length) getHistoryService().replace(record.id, kept, { reason: 'task-delete' });
      if (ids.includes(record.taskState?.taskId)) record.taskState = {};
      if (ids.includes(getState(record.id)?._currentTaskId)) delete getState(record.id)._currentTaskId;
      const shared = otherTasks.some(t => t.chatSessionId === record.id || (t.refs || []).some(r => r.sessionId === record.id));
      if (ids.includes(record.taskBoundTaskId) && !shared) {
        // The generic session teardown treats history IO as best-effort. A
        // permanent task deletion must instead fail visibly and remain retryable.
        getHistoryService().deleteSession(record.id);
        const result = await destroySession(record, directories.get(record.dirId), { force: !!options.force });
        if (!result.ok) throw removalFailure(result, 'session_delete_failed');
      }
    }
    persist();
  }
  function syncTaskTitle(task) {
    if (typeof mutate !== 'function') return;
    const updated = [];
    mutate('task.title-rename', sessions => {
      for (const record of sessions.values()) {
        if (record.taskBoundTaskId !== task.id) continue;
        record.label = task.title;
        updated.push({ id: record.id, dirId: record.dirId });
      }
    });
    for (const record of updated) {
      const event = { type: 'session_updated', sessionId: record.id, label: task.title };
      workspaceBroadcast?.(record.dirId, event);
      chatBroadcast?.(record.id, event);
    }
  }
  return { assertTaskIdle, prepareTaskDelete, purgeTaskData, syncTaskTitle };
}

module.exports = { createTaskLifecycleHost };
