'use strict';

// Pure derivation of standard task events from a taskState transition.
// `prev`/`next` are full taskState objects (before/after setTaskState).
// The classify letter is the only state source; goalState is the D sub-state,
// which may arrive with D (classify), after D (refine) or by hand (manual).
//
// The derivation lives in native/core/src/events.rs. taskState carries seven
// days of classifyHistory and fires on every setTaskState, so only the fields
// the derivation reads cross the bridge.

const { getNative } = require('../native/runtime');

const native = getNative();
const CATALOG = JSON.parse(native.eventsCatalog());
const request = (op, input) => JSON.parse(native.eventsRequest(op, JSON.stringify(input)));

const LETTER_EVENT = Object.freeze(CATALOG.letterEvent);
const GOAL_EVENT = Object.freeze(CATALOG.goalEvent);

const FIELDS = ['classifyState', 'goalState', 'taskId', 'goal', 'phase', 'startedAt',
  'cancelledAt', 'cancelReason', 'goalStateManualAt'];

function project(state) {
  if (!state || typeof state !== 'object') return state;
  const out = {};
  for (const key of FIELDS) if (state[key] !== undefined) out[key] = state[key];
  const { apiError } = state;
  if (apiError !== undefined) {
    out.apiError = apiError && typeof apiError === 'object' ? { category: apiError.category } : apiError;
  }
  return out;
}

function letterOf(state) {
  return request('letterOf', { state: project(state) });
}

function goalOf(state) {
  return request('goalOf', { state: project(state) });
}

// Returns an ordered array of { type, data }. Empty when nothing observable
// changed. Idempotency across calls is the hub's job (it owns the memory).
function deriveTaskEvents(prev, next) {
  return request('deriveTaskEvents', { prev: project(prev), next: project(next) });
}

// Segment id used for idempotency: one task segment = one task id + start time.
function segmentKey(state) {
  return request('segmentKey', { state: project(state) });
}

module.exports = { LETTER_EVENT, GOAL_EVENT, deriveTaskEvents, segmentKey, letterOf, goalOf };
