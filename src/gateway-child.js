'use strict';

// Node side of the Rust front door (multicc-gateway). See docs/gateway.md.
//
// The front door owns the public port and opens exactly one upstream connection
// per client. Before any client byte it writes a PROXY v1 line carrying the
// real peer address. This module binds the loopback-only internal port, parses
// that one line, and then hands the socket to the ordinary http.Server. Every
// existing decision that reads req.socket.remoteAddress therefore keeps working
// without a single change, and no forwarding headers are ever invented.
//
// Protocol version is mirrored in three places (docs/gateway.md §1):
// `multicc-gateway --version`, scripts/build-rust-kernels.js, and here.

const net = require('node:net');

const GATEWAY_PROTOCOL = 3;
const INTERNAL_HOST = '127.0.0.1';
// Max PROXY v1 line length including CRLF (docs/gateway.md §5).
const MAX_HEADER_BYTES = 107;
const HEADER_TIMEOUT_MS = 5000;
const PROXY_PREFIX = 'PROXY ';

// The flag alone is not proof: these variables leak into everything this server
// spawns — CLI sessions, and the tests and servers they start in turn. Such a
// `node server.js` would otherwise listen only on an internal port nobody
// forwards to. We are behind a front door only while our parent is the pid it
// announced.
function isGatewayChild(env = process.env, ppid = process.ppid) {
  return String((env && env.MULTICC_GATEWAY_CHILD) || '').trim() === '1'
    && String((env && env.MULTICC_GATEWAY_PID) || '').trim() === String(ppid);
}

// Returns the loopback port the front door reserved for this process, or null
// when unset/invalid. Callers fail closed rather than guessing a port.
function internalPort(env = process.env) {
  const raw = String((env && env.MULTICC_GATEWAY_INTERNAL_PORT) || '').trim();
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

// Strict PROXY v1: exactly `PROXY TCP4|TCP6 src dst sport dport`. `PROXY
// UNKNOWN`, trailing tokens, hostnames and family/address mismatches are all
// invalid and must destroy the connection (docs/gateway.md §5).
function parseProxyHeader(line) {
  const match = /^PROXY (TCP4|TCP6) (\S+) (\S+) (\d{1,5}) (\d{1,5})$/.exec(line.toString('latin1'));
  if (!match) return null;
  const [, transport, remoteAddress, localAddress, remotePort, localPort] = match;
  const family = transport === 'TCP4' ? 4 : 6;
  if (net.isIP(remoteAddress) !== family || net.isIP(localAddress) !== family) return null;
  const ports = [Number(remotePort), Number(localPort)];
  if (ports.some(port => port > 65535)) return null;
  return {
    remoteAddress,
    remotePort: ports[0],
    remoteFamily: family === 4 ? 'IPv4' : 'IPv6',
    localAddress,
    localPort: ports[1],
  };
}

// Shadow the net.Socket transport getters on this one instance. The front door
// is the only writer of the header, so this is the authoritative peer.
function installPeer(socket, peer) {
  for (const [name, value] of Object.entries(peer)) {
    Object.defineProperty(socket, name, { value, configurable: true, enumerable: true, writable: false });
  }
}

function listenBehindGateway(httpServer, { port, logger = console, headerTimeoutMs = HEADER_TIMEOUT_MS, onListening } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    logger.error('gateway_child_internal_port_invalid', { port });
    process.exit(1);
  }
  const sockets = new Set();
  const awaitingHeader = new Set();
  let closing = false;

  function failConnection(socket) {
    awaitingHeader.delete(socket);
    socket.destroy();
  }

  // Each internal connection must start with exactly one PROXY line. The line
  // may arrive split across TCP segments or arrive together with the first HTTP
  // request / WebSocket handshake; both cases are handled by buffering until
  // CRLF and unshifting the remainder before the http server takes over.
  // pauseOnConnect plus an explicit resume() makes the socket's initial flow
  // deterministic: without it Node may start reading before our 'data'
  // listener is attached and hand the PROXY line to the http parser.
  function handleConnection(socket) {
    sockets.add(socket);
    awaitingHeader.add(socket);
    socket.once('close', () => { sockets.delete(socket); awaitingHeader.delete(socket); });
    socket.on('error', () => {});
    let buffered = Buffer.alloc(0);
    let settled = false;

    const timeout = setTimeout(() => fail(), headerTimeoutMs);
    timeout.unref();

    function fail() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      failConnection(socket);
    }

    function onData(chunk) {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
      // Reject a first packet that can never be a PROXY line as soon as the
      // mismatch is visible, instead of waiting for more bytes.
      const prefixLength = Math.min(buffered.length, PROXY_PREFIX.length);
      if (buffered.subarray(0, prefixLength).toString('latin1') !== PROXY_PREFIX.slice(0, prefixLength)) return fail();
      const end = buffered.indexOf('\r\n');
      if (end < 0) {
        // Longest valid pre-CRLF content is MAX_HEADER_BYTES - 2.
        if (buffered.length > MAX_HEADER_BYTES - 1) fail();
        return;
      }
      if (end + 2 > MAX_HEADER_BYTES) return fail();
      const peer = parseProxyHeader(buffered.subarray(0, end));
      if (!peer) return fail();
      settled = true;
      clearTimeout(timeout);
      socket.removeListener('data', onData);
      socket.pause();
      const rest = buffered.subarray(end + 2);
      if (rest.length) socket.unshift(rest);
      installPeer(socket, peer);
      awaitingHeader.delete(socket);
      // http.Server's connection listener only depends on the socket events;
      // emitting it directly is what makes both requests and 'upgrade' work.
      httpServer.emit('connection', socket);
      socket.resume();
    }

    socket.on('data', onData);
    socket.resume();
  }

  const listener = net.createServer({ pauseOnConnect: true }, handleConnection);

  // host-lifecycle and lan-discovery read `server.listening` / call
  // server.close(); keep those call sites unchanged by making the internal
  // listener the http server's public lifecycle surface.
  Object.defineProperty(httpServer, 'listening', {
    configurable: true,
    enumerable: true,
    get: () => listener.listening && !closing,
  });
  httpServer.address = function address() { return listener.address(); };
  httpServer.close = function close(callback) {
    const done = typeof callback === 'function' ? callback : () => {};
    if (closing) return void process.nextTick(done, Object.assign(new Error('Server is not running'), { code: 'ERR_SERVER_NOT_RUNNING' }));
    closing = true;
    // Clients still sending the PROXY line carry no request yet: drop them.
    for (const socket of awaitingHeader) socket.destroy();
    if (!listener.listening) return void process.nextTick(done);
    // net.Server.close() stops accepting and its callback fires once every
    // accepted connection has ended — the same drain semantics as before.
    listener.close(() => done());
    if (typeof httpServer.closeIdleConnections === 'function') httpServer.closeIdleConnections();
  };

  listener.once('error', err => {
    logger.error('gateway_child_listen_failed', { host: INTERNAL_HOST, port, error: err.message, code: err.code });
    // The front door retries with a fresh internal port (docs/gateway.md §4).
    process.exit(err.code === 'EADDRINUSE' ? 75 : 1);
  });
  listener.listen(port, INTERNAL_HOST, () => {
    // http.Server starts tracking live connections (the set behind
    // closeIdleConnections()/closeAllConnections()) from its own 'listening'
    // event. We never call httpServer.listen(), so emit it once before any
    // connection exists; otherwise the 2s hard-close watchdog is a no-op.
    httpServer.emit('listening');
    logger.info('gateway_child_listening', { host: INTERNAL_HOST, port, protocol: GATEWAY_PROTOCOL });
    if (typeof onListening === 'function') onListening();
  });

  return {
    listener,
    get port() {
      const address = listener.address();
      return address && address.port;
    },
    close(callback) { httpServer.close(callback); },
    connectionCount() { return sockets.size; },
  };
}

// The front door hands us a stdin pipe it never writes (docs/gateway.md §3).
// EOF means it is gone — clean exit, crash or SIGKILL alike — and an orphaned
// server would keep running every timer and CLI turn next to its replacement.
// Shut down the normal way (SIGINT → gracefulShutdown). During early boot the
// SIGINT handler may not exist yet; the default action would kill the process
// mid-migration, so wait for the handler instead. This is also how the front
// door stops us on Windows, which has no signals: there process.kill(pid,
// 'SIGINT') terminates outright, so the handlers are invoked in-process.
function raiseSigint(platform = process.platform) {
  if (platform === 'win32') process.emit('SIGINT', 'SIGINT');
  else process.kill(process.pid, 'SIGINT');
}

function watchGatewayLifeline({ env = process.env, stdin = process.stdin, logger = console,
  signal = () => raiseSigint(), hasHandler = () => process.listenerCount('SIGINT') > 0,
  retryMs = 1000 } = {}) {
  if (!isGatewayChild(env) || !stdin || stdin.isTTY) return false;
  let lost = false;
  const onLost = () => {
    if (lost) return;
    lost = true;
    logger.warn('gateway_lifeline_lost', { action: 'graceful-shutdown' });
    const fire = () => {
      if (hasHandler()) return signal();
      setTimeout(fire, retryMs).unref();
    };
    fire();
  };
  stdin.on('end', onLost);
  stdin.on('close', onLost);
  stdin.on('error', onLost);
  stdin.resume();
  return true;
}

module.exports = {
  GATEWAY_PROTOCOL,
  MAX_HEADER_BYTES,
  HEADER_TIMEOUT_MS,
  isGatewayChild,
  internalPort,
  parseProxyHeader,
  listenBehindGateway,
  watchGatewayLifeline,
  raiseSigint,
};
