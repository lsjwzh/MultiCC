'use strict';

// /codex-proxy is not served from one place: the attempt guard, the ChatGPT
// OAuth relay and the router's generic Codex proxy all mount on the same
// prefix, in that order. When a CLI reports `unexpected status 404 … <url>`,
// nothing in that report says which of them ran — or whether any of them did.
// A response that never touched this process (an intermediary, a stale home
// pointed at a dead port) looks exactly like a host-side miss.
//
// This trace keeps the last N requests that reached the prefix in memory,
// together with the stage that finally answered and the status it wrote, so a
// reported 404 can be matched to an entry — or shown to be absent from a
// window this process demonstrably was not answering.
//
// Diagnostics only: the middleware never writes a response and never changes
// one. The attempt-scoped capability in the path is a bearer-like secret, so it
// is redacted before it reaches an entry.

const MAX_ROUTE = 300;
const CAPABILITY_SEGMENT = /^(?:pr1|mcr1|mcp1)\./;
const DEFAULT_CAPACITY = 200;

function redactSegment(segment) {
  const value = String(segment || '');
  return CAPABILITY_SEGMENT.test(value) ? `${value.slice(0, 4)}<redacted>` : value;
}

function traceRoute(rawUrl) {
  const path = String(rawUrl || '').split('?')[0].split('#')[0];
  return path.split('/').map(redactSegment).join('/').slice(0, MAX_ROUTE);
}

// /codex-proxy/<provider>/<session>/<role>/responses is the attempt form;
// /codex-proxy/<provider>/responses the session-less one. Anything else on the
// prefix keeps only the provider so unknown routes stay recognizable.
function traceParts(rawUrl) {
  const segments = String(rawUrl || '').split('?')[0].split('/').filter(Boolean);
  const at = segments.indexOf('codex-proxy');
  if (at < 0) return { providerId: null, session: null, role: null };
  const tail = segments.slice(at + 1);
  const providerId = tail[0] ? redactSegment(tail[0]) : null;
  const rest = tail.slice(1);
  if (!rest.length || rest[0] === 'responses') return { providerId, session: null, role: null };
  const session = redactSegment(rest[0]);
  const role = rest[2] === 'responses' && rest[1] ? redactSegment(rest[1]) : null;
  return { providerId, session, role };
}

function traceModel(req) {
  const body = req && req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.isBuffer(body)) return null;
  return typeof body.model === 'string' ? body.model.slice(0, 80) : null;
}

function stageOf(res) {
  const locals = res && res.locals;
  const stage = locals && typeof locals === 'object' ? locals.multiccProxyStage : null;
  return typeof stage === 'string' && stage ? stage : 'proxy';
}

// Stage labels a responder writes before it answers:
//   guard          — the attempt guard rejected the route (409)
//   official-relay — the host-owned ChatGPT OAuth relay took the request
//   unmatched      — nothing mounted on the prefix accepted it (Express answers)
//   proxy          — a mounted proxy route (the router's generic Codex family)
function markStage(res, stage) {
  if (!res || !stage) return undefined;
  res.locals = res.locals && typeof res.locals === 'object' ? res.locals : {};
  res.locals.multiccProxyStage = String(stage);
  return res.locals.multiccProxyStage;
}

function createCodexProxyTrace(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const requested = Number(options.capacity);
  const capacity = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_CAPACITY;
  let logger = options.logger && typeof options.logger.warn === 'function' ? options.logger : null;
  const entries = [];
  let seq = 0;

  function attachLogger(next) {
    logger = next && typeof next.warn === 'function' ? next : null;
    return logger;
  }

  function settle(entry, res) {
    if (entry.ended) return;
    entry.ended = true;
    entry.status = res && Number.isInteger(res.statusCode) ? res.statusCode : null;
    entry.stage = stageOf(res);
    entry.durationMs = Math.max(0, now() - entry.startedAt);
    entry.aborted = res ? res.writableFinished === false : false;
    // Mirrors what the caller can see on the wire: a host-owned Express
    // response always carries x-powered-by, a forwarded/foreign one need not.
    entry.expressResponded = res && typeof res.getHeader === 'function'
      ? Boolean(res.getHeader('x-powered-by')) : null;
    // Only the states that sent someone looking: a miss, a 5xx, a client gone.
    if (!logger) return;
    if (entry.stage !== 'unmatched' && !entry.aborted && entry.status !== 404 && !(entry.status >= 500)) return;
    try {
      logger.warn('codex_proxy_trace', {
        requestId: entry.requestId, method: entry.method, route: entry.route,
        providerId: entry.providerId, role: entry.role, model: entry.model,
        status: entry.status, stage: entry.stage, aborted: entry.aborted,
        durationMs: entry.durationMs,
      });
    } catch (_) { /* diagnostics must never fail the request */ }
  }

  function middleware(req, res, next) {
    const raw = req && (req.originalUrl || req.url);
    const parts = traceParts(raw);
    const entry = {
      seq: ++seq,
      at: new Date(now()).toISOString(),
      startedAt: now(),
      requestId: (res && res.locals && res.locals.requestId) || (req && req.id) || null,
      method: String(req && req.method || '').toUpperCase(),
      route: traceRoute(raw),
      providerId: parts.providerId,
      session: parts.session,
      role: parts.role,
      model: traceModel(req),
      stage: null, status: null, durationMs: null,
      ended: false, aborted: false, expressResponded: null,
    };
    entries.push(entry);
    while (entries.length > capacity) entries.shift();
    if (res && typeof res.once === 'function') {
      res.once('finish', () => settle(entry, res));
      res.once('close', () => settle(entry, res));
    }
    return typeof next === 'function' ? next() : undefined;
  }

  // Mounted last on the prefix. Reaching it means no mounted route answered;
  // Express's own anonymous 404 follows exactly as it would without this.
  function unmatched(req, res, next) {
    markStage(res, 'unmatched');
    return typeof next === 'function' ? next() : undefined;
  }

  function snapshot(limit = capacity) {
    const count = Number.isInteger(limit) && limit > 0 ? limit : capacity;
    return entries.slice(-count).reverse().map(({ startedAt, ...rest }) => rest);
  }

  return Object.freeze({ middleware, unmatched, snapshot, attachLogger });
}

let shared = null;
function codexProxyTrace(options = {}) {
  if (!shared) shared = createCodexProxyTrace(options);
  else if (options.logger) shared.attachLogger(options.logger);
  return shared;
}

// Tests exercise their own instance; the host only ever uses the shared one so
// the debug route and the mounted middleware cannot drift apart.
function setSharedCodexProxyTrace(trace) {
  shared = trace || null;
  return shared;
}

module.exports = {
  createCodexProxyTrace,
  codexProxyTrace,
  markStage,
  setSharedCodexProxyTrace,
  traceParts,
  traceRoute,
};
