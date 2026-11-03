// The wire payload is shared with the connect seed and server.js's legacy
// broadcast — see src/chat/task-state-payload.js; the three producers must
// never drift (a reopened page once lost the last API error to that drift).
const { taskStatePayload } = require('../chat/task-state-payload');

function createTaskStateStore(deps) {
  const { persistedSessions, saveBestEffort, chatBroadcast, workspaceBroadcast } = deps;

  const TASK_STATE_DEFAULTS = {
    goal: '', taskId: null, phase: 'idle', startedAt: null, endedAt: null,
    lastSummary: '', lastSummaryAt: null, lastTurnEndedAt: null,
    // 「执行成功」的子状态（achieved/interact，见 src/classify/vocab.js
    // GOAL_STATES）：只在 classifyState==='D' 时有值，其余时刻为 null。它描述的是
    // ✅ 那一格该说「达成目标」「需要交互」还是「执行成功」，不影响任何判定/守卫。
    classifyState: null, goalState: null, pendingDispatches: [],
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
    const classifyPayload = taskStatePayload(next);
    try { chatBroadcast(sessionId, classifyPayload); } catch (_) {}
    if (persisted.dirId) {
      try { workspaceBroadcast(persisted.dirId, { ...classifyPayload, sessionId }); } catch (_) {}
    }
    return next;
  }

  return { getTaskState, setTaskState, TASK_STATE_DEFAULTS };
}

module.exports = { createTaskStateStore };
