'use strict';

// Derivation layer over the turn event journal (#110): replay journal lines
// and reconstruct turn facts (per-tool timing, blob parity, open background
// tasks). The kernels live in the Rust addon
// (native/addon/src/turn_event_replay.rs over
// native/core/src/turn_event_replay.rs); this module is only the CommonJS
// surface the turn engine and scripts/turn-event-report.js import. The
// addon reads every property from the caller's objects lazily, so getters,
// exceptions, coercion order and reference identity behave as before.

const { getNative } = require('../native/runtime');

function deriveToolTiming(records) {
  return getNative().turnEventToolTiming(records);
}

function diffToolTiming(derivedTools, blobTools, options = {}) {
  return getNative().turnEventDiffTiming(derivedTools, blobTools, options);
}

function deriveOpenTasks(records) {
  return getNative().turnEventOpenTasks(records);
}

module.exports = Object.freeze({
  deriveToolTiming,
  diffToolTiming,
  deriveOpenTasks,
  DEFAULT_TOLERANCE_MS: 2000,
});
