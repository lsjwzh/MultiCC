'use strict';

// HTTP authentication surface: cookie/token login, the auth gate middleware,
// the /api shutdown gate, and the cookie/ws-ticket exchange endpoints.
//
// Rust owns the general admission policies. Node keeps Express mounting,
// body parsers and live host ports while the HTTP/WS transport migrates.
// Credentials and shutdown state are read on each request, never snapshotted.

const { getNative } = require('../native/runtime');

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
    isRequestPeerAllowed = () => true,
    authorizeScopedRequest = () => false,
    allowLegacyTokenQuery = false,
    handleServiceRequest = () => false,
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
    allowLegacyTokenQuery, handleServiceRequest, normalizeRedirect, escapeHtmlAttribute });
  function authCookieHeader(req, value) {
    return getNative().httpEntryCookie(req, entryPort, value);
  }
  function isAuthenticated(req) {
    return getNative().httpEntryAuthenticated(req, entryPort);
  }
  const gate = stage => (req, res, next) => getNative().httpEntryGate(stage, req, res, next, entryPort);

  const route = stage => (req, res) => getNative().httpAuthRoute(stage, req, res, entryPort);

  function mountRoutes(app) {
    app.use('/api', gate('shutdown'));
    app.use(gate('peer'));

    app.get('/login', route('login-page'));
    app.post('/login', express.urlencoded({ extended: false }), route('login'));
    app.get('/logout', route('logout'));
    app.use(gate('auth'));
    app.post('/api/auth/exchange', route('exchange'));
    app.post('/api/auth/ws-ticket', express.json({ limit: '4kb' }), route('ws-ticket'));

  }

  return { mountRoutes, isAuthenticated, authCookieHeader };
}

module.exports = { createAuthRuntime };
