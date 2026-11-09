'use strict';

// Task-state store (step ①): the ONLY implementation of getTaskState/
// setTaskState. server.js builds it once and every host receives these two
// functions, so the cancel-flow tests exercise the live code.
//
// persisted.taskState is the durable closed-loop task snapshot: it survives
// restarts so the reconcile (②) can decide what was running, whether it
// stalled, and whether to nudge. Sessions predating the field read as {}.
//
//   classifyState ∈ D | C | W | B | E | P | null  (D=done; B=terminal only; null=never classified)
//   classifyHistory: [{ at: ms, goal, phase, state, error }] — last 7 days
//
// The merge, the classifyUpdatedAt stamp and the save/broadcast ordering live in
// the native session-record owner (native/addon/src/session_records.rs) so the
// record table and the task state have exactly one writer. The defaults come
// from that owner's core rule as well.
//
// The wire payload is shared with the connect seed — see
// src/chat/task-state-payload.js; the two producers must never drift (a
// reopened page once lost the last API error to that drift).
const { taskStatePayload } = require('../chat/task-state-payload');
const { sessionRecordDefaults, sessionRecordsOwner } = require('../session/records');

const TASK_STATE_DEFAULTS = Object.freeze(sessionRecordDefaults());

// deps.bus receives 'task:state-changed' (sessionId, prev, next) on every
// write; the event hub derives task.* events from it, so it is required.
function createTaskStateStore(deps) {
  const { persistedSessions, chatBroadcast, workspaceBroadcast, bus, now = Date.now } = deps;
  if (!bus || typeof bus.emit !== 'function') {
    throw new TypeError('[task-state-store] bus with emit() is required');
  }
  const owner = sessionRecordsOwner(persistedSessions);
  if (!owner) {
    throw new TypeError('[task-state-store] persistedSessions must be the native session record owner');
  }
  owner.configure({
    busEmit: (event, ...args) => bus.emit(event, ...args),
    chatBroadcast,
    workspaceBroadcast,
    taskStatePayload,
    now,
  });

  function getTaskState(persisted) {
    return owner.getTaskState(persisted);
  }

  // Merge a patch into persisted.taskState; {save:false} batches. Returns the new state.
  function setTaskState(sessionId, patch, opts = {}) {
    return owner.setTaskState(sessionId, patch, opts || {});
  }

  // Classify history append (last-7-days window) and task-deletion reset are
  // direct writers on the same record; both route through the owner so no
  // mutation can land outside the persistence lifecycle.
  function appendClassifyHistory(sessionId, entry, cutoff) {
    return owner.appendClassifyHistory(sessionId, entry, cutoff);
  }
  function resetTaskState(sessionId) {
    return owner.resetTaskState(sessionId);
  }

  return { getTaskState, setTaskState, appendClassifyHistory, resetTaskState, TASK_STATE_DEFAULTS };
}

module.exports = { createTaskStateStore, TASK_STATE_DEFAULTS };
