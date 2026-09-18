'use strict';

const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { createTaskShellStore } = require('./store');
const { createTaskShellRuntime, failure } = require('./runtime');
const {
  renderLazyContextPrompt, snapshotHistory, renderSnapshots, verifySnapshot,
} = require('./context');
const { mountTaskShellRoutes } = require('./routes');
const { shellHistoryPage, watchShellHistory } = require('./chat-history');
const { createAttributionSettingsFromEnv } = require('./attribution-settings');

function createTaskShellHost(deps) {
  let runtime, store, candidates;
  const workspace = require('./workspace').createShellWorkspaceHost(deps);
  // Automatic attribution (P2) is a host policy switch, not a per-call flag:
  // it lives with the other host settings so a restart can neither widen nor
  // narrow it by accident. The host owns it because it is the only layer that
  // may change task identity.
  //
  // Value only: the .env write belongs to src/routes/host-write.js, which owns
  // the local-only check and the persist→apply→rollback order. Persisting here
  // as well would be a second writer for one setting.
  const attributionSettings = createAttributionSettingsFromEnv();
  const shortText = (value, limit = 500) => {
    if (value == null) return '';
    let text;
    try { text = typeof value === 'string' ? value : JSON.stringify(value); }
    catch (_) { text = String(value); }
    return text.slice(0, limit);
  };
  const publicQueueItem = item => ({
    entryId: shortText(item?.entryId, 160), taskId: shortText(item?.taskId, 160) || null,
    taskRunId: shortText(item?.taskRunId, 160) || null, source: shortText(item?.source, 80) || null,
    workKind: shortText(item?.workKind, 80) || null, state: shortText(item?.state, 40) || null,
    position: Number(item?.position) || null, priority: item?.priority === true,
    admittedAt: Number(item?.admittedAt) || null, text: shortText(item?.text, 32000),
  });
  const publicActive = active => active ? Object.fromEntries([
    'entryId', 'taskId', 'taskRunId', 'source', 'workKind', 'admittedAt', 'claimedAt', 'startedAt', 'attempt',
  ].filter(key => active[key] != null).map(key => [key,
    ['admittedAt', 'claimedAt', 'startedAt', 'attempt'].includes(key) ? Number(active[key]) : shortText(active[key], 160),
  ])) : null;
  function candidate(id) {
    const record = deps.records.get(id);
    return record?.taskBoundTaskId && id === `task-${record.taskBoundTaskId.replace(/^tsk_/, '')}`;
  }
  function currentTurn(sessionId) {
    const record = deps.records.get(sessionId);
    const pending = record?.taskState?.pendingUserInput;
    if (pending && pending.resolved !== true && pending.turnId) return pending.turnId;
    const live = deps.getChatState(sessionId);
    // A queued successor still carries the previous persisted signal ID. It
    // must not expose that ended turn as a valid cancel/steer target.
    return live?.isStreaming || live?.claudeProc ? live._activeTurn?.turnId || null : null;
  }
  // Reading the store must not require the whole runtime: the decision journal
  // is reachable from the classifier before any shell has been resolved.
  function ensureStore() {
    if (!store) store = createTaskShellStore(deps.file);
    return store;
  }
  function getRuntime() {
    if (runtime) return runtime;
    ensureStore();
    candidates = require('../task-routing/candidates').createCandidateStore(store);
    runtime = createTaskShellRuntime({
      store,
      taskShortCode: deps.taskShortCode,
      getDirectory: id => deps.directories?.get(id),
      taskDirectory: task => require('../task-board/core').taskDirId(deps.getTaskBoard().getBoard(), task),
      validateTaskRuntime: (dirId, config) => deps.createSessionRecord({ ...config, dir: deps.directories.get(dirId), kind: 'chat', validateOnly: true }),
      unifiedAdmission: true,
      taskFirst: true, defaultTaskRuntime: deps.defaultTaskRuntime,
      getRecord: id => deps.records.get(id),
      onStateTargetChanged: id => deps.onStateTargetChanged?.(id),
      onSeparationChanged: id => deps.onSeparationChanged?.(id),
      onRelationChanged: id => deps.onRelationChanged?.(id),
      // Deleting a shell also drops the re-attribution journal rows it owns;
      // task-operations owns the overlay keys, so it does that half.
      purgeShellAttribution: shellId => taskOperations().purgeShell(shellId),
      getHistory: deps.loadHistory,
      // Read-only view of manual re-attribution. Missing overlay ports (tests,
      // older hosts) simply keep the canonical annotation.
      applyAttributionOverlay: messages => {
        try { return taskOperations().overlay.apply(messages); } catch (_) { return messages; }
      },
      getLiveState: deps.getChatState,
      getExecution: async id => {
        const host = deps.getWorkHost();
        const scheduler = deps.getScheduler();
        const record = deps.records.get(id);
        if (!host || !scheduler || !record) return { busy: true, status: 'unavailable' };
        const state = await scheduler.status(id);
        const pending = record.taskState?.pendingUserInput;
        const taskState = record.taskState || {};
        const classifyHistory = (Array.isArray(taskState.classifyHistory) ? taskState.classifyHistory : [])
          .slice(-20).map(item => ({ at: Number(item?.at) || null,
            taskId: shortText(item?.taskId, 160) || null, goal: shortText(item?.goal, 500),
            phase: shortText(item?.phase, 80), state: shortText(item?.state, 8) || null,
            error: item?.error === true, evidence: shortText(item?.evidence, 240) || null }));
        let events = [];
        try {
          const recent = deps.recentEvents?.(record.dirId);
          events = (Array.isArray(recent) ? recent : [])
            .filter(event => event?.sessionId === id).slice(-30)
            .map(event => ({ ts: Number(event?.ts) || null, type: shortText(event?.type, 80) || 'event',
              detail: shortText(event?.detail, 500) }));
        } catch (_) {}
        const busy = !!state.active || !!state.queued?.length || !!(pending && !pending.resolved)
          || !['idle', 'assessing'].includes(state.state) || host.isRunActive(id);
        return { busy, status: host.getRunState(id), completed: !busy && state.classifyState === 'D',
          turnId: currentTurn(id), pending: pending && !pending.resolved ? pending : null,
          queue: { state: shortText(state.state, 40) || 'idle', freezeReason: shortText(state.freezeReason, 160) || null,
            classifyState: shortText(state.classifyState, 8) || null, active: publicActive(state.active),
            queued: (Array.isArray(state.queued) ? state.queued : []).map(publicQueueItem),
            updatedAt: Number(state.updatedAt) || null },
          classify: { state: shortText(taskState.classifyState || state.classifyState, 8) || null,
            goal: shortText(taskState.goal, 500), phase: shortText(taskState.phase, 80),
            updatedAt: Number(taskState.classifyUpdatedAt) || null, history: classifyHistory },
          events };
      },
      getTask: id => deps.getTaskBoard?.()?.getBoard?.().tasks?.[id] || null,
      isDeletedTask: id => deps.getTaskBoard?.()?.getBoard?.().deletedTaskIds?.includes(id),
      isTaskLifecycleBusy: id => deps.getTaskBoard?.()?.isTaskLifecycleBusy?.(id),
      prepareExecution: workspace.prepareExecution, captureForkBaseline: workspace.captureForkBaseline,
      captureIndependentBaseline: workspace.captureIndependentBaseline,
      // Cancelling a prepared-but-unused execution reclaims only what this
      // request created: a planned record with no history and no live work.
      // Anything else is left to the user and reported as kept.
      discardExecution: async (sessionId, { taskId } = {}) => {
        const record = deps.records.get(sessionId);
        if (!record || record.taskBoundTaskId !== taskId) return { ok: false, code: 'not_created_here' };
        if ((deps.loadHistory?.(sessionId) || []).length) return { ok: false, code: 'has_history' };
        const dir = deps.directories.get(record.dirId);
        if (record.worktreePath && record.branch && dir) {
          await require('../git/service').gitWorktreeRollbackCreate(dir.path, record.worktreePath, record.branch, { sessionId });
        }
        deps.persistRecords('task-shell.independent-cancel', map => map.delete(sessionId));
        deps.resetChatState?.(sessionId);
        return { ok: true };
      },
      deliveryEvidence: (id, turnId) => deps.getWorkspaceAdmission?.()?.deliveryEvidence(id, turnId),
      verifyDeliveryBaseline: (integration, id) => {
        const record = deps.records.get(id), cwd = record && deps.directories.get(record.dirId)?.path;
        return deps.getWorkspaceAdmission?.()?.verifyBaseline(integration, cwd);
      },
      withSeparationBarrier: (input, work) => deps.getWorkspaceAdmission?.()?.withSeparationBarrier(input, work),
      recordSeparationApplication: input => deps.getWorkspaceAdmission?.()?.recordSeparationApplication(input),
      createExecution: async (task, source) => {
        const dir = deps.directories.get(task.dirId);
        if (!dir) throw failure('directory_missing');
        const owner = runtime.ownerOf(task);
        const result = await deps.createSessionRecord({ ...source, dir, id: task.sessionId,
          kind: 'chat', label: task.title, taskBoundTaskId: task.id, autoCommit: false,
          workspaceOwnerSessionId: owner && !owner.standalone && !task.taskFirst ? owner.sourceSessionId : null, workspaceBaseCommit: task.forkBaseline?.commit || null,
          persistence: 'required', persistenceSource: 'task-shell.create' });
        if (!result.ok) return result;
        const record = deps.records.get(task.sessionId);
        if (record.taskBoundTaskId !== task.id || record.dirId !== task.dirId || record.autoCommit !== false) throw failure('execution_identity_conflict');
        if (record.workspaceState === 'planned') return { ok: true, baseline: null };
        const git = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: record.worktreePath, timeout: 15000 });
        return { ok: true, baseline: { commit: git.stdout.trim(), branch: record.branch, baseBranch: dir.baseBranch, worktreePath: record.worktreePath } };
      },
      indexTask: task => deps.getTaskBoard().registerShellTask(task),
      taskGraphContext: deps.taskGraphContext,
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
    if (task.unavailable) throw failure('task_shell_state_unavailable');
    const snapshots = isFirstTurn && !task.adopted ? task.snapshotIds.map(id => {
      const value = store.get('snapshot', id);
      if (!verifySnapshot(value, id)) throw failure('snapshot_unverified');
      return value;
    }) : [];
    if (isFirstTurn && !task.adopted) {
      const own = snapshotHistory(task.id, deps.loadHistory(sessionId));
      if (own.messages.length) snapshots.push(own);
    }
    return `${fallback || renderSnapshots(snapshots)}${renderLazyContextPrompt(task.id)}`;
  }
  function owns(id) { return getRuntime().owns(id) || (candidate(id) ? { unavailable: true } : null); }
  function accepts(id) {
    const record = deps.records.get(id);
    return !!record && record.kind === 'chat' && !record.taskExecutionSlot && !record.experimentalMode
      && !['aux', 'gateway'].includes(record.type);
  }
  function open(id) {
    const owner = owns(id);
    if (owner?.unavailable) throw failure('task_shell_state_unavailable');
    const rt = getRuntime(), shell = rt.open(id);
    rt.adopt(shell.id, id);
    return rt.view(shell.id);
  }
  async function sendFromSession(id, text, options = {}) {
    const shell = open(id), rt = getRuntime();
    const payload = { text, clientMsgId: options.clientMsgId || randomUUID(), intent: 'work' };
    if (options.userInputRequestId) {
      const { execution } = await rt.detail(shell.id, shell.currentTaskId);
      Object.assign(payload, { taskId: shell.currentTaskId, intent: 'answer', requestId: options.userInputRequestId, turnId: execution.turnId });
    }
    const result = options.taskId && !options.userInputRequestId
      ? await rt.sendExplicit(shell.id, payload, {
        taskId: options.taskId,
        taskStart: options.taskStart === true,
        taskSource: options.taskSource,
        taskText: options.taskText || text,
      })
      : await rt.send(shell.id, payload);
    return { ...result, chatId: result.sessionId, targetSessionId: result.sessionId,
      shellId: shell.id, url: `/task-shell.html?shell=${encodeURIComponent(shell.id)}&task=${encodeURIComponent(result.taskId)}` };
  }
  async function sendClientInput(id, message, shellId = null) {
    const rt = getRuntime();
    if (shellId) rt.chatScope(shellId, id);
    const shell = shellId ? rt.view(shellId) : open(id);
    const intent = message.type === 'cancel' ? 'cancel' : message.userInputRequestId ? 'answer' : 'work';
    const result = await rt.send(shell.id, { text: intent === 'cancel' ? '' : message.text,
      clientMsgId: message.clientMsgId, taskId: intent === 'work' ? null : rt.owns(id)?.id || shell.currentTaskId, intent,
      ...(message.goal === true ? { goal: true, goalLimits: message.goalLimits } : {}),
      ...(intent !== 'work' ? { turnId: message.turnId, requestId: message.userInputRequestId } : {}) });
    return { ...result, shellId: shell.id, clientMsgId: message.clientMsgId };
  }
  async function sendTaskMessage(id, text, options = {}) {
    const rt = getRuntime();
    const entry = await rt.bindPlannedTask(id);
    if (entry.readOnly) throw failure('task_read_only', 'The fixed Air task is archived or read-only', 409);
    if (!entry.ownerShellId) throw failure('task_owner_missing', 'The fixed Air task has no owning task shell', 409);
    return rt.sendExplicit(entry.ownerShellId, {
      text: String(text || ''),
      clientMsgId: options.clientMsgId || randomUUID(),
      intent: 'work',
    }, {
      taskId: id,
      taskStart: false,
      taskSource: options.source || 'task-shell',
      taskText: options.taskText || entry.task.title,
    });
  }
  function taskSummary(id) {
    const rt = getRuntime();
    const task = rt.listTasks().find(value => value.id === id);
    if (!task) return null;
    const lifecycle = deps.getTaskBoard?.()?.getBoard?.().tasks?.[id] || task;
    const record = deps.records.get(task.sessionId);
    const access = rt.taskAccess(task);
    const source = { ...(task.runtime || {}), ...(record || {}) };
    const runtime = Object.fromEntries(['cli', 'model', 'provider', 'providerSelection', 'effort', 'agent']
      .filter(key => source[key] !== undefined)
      .map(key => [key, source[key]]));
    return { id, dirId: task.dirId, title: lifecycle.title || task.title, status: lifecycle.status || access.status,
      readOnly: access.readOnly, sessionId: task.sessionId, runtime };
  }
  // Full-history task directory for the conversation index. Metadata only: it
  // returns task identity and message anchors, never message bodies, and it
  // never selects a routing target.
  function taskIndex(id, options = {}) {
    const runtime = getRuntime();
    const scope = runtime.chatScope(id);
    const tasks = runtime.listTasks().filter(task => scope.sessionIds.includes(task.sessionId));
    return require('./task-index').collectTaskIndex(scope, deps.displayHistory || deps.loadHistory, deps.getChatState, {
      tasks,
      codeFor: deps.taskShortCode,
      includeEmpty: options.includeEmpty === true,
      overlay: taskOperations().overlay.apply,
      // Capabilities are advisory read-model hints. Every write still re-checks
      // access, lifecycle and ownership on the server.
      capabilitiesOf: task => {
        const access = runtime.taskAccess(task) || {};
        const writable = access.readOnly !== true && task?.ready !== false;
        return { canDetach: writable, canSelectTarget: writable };
      },
    });
  }
  // Manual re-attribution (P1): a durable operation journal plus a read-only
  // overlay. Nothing here creates an execution, moves code or re-routes a turn.
  function taskOperations() {
    if (taskOperationsRuntime) return taskOperationsRuntime;
    const runtime = getRuntime();
    taskOperationsRuntime = require('./task-operations').createTaskOperations({
      store,
      revisionOf: scope => taskIndex(scope.shellId).scopeRevision,
      isTurnBusy: (sessionId, turnId) => {
        const record = deps.records.get(sessionId);
        const pending = record?.taskState?.pendingUserInput;
        if (pending && pending.resolved !== true && pending.turnId === turnId) return true;
        return currentTurn(sessionId) === turnId;
      },
      resolveTarget: async (scope, taskId) => {
        const task = store.get('task', taskId);
        if (!task) throw Object.assign(new Error('task_not_found'), { code: 'task_not_found', status: 404 });
        if (!store.get('link', `${scope.shellId}:${taskId}`)) {
          throw Object.assign(new Error('task_not_linked'), { code: 'task_not_linked', status: 403 });
        }
        runtime.assertBoardWritable?.(taskId);
        return task;
      },
      effectiveTaskOf: (sessionId, turnId) => {
        const messages = (deps.displayHistory || deps.loadHistory)(sessionId) || [];
        const message = messages.find(value => value?.turnId === turnId);
        if (!message) return null;
        return taskOperationsRuntime.overlay.get(sessionId, turnId)?.taskId ?? message.taskId ?? null;
      },
      taskTitle: taskId => store.get('task', taskId)?.title || null,
      // 整段批量整理（P4）：区间由服务端按会话内轮次顺序展开，客户端无需先
      // 把没加载的历史拉到页面上，也无法引用不存在的轮次。
      turnOrderOf: sessionId => (deps.displayHistory || deps.loadHistory)(sessionId)
        .filter(message => message?.turnId).map(message => message.turnId),
    });
    return taskOperationsRuntime;
  }
  let taskOperationsRuntime = null;
  // Automatic attribution (P2): the classifier's verdict is journalled, and the
  // mode decides whether the host is allowed to act on it. The journal and the
  // manual overlay share one store and one write path, so "who moved this turn"
  // is always answerable from the same place.
  function attributionDecisions() {
    if (attributionDecisionsRuntime) return attributionDecisionsRuntime;
    ensureStore();
    attributionDecisionsRuntime = require('./attribution-decisions').createAttributionDecisions({
      store,
      operations: taskOperations(),
      scopeOf: shellId => getRuntime().chatScope(shellId),
      settleAttribution: (sessionId, receiptId, attribution) =>
        getRuntime().settleAttribution(sessionId, receiptId, attribution),
      restoreSettledCursor: (shellId, options) => getRuntime().restoreSettledCursor(shellId, options),
      isTurnBusy: (sessionId, turnId) => {
        const record = deps.records.get(sessionId);
        const pending = record?.taskState?.pendingUserInput;
        if (pending && pending.resolved !== true && pending.turnId === turnId) return true;
        return currentTurn(sessionId) === turnId;
      },
      taskTitle: taskId => store.get('task', taskId)?.title || null,
      onAttributionChanged: id => deps.onAttributionChanged?.(id),
    });
    return attributionDecisionsRuntime;
  }
  let attributionDecisionsRuntime = null;
  // Manual re-attribution keeps an audit trail, so its rows outlive the change
  // by a retention window instead of being deleted with the turn. That window is
  // only real if something enforces it: this is the only caller of
  // `expireOlderThan`, and it runs once at mount and then daily.
  let sweepTimer = null;
  function sweepAttributionLog() {
    const sweep = () => {
      try { taskOperations().expireOlderThan(); }
      catch (error) { console.warn('[task-attribution] sweep failed', error.message); }
    };
    sweep();
    if (sweepTimer) return;
    sweepTimer = setInterval(sweep, 24 * 60 * 60 * 1000);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  }
  return {
    mountRoutes: app => {
      mountTaskShellRoutes(app, { getRuntime, open,
        taskEntry: id => getRuntime().bindPlannedTask(id),
        taskIndex: (id, options) => taskIndex(id, options),
        taskOperations: () => taskOperations(),
    attributionDecisions: () => attributionDecisions(),
        relations: () => getRuntime().relations,
        independent: () => getRuntime().independent,
        artifacts: async id => {
          const { collectTaskArtifacts, artifactFileExists } = require('./artifacts');
          return collectTaskArtifacts(await getRuntime().taskEntry(id), require('../docs-registry').list(), artifactFileExists);
        },
        history: (id, options) => shellHistoryPage(getRuntime().chatScope(id),
          deps.displayHistory || deps.loadHistory, deps.getChatState, { ...options, overlay: taskOperations().overlay.apply }) });
      attributionSettings.mount(app);
      // 独立继续的等待队列由服务端推进：重启后恢复，不依赖页面开着。
      getRuntime().independent.start();
      // 归属操作日志的保留期清理同样由服务端推进，页面关着也生效。
      sweepAttributionLog();
    },
    taskIndex,
    taskOperations,
    attributionSettings: () => attributionSettings,
    attributionDecisions,
    chatScope: (id, sessionId) => getRuntime().chatScope(id, sessionId),
    chatHistory: (id, options) => shellHistoryPage(getRuntime().chatScope(id, options.activeSessionId),
      deps.displayHistory || deps.loadHistory, deps.getChatState, { ...options, overlay: taskOperations().overlay.apply }),
    watchChatHistory: (id, activeSessionId, emit) => watchShellHistory(getRuntime().chatScope(id, activeSessionId), activeSessionId,
      { subscribe: deps.subscribeChat, readMessages: deps.displayHistory || deps.loadHistory, getState: deps.getChatState, emit }),
    guardAdmission: (id, text, options = {}) => {
      const board = deps.getTaskBoard?.()?.getBoard?.();
      for (const taskId of [options.taskId, deps.records.get(id)?.taskBoundTaskId].filter(Boolean)) {
        const task = board && require('../task-board/core').resolveTask(board, taskId);
        const code = board?.deletedTaskIds?.includes(taskId) ? 'task_deleted' : task?.deleting ? 'task_deleting'
          : task?.status === 'archived' ? 'task_archived' : deps.getTaskBoard?.()?.isTaskLifecycleBusy?.(taskId) ? 'task_busy' : null;
        if (code) return { ok: false, code };
      }
      if (!owns(id)) return null;
      const owner = getRuntime();
      return owner?.owns(id) ? owner.guardAdmission(id, text, options) : { ok: false, code: 'task_shell_state_unavailable' };
    },
    accepts, open, owns, sendFromSession, sendClientInput, sendTaskMessage, taskSummary,
    migrateTaskSessions: async () => {
      const rt = getRuntime(), result = await rt.migrateTaskSessions([...deps.records.values()]);
      const ready = new Set(result.migrated);
      const bindings = rt.listTasks().filter(task => ready.has(task.id) && deps.records.has(task.sessionId)
        && !deps.records.get(task.sessionId).taskBoundTaskId);
      if (bindings.length) deps.persistRecords('task-first.bind-executions', records => {
        for (const task of bindings) {
          const record = records.get(task.sessionId);
          if (record && !record.taskBoundTaskId) record.taskBoundTaskId = task.id;
        }
      });
      return result;
    },
    listTasks: () => getRuntime().listTasks(),
    taskGraphData: () => getRuntime().taskGraphData(),
    getSnapshot: id => getRuntime().getSnapshot(id),
    artifactTaskId: id => getRuntime().owns(id)?.id || deps.records.get(id)?.taskBoundTaskId || null,
    stateTarget: id => getRuntime().stateTarget(id), stateSources: id => getRuntime().stateSources(id),
    purgeTasks: ids => getRuntime().purgeTasks(ids),
    recentTasks: (id, receiptId) => getRuntime().recentTasks(id, receiptId),
    refillContext: (id, options) => getRuntime().refillContext(id, options),
    contextTrace: (id, receiptId, options) => getRuntime().contextTrace(id, receiptId, options),
    proposeSeparation: (id, receiptId, result) => getRuntime().separation.propose(id, receiptId, result),
    taskSeparation: id => getRuntime().separation.forTask(id),
    proposeAttribution: (id, receiptId, result) => { getRuntime(); return candidates.propose(id, receiptId, result); },
    attributionCandidate: id => { getRuntime(); return candidates.latest(id); },
    // The classifier reports what it saw; the mode decides what may happen.
    // Returning the planned action lets the caller stop before touching
    // identity, which is what makes shadow and suggest genuinely non-mutating.
    recordAttributionDecision: (id, receiptId, result = {}) => {
      ensureStore();
      return attributionDecisions().record(id, receiptId, {
        ...result, mode: attributionSettings.getMode(),
      });
    },
    settleAttribution: (id, receiptId, result) => getRuntime().settleAttribution(id, receiptId, result),
    createTask: input => getRuntime().createStandalone(input),
    roleBindings: id => getRuntime().roles.current(id), updateRoleBindings: (id, input) => getRuntime().roles.update(id, input),
    taskAccess: task => getRuntime().taskAccess(task), taskEntry: id => getRuntime().bindPlannedTask(id),
    relocateTask: (taskId, dirId, options) => getRuntime().relocateTask(taskId, dirId, options),
    workspaceGroup: workspace.group, isWorkspaceBusy: workspace.busy, contextSeed,
    prepareContext: (id, options) => owns(id) ? getRuntime().prepareContext(id, options) : null,
    contextSent: (...args) => getRuntime().contextSent(...args),
    contextComplete: (...args) => getRuntime().contextComplete(...args),
    close: () => {
      try { runtime?.independent?.stop(); } catch (_) {}
      if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
      store?.close();
    },
  };
}

module.exports = { createTaskShellHost };
