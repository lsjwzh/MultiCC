'use strict';

// Task state persistence (step ①): the ONLY implementation of
// getTaskState/setTaskState. server.js builds it once and every host receives
// these two functions, so the cancel-flow tests exercise the live code.
//
// persisted.taskState is the durable closed-loop task snapshot: it survives
// restarts so the reconcile (②) can decide what was running, whether it
// stalled, and whether to nudge. Sessions predating the field read as {}.
//
//   classifyState ∈ D | C | W | B | E | P | null  (D=done; B=terminal only; null=never classified)
//   classifyHistory: [{ at: ms, goal, phase, state, error }] — last 7 days
//
// The wire payload is shared with the connect seed — see
// src/chat/task-state-payload.js; the two producers must never drift (a
// reopened page once lost the last API error to that drift).
const { taskStatePayload } = require('../chat/task-state-payload');

const TASK_STATE_DEFAULTS = Object.freeze({
  goal: '', taskId: null, phase: 'idle', startedAt: null, endedAt: null,
  lastSummary: '', lastSummaryAt: null, lastTurnEndedAt: null,
  // 「执行成功」的子状态（achieved/interact，见 src/classify/vocab.js
  // GOAL_STATES）：只在 classifyState==='D' 时有值，其余时刻为 null。它描述的是
  // ✅ 那一格该说「达成目标」「需要交互」还是「执行成功」，不影响任何判定/守卫。
  classifyState: null, goalState: null, pendingDispatches: [],
  classifyHistory: [],
  pendingUserInput: null, userInputSignalVersion: 0, userInputSignalTurnId: null,
  apiError: null,
  // Stamped whenever the classify letter changes; the process watchdog
  // measures how long a session has sat in its current letter from it.
  classifyUpdatedAt: null,
  // Cancellation envelope. Written only by the classify dispatch, never by a
  // controller: `cancelledAt` is what marks an E as "the user stopped this"
  // rather than "the provider failed", and it is the guard that keeps a late
  // Aux verdict from resurrecting the turn.
  cancelledAt: null, cancelReason: null, cancelSource: null,
  cancelOperationId: null,
});

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// deps.bus receives 'task:state-changed' (sessionId, prev, next) on every
// write; the event hub derives task.* events from it, so it is required.
function createTaskStateStore(deps) {
  const { persistedSessions, saveBestEffort, chatBroadcast, workspaceBroadcast, bus, now = Date.now } = deps;
  if (!bus || typeof bus.emit !== 'function') {
    throw new TypeError('[task-state-store] bus with emit() is required');
  }

  function getTaskState(persisted) {
    if (!persisted) return { ...TASK_STATE_DEFAULTS };
    const ts = persisted.taskState || {};
    return { ...TASK_STATE_DEFAULTS, ...ts };
  }

  // Merge a patch into persisted.taskState; {save:false} batches. Returns the new state.
  function setTaskState(sessionId, patch, opts = {}) {
    const persisted = persistedSessions.get(sessionId);
    if (!persisted) return null;
    const cur = getTaskState(persisted);
    const classifyChanged = hasOwn(patch, 'classifyState') && patch.classifyState !== cur.classifyState;
    const next = {
      ...cur,
      ...patch,
      ...(classifyChanged && !hasOwn(patch, 'classifyUpdatedAt') ? { classifyUpdatedAt: now() } : {}),
    };
    persisted.taskState = next;
    bus.emit('task:state-changed', sessionId, cur, next);
    if (opts.save !== false) saveBestEffort('runtime.task-state');
    // Push classify goal/phase to connected chat clients, and to workspace
    // subscribers (fleet cards / Active sessions).
    const classifyPayload = taskStatePayload(next);
    try { chatBroadcast(sessionId, classifyPayload); } catch (_) {}
    if (persisted.dirId) {
      try { workspaceBroadcast(persisted.dirId, { ...classifyPayload, sessionId }); } catch (_) {}
    }
    return next;
  }

  return { getTaskState, setTaskState, TASK_STATE_DEFAULTS };
}

module.exports = { createTaskStateStore, TASK_STATE_DEFAULTS };
