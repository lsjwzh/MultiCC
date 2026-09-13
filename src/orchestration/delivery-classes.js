'use strict';

// Delivery classes: the outbox item's OWN provenance (payload.type + source),
// decided once at the delivery boundary. Downstream consumers — the chat turn
// engine, the task-shell admission guard, the result sink — route on the
// class instead of re-inferring what a message is from partial fields
// (taskId/originContinue). A message that loses its class context on the way
// to the guard is exactly how a system notice came to be rejected as an
// impostor task message (task_identity_mismatch, silently).
const DELIVERY_CLASS = Object.freeze({
  // System-generated notices (e.g. task.interrupted). They are written
  // straight into chat history for the human to see; they never start a
  // native turn and never pass a task admission guard.
  NOTICE: 'notice',
  // User-typed chat input. Starts a fresh native conversation turn under the
  // ordinary admission gates.
  TURN: 'turn',
  // Task/dispatch work. Starts a turn under the FULL task-shell guard chain
  // (task identity, receipt protocol, lifecycle state).
  TASK: 'task',
  // Async dispatch results. Routed to the gateway that owns the dispatch.
  RESULT: 'result',
});

// Explicit map for system-typed payloads. session.work is classified by its
// source: direct user input vs. task-staged work. An UNKNOWN payload type
// defaults to NOTICE — a system payload must never silently spin up a native
// CLI turn just because nobody classified it.
const CLASS_BY_PAYLOAD_TYPE = Object.freeze({
  'task.interrupted': DELIVERY_CLASS.NOTICE,
  'dispatch.result': DELIVERY_CLASS.RESULT,
  'dispatch.request': DELIVERY_CLASS.TASK,
});

function deliveryClassForItem(item) {
  const payload = item?.payload || {};
  const explicit = CLASS_BY_PAYLOAD_TYPE[payload.type];
  if (explicit) return explicit;
  if (payload.type === 'session.work') {
    return payload.source === 'direct' ? DELIVERY_CLASS.TURN : DELIVERY_CLASS.TASK;
  }
  return DELIVERY_CLASS.NOTICE;
}

module.exports = { DELIVERY_CLASS, deliveryClassForItem };
