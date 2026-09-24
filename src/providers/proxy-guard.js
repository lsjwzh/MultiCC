'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { observeProxyRequest } = require('./proxy-outcome');

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function routeSegments(req) {
  const rawPath = clean(req && (req.url || req.originalUrl)).split('?')[0];
  const rawSegments = rawPath.split('/').filter(Boolean);
  try { return rawSegments.map(segment => decodeURIComponent(segment)); }
  catch (_) { return []; }
}

// Host-owned claude routes: the segment after the provider id names a host
// request (aux inference, relay-share remote, speed test, model probe) rather
// than a session. Each has no turn attempt to prove, so it is authenticated at
// the outer HTTP boundary — loopback-only in practice, and the route token is
// the same throwaway virtual one a probe child carries.
const CLAUDE_HOST_ROUTE_BUCKETS = new Set(['aux', 'remote', 'speedtest', 'probe']);

// CPR exposes two different trust domains under the same protocol prefix:
//   - attempt routes carry a per-turn capability in the session segment;
//   - host routes are authenticated by the outer HTTP boundary (admin access,
//     loopback, or the relay-only bearer) and have no turn attempt to prove.
// Keep that distinction in one classifier so both the early HTTP guard and the
// final getProvider admission make the same ownership decision.
function classifyProviderProxyRoute(protocol, segments = []) {
  const providerId = clean(segments[0]);
  const sessionId = clean(segments[1]);
  const role = protocol === 'codex' ? clean(segments[2]) || 'main' : 'main';
  if (!providerId || !sessionId) {
    return Object.freeze({ scope: 'host', providerId, sessionId, role });
  }
  if (protocol === 'codex' && (!segments[2] || sessionId === 'responses')) {
    return Object.freeze({ scope: 'host', providerId, sessionId, role });
  }
  if (protocol === 'claude' && CLAUDE_HOST_ROUTE_BUCKETS.has(sessionId)) {
    return Object.freeze({ scope: 'host', providerId, sessionId, role });
  }
  return Object.freeze({ scope: 'attempt', providerId, sessionId, role });
}

function reject(res) {
  const body = JSON.stringify({ error: 'provider route attempt is no longer active' });
  if (res && typeof res.status === 'function' && typeof res.json === 'function') {
    return res.status(409).json(JSON.parse(body));
  }
  if (res && typeof res.writeHead === 'function') {
    res.writeHead(409, { 'content-type': 'application/json' });
  } else if (res) {
    res.statusCode = 409;
    if (typeof res.setHeader === 'function') res.setHeader('content-type', 'application/json');
  }
  return res && typeof res.end === 'function' ? res.end(body) : undefined;
}

// A 409 on this path is a host decision, not an upstream failure, and it was
// completely silent: the caller received a rejection from a route it believed it
// still owned, with nothing naming the session, the provider or which attempt
// had been retired. During an incident that made a process replaying a finished
// turn's route — a keep-alive child poking the proxy every half minute —
// indistinguishable from idle traffic, and the log pointed only at the queue.
// Diagnostics only: the port is optional and can never change the response.
function reportRejection(options, detail) {
  if (typeof options.onRejected !== 'function') return undefined;
  try { return options.onRejected(detail); } catch (_) { return undefined; }
}

function createProviderProxyGuard(options = {}) {
  const protocol = clean(options.protocol).toLowerCase();
  const authorize = options.authorizeProxyRequest;
  if (protocol !== 'claude' && protocol !== 'codex') {
    throw new TypeError('provider proxy guard protocol must be claude or codex');
  }
  if (typeof authorize !== 'function') {
    throw new TypeError('provider proxy guard authorizer is required');
  }
  return function providerProxyGuard(req, res, next) {
    const segments = routeSegments(req);
    const route = classifyProviderProxyRoute(protocol, segments);
    if (route.scope !== 'attempt') {
      return typeof next === 'function' ? next() : undefined;
    }
    let decision;
    try {
      decision = authorize({
        protocol, providerId: route.providerId, sessionId: route.sessionId,
        role: route.role, method: clean(req && req.method).toUpperCase(),
      });
    } catch (_) {
      decision = null;
    }
    const method = clean(req && req.method).toUpperCase();
    if (!decision || decision.ok !== true) {
      reportRejection(options, { protocol, stage: 'http_guard', method,
        providerId: route.providerId, sessionId: route.sessionId, role: route.role,
        reason: clean(decision && decision.code) || 'attempt_not_active' });
      return reject(res);
    }
    // Claude probes connectivity with HEAD /api/hello (older versions use /).
    // This checks the local proxy, not model inference. Keep it behind attempt
    // authorization and out of CPR's upstream usage/error/activity callbacks.
    const apiPath = segments.slice(2).join('/');
    if (protocol === 'claude' && method === 'HEAD'
        && (apiPath === '' || apiPath === 'api/hello')) {
      res.statusCode = 200;
      return res.end();
    }
    return typeof next === 'function' ? next() : undefined;
  };
}

class ProviderProxyAdmissionError extends Error {
  constructor(detail = {}) {
    super('provider route attempt is no longer active');
    this.name = 'ProviderProxyAdmissionError';
    this.code = 'PROVIDER_PROXY_ADMISSION_REJECTED';
    // Carried so the rejection can be reported with the identity the caller
    // actually asked for, instead of whatever this session resolved last.
    if (detail.providerId) this.providerId = detail.providerId;
    if (detail.sessionId) this.sessionId = detail.sessionId;
    if (detail.role) this.role = detail.role;
    if (detail.reason) this.reason = detail.reason;
  }
}

function createProviderProxyAdmission(options = {}) {
  const protocol = clean(options.protocol).toLowerCase();
  const authorize = options.authorizeProxyRequest;
  const getProvider = options.getProvider;
  if ((protocol !== 'claude' && protocol !== 'codex')
      || typeof authorize !== 'function' || typeof getProvider !== 'function') {
    throw new TypeError('provider proxy admission ports are required');
  }
  const requestContext = new AsyncLocalStorage();

  function onActivity(event) {
    const context = requestContext.getStore();
    if (context && event && event.phase === 'request') {
      context.openActivity = { ...event };
      context.role = event.roleKind || event.role || context.role;
      context.providerId = event.providerId || context.mainProviderId;
    } else if (context && event && event.phase === 'end') {
      context.openActivity = null;
    }
    if (typeof options.onActivity === 'function') return options.onActivity(event);
    return undefined;
  }

  function onUsageEvent(event) {
    const context = requestContext.getStore();
    const proxyOutcome = context ? context.observation.settle(event) : null;
    if (typeof options.onUsageEvent !== 'function') return;
    return options.onUsageEvent({
      ...event,
      // Request context is captured by AsyncLocalStorage, never taken from a
      // provider response or inferred from the last request on this session.
      ...(proxyOutcome ? { proxyOutcome } : {}),
    });
  }

  function closeOpenActivity(context, error) {
    const open = context && context.openActivity;
    if (!open) return;
    context.openActivity = null;
    if (typeof options.onActivity !== 'function') return;
    try {
      options.onActivity({
        ...open, phase: 'end', status: 'error',
        errorCode: String(error && error.code || 'PROXY_HANDLER_FAILED'),
      });
    } catch (_) {}
  }

  function contextFor(req) {
    if (protocol === 'codex' && req && req.params) {
      const route = classifyProviderProxyRoute(protocol, [
        req.params.providerId, req.params.sessionId, req.params.role,
      ]);
      if (route.scope !== 'attempt') return null;
      return {
        sessionId: route.sessionId,
        mainProviderId: route.providerId,
        role: route.role,
      };
    }
    const route = classifyProviderProxyRoute(protocol, routeSegments(req));
    if (route.scope !== 'attempt') return null;
    return {
      sessionId: route.sessionId,
      mainProviderId: route.providerId,
      role: route.role,
    };
  }

  function handleFailure(error, res, next, context) {
    closeOpenActivity(context, error);
    if (error instanceof ProviderProxyAdmissionError) {
      // The rejected lookup is the second half of the same decision the HTTP
      // guard makes, and it is the half a replayed attempt usually reaches (the
      // mount already passed the guard when the route was live). Report the
      // identity the caller asked for, not the context's last resolved one.
      reportRejection(options, { protocol, stage: 'getProvider',
        providerId: error.providerId || context?.providerId || context?.mainProviderId || '',
        sessionId: error.sessionId || context?.sessionId || '',
        role: error.role || context?.role || '',
        reason: error.reason || 'attempt_not_active' });
      return reject(res);
    }
    if (typeof next === 'function') return next(error);
    throw error;
  }

  function invoke(handler, req, res, next) {
    const route = contextFor(req);
    const context = { ...route, attemptScoped: !!route };
    context.observation = observeProxyRequest(protocol, req, res, (proxyOutcome, event) => {
      if (!context.attempt || typeof options.onOutcome !== 'function') return;
      // Transport events may fire outside AsyncLocalStorage. The closure owns
      // the admission snapshot; no lookup of the session's latest turn occurs.
      options.onOutcome({
        ...context.attempt, roleKind: context.role, routeAttribution: 'exact',
        providerId: context.providerId || context.mainProviderId,
        status: event.status, statusCode: event.statusCode, errorCode: event.errorCode,
        proxyOutcome,
      });
    });
    let result;
    try {
      const call = () => handler(req, res, next);
      result = requestContext.run(context, call);
    } catch (error) {
      return handleFailure(error, res, next, context);
    }
    if (result && typeof result.then === 'function') {
      return result.catch(error => handleFailure(error, res, next, context));
    }
    return result;
  }

  const app = protocol === 'claude'
    ? Object.freeze({
      use(pathname, handler) {
        return options.app.use(pathname, (req, res, next) => invoke(handler, req, res, next));
      },
    })
    : Object.freeze({
      post(pathname, handler) {
        return options.app.post(pathname, (req, res, next) => invoke(handler, req, res, next));
      },
    });

  function guardedGetProvider(appType, providerId) {
    const context = requestContext.getStore();
    if (context?.attemptScoped) {
      const role = protocol === 'claude' && clean(providerId) !== context.mainProviderId
        ? 'sub' : context.role;
      let decision;
      try {
        decision = authorize({
          protocol, sessionId: context.sessionId, providerId: clean(providerId), role,
        });
      } catch (_) {
        decision = null;
      }
      if (!decision || decision.ok !== true) throw new ProviderProxyAdmissionError({
        providerId: clean(providerId), sessionId: context.sessionId, role,
        reason: clean(decision && decision.code) || 'attempt_not_active',
      });
      context.attempt = decision.attempt;
      context.providerId = clean(providerId);
      context.role = role;
    }
    return getProvider(appType, providerId);
  }

  return Object.freeze({ app, getProvider: guardedGetProvider, onActivity, onUsageEvent });
}

module.exports = {
  ProviderProxyAdmissionError,
  classifyProviderProxyRoute,
  createProviderProxyAdmission,
  createProviderProxyGuard,
  routeSegments,
};
