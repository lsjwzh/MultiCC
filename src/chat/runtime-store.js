'use strict';

// The per-session turn runtime store — the single owner is the native
// `RustSessionRecords` (native/addon/src/session_records.rs, `turn*` methods).
// This module is a thin facade, not a second table: phases, turn ids,
// generation counters, the last/pending outcome and the frozen provider-route
// proof all live in Rust. The native owner only keeps preparation state; the
// streaming runner, CLI child process and timers stay with the turn engine and
// are never handed to this store.
//
// The frozen pre-migration implementation lives on as the differential oracle
// in `tests/helpers/legacy-chat-runtime-store.js`; `tests/test-chat-runtime-native.js`
// replays randomized lifecycles against both.

const { createStateOwner } = require('../state/owner');

// `options.owner` is the process-wide state owner from `src/state/owner.js`.
// A store created without one (unit fixtures) gets its own native owner: there
// is no Node-side fallback lane.
function createTurnRuntimeStore(options = {}) {
  const shared = options.owner || createStateOwner();
  const native = shared.native;
  native.turnConfigure(typeof options.now === 'function' ? options.now : Date.now);

  return Object.freeze({
    claim(sessionId, turnId, meta = {}) {
      return native.turnClaim(sessionId, turnId, meta);
    },
    markMessageDurable(sessionId, turnId) {
      return native.turnMarkMessageDurable(sessionId, turnId);
    },
    markProviderRouteResolved(sessionId, turnId, route = {}) {
      return native.turnMarkProviderRouteResolved(sessionId, turnId, route);
    },
    providerRouteFailed(sessionId, turnId, reason = 'route-failed') {
      return native.turnProviderRouteFailed(sessionId, turnId, reason);
    },
    abortPreparation(sessionId, turnId, reason = 'preparation-failed') {
      return native.turnAbortPreparation(sessionId, turnId, reason);
    },
    settle(sessionId, turnId, outcome = {}, allowedPhases) {
      return native.turnSettle(sessionId, turnId, outcome, allowedPhases);
    },
    start(sessionId, turnId) {
      return native.turnStart(sessionId, turnId);
    },
    beginCleanup(sessionId, turnId, outcome = {}) {
      return native.turnBeginCleanup(sessionId, turnId, outcome);
    },
    cleanup(sessionId, turnId) {
      return native.turnCleanup(sessionId, turnId);
    },
    claimProof(sessionId, turnId) {
      return native.turnClaimProof(sessionId, turnId);
    },
    snapshot(sessionId) {
      return native.turnSnapshot(sessionId);
    },
    list() {
      return native.turnList();
    },
  });
}

module.exports = { createTurnRuntimeStore };
