'use strict';

// Compatibility exports only. Rust owns crypto, URL policy and the single
// ticket store; injected host callbacks preserve the existing test seams.
const { getNative } = require('./native/runtime');
const COOKIE_VERSION = 1;
const DEFAULT_COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_TICKET_TTL_MS = 30 * 1000;
function createAuthSecurity(options) {
  // The VM must see callback/metadata references to collect cycles. Rust owns
  // the slots and their lifecycle; this anchor contains no auth decisions.
  const anchor = {};
  const runtime = new (getNative().RustAuthSecurity)(options, anchor);
  Object.defineProperty(runtime, Symbol('auth host references'), { value: anchor });
  return {
    accessToken: () => runtime.accessToken(),
    setAccessToken: value => runtime.setAccessToken(value),
    shuttingDown: () => runtime.shuttingDown(),
    setShuttingDown: value => runtime.setShuttingDown(value),
    connectGateway: (port, capability) => runtime.connectGateway(port, capability),
    connectWorkspaceGateway: (owner, ...args) => owner.connectGateway(...args, runtime),
    createCookie: () => runtime.createCookie(),
    verifyCookie: cookie => runtime.verifyCookie(cookie),
    verifyAccessToken: value => runtime.verifyAccessToken(value),
    issueWsTicket: (path, metadata) => runtime.issueWsTicket(path, metadata),
    consumeWsTicket: (ticket, path) => runtime.consumeWsTicket(ticket, path),
    pruneTickets: () => runtime.pruneTickets(),
    ticketCount: () => runtime.ticketCount(),
  };
}
module.exports = {
  COOKIE_VERSION, DEFAULT_COOKIE_TTL_MS, DEFAULT_TICKET_TTL_MS, createAuthSecurity,
  timingSafeEqualText: (a, b) => getNative().authTimingSafeEqualText(a, b),
  normalizeRedirect: (value, fallback) => getNative().authNormalizeRedirect(value, fallback),
  normalizeWsPath: value => getNative().authNormalizeWsPath(value),
  escapeHtmlAttribute: value => getNative().authEscapeHtmlAttribute(value),
};
