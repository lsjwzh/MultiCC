'use strict';

// The classify verdict says what a turn *looks* like; the mode says what the
// host is allowed to do about it. Keeping the two apart is what makes the
// ladder measurable: the same verdict is produced in every tier, and only the
// last one may change task identity on its own.
//
//   off     — the automatic verdict is ignored.
//   shadow  — recorded for parity measurement, never shown, never applied.
//   suggest — recorded and offered to the user; still never applied by itself.
//   auto    — applied immediately when the target is known and the turn is free.
//
// `suggest` is the default: today's separation dialog already is a suggestion,
// so the default keeps user-visible behaviour unchanged while the journal
// starts collecting the evidence `auto` would need.
//
// The ladder lives in native/core/src/task_routing.rs. Only strings carry
// meaning in either call, so the bridge passes string-or-null per field (no
// BigInt/Symbol can reach JSON.stringify); the caller-supplied fallback is
// applied here so its identity is preserved.

const { getNative } = require('../native/runtime');

const native = getNative();
const CATALOG = JSON.parse(native.taskRoutingCatalog());

const MODES = Object.freeze(CATALOG.attributionModes);
const DEFAULT_MODE = CATALOG.defaultAttributionMode;

const str = value => (typeof value === 'string' ? value : null);
const request = (op, input) => JSON.parse(native.taskRoutingRequest(op, JSON.stringify(input)));

function normalizeAttributionMode(value, fallback = DEFAULT_MODE) {
  const mode = request('normalizeAttributionMode', { value: str(value) });
  return mode === null ? fallback : mode;
}

// A verdict only "wants" a change when it either declares a new task or names a
// different existing one. Naming the task a turn already has is not a change,
// and must not create a shadow row or a suggestion.
function planAttributionAction({ mode, relation, targetTaskId = null, currentTaskId = null } = {}) {
  return request('planAttributionAction', {
    mode: str(mode), relation: str(relation),
    targetTaskId: str(targetTaskId), currentTaskId: str(currentTaskId),
  });
}

module.exports = { MODES, DEFAULT_MODE, normalizeAttributionMode, planAttributionAction };
