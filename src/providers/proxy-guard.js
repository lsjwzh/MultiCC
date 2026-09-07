'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function routeSegments(req) {
  const rawPath = clean(req && (req.url || req.originalUrl)).split('?')[0];
  const rawSegments = rawPath.split('/').filter(Boolean);
  try { return rawSegments.map(segment => decodeURIComponent(segment)); }
  catch (_) { return []; }
}

const CLAUDE_HOST_ROUTE_BUCKETS = new Set(['aux', 'remote', 'speedtest']);

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
    const route = classifyProviderProxyRoute(protocol, routeSegments(req));
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
    if (!decision || decision.ok !== true) return reject(res);
    return typeof next === 'function' ? next() : undefined;
  };
}

class ProviderProxyAdmissionError extends Error {
  constructor() {
    super('provider route attempt is no longer active');
    this.name = 'ProviderProxyAdmissionError';
    this.code = 'PROVIDER_PROXY_ADMISSION_REJECTED';
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
    } else if (context && event && event.phase === 'end') {
      context.openActivity = null;
    }
    if (typeof options.onActivity === 'function') return options.onActivity(event);
    return undefined;
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
    if (error instanceof ProviderProxyAdmissionError) return reject(res);
    if (typeof next === 'function') return next(error);
    throw error;
  }

  function invoke(handler, req, res, next) {
    const context = contextFor(req);
    let result;
    try {
      const call = () => handler(req, res, next);
      result = context ? requestContext.run(context, call) : call();
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
    if (context) {
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
      if (!decision || decision.ok !== true) throw new ProviderProxyAdmissionError();
    }
    return getProvider(appType, providerId);
  }

  return Object.freeze({ app, getProvider: guardedGetProvider, onActivity });
}

module.exports = {
  ProviderProxyAdmissionError,
  classifyProviderProxyRoute,
  createProviderProxyAdmission,
  createProviderProxyGuard,
  routeSegments,
};
