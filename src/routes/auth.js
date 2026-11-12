'use strict';

// HTTP authentication surface: cookie/token login, the auth gate middleware,
// the /api shutdown gate, and the cookie/ws-ticket exchange endpoints.
//
// Rust owns the general admission policies. Node keeps Express mounting,
// body parsers and live host ports while the HTTP/WS transport migrates.
// Credentials and shutdown state are read on each request, never snapshotted.

const { getNative } = require('../native/runtime');
const { isGatewayChild } = require('../gateway-child');

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`[auth] ${name} must be a function`);
  }
}

function createAuthRuntime(rawDeps) {
  const deps = rawDeps || {};
  const {
    express,
    authSecurity,
    isLocalRequest,
    parseCookies,
    normalizeRedirect,
    escapeHtmlAttribute,
    metrics,
    logger,
    createErrorDto,
    getAccessToken,
    getShuttingDown,
    authorizeProviderRelayRequest = () => null,
    authorizeProviderRelayRequestAsync,
    isRequestPeerAllowed = () => true,
    authorizeScopedRequest = () => false,
    allowLegacyTokenQuery = false,
  } = deps;

  if (!express || typeof express.urlencoded !== 'function' || typeof express.json !== 'function') {
    throw new TypeError('[auth] express (with urlencoded/json) is required');
  }
  if (!authSecurity
    || typeof authSecurity.createCookie !== 'function'
    || typeof authSecurity.verifyCookie !== 'function'
    || typeof authSecurity.verifyAccessToken !== 'function'
    || typeof authSecurity.issueWsTicket !== 'function') {
    throw new TypeError('[auth] authSecurity must expose cookie, access-token and WebSocket-ticket methods');
  }
  for (const [fn, name] of [
    [isLocalRequest, 'isLocalRequest'], [parseCookies, 'parseCookies'],
    [normalizeRedirect, 'normalizeRedirect'], [escapeHtmlAttribute, 'escapeHtmlAttribute'],
    [createErrorDto, 'createErrorDto'], [getAccessToken, 'getAccessToken'],
    [getShuttingDown, 'getShuttingDown'],
    [authorizeProviderRelayRequest, 'authorizeProviderRelayRequest'],
    [isRequestPeerAllowed, 'isRequestPeerAllowed'], [authorizeScopedRequest, 'authorizeScopedRequest'],
  ]) assertFunction(fn, name);
  if (!metrics || typeof metrics.inc !== 'function') {
    throw new TypeError('[auth] metrics.inc is required');
  }
  if (!logger || typeof logger.warn !== 'function') {
    throw new TypeError('[auth] logger.warn is required');
  }

  // Migration bridge: dynamic credentials, scoped authorizers and HTTP effects
  // stay in the host; Rust owns admission and its callback/response ordering.
  const entryPort = Object.freeze({ authSecurity, isLocalRequest, parseCookies,
    metrics, logger, createErrorDto, getAccessToken, getShuttingDown,
    authorizeProviderRelayRequest, isRequestPeerAllowed, authorizeScopedRequest,
    allowLegacyTokenQuery, normalizeRedirect, escapeHtmlAttribute });
  function authCookieHeader(req, value) {
    return getNative().httpEntryCookie(req, entryPort, value);
  }
  function isAuthenticated(req) {
    return getNative().httpEntryAuthenticated(req, entryPort);
  }
  if (authorizeProviderRelayRequestAsync !== undefined) assertFunction(authorizeProviderRelayRequestAsync, 'authorizeProviderRelayRequestAsync');
  const gate = stage => (req, res, next) => {
    const native = getNative();
    if (stage !== 'auth' || !authorizeProviderRelayRequestAsync) return native.httpEntryGate(stage, req, res, next, entryPort);
    // Native code decides precisely where authority must be awaited. The host
    // only schedules the Promise and resumes the same native gate with its result.
    const deferred = {};
    let input;
    const prepared = native.httpEntryGate('auth-prepare', req, res, next, {
      ...entryPort, deferProviderRelay: value => { input = value; return deferred; },
    });
    if (prepared !== deferred) return prepared;
    const resume = resolver => {
      if (res.destroyed) return;
      return native.httpEntryGate('auth-resume', req, res, next, { ...entryPort, authorizeProviderRelayRequest: resolver });
    };
    return Promise.resolve().then(() => authorizeProviderRelayRequestAsync(input)).then(
      value => resume(() => value), error => resume(() => { throw error; }),
    ).catch(next);
  };

  const route = stage => (req, res) => getNative().httpAuthRoute(stage, req, res, entryPort);

  // Private gateway adapter: execute the same Rust admission owner against the
  // original wire request. Only Express effects are converted to a DTO here;
  // relay persistence, scoped grants and metrics keep their existing owners.
  function admitGatewayRequest(req) {
    return new Promise((resolve, reject) => {
      const headers = {};
      let status = 200;
      const res = {
        destroyed: false,
        status(value) { status = value; return this; },
        setHeader(name, value) { headers[name] = String(value); return this; },
        json(body) { resolve({ allowed: false, status, body, headers }); return this; },
        redirect(location) { resolve({ allowed: false, status: 302, location, headers }); return this; },
      };
      const admitted = error => error ? reject(error) : resolve({ allowed: true, headers });
      const authenticate = error => {
        if (error) return reject(error);
        return gate('auth')(req, res, admitted);
      };
      Promise.resolve().then(() => gate('peer')(req, res, authenticate)).catch(reject);
    });
  }

  function mountRoutes(app) {
    app.use('/api', gate('shutdown'));
    app.use(gate('peer'));

    if (!isGatewayChild()) {
      app.get('/login', route('login-page'));
      app.post('/login', express.urlencoded({ extended: false }), route('login'));
      app.get('/logout', route('logout'));
    }
    app.use(gate('auth'));
    if (!isGatewayChild()) {
      app.post('/api/auth/exchange', route('exchange'));
      app.post('/api/auth/ws-ticket', express.json({ limit: '4kb' }), route('ws-ticket'));
    }

  }

  return { mountRoutes, isAuthenticated, authCookieHeader, admitGatewayRequest };
}

module.exports = { createAuthRuntime };
