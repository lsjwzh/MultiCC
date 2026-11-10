'use strict';
const fs = require('node:fs');
const { gitRun, gitWorktreeMergeState, gitWorktreeRemove } = require('../git/service');
const { isOpenRunState } = require('../classify/vocab');
const { taskDirId } = require('./core');

function createTaskLifecycleHost({ records, getBoard, getShell, getHistory, getState,
  getRunState, isSessionBusy = () => false, dropHistoryMessages, canDeleteHistory, deleteHistory,
  destroySession, directories, persist, mutate,
  resetTaskState,
  workspaceBroadcast, chatBroadcast, getHibernation }) {
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
    if (!record.worktreePath || !record.branch || (safety.reason && !safety.worktreeMissing) || safety.conflict) {
      reasons.push('task_workspace_unverifiable');
    }
    if (safety.worktreeMissing && !reasons.length) {
      // Reclaimed checkouts retain their branch. Prove that it is merged
      // from the base repo; merge-state's placeholder ahead=0 is not evidence.
      try {
        const ref = `refs/heads/${record.branch}`;
        const refs = await gitRun(dir.path, ['for-each-ref', '--format=%(refname)', ref]);
        // A never-materialized planned workspace has no branch. A Git IO
        // failure must still refuse deletion rather than masquerade as absence.
        if (!refs.split('\n').includes(ref)) return;
        const checkouts = await gitRun(dir.path, ['worktree', 'list', '--porcelain']);
        if (checkouts.split('\n').includes(`branch ${ref}`)) throw new Error('branch still checked out');
        const baseBranch = dir.baseBranch || safety.baseBranch;
        if (!baseBranch) throw new Error('base branch unavailable');
        const baseRef = `refs/heads/${baseBranch}`;
        const ahead = Number(await gitRun(dir.path, ['rev-list', '--count', `${baseRef}..${ref}`]));
        if (!Number.isInteger(ahead) || ahead < 0) throw new Error('invalid commit count');
        if (ahead > 0) reasons.push('task_workspace_unmerged');
        else await gitRun(dir.path, ['merge-base', '--is-ancestor', ref, baseRef]);
      } catch (_) { reasons.push('task_workspace_unverifiable'); }
    }
    if (reasons.length) throw Object.assign(new Error(reasons[0]), { code: reasons[0], reasons });
    if (safety.worktreeMissing) return;
    if (safety.dirty) reasons.push('task_workspace_dirty');
    if (safety.ahead > 0) reasons.push('task_workspace_unmerged');
    if (!Number.isFinite(safety.ahead)) reasons.push('task_workspace_unverifiable');
    if (!reasons.length && record.branch) {
      try {
        const currentBranch = await gitRun(record.worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
        if (currentBranch !== record.branch) reasons.push('task_workspace_unverifiable');
        const baseBranch = dir.baseBranch || safety.baseBranch;
        if (!baseBranch) reasons.push('task_workspace_unverifiable');
        else await gitRun(dir.path, ['merge-base', '--is-ancestor', `refs/heads/${record.branch}`, `refs/heads/${baseBranch}`]);
      } catch (_) { reasons.push('task_workspace_unverifiable'); }
    }
    if (reasons.length) throw Object.assign(new Error(reasons[0]), { code: reasons[0], reasons });
  }
  async function assertNoIgnoredData(worktreePath) {
    if (!worktreePath || !fs.existsSync(worktreePath)) return;
    const ignored = await gitRun(worktreePath, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--directory']);
    if (ignored) throw Object.assign(new Error('task_workspace_ignored'), { code: 'task_workspace_ignored' });
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
      // An open run blocks the delete: `background` too, because that turn is
      // only idle while a job it started is still out there. Membership lives
      // in src/classify/vocab.js (OPEN_RUN_STATES) — the same list the merge
      // guard and both UIs read.
      if ((dedicated || selected || current) && (isOpenRunState(getRunState(record.id)) || isSessionBusy(record.id))) {
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
        if (options.automatic) await assertNoIgnoredData(record.worktreePath);
      }
    }
    for (const member of worktrees(ids)) {
      if (otherTasks.some(t => t.worktreePath === member.worktreePath)) {
        throw Object.assign(new Error('shell_workspace_referenced'), { code: 'shell_workspace_referenced' });
      }
      if (!options.force) {
        await assertWorkspaceSafe(directories.get(taskDirId(getBoard(), member)), member);
        if (options.automatic) await assertNoIgnoredData(member.worktreePath);
      }
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
      // 只把要删的消息 id 交给队列；当前 transcript 由 Rust 在队首读取，任务
      // 刚判空闲时仍在飞的那条追加不会被 Node 的旧底稿覆盖或误删。
      //
      // 边界（问题 4）：ids 来自这里的 Node 快照。快照之后才落地、却带着本任务
      // taskId 的消息不会被裁剪；assertTaskIdle 让这条路径实际上不可达（任务
      // 空闲时没有在飞的追加）。队列仍按 id 过滤而不是按 taskId 扫整份历史，
      // 否则另一任务共享的消息 id 会被一并删掉。
      const dropIds = sharedHistory ? [] : history
        .filter(m => !sharedIds.has(m.id) && (ids.includes(m.taskId) || ownedIds.has(m.id)))
        .map(m => m.id)
        .filter(Boolean);
      if (dropIds.length) {
        await dropHistoryMessages(record.id, dropIds, { reason: 'task-delete' });
      }
      // Direct record write, routed through the native record owner.
      if (ids.includes(record.taskState?.taskId)) resetTaskState(record.id);
      if (ids.includes(getState(record.id)?._currentTaskId)) delete getState(record.id)._currentTaskId;
      // 删除资格只问 Rust（chat_history 的 deletionVerdict），Node 只按结构化
      // 结论行事，不维护第二份判据：
      // - ok：删历史并销毁会话；
      // - shared：另一个任务通过 chatSessionId/refs 正式拥有该会话（旧 purge
      //   的 shared 分支）→ 保持会话原样，绝不删共享历史；
      // - referenced：routing.workerSessionId 或受保护消息（旧 deleteSession
      //   会抛 TASK_HISTORY_REFERENCED）→ 同样中止任务删除，卡片可见可重试。
      //
      // 这些 await 没有调用方超时/看门狗（问题 2，见 docs/backend-rust-exit-plan.md）：
      // 放弃在途写会重新引入“旧写覆盖新写”的竞态。同会话的所有历史写共享
      // 这个限制，旧同步实现更是整段阻塞事件循环。
      if (ids.includes(record.taskBoundTaskId)) {
        const verdict = canDeleteHistory(record.id);
        const deletable = verdict === true || verdict?.ok === true;
        const shared = verdict !== false && verdict?.reason === 'shared';
        if (deletable) {
          // The generic session teardown treats history IO as best-effort. A
          // permanent task deletion must instead fail visibly and remain retryable.
          // The queued delete only cancels unstarted work after it commits, so a
          // refusal leaves every accepted write on disk.
          await deleteHistory(record.id);
          const result = await destroySession(record, directories.get(record.dirId), { force: !!options.force });
          if (!result.ok) throw removalFailure(result, 'session_delete_failed');
        } else if (!shared && verdict !== false) {
          // Unknown/failed verdicts fail closed and stay retryable instead of
          // silently orphaning the session behind a deleted task.
          throw Object.assign(new Error('TASK_HISTORY_REFERENCED'), {
            code: 'TASK_HISTORY_REFERENCED',
            ...(Array.isArray(verdict?.tasks) ? { tasks: verdict.tasks } : {}),
            ...(Array.isArray(verdict?.taskIds) ? { taskIds: verdict.taskIds } : {}),
          });
        }
        // verdict === false（旧布尔接线）也与 shared 一样保持会话原样。
      }
    }
    persist();
  }
  async function withTaskWorktreeCleanup(task, remove, complete) {
    // References and routing are not ownership: only the dedicated session
    // whose checkout and branch both match may have its lifecycle changed.
    const residents = [...records.values()].filter(record => record.worktreePath === task.worktreePath
      || record.branch === task.branch);
    const owners = residents.filter(record => record.taskBoundTaskId === task.id
      && record.dirId === taskDirId(getBoard(), task) && !record.workspaceOwnerSessionId
      && record.worktreePath === task.worktreePath && record.branch === task.branch
      && record.branch === `multicc/${record.id}`);
    if (residents.length && (owners.length !== 1 || residents.length !== 1)) {
      return { ok: false, blocked: true, code: 'workspace_owner_mismatch' };
    }
    assertTaskIdle(task, [task.id]);
    if (!owners.length) return complete(await remove({}));
    const owner = owners[0];
    const runtime = getHibernation?.();
    if (!runtime?.reclaimMergedWorkspace) return { ok: false, code: 'workspace_cleanup_unavailable' };
    const activeCheck = () => isSessionBusy(owner.id) || isOpenRunState(getRunState(owner.id));
    // A publication callback can still be inside its own merge lease. Skip;
    // waiting on that lease here would deadlock the operation that published it.
    if (activeCheck() || runtime.isLocked(owner.id)) return { ok: false, blocked: true, code: 'run_active' };
    return runtime.reclaimMergedWorkspace(owner.id, { ...task, dirId: owner.dirId },
      () => remove({ sessionId: owner.id, activeCheck }), complete);
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
  return { assertTaskIdle, prepareTaskDelete, purgeTaskData, syncTaskTitle, withTaskWorktreeCleanup };
}

module.exports = { createTaskLifecycleHost };
