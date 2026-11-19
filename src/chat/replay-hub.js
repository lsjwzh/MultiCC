'use strict';

// JavaScript face of the /ws/chat replay buffer and client membership.
//
// The state is NOT held here. Both the per-session 500-frame replay buffer and
// the ordered set of live clients belong to the native `RustWsHost` (the same
// owner as the connection registry and the send queues), so a frame is
// buffered, fanned out and replayed by one owner with one ordering. This
// module only encodes events and forwards calls; it keeps no array, Set or
// counter of its own.
//
// Frames are stored already encoded as `JSON.stringify(createWsEnvelope(event))`.
// That is byte-identical to the retired burst-time encode because the buffered
// event is never mutated after the push: `tagProviderAttemptEvent` freezes it,
// and `chatErrors.annotate` / `scopeHostProviderEvent` / the task-context
// broadcast all copy before adding fields (so buffered frames never carry
// `errorClientMsgId`, `providerRouteScope` or `taskId`, exactly as before).
const { createWsEnvelope } = require('../api-contract');
const { createWsHost } = require('../ws/ws-host');

function createChatReplayHub({ host }) {
  if (!host || typeof host.replayPush !== 'function' || typeof host.fanOut !== 'function') {
    throw new TypeError('[chat-replay-hub] a native RustWsHost with chat session support is required');
  }
  const encode = payload => JSON.stringify(createWsEnvelope(payload));

  return Object.freeze({
    // ---- replay buffer -------------------------------------------------
    // Never throws: the retired `cs.streamReplay.push(event)` could not, and
    // an event the envelope rejects (no string `type`) was never deliverable
    // at burst time either (the per-frame try/catch swallowed it).
    push(sessionId, event) {
      let frame;
      try { frame = encode(event); } catch (_) { return false; }
      host.replayPush(sessionId, frame);
      return true;
    },
    clear(sessionId) { host.replayClear(sessionId); },
    size(sessionId) { return host.replayLen(sessionId); },
    // Decoded events, for the dispatch progress reducer (read-only consumer).
    events(sessionId) {
      const out = [];
      for (const frame of host.replayFrames(sessionId)) {
        try { out.push(JSON.parse(frame)); } catch (_) {}
      }
      return out;
    },
    // The reconnect burst: one native send per buffered frame, in order, past
    // the message-count tripwire. Returns how many frames were sent.
    burst(connectionId, sessionId) { return host.replayBurst(connectionId, sessionId); },

    // ---- live clients --------------------------------------------------
    join(sessionId, connectionId) { host.clientJoin(sessionId, connectionId); },
    leave(sessionId, connectionId) { host.clientLeave(sessionId, connectionId); },
    clearClients(sessionId) { host.clientClear(sessionId); },
    clientCount(sessionId) { return host.clientCount(sessionId); },
    // Read-only stand-in for the retired `cs.clients` Set: only `.size` is
    // readable, so a stray `.add()` / `.delete()` throws instead of silently
    // forking the membership.
    clientsOf(sessionId) {
      return Object.freeze({ get size() { return host.clientCount(sessionId); } });
    },
    // broadcastTo for one chat session: encode once, send to every OPEN member
    // in membership order. Returns how many sends were attempted.
    broadcast(sessionId, payload) { return host.fanOut(sessionId, encode(payload)); },

    // ---- lifecycle -----------------------------------------------------
    // Session destroy: terminate every member, then forget the session.
    drop(sessionId) { return host.sessionDrop(sessionId); },
    // A chat state is created or discarded without touching its sockets.
    reset(sessionId) { host.sessionReset(sessionId); },
  });
}

// The composition root's one call: build the native WS host, the replay hub on
// top of it, and tie the hub's per-session state to the chat session table so
// every path that discards a chat state (delete, clear, relocate, reset) also
// forgets its buffer and membership.
function createChatReplayRuntime(chatSessions) {
  const wsHost = createWsHost();
  const chatReplay = createChatReplayHub({ host: wsHost });
  chatSessions.onForget(chatReplay.reset);
  return { wsHost, chatReplay };
}

module.exports = { createChatReplayHub, createChatReplayRuntime };
