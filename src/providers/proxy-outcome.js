'use strict';

const { randomUUID } = require('node:crypto');

const { getNative } = require('../native/binding');

function proxyRequestKind(protocol, req) {
  const method = String(req?.method || '').toUpperCase();
  const url = String(req?.url || req?.originalUrl || '');
  return getNative().proxyClassifyRequest(protocol === 'claude', method, url);
}

function normalizeProxyOutcome(value) {
  return getNative().proxyNormalizeOutcome(value);
}

// Observe the direction of a disconnect at the host HTTP boundary, before any
// provider adapter installs its handlers. Error-code strings remain diagnostics;
// neither provider identity nor a vendor's choice of code determines completion.
function observeProxyRequest(protocol, req, res, onTerminal = () => {}, beforeDisconnect = () => false) {
  const requestId = randomUUID();
  const requestKind = proxyRequestKind(protocol, req);
  const state = new (getNative().ProxyObservationState)();
  const closed = () => {
    if (res?.writableEnded) return;
    // The native timer can have expired while the JS event loop was paused.
    // Give it the close boundary before attributing a downstream disconnect.
    try { if (beforeDisconnect() === true) return; } catch (_) { /* fall back to close observation */ }
    state.disconnect();
    observation.settle({ status: 'error', statusCode: res?.statusCode, errorCode: 'DOWNSTREAM_DISCONNECT' });
  };
  req?.once?.('aborted', closed);
  res?.once?.('close', closed);
  res?.once?.('finish', () => {
    // HTTP 200 alone does not prove stream success: an SSE error can be in
    // the body. Successful completion comes from the adapter's terminal event.
    if (res.statusCode >= 400) observation.settle({ status: 'error', statusCode: res.statusCode });
  });
  const observation = Object.freeze({
    outcome(event = {}) {
      return state.outcome(requestId, requestKind, Number(event.statusCode), event);
    },
    settle(event) {
      const outcome = observation.outcome(event);
      if (state.claimTerminal()) {
        try { onTerminal(outcome, event); } catch (_) {}
      }
      return outcome;
    },
  });
  return observation;
}

module.exports = { normalizeProxyOutcome, observeProxyRequest, proxyRequestKind };
