function createTaskStateStore(deps) {
  const { persistedSessions, saveBestEffort, chatBroadcast, workspaceBroadcast } = deps;

  const TASK_STATE_DEFAULTS = {
    goal: '', phase: 'idle', startedAt: null, endedAt: null,
    lastSummary: '', lastSummaryAt: null, lastTurnEndedAt: null,
    classifyState: null, pendingDispatches: [],
    classifyHistory: [],
    pendingUserInput: null, userInputSignalVersion: 0, userInputSignalTurnId: null,
    apiError: null,
    // Cancellation envelope. Written only by the classify dispatch, never by a
    // controller: `cancelledAt` is what marks an E as "the user stopped this"
    // rather than "the provider failed", and it is the guard that keeps a late
    // Aux verdict from resurrecting the turn.
    cancelledAt: null, cancelReason: null, cancelSource: null,
    cancelOperationId: null,
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
      // Lets a surface say 「已取消」 instead of 「API 异常」 without inventing a
      // second terminal value: the state is still E, only the reason differs.
      cancelledAt: next.cancelledAt || null,
      cancelReason: next.cancelledAt ? (next.cancelReason || null) : null,
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
