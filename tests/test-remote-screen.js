'use strict';
// Tests for src/remote-screen.js — the 「🖥 屏幕」 remote-assist routes.
// The Agent socket is a fake unix-socket server (one JSON line in, one out);
// sips/osascript are stubbed through _deps.execFile, and the capture dir is a
// tmp dir. The real Agent, screen and ~/.multicc are never touched.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const test = require('node:test');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-screen-test-'));
process.env.MULTICC_DATA_DIR = tmp;
const rs = require('../src/remote-screen');
const live = require('../src/annotation-live');

const realAgentCall = rs._deps.agentCall;
rs._deps.dir = path.join(tmp, 'remote-screen');
fs.mkdirSync(rs._deps.dir, { recursive: true });

// sips -g → 2940x1912 physical; osascript → 1470x956 logical; conversions touch the --out file.
rs._deps.execFile = (cmd, args, opts, cb) => {
  if (cmd === 'osascript') return cb(null, '0, 0, 1470, 956\n');
  if (cmd === 'sips' && args[0] === '-g') return cb(null, 'pixelWidth: 2940\npixelHeight: 1912\n');
  if (cmd === 'sips') { fs.writeFileSync(args[args.indexOf('--out') + 1], 'img'); return cb(null, ''); }
  cb(new Error('unexpected ' + cmd));
};

let agentLog = [];
let agentReply = () => ({ ok: true });
rs._deps.agentCall = async req => { agentLog.push(req); return agentReply(req); };

function fakeApp() {
  const handlers = {};
  return { handlers, get: (p, h) => { handlers['GET ' + p] = h; }, post: (p, h) => { handlers['POST ' + p] = h; } };
}
async function invoke(handler, body) {
  const res = {
    statusCode: 200, body: undefined, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(v) { this.body = v; return this; },
    set(h) { Object.assign(this.headers, h); return this; },
    end(v) { this.body = v; return this; },
  };
  await handler({ body: body || {} }, res);
  return res;
}

test('agentCall speaks one JSON line over the unix socket', async () => {
  const sock = path.join(tmp, 'a.sock');
  const server = net.createServer(c => {
    c.on('data', d => {
      const req = JSON.parse(String(d).trim());
      c.write(JSON.stringify({ ok: true, echo: req.op, session: req.session }) + '\n');
    });
  });
  await new Promise(r => server.listen(sock, r));
  const prev = rs._deps.sock;
  rs._deps.sock = sock;
  try {
    assert.deepEqual(await realAgentCall({ op: 'status', session: 'remote-screen' }), { ok: true, echo: 'status', session: 'remote-screen' });
    rs._deps.sock = path.join(tmp, 'missing.sock');
    assert.equal((await realAgentCall({ op: 'status' })).error, 'agent-unreachable');
  } finally {
    rs._deps.sock = prev;
    server.close();
  }
});

test('input whitelist: unlock/see/set refused, fields coerced and clamped, session pinned', () => {
  for (const op of ['unlock', 'see', 'set', 'snap', 'probe-unlock', '']) assert.ok(rs.buildInput({ op }).error, op);
  const click = rs.buildInput({ op: 'click', x: '10.5', y: 20, button: 'right', count: 9, session: 'evil', allowTerminal: true }).req;
  assert.deepEqual(click, { op: 'click', session: 'remote-screen', x: 10.5, y: 20, allowSystem: true, button: 'right', count: 3 });
  assert.equal(rs.buildInput({ op: 'scroll', x: 1, y: 1, amount: -999 }).req.amount, -50);
  assert.ok(rs.buildInput({ op: 'drag', x: 1, y: 1 }).error);
  assert.equal(rs.buildInput({ op: 'drag', x: 1, y: 1, x2: 5, y2: 5, ms: 1 }).req.ms, 80);
  assert.ok(rs.buildInput({ op: 'type', text: 'x'.repeat(4001) }).error);
  assert.ok(rs.buildInput({ op: 'press', keys: '' }).error);
  assert.equal(rs.buildInput({ op: 'press', keys: ' cmd+c ' }).req.keys, 'cmd+c');
  assert.deepEqual(rs.buildInput({ op: 'release' }).req, { op: 'release', session: 'remote-screen' });
});

test('routes: frame is a logical-width jpeg, snapshot returns a download url, refusals are explained', async () => {
  rs._resetForTests();
  agentLog = [];
  const app = fakeApp();
  rs.mount(app);
  const frame = await invoke(app.handlers['GET /api/remote-screen/frame']);
  assert.equal(frame.headers['Content-Type'], 'image/jpeg');
  assert.equal(frame.headers['X-Screen-Width'], '1470');
  assert.equal(agentLog[0].op, 'snap');

  const snap = await invoke(app.handlers['POST /api/remote-screen/snapshot']);
  assert.equal(snap.body.width, 1470);
  assert.ok(rs.isOwnShot(snap.body.path));
  assert.match(snap.body.url, /^\/api\/download\?path=.*shot-\d+\.png&inline=1$/);

  const bad = await invoke(app.handlers['POST /api/remote-screen/input'], { op: 'unlock' });
  assert.equal(bad.statusCode, 400);
  agentReply = () => ({ ok: false, reason: 'user-stopped' });
  const halted = await invoke(app.handlers['POST /api/remote-screen/input'], { op: 'click', x: 1, y: 2 });
  assert.equal(halted.body.error, 'user-stopped');
  assert.match(halted.body.message, /Esc/);
  agentReply = () => ({ ok: true });
});

test('annotations on remote-screen shots run as input and refresh the same file', async () => {
  const shot = path.join(rs._deps.dir, 'shot-1.png');
  fs.writeFileSync(shot, 'old');
  agentLog = [];
  const point = await rs.handleAnnotation({ src: shot, width: 1470, height: 956, kind: 'point', a: { x: 100, y: 50 } });
  assert.deepEqual(point, { ok: true, refresh: true, text: '已点击 (100, 50)' });
  assert.deepEqual(agentLog.map(r => r.op), ['click', 'snap']);
  assert.equal(fs.readFileSync(shot, 'utf8'), 'img');

  agentLog = [];
  // 标注图若被缩小到一半，坐标按逻辑宽放大回去。
  await rs.handleAnnotation({ src: shot, width: 735, kind: 'arrow', a: { x: 10, y: 10 }, b: { x: 20, y: 30 } });
  assert.deepEqual(agentLog[0], { op: 'drag', session: 'remote-screen', x: 20, y: 20, allowSystem: true, x2: 40, y2: 60, ms: 400 });

  agentLog = [];
  await rs.handleAnnotation({ src: shot, width: 1470, kind: 'box', a: { x: 0, y: 0 }, b: { x: 10, y: 20 } });
  assert.deepEqual([agentLog[0].x, agentLog[0].y], [5, 10]);

  agentLog = [];
  assert.equal((await rs.handleAnnotation({ src: shot, width: 1470, kind: 'recapture' })).refresh, true);
  assert.deepEqual(agentLog.map(r => r.op), ['snap']);

  agentReply = req => (req.op === 'click' ? { ok: false, reason: 'screen-locked' } : { ok: true });
  const locked = await rs.handleAnnotation({ src: shot, width: 1470, kind: 'point', a: { x: 1, y: 1 } });
  assert.equal(locked.ok, false);
  assert.match(locked.text, /锁定/);
  agentReply = () => ({ ok: true });

  assert.equal((await rs.handleAnnotation({ src: path.join(tmp, 'shot-1.png'), kind: 'point', a: { x: 1, y: 1 } })).ok, false);
  assert.equal(rs.isOwnShot(path.join(rs._deps.dir, '..', 'remote-screen', 'live.jpg')), false);
  assert.equal(rs.isOwnShot(path.join(rs._deps.dir, 'sub', 'shot-1.png')), false);
});

test('annotation-live hands remote-screen shots to the built-in handler without config', async () => {
  const shot = path.join(rs._deps.dir, 'shot-2.png');
  fs.writeFileSync(shot, 'old');
  const app = fakeApp();
  live.mount(app);
  agentLog = [];
  const res = await invoke(app.handlers['POST /api/annotation-live'], { sessionId: 's', src: shot, width: 1470, height: 956, kind: 'point', a: { x: 3, y: 4 } });
  assert.deepEqual(res.body, { ok: true, relayed: 1, results: [{ ok: true, refresh: true, text: '已点击 (3, 4)' }] });
  assert.equal(agentLog[0].op, 'click');
});

// ── RFB 流式模式：/ws/remote-screen ↔ rfb.sock 的字节管道 ──
const { EventEmitter } = require('events');
function fakeWs() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.sent = [];
  ws.closed = null;
  ws.send = d => ws.sent.push(d);
  ws.close = (code, reason) => { ws.closed = { code, reason }; ws.readyState = 3; ws.emit('close'); };
  return ws;
}
const tick = ms => new Promise(r => setTimeout(r, ms));

test('attachRfb pipes bytes both ways and queues pre-connect messages', async () => {
  const sockPath = path.join(tmp, 'rfb.sock');
  const got = [];
  const conns = [];
  const server = net.createServer(c => {
    conns.push(c);
    c.write('RFB 003.008\n'); // Agent 的版本串应原样透到浏览器端
    c.on('data', d => got.push(d));
  });
  await new Promise(r => server.listen(sockPath, r));
  const prev = rs._deps.rfbSock;
  rs._deps.rfbSock = sockPath;
  const ws = fakeWs();
  try {
    rs.attachRfb(ws);
    ws.emit('message', Buffer.from('RFB 003.008\n')); // connect 前到达 → 排队，connect 后按序补投
    await tick(200);
    assert.deepEqual(ws.sent.map(String), ['RFB 003.008\n']);
    assert.deepEqual(got.map(String), ['RFB 003.008\n']);
    ws.emit('message', Buffer.from('\x02\x00\x00\x00')); // ClientInit
    await tick(100);
    assert.deepEqual(got.map(String), ['RFB 003.008\n', '\x02\x00\x00\x00']);
    ws.emit('close'); // 浏览器端断开 → 桥拆掉 unix socket
    await tick(100);
    assert.ok(conns[0].destroyed);
  } finally {
    rs._deps.rfbSock = prev;
    server.close();
  }
});

test('attachRfb closes the ws with 1011 when rfb.sock is unavailable', async () => {
  const prev = rs._deps.rfbSock;
  rs._deps.rfbSock = path.join(tmp, 'missing-rfb.sock');
  const ws = fakeWs();
  rs.attachRfb(ws);
  await tick(150);
  try {
    assert.deepEqual(ws.closed, { code: 1011, reason: 'rfb-unavailable' });
  } finally { rs._deps.rfbSock = prev; }
});

test('connection-router routes /ws/remote-screen through the rfb bridge behind site auth', () => {
  const src = fs.readFileSync('src/ws/connection-router.js', 'utf8');
  // 免 id 的 WS 路径表里带上了 /ws/remote-screen（远程访问仍要 ws-ticket，本地免票）。
  assert.match(src, /SESSIONLESS_WS_PATHS[\s\S]*?\/ws\/remote-screen/);
  assert.match(src, /remoteScreenRfb\.attachRfb\(ws\)/);
});

test('唤起屏幕只允许已开启自动解锁的用户，并核对真实解锁结果', async () => {
  const { mountWakeRoutes } = require('../src/remote-screen-wake');
  let enabled = false, locked = true, permissions = true, halted = false, unlockOk = true, staysLocked = false;
  let wakes = 0, unlocks = 0, invalidations = 0;
  const app = fakeApp();
  mountWakeRoutes(app, {
    consent: async () => enabled,
    wakeDisplay: async () => { wakes++; }, invalidate: () => { invalidations++; },
    call: async req => {
      if (req.op === 'status') return { ok: true, screenLocked: locked,
        accessibility: permissions, screenRecording: permissions, control: { halted } };
      assert.deepEqual(req, { op: 'unlock', session: 'remote-screen' });
      unlocks++;
      if (!unlockOk) return { ok: false, reason: 'password-needs-authorization' };
      if (!staysLocked) locked = false;
      return { ok: true };
    },
  });
  const get = () => invoke(app.handlers['GET /api/remote-screen/wake']);
  const post = () => invoke(app.handlers['POST /api/remote-screen/wake']);
  assert.equal((await get()).body.canWake, false);
  assert.equal(unlocks, 0);
  assert.equal((await post()).body.error, 'auto-unlock-disabled');
  enabled = true; permissions = false;
  assert.equal((await post()).body.error, 'permissions-required');
  permissions = true; halted = true;
  assert.equal((await post()).body.error, 'user-stopped');
  assert.equal(wakes, 0);
  halted = false; unlockOk = false;
  assert.equal((await post()).body.error, 'password-needs-authorization');
  unlockOk = true; staysLocked = true;
  assert.equal((await post()).body.error, 'still-locked');
  assert.equal(invalidations, 0);
  staysLocked = false;
  assert.equal((await post()).body.screenLocked, false);
  assert.equal(invalidations, 1);
  const count = unlocks;
  assert.equal((await post()).body.ok, true);
  assert.equal(unlocks, count, '未锁屏时只唤醒，不提交密码');
});

test('并发点击不会重复提交解锁密码', async () => {
  const { mountWakeRoutes } = require('../src/remote-screen-wake');
  const app = fakeApp();
  let finish, calls = 0;
  mountWakeRoutes(app, {
    consent: async () => true, invalidate: () => {},
    wakeDisplay: () => new Promise(resolve => { finish = resolve; }),
    call: async () => { calls++; return { ok: true, screenLocked: false, accessibility: true, screenRecording: true }; },
  });
  const first = invoke(app.handlers['POST /api/remote-screen/wake']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await invoke(app.handlers['POST /api/remote-screen/wake'])).body.error, 'busy');
  finish();
  assert.equal((await first).body.ok, true);
  assert.equal(calls, 2);
});
