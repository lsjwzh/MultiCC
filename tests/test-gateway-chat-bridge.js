'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const test = require('node:test');
const {
  FrameError, KIND, connectChatBridge, decodeToNode, encodeClose, encodePing, encodeSend,
  encodeTerminate, sign, validCloseCode,
} = require('../src/ws/gateway-chat-bridge');
const corpus = require('../native/core/tests/fixtures/chat-bridge-corpus.json');

// The Node end of the /ws/chat bridge. Two layers are checked here:
//  1. the codec against the byte corpus native/core/src/chat_bridge.rs
//     generates (Rust pins the same file from its side), using an encoder and
//     a decoder written independently below, from the grammar alone;
//  2. the virtual socket against a scripted front door.

const CAPABILITY = 'test-capability-0123456789abcdef';

// ---- independent transcription of the grammar ------------------------------

function u32(value) { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; }
function u16(value) { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; }

function toNodeBytes(frame) {
  switch (frame.kind) {
    case 0x01: return Buffer.concat([Buffer.from([1]), u32(frame.conn), Buffer.from(JSON.stringify(frame.info))]);
    case 0x02: return Buffer.concat([Buffer.from([2]), u32(frame.conn), Buffer.from([frame.binary ? 1 : 0]), frame.data]);
    case 0x03: return Buffer.concat([Buffer.from([3]), u32(frame.conn)]);
    case 0x04: return Buffer.concat([
      Buffer.from([4]), u32(frame.conn), u16(frame.code),
      Buffer.from([(frame.received ? 1 : 0) | (frame.sent ? 2 : 0)]), Buffer.from(frame.reason),
    ]);
    case 0x05: return Buffer.concat([
      Buffer.from([5]), u32(frame.conn), u32(frame.seq), Buffer.from([frame.error === null ? 0 : 1]),
      Buffer.from(frame.error === null ? '' : frame.error),
    ]);
    default: throw new Error(`no such frame kind ${frame.kind}`);
  }
}

function parseToGateway(body) {
  const kind = body[0];
  const conn = body.readUInt32BE(1);
  switch (kind) {
    case 0x11: return { kind, conn, seq: body.readUInt32BE(5), binary: body[9] === 1, data: body.subarray(10) };
    case 0x12: return { kind, conn, code: body.readUInt16BE(5), reason: body.subarray(7).toString('utf8') };
    case 0x13: case 0x14: assert.equal(body.length, 5); return { kind, conn };
    default: throw new Error(`no such frame kind ${kind}`);
  }
}

// ---- codec against the corpus ----------------------------------------------

test('every Rust-generated Node-bound frame decodes and re-encodes to the same bytes', () => {
  assert.ok(corpus.toNode.length >= 10, 'the corpus must cover every kind and edge');
  const kinds = new Set();
  for (const hex of corpus.toNode) {
    const bytes = Buffer.from(hex, 'hex');
    const frame = decodeToNode(bytes);
    kinds.add(frame.kind);
    assert.equal(toNodeBytes(frame).toString('hex'), hex);
  }
  assert.deepEqual([...kinds].sort(), [1, 2, 3, 4, 5]);
});

test('every Rust-parsed Gateway-bound frame is what the Node encoders write', () => {
  const kinds = new Set();
  for (const hex of corpus.toGateway) {
    const parsed = parseToGateway(Buffer.from(hex, 'hex'));
    kinds.add(parsed.kind);
    let written;
    if (parsed.kind === KIND.send) written = encodeSend(parsed.conn, parsed.seq, parsed.binary, parsed.data);
    else if (parsed.kind === KIND.close) {
      written = encodeClose(parsed.conn, parsed.code, parsed.reason);
    } else if (parsed.kind === KIND.terminate) written = encodeTerminate(parsed.conn);
    else written = encodePing(parsed.conn);
    assert.equal(written.toString('hex'), hex);
  }
  assert.deepEqual([...kinds].sort(), [0x11, 0x12, 0x13, 0x14]);
});

test('off-grammar Node-bound frames are rejected, never guessed at', () => {
  const bad = [
    ['empty', Buffer.alloc(0)],
    ['unknown kind', Buffer.from([0x7f, 0, 0, 0, 1])],
    ['gateway-bound kind', Buffer.from([0x11, 0, 0, 0, 1])],
    ['truncated open', Buffer.from([1, 0, 0])],
    ['open that is not JSON', Buffer.concat([Buffer.from([1, 0, 0, 0, 1]), Buffer.from('{nope')])],
    ['message without flag', Buffer.from([2, 0, 0, 0, 1])],
    ['message with flag 2', Buffer.from([2, 0, 0, 0, 1, 2, 0x61])],
    ['pong with trailing byte', Buffer.from([3, 0, 0, 0, 1, 0])],
    ['closed with flags 4', Buffer.from([4, 0, 0, 0, 1, 3, 232, 4])],
    ['closed with invalid UTF-8 reason', Buffer.from([4, 0, 0, 0, 1, 3, 232, 0, 0xff])],
    ['sent truncated', Buffer.from([5, 0, 0, 0, 1, 0, 0, 0, 1])],
    ['sent with flag 9', Buffer.from([5, 0, 0, 0, 1, 0, 0, 0, 1, 9])],
  ];
  for (const [name, body] of bad) {
    assert.throws(() => decodeToNode(body), FrameError, name);
  }
});

test('close codes are validated the way ws validates them', () => {
  for (const ok of [1000, 1001, 1003, 1007, 1011, 1014, 3000, 4000, 4999]) assert.equal(validCloseCode(ok), true, String(ok));
  for (const bad of [0, 999, 1004, 1005, 1006, 1015, 2999, 5000, 65535]) assert.equal(validCloseCode(bad), false, String(bad));
});

// ---- the virtual socket against a scripted front door ----------------------

function frameOut(body) { return Buffer.concat([u32(body.length), body]); }
function jsonFrame(value) { return frameOut(Buffer.from(JSON.stringify(value))); }

function openInfo(overrides = {}) {
  return {
    url: '/ws/chat?session=s', headers: [['host', 'x'], ['cookie', 'a=1; b=2'], ['cookie', 'c=3']],
    remoteAddress: '203.0.113.9', remotePort: 51234, localAddress: '127.0.0.1', localPort: 8080, ...overrides,
  };
}

// Everything a test opened. A failed assertion must not leave a listening
// server behind, or the run would hang instead of failing.
const opened = { servers: new Set(), sockets: new Set(), bridges: new Set() };
test.afterEach(() => {
  for (const bridge of opened.bridges) bridge.end();
  for (const socket of opened.sockets) socket.destroy();
  for (const server of opened.servers) server.close();
  opened.bridges.clear(); opened.sockets.clear(); opened.servers.clear();
});

// A front door that speaks the real handshake and then lets the test push
// frames and read what the Node end writes.
async function frontDoor({ capability = CAPABILITY, prove = true } = {}) {
  const incoming = [];
  const waiters = [];
  let session = null;
  const ready = new Promise(resolve => { session = resolve; });
  const server = net.createServer(socket => {
    opened.sockets.add(socket);
    let buffered = Buffer.alloc(0);
    let phase = 'proof';
    const nonce = crypto.randomBytes(16).toString('hex');
    socket.write(jsonFrame(nonce));
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (buffered.length < 4) return;
        const size = buffered.readUInt32BE(0);
        if (buffered.length < 4 + size) return;
        const body = buffered.subarray(4, 4 + size);
        buffered = buffered.subarray(4 + size);
        if (phase === 'proof') {
          const proof = JSON.parse(body.toString());
          if (proof !== sign(capability, `child:${nonce}`)) { socket.destroy(); return; }
          socket.write(jsonFrame(prove ? sign(capability, `parent:${nonce}`) : 'forged'));
          phase = 'frames';
          session(socket);
        } else {
          const frame = parseToGateway(body);
          const waiter = waiters.shift();
          if (waiter) waiter(frame); else incoming.push(frame);
        }
      }
    });
  });
  opened.servers.add(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    socket: () => ready,
    push: async frame => (await ready).write(frameOut(toNodeBytes(frame))),
    pushRaw: async bytes => (await ready).write(bytes),
    next: () => new Promise(resolve => {
      const queued = incoming.shift();
      if (queued) resolve(queued); else waiters.push(resolve);
    }),
    close: () => new Promise(resolve => { server.close(resolve); ready.then(s => s.destroy()); setTimeout(resolve, 50); }),
    server,
  };
}

async function connected(options = {}) {
  const door = await frontDoor(options.door);
  const sockets = [];
  const lost = [];
  const wss = { clients: new Set() };
  const logs = [];
  const bridge = await connectChatBridge({
    port: door.port, capability: CAPABILITY, wss,
    logger: { error: (...args) => logs.push(args) },
    onConnection: (ws, req) => { sockets.push({ ws, req }); if (options.onConnection) options.onConnection(ws, req); },
    onLost: error => lost.push(error),
  });
  opened.bridges.add(bridge);
  return { door, bridge, sockets, lost, wss, logs };
}

async function settle() { await new Promise(resolve => setTimeout(resolve, 20)); }

test('the handshake refuses a front door that cannot prove the capability', async () => {
  const door = await frontDoor({ prove: false });
  await assert.rejects(connectChatBridge({
    port: door.port, capability: CAPABILITY, onConnection() {}, logger: { error() {} },
  }), /capability proof/);
  await door.close();
});

test('the front door refuses a Node that holds a different capability', async () => {
  const door = await frontDoor();
  await assert.rejects(connectChatBridge({
    port: door.port, capability: 'some-other-capability-000000000000', onConnection() {}, logger: { error() {} },
  }));
  await door.close();
});

test('an Open frame becomes a socket and a ws-shaped request', async () => {
  const { door, bridge, sockets, wss } = await connected();
  await door.push({ kind: 1, conn: 7, info: openInfo() });
  await settle();
  assert.equal(sockets.length, 1);
  const { ws, req } = sockets[0];
  assert.equal(ws.readyState, 1);
  assert.equal(ws.bufferedAmount, 0);
  assert.equal(req.url, '/ws/chat?session=s');
  assert.equal(req.method, 'GET');
  assert.equal(req.headers.host, 'x');
  assert.deepEqual(req.rawHeaders, ['host', 'x', 'cookie', 'a=1; b=2', 'cookie', 'c=3']);
  assert.equal(req.socket.remoteAddress, '203.0.113.9');
  assert.equal(req.socket.remotePort, 51234);
  assert.equal(req.socket.remoteFamily, 'IPv4');
  assert.equal(req.socket.encrypted, false);
  assert.equal(wss.clients.has(ws), true);
  assert.equal(bridge.sockets(), 1);
  bridge.end();
  await door.close();
});

test('IPv6 peers are reported with their family', async () => {
  const { door, bridge, sockets } = await connected();
  await door.push({ kind: 1, conn: 1, info: openInfo({ remoteAddress: '2001:db8::1' }) });
  await settle();
  assert.equal(sockets[0].req.socket.remoteFamily, 'IPv6');
  bridge.end();
  await door.close();
});

test('messages arrive as Buffers with the text/binary flag, in order', async () => {
  const { door, bridge, sockets } = await connected();
  await door.push({ kind: 1, conn: 1, info: openInfo() });
  await settle();
  const seen = [];
  sockets[0].ws.on('message', (data, isBinary) => seen.push([Buffer.isBuffer(data), data.toString('hex'), isBinary]));
  await door.push({ kind: 2, conn: 1, binary: false, data: Buffer.from('hi') });
  await door.push({ kind: 2, conn: 1, binary: true, data: Buffer.from([0, 255, 1]) });
  await door.push({ kind: 2, conn: 1, binary: false, data: Buffer.alloc(0) });
  await settle();
  assert.deepEqual(seen, [[true, '6869', false], [true, '00ff01', true], [true, '', false]]);
  bridge.end();
  await door.close();
});

test('send writes a Send frame; the callback and bufferedAmount follow the front door\'s ack', async () => {
  const { door, bridge, sockets } = await connected();
  await door.push({ kind: 1, conn: 3, info: openInfo() });
  await settle();
  const { ws } = sockets[0];
  const done = [];
  ws.send('hello', error => done.push(['a', error]));
  ws.send(Buffer.from([1, 2, 3]), { binary: true }, error => done.push(['b', error]));
  ws.send('forced-binary', { binary: true });
  assert.equal(ws.bufferedAmount, 5 + 3 + 13);
  const first = await door.next();
  const second = await door.next();
  const third = await door.next();
  assert.deepEqual([first.seq, first.binary, first.data.toString()], [0, false, 'hello']);
  assert.deepEqual([second.seq, second.binary, [...second.data]], [1, true, [1, 2, 3]]);
  assert.deepEqual([third.seq, third.binary], [2, true]);
  assert.deepEqual(done, []);
  // Acks may complete out of order; each settles only its own send.
  await door.push({ kind: 5, conn: 3, seq: 1, error: null });
  await settle();
  assert.deepEqual(done, [['b', undefined]]);
  assert.equal(ws.bufferedAmount, 5 + 13);
  await door.push({ kind: 5, conn: 3, seq: 0, error: 'write failed' });
  await settle();
  assert.equal(done[1][0], 'a');
  assert.equal(done[1][1].message, 'write failed');
  assert.equal(ws.bufferedAmount, 13);
  await door.push({ kind: 5, conn: 3, seq: 2, error: null });
  await settle();
  assert.equal(ws.bufferedAmount, 0);
  // An ack for a send that is not pending is ignored.
  await door.push({ kind: 5, conn: 3, seq: 99, error: null });
  await settle();
  assert.equal(ws.bufferedAmount, 0);
  bridge.end();
  await door.close();
});

test('send on a socket that is not open reports the ws error and writes nothing', async () => {
  const { door, bridge, sockets } = await connected();
  await door.push({ kind: 1, conn: 1, info: openInfo() });
  await settle();
  const { ws } = sockets[0];
  await door.push({ kind: 4, conn: 1, code: 1000, received: true, sent: true, reason: '' });
  await settle();
  const errors = [];
  ws.send('late', error => errors.push(error));
  await settle();
  assert.match(errors[0].message, /WebSocket is not open: readyState 3 \(CLOSED\)/);
  bridge.end();
  await door.close();
});

test('close sends a Close frame once and the Closed frame ends the socket exactly once', async () => {
  const { door, bridge, sockets, wss } = await connected();
  await door.push({ kind: 1, conn: 4, info: openInfo() });
  await settle();
  const { ws } = sockets[0];
  const closes = [];
  ws.on('close', (code, reason) => closes.push([code, reason.toString()]));
  ws.close(4003, 'Forbidden');
  ws.close(4004, 'ignored: already closing');
  assert.equal(ws.readyState, 2);
  const frame = await door.next();
  assert.deepEqual([frame.kind, frame.conn, frame.code, frame.reason], [KIND.close, 4, 4003, 'Forbidden']);
  await door.push({ kind: 4, conn: 4, code: 4003, received: true, sent: true, reason: 'Forbidden' });
  await door.push({ kind: 4, conn: 4, code: 1006, received: false, sent: false, reason: '' });
  await settle();
  assert.deepEqual(closes, [[4003, 'Forbidden']]);
  assert.equal(ws.readyState, 3);
  assert.equal(wss.clients.has(ws), false);
  assert.equal(bridge.sockets(), 0);
  bridge.end();
  await door.close();
});

test('close() validates its arguments like ws does', async () => {
  const { door, bridge, sockets } = await connected();
  await door.push({ kind: 1, conn: 1, info: openInfo() });
  await settle();
  const { ws } = sockets[0];
  assert.throws(() => ws.close(1005), TypeError);
  assert.throws(() => ws.close(999), TypeError);
  assert.throws(() => ws.close(1000, 'x'.repeat(124)), RangeError);
  assert.equal(ws.readyState, 1, 'a rejected close leaves the socket open');
  ws.close();
  const frame = await door.next();
  assert.deepEqual([frame.code, frame.reason], [0, '']);
  bridge.end();
  await door.close();
});

test('terminate and ping write their frames; a pong is emitted', async () => {
  const { door, bridge, sockets } = await connected();
  await door.push({ kind: 1, conn: 9, info: openInfo() });
  await settle();
  const { ws } = sockets[0];
  const pongs = [];
  ws.on('pong', data => pongs.push(data.length));
  ws.ping();
  assert.deepEqual(await door.next(), { kind: KIND.ping, conn: 9 });
  await door.push({ kind: 3, conn: 9 });
  await settle();
  assert.deepEqual(pongs, [0]);
  ws.terminate();
  assert.equal(ws.readyState, 2);
  assert.deepEqual(await door.next(), { kind: KIND.terminate, conn: 9 });
  ws.ping(); // Not open any more: nothing is written.
  await door.push({ kind: 4, conn: 9, code: 1006, received: false, sent: false, reason: '' });
  await settle();
  assert.equal(ws.readyState, 3);
  bridge.end();
  await door.close();
});

test('pending sends fail when their socket ends, and frames for ended sockets are dropped', async () => {
  const { door, bridge, sockets } = await connected();
  await door.push({ kind: 1, conn: 2, info: openInfo() });
  await settle();
  const { ws } = sockets[0];
  const errors = [];
  ws.send('pending', error => errors.push(error));
  await door.next();
  await door.push({ kind: 4, conn: 2, code: 1006, received: false, sent: false, reason: '' });
  await settle();
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof Error);
  assert.equal(ws.bufferedAmount, 0);
  await door.push({ kind: 2, conn: 2, binary: false, data: Buffer.from('ghost') });
  await settle();
  assert.equal(bridge.lost, false, 'a stray frame for a finished socket is not a protocol error');
  bridge.end();
  await door.close();
});

test('losing the stream ends every socket with 1006 and reports it once', async () => {
  const { door, bridge, sockets, lost, wss } = await connected();
  await door.push({ kind: 1, conn: 1, info: openInfo() });
  await door.push({ kind: 1, conn: 2, info: openInfo() });
  await settle();
  const closes = [];
  for (const { ws } of sockets) ws.on('close', (code, reason) => closes.push([code, reason.length]));
  (await door.socket()).destroy();
  await settle();
  assert.deepEqual(closes, [[1006, 0], [1006, 0]]);
  assert.equal(lost.length, 1);
  assert.equal(bridge.lost, true);
  assert.equal(wss.clients.size, 0);
  // Writing to a lost bridge is a no-op, not a crash.
  assert.doesNotThrow(() => sockets[0].ws.send('x'));
  await door.close();
});

test('a protocol violation drops the stream', async () => {
  const { door, bridge, sockets, lost, logs } = await connected();
  await door.push({ kind: 1, conn: 1, info: openInfo() });
  await settle();
  const closes = [];
  sockets[0].ws.on('close', code => closes.push(code));
  await door.pushRaw(frameOut(Buffer.from([0x7f, 0, 0, 0, 1])));
  await settle();
  assert.equal(bridge.lost, true);
  assert.equal(lost.length, 1);
  assert.deepEqual(closes, [1006]);
  assert.equal(logs[0][0], 'chat_bridge_protocol_error');
  await door.close();
});

test('a zero-length or oversize frame prefix drops the stream', async () => {
  for (const prefix of [u32(0), u32(100 * 1024 * 1024 + 1025)]) {
    const { door, bridge, lost } = await connected();
    await door.pushRaw(prefix);
    await settle();
    assert.equal(bridge.lost, true);
    assert.equal(lost.length, 1);
    await door.close();
  }
});

test('a duplicate Open for a live connection id drops the stream', async () => {
  const { door, bridge } = await connected();
  await door.push({ kind: 1, conn: 5, info: openInfo() });
  await door.push({ kind: 1, conn: 5, info: openInfo() });
  await settle();
  assert.equal(bridge.lost, true);
  await door.close();
});

test('a frame split across reads is reassembled', async () => {
  const { door, bridge, sockets } = await connected();
  const bytes = frameOut(toNodeBytes({ kind: 1, conn: 6, info: openInfo() }));
  const socket = await door.socket();
  socket.setNoDelay(true);
  for (let i = 0; i < bytes.length; i += 7) {
    socket.write(bytes.subarray(i, i + 7));
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  await settle();
  assert.equal(sockets.length, 1);
  assert.equal(bridge.lost, false);
  bridge.end();
  await door.close();
});

test('a throwing listener costs its own socket, not the stream', async () => {
  const { door, bridge, sockets, logs } = await connected();
  await door.push({ kind: 1, conn: 1, info: openInfo() });
  await door.push({ kind: 1, conn: 2, info: openInfo() });
  await settle();
  sockets[0].ws.on('message', () => { throw new Error('listener bug'); });
  const healthy = [];
  sockets[1].ws.on('message', data => healthy.push(data.toString()));
  await door.push({ kind: 2, conn: 1, binary: false, data: Buffer.from('boom') });
  assert.deepEqual(await door.next(), { kind: KIND.terminate, conn: 1 });
  await door.push({ kind: 2, conn: 2, binary: false, data: Buffer.from('fine') });
  await settle();
  assert.equal(bridge.lost, false);
  assert.deepEqual(healthy, ['fine']);
  assert.equal(logs[0][0], 'chat_bridge_listener_failed');
  bridge.end();
  await door.close();
});

test('a connection handler that throws terminates only that socket', async () => {
  const { door, bridge, logs } = await connected({
    onConnection: (_ws, req) => { if (req.url.includes('bad')) throw new Error('router bug'); },
  });
  await door.push({ kind: 1, conn: 1, info: openInfo({ url: '/ws/chat?bad=1' }) });
  assert.deepEqual(await door.next(), { kind: KIND.terminate, conn: 1 });
  await door.push({ kind: 1, conn: 2, info: openInfo() });
  await settle();
  assert.equal(bridge.lost, false);
  assert.equal(bridge.sockets(), 2);
  assert.equal(logs[0][0], 'chat_bridge_listener_failed');
  bridge.end();
  await door.close();
});

test('sequence numbers are per socket and independent', async () => {
  const { door, bridge, sockets } = await connected();
  await door.push({ kind: 1, conn: 1, info: openInfo() });
  await door.push({ kind: 1, conn: 2, info: openInfo() });
  await settle();
  sockets[0].ws.send('a');
  sockets[1].ws.send('b');
  sockets[0].ws.send('c');
  const frames = [await door.next(), await door.next(), await door.next()];
  assert.deepEqual(frames.map(f => [f.conn, f.seq]), [[1, 0], [2, 0], [1, 1]]);
  bridge.end();
  await door.close();
});
