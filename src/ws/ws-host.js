'use strict';

// Construction of the one native WS host. It lives in its own module so the
// composition root can build it before the connection router is mounted: the
// chat turn engine's replay hub and the router must share the same host (one
// connection registry, one send queue per socket, one chat session table).
const { getNative } = require('../native/runtime');

function createWsHost() {
  const anchor = {};
  const host = new (getNative().RustWsHost)(anchor);
  // The native side holds the anchor's realm; keep it reachable for the
  // host's lifetime.
  Object.defineProperty(host, Symbol('ws host anchor'), { value: anchor });
  return host;
}

module.exports = { createWsHost };
