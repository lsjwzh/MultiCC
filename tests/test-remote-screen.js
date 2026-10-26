'use strict';

// Tests for src/remote-screen.js — the Node side of 「🖥 屏幕」.
//
// The service logic now lives in the Rust process multicc-remote; this file only
// starts and supervises it and forwards authenticated HTTP/WS traffic. The fake
// upstream (tests/helpers/remote-screen-fake-bin.js) implements the process
// protocol from docs/remote-screen-process.md, so every case here pins the Node
// hop — lazy start, ready timeout, secret header, transparent HTTP and WS
// relay, back-off restart, stdin EOF, and annotation forwarding.
//
// The browser-side cases at the bottom exercise public/chat-remote-screen.js in
// a VM; they are not Rust behaviour and stay here.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { spawn } = require('node:child_process');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-screen-test-'));
process.env.MULTICC_DATA_DIR = tmp;
process.env.MULTICC_AGENT_DIR = path.join(tmp, 'agent');
const rs = require('../src/remote-screen-rust');
const {
  installFakeRemote, waitFor, fakeClientWs, fakeUpstreamWs, JPEG, CAPABILITIES,
} = require('./helpers/remote-screen-node-harness');

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function mountHttp(t) {
  const app = express();
  app.use(express.json());
  rs.mount(app);
  const server = http.createServer(app);
  const port = await listen(server);
  t.after(() => new Promise(resolve => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  return `http://127.0.0.1:${port}`;
}

async function mountWs(t) {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => {
      if (new URL(req.url, 'http://x').searchParams.get('mode') === 'h264') rs.attachH264(ws, req);
      else rs.attachRfb(ws, req);
    });
  });
  const port = await listen(server);
  t.after(() => new Promise(resolve => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  return `ws://127.0.0.1:${port}/ws/remote-screen`;
}

function openClient(url) {
  const ws = new WebSocket(url);
  const text = [];
  const binary = [];
  const closed = new Promise(resolve => ws.on('close', (code, reason) => resolve({ code, reason: String(reason) })));
  ws.on('message', (data, isBinary) => (isBinary ? binary : text).push(isBinary ? Buffer.from(data) : String(data)));
  ws.on('error', () => {});
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('close', () => reject(new Error('closed before open'))); });
  opened.catch(() => {});
  return { ws, text, binary, closed, opened };
}

function withFake(t, env) {
  const fake = installFakeRemote(env);
  t.after(async () => { await rs._resetForTests(); fake.cleanup(); });
  return fake;
}

test('lazily starts the process once, sends the dir config and the internal secret', async t => {
  const fake = withFake(t);
  const [first, second] = await Promise.all([rs.capabilities(), rs.capabilities()]);
  assert.deepEqual(first, CAPABILITIES);
  assert.deepEqual(second, CAPABILITIES);

  const state = rs._state();
  assert.equal(state.attempts, 1, 'concurrent requests share one start');
  assert.ok(state.ready?.secret, 'ready line carried a secret');
  const events = fake.events();
  assert.equal(events.filter(e => e.type === 'config').length, 1);
  assert.deepEqual(events.find(e => e.type === 'config').config, { v: 1, dir: rs.DIR });
  const requests = events.filter(e => e.type === 'http');
  assert.equal(requests.length, 2);
  assert.ok(requests.every(e => e.authorized), 'every request carried the negotiated secret');
});

test('a process that never prints the ready line is killed and reported unavailable', async t => {
  const previous = rs._deps.readyTimeoutMs;
  rs._deps.readyTimeoutMs = 150;
  t.after(() => { rs._deps.readyTimeoutMs = previous; });
  const fake = withFake(t, { FAKE_REMOTE_NO_READY: '1' });

  assert.deepEqual(await rs.capabilities(), rs._unavailableCapabilities());
  assert.equal(rs._state().attempts, 1);
  assert.equal(rs._state().ready, null);
  const pid = Number(fs.readFileSync(fake.pidFile, 'utf8'));
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 3000, 'the stuck process is killed');
});

test('HTTP forwarding keeps status, headers and body, including JPEG bytes and HEAD', async t => {
  withFake(t);
  const base = await mountHttp(t);

  const frame = await fetch(`${base}/api/remote-screen/frame`);
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get('content-type'), 'image/jpeg');
  assert.equal(frame.headers.get('cache-control'), 'no-store');
  assert.equal(frame.headers.get('x-screen-width'), '1470');
  assert.deepEqual(Buffer.from(await frame.arrayBuffer()), JPEG, 'the JPEG body is byte-identical');

  const head = await fetch(`${base}/api/remote-screen/frame`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('x-screen-height'), '956');
  assert.equal((await head.arrayBuffer()).byteLength, 0, 'HEAD has no body');

  const region = await fetch(`${base}/api/remote-screen/frame?x=100&y=80&width=400&height=240`);
  assert.equal(region.headers.get('x-region-x'), '100');
  assert.equal(region.headers.get('x-region-width'), '400');
  await region.arrayBuffer();

  const input = await fetch(`${base}/api/remote-screen/input?slot=7`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'click', x: 1, y: 2 }),
  });
  assert.equal(input.status, 202, 'upstream status is preserved');
  assert.equal(input.headers.get('x-screen-echo'), '1', 'upstream x-screen-* header is preserved');
  const echoed = await input.json();
  assert.deepEqual(echoed.received, { op: 'click', x: 1, y: 2 });
  assert.equal(echoed.url, '/api/remote-screen/input?slot=7', 'path and query are unchanged');
  assert.equal(echoed.secret, rs._state().ready.secret);
});

test('wake requests carry the Node-computed power consent; other routes do not', async t => {
  withFake(t);
  const base = await mountHttp(t);
  const previous = rs._deps.powerConsent;
  t.after(() => { rs._deps.powerConsent = previous; });

  rs._deps.powerConsent = () => '1';
  const on = await (await fetch(`${base}/api/remote-screen/wake`)).json();
  assert.equal(on.consent, '1');
  rs._deps.powerConsent = () => '0';
  const off = await (await fetch(`${base}/api/remote-screen/wake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  assert.equal(off.consent, '0');
  assert.equal(off.method, 'POST');

  // 第三态：读电源设置失败。迁移前那是 readConsent 抛错 → 503 agent-unavailable；
  // 折成 '0' 会让前端看到「自动解锁未开启」，把用户引去改一个没问题的开关。
  rs._deps.powerConsent = () => 'error';
  const failed = await (await fetch(`${base}/api/remote-screen/wake`)).json();
  assert.equal(failed.consent, 'error');
  rs._deps.powerConsent = () => { throw new Error('power settings unreadable'); };
  const threw = await (await fetch(`${base}/api/remote-screen/wake`)).json();
  assert.equal(threw.consent, 'error', 'deps 抛异常也要落到 error 三态，不能静默变 0');

  await (await fetch(`${base}/api/remote-screen/frame`)).arrayBuffer();
});

test('without a binary every surface degrades: capabilities 200 false, HTTP 503, WS 1011', async t => {
  t.after(async () => { await rs._resetForTests(); });
  process.env.MULTICC_REMOTE_BIN = path.join(tmp, 'missing-multicc-remote');
  const base = await mountHttp(t);

  const caps = await fetch(`${base}/api/remote-screen/capabilities`);
  assert.equal(caps.status, 200);
  const unavailable = await caps.json();
  assert.equal(unavailable.supported, false);
  assert.equal(unavailable.reason, 'remote-unavailable');
  assert.deepEqual(unavailable.streams, { h264: false, rfb: false });
  assert.ok(Object.values(unavailable.features).every(value => value === false));

  for (const route of ['/api/remote-screen/frame', '/api/remote-screen/snapshot']) {
    const res = await fetch(`${base}${route}`, { method: route.endsWith('snapshot') ? 'POST' : 'GET',
      ...(route.endsWith('snapshot') ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, error: 'remote-unavailable' });
  }

  const wsBase = await mountWs(t);
  const client = openClient(`${wsBase}?mode=h264`);
  assert.deepEqual(await client.closed, { code: 1011, reason: 'remote-unavailable' });
});

test('WS forwarding passes text and binary frames unchanged and strips ticket/token', async t => {
  const fake = withFake(t);
  const wsBase = await mountWs(t);
  const client = openClient(`${wsBase}?mode=h264&ticket=T&token=X&lang=zh`);
  await client.opened;
  t.after(() => client.ws.terminate());

  await waitFor(() => client.text.length >= 1, 3000, 'upstream greeting');
  const hello = JSON.parse(client.text[0]);
  assert.equal(hello.url, '/ws/remote-screen?mode=h264&lang=zh',
    'ticket and token never reach the upstream; other query params survive');

  client.ws.send('ping-1');
  client.ws.send(Buffer.from([1, 0, 2, 255]));
  await waitFor(() => client.text.length >= 2 && client.binary.length >= 1, 3000, 'echoed frames');
  assert.equal(client.text[1], 'ping-1', 'text stays text');
  assert.deepEqual(client.binary[0], Buffer.from([1, 0, 2, 255]), 'binary stays binary');

  const upgrade = fake.events().find(e => e.type === 'ws-upgrade');
  assert.equal(upgrade.authorized, true, 'the internal secret authenticated the upgrade');
});

test('client messages queue before the upstream is ready, and overflow closes with 1013', async t => {
  withFake(t);
  const previous = rs._deps.connectUpstream;
  t.after(() => { rs._deps.connectUpstream = previous; });
  await rs.capabilities(); // 先把进程拉起来，免得排队计时被启动时间占掉

  let upstream = null;
  const downstream = fakeUpstreamWs();
  downstream.readyState = 0; // CONNECTING：消息只能排队
  rs._deps.connectUpstream = () => { upstream = downstream; return downstream; };

  const client = fakeClientWs();
  rs.attachH264(client, { url: '/ws/remote-screen?mode=h264' });
  await waitFor(() => upstream !== null, 2000, 'upstream connect');

  client.emit('message', Buffer.alloc(1024 * 1024 + 1), true);
  assert.equal(client.closed?.code, 1013);
  assert.match(String(client.closed?.reason || ''), /queue-overflow/);
});

test('queued messages flush in order once the upstream opens', async t => {
  withFake(t);
  const previous = rs._deps.connectUpstream;
  t.after(() => { rs._deps.connectUpstream = previous; });
  await rs.capabilities();

  let upstream = null;
  const downstream = fakeUpstreamWs();
  downstream.readyState = 0;
  rs._deps.connectUpstream = () => { upstream = downstream; return downstream; };

  const client = fakeClientWs();
  rs.attachRfb(client, { url: '/ws/remote-screen' });
  await waitFor(() => upstream !== null, 2000, 'upstream connect');
  client.emit('message', Buffer.from('first'), false);
  client.emit('message', Buffer.from([2, 3]), true);
  assert.equal(downstream.sent.length, 0, 'nothing is written while connecting');
  upstream.readyState = 1;
  upstream.emit('open');
  assert.deepEqual(downstream.sent.map(item => [item.data.toString(), item.binary]), [['first', false], ['\x02\x03', true]]);
  client.emit('close', 1000, 'bye');
});

test('close codes travel both ways; 1005/1006 become 1011', async t => {
  withFake(t);
  const previous = rs._deps.connectUpstream;
  t.after(() => { rs._deps.connectUpstream = previous; });
  await rs.capabilities();

  const attach = async () => {
    const downstream = fakeUpstreamWs();
    let created = false;
    rs._deps.connectUpstream = () => { created = true; return downstream; };
    const client = fakeClientWs();
    rs.attachH264(client, { url: '/ws/remote-screen?mode=h264' });
    await waitFor(() => created, 2000, 'upstream connect');
    return { client, downstream };
  };

  const clientToUpstream = await attach();
  clientToUpstream.client.close(4001, 'bye');
  assert.deepEqual(clientToUpstream.downstream.closed, { code: 4001, reason: 'bye' });

  for (const [code, want] of [[1000, 1000], [1013, 1013], [1006, 1011], [1005, 1011]]) {
    const { client, downstream } = await attach();
    downstream.emit('close', code, '');
    assert.equal(client.closed?.code, want, `upstream ${code} → client ${want}`);
  }
});

test('a slow client pauses the upstream between 64 KB and 16 KB', async t => {
  withFake(t);
  const previous = rs._deps.connectUpstream;
  t.after(() => { rs._deps.connectUpstream = previous; });
  await rs.capabilities();

  const downstream = fakeUpstreamWs();
  let created = false;
  rs._deps.connectUpstream = () => { created = true; return downstream; };
  const client = fakeClientWs();
  rs.attachH264(client, { url: '/ws/remote-screen?mode=h264' });
  await waitFor(() => created, 2000, 'upstream connect');

  client.bufferedAmount = 100 * 1024;
  downstream.emit('message', Buffer.from([1]), true);
  assert.equal(client.sent.length, 1);
  assert.equal(downstream.pauses, 1, 'reading the upstream stops above the high-water mark');

  downstream.emit('message', Buffer.from([2]), true);
  assert.equal(downstream.pauses, 1, 'one pause until the queue drains');

  client.bufferedAmount = 8 * 1024;
  await waitFor(() => downstream.resumes === 1, 1000, 'resume below the low-water mark');
  client.emit('close', 1000, '');
});

test('backpressure also counts the ws-backpressure queue, not only bufferedAmount', async t => {
  withFake(t);
  const previous = rs._deps.connectUpstream;
  t.after(() => { rs._deps.connectUpstream = previous; });
  await rs.capabilities();

  const downstream = fakeUpstreamWs();
  let created = false;
  rs._deps.connectUpstream = () => { created = true; return downstream; };
  const client = fakeClientWs();
  // connection-router 给每条 WS 都装了背压层：ws.send 先把字节攒在这里，
  // 没写进 socket 的那部分不计入 bufferedAmount。只看 bufferedAmount 会漏掉它。
  let queueBytes = 100 * 1024;
  client.bufferedAmount = 0;
  client._multiccBackpressure = { stats: () => ({ queueBytes, queueMessages: 3, sending: false, congestedAt: 0, closed: false }) };
  rs.attachH264(client, { url: '/ws/remote-screen?mode=h264' });
  await waitFor(() => created, 2000, 'upstream connect');

  downstream.emit('message', Buffer.from([1]), true);
  assert.equal(downstream.pauses, 1, 'queueBytes 超过高水位也要暂停上游');

  queueBytes = 8 * 1024;
  await waitFor(() => downstream.resumes === 1, 1000, 'queueBytes 回落到低水位以下才恢复');

  // 两处相加：bufferedAmount 和 queueBytes 任何一个单独低于水位都不能提前放行。
  client.bufferedAmount = 60 * 1024;
  queueBytes = 10 * 1024;
  downstream.emit('message', Buffer.from([2]), true);
  assert.equal(downstream.pauses, 2, '两段积压要合起来判断');
  client.bufferedAmount = 8 * 1024;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(downstream.resumes, 1, '单独的 bufferedAmount 低了，合起来仍高于低水位就不该恢复');
  queueBytes = 0;
  await waitFor(() => downstream.resumes === 2, 1000, '合并积压降到低水位以下才恢复');
  client.emit('close', 1000, '');
});

test('a crash closes live WS with 1011, backs off, and restarts on demand', async t => {
  const fake = withFake(t, { FAKE_REMOTE_EXIT_AFTER_MS: '150' });
  const previous = { base: rs._deps.restartBaseMs, max: rs._deps.restartMaxMs };
  rs._deps.restartBaseMs = 300;
  rs._deps.restartMaxMs = 5000;
  t.after(() => { rs._deps.restartBaseMs = previous.base; rs._deps.restartMaxMs = previous.max; });

  const previousConnect = rs._deps.connectUpstream;
  t.after(() => { rs._deps.connectUpstream = previousConnect; });
  const downstream = fakeUpstreamWs();
  rs._deps.connectUpstream = () => downstream;
  const client = fakeClientWs();
  rs.attachH264(client, { url: '/ws/remote-screen?mode=h264' });
  await waitFor(() => rs._state().ready !== null, 3000, 'first ready');

  await waitFor(() => client.closed !== null, 3000, 'the live WS is closed when the process exits');
  assert.equal(client.closed.code, 1011);
  assert.match(String(client.closed.reason), /remote-unavailable/);
  assert.equal(rs._state().attempts, 1);
  assert.equal(rs._state().restartPending, true, 'the back-off window is armed');
  const firstBackoff = rs._state().backoffMs;
  assert.ok(firstBackoff >= 600, `back-off grows (${firstBackoff})`);

  // 退避窗口内的请求照样拿到 503，但会记下「有人要」，窗口到期自动重启。
  assert.deepEqual(await rs.capabilities(), rs._unavailableCapabilities());
  await waitFor(() => rs._state().attempts === 2, 3000, 'automatic restart after the back-off');
  await waitFor(() => rs._state().ready !== null, 3000, 'the restarted process is ready');
  assert.ok(fake.events().some(e => e.type === 'exit-after'));
});

test('stdin EOF alone stops the child when the Node process exits', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-remote-eof-'));
  const binary = path.join(dir, 'multicc-remote');
  const fakeBin = path.join(__dirname, 'helpers', 'remote-screen-fake-bin.js');
  fs.writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${fakeBin}" "$@"\n`, { mode: 0o755 });
  const pidFile = path.join(dir, 'remote.pid');
  const script = `const rs = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'remote-screen-rust.js'))});`
    + 'rs.capabilities().then(r => process.exit(r.supported ? 0 : 1), () => process.exit(1));';
  const child = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, MULTICC_DATA_DIR: dir, MULTICC_REMOTE_BIN: binary,
      FAKE_REMOTE_PID_FILE: pidFile, FAKE_REMOTE_EVENTS_FILE: path.join(dir, 'events.jsonl') },
    stdio: 'ignore',
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 3000,
    'the child exits on stdin EOF');
});

test('annotations on own shots are forwarded to /internal/annotation; others never leave Node', async t => {
  const fake = withFake(t);
  fs.mkdirSync(rs.DIR, { recursive: true });
  const shot = path.join(rs.DIR, 'shot-1.png');
  fs.writeFileSync(shot, 'old');
  assert.equal(rs.isOwnShot(shot), true);
  assert.equal(rs.isOwnShot(path.join(rs.DIR, 'live.jpg')), false);
  assert.equal(rs.isOwnShot(path.join(rs.DIR, 'sub', 'shot-1.png')), false);

  const result = await rs.handleAnnotation({ src: shot, width: 1470, height: 956, kind: 'point', a: { x: 1, y: 2 } });
  assert.equal(result.ok, true);
  assert.equal(result.refresh, true);
  assert.match(result.text, /已执行：point/);
  assert.deepEqual(result.received.a, { x: 1, y: 2 });

  const forwards = fake.events().filter(e => e.type === 'http' && e.url.startsWith('/internal/annotation'));
  assert.equal(forwards.length, 1);

  const foreign = path.join(tmp, 'shot-1.png');
  fs.writeFileSync(foreign, 'x');
  const refused = await rs.handleAnnotation({ src: foreign, kind: 'point' });
  assert.deepEqual(refused, { ok: false, refresh: false, text: '不是远程屏幕截图' });
  assert.equal(fake.events().filter(e => e.type === 'http' && e.url.startsWith('/internal/annotation')).length, 1,
    'foreign shots are never forwarded');
});

test('annotation-live hands remote-screen shots to the forwarding layer without config', async t => {
  withFake(t);
  fs.mkdirSync(rs.DIR, { recursive: true });
  const shot = path.join(rs.DIR, 'shot-2.png');
  fs.writeFileSync(shot, 'old');
  const live = require('../src/annotation-live');
  const app = express();
  app.use(express.json());
  live.mount(app);
  const server = http.createServer(app);
  const port = await listen(server);
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }));

  const response = await fetch(`http://127.0.0.1:${port}/api/annotation-live`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's', src: shot, width: 1470, height: 956, kind: 'point', a: { x: 3, y: 4 } }),
  });
  const body = await response.json();
  assert.deepEqual(body, { ok: true, relayed: 1, results: [{ ok: true, refresh: true, text: '已执行：point', received: {
    sessionId: 's', src: shot, width: 1470, height: 956, kind: 'point', a: { x: 3, y: 4 }, b: null } }] });
});

// ── 浏览器侧（public/chat-remote-screen.js）：与 Rust 迁移无关，原样保留 ──

// Execute the actual browser functions with controlled geometry and transport.
function webHarness() {
  const vm = require('node:vm');
  const window = { addEventListener() {} };
  const document = { readyState: 'loading', addEventListener() {}, querySelector() { return null; },
    createElement() { return { style: {}, remove() {} }; } };
  const context = { window, document, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, fetch: null };
  let source = fs.readFileSync('public/chat-remote-screen.js', 'utf8');
  // 钩子按源码文本改这一行：导出表一变，这里就得跟着变（少了它就是 probe 未定义，
  // 两个用例一起红 —— 这正是「让测试自己告诉你它被改坏了」的那条线）。
  source = source.replace('global.MultiCCRemoteScreen = Object.freeze({ open, close, openMode });',
    'global.probe = { toScreen, applyBoxZoom, zoomTap, loop, resetZoom, wirePointer, set: value => { s = value; ov = { appendChild() {}, classList: { toggle() {} } }; }, zoom };');
  vm.runInNewContext(source, context);
  return { context, probe: window.probe };
}

test('web fallback streams before lift and coalesces motion behind a slow request', async () => {
  const { context, probe } = webHarness();
  const handlers = {};
  const stage = { addEventListener: (name, fn) => { handlers[name] = fn; }, setPointerCapture() {} };
  const state = {
    control: true, screenW: 400, screenH: 200, stage, unhalt: {},
    img: { naturalWidth: 400, naturalHeight: 200, getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 200 }) },
  };
  probe.set(state);
  const sent = [];
  let finish;
  context.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    if (sent.length === 1) await new Promise(resolve => { finish = resolve; });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  probe.wirePointer(stage);
  const event = x => ({ pointerId: 1, button: 0, clientX: x, clientY: 50, preventDefault() {} });
  handlers.pointerdown(event(50));
  handlers.pointermove(event(80));
  assert.equal(sent.length, 1, 'press has left the browser before pointerup');
  assert.deepEqual([sent[0].op, sent[0].mask, sent[0].x], ['pointer', 1, 50]);
  handlers.pointermove(event(100));
  handlers.pointermove(event(120));
  handlers.pointerup(event(130));
  finish();
  await state.cancelFallback();
  assert.deepEqual(sent.map(sample => [sample.mask, sample.x]), [[1, 50], [1, 130], [0, 130]]);
  assert.ok(sent.every(sample => sample.op === 'pointer'));
});

test('web fallback retains dragging when an older Agent lacks the pointer protocol', async () => {
  const { context, probe } = webHarness();
  const handlers = {};
  const stage = { addEventListener: (name, fn) => { handlers[name] = fn; }, setPointerCapture() {} };
  const state = { control: true, screenW: 400, screenH: 200, stage, unhalt: {},
    img: { naturalWidth: 400, naturalHeight: 200, getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 200 }) } };
  probe.set(state);
  const sent = [];
  context.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); sent.push(body);
    return { ok: true, json: async () => body.op === 'pointer'
      ? { ok: false, error: 'unknown op: pointer' } : { ok: true } };
  };
  probe.wirePointer(stage);
  const event = x => ({ pointerId: 1, button: 0, clientX: x, clientY: 50, preventDefault() {} });
  handlers.pointerdown(event(50));
  handlers.pointermove(event(100));
  handlers.pointerup(event(120));
  await state.cancelFallback();
  assert.deepEqual(sent.map(body => body.op), ['pointer', 'drag']);
  assert.deepEqual([sent[1].x, sent[1].x2], [50, 120]);
});

test('web crops use image letterboxing and nested origins; view-only zoom taps send no input', async () => {
  const { context, probe } = webHarness();
  const state = {
    screenW: 1000, screenH: 500, viewRegion: { x: 200, y: 100, width: 400, height: 200 },
    region: null, regionEpoch: 0, running: true, closed: false, control: false,
    img: { naturalWidth: 800, naturalHeight: 400, style: {}, getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 400 }) },
    stage: { getBoundingClientRect: () => ({ left: 10, top: 20 }) },
    zoomer: { style: {} }, zoomBadge: {}, modeBtn: { classList: { toggle() {} } },
    keybar: {}, hint: {}, status: { classList: { toggle() {} } }, pauseBtn: {},
  };
  probe.set(state);
  const p = probe.toScreen({ clientX: 210, clientY: 220 });
  assert.deepEqual([p.x, p.y], [400, 200]);
  assert.equal(probe.toScreen({ clientX: 210, clientY: 50 }), null, 'letterbox does not map to an input');
  context.fetch = () => { throw new Error('view-only must not send'); };
  await probe.zoomTap({ clientX: 210, clientY: 220 }, 0);
  // Image occupies stage y=100..300. Selecting its middle quarter crops at the source.
  await probe.applyBoxZoom({ x: 100, y: 150 }, { x: 300, y: 250 });
  assert.deepEqual(Object.values(state.region), [300, 150, 200, 100]);
  assert.equal(state.regionLoading, true, 'input is blocked until the new crop arrives');
  assert.equal(probe.zoom.scale, 1, 'source crop is fitted, not CSS-enlarged from old pixels');
});

test('web discards late full-screen frames after a selection and uses returned region geometry', async () => {
  const { context, probe } = webHarness();
  let finishOld;
  const state = { region: null, regionEpoch: 0, screenW: 1000, screenH: 500,
    paused: false, closed: false, errAt: 0, status: { classList: { toggle() {} } }, img: {} };
  probe.set(state);
  const paths = [];
  context.fetch = url => {
    paths.push(url);
    if (paths.length === 1) return new Promise(resolve => { finishOld = resolve; });
    return Promise.resolve({ ok: true, headers: new Headers({ 'X-Screen-Width': '1000', 'X-Screen-Height': '500',
      'X-Region-X': '100', 'X-Region-Y': '50', 'X-Region-Width': '200', 'X-Region-Height': '100' }), blob: async () => new Blob(['img']) });
  };
  Object.defineProperty(state.img, 'src', { set() { state.paused = true; state.img.onload(); } });
  const pending = probe.loop();
  state.region = { x: 100, y: 50, width: 200, height: 100 }; state.regionEpoch++; state.regionLoading = true;
  finishOld({ ok: true, headers: new Headers(), blob() { throw new Error('obsolete full-screen frame must be discarded'); } });
  await pending;
  assert.ok(paths[1].includes('x=100'));
  assert.deepEqual(Object.values(state.viewRegion), [100, 50, 200, 100]);
  assert.equal(state.regionLoading, false);
  URL.revokeObjectURL(state.lastUrl);
});

test('AI snap-hires requests source coordinates without resizing the result', () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(tmp, 'mcu-'));
  const agent = path.join(dir, 'agent');
  const log = path.join(dir, 'calls');
  fs.writeFileSync(agent, `#!/bin/bash
if [ "$1" = status ]; then echo '{"accessibility":true,"screenRecording":true}'; else printf '%s\\n' "$@" > "$MCU_TEST_LOG"; touch "$2"; fi
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'sips'), `#!/bin/bash
case "$2" in pixelWidth) echo 'pixelWidth: 800';; pixelHeight) echo 'pixelHeight: 480';; *) exit 9;; esac
`, { mode: 0o755 });
  const out = path.join(dir, 'detail.png');
  const result = execFileSync('bash', ['skills/multicc-computer-use/scripts/mcu.sh', 'snap-hires', out, '400', '240', '100', '80'], {
    encoding: 'utf8', env: { ...process.env, MCU_BACKEND: '', MULTICC_AGENT_BIN: agent, MCU_TEST_LOG: log, PATH: dir + path.delimiter + process.env.PATH },
  });
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['snap', out, '100', '80', '400', '240']);
  assert.match(result, /logical origin=100,80 size=400x240; pixels=800x480/);
});
