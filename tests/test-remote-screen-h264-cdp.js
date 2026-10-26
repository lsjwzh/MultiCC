'use strict';

// 「🖥 屏幕」高清流畅模式端到端：假 Agent（h264.sock 帧格式，内容是 ffmpeg 编的真实
// H.264）→ 假 multicc-remote 进程 → Node 转发层 → 真 Chrome 里的
// chat-remote-screen-h264.js（WebCodecs 解码）。验证：能解码出画面、canvas = 屏幕
// 逻辑尺寸、首个关键帧请求、指针/键盘按 RFB 字节格式回到 Agent。
//
// 分帧 / 关键帧节流那些逻辑已经属于 Rust（native/remote/），这里只钉 Node 搬字节的
// 这一跳不吞不改协议。需要 ffmpeg 与 Chrome，缺任何一个就跳过。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

process.env.MULTICC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-h264-cdp-data-'));
const rs = require('../src/remote-screen-rust');
const { installFakeRemote } = require('./helpers/remote-screen-node-harness');

const REQ_KEY = 0x4b;   // 网页播放端请求关键帧的单字节（线协议，跟 Rust 侧一致）

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const W = 320, H = 240;

function encodeClip(dir) {
  const out = path.join(dir, 'clip.h264');
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${W}x${H}:rate=30`,
    '-frames:v', '60', '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-bf', '0', '-g', '30',
    '-x264-params', 'aud=1:repeat-headers=1', '-f', 'h264', out]);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  return fs.readFileSync(out);
}

// Annex B → 访问单元（按 AUD 切），标出关键帧并从 SPS 拼出 avc1 codec 字符串。
function accessUnits(bytes) {
  // x264 混用 3 字节与 4 字节起始码；统一成 4 字节（与 Agent 输出一致）。
  const starts = [];
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) { starts.push(i + 3); i += 2; }
  }
  const nals = starts.map((s, i) => {
    let end = starts[i + 1] != null ? starts[i + 1] - 3 : bytes.length;
    if (end > s && bytes[end - 1] === 0) end -= 1; // 下一个 4 字节起始码的前导 0
    return Buffer.concat([Buffer.from([0, 0, 0, 1]), bytes.subarray(s, end)]);
  });
  const units = [];
  let codec = null;
  for (const nal of nals) {
    const type = nal[4] & 0x1f;
    if (type === 9 || !units.length) units.push({ parts: [], key: false });
    const unit = units[units.length - 1];
    unit.parts.push(nal);
    if (type === 5) unit.key = true;
    if (type === 7 && !codec) codec = 'avc1.' + [nal[5], nal[6], nal[7]].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  return { codec, units: units.map(u => ({ key: u.key, data: Buffer.concat(u.parts) })) };
}

function msg(type, payload) {
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

// 只装播放端的测试页：640×480 的容器 + chat-remote-screen-h264.js。
function viewerRoutes() {
  return {
    '/': { headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<!doctype html><body style="margin:0"><div id="t" style="position:fixed;inset:0;width:640px;height:480px"></div>'
        + '<script src="/chat-remote-screen-h264.js"></script></body>' },
    '/chat-remote-screen-h264.js': { headers: { 'content-type': 'text/javascript' },
      body: fs.readFileSync(path.join(__dirname, '..', 'public', 'chat-remote-screen-h264.js')) },
  };
}

// 假 Agent（h264.sock 帧格式，循环播 ffmpeg 编的片段）+ 假上游进程 + Node 转发层。
async function fakeAgentAndRelay(t, WebSocketServer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-h264-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { codec, units } = accessUnits(encodeClip(dir));
  assert.ok(codec && units.length >= 30 && units[0].key, 'clip parsed into access units');

  // 假 Agent：先发 config，再按 30fps 循环发帧；记下浏览器发回来的字节。
  const sockPath = path.join(dir, 'h264.sock');
  const received = [];
  const timers = [];
  const agent = net.createServer(conn => {
    conn.on('data', d => received.push(...d));
    conn.on('error', () => {});
    conn.write(msg(1, Buffer.from(JSON.stringify({ codec, width: W, height: H }))));
    let i = 0;
    const timer = setInterval(() => {
      const u = units[i % units.length];
      const ts = Buffer.alloc(8);
      ts.writeBigUInt64BE(BigInt(i) * 33333n);
      conn.write(msg(u.key ? 2 : 3, Buffer.concat([ts, u.data])));
      i += 1;
    }, 33);
    timers.push(timer);
    conn.on('close', () => clearInterval(timer));
  });
  await new Promise(r => agent.listen(sockPath, r));
  t.after(() => { timers.forEach(clearInterval); agent.close(); });

  // 假进程一收到 WS 消息就写进这个 socket，反向数据按二进制帧发回。
  const fake = installFakeRemote({ FAKE_REMOTE_PIPE_SOCK: sockPath });
  t.after(async () => { await rs._resetForTests(); fake.cleanup(); });

  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => wss.once('listening', r));
  wss.on('connection', ws => rs.attachH264(ws, { url: '/ws/remote-screen?mode=h264' }));
  t.after(() => { for (const c of wss.clients) c.terminate(); wss.close(); });
  const wsUrl = `ws://127.0.0.1:${wss.address().port}/ws/remote-screen?mode=h264`;
  return { wsUrl, received };
}

test('h264 stream: fake agent → multicc-remote → Node forwarder → Chrome decodes frames and sends RFB input back',
  { skip: !hasFfmpeg || !findChromeBinary() ? 'needs ffmpeg and Chrome' : false, timeout: 60000 }, async t => {
    let WebSocketServer;
    try { ({ WebSocketServer } = require('ws')); } catch { t.skip('ws module not installed'); return; }
    const { wsUrl, received } = await fakeAgentAndRelay(t, WebSocketServer);

    await withCdpHarness({ routes: viewerRoutes() }, async page => {
      await page.navigate(page.baseUrl + '/');
      const supported = await page.evaluate('window.MultiCCH264View.supported()');
      if (!supported) { t.skip('this Chrome has no WebCodecs VideoDecoder'); return; }
      await page.evaluate(`(() => {
        const v = window.v = new MultiCCH264View(document.getElementById('t'), ${JSON.stringify(wsUrl)});
        v.addEventListener('connect', () => { window.connected = true; });
        v.addEventListener('disconnect', () => { window.disconnected = true; });
        return true;
      })()`);
      assert.ok(await page.waitFor('window.connected === true', { timeoutMs: 15000 }), 'first frame decoded');
      assert.ok(await page.waitFor('window.v.stats.frames >= 15', { timeoutMs: 10000 }), 'keeps decoding');
      const view = await page.evaluate(`(() => {
        const c = document.querySelector('#t canvas');
        const px = c.getContext('2d').getImageData(${W / 2}, ${H / 4}, 1, 1).data;
        return { w: c.width, h: c.height, cssW: parseFloat(c.style.width), lit: px[0] + px[1] + px[2] > 30, closed: !!window.disconnected };
      })()`);
      assert.deepEqual({ w: view.w, h: view.h }, { w: W, h: H }, 'canvas runs at the screen logical size');
      assert.equal(view.cssW, 640, 'scaleViewport fits the container');
      assert.ok(view.lit, 'decoded pixels were drawn');
      assert.equal(view.closed, false);
      assert.ok(received.includes(REQ_KEY), 'decoder asked for a key frame on configure');

      // 输入：可操作态下点 canvas 中心、敲一个 a。CSS 640 宽 → 逻辑 320，中心 = (160,120)。
      received.length = 0;
      await page.evaluate(`(() => {
        const c = document.querySelector('#t canvas');
        window.v.viewOnly = false;
        const at = (type, buttons) => c.dispatchEvent(new PointerEvent(type, { clientX: 320, clientY: 240, buttons, bubbles: true }));
        at('pointerdown', 1); at('pointerup', 0);
        c.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        c.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
        return true;
      })()`);
      const deadline = Date.now() + 3000;
      while (received.length < 28 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
      const hex = Buffer.from(received).toString('hex');
      assert.ok(hex.includes('0501' + '00a0' + '0078'), `pointer down at (160,120): ${hex}`);
      assert.ok(hex.includes('0500' + '00a0' + '0078'), `pointer up at (160,120): ${hex}`);
      assert.ok(hex.includes('0401000000000061') && hex.includes('0400000000000061'), `key a down/up: ${hex}`);

      // 悬停：画面里是远端真实光标，鼠标不按键移动也要发（限频，首个立即、末个补发，中间丢）；
      // 触屏没有悬停，不发。
      received.length = 0;
      await page.evaluate(`(() => {
        const c = document.querySelector('#t canvas');
        const mv = (x, pointerType) => c.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: 240, buttons: 0, pointerType, bubbles: true }));
        for (let x = 100; x <= 300; x += 20) mv(x, 'mouse');
        mv(400, 'touch');
        return true;
      })()`);
      await new Promise(r => setTimeout(r, 300));
      const hover = Buffer.from(received).toString('hex');
      assert.ok(hover.includes('0500' + '0032' + '0078'), `first hover sample goes out at once (50,120): ${hover}`);
      assert.ok(hover.includes('0500' + '0096' + '0078'), `final hover position is flushed (150,120): ${hover}`);
      assert.ok(!hover.includes('0500' + '0064' + '0078'), `burst samples in between are throttled: ${hover}`);
      assert.ok(!hover.includes('0500' + '00c8' + '0078'), `touch moves without contact send nothing: ${hover}`);

      await page.evaluate('window.v.disconnect(), true');
      assert.ok(await page.waitFor('window.disconnected === true', { timeoutMs: 3000 }));
    });
  });

// ── 直连（P2P）──
//
// 同一个网页客户端，但这次对面是真 Rust 进程（multicc-remote），经测试台
// （真 server.js + 假 Agent，见 tests/helpers/remote-screen-e2e-harness.js）连进去：
// 隧道 → Node 转发层 → multicc-remote 的 H.264 桥。桥发 rtc-hello，Chrome 出 offer，
// DataChannel 打开后帧改走直连。验：transport 变 p2p、直连后仍解出新帧、画面亮。
// MULTICC_REMOTE_STUN 置空 = 只用本机候选，不连外部 STUN。
test('h264 p2p cdp: Chrome ⇄ real multicc-remote over the test harness decodes frames on the DataChannel',
  { skip: !hasFfmpeg || !findChromeBinary() ? 'needs ffmpeg and Chrome' : false, timeout: 180000 }, async t => {
    const { startHarness } = require('./helpers/remote-screen-e2e-harness');
    const saved = { stun: process.env.MULTICC_REMOTE_STUN, bin: process.env.MULTICC_REMOTE_BIN };
    // 前一个用例可能留下假进程的 MULTICC_REMOTE_BIN；测试台必须用自己编的真二进制。
    delete process.env.MULTICC_REMOTE_BIN;
    process.env.MULTICC_REMOTE_STUN = '';
    const h = await startHarness({ p2pStats: true });
    t.after(async () => {
      for (const [key, value] of [['MULTICC_REMOTE_STUN', saved.stun], ['MULTICC_REMOTE_BIN', saved.bin]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await h.close();
    });

    const issued = await (await fetch(`${h.server}/api/auth/ws-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Access-Token': h.token },
      body: JSON.stringify({ path: '/ws/remote-screen' }),
    })).json();
    assert.ok(issued.ticket, `ws ticket: ${JSON.stringify(issued)}`);
    const wsUrl = `${h.server.replace(/^http/, 'ws')}/ws/remote-screen?mode=h264&ticket=${encodeURIComponent(issued.ticket)}`;
    const screen = JSON.parse(h.messages[0].bytes.subarray(5).toString());

    await withCdpHarness({ routes: viewerRoutes() }, async page => {
      await page.navigate(page.baseUrl + '/');
      if (!(await page.evaluate('window.MultiCCH264View.supported()'))) { t.skip('this Chrome has no WebCodecs VideoDecoder'); return; }
      await page.evaluate(`(() => {
        const v = window.v = new MultiCCH264View(document.getElementById('t'), ${JSON.stringify(wsUrl)});
        window.transports = [];
        v.addEventListener('transport', () => window.transports.push(v.transport));
        v.addEventListener('disconnect', () => { window.disconnected = true; });
        v.addEventListener('connect', () => { window.connected = true; });
        return true;
      })()`);
      assert.ok(await page.waitFor('window.connected === true', { timeoutMs: 20000 }), 'first frame decoded over the relay');
      assert.ok(await page.waitFor("window.v.transport === 'p2p'", { timeoutMs: 20000 }), 'the DataChannel opened');

      // 切直连后桥会补要关键帧；帧从 DataChannel 来，照样解出新帧。
      const before = await page.evaluate('window.v.stats.frames');
      assert.ok(await page.waitFor(`window.v.stats.frames >= ${before + 5}`, { timeoutMs: 15000 }),
        `frames keep decoding over the DataChannel (was ${before})`);
      const view = await page.evaluate(`(() => {
        const c = document.querySelector('#t canvas');
        const px = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
        return { w: c.width, h: c.height, lit: px[0] + px[1] + px[2] > 30, transport: window.v.transport,
                 frames: window.v.stats.frames, dropped: window.v.stats.dropped, disconnected: !!window.disconnected };
      })()`);
      assert.equal(view.transport, 'p2p');
      assert.equal(view.disconnected, false, `the session stayed up across the switch: ${JSON.stringify(view)}`);
      assert.equal(view.w, screen.width, 'canvas runs at the fixture screen width');
      assert.ok(view.lit, 'decoded pixels were drawn after switching to the direct channel');
      assert.deepEqual(await page.evaluate('window.transports'), ['p2p']);

      // 服务端视角：桥的出口确实是 p2p。观测文件 200ms 一笔，要等切换那一笔落盘。
      let stats = {};
      for (let i = 0; i < 50; i += 1) {
        stats = await (await fetch(`${h.control}/p2p`)).json();
        if (stats.stats?.transport === 'p2p') break;
        await new Promise(r => setTimeout(r, 100));
      }
      assert.equal(stats.stats?.transport, 'p2p', `bridge stats: ${JSON.stringify(stats)}`);
      assert.ok((stats.stats?.p2pOpened ?? 0) >= 1);
      await page.evaluate('window.v.disconnect(), true');
      assert.ok(await page.waitFor('window.disconnected === true', { timeoutMs: 5000 }));
    });
  });
