'use strict';

// Default-model selection is implemented in native/core/src/model_default.rs.
// This file is a thin bridge: it serializes the lane facts the host already
// resolved (provider summary, model list, explicit-selection history) and
// returns the model the core chose. No selection rule lives here.

const { getNative } = require('../native/runtime');

function resolveModelDefault(request) {
  const reply = getNative().sessionModelDefault(JSON.stringify(request || {}));
  let parsed;
  try {
    parsed = JSON.parse(reply);
  } catch (_) {
    return null;
  }
  return parsed && typeof parsed.model === 'string' && parsed.model ? parsed.model : null;
}

module.exports = { resolveModelDefault };
