'use strict';

// PROXY v1 front-door contract for the Node side (docs/gateway.md §4/§5).
// These tests exercise the real listener, not a mock: a raw TCP client speaks
// PROXY + HTTP/WebSocket, exactly like multicc-gateway does.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const {
  GATEWAY_PROTOCOL,
  MAX_HEADER_BYTES,
  isGatewayChild,
  internalPort,
  parseProxyHeader,
  listenBehindGateway,
  watchGatewayLifeline,
  raiseSigint,
} = require('../src/gateway-child');
const { isLocalRequest, isPrivateRequestPeer } = require('../src/request-locality');

const quietLogger = { info() {}, warn() {}, error() {} };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(check, { timeoutMs = 3000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Starts a plain http.Server behind the PROXY listener and records what the
// application actually sees for each request.
async function startBehindGateway(t, { headerTimeoutMs, upgrade = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({
      url: req.url,
      headers: req.headers,
      remoteAddress: req.socket.remoteAddress,
      remotePort: req.socket.remotePort,
      remoteFamily: req.socket.remoteFamily,
      localAddress: req.socket.localAddress,
      localPort: req.socket.localPort,
      isLocal: isLocalRequest(req),
      isPrivate: isPrivateRequestPeer(req),
    });
    res.end(`ok:${req.url}`);
  });
  const upgrades = [];
  let wss = null;
  if (upgrade) {
    wss = new WebSocket.Server({ noServer: true });
    wss.on('connection', ws => ws.on('message', message => ws.send(`echo:${message}`)));
    server.on('upgrade', (req, socket, head) => {
      upgrades.push({ remoteAddress: req.socket.remoteAddress, remoteFamily: req.socket.remoteFamily });
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    });
  }
  const port = await freePort();
  const clients = [];
  const handle = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('listener did not start')), 3000);
    const started = listenBehindGateway(server, {
      port,
      logger: quietLogger,
      headerTimeoutMs,
      onListening: () => { clearTimeout(timer); resolve(started); },
    });
  });
  t.after(async () => {
    for (const client of clients) client.destroy();
    // A WebSocket connection is not in `clients`; force-close anything that a
    // graceful close is still draining so the test process can exit.
    await new Promise(resolve => {
      const timer = setTimeout(() => { try { server.closeAllConnections(); } catch {} resolve(); }, 200);
      timer.unref();
      handle.close(() => { clearTimeout(timer); resolve(); });
    });
  });
  return {
    port,
    server,
    requests,
    upgrades,
    connect() {
      const socket = net.connect(port, '127.0.0.1');
      const client = {
        socket,
        text: '',
        closed: false,
        write(chunk) { socket.write(chunk); },
        destroy() { socket.destroy(); },
      };
      socket.setEncoding('utf8');
      socket.on('data', chunk => { client.text += chunk; });
      socket.on('close', () => { client.closed = true; });
      socket.on('error', () => { client.closed = true; });
      clients.push(socket);
      return client;
    },
  };
}

const httpRequest = (url = '/', extra = '') => `GET ${url} HTTP/1.1\r\nHost: 127.0.0.1\r\n${extra}\r\n`;

test('protocol version and environment helpers fail closed', () => {
  assert.equal(GATEWAY_PROTOCOL, 2);
  // The three places docs/gateway.md §1 says must agree.
  const crate = fs.readFileSync(path.join(__dirname, '..', 'native', 'gateway', 'src', 'lib.rs'), 'utf8');
  assert.equal(Number(/pub const PROTOCOL_VERSION: u32 = (\d+);/.exec(crate)[1]), GATEWAY_PROTOCOL);
  assert.equal(require('../scripts/build-rust-kernels').GATEWAY_PROTOCOL, GATEWAY_PROTOCOL);
  assert.equal(isGatewayChild({ MULTICC_GATEWAY_CHILD: '1', MULTICC_GATEWAY_PID: '4242' }, 4242), true);
  assert.equal(isGatewayChild({ MULTICC_GATEWAY_CHILD: 'true', MULTICC_GATEWAY_PID: '4242' }, 4242), false);
  assert.equal(isGatewayChild({}), false);
  // Inherited by a restart or a launcher: the flag survives, the parent does
  // not. A direct start must then bind the public port, not a dead internal one.
  assert.equal(isGatewayChild({ MULTICC_GATEWAY_CHILD: '1', MULTICC_GATEWAY_PID: '4242' }, 1), false);
  assert.equal(isGatewayChild({ MULTICC_GATEWAY_CHILD: '1' }, 4242), false);
  assert.equal(internalPort({ MULTICC_GATEWAY_INTERNAL_PORT: '41234' }), 41234);
  assert.equal(internalPort({ MULTICC_GATEWAY_INTERNAL_PORT: '0' }), null);
  assert.equal(internalPort({ MULTICC_GATEWAY_INTERNAL_PORT: '65536' }), null);
  assert.equal(internalPort({ MULTICC_GATEWAY_INTERNAL_PORT: 'abc' }), null);
  assert.equal(internalPort({}), null);
});

test('PROXY v1 parsing accepts TCP4, TCP6 and IPv4-mapped peers, rejects everything else', () => {
  assert.deepEqual(parseProxyHeader(Buffer.from('PROXY TCP4 192.168.1.5 10.0.0.2 51234 3000')), {
    remoteAddress: '192.168.1.5', remotePort: 51234, remoteFamily: 'IPv4', localAddress: '10.0.0.2', localPort: 3000,
  });
  assert.deepEqual(parseProxyHeader(Buffer.from('PROXY TCP6 2001:db8::1 ::1 51234 3000')), {
    remoteAddress: '2001:db8::1', remotePort: 51234, remoteFamily: 'IPv6', localAddress: '::1', localPort: 3000,
  });
  assert.deepEqual(parseProxyHeader(Buffer.from('PROXY TCP6 ::ffff:192.168.1.5 ::ffff:10.0.0.2 51234 3000')), {
    remoteAddress: '::ffff:192.168.1.5', remotePort: 51234, remoteFamily: 'IPv6', localAddress: '::ffff:10.0.0.2', localPort: 3000,
  });
  for (const line of [
    'PROXY UNKNOWN',
    'PROXY UNKNOWN\r',
    'PROXY TCP4 192.168.1.5 10.0.0.2 51234',
    'PROXY TCP4 192.168.1.5 10.0.0.2 51234 3000 extra',
    'PROXY TCP4 2001:db8::1 10.0.0.2 51234 3000',   // family/address mismatch
    'PROXY TCP6 192.168.1.5 10.0.0.2 51234 3000',   // family/address mismatch
    'PROXY TCP4 host.example 10.0.0.2 51234 3000',  // hostnames are not addresses
    'PROXY TCP4 192.168.1.5 10.0.0.2 51234 65536',  // port out of range (also too long)
    'PROXY  TCP4 192.168.1.5 10.0.0.2 51234 3000',  // double space
    '',
  ]) {
    assert.equal(parseProxyHeader(Buffer.from(line)), null, line);
  }
});

test('header split byte-by-byte and request in the same segment both reach http', async t => {
  const gw = await startBehindGateway(t);

  const split = gw.connect();
  const payload = 'PROXY TCP4 203.0.113.9 127.0.0.1 5555 3000\r\n' + httpRequest('/split');
  for (const byte of payload) { split.write(byte); await sleep(1); }
  await waitFor(() => split.text.includes('ok:/split'), { label: 'split request' });

  const combined = gw.connect();
  combined.write('PROXY TCP6 ::ffff:192.168.1.5 ::ffff:127.0.0.1 6666 3000\r\n' + httpRequest('/combined'));
  await waitFor(() => combined.text.includes('ok:/combined'), { label: 'combined request' });

  assert.equal(gw.requests.length, 2);
  assert.equal(gw.requests[0].remoteAddress, '203.0.113.9');
  assert.equal(gw.requests[0].remotePort, 5555);
  assert.equal(gw.requests[0].remoteFamily, 'IPv4');
  assert.equal(gw.requests[0].localAddress, '127.0.0.1');
  assert.equal(gw.requests[0].localPort, 3000);
  assert.equal(gw.requests[1].remoteAddress, '::ffff:192.168.1.5');
  assert.equal(gw.requests[1].remoteFamily, 'IPv6');
});

test('request-locality sees the real peer: loopback is local, LAN is private, forwarded headers never lie', async t => {
  const gw = await startBehindGateway(t);
  const cases = [
    { line: 'PROXY TCP4 127.0.0.1 127.0.0.1 1111 3000', host: '127.0.0.1:3000', isLocal: true, isPrivate: true },
    { line: 'PROXY TCP6 ::1 ::1 1111 3000', host: '[::1]:3000', isLocal: true, isPrivate: true },
    { line: 'PROXY TCP4 192.168.1.20 127.0.0.1 2222 3000', host: 'localhost:3000', isLocal: false, isPrivate: true },
    { line: 'PROXY TCP6 ::ffff:127.0.0.1 ::1 3333 3000', host: 'localhost:3000', isLocal: true, isPrivate: true },
    { line: 'PROXY TCP4 203.0.113.9 127.0.0.1 4444 3000', host: 'localhost:3000', isLocal: false, isPrivate: false },
    // A client-supplied forwarding header arrives untouched and still forces external.
    { line: 'PROXY TCP4 127.0.0.1 127.0.0.1 5555 3000', host: '127.0.0.1:3000',
      extra: 'X-Forwarded-For: 203.0.113.9\r\n', isLocal: false, isPrivate: true },
  ];
  for (const [index, entry] of cases.entries()) {
    const client = gw.connect();
    client.write(entry.line + '\r\n' + `GET /case-${index} HTTP/1.1\r\nHost: ${entry.host}\r\n${entry.extra || ''}\r\n`);
    await waitFor(() => gw.requests.length > index, { label: `case ${index}` });
  }
  assert.deepEqual(cases.map((_, index) => ({
    isLocal: gw.requests[index].isLocal,
    isPrivate: gw.requests[index].isPrivate,
  })), cases.map(entry => ({ isLocal: entry.isLocal, isPrivate: entry.isPrivate })));
});

test('keep-alive reuses the connection and keeps the same peer identity', async t => {
  const gw = await startBehindGateway(t);
  const client = gw.connect();
  client.write('PROXY TCP4 10.1.2.3 127.0.0.1 7777 3000\r\n'
    + httpRequest('/one', 'Connection: keep-alive\r\n'));
  await waitFor(() => client.text.includes('ok:/one'), { label: 'first keep-alive request' });
  client.write(httpRequest('/two', 'Connection: keep-alive\r\n'));
  await waitFor(() => client.text.includes('ok:/two'), { label: 'second keep-alive request' });
  assert.equal(gw.requests.length, 2);
  assert.deepEqual(gw.requests.map(r => [r.remoteAddress, r.remotePort]), [['10.1.2.3', 7777], ['10.1.2.3', 7777]]);
});

test('WebSocket upgrade works through the PROXY listener', async t => {
  const gw = await startBehindGateway(t, { upgrade: true });
  const client = new WebSocket(`ws://127.0.0.1:${gw.port}/socket`, {
    createConnection: () => {
      const socket = net.connect(gw.port, '127.0.0.1');
      // Queued before the handshake bytes: the front door writes its header first.
      socket.write('PROXY TCP4 192.168.44.7 127.0.0.1 8800 3000\r\n');
      return socket;
    },
  });
  t.after(() => client.terminate());
  await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
  const echoed = new Promise(resolve => client.once('message', data => resolve(String(data))));
  client.send('ping');
  assert.equal(await echoed, 'echo:ping');
  assert.equal(gw.upgrades.length, 1);
  assert.equal(gw.upgrades[0].remoteAddress, '192.168.44.7');
  assert.equal(gw.upgrades[0].remoteFamily, 'IPv4');
});

test('a second PROXY line from the client is not a new peer: http rejects it as 400', async t => {
  const gw = await startBehindGateway(t);
  const client = gw.connect();
  client.write('PROXY TCP4 10.9.9.9 127.0.0.1 1234 3000\r\n'
    + 'PROXY TCP4 127.0.0.1 127.0.0.1 1 1\r\n'
    + httpRequest('/forged'));
  await waitFor(() => client.closed || client.text.includes('400'), { label: 'forged header rejection' });
  assert.equal(gw.requests.length, 0, 'forged request must never reach the app');
});

test('invalid, overlong, UNKNOWN and missing headers destroy the connection', async t => {
  const gw = await startBehindGateway(t);
  const payloads = [
    'GET /no-proxy HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n',
    'PROXY UNKNOWN\r\nGET /unknown HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n',
    'PROXY TCP4 192.168.1.5 127.0.0.1 51234\r\n',
    'PROXY TCP4 host.example 127.0.0.1 51234 3000\r\n',
    `PROXY TCP4 192.168.1.5 127.0.0.1 ${'9'.repeat(MAX_HEADER_BYTES)} 3000\r\n`,
  ];
  for (const payload of payloads) {
    const client = gw.connect();
    client.write(payload);
    await waitFor(() => client.closed, { label: `rejection of ${JSON.stringify(payload.slice(0, 24))}` });
  }
  assert.equal(gw.requests.length, 0);
});

test('a connection that never completes the header is destroyed after the timeout', async t => {
  const gw = await startBehindGateway(t, { headerTimeoutMs: 100 });
  const client = gw.connect();
  client.write('PROXY TCP4 192.168.1.5');
  await waitFor(() => client.closed, { timeoutMs: 3000, label: 'header timeout' });
  assert.equal(gw.requests.length, 0);
});

test('closing the listener drains like server.close() and rejects later connects', async t => {
  const gw = await startBehindGateway(t);
  const client = gw.connect();
  client.write('PROXY TCP4 10.0.0.9 127.0.0.1 1234 3000\r\n' + httpRequest('/drain'));
  await waitFor(() => client.text.includes('ok:/drain'), { label: 'drain request' });
  assert.equal(gw.server.listening, true);
  const closed = new Promise(resolve => gw.server.close(() => resolve()));
  await closed;
  assert.equal(gw.server.listening, false);
  assert.equal(gw.server.address(), null);
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = net.connect(gw.port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
  }));
});

test('EADDRINUSE exits with code 75 so the front door can pick another port', async () => {
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const { port } = blocker.address();
  const script = 'const http=require("http");const g=require(process.argv[1]);'
    + 'const s=http.createServer((q,r)=>r.end());'
    + 'g.listenBehindGateway(s,{port:Number(process.argv[2]),logger:{info(){},warn(){},error(){}}});';
  try {
    const child = spawn(process.execPath, ['-e', script, path.join(__dirname, '..', 'src', 'gateway-child.js'), String(port)],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(code, 75);
  } finally {
    await new Promise(resolve => blocker.close(resolve));
  }
});

test('lifeline: EOF on stdin from the front door triggers exactly one graceful SIGINT', async () => {
  const { EventEmitter } = require('node:events');
  const fakeStdin = () => Object.assign(new EventEmitter(), { isTTY: false, resumed: false, resume() { this.resumed = true; } });
  const child = { MULTICC_GATEWAY_CHILD: '1', MULTICC_GATEWAY_PID: String(process.ppid) };

  assert.equal(watchGatewayLifeline({ env: {}, stdin: fakeStdin(), logger: quietLogger }), false, 'direct mode never watches stdin');
  const tty = Object.assign(fakeStdin(), { isTTY: true });
  assert.equal(watchGatewayLifeline({ env: child, stdin: tty, logger: quietLogger }), false, 'a terminal is not a lifeline');

  const stdin = fakeStdin();
  let signals = 0;
  assert.equal(watchGatewayLifeline({ env: child, stdin, logger: quietLogger, signal: () => signals++, hasHandler: () => true }), true);
  assert.equal(stdin.resumed, true, 'stdin must flow so EOF is observed');
  stdin.emit('end'); stdin.emit('close'); stdin.emit('error', new Error('EPIPE'));
  assert.equal(signals, 1, 'end/close/error together still mean one shutdown');

  // Early boot: no SIGINT handler yet, so the default action would kill the
  // process mid-migration. The lifeline waits until gracefulShutdown is wired.
  const early = fakeStdin();
  let handler = false;
  let fired = 0;
  watchGatewayLifeline({ env: child, stdin: early, logger: quietLogger, signal: () => fired++, hasHandler: () => handler, retryMs: 10 });
  early.emit('end');
  await sleep(40);
  assert.equal(fired, 0, 'no SIGINT before a handler exists');
  handler = true;
  await sleep(40);
  assert.equal(fired, 1);
});

test('on Windows a lost lifeline runs the SIGINT handlers in-process instead of terminating', () => {
  // process.kill(self, 'SIGINT') is TerminateProcess on Windows: no drain.
  const seen = [];
  const handler = name => seen.push(name);
  process.on('SIGINT', handler);
  try {
    raiseSigint('win32');
  } finally {
    process.removeListener('SIGINT', handler);
  }
  assert.deepEqual(seen, ['SIGINT']);
});
