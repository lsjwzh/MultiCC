'use strict';

// Scripted dependency world for the session-admin retirement differential
// (docs/rust-migration/differential/session-admin.js).
//
// The retired routes (tests/helpers/legacy-session-admin-routes.js) and the
// surviving host port (src/routes/session-admin-host.js) both bottom out in the
// same handful of runtime facts: the session/directory Maps, the classify task
// state, the chat runtimes, the transcript and the aux queue. This module turns
// one plain JSON world into that dependency bag, so the frozen oracle and the
// front door's Node child read one world.
//
// Everything here is deterministic: no clock, no randomness, no filesystem and
// no network. `apply(world)` swaps the world between corpus cases while the
// runtime keeps holding the same Maps (both compositions capture `deps` once).


const SYSTEM_PREFIX = '\u{1F507}';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Verbatim copy of the rule in src/classify/state-machine.js. */
function isInjectedOrJunkGoal(goal) {
  const g = String(goal || '').trim();
  if (!g) return true;
  return g.startsWith(SYSTEM_PREFIX) || g.startsWith('<') || g.startsWith('"<');
}

function buildDeps(initialWorld = {}, contract = require('../../src/native/binding').getApiContract()) {
  const { createErrorDto, withApiMeta } = contract;
  const records = new Map();
  const directories = new Map();
  const terminalSessions = new Map();
  const chatSessions = new Map();
  const state = { world: initialWorld, taskStates: new Map(), chats: new Map() };
  const effects = { classified: [], dispatched: [], writes: [] };

  function world() {
    return state.world || {};
  }

  function chats() {
    return world().chatSessions || {};
  }

  function apply(next) {
    state.world = next || {};
    const w = world();
    records.clear();
    for (const record of w.records || []) records.set(record.id, record);
    directories.clear();
    for (const dir of w.directories || []) directories.set(dir.id, dir);
    terminalSessions.clear();
    // `readSessionRuntime` reads cwd/createdAt/lastActivity/clients off the
    // terminal entry, so the world has to supply a real-shaped one.
    for (const [id, spec] of Object.entries(w.terminalSessions || {})) {
      const value = spec || {};
      terminalSessions.set(id, {
        cwd: value.cwd || `/repo/wt/${id}`,
        createdAt: value.createdAt === undefined ? 1700000000000 : value.createdAt,
        lastActivity: value.lastActivity === undefined ? null : value.lastActivity,
        clients: new Set(Array.from(
          { length: Number(value.clients) || 0 }, (_, index) => `t${index}`)),
      });
    }
    chatSessions.clear();
    state.taskStates.clear();
    for (const [id, task] of Object.entries(w.taskStates || {})) {
      const copy = clone(task);
      state.taskStates.set(id, copy);
      const record = records.get(id);
      // `readSessionRuntime`/`getInvalidSession` read the record, not the state.
      if (record) record.taskState = copy;
    }
    for (const [id, spec] of Object.entries(chats())) {
      chatSessions.set(id, {
        clients: new Set(Array.from({ length: Number(spec.clients) || 0 }, (_, index) => `c${index}`)),
        isStreaming: spec.streaming === true,
        currentAssistantText: spec.currentAssistantText,
      });
    }
  }

  function getTaskState(record) {
    if (!record || !record.id) return {};
    const task = state.taskStates.get(record.id);
    return task ? { ...task } : {};
  }

  function setTaskState(id, patch) {
    const current = state.taskStates.get(id) || {};
    const next = { ...current, ...patch };
    state.taskStates.set(id, next);
    const record = records.get(id);
    if (record) record.taskState = next;
    effects.writes.push({
      id,
      goalState: patch.goalState === undefined ? null : patch.goalState,
      manualAt: typeof patch.goalStateManualAt === 'number',
    });
    return next;
  }

  function history(id) {
    const w = world();
    if ((w.historyThrows || []).includes(id)) throw new Error('scripted transcript failure');
    return clone((w.histories || {})[id]) || [];
  }

  function classifyChat(chat, id, options) {
    effects.classified.push({
      id,
      manual: !!(options && options.manual === true),
      text: chat && typeof chat.currentAssistantText === 'string'
        ? chat.currentAssistantText.slice(0, 60) : null,
    });
  }

  function dispatchStateAction(action, context = {}) {
    effects.dispatched.push({
      state: action && action.state,
      goal: action && action.goal,
      phase: action && action.phase,
      sessionName: context.sessionName,
      sessionId: context.sessionId,
      hasCs: !!context.cs,
      isTerminal: context.isTerminal === true,
    });
  }

  function auxRuntime() {
    const spec = world().aux;
    if (spec === 'none') return null;
    const aux = spec || {};
    const clients = Number(aux.clients) || 0;
    return {
      id: 'aux-1',
      queue: {
        clients: new Set(Array.from({ length: clients }, (_, index) => `a${index}`)),
        processing: aux.processing === true,
        lastTaskTime: aux.lastTaskTime === undefined ? null : aux.lastTaskTime,
        getStatus: () => aux.status || 'idle',
      },
    };
  }

  let deps = null;

  function syncSetTaskState() {
    if (!deps) return;
    // The retired /mark-goal-achieved handler answered 501 when this dependency
    // was absent; the world can remove it per case.
    if (world().noSetTaskState) deps.setTaskState = undefined;
    else deps.setTaskState = setTaskState;
  }

  deps = {
    records,
    terminalSessions,
    chatSessions,
    directories,
    resolveStateTarget: id => {
      const target = (world().stateTargets || {})[id];
      return target ? { executionSessionId: target } : undefined;
    },
    cwdForSession: record => record.cwd || `/repo/wt/${record.id}`,
    chatLastActivity: id => {
      const table = world().chatLastActivity || {};
      return table[id] === undefined ? null : table[id];
    },
    effectiveSessionModel: record => record.model || 'default-model',
    effectiveSessionEffort: record => record.effort || 'medium',
    // The retired presenters spread `runtime.subagent` straight into the DTO,
    // so "no subagent" has to be null rather than an absent key.
    serializeSubagent: value => (value === undefined ? null : value),
    mergeStateCached: (dir, record) => {
      const table = world().mergeStates || {};
      return table[record.id] === undefined ? null : table[record.id];
    },
    cliStateSummary: record => clone((world().cliStates || {})[record.id]) || [],
    cliHandoffSummary: record => clone((world().handoffs || {})[record.id]) || null,
    cliAvailabilitySummary: () => clone(world().cliAvailability) || [],
    sessionProviderBaseUrl: record => (world().providerBaseUrls || {})[record.id] || null,
    getInvalidSession: id => (world().invalidSessions || {})[id],
    getWorkspaceStatus: id => clone((world().workspaceStatus || {})[id]),
    getSessionSummary: id => clone((world().sessionSummaries || {})[id]),
    pendingNotesFor: id => clone((world().pendingNotes || {})[id]) || [],
    getAuxRuntime: () => auxRuntime(),
    loadChatHistory: id => history(id),
    viewChatHistory: id => history(id),
    isInjectedOrJunkGoal,
    buildClassifySystemPrompt: () => '',
    buildClassifyConversation: () => [],
    parseClassifyResult: () => null,
    dispatchStateAction,
    runClassifyNow: classifyChat,
    getTaskState,
    setTaskState,
    createErrorDto,
    requestContext: () => ({ requestId: 'diff-req-1', correlationId: 'diff-req-1' }),
    withApiMeta,
  };

  const originalApply = apply;
  apply = function applyWorld(next) {
    originalApply(next);
    syncSetTaskState();
  };

  apply(initialWorld);

  return { deps, apply, effects, world };
}

module.exports = { buildDeps, isInjectedOrJunkGoal };
