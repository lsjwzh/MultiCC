'use strict';

const { randomUUID } = require('node:crypto');

const REQUEST_KINDS = new Set(['inference', 'probe', 'auxiliary']);
const TERMINATIONS = new Set(['completed', 'downstream_disconnect', 'upstream_http_error', 'upstream_failure']);

function proxyRequestKind(protocol, req) {
  const method = String(req?.method || '').toUpperCase();
  const pathname = String(req?.url || req?.originalUrl || '').split('?')[0].replace(/\/+$/, '');
  if (method === 'HEAD') return 'probe';
  if (method === 'POST' && (protocol === 'claude'
    ? /\/v1\/messages$/.test(pathname) : /\/responses$/.test(pathname))) return 'inference';
  return 'auxiliary';
}

function normalizeProxyOutcome(value) {
  if (!value || value.version !== 1 || typeof value.requestId !== 'string'
      || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.requestId)
      || !REQUEST_KINDS.has(value.requestKind) || !TERMINATIONS.has(value.termination)) {
    throw new TypeError('invalid proxy outcome');
  }
  const httpStatus = value.httpStatus == null ? null : value.httpStatus;
  if (httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 400 || httpStatus > 599)
      || (value.termination === 'upstream_http_error') !== (httpStatus !== null)) {
    throw new TypeError('invalid proxy outcome HTTP status');
  }
  return Object.freeze({
    version: 1, requestId: value.requestId, requestKind: value.requestKind,
    termination: value.termination, httpStatus,
  });
}

// Observe the direction of a disconnect at the host HTTP boundary, before any
// provider adapter installs its handlers. Error-code strings remain diagnostics;
// neither provider identity nor a vendor's choice of code determines completion.
function observeProxyRequest(protocol, req, res, onTerminal = () => {}) {
  const requestId = randomUUID();
  const requestKind = proxyRequestKind(protocol, req);
  let downstreamClosed = false;
  let settled = false;
  const closed = () => {
    if (res?.writableEnded) return;
    downstreamClosed = true;
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
      const status = Number(event.statusCode);
      const httpStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
      const termination = httpStatus !== null ? 'upstream_http_error'
        : String(event.status).toLowerCase() !== 'error' ? 'completed'
          : downstreamClosed ? 'downstream_disconnect' : 'upstream_failure';
      return normalizeProxyOutcome({ version: 1, requestId, requestKind, termination, httpStatus });
    },
    settle(event) {
      const outcome = observation.outcome(event);
      if (!settled) {
        settled = true;
        try { onTerminal(outcome, event); } catch (_) {}
      }
      return outcome;
    },
  });
  return observation;
}

module.exports = { normalizeProxyOutcome, observeProxyRequest, proxyRequestKind };
