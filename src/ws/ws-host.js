'use strict';

// Construction of the one native WS host. It lives in its own module so the
// composition root can build it before the connection router is mounted: the
// chat turn engine's replay hub and the router must share the same host (one
// connection registry, one send queue per socket, one chat session table).
const { getNative } = require('../native/binding');

function createWsHost() {
  // 在宿主一次完成对象展开和序列化，协议字段由 Rust 提供。
  const anchor = { stringifyWithFields: (value, fields) => JSON.stringify({ ...value, ...fields }) };
  const host = new (getNative().RustWsHost)(anchor);
  // The native side holds the anchor's realm; keep it reachable for the
  // host's lifetime.
  Object.defineProperty(host, Symbol('ws host anchor'), { value: anchor });
  return host;
}

function createChatReplayHub({ host }) {
  if (!host || typeof host.replayPushEvent !== 'function' || typeof host.fanOutEvent !== 'function') {
    throw new TypeError('[chat-replay-hub] a native RustWsHost with chat session support is required');
  }
  return Object.freeze({
    push: host.replayPushEvent.bind(host),
    clear: host.replayClear.bind(host),
    size: host.replayLen.bind(host),
    events: host.replayEvents.bind(host),
    burst: host.replayBurst.bind(host),
    join: host.clientJoin.bind(host),
    leave: host.clientLeave.bind(host),
    clearClients: host.clientClear.bind(host),
    clientCount: host.clientCount.bind(host),
    clientsOf(sessionId) {
      return Object.freeze({ get size() { return host.clientCount(sessionId); } });
    },
    broadcast: host.fanOutEvent.bind(host),
    drop: host.sessionDrop.bind(host),
    reset: host.sessionReset.bind(host),
  });
}

function createChatReplayRuntime(chatSessions) {
  const wsHost = createWsHost();
  const chatReplay = createChatReplayHub({ host: wsHost });
  chatSessions.onForget(chatReplay.reset);
  return { wsHost, chatReplay };
}

module.exports = { createWsHost, createChatReplayHub, createChatReplayRuntime };
