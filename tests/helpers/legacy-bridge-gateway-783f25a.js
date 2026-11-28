'use strict';
// gateway-core — shared gateway plumbing for MultiCC's IM bridges.
//
// Before this module, five IM bridges (WeChat iLink, Feishu, Telegram, Discord,
// Slack) each carried the same ~200 lines of copy-paste:
//
//   • gateway session lifecycle (create/switch/destroy/reset) that mutates the
//     server's persistedSessions Map,
//   • internal WebSocket client that connects to the local /ws/chat and
//     accumulates assistant text until `result`,
//   • echo suppression to keep the bot's own outbound text from being fed back
//     in as user input on the next inbound poll,
//   • message log ring buffer + SSE broadcast so the manage UI can watch the
//     bridge in real time,
//   • dispatch-marker stripping (<<dispatch target="…">…</dispatch>>) and the
//     assistant-turn flush that hands text to the platform-specific outbound.
//
// Every one of those was slightly different — enough that "just fix it in
// place" was risky. Extracting them into a single core with a small dependency
// contract keeps behaviour bit-for-bit identical (the adapters pass the exact
// same strings and knobs that were previously baked into their copy) while
// deleting the duplicated bodies. When we need to fix one of those concerns —
// e.g. tighten echo suppression, add correlation ids to the log — there is
// now one place to do it.
//
// Contract (in short)
// -------------------
//   const gw = createGatewayCore({
//     platform: 'Slack',                                // human-readable, used in log lines only
//     sessionId: '__slack_gateway__',                   // persisted session id
//     cwd: '~/.multicc/slack-gateway',                  // working dir for the gateway record
//     label: 'Slack Gateway',                           // sessions.json label
//     platformLabel: 'Slack',                           // "created", "history cleared" prefix
//     platformCommandLine: (rec) =>                     // /status footer line, adapter-specific
//         `📡 Socket Mode: ${appConnected ? '已建立' : '未建立'}`,
//     ...
//     sendPlatformText: async (text) => { /* adapter outbound */ },
//     isRunning: () => _running,                        // adapter's own running flag
//     bridgeHistoryFile,                                // from secure-config
//   })
//
//   // gw.state is the mutable slot the adapter reads from / writes into for
//   // things the adapter still owns (currentTarget etc.).
//   // gw.echo / gw.log / gw.gateway / gw.chatWs / gw.commandRouter / gw.buildRouter
//   // are stable groups; see individual JSDoc.
//
// The adapters keep everything platform-specific: SDK loading, inbound
// normalisation, outbound chunking, config load/save. Everything else — the
// shared plumbing that used to be 200-line copy-paste — lives here.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const WebSocket = require('ws');

// Regex used across every bridge to keep raw <<dispatch>> markers off the
// downstream platform. Defined here so adapters share the exact string.
const DISPATCH_MARKER_RE = /<<dispatch\s+target="[^"]+"\s*>[\s\S]*?<\/dispatch>>/g;

function stripDispatchMarkers(text) {
  return String(text || '')
    .replace(DISPATCH_MARKER_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Cheap normalising hash for echo suppression. First 200 chars of whitespace-
// collapsed text; adapters treat this as opaque.
function hashText(t) { return String(t).replace(/\s+/g, ' ').trim().slice(0, 200); }

// Echo store: { hash → expiry }. Legacy behaviour preserved exactly:
//   • add(t) stamps a 60s expiry on the current time,
//   • isEcho(t) sweeps expired entries first, then reports true on either an
//     exact match or a substring overlap ≥ 12 chars (the wechat-ilink comment
//     explains why: WeChat can echo our (possibly chunked) outbound as inbound
//     text, so we need overlap-not-just-equality; 12 chars keeps "确认"/"取消"
//     from being swallowed just because they appear in a prompt we sent).
function createEchoStore({ ttlMs = 60_000, now = () => Date.now() } = {}) {
  const seen = new Map();
  function add(t) { const h = hashText(t); if (h) seen.set(h, now() + ttlMs); }
  function isEcho(t) {
    const h = hashText(t);
    if (!h) return true;
    const nowMs = now();
    for (const [k, v] of seen) if (v < nowMs) seen.delete(k);
    for (const [k] of seen) {
      if (k === h) return true;
      const shorter = h.length <= k.length ? h : k;
      if (shorter.length >= 12 && (k.includes(h) || h.includes(k))) return true;
    }
    return false;
  }
  return { add, isEcho, _sweep: (nowMs = Date.now()) => {
    for (const [k, v] of seen) if (v < nowMs) seen.delete(k);
    return seen.size;
  }, _size: () => seen.size };
}

// Log ring + SSE broadcast. Adapters call log(type, text) for anything worth
// surfacing in the manage UI ("in", "out", "system", "error"). The Router
// helpers below wire /log and /events onto this store.
function createLogStore({ max = 300 } = {}) {
  let buffer = [];
  const sseClients = new Set();

  function push(type, text) {
    const entry = { type, text, ts: new Date().toISOString() };
    buffer.push(entry);
    if (buffer.length > max) buffer = buffer.slice(-max);
    const data = JSON.stringify(entry);
    for (const res of sseClients) {
      try { res.write(`data: ${data}\n\n`); } catch (_) { sseClients.delete(res); }
    }
  }

  function snapshot() { return buffer.slice(); }

  function filterSince(sinceMs) {
    if (!sinceMs) return buffer.slice();
    return buffer.filter(e => new Date(e.ts).getTime() > sinceMs);
  }

  function addClient(res) { sseClients.add(res); }
  function removeClient(res) { sseClients.delete(res); }

  return { push, snapshot, filterSince, addClient, removeClient, _size: () => buffer.length };
}

// Gateway session lifecycle. Every adapter has an identical create/switch/
// destroy/reset flow — the only variance is the string labels ("Feishu gateway
// created" vs "Discord gateway destroyed"). Take those as parameters and every
// adapter uses this untouched.
function createGatewayLifecycle({
  sessionId,
  cwd,
  label,
  platformLabel,          // "Slack", "Feishu", … — used in _log system messages
  persistedSessions,      // server's live Map
  chatSessions,           // server's live Map (chat sessions with claudeProc handles)
  savePersistedSessions,  // adapter passes the server's persistence hook
  bridgeHistoryFile,      // from secure-config; used only inside resetHistory()
  chatWsCtl,              // { disconnect, reconnectIfRunning } — created by createChatWsClient
  log,                    // (type, text) => void
}) {
  if (typeof persistedSessions?.get !== 'function') {
    throw new TypeError('gateway-core lifecycle: persistedSessions Map required');
  }

  function get() { return persistedSessions.get(sessionId) || null; }

  function create(cli) {
    if (get()) throw new Error(`${platformLabel} gateway already exists`);
    if (!['claude', 'codex'].includes(cli)) throw new Error('cli must be claude or codex');
    try { fs.mkdirSync(cwd, { recursive: true }); } catch (_) {}
    const rec = {
      id: sessionId,
      type: 'gateway',
      kind: 'chat',
      cli,
      cliSessionId: null,
      label,
      cwd,
      createdAt: new Date().toISOString(),
    };
    persistedSessions.set(sessionId, rec);
    savePersistedSessions();
    log('system', `${platformLabel} gateway created (cli=${cli})`);
    return rec;
  }

  // Switch the gateway between the two CLIs, blowing the chat WS + any live
  // per-turn child so the next turn re-spawns under the new binary. Legacy
  // behaviour of returning the existing record when cli is unchanged is kept.
  function switchCli(cli) {
    const rec = get();
    if (!rec) throw new Error(`${platformLabel} gateway does not exist`);
    if (!['claude', 'codex'].includes(cli)) throw new Error('cli must be claude or codex');
    if (rec.cli === cli) return rec;
    rec.cli = cli;
    rec.cliSessionId = null;
    savePersistedSessions();
    const cs = chatSessions?.get(sessionId);
    if (cs) {
      if (cs.claudeProc) { try { cs.claudeProc.kill('SIGTERM'); } catch (_) {} cs.claudeProc = null; }
      cs.cli = cli;
      cs.chatTurnCount = 0;
    }
    chatWsCtl.disconnect();
    chatWsCtl.reconnectIfRunning();
    log('system', `${platformLabel} gateway cli switched to ${cli}`);
    return rec;
  }

  function destroy() {
    const rec = get();
    if (!rec) return;
    chatWsCtl.disconnect();
    const cs = chatSessions?.get(sessionId);
    if (cs?.claudeProc) { try { cs.claudeProc.kill('SIGTERM'); } catch (_) {} }
    chatSessions?.delete(sessionId);
    persistedSessions.delete(sessionId);
    savePersistedSessions();
    log('system', `${platformLabel} gateway destroyed`);
  }

  function resetHistory() {
    const rec = get();
    if (!rec) return;
    const histFile = bridgeHistoryFile(sessionId);
    try { fs.unlinkSync(histFile); } catch (_) {}
    rec.cliSessionId = (rec.cli === 'claude') ? crypto.randomUUID() : null;
    savePersistedSessions();
    const cs = chatSessions?.get(sessionId);
    if (cs) {
      if (cs.claudeProc) { try { cs.claudeProc.kill('SIGTERM'); } catch (_) {} cs.claudeProc = null; }
      cs.chatTurnCount = 0;
    }
    chatWsCtl.disconnect();
    chatWsCtl.reconnectIfRunning();
    log('system', `${platformLabel} gateway history cleared`);
  }

  return { get, create, switchCli, destroy, resetHistory };
}

// Internal chat WebSocket client. Connects to /ws/chat as an ordinary client
// on 127.0.0.1, accumulates assistant text, and calls back to the adapter with
// the flushed turn on `result`. Reconnects (1500 ms backoff) whenever the WS
// drops AND the adapter is still running + the gateway exists.
//
// The `wsFactory` param lets tests substitute a fake WebSocket; production
// callers omit it and get the real `ws` package.
function createChatWsClient({
  port,
  sessionId,
  getGateway,           // () => gateway record | null
  isRunning,            // () => boolean; adapter's own running flag
  log,
  onTurn,               // async (text) => void   (called with dispatch-stripped assistant text)
  wsFactory = (url) => new WebSocket(url),
  reconnectDelayMs = 1500,
  hostLabel,            // "Slack" etc. for log lines. Falls back to sessionId.
} = {}) {
  const banner = hostLabel || sessionId;

  // State kept as a closure so the adapter can't accidentally clobber
  // half-accumulated text with `Object.assign(state, ...)`.
  let ws = null;
  let reconnectTimer = null;
  let currentAssistantText = '';
  let turnInProgress = false;

  function connect() {
    if (ws) return;
    if (!getGateway()) return;
    const url = `ws://127.0.0.1:${port}/ws/chat?session=${encodeURIComponent(sessionId)}`;
    const w = wsFactory(url);
    ws = w;
    w.on('open', () => log('system', `Connected to ${banner} gateway chat session`));
    w.on('message', (raw) => {
      let evt; try { evt = JSON.parse(raw.toString()); } catch (_) { return; }
      _handleChatEvent(evt);
    });
    w.on('close', () => {
      ws = null;
      if (isRunning() && getGateway()) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, reconnectDelayMs);
      }
    });
    w.on('error', (e) => log('error', `Chat WS error: ${e.message}`));
  }

  function disconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
    currentAssistantText = '';
    turnInProgress = false;
  }

  function reconnectIfRunning() { if (isRunning()) connect(); }

  // Wait for a CONNECTING socket to finish handshake, or a short timeout —
  // mirror the (max 2s) inline wait every adapter had before sending a message.
  async function ensureOpen(timeoutMs = 2000) {
    if (!ws || ws.readyState !== WebSocket.CONNECTING) return;
    await new Promise(resolve => {
      const t = setTimeout(resolve, timeoutMs);
      ws.once('open', () => { clearTimeout(t); resolve(); });
    });
  }

  function isOpen() { return !!(ws && ws.readyState === WebSocket.OPEN); }

  function sendUserMessage(text) {
    if (!isOpen()) {
      log('error', `${banner} gateway chat not connected — cannot deliver message`);
      return false;
    }
    currentAssistantText = '';
    turnInProgress = true;
    ws.send(JSON.stringify({ type: 'user_message', text }));
    return true;
  }

  // Adapter can override the event handler for exotic events, but the default
  // implements the exact assistant/result/error accumulation shared by all
  // five bridges.
  function _handleChatEvent(evt) {
    if (evt.type === 'assistant' && evt.message?.content) {
      for (const block of evt.message.content) {
        if (block.type === 'text' && block.text) currentAssistantText += block.text;
      }
      return;
    }
    if (evt.type === 'result') {
      const text = stripDispatchMarkers(currentAssistantText);
      currentAssistantText = '';
      turnInProgress = false;
      if (text) {
        Promise.resolve()
          .then(() => onTurn && onTurn(text))
          .catch(e => log('error', `Send to ${banner} failed: ${e && e.message}`));
      }
      return;
    }
    if (evt.type === 'system' && evt.subtype === 'init') return;
    if (evt.type === 'error') {
      log('error', `${banner} gateway: ${evt.error || 'unknown error'}`);
      turnInProgress = false;
    }
  }

  return {
    connect,
    disconnect,
    reconnectIfRunning,
    sendUserMessage,
    ensureOpen,
    isOpen,
    // Exposed for tests + tight-loop callers only:
    _feed: _handleChatEvent,
    _peekAssistantText: () => currentAssistantText,
    _peekTurnInProgress: () => turnInProgress,
  };
}

// Chunk text for platform-with-a-message-cap outbound. Returns an array of
// bodies, prefixed with "(续N) " for continuations, matching the legacy
// wechat/feishu/telegram/slack behaviour bit-for-bit.
function chunkOutbound(text, { max, continuationPrefix = (i) => `(续${i + 1}) ` } = {}) {
  if (!max || max < 1) throw new TypeError('chunkOutbound: max chunk length required');
  const chunks = [];
  let remaining = String(text || '');
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf('\n', max);
    if (cut <= 0) cut = max;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.trim()) chunks.push(remaining);
  return chunks.map((body, i) => (i === 0 ? body : `${continuationPrefix(i)}${chunks[i]}`));
}

module.exports = {
  DISPATCH_MARKER_RE,
  stripDispatchMarkers,
  hashText,
  createEchoStore,
  createLogStore,
  createGatewayLifecycle,
  createChatWsClient,
  chunkOutbound,
  // Node-provided modules the adapters would otherwise all require separately.
  // Re-exported so an adapter can `const { fs, path, os, express } = gwCore.deps`
  // and stay narrow.
  deps: { fs, path, os, crypto },
};
