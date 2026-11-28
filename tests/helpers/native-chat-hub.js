'use strict';

// A real native chat session table for deterministic tests. There is no JS
// double of the buffer or the membership: tests drive the same RustWsHost the
// product uses, with fake sockets that record what the fan-out and the replay
// burst actually send.
const { createChatReplayHub, createWsHost } = require('../../src/native/binding').wsHost;

const OPEN = 1;

function createTestChatHub() {
  const host = createWsHost();
  const sockets = new Map();
  // Global delivery order across every socket: (connection id, frame).
  const deliveries = [];
  const ports = {
    ping() {}, terminate(socket) { socket.terminated = true; },
    close(socket, code, reason) { socket.closedWith = { code, reason }; },
    schedule() { return null; }, cancelSchedule() {}, metric() {},
    backpressureLog() {}, heartbeatTimeout() {}, now: () => Date.now(),
    connPort: id => sockets.get(id)?.ports,
  };
  host.bindPorts(ports);
  const hub = createChatReplayHub({ host });

  // Register a fake client socket; `sent` collects the frames it received.
  function attach({ readyState = OPEN, throwOnSend = false } = {}) {
    const socket = { readyState, bufferedAmount: 0, sent: [], terminated: false, closedWith: null };
    const id = host.attach(socket, { path: '/ws/chat' }, false, Date.now());
    socket.ports = Object.create(ports);
    socket.ports.sendFrame = (target, data) => {
      if (throwOnSend) throw new Error('send failed');
      target.sent.push(data);
      deliveries.push({ id, data });
      host.sendResult(id, null, socket.ports);
    };
    sockets.set(id, socket);
    Object.defineProperty(socket, '_multiccConnId', { value: id });
    return { id, socket };
  }

  return { host, hub, attach, sockets, ports, deliveries };
}

module.exports = { createTestChatHub };
