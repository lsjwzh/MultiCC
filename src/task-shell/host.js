'use strict';

const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { createTaskShellStore } = require('./store');
const { createTaskShellRuntime, failure } = require('./runtime');
const { snapshotHistory, renderSnapshots, verifySnapshot } = require('./context');
const { mountTaskShellRoutes } = require('./routes');

function createTaskShellHost(deps) {
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
    store = createTaskShellStore(deps.file);
    runtime = createTaskShellRuntime({
      store,
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
    const task = owns(sessionId);
    if (!task) return fallback;
    if (task.adopted) return fallback;
    if (task.unavailable) throw failure('task_shell_state_unavailable');
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
  function owns(id) { return getRuntime().owns(id) || (candidate(id) ? { unavailable: true } : null); }
  function accepts(id) {
    const record = deps.records.get(id);
    return !!record && record.kind === 'chat' && !record.taskExecutionSlot && !record.experimentalMode
      && !['aux', 'gateway', 'commander'].includes(record.type);
  }
  function open(id) {
    const owner = owns(id);
    if (owner?.unavailable) throw failure('task_shell_state_unavailable');
    const rt = getRuntime(), shell = rt.open(id);
    if (owner || deps.records.get(id)?.taskBoundTaskId || deps.loadHistory(id).length) rt.adopt(shell.id, id);
    return rt.view(shell.id);
  }
  async function sendFromSession(id, text, options = {}) {
    const shell = open(id), rt = getRuntime(), task = rt.adopt(shell.id, id);
    const payload = { taskId: task.id, text, clientMsgId: options.clientMsgId || randomUUID(), intent: 'work' };
    if (options.userInputRequestId) {
      const { execution } = await rt.detail(shell.id, task.id);
      Object.assign(payload, { intent: 'answer', requestId: options.userInputRequestId, turnId: execution.turnId });
    }
    const result = await rt.send(shell.id, payload);
    return { ...result, chatId: result.sessionId, targetSessionId: result.sessionId,
      shellId: shell.id, url: `/task-shell.html?shell=${encodeURIComponent(shell.id)}&task=${encodeURIComponent(result.taskId)}` };
  }
  async function sendClientInput(id, message) {
    const shell = open(id), rt = getRuntime(), task = rt.adopt(shell.id, id);
    const intent = message.type === 'cancel' ? 'cancel' : message.userInputRequestId ? 'answer' : 'work';
    const result = await rt.send(shell.id, { text: intent === 'cancel' ? '' : message.text,
      clientMsgId: message.clientMsgId, taskId: task.id, intent,
      ...(message.goal === true ? { goal: true, goalLimits: message.goalLimits } : {}),
      ...(intent !== 'work' ? { turnId: message.turnId, requestId: message.userInputRequestId } : {}) });
    return { ...result, shellId: shell.id, clientMsgId: message.clientMsgId };
  }
  return {
    mountRoutes: app => mountTaskShellRoutes(app, { getRuntime, open }),
    guardAdmission: (id, ...args) => {
      if (!owns(id)) return null;
      const owner = getRuntime();
      return owner?.owns(id) ? owner.guardAdmission(id, ...args) : { ok: false, code: 'task_shell_state_unavailable' };
    },
    accepts, open, owns, sendFromSession, sendClientInput,
    contextSeed,
    close: () => store?.close(),
  };
}

module.exports = { createTaskShellHost };
