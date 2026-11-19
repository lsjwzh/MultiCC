'use strict';
// Frozen transcription of the /ws/chat replay-buffer write side, the chat
// client registry and the chat fan-out, captured 2026-11-19 as the
// differential oracle for multicc_core::chat_replay_buffer. The transcription
// is statement for statement so a drift shows up as a content/order
// difference, not a rewrite.
//
// Sources (line references are to the checkout the oracle was frozen from):
//   push         src/chat/turn-engine.js forwardProviderEvent:
//                  cs.streamReplay.push(tagged);
//                  if (cs.streamReplay.length > 500) cs.streamReplay.shift();
//   guarded push src/chat/provider-log-watchdog.js (two sites, same body):
//                  try { if (Array.isArray(cs.streamReplay)) { push; cap; } }
//                  catch (_) {}
//   clear        cs.streamReplay = [];  -- the same statement at every site:
//                  turn-engine.js (turn admission, fresh retry, the connect
//                  path's in-progress-assistant drop), src/chat/api-error-host.js
//                  (API-error retry), src/routes/session-lifecycle.js
//                  (restart-spawn reset), src/session-work/host.js (cancel).
//   registry     cs.clients is a JavaScript Set of sockets: add is a no-op
//                when the socket is already present (the entry keeps its
//                position), delete removes it, clear empties it; iteration is
//                insertion order. The ws close handler's cleanup closure
//                deletes the socket from the one session it joined.
//   destroy      src/routes/session-lifecycle.js and server.js: every client
//                of the session is terminated in iteration order, then the
//                chatSessions entry is deleted; the next lookup builds a new
//                state with an empty buffer and no clients.
//   fan-out      server.js broadcastTo:
//                  const json = JSON.stringify(createWsEnvelope(payload));
//                  for (const client of clients) {
//                    if (client.readyState === WebSocket.OPEN) {
//                      try { client.send(json); } catch (_) {}
//                    }
//                  }
//                One encode, insertion order, only OPEN sockets; a throwing
//                send is swallowed and does not stop the remaining sends.

const REPLAY_BUFFER_CAP = 500;

function createChatSessions() {
  return new Map();
}

// chatSessions.get(id) || create: the state is created on first use.
function chatState(sessions, id) {
  let cs = sessions.get(id);
  if (!cs) {
    cs = { streamReplay: [], clients: new Set() };
    sessions.set(id, cs);
  }
  return cs;
}

// The unguarded production push (turn-engine's forwardProviderEvent).
function pushReplay(cs, frame) {
  cs.streamReplay.push(frame);
  if (cs.streamReplay.length > REPLAY_BUFFER_CAP) cs.streamReplay.shift();
}

// The watchdog variant: identical operation under an Array.isArray guard and
// a swallowed throw. State built by chatState always passes the guard; the
// transcription keeps it so foreign state sees the no-op the watchdog had.
function pushReplayGuarded(cs, frame) {
  try {
    if (Array.isArray(cs.streamReplay)) {
      cs.streamReplay.push(frame);
      if (cs.streamReplay.length > REPLAY_BUFFER_CAP) cs.streamReplay.shift();
    }
  } catch (_) {}
}

// Every clear site assigns a fresh array. No reader holds the old array
// (each re-reads cs.streamReplay), so contents are what is compared.
function clearReplay(cs) {
  cs.streamReplay = [];
}

function joinClient(cs, client) {
  cs.clients.add(client);
}

function leaveClient(cs, client) {
  cs.clients.delete(client);
}

function clearClients(cs) {
  cs.clients.clear();
}

// The ws close handler for a socket that joined exactly one session.
function detachClient(sessions, client) {
  for (const cs of sessions.values()) cs.clients.delete(client);
}

// Session destroy: terminate every client in order, drop the whole state.
function destroySession(sessions, id, terminate) {
  const cs = sessions.get(id);
  if (cs) {
    for (const client of cs.clients || []) {
      try { terminate(client); } catch (_) {}
    }
  }
  sessions.delete(id);
}

// broadcastTo: returns the ids send() was attempted for, in order. `open`
// stands for `client.readyState === WebSocket.OPEN`; `send` may throw.
function fanOut(cs, payload, open, send) {
  const json = JSON.stringify(payload);
  const attempted = [];
  for (const client of cs.clients) {
    if (open(client)) {
      attempted.push(client);
      try { send(client, json); } catch (_) {}
    }
  }
  return attempted;
}

module.exports = {
  REPLAY_BUFFER_CAP,
  createChatSessions,
  chatState,
  pushReplay,
  pushReplayGuarded,
  clearReplay,
  joinClient,
  leaveClient,
  clearClients,
  detachClient,
  destroySession,
  fanOut,
};
