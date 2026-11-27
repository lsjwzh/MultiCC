'use strict';

// The JavaScript half of the Rust WS host's send path. It patches `ws.send`
// so every frame is queued, coalesced and capped by the native wrapper, and
// re-exposes the retired `_multiccBackpressure` surface for its two remaining
// consumers: the turn engine's reconnect replay (`sendImmediate`) and the
// remote screen's pause check (`stats().queueBytes`).
//
// Every queueing decision is native; this file only forwards calls. The one
// error channel the retired patch had is preserved: `ws.send` never threw
// synchronously — a synchronous transport throw disconnected the socket and
// reached the producer through its send callback.
function installNativeQueue(ws, host, id, ports, registry) {
  if (ws._multiccBackpressure) return ws._multiccBackpressure;
  const originalSend = ws.send.bind(ws);
  // Per-connection ports: `sendFrame` closes over the real transport send and
  // reports completions with this connection's id, so the native transport
  // never re-enters the patched `ws.send`. Everything else (schedule, metric,
  // logs, close) is inherited from the shared router ports.
  const connPorts = Object.create(ports);
  connPorts.sendFrame = (socket, data, options) => originalSend(data, options, error => {
    try {
      host.sendResult(id, error ? String((error && error.message) || error) : null, connPorts);
    } catch (_) {}
  });
  // After detach the native entry is gone; the retired surface kept answering
  // on the closed socket with an emptied queue.
  const tombstone = () => ({ queueBytes: 0, queueMessages: 0, sending: false, congested: false, closed: true });
  const api = {
    sendImmediate(data, options, callback) {
      try { host.sendImmediate(id, data, options, callback, connPorts); } catch (_) {}
    },
    stats() {
      try {
        const snapshot = host.stats(id);
        return snapshot || tombstone();
      } catch (_) {
        return tombstone();
      }
    },
    flush() {
      try { host.flush(id, connPorts); } catch (_) {}
    },
  };
  ws.send = (data, options, callback) => {
    try {
      host.send(id, data, options, callback, connPorts);
    } catch (error) {
      const cb = typeof options === 'function' ? options : callback;
      if (typeof cb === 'function') {
        try { cb(error); } catch (_) {}
      }
    }
  };
  ws._multiccBackpressure = api;
  if (registry) registry.set(id, connPorts);
  return api;
}

module.exports = { installNativeQueue };
