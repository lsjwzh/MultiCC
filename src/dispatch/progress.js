'use strict';

const { getNative } = require('../native/binding');

function textDeltaFromPart(delta) { return getNative().dispatchPart(delta, false); }
function reasoningDeltaFromPart(delta) { return getNative().dispatchPart(delta, true); }
function createSafeProgressReducer(onProgress, options = {}) {
  return getNative().dispatchReducer(onProgress, options);
}

// Server wiring for the sync dispatch progress bridge: subscribe to the
// normalized chat stream, filtered down to one dispatch operation's target
// session. Extracted from server.js — accessors keep it decoupled from the
// server's session maps (cliOf: persisted metadata, activeTurnOf/streamReplayOf:
// live in-memory state).
function createDispatchProgressSubscription({
  bus,
  createReducer = createSafeProgressReducer,
  cliOf,
  activeTurnOf,
  streamReplayOf,
} = {}) {
  if (!bus || typeof bus.on !== 'function' || typeof bus.off !== 'function') {
    throw new TypeError('dispatch progress subscription requires a bus');
  }
  return function subscribeDispatchProgress({ operationId, targetSessionId, onProgress } = {}) {
    const reducer = createReducer(onProgress, { cli: cliOf(targetSessionId) });
    const belongsToOperation = () => {
      const turn = activeTurnOf(targetSessionId);
      return turn?.lineage?.kind === 'dispatch'
        && turn.lineage.operationId === operationId;
    };
    const handle = (sessionId, payload) => {
      if (sessionId !== targetSessionId || !belongsToOperation()) return;
      try { reducer.push(payload); } catch (_) {}
    };
    bus.on('chat:stream-progress', handle);

    // Admission may start an idle worker before dispatch_master has returned
    // far enough to attach this listener. Replay the bounded current-turn
    // stream once so the first deltas are not lost; the reducer suppresses
    // duplicates.
    if (belongsToOperation()) {
      const replay = streamReplayOf(targetSessionId);
      if (Array.isArray(replay)) {
        for (const event of replay) reducer.push(event);
      }
    }
    return () => bus.off('chat:stream-progress', handle);
  };
}

module.exports = {
  createSafeProgressReducer,
  createDispatchProgressSubscription,
  reasoningDeltaFromPart,
  textDeltaFromPart,
};
