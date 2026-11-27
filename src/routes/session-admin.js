'use strict';

const { createSessionQueryService } = require('../session/query-service');
const { createWorkspaceService } = require('../session/workspace-service');
const { classifyDisplay } = require('../native/binding').classifyVocab;
const { taskShortCode } = require('../native/task-domain');
const { auxVerdictStaleness } = require('../native/binding');
const { markTaskAchievedFacts, markTaskAchievedWrite } = require('./task-goal');
const { mountUnattendedRoutes } = require('./orchestration-host');
const {
  assistantText,
  latestAssistant,
  latestStringAssistant,
  mountSessionAdminHostRoute,
} = require('./session-admin-host');

function assertFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`[session-admin] ${name} must be a function`);
}

function assertMapLike(value, name) {
  if (!value || typeof value.get !== 'function') {
    throw new TypeError(`[session-admin] ${name} must expose get()`);
  }
}

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('[session-admin] dependencies are required');
  for (const name of ['records', 'terminalSessions', 'chatSessions', 'directories']) {
    assertMapLike(deps[name], name);
  }
  if (typeof deps.records.values !== 'function') {
    throw new TypeError('[session-admin] records must expose values()');
  }
  if (typeof deps.directories.values !== 'function') {
    throw new TypeError('[session-admin] directories must expose values()');
  }
  for (const name of [
    'cwdForSession', 'chatLastActivity', 'effectiveSessionModel', 'effectiveSessionEffort',
    'serializeSubagent', 'mergeStateCached', 'cliStateSummary', 'cliHandoffSummary',
    'cliAvailabilitySummary', 'sessionProviderBaseUrl',
    'getInvalidSession', 'getWorkspaceStatus',
    'getSessionSummary', 'getTaskState', 'pendingNotesFor', 'getAuxRuntime',
    'dispatchStateAction', 'runClassifyNow',
  ]) assertFunction(deps[name], name);
  // Transcript reads moved to the host port; the legacy cloning loader is still
  // accepted for hosts that never wired the uncopied view.
  if (typeof deps.viewChatHistory !== 'function' && typeof deps.loadChatHistory !== 'function') {
    throw new TypeError('[session-admin] dependency missing: viewChatHistory');
  }
  return deps;
}

function createSessionAdminRuntime(rawDeps) {
  const deps = assertDependencies(rawDeps);
  // A judgement Aux has stopped revising is still the best description there
  // is, but it must not be presented as current (see
  // native/addon/src/aux_verdict_health.rs). Every presenter below whitelists its
  // fields, so each one has to pass the pair through explicitly.
  function verdictFreshness(view) {
    return {
      auxUnhealthy: view?.auxUnhealthy === true,
      auxUnhealthySince: view?.auxUnhealthySince || null,
    };
  }

  function stateSource(id) {
    return deps.resolveStateTarget?.(id) || { executionSessionId: id };
  }
  function sessionView(id) {
    const target = stateSource(id);
    const record = deps.records.get(target.executionSessionId);
    const task = deps.getTaskState(record);
    const status = deps.getWorkspaceStatus(target.executionSessionId) || {
      status: 'idle', lastActivity: 0, runStartedAt: null, runEndedAt: null,
    };
    const summary = deps.getSessionSummary(target.executionSessionId);
    return { ...status, id, stateSource: target,
      status: task.classifyState ? classifyDisplay(task.classifyState).cardStatus : status.status,
      currentFile: status.currentFile || null, pendingNotes: deps.pendingNotesFor(id).length,
      summary: summary?.summary || null, summaryAt: summary?.ts || null,
      classifyState: task.classifyState || null, goal: task.goal || '',
      taskShortCode: taskShortCode(task.taskId), phase: task.phase || 'idle',
      // Whether this judgement is still being revised. See
      // native/addon/src/aux_verdict_health.rs — a frozen verdict is still the best
      // description available, it just stops claiming to be current.
      ...auxVerdictStaleness() };
  }

  function readSessionRuntime(id, record, { includeMergeState = true } = {}) {
    const terminal = deps.terminalSessions.get(id);
    const target = stateSource(id);
    const chat = deps.chatSessions.get(target.executionSessionId);
    const kind = record.kind || 'terminal';
    const isChat = kind === 'chat';
    const chatActive = !!chat && (chat.clients.size > 0 || chat.isStreaming);
    const chatActivity = isChat ? deps.chatLastActivity(target.executionSessionId, chat) : null;
    return {
      cwd: isChat ? deps.cwdForSession(record) : (terminal ? terminal.cwd : record.cwd),
      sessionCwd: deps.cwdForSession(record),
      createdAt: terminal ? terminal.createdAt : record.createdAt,
      terminalActive: !!terminal,
      terminalLastActivity: terminal ? terminal.lastActivity : null,
      terminalClients: terminal ? terminal.clients.size : 0,
      chatActive,
      chatLastActivity: chatActivity,
      chatClients: chat ? chat.clients.size : 0,
      effectiveModel: deps.effectiveSessionModel(record),
      effectiveEffort: deps.effectiveSessionEffort(record),
      subagent: deps.serializeSubagent(record.subagent),
      lastActivity: isChat ? chatActivity : (terminal ? terminal.lastActivity : null),
      clients: isChat ? (chat ? chat.clients.size : 0) : (terminal ? terminal.clients.size : 0),
      active: isChat ? chatActive : !!terminal,
      mergeState: includeMergeState && record.dirId
        ? deps.mergeStateCached(deps.directories.get(record.dirId), record)
        : null,
    };
  }

  const recordsPort = {
    list: () => deps.records.values(),
    get: id => deps.records.get(id),
  };
  const sessionQuery = createSessionQueryService({
    records: recordsPort,
    runtime: {
      read: (id, record) => readSessionRuntime(id, record),
    },
  });

  const sessionWorkspace = createWorkspaceService({
    sessionQuery,
    directories: {
      list: () => deps.directories.values(),
      get: id => deps.directories.get(id),
    },
    workspaceFacts: {
      read: sessionView,
    },
  });

  function legacyWorkspacePresenter({ session, facts }) {
    const record = session.record;
    const runtime = session.runtime;
    return {
      id: record.id,
      label: record.label || null,
      cli: record.cli || 'claude',
      kind: record.kind || 'terminal',
      branch: record.branch || null,
      invalid: deps.getInvalidSession(record.id) || null,
      status: facts.status,
      stateSource: facts.stateSource,
      currentFile: facts.currentFile || null,
      lastActivity: facts.lastActivity,
      runStartedAt: facts.runStartedAt || null,
      runEndedAt: facts.runEndedAt || null,
      clients: runtime.clients || 0,
      pendingNotes: facts.pendingNotes,
      mergeState: runtime.mergeState,
      summary: facts.summary || null,
      summaryTs: facts.summaryAt || null,
      classifyState: facts.classifyState || null,
      goal: facts.goal || '',
      taskShortCode: facts.taskShortCode || '',
      phase: facts.phase || 'idle',
      ...verdictFreshness(facts),
    };
  }

  function workspaceSnapshot(dirId) {
    const snapshot = sessionWorkspace.snapshot(dirId, { presenter: legacyWorkspacePresenter });
    return snapshot ? snapshot.sessions : [];
  }

  function mountRoutes(app, { unattendedApp = null } = {}) {
    if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
      throw new TypeError('[session-admin] Express app is required');
    }

    // 13 条公开路由（/api/v1/sessions*、/api/sessions*、/api/directories/:id/*、
    // /api/reclassify-all、/api/debug/classify*）已由 Rust 前门独占；这里只把
    // 进程内事实与副作用暴露成回环宿主端口。
    mountSessionAdminHostRoute(app, {
      deps,
      sessionView,
      readSessionRuntime,
    });
    // Unattended mode's per-session GET/POST are owned by the Rust front door
    // (native/gateway/src/app/orchestration_routes.rs); they are mounted only on
    // the orchestration host port's capture app, never on the public app. The
    // supervisor host is composed later, so it is resolved lazily through
    // deps.getUnattended.
    if (unattendedApp) mountUnattendedRoutes(unattendedApp, deps);
  }

  return Object.freeze({
    mountRoutes,
    sessionQuery,
    sessionWorkspace,
    workspaceSnapshot,
    sessionView,
    // Air 的「标记达成」：语义与 /mark-goal-achieved 相同，只是入口给的是 taskId。
    // 路由本身已由 Rust 前门独占（native/gateway/src/app/task_routes.rs）；eligibility
    // 阶梯也在 Rust，这里只把 deps 里真正的状态 writer（server.js 的 setTaskState）
    // 暴露成两个端口供回环宿主端口调用。
    taskGoalPorts: Object.freeze({
      facts: taskId => markTaskAchievedFacts(deps, taskId),
      write: (taskId, sessionId) => markTaskAchievedWrite(deps, taskId, sessionId),
    }),
  });
}

module.exports = {
  assistantText,
  latestAssistant,
  latestStringAssistant,
  createSessionAdminRuntime,
};
