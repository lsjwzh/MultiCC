'use strict';

// Session records are cloned during a CLI handoff and persistence hydration.
// Only a policy change, not a new object holding the same policy, resets its
// current route. The key itself is derived in the core
// (`native/core/src/auto_provider_selection_key.rs`); this module stays as the
// call site's stable entry point.
const { selectionKey } = require('../providers/auto-provider-config');

module.exports = { selectionKey };
