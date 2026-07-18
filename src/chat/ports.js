'use strict';

// Future server.js glue should implement only these narrow capabilities. The
// pure core never imports their concrete Express/WS/fs/child-process adapters.
const CHAT_TURN_PORTS = Object.freeze({
  history: Object.freeze(['findDelivery', 'appendUserMessage']),
  runner: Object.freeze(['interrupt', 'spawn']),
  providerRoute: Object.freeze(['resolve']),
  postTurn: Object.freeze(['deliver']),
});

function assertChatTurnPorts(ports) {
  if (!ports || typeof ports !== 'object') throw new TypeError('chat turn ports are required');
  for (const [name, methods] of Object.entries(CHAT_TURN_PORTS)) {
    const port = ports[name];
    if (!port || typeof port !== 'object') throw new TypeError(`chat turn port missing: ${name}`);
    for (const method of methods) {
      if (typeof port[method] !== 'function') throw new TypeError(`chat turn port missing: ${name}.${method}`);
    }
  }
  return ports;
}

module.exports = { CHAT_TURN_PORTS, assertChatTurnPorts };
