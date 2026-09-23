'use strict';

// Composition for the session hibernation runtime: git ports, runtime blocker
// inspection, persistence and event wiring. Extracted from server.js so the
// host stays under its line budget; behavior is unchanged unless noted.

const fs = require('node:fs');
const { createSessionHibernationRuntime } = require('./hibernation');

// Non-terminal orchestration rows older than this no longer pin a workspace
// awake (zombie amnesty); recovery still owns their lifecycle.
const DEFAULT_DURABLE_STALE_MS = 6 * 60 * 60 * 1000;

function createSessionHibernation(deps) {
  const {
    records, directories, persistence, loadHistory,
    gitWorktreeValidate, gitWorktreeDetach, gitWorktreeAdd, gitWorktreeMergeState,
    invalidSessions, defaultRepoActor, chatSessions, chatStream,
    backgroundTaskRuntime, waitInjector, orchestrationRuntime, sessionWorkHost,
    getWorkspaceAdmission, workspaceBroadcast, metrics, logger,
  } = deps;

  return createSessionHibernationRuntime({
    records, directories, persistence, loadHistory,
    git: {
      inspect: async (dir, record) => {
        if (!dir || !record.worktreePath || !record.branch) return { pathExists: false, branchExists: false, valid: false };
        const result = await gitWorktreeValidate(dir.path, record.worktreePath, record.branch, { sessionId: record.id });
        return { pathExists: result.pathExists, branchExists: result.branchExists, valid: result.ok, code: result.code };
      },
      detach: (dir, record) => gitWorktreeDetach(dir.path, record.worktreePath, record.branch, { sessionId: record.id }),
      thaw: async (dir, record) => {
        try {
          return await gitWorktreeAdd(dir.path, record.id, dir.baseBranch, {
            sessionId: record.id,
            requireExistingBranch: true,
          });
        } catch (error) {
          if (error?.code !== 'WORKTREE_BRANCH_MISSING') throw error;
          // A missing retained ref must not make a conversation permanently
          // unusable. Recreate only this session's isolated branch/path from the
          // directory base; an existing detached/conflicted checkout is retained
          // by gitWorktreeAdd and continues in place.
          return gitWorktreeAdd(dir.path, record.id, dir.baseBranch, { sessionId: record.id });
        }
      },
    },
    inspectBlockers: async (id, record) => {
      const blockers = [], chat = chatSessions.get(id), stream = chatStream.status(id);
      if (invalidSessions.has(id)) {
        // Revalidate before treating as permanently invalid: a directory that
        // came back (remount, re-add, fixed duplicate) un-marks the session so
        // it can hibernate instead of blocking every sweep until a restart.
        const dir = directories.get(record.dirId);
        if (dir && record.worktreePath && fs.existsSync(record.worktreePath)) invalidSessions.delete(id);
        else blockers.push('invalid_session');
      }
      try { if (getWorkspaceAdmission()?.hasActiveLease?.(id)) blockers.push('workspace_lease'); } catch (_) { blockers.push('workspace_lease_unknown'); }
      if (defaultRepoActor.isLeased(id)) blockers.push('repo_lease');
      if (chat?.isStreaming || chat?.claudeProc || chat?._cancelledProc || chat?._activeRunner) blockers.push('active_cli');
      if (stream?.busy || stream?.queued) blockers.push('active_stream');
      if (backgroundTaskRuntime.hasLiveBackgroundTasks(id)) blockers.push('background_task');
      if (waitInjector.hasWait(id)) blockers.push('pending_wait');
      const durableStaleMs = Number(process.env.MULTICC_HIBERNATE_DURABLE_STALE_MS || DEFAULT_DURABLE_STALE_MS);
      if (orchestrationRuntime && await orchestrationRuntime.hasSessionActivity(id, { staleMs: durableStaleMs })) blockers.push('durable_work');
      if (sessionWorkHost?.isRunActive(id)) blockers.push('running_task');
      if (record.worktreePath && fs.existsSync(record.worktreePath)) {
        const state = await gitWorktreeMergeState(directories.get(record.dirId), record).catch(() => null);
        if (!state) blockers.push('git_state_unknown'); else if (state.conflict) blockers.push('git_conflict');
      }
      return blockers;
    },
    closePersistent: id => chatStream.closeAndWait(id),
    updateChatCwd: (id, cwd) => { const chat = chatSessions.get(id); if (chat) chat.cwd = cwd; },
    pathExists: record => !!record.worktreePath && fs.existsSync(record.worktreePath),
    idleMs: process.env.MULTICC_SESSION_HIBERNATE_IDLE_MS,
    intervalMs: process.env.MULTICC_SESSION_HIBERNATE_INTERVAL_MS,
    startupDelayMs: process.env.MULTICC_SESSION_HIBERNATE_STARTUP_DELAY_MS,
    batchSize: process.env.MULTICC_SESSION_HIBERNATE_BATCH_SIZE,
    awakeLimit: process.env.MULTICC_WORKSPACE_AWAKE_LIMIT,
    onEvent: event => {
      logger.info('session_workspace_lifecycle', event);
      const record = event.sessionId && records.get(event.sessionId);
      if (record?.dirId) workspaceBroadcast(record.dirId, event);
      if (event.action === 'hibernate' && event.status === 'success') getWorkspaceAdmission()?.reconcileResidency?.();
    },
    metric: name => metrics.inc(name), logger,
  });
}

module.exports = { createSessionHibernation, DEFAULT_DURABLE_STALE_MS };
