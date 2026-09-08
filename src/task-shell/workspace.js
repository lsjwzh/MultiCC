'use strict';

const { defaultRepoActor } = require('../repo-actor');
const { gitWorktreeSnapshot } = require('../git/service');
const { existsSync } = require('node:fs');
const fail = (code, message = code) => Object.assign(new Error(message), { code, status: 409 });

function sharedWorkspace(records, ownerId, dirId) {
  const owner = records.get(ownerId);
  if (!owner || owner.dirId !== dirId || owner.workspaceOwnerSessionId || !owner.worktreePath || !owner.branch
      || !existsSync(owner.worktreePath) || (owner.workspaceState && owner.workspaceState !== 'awake')) throw fail('shell_workspace_unavailable');
  return { worktreePath: owner.worktreePath, branch: owner.branch };
}

function createShellWorkspaceHost(deps) {
  const forkLocks = new Set();
  function group(id) { return deps.records.get(id)?.workspaceOwnerSessionId || id; }
  function busy(id) {
    const key = group(id);
    if (forkLocks.has(key)) return true;
    for (const record of deps.records.values()) {
      if (record.id === id || group(record.id) !== key) continue;
      const state = deps.getChatState(record.id);
      if (state?.isStreaming || state?.claudeProc || state?._cancelledProc || state?._activeRunner
          || deps.getWorkHost()?.isRunActive(record.id) || deps.hasBackground?.(record.id)) return true;
    }
    return false;
  }
  async function prepareExecution(task, owner) {
    if (!owner || owner.standalone) return;
    let record = deps.records.get(task.sessionId);
    if (!record || record.id === owner.sourceSessionId) return;
    const target = sharedWorkspace(deps.records, owner.sourceSessionId, task.dirId);
    if (record.worktreePath === target.worktreePath && record.workspaceOwnerSessionId === owner.sourceSessionId) return;
    if (record.workspaceState && record.workspaceState !== 'awake') {
      const result = await deps.ensureWorkspaceAwake?.(record.id);
      if (!result?.ok) throw fail(result?.code || 'legacy_workspace_unavailable');
      record = deps.records.get(task.sessionId);
    }
    // Legacy per-task directories are never silently discarded or rebound
    // with live/unique work. Successful migration keeps a recoverable ledger.
    const state = deps.getChatState(record.id);
    if (state?.isStreaming || state?.claudeProc || deps.getWorkHost()?.isRunActive(record.id) || deps.hasBackground?.(record.id)) throw fail('legacy_workspace_busy');
    const dir = deps.directories.get(task.dirId);
    await defaultRepoActor.run(dir.path, 'shell-workspace-migration', async ({ execGit }) => {
      const dirty = await execGit(record.worktreePath, ['status', '--porcelain', '--untracked-files=all']);
      const ahead = await execGit(record.worktreePath, ['rev-list', '--count', `${dir.baseBranch}..HEAD`]);
      if (dirty || Number(ahead) > 0) throw fail('legacy_workspace_has_changes', 'Save and merge the old task workspace before continuing in the conversation workspace');
      await deps.closeExecution?.(record.id);
      deps.persistRecords('task-shell.workspace-migration', map => {
        const current = map.get(record.id);
        current.retiredWorktrees = [...(current.retiredWorktrees || []), { worktreePath: current.worktreePath, branch: current.branch }];
        require('../cli-switch').clearAllNativeCliStates(current);
        Object.assign(current, target, { workspaceOwnerSessionId: owner.sourceSessionId });
      });
      deps.resetChatState?.(record.id);
    }, { sessionId: record.id });
  }
  async function captureForkBaseline(task, owner, captureHistory) {
    const sid = [task.sessionId, task.chatSessionId, owner.sourceSessionId].find(id => deps.records.has(id)), key = group(sid);
    if (busy(sid) || forkLocks.has(key)) throw fail('fork_source_busy');
    forkLocks.add(key);
    try {
      const state = deps.getChatState(sid);
      if (state?.isStreaming || state?.claudeProc || deps.getWorkHost()?.isRunActive(sid) || deps.hasBackground?.(sid)) throw fail('fork_source_busy');
      let record = deps.records.get(sid);
      if (record?.workspaceState && record.workspaceState !== 'awake') {
        const result = await deps.ensureWorkspaceAwake?.(sid);
        if (!result?.ok) throw fail(result?.code || 'source_workspace_missing');
        record = deps.records.get(sid);
      }
      if (!record?.worktreePath) throw fail('source_workspace_missing');
      const snapshot = await gitWorktreeSnapshot(record.worktreePath, record.branch);
      if (snapshot.changes.length) throw fail('fork_source_dirty', 'Commit the source changes before forking; uncommitted files are not copied');
      return { commit: snapshot.head, branch: snapshot.branch, sourceSessionId: sid, sourceWorkspace: record.worktreePath, ...(captureHistory ? { history: await captureHistory() } : {}) };
    } finally { forkLocks.delete(key); }
  }
  return { group, busy, prepareExecution, captureForkBaseline };
}
module.exports = { sharedWorkspace, createShellWorkspaceHost };
