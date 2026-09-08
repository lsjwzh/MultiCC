'use strict';
const { gitWorktreeMergeState, gitWorktreeRemove } = require('../git/service');
const { taskDirId } = require('./core');

function createTaskLifecycleHost({ records, getBoard, getShell, getHistory, getState,
  getRunState, getHistoryService, destroySession, directories, persist }) {
  function worktrees(ids) {
    return Object.values(getBoard().tasks).filter(t => ids.includes(t.id) && t.worktreePath && t.branch);
  }
  async function assertWorkspaceSafe(dir, record) {
    if (!dir) throw Object.assign(new Error('directory_not_found'), { code: 'directory_not_found' });
    const safety = await gitWorktreeMergeState(dir, record);
    const code = safety.dirty ? 'task_workspace_dirty' : safety.ahead > 0 ? 'task_workspace_unmerged' : null;
    if (code) throw Object.assign(new Error(code), { code });
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
  async function prepareTaskDelete(task, ids) {
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
      if (ids.includes(record.taskBoundTaskId) && record.worktreePath && !record.workspaceOwnerSessionId) {
        await assertWorkspaceSafe(directories.get(record.dirId), record);
      }
    }
    for (const member of worktrees(ids)) {
      if (otherTasks.some(t => t.worktreePath === member.worktreePath)) {
        throw Object.assign(new Error('shell_workspace_referenced'), { code: 'shell_workspace_referenced' });
      }
      await assertWorkspaceSafe(directories.get(taskDirId(getBoard(), member)), member);
    }
  }
  async function purgeTaskData(task, ids) {
    await prepareTaskDelete(task, ids);
    const targets = sessions(task, ids);
    const otherTasks = Object.values(getBoard().tasks).filter(t => !ids.includes(t.id));
    const ownedRefs = Object.values(getBoard().tasks).filter(t => ids.includes(t.id)).flatMap(t => t.refs || []);
    // Legacy planned tasks can own a worktree directly, without a dedicated chat.
    for (const member of worktrees(ids)) {
      if (targets.some(r => ids.includes(r.taskBoundTaskId) && !r.workspaceOwnerSessionId && r.worktreePath === member.worktreePath)) continue;
      const dir = directories.get(taskDirId(getBoard(), member));
      const result = await gitWorktreeRemove(dir.path, member.worktreePath, member.branch, { baseBranch: dir.baseBranch });
      if (!result.ok) {
        const code = result.code || result.reasons?.[0] || 'worktree_remove_refused';
        throw Object.assign(new Error(code), { code });
      }
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
        const result = await destroySession(record, directories.get(record.dirId));
        if (!result.ok) {
          const code = result.code || result.reasons?.[0] || 'session_delete_failed';
          throw Object.assign(new Error(code), { code });
        }
      }
    }
    persist();
  }
  return { assertTaskIdle, prepareTaskDelete, purgeTaskData };
}

module.exports = { createTaskLifecycleHost };
