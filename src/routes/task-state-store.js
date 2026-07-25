function createTaskStateStore(deps) {
  const { persistedSessions, saveBestEffort, chatBroadcast, workspaceBroadcast } = deps;

  const TASK_STATE_DEFAULTS = {
    goal: '', phase: 'idle', startedAt: null, endedAt: null,
    lastSummary: '', lastSummaryAt: null, lastTurnEndedAt: null,
    classifyState: null, pendingDispatches: [],
    classifyHistory: [],
    pendingUserInput: null, userInputSignalVersion: 0, userInputSignalTurnId: null,
    apiError: null,
  };

  function getTaskState(persisted) {
    if (!persisted) return { ...TASK_STATE_DEFAULTS };
    const ts = persisted.taskState || {};
    return { ...TASK_STATE_DEFAULTS, ...ts };
  }

  function setTaskState(sessionId, patch, opts = {}) {
    const persisted = persistedSessions.get(sessionId);
    if (!persisted) return null;
    const cur = getTaskState(persisted);
    const next = { ...cur, ...patch };
    persisted.taskState = next;
    if (opts.save !== false) saveBestEffort('runtime.task-state');
    const classifyPayload = {
      type: 'task_state',
      goal: next.goal || '',
      phase: next.phase || 'idle',
      classifyState: next.classifyState || null,
      apiError: next.apiError || null,
    };
    try { chatBroadcast(sessionId, classifyPayload); } catch (_) {}
    if (persisted.dirId) {
      try { workspaceBroadcast(persisted.dirId, { ...classifyPayload, sessionId }); } catch (_) {}
    }
    return next;
  }

  return { getTaskState, setTaskState, TASK_STATE_DEFAULTS };
}

module.exports = { createTaskStateStore };
