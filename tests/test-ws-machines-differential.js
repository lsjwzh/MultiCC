'use strict';
// Differential proof for the `/ws/machines/<id>` bridge retired from Node.
//
// Both sides are driven by the same raw socket and the same fake peer, so the
// comparison is the bytes a real client sees: the handshake response, every
// data frame (opcode + payload) and the close frame (code + reason).
//
//   node  = tests/helpers/legacy-ws-machines.js (the frozen production
//           module, SHA-256 239bbad4a6dd66e96c0fefdf874a5fbdd70920b3c06e9be
//           92f5a01343cb9d451) behind a real `ws` server, with the native
//           send wrapper the shared router installed on every socket.
//   rust  = the release/debug `multicc-gateway` binary terminating the
//           upgrade itself (native/gateway/src/ws_machines.rs).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const addonPath = process.env.MULTICC_RUST_ADDON || path.join(
  process.env.MULTICC_RUST_PREBUILT_DIR || path.resolve(__dirname, '../native/prebuilt'),
  `${process.platform}-${process.arch}`, 'multicc_core.node');
const binary = path.join(path.dirname(addonPath), process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway');
const fixture = path.resolve(__dirname, 'helpers/gateway-auth-child.js');
const { bridgeMachineSocket } = require('./helpers/legacy-ws-machines');
const { installNativeQueue } = require('../src/ws/native-queue');
const auth = require('../src/auth-security');
const { getNative } = require('../src/native/runtime');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

function request(port, method, url, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, timeout: 8000,
      headers: { host: 'fixture.example', ...headers, 'content-length': bytes.length } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('timeout', () => req.destroy(new Error('fixture request timeout')));
    req.on('error', reject);
    req.end(bytes);
  });
}

// ── the fake paired machine ────────────────────────────────────────────────
// Scripted: it echoes what it receives and can be told to close with a code.
async function startPeer(t, script) {
  const server = http.createServer();
  const wss = new WebSocket.Server({ server });
  const seen = [];
  wss.on('connection', ws => {
    ws.on('message', (data, binary) => {
      seen.push({ text: binary ? null : data.toString(), bytes: data.length, binary });
      script({ ws, data, binary, seen });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { wss.close(); server.close(resolve); }));
  return { port: server.address().port, seen };
}

// ── the oracle: the frozen Node bridge, wrapper included ───────────────────
async function startNodeSide(t, peerPort) {
  const security = auth.createAuthSecurity({ secret: 'fixture-token' });
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const wss = new WebSocket.Server({ noServer: true });
  const anchor = {};
  const wsHost = new (getNative().RustWsHost)(anchor);
  // The anchor has to stay reachable from the host, exactly as the shared
  // router keeps it; a plain local goes away with the first collection.
  Object.defineProperty(wsHost, Symbol('ws host anchor'), { value: anchor });
  const connPortsById = new Map();
  const ports = {
    ping(socket) { socket.ping(); },
    terminate(socket) { socket.terminate(); },
    close(socket, code, reason) { socket.close(code, reason); },
    schedule(id, ms) {
      const timer = setTimeout(() => {
        const connPorts = connPortsById.get(id);
        if (!connPorts) return;
        try { wsHost.flushClient(id, connPorts); } catch (_) {}
      }, ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
      return timer;
    },
    cancelSchedule(timer) { clearTimeout(timer); },
    metric() {}, backpressureLog() {}, heartbeatTimeout() {},
    now: () => Date.now(),
  };
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws, req) => {
    const urlObj = new URL(req.url, 'http://localhost');
    const connId = wsHost.attach(ws, { connectionId: 'test', path: urlObj.pathname }, false, Date.now());
    ws.once('close', () => { try { wsHost.detach(connId, ports); } catch (_) {} connPortsById.delete(connId); });
    installNativeQueue(ws, wsHost, connId, ports, connPortsById);
    bridgeMachineSocket(ws, urlObj, { authSecurity: security });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { wss.close(); server.close(resolve); }));
  const issue = (id, peer, scopeId) => security.issueWsTicket(`/ws/machines/${scopeId || id}`,
    { machineId: id, upstream: { url: `ws://127.0.0.1:${peer}/`, addresses: [{ address: '127.0.0.1', family: 4 }] } });
  return { port: server.address().port, issue, peerPort };
}

// ── the Rust front door ────────────────────────────────────────────────────
async function startRustSide(t) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-ws-machines-'));
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1',
    MULTICC_ENV_FILE: path.join(dir, '.env'), MULTICC_DATA_DIR: dir,
    MULTICC_GATEWAY_BACKOFF_SCALE: '0.01', MULTICC_RUST_ADDON: addonPath };
  for (const key of Object.keys(env)) {
    if (key.startsWith('MULTICC_GATEWAY_') && key !== 'MULTICC_GATEWAY_BACKOFF_SCALE') delete env[key];
  }
  const child = spawn(binary, ['serve', '--cwd', dir, '--node', process.execPath, '--stdin-lifeline', '--', fixture],
    { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', c => { logs += c; });
  child.stderr.on('data', c => { logs += c; });
  t.after(async () => {
    if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill('SIGINT'); await exit; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 200; i++) {
    try { if ((await request(port, 'GET', '/fixture/state')).status === 200) return { port, logs: () => logs }; } catch {}
    if (child.exitCode !== null) throw new Error(`gateway exited: ${logs}`);
    await delay(20);
  }
  throw new Error(`gateway did not start: ${logs}`);
}

// ── a raw WebSocket client that records exactly what arrives ───────────────
function rawExchange(port, target, frames, { settleMs = 400 } = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(port, '127.0.0.1');
    const received = [];
    let head = null;
    let buffer = Buffer.alloc(0);
    const finish = () => resolve({ head, frames: received });
    const timer = setTimeout(() => { socket.destroy(); finish(); }, settleMs + 1500);
    socket.on('connect', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
        + `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`);
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (head === null) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        head = buffer.slice(0, end).toString();
        buffer = buffer.slice(end + 4);
        if (!head.startsWith('HTTP/1.1 101')) { clearTimeout(timer); socket.destroy(); return finish(); }
        for (const frame of frames) socket.write(maskedFrame(frame));
      }
      for (;;) {
        const parsed = readFrame(buffer);
        if (!parsed) break;
        buffer = buffer.slice(parsed.size);
        received.push(parsed.frame);
        if (parsed.frame.opcode === 0x8) { clearTimeout(timer); socket.destroy(); return finish(); }
      }
    });
    socket.on('error', error => { clearTimeout(timer); head === null ? reject(error) : finish(); });
    socket.on('close', () => { clearTimeout(timer); finish(); });
  });
}

function maskedFrame({ opcode = 0x1, payload = '' }) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(body.map((byte, i) => byte ^ mask[i % 4]));
  let header;
  if (body.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
  else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const length = buffer[1] & 0x7f;
  let offset = 2;
  let size = length;
  if (length === 126) { if (buffer.length < 4) return null; size = buffer.readUInt16BE(2); offset = 4; }
  else if (length === 127) { if (buffer.length < 10) return null; size = Number(buffer.readBigUInt64BE(2)); offset = 10; }
  if (buffer.length < offset + size) return null;
  const payload = buffer.slice(offset, offset + size);
  const frame = { opcode, bytes: size };
  if (opcode === 0x8) {
    frame.code = size >= 2 ? payload.readUInt16BE(0) : null;
    frame.reason = size > 2 ? payload.slice(2).toString('utf8') : '';
  } else {
    frame.sha = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
    frame.text = opcode === 0x1 ? payload.toString('utf8') : null;
  }
  return { frame, size: offset + size };
}

const machineId = 'fixture-machine';

async function bothSides(t, script, frames, mutate = {}, settleMs = 400) {
  const peer = await startPeer(t, script);
  const node = await startNodeSide(t, peer.port);
  const rust = await startRustSide(t);
  const nodeTicket = node.issue(mutate.nodeMachineId || machineId, peer.port, mutate.scopeMachineId).ticket;
  const issued = await request(rust.port, 'POST', '/fixture/issue-machine',
    { 'content-type': 'application/json' },
    JSON.stringify({ machineId: mutate.rustMachineId || machineId, scopeMachineId: mutate.scopeMachineId,
      url: `ws://127.0.0.1:${peer.port}/`,
      addresses: mutate.addresses || [{ address: '127.0.0.1', family: 4 }] }));
  assert.equal(issued.status, 200, issued.body);
  const rustTicket = JSON.parse(issued.body).ticket;
  const target = id => `/ws/machines/${id}?ticket=`;
  const nodeView = await rawExchange(node.port, `${target(machineId)}${nodeTicket}`, frames, { settleMs });
  const rustView = await rawExchange(rust.port, `${target(machineId)}${rustTicket}`, frames, { settleMs });
  return { nodeView, rustView, peer };
}

function compare(nodeView, rustView, what) {
  assert.equal(rustView.head.split('\r\n')[0], nodeView.head.split('\r\n')[0], `${what}: status line`);
  assert.deepEqual(rustView.frames, nodeView.frames, `${what}: client-visible frames`);
}

test('the bridge relays both directions with identical client frames', { timeout: 60000 }, async t => {
  const script = ({ ws, data, binary }) => ws.send(data, { binary });
  const { nodeView, rustView } = await bothSides(t, script, [
    { opcode: 0x1, payload: JSON.stringify({ type: 'machine_hello', seq: 1 }) },
    { opcode: 0x2, payload: Buffer.from([0, 1, 2, 250, 251, 252]) },
    { opcode: 0x1, payload: '中文 payload across a frame boundary' },
  ]);
  compare(nodeView, rustView, 'relay');
  assert.equal(rustView.frames.length >= 3, true, `expected the echoed frames, got ${JSON.stringify(rustView.frames)}`);
});

test('an upstream close maps to 1012 on the client, and 4003 is preserved', { timeout: 60000 }, async t => {
  const closing = code => ({ ws, data }) => { if (data.toString() === 'close') ws.close(code, 'peer done'); };
  const plain = await bothSides(t, closing(4100), [{ opcode: 0x1, payload: 'close' }]);
  compare(plain.nodeView, plain.rustView, 'upstream close');
  assert.equal(plain.rustView.frames.at(-1).code, 1012);
  assert.equal(plain.rustView.frames.at(-1).reason, '电脑连接已关闭');

  const refused = await bothSides(t, closing(4003), [{ opcode: 0x1, payload: 'close' }]);
  compare(refused.nodeView, refused.rustView, 'upstream 4003');
  assert.equal(refused.rustView.frames.at(-1).code, 4003);
});

// The ticket is valid for the path being opened; only the machine id inside
// it belongs elsewhere. That is the case `url.pathname !== \`/ws/machines/${ticket.machineId}\``
// existed for, and the ticket table's own scope check cannot see it.
test('a ticket whose machine id does not match the path is refused with 4003', { timeout: 60000 }, async t => {
  const { nodeView, rustView } = await bothSides(t, ({ ws, data, binary }) => ws.send(data, { binary }), [],
    { nodeMachineId: 'other-machine', rustMachineId: 'other-machine', scopeMachineId: machineId });
  compare(nodeView, rustView, 'path mismatch');
  assert.equal(rustView.frames.at(-1).code, 4003);
  assert.equal(rustView.frames.at(-1).reason, '电脑连接票据无效');
});

test('a ticket with no pinned address is refused with 4003', { timeout: 60000 }, async t => {
  const peer = await startPeer(t, ({ ws, data, binary }) => ws.send(data, { binary }));
  const rust = await startRustSide(t);
  const issued = await request(rust.port, 'POST', '/fixture/issue-machine',
    { 'content-type': 'application/json' },
    JSON.stringify({ machineId, url: `ws://127.0.0.1:${peer.port}/`, addresses: [] }));
  const ticket = JSON.parse(issued.body).ticket;
  const view = await rawExchange(rust.port, `/ws/machines/${machineId}?ticket=${ticket}`, []);
  assert.equal(view.frames.at(-1).code, 4003);
  assert.equal(view.frames.at(-1).reason, '电脑连接票据无效');
});

test('the one-use ticket cannot authorize a second socket', { timeout: 60000 }, async t => {
  const peer = await startPeer(t, ({ ws, data, binary }) => ws.send(data, { binary }));
  const rust = await startRustSide(t);
  const issued = await request(rust.port, 'POST', '/fixture/issue-machine',
    { 'content-type': 'application/json' },
    JSON.stringify({ machineId, url: `ws://127.0.0.1:${peer.port}/`, addresses: [{ address: '127.0.0.1', family: 4 }] }));
  const ticket = JSON.parse(issued.body).ticket;
  const target = `/ws/machines/${machineId}?ticket=${ticket}`;
  const first = await rawExchange(rust.port, target, [{ opcode: 0x1, payload: 'ping' }]);
  assert.equal(first.frames.some(frame => frame.text === 'ping'), true, JSON.stringify(first.frames));
  const replay = await rawExchange(rust.port, target, []);
  assert.equal(replay.frames.at(-1).code, 4003);
});

test('a malformed upgrade is refused before the ticket is spent', { timeout: 60000 }, async t => {
  const peer = await startPeer(t, ({ ws, data, binary }) => ws.send(data, { binary }));
  const rust = await startRustSide(t);
  const issued = await request(rust.port, 'POST', '/fixture/issue-machine',
    { 'content-type': 'application/json' },
    JSON.stringify({ machineId, url: `ws://127.0.0.1:${peer.port}/`, addresses: [{ address: '127.0.0.1', family: 4 }] }));
  const ticket = JSON.parse(issued.body).ticket;
  // No Sec-WebSocket-Version: the handshake planner rejects it with 400.
  const refused = await new Promise((resolve, reject) => {
    const socket = net.connect(rust.port, '127.0.0.1');
    let text = '';
    socket.on('connect', () => socket.write(
      `GET /ws/machines/${machineId}?ticket=${ticket} HTTP/1.1\r\nHost: 127.0.0.1\r\n`
      + `Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`));
    socket.on('data', chunk => { text += chunk; });
    socket.on('error', reject);
    socket.on('close', () => resolve(text));
  });
  assert.match(refused, /^HTTP\/1\.1 400/);
  // The ticket survived, so the same one still opens a socket.
  const view = await rawExchange(rust.port, `/ws/machines/${machineId}?ticket=${ticket}`, [{ opcode: 0x1, payload: 'alive' }]);
  assert.equal(view.frames.some(frame => frame.text === 'alive'), true, JSON.stringify(view.frames));
});

// The shared router installed the native send wrapper on every socket, so the
// kernel's own ceilings apply to the bridge too. A frame over
// `maxFrameBytes` (8 MiB) is inside the upstream's 48 MiB payload limit but
// overflows the client queue, which cuts the socket with 1013 and the
// kernel's exact reason. If the wrapper is missing from either side, the
// client sees the 9 MiB frame instead.
test('an upstream frame over the queue ceiling cuts the client with 1013', { timeout: 60000 }, async t => {
  const huge = Buffer.alloc(9 * 1024 * 1024, 0x61);
  const script = ({ ws, data }) => { if (data.toString() === 'huge') ws.send(huge, { binary: true }); };
  const { nodeView, rustView } = await bothSides(t, script, [{ opcode: 0x1, payload: 'huge' }], {}, 2500);
  compare(nodeView, rustView, 'queue ceiling');
  assert.equal(rustView.frames.at(-1).code, 1013);
  assert.equal(rustView.frames.at(-1).reason, 'slow client; reconnect to resync');
  assert.equal(rustView.frames.some(frame => frame.bytes === huge.length), false,
    'the oversize frame must never reach the client');
});

test('a plain GET on the bridge path is still answered by Node', { timeout: 60000 }, async t => {
  const rust = await startRustSide(t);
  const response = await request(rust.port, 'GET', `/ws/machines/${machineId}`, { 'x-access-token': 'fixture-token' });
  assert.equal(response.status, 404, 'the front door must not claim a non-upgrade request');
});
