'use strict';
// Safe HTTP error responses + per-request ids.
//
// Prior to this module, server.js's Express handlers sometimes leaked raw
// child-process stderr, Error.message strings that contained absolute paths,
// or full stack traces into JSON responses. Every one of those is a small
// information disclosure — a browser Fetch tab shows a filesystem layout to
// anyone who can reach the port. We can't audit every route in one pass, but
// we can install a single terminal error handler + a middleware that stamps
// each request with a short id so:
//
//   1. Handlers can call `next(err)` (or throw in an async wrapper) and know
//      the client sees `{ error: 'internal_error', requestId }` — no stack,
//      no stderr. The full details still go to server logs, tagged with the
//      same id so it's trivially correlate-able.
//   2. `res.locals.requestId` is available for any handler that WANTS to echo
//      the id back on a successful response (useful for /api/restart, /merge,
//      /sync, etc. so users can quote it when reporting bugs).
//   3. Anything the handler didn't sanitise is masked at the boundary.
//
// This is intentionally minimal: it does not attempt to classify every error
// (that stays in domain services). It's a floor, not a ceiling.

const crypto = require('crypto');
const { API_VERSION, createErrorDto } = require('./api-contract');

// 8 hex chars is enough entropy for correlation over a single log tail (16
// bits of collision resistance per pair-of-requests; noise-free at request
// rates below a few hundred/second, which multicc is well below). Short enough
// to fit in a mobile UI toast if we ever surface it.
function makeRequestId() { return crypto.randomBytes(4).toString('hex'); }

function cleanIncomingId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

function requestIdMiddleware(req, res, next) {
  const headers = req.headers || {};
  const id = cleanIncomingId(headers['x-request-id']) || makeRequestId();
  const correlationId = cleanIncomingId(headers['x-correlation-id']) || id;
  const startedAt = process.hrtime.bigint();
  req.id = id;
  req.correlationId = correlationId;
  res.locals = res.locals || {};
  res.locals.requestId = id;
  res.locals.correlationId = correlationId;
  res.setHeader('X-Multicc-Request-Id', id);
  res.setHeader('X-Correlation-Id', correlationId);
  res.setHeader('X-Multicc-API-Version', API_VERSION);
  let logged = false;
  if (typeof res.once === 'function') res.once('finish', () => {
    if (logged) return;
    logged = true;
    const obs = req.app && req.app.locals && req.app.locals.observability;
    if (!obs || !obs.logger) return;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    obs.logger.info('http_request', {
      requestId: id,
      correlationId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 1000) / 1000,
    });
  });
  if (typeof res.on === 'function') res.on('close', () => {
    if (logged || res.writableFinished) return;
    logged = true;
    const obs = req.app && req.app.locals && req.app.locals.observability;
    if (!obs || !obs.logger) return;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    obs.logger.info('http_request', {
      requestId: id,
      correlationId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 1000) / 1000,
      aborted: true,
    });
  });
  next();
}

// Terminal error handler. Register with `app.use(safeErrorHandler)` LAST, so
// every route falls through to it. Async handlers should be wrapped with
// `asyncHandler(fn)` (below) so their rejections reach here rather than
// hanging the request.
function safeErrorHandler(logger = console) {
  return function safeErrorHandlerMiddleware(err, req, res, _next) {
    if (res.headersSent) {
      // Nothing we can do — Express default handler will terminate the socket.
      return _next(err);
    }
    const rid = (res.locals && res.locals.requestId) || (req && req.id) || 'no-req-id';
    const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    // Full details to logs, tagged with the request id. Never to the client.
    try {
      const detail = err && (err.stack || err.message) || String(err);
      if (logger && logger.error && logger.error.length >= 2) {
        logger.error('http_error', { requestId: rid, correlationId: req && req.correlationId, method: req && req.method, path: req && req.path, status, detail });
      } else {
        logger.error(`[http:${rid}] ${req && req.method} ${req && req.path} → ${status}: ${detail}`);
      }
    } catch (_) { /* logger explosion is not our problem */ }

    // Client body: never include err.message or err.stack unless the caller
    // marked the error as `safe: true` (used by domain services returning
    // known-safe validation strings, e.g. "path does not exist: /p/missing").
    const correlationId = (res.locals && res.locals.correlationId) || (req && req.correlationId) || rid;
    const safeMessage = err && err.safe && typeof err.message === 'string' ? err.message : null;
    const body = createErrorDto({
      message: status >= 500 ? 'internal_error' : (safeMessage || 'request_error'),
      code: err && err.code || (status >= 500 ? 'internal_error' : 'request_error'),
      requestId: rid,
      correlationId,
    });
    res.status(status).json(body);
  };
}

// Wrap an async handler so its rejection reaches the safeErrorHandler above.
// Express 4 does not catch async throws in handlers by default.
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// A tiny helper for handlers that want to signal "known-safe validation
// failure, please pass the message through". Domain-service callers use this
// rather than raw new Error() so information leakage is opt-in.
function safeError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.safe = true;
  if (code) e.code = code;
  return e;
}

module.exports = {
  requestIdMiddleware,
  safeErrorHandler,
  asyncHandler,
  safeError,
  makeRequestId,
  cleanIncomingId,
};
