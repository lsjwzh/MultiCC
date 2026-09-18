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
const MODES = Object.freeze(['off', 'shadow', 'suggest', 'auto']);
const DEFAULT_MODE = 'suggest';

function normalizeAttributionMode(value, fallback = DEFAULT_MODE) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return MODES.includes(mode) ? mode : fallback;
}

// A verdict only "wants" a change when it either declares a new task or names a
// different existing one. Naming the task a turn already has is not a change,
// and must not create a shadow row or a suggestion.
function planAttributionAction({ mode, relation, targetTaskId = null, currentTaskId = null } = {}) {
  const resolved = normalizeAttributionMode(mode);
  const target = typeof targetTaskId === 'string' && targetTaskId ? targetTaskId : null;
  const current = typeof currentTaskId === 'string' && currentTaskId ? currentTaskId : null;
  const wantsChange = relation === 'new' || (!!target && target !== current);
  if (!wantsChange) return { mode: resolved, action: 'none', reason: 'no_change', targetTaskId: null };
  if (resolved === 'off') return { mode: resolved, action: 'none', reason: 'mode_off', targetTaskId: null };
  if (resolved === 'shadow') return { mode: resolved, action: 'record', reason: 'shadow', targetTaskId: target };
  if (resolved === 'suggest') return { mode: resolved, action: 'suggest', reason: 'suggest', targetTaskId: target };
  // Auto still needs an address. A vague "this is new" without an identity to
  // promote stays a suggestion instead of minting an unnamed task.
  if (!target) return { mode: resolved, action: 'suggest', reason: 'target_unknown', targetTaskId: null };
  return { mode: resolved, action: 'apply', reason: 'auto', targetTaskId: target };
}

module.exports = { MODES, DEFAULT_MODE, normalizeAttributionMode, planAttributionAction };
