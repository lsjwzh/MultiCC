'use strict';

const { normalizeStoredProviderSelection } = require('../providers/auto-provider-config');

// Session records are cloned during a CLI handoff and persistence hydration.
// Only a policy change, not a new object holding the same policy, resets its
// current route. Normalization fixes key order and resolves omitted defaults.
function selectionKey(selection) {
  const normalized = normalizeStoredProviderSelection(selection);
  if (!normalized) return null;
  // presetId is a display label ("this pool came from preset X"), not routing
  // policy: saving the same pool again under another preset must not reset the
  // session's sticky route or its notes.
  const policy = { ...normalized };
  delete policy.presetId;
  return JSON.stringify(policy);
}

module.exports = { selectionKey };
