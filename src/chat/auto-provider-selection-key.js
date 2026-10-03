'use strict';

const { normalizeStoredProviderSelection } = require('../providers/auto-provider-config');

// Session records are cloned during a CLI handoff and persistence hydration.
// Only a policy change, not a new object holding the same policy, resets its
// current route. Normalization fixes key order and resolves omitted defaults.
function selectionKey(selection) {
  const normalized = normalizeStoredProviderSelection(selection);
  return normalized ? JSON.stringify(normalized) : null;
}

module.exports = { selectionKey };
