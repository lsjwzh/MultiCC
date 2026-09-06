'use strict';

const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { createTaskShellStore } = require('./store');
const { createTaskShellRuntime, failure } = require('./runtime');
const { snapshotHistory, renderSnapshots, verifySnapshot } = require('./context');
const { mountTaskShellRoutes } = require('./routes');

function createTaskShellHost(deps) {
  const enabled = () => process.env.MULTICC_TASK_SHELLS === '1';
  let runtime, store;
  function candidate(id) {
    const record = deps.records.get(id);
    return record?.taskBoundTaskId && id === `task-${record.taskBoundTaskId.replace(/^tsk_/, '')}`;
  }
  function currentTurn(sessionId) {
    const record = deps.records.get(sessionId);
    return record?.taskState?.pendingUserInput?.resolved !== true && record?.taskState?.pendingUserInput?.turnId
      || record?.taskState?.userInputSignalTurnId || null;
  }
  function getRuntime() {
    if (runtime) return runtime;
    if (!enabled() && !fs.existsSync(deps.file)) return null;
    store = createTaskShellStore(deps.file);
    runtime = createTaskShellRuntime({
      store, enabled,
      getRecord: id => deps.records.get(id),
      getHistory: deps.loadHistory,
      getExecution: async id => {
        const host = deps.getWorkHost();
        const scheduler = deps.getScheduler();
        const record = deps.records.get(id);
        if (!host || !scheduler || !record) return { busy: true, status: 'unavailable' };
        const state = await scheduler.status(id);
        const pending = record.taskState?.pendingUserInput;
        const busy = !!state.active || !!state.queued?.length || !!(pending && !pending.resolved)
          || !['idle', 'assessing'].includes(state.state) || host.isRunActive(id);
        return { busy, status: host.getRunState(id), completed: !busy && state.classifyState === 'D',
          turnId: currentTurn(id), pending: pending && !pending.resolved ? pending : null };
      },
      createExecution: async (task, source) => {
        const dir = deps.directories.get(task.dirId);
        if (!dir) throw failure('directory_missing');
        const result = await deps.createSessionRecord({ ...source, dir, id: task.sessionId,
          kind: 'chat', label: task.title, taskBoundTaskId: task.id, autoCommit: false,
          persistence: 'required', persistenceSource: 'task-shell.create' });
        if (!result.ok) return result;
        const record = deps.records.get(task.sessionId);
        if (record.taskBoundTaskId !== task.id || record.dirId !== task.dirId || record.autoCommit !== false) throw failure('execution_identity_conflict');
        const git = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: record.worktreePath, timeout: 15000 });
        return { ok: true, baseline: { commit: git.stdout.trim(), branch: record.branch, baseBranch: dir.baseBranch, worktreePath: record.worktreePath } };
      },
      indexTask: task => deps.getTaskBoard().registerShellTask(task),
      send: (...args) => deps.deliver(...args),
      cancel: (id, turnId) => {
        if (currentTurn(id) !== turnId) throw failure('stale_control');
        return deps.getWorkHost().cancelActiveTurn(id, { source: 'task-shell', reason: 'user_cancelled' });
      },
    });
    return runtime;
  }
  function contextSeed(sessionId, fallback, isFirstTurn) {
    if (!candidate(sessionId)) return fallback;
    const task = getRuntime()?.owns(sessionId);
    if (!task) throw failure('task_shell_state_unavailable');
    if (!isFirstTurn) return '';
    const snapshots = task.snapshotIds.map(id => {
      const value = store.get('snapshot', id);
      if (!verifySnapshot(value, id)) throw failure('snapshot_unverified');
      return value;
    });
    const own = snapshotHistory(task.id, deps.loadHistory(sessionId));
    if (own.messages.length) snapshots.push(own);
    return renderSnapshots(snapshots);
  }
  return {
    mountRoutes: app => mountTaskShellRoutes(app, { getRuntime, enabled }),
    guardAdmission: (id, ...args) => {
      if (!candidate(id)) return null;
      const owner = getRuntime();
      return owner?.owns(id) ? owner.guardAdmission(id, ...args) : { ok: false, code: 'task_shell_state_unavailable' };
    },
    owns: id => candidate(id) ? getRuntime()?.owns(id) || { unavailable: true } : null,
    contextSeed,
    close: () => store?.close(),
  };
}

module.exports = { createTaskShellHost };
