'use strict';

// Turn state is a projection of structured runtime facts. Aux is deliberately
// absent from this module: naming/grouping may degrade when the model is down,
// but the scheduler must still receive one deterministic P/D/W/B/E verdict.
//
// The resolver lives in native/core/src/turn_state.rs (unknown boundaries fail
// closed to E; a live or unknown runner is always P). This module keeps the
// export surface and forwards; tests/test-turn-state-rules.js pins behaviour.

const { getNative } = require('../native/runtime');

const native = getNative();
const CATALOG = JSON.parse(native.turnStateCatalog());

const ABNORMAL_BOUNDARIES = new Set(CATALOG.abnormalBoundaries);

function resolveTurnState(input = {}) {
  return JSON.parse(native.resolveTurnState(JSON.stringify(input)));
}

module.exports = { resolveTurnState, ABNORMAL_BOUNDARIES };
