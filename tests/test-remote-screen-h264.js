'use strict';

// 「🖥 屏幕」高清流畅模式的服务端桥：Agent h264.sock ⇄ /ws/remote-screen?mode=h264。
// 用假 socket / 假 WS 钉住四件事：按帧切分转发、积压时只丢普通帧并补要关键帧、
// 浏览器→Agent 只放行三种定长消息、出不了首帧就断开让前端回退。

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { attachH264Bridge, T_CONFIG, T_KEY, T_DELTA, REQ_KEY } = require('../src/remote-screen-h264-bridge');

function frame(type, body) {
  const payload = Buffer.from(body);
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

function harness(opts = {}) {
  const sock = new EventEmitter();
  sock.written = [];
  sock.destroyed = false;
  sock.write = data => { sock.written.push(Buffer.from(data)); return true; };
  sock.destroy = () => { sock.destroyed = true; };
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.bufferedAmount = 0;
  ws.sent = [];
  ws.closedWith = null;
  ws.send = (msg, _opts, cb) => { ws.sent.push(Buffer.from(msg)); cb?.(); };
  ws.close = (code, reason) => { ws.closedWith = { code, reason }; ws.readyState = 3; };
  let t = 0;
  const { beforeAttach, ...bridgeOpts } = opts;
  beforeAttach?.(ws);
  const bridge = attachH264Bridge(ws, { socketPath: '/nope', connect: () => sock, now: () => t, ...bridgeOpts });
  sock.emit('connect');
  return { sock, ws, bridge, advance: ms => { t += ms; } };
}

test('h264 bridge: reassembles frames split across reads, one WS message per frame', t => {
  const { sock, ws, bridge } = harness();
  t.after(() => bridge.close());
  const cfg = frame(T_CONFIG, JSON.stringify({ codec: 'avc1.64001F', width: 1470, height: 956 }));
  const key = frame(T_KEY, 'KEYFRAME');
  const delta = frame(T_DELTA, 'delta');
  const all = Buffer.concat([cfg, key, delta]);
  // 故意切在帧头中间、帧体中间
  sock.emit('data', all.subarray(0, 3));
  sock.emit('data', all.subarray(3, cfg.length + 7));
  sock.emit('data', all.subarray(cfg.length + 7));
  assert.deepEqual(ws.sent.map(b => b.toString('hex')), [cfg, key, delta].map(b => b.toString('hex')));
});

test('h264 bridge: delta frames before the first key frame are dropped', t => {
  const { sock, ws, bridge } = harness();
  t.after(() => bridge.close());
  sock.emit('data', frame(T_DELTA, 'early'));
  assert.equal(ws.sent.length, 0);
  sock.emit('data', frame(T_KEY, 'k'));
  sock.emit('data', frame(T_DELTA, 'd'));
  assert.deepEqual(ws.sent.map(b => b[0]), [T_KEY, T_DELTA]);
});

test('h264 bridge: frames parked in the WS backpressure queue count as backlog', t => {
  // The connection router wraps every WS (ws-backpressure): frames wait in its
  // queue while bufferedAmount sits at its high-water mark. The bridge must see
  // that queue, or a slow link queues seconds of stale video instead of dropping.
  const { installWsBackpressure } = require('../src/ws-backpressure');
  const timers = [];
  const { sock, ws, bridge } = harness({
    highWater: 1000,
    lowWater: 100,
    beforeAttach: w => installWsBackpressure(w, {
      limits: { highWaterBytes: 100 },
      schedule: fn => { timers.push(fn); return timers.length; },
      cancelSchedule: () => {},
    }),
  });
  t.after(() => { bridge.close(); ws.emit('close'); });
  sock.emit('data', frame(T_KEY, 'k1'));
  assert.equal(ws.sent.length, 1);
  ws.bufferedAmount = 150; // above the queue's 100, below the bridge's 1000
  for (let i = 0; i < 40; i++) sock.emit('data', frame(T_DELTA, 'd'.repeat(100)));
  const queued = ws._multiccBackpressure.stats().queueBytes;
  assert.ok(queued <= 1000 + 105, `the bridge stops feeding the queue at its high-water mark (queued ${queued})`);
  assert.ok(bridge.stats.dropped > 0, 'deltas beyond the backlog are dropped, not queued');
});

test('h264 bridge: backlog drops deltas (never the stream), then asks for a key frame once drained', t => {
  const { sock, ws, bridge, advance } = harness({ highWater: 1000, lowWater: 100, keyRequestIntervalMs: 500 });
  t.after(() => bridge.close());
  sock.emit('data', frame(T_KEY, 'k1'));
  ws.bufferedAmount = 5000;
  sock.emit('data', frame(T_DELTA, 'd1'));
  sock.emit('data', frame(T_DELTA, 'd2'));
  assert.equal(ws.sent.length, 1, 'deltas over the high-water mark are dropped');
  assert.equal(sock.written.length, 0, 'no key request while the link is still backed up');
  assert.equal(ws.closedWith, null, 'a slow link must not close the stream');

  ws.bufferedAmount = 0;
  advance(1000);
  sock.emit('data', frame(T_DELTA, 'd3'));
  assert.equal(ws.sent.length, 1, 'still waiting for a key frame: deltas cannot be decoded');
  assert.deepEqual(sock.written.map(b => b[0]), [REQ_KEY]);
  sock.emit('data', frame(T_DELTA, 'd4'));
  assert.equal(sock.written.length, 1, 'key requests are throttled');

  sock.emit('data', frame(T_KEY, 'k2'));
  sock.emit('data', frame(T_DELTA, 'd5'));
  assert.deepEqual(ws.sent.slice(1).map(b => b.subarray(5).toString()), ['k2', 'd5']);
  assert.ok(bridge.stats.dropped >= 4);
});

test('h264 bridge: browser → agent passes only key requests and RFB key/pointer events', t => {
  const { sock, ws, bridge } = harness();
  t.after(() => bridge.close());
  ws.emit('message', Buffer.from([REQ_KEY]), true);
  ws.emit('message', Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]), true);
  ws.emit('message', Buffer.from([5, 1, 0, 10, 0, 20]), true);
  ws.emit('message', Buffer.from([5, 1, 0, 10]), true);                 // wrong length
  ws.emit('message', Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]), true); // RFB FramebufferUpdateRequest: not ours
  ws.emit('message', Buffer.from('K'), false);                           // text frame
  assert.deepEqual(sock.written.map(b => b.toString('hex')), ['4b', '0401000000000061', '050100'+'0a0014']);
});

test('h264 bridge: no frame from the agent → close so the page falls back to noVNC', async () => {
  const { ws } = harness({ firstFrameTimeoutMs: 20 });
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(ws.closedWith, { code: 1011, reason: 'h264-no-frames' });
});

test('h264 bridge: oversized frame header is rejected, socket close ends the WS', t => {
  const a = harness({ maxFrameBytes: 16 });
  t.after(() => a.bridge.close());
  const head = Buffer.alloc(5); head[0] = T_KEY; head.writeUInt32BE(1 << 20, 1);
  a.sock.emit('data', head);
  assert.equal(a.ws.closedWith.reason, 'h264-bad-frame');
  assert.ok(a.sock.destroyed);

  const b = harness();
  b.sock.emit('close');
  assert.equal(b.ws.closedWith.reason, 'h264-unavailable');
});

// ── 直连（P2P）切换：用假 session 钉住 bridge 侧的通道选择 ──
function p2pHarness(opts = {}) {
  let hooks = null;
  const signals = [];
  const session = { handled: [], closed: false, handleSignal(m) { this.handled.push(m); }, close() { this.closed = true; } };
  const h = harness({ p2p: x => { hooks = x; return session; }, p2pHello: { iceServers: [] }, ...opts });
  // 构造时发出的 rtc-hello 落在默认假 ws 的 sent 里：取出来单独核对
  const hello = JSON.parse(h.ws.sent.shift().toString());
  h.ws.send = (msg, _o, cb) => {
    if (typeof msg === 'string') signals.push(JSON.parse(msg));
    else h.ws.sent.push(Buffer.from(msg));
    cb?.();
  };
  const p2pSent = [];
  const sink = { kind: 'p2p', backlog: 0, buffered() { return this.backlog; }, send: m => p2pSent.push(Buffer.from(m)) };
  return { ...h, hooks: () => hooks, hello, session, signals, sink, p2pSent };
}

test('h264 bridge p2p: hello on attach, text frames are signalling, frames follow the active channel', t => {
  const { sock, ws, bridge, hooks, hello, session, signals, sink, p2pSent } = p2pHarness();
  t.after(() => bridge.close());
  assert.deepEqual(hello, { t: 'rtc-hello', iceServers: [] });
  ws.emit('message', Buffer.from(JSON.stringify({ t: 'rtc-offer', sdp: 'v=0' })), false);
  assert.deepEqual(session.handled, [{ t: 'rtc-offer', sdp: 'v=0' }]);

  sock.emit('data', frame(T_KEY, 'k1'));
  assert.equal(ws.sent.length, 1, 'relay before the channel opens');

  hooks().onOpen(sink);
  assert.deepEqual(signals.at(-1), { t: 'rtc-active', on: true }, 'browser told before frames move');
  assert.equal(sock.written.at(-1)[0], REQ_KEY, 'switching asks for a key frame');
  assert.equal(bridge.stats.transport, 'p2p');
  sock.emit('data', frame(T_DELTA, 'd-before-key'));
  sock.emit('data', frame(T_KEY, 'k2'));
  sock.emit('data', frame(T_DELTA, 'd2'));
  assert.deepEqual(p2pSent.map(b => b.subarray(5).toString()), ['k2', 'd2'], 'new channel starts at a key frame');
  assert.equal(ws.sent.length, 1, 'nothing more on the relay');

  // 直连上的输入同样按白名单转给 Agent
  hooks().onMessage(Buffer.from([5, 1, 0, 1, 0, 2]));
  hooks().onMessage(Buffer.from([3, 0]));
  assert.equal(sock.written.at(-1).toString('hex'), '050100010002');

  hooks().onClose();
  assert.deepEqual(signals.at(-1), { t: 'rtc-active', on: false });
  sock.emit('data', frame(T_KEY, 'k3'));
  assert.equal(ws.sent.at(-1).subarray(5).toString(), 'k3', 'back on the relay');
  assert.equal(bridge.stats.transport, 'relay');
});

test('h264 bridge p2p: backlog on the direct channel drops deltas; closing the WS closes the session', () => {
  const { sock, ws, hooks, session, sink, p2pSent } = p2pHarness({ highWater: 1000, lowWater: 100 });
  hooks().onOpen(sink);
  sock.emit('data', frame(T_KEY, 'k'));
  sink.backlog = 5000;
  sock.emit('data', frame(T_DELTA, 'd'));
  assert.equal(p2pSent.length, 1);
  ws.emit('close');
  assert.ok(session.closed);
});

test('p2p ice servers: public STUN by default, env overrides, empty = LAN only, junk ignored', () => {
  const { iceServersFromEnv, DEFAULT_STUN } = require('../src/remote-screen-p2p');
  assert.deepEqual(iceServersFromEnv({}), [{ urls: DEFAULT_STUN }]);
  assert.deepEqual(iceServersFromEnv({ MULTICC_REMOTE_STUN: '' }), []);
  assert.deepEqual(iceServersFromEnv({ MULTICC_REMOTE_STUN: 'stun:a.example:3478, turn:relay.example, http://x, stuns:b.example' }),
    [{ urls: ['stun:a.example:3478', 'stuns:b.example'] }], 'only stun:/stuns: — never a TURN relay');
});

// Wire golden (tests/fixtures/remote-screen-wire.json): the App, this bridge and
// the Agent each assert the same byte table, so no end can drift alone.
const wire = require('./fixtures/remote-screen-wire.json');
const hex = h => Buffer.from(h, 'hex');

test('wire golden: fixture bytes are the encoding of their own fields', () => {
  const be16 = v => [v >> 8, v & 0xff];
  for (const c of wire.clientToAgent) {
    const want = c.kind === 'pointer' ? [5, c.mask, ...be16(c.x), ...be16(c.y)]
      : c.kind === 'key' ? [4, c.down ? 1 : 0, 0, 0, ...[24, 16, 8, 0].map(s => (c.keysym >>> s) & 0xff)]
        : [REQ_KEY];
    assert.equal(c.hex, Buffer.from(want).toString('hex'), c.name);
  }
  for (const f of wire.agentToClient) {
    const payload = f.type === T_CONFIG ? hex(f.payloadHex)
      : Buffer.concat([(() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(f.pts)); return b; })(), hex(f.annexBHex)]);
    assert.equal(f.hex, frame(f.type, payload).toString('hex'), f.name);
    if (f.type === T_CONFIG) assert.deepEqual(JSON.parse(payload.toString()), f.json);
  }
  assert.deepEqual(wire.agentToClient.map(f => f.type), [T_CONFIG, T_KEY, T_DELTA]);
});

test('wire golden: bridge forwards every client message byte-for-byte and nothing else', t => {
  const { sock, ws, bridge } = harness();
  t.after(() => bridge.close());
  for (const c of wire.clientToAgent) {
    sock.written.length = 0;
    ws.emit('message', hex(c.hex), true);
    assert.deepEqual(sock.written.map(b => b.toString('hex')), [c.hex], c.name);
  }
  for (const c of wire.rejectedByBridge) {
    sock.written.length = 0;
    ws.emit('message', hex(c.hex), true);
    assert.deepEqual(sock.written, [], `${c.name}: ${c.why}`);
  }
});

test('wire golden: agent frames reach the client one message each, whatever the read boundaries', t => {
  for (const cut of [1, 3, 7, 64]) {
    const { sock, ws, bridge } = harness();
    t.after(() => bridge.close());
    const stream = Buffer.concat(wire.agentToClient.map(f => hex(f.hex)));
    for (let i = 0; i < stream.length; i += cut) sock.emit('data', stream.subarray(i, i + cut));
    assert.deepEqual(ws.sent.map(b => b.toString('hex')), wire.agentToClient.map(f => f.hex), `cut ${cut}`);
  }
});
