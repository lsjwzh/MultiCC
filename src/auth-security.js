'use strict';

// Compatibility exports only. Rust owns crypto, URL policy and the single
// ticket store; injected host callbacks preserve the existing test seams.
const { getNative } = require('./native/runtime');
const COOKIE_VERSION = 1;
const DEFAULT_COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_TICKET_TTL_MS = 30 * 1000;
// Keep the callback's lexical scope separate from the owner. The native
// control task retains this function; only the facade retains the anchor.
function ticketMetadataReader(anchor) {
  const weak = new WeakRef(anchor);
  return (_error, slot) => {
    const slots = weak.deref()?.slots;
    if (!slots || !Object.hasOwn(slots, slot)) return null;
    const value = slots[slot];
    delete slots[slot];
    try {
      // Cross-process ticket consumers need only these admission fields and
      // the machine transport destination. Other VM values may be cyclic or
      // retain live callbacks and must not cross the boundary.
      const projected = {};
      for (const key of ['machineId', 'machineGrantId', 'fleetSessionId', 'fleetDirectoryId', 'requestId', 'correlationId']) {
        if (Object.hasOwn(value, key)) projected[key] = value[key];
      }
      if (Object.hasOwn(value, 'upstream')) {
        const upstream = value.upstream;
        const addresses = upstream?.addresses;
        projected.upstream = upstream == null ? upstream : { url: upstream.url,
          addresses: Array.isArray(addresses) ? addresses.map(entry => ({ address: entry?.address, family: entry?.family })) : addresses };
      }
      return JSON.stringify(projected);
    } catch { return null; }
  };
}
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
    connectGateway: (port, capability) => runtime.connectGateway(port, capability, ticketMetadataReader(anchor)),
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
