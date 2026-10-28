'use strict';

// A ws-shaped socket that reaches Chrome through the local CDP gateway
// (native/cdpd, managed by src/cdpd.js). Anything written against the `ws` API —
// src/chrome-cdp.js in particular — uses it unchanged.
//
// Chrome 144+ asks "Allow remote debugging?" once per WebSocket connection to a
// live browser. The gateway keeps one approved connection per Chrome; every
// socket opened here is a local stream to it, so the user approves once.
//
// The rule that makes this work: once the gateway has ACCEPTED a connection we
// never fall back to a direct WebSocket. The gateway may be waiting for the user
// to click Allow, and a direct connection at that moment is a second dialog.
// Direct is only for "there is no gateway" (disabled, not built, would not
// start) or a request the gateway turns down on principle (a non-local Chrome).
//
// Events: 'open' (ready), 'message' (Buffer, one CDP frame), 'error' (Error with
// .code), 'close', and 'pending' when Chrome has not answered within a second —
// it is almost certainly showing the approval dialog, so callers should keep
// waiting instead of giving up after their usual connect timeout.
//
// Wire format: docs/desktop-agent-protocol.md §4.4.

const net = require('net');
const { EventEmitter } = require('events');

const cdpd = require('./cdpd');

const WS_OPTIONS = { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 };

// Refusals after which connecting directly is still sound. Everything else
// (cooldown after a denied dialog, approval timeout, Chrome rejected us) would
// just put another dialog in front of the user.
const DIRECT_FALLBACK_CODES = new Set(['bad-request']);

function createLineReader(onLine) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  };
}

// A control line shares the stream with CDP frames: it has `ok` and neither
// `id` nor `method`.
function asControl(line) {
  if (!line.startsWith('{"ok"')) return null;
  try {
    const message = JSON.parse(line);
    return message.id === undefined && message.method === undefined ? message : null;
  } catch (_) {
    return null;
  }
}

function gatewayError(message) {
  const error = new Error(`${message.error}${message.detail ? `: ${message.detail}` : ''}`);
  error.code = message.error;
  if (message.retryAfterMs !== undefined) error.retryAfterMs = message.retryAfterMs;
  return error;
}

// The first gateway connection of a process makes sure the RIGHT gateway runs:
// starts it, or swaps out an older one (src/cdpd.js decides when that is safe).
// After that it is one ping per process, not per connection. A failed check is
// not fatal: the connection attempt below has its own fallbacks.
const preflights = new WeakMap();
const provisioners = new WeakMap();
function provisionerFor(env) {
  if (env === process.env) return cdpd.sharedCdpdProvisioner();
  if (!provisioners.has(env)) provisioners.set(env, cdpd.createCdpdProvisioner({ env }));
  return provisioners.get(env);
}
function preflight(provisioner, env) {
  if (!provisioner || cdpd.autostartDisabled(env)) return Promise.resolve(null);
  let pending = preflights.get(provisioner);
  if (!pending) {
    pending = Promise.resolve().then(() => provisioner.ensure()).catch(() => null);
    preflights.set(provisioner, pending);
    // Re-check later in a long-lived process: the gateway may have idled out.
    pending.then(() => setTimeout(() => preflights.delete(provisioner), 60_000).unref?.());
  }
  return pending;
}

function openCdpSocket(wsUrl, options = {}) {
  const {
    env = process.env,
    WebSocketImpl = require('ws'),
    provisioner = provisionerFor(env),
    netModule = net,
    acceptTimeoutMs = 1500,
    pendingAfterMs = 1000,
    lane = null,
  } = options;

  const socket = new EventEmitter();
  // connecting → accepted → open → closed; 'direct' once we gave up on the gateway.
  let state = 'connecting';
  let relay = null;
  let direct = null;
  let closedByUser = false;
  let autostarted = false;
  let pendingTimer = null;
  socket.transport = null;
  socket.closeReason = null;

  const clearPending = () => { if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; } };

  function failBeforeOpen(error) {
    if (state === 'open' || state === 'closed') return;
    state = 'closed';
    clearPending();
    if (!closedByUser) socket.emit('error', error);
  }

  function goDirect(reason) {
    if (closedByUser || direct) return;
    state = 'direct';
    relay = null;
    socket.transport = 'direct';
    socket.fallbackReason = reason;
    try { direct = new WebSocketImpl(wsUrl, WS_OPTIONS); }
    catch (error) { failBeforeOpen(error); return; }
    direct.on('open', () => { state = 'open'; socket.emit('open'); });
    direct.on('message', (raw) => socket.emit('message', Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw))));
    direct.on('error', (error) => {
      if (state === 'open') socket.emit('error', error);
      else failBeforeOpen(error);
    });
    direct.on('close', () => {
      if (state === 'open') { state = 'closed'; if (!closedByUser) socket.emit('close'); }
      else failBeforeOpen(new Error('CDP socket closed before it opened'));
    });
  }

  function viaGateway() {
    let connection;
    let acceptTimer = null;
    // error and close both report one failed attempt; only the first one counts.
    let attemptOver = false;

    const unreachable = (error) => {
      if (attemptOver || state !== 'connecting') return;
      attemptOver = true;
      clearTimeout(acceptTimer);
      try { connection && connection.destroy(); } catch (_) { /* gone */ }
      const missing = error && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED');
      if (missing && !autostarted && !cdpd.autostartDisabled(env) && provisioner) {
        // Not running (idle exit, crash, first use): start it and try once more.
        autostarted = true;
        Promise.resolve(provisioner.ensure()).then((result) => {
          if (closedByUser || state !== 'connecting') return;
          if (result && (result.action === 'started' || result.action === 'already-running')) viaGateway();
          else goDirect(`gateway ${result ? (result.reason || result.action) : 'unavailable'}`);
        }, (err) => goDirect(`gateway start failed: ${err.message}`));
        return;
      }
      goDirect(error ? error.message : 'gateway unavailable');
    };

    const onControl = (message) => {
      if (message.ok === true && message.phase === 'accepted') {
        if (state !== 'connecting') return;
        state = 'accepted';
        attemptOver = true;
        clearTimeout(acceptTimer);
        socket.transport = 'gateway';
        pendingTimer = setTimeout(() => { pendingTimer = null; socket.emit('pending'); }, pendingAfterMs);
        pendingTimer.unref?.();
        return;
      }
      if (message.ok === true && message.phase === 'ready') {
        if (state !== 'accepted') return;
        clearPending();
        state = 'open';
        socket.mode = message.mode;
        socket.emit('open');
        return;
      }
      if (message.ok === true) {
        // A protocol-1 gateway (no phases). Its sharing semantics are unsafe;
        // treat it as no gateway rather than half-speak its protocol.
        if (state === 'connecting') { attemptOver = true; clearTimeout(acceptTimer); connection.destroy(); goDirect('incompatible gateway'); }
        return;
      }
      socket.closeReason = message;
      if (state === 'connecting' && DIRECT_FALLBACK_CODES.has(message.error)) {
        attemptOver = true;
        clearTimeout(acceptTimer);
        connection.destroy();
        goDirect(message.error);
        return;
      }
      if (state === 'connecting' || state === 'accepted') {
        attemptOver = true;
        clearTimeout(acceptTimer);
        connection.destroy();
        failBeforeOpen(gatewayError(message));
      }
      // When open, the close that follows reports it; closeReason says why.
    };

    const read = createLineReader((line) => {
      const control = asControl(line);
      if (control) { onControl(control); return; }
      if (state === 'open') socket.emit('message', Buffer.from(line));
    });

    try { connection = netModule.createConnection({ path: cdpd.socketPath(env) }); }
    catch (error) { unreachable(error); return; }
    relay = connection;
    // Only reaching the gateway is bounded here. Waiting for Chrome (the approval
    // dialog) is the caller's budget — see the 'pending' event.
    acceptTimer = setTimeout(() => unreachable(new Error('the CDP gateway did not answer')), acceptTimeoutMs);
    acceptTimer.unref?.();

    connection.on('connect', () => {
      const hello = { op: 'cdp', wsUrl };
      if (lane) hello.lane = lane;
      connection.write(`${JSON.stringify(hello)}\n`);
    });
    connection.on('data', (chunk) => read(chunk.toString('utf8')));
    connection.on('error', (error) => unreachable(error));
    connection.on('close', () => {
      if (relay === connection) relay = null;
      if (state === 'connecting') { unreachable(new Error('the CDP gateway closed the connection')); return; }
      if (state === 'accepted') {
        failBeforeOpen(gatewayError(socket.closeReason || { error: 'cdp-gateway-closed' }));
        return;
      }
      if (state === 'open') {
        state = 'closed';
        if (!closedByUser) socket.emit('close');
      }
    });
  }

  if (cdpd.gatewayDisabled(env)) goDirect('disabled');
  else {
    preflight(provisioner, env).then((result) => {
      if (closedByUser || state !== 'connecting') return;
      // A gateway that speaks another protocol and would not stop: never send
      // it a hello — an old one connects to Chrome before answering, and our
      // direct socket after that would be a second dialog.
      if (result && result.reason === 'incompatible-running') goDirect('incompatible gateway');
      else viaGateway();
    });
  }

  socket.send = (data) => {
    if (closedByUser) return;
    if (direct) { direct.send(data); return; }
    if (!relay) throw new Error('CDP socket is not open');
    relay.write(`${data}\n`);
  };

  socket.close = () => {
    if (closedByUser) return;
    closedByUser = true;
    clearPending();
    if (relay) { try { relay.destroy(); } catch (_) { /* gone */ } relay = null; }
    if (direct) { try { direct.close(); } catch (_) { /* gone */ } }
  };

  return socket;
}

module.exports = {
  openCdpSocket,
  createLineReader,
  DIRECT_FALLBACK_CODES,
};
