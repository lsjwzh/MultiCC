'use strict';

// 真 server.js 的「🖥 屏幕」H.264 中继，经模拟隧道（外网请求：要令牌、要换票），对上
// 回放 Agent 真编码器字节流的假 Agent（tests/helpers/remote-screen-e2e-harness.js）。
// 钉住服务端这一跳：鉴权拦得住、帧一字不差逐条到达、输入逐字节回到 Agent、Agent 断流
// 时 WS 跟着断（App 才会回退）。App 侧同一台测试台见 app/test/remote_screen_e2e_test.dart。
// 只有 macOS 上服务端才有 h264.sock，其他平台跳过。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const WebSocket = require('ws');
const { startHarness } = require('./helpers/remote-screen-e2e-harness');

const wire = require('./fixtures/remote-screen-wire.json');
const darwin = process.platform === 'darwin';
const FIXTURE_DIR = process.env.REMOTE_SCREEN_E2E_FIXTURE_DIR || undefined;

async function ticket(h, token = h.token) {
  const res = await fetch(`${h.server}/api/auth/ws-ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Access-Token': token } : {}) },
    body: JSON.stringify({ path: '/ws/remote-screen' }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function open(url) {
  const ws = new WebSocket(url);
  const binary = [];
  const text = [];
  const closed = new Promise(resolve => {
    ws.on('close', (code, reason) => resolve({ code, reason: String(reason) }));
    ws.on('error', () => {});
  });
  ws.on('message', (data, isBinary) => (isBinary ? binary : text).push(isBinary ? Buffer.from(data) : String(data)));
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('close', () => reject(new Error('closed before open'))); });
  opened.catch(() => {});
  return { ws, binary, text, closed, opened };
}

async function until(fn, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 30));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// 文本帧都是信令 JSON；解析失败返回 null（不认识的帧不该让用例直接炸）。
function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function relayCase(t, backend) {
  const h = await startHarness({ fixtureDir: FIXTURE_DIR, backend });
  t.after(() => h.close());

  // 1. 外网请求：没令牌的能力查询与换票都被拒，带令牌才放行，且如实报告 h264.sock。
  const anon = await fetch(`${h.server}/api/remote-screen/capabilities`);
  assert.ok([401, 403].includes(anon.status), `capabilities without a token through the tunnel: ${anon.status}`);
  assert.ok([401, 403].includes((await ticket(h, '')).status), 'ticket without a token is refused');
  const caps = await (await fetch(`${h.server}/api/remote-screen/capabilities`, { headers: { 'X-Access-Token': h.token } })).json();
  assert.equal(caps.streams?.h264, true, `capabilities: ${JSON.stringify(caps)}`);

  // 2. 不带票的 WS（经隧道就是外网连接）：服务端接下升级后立刻以 4003 关闭，一帧都不给。
  const wsBase = h.server.replace(/^http/, 'ws') + '/ws/remote-screen?mode=h264';
  const bare = open(wsBase);
  const denied = await Promise.race([bare.closed, new Promise(r => setTimeout(() => r(null), 5000))]);
  assert.equal(denied?.code, 4003, `a WS without a ticket must be closed as unauthorized: ${JSON.stringify(denied)}`);
  assert.equal(bare.binary.length, 0, 'no screen bytes before authentication');

  // 3. 换票后：帧按 Agent 写出的原样字节逐条到达，一条 WS 消息一帧。
  const issued = await ticket(h);
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.equal(issued.body.path, '/ws/remote-screen');
  const live = open(`${wsBase}&ticket=${encodeURIComponent(issued.body.ticket)}`);
  await live.opened;
  t.after(() => live.ws.terminate());
  await until(() => live.binary.length >= h.messages.length, 8000, 'the whole fixture stream');
  assert.deepEqual(
    live.binary.slice(0, h.messages.length).map(b => b.toString('hex')),
    h.messages.map(m => m.bytes.toString('hex')),
    'config + key + deltas arrive byte-identical and in order',
  );
  for (const msg of live.text) assert.doesNotThrow(() => JSON.parse(msg), 'text frames are JSON signalling only');

  // 4. 输入：线协议金样里的每条客户端消息，经服务端原样到达 Agent。
  await until(() => h.agent.snapshot().connections.length === 1, 3000, 'agent connection');
  h.agent.reset();
  for (const c of wire.clientToAgent) live.ws.send(Buffer.from(c.hex, 'hex'));
  const want = wire.clientToAgent.map(c => c.hex).join('');
  // 桥自己也可能补要关键帧（'K' = 4b）；只认测试发的那串字节按顺序出现。
  await until(() => {
    const raw = h.agent.snapshot().connections.map(c => c.raw).join('');
    return raw.replace(/^(4b)+/, '').startsWith(want) || raw.includes(want);
  }, 3000, 'golden input at the agent');

  // 5. Agent 断流（崩溃 / 采集停止）：服务端必须把 WS 也断掉，App 才会走回退。
  const before = live.binary.length;
  assert.equal(h.agent.drop(), 1);
  const closed = await Promise.race([live.closed, new Promise(r => setTimeout(() => r(null), 5000))]);
  assert.ok(closed, `the WS closes when the agent stream drops (server log:\n${h.serverLog().slice(-1500)})`);
  assert.ok(live.binary.length >= before);
}

test('remote-screen e2e harness: the real server relays the agent stream behind tunnel auth', { skip: !darwin && 'server exposes h264.sock on macOS only', timeout: 90000 }, t => relayCase(t, 'rust'));
test('remote-screen e2e harness: the Node fallback backend relays the agent stream byte-identically', { skip: !darwin && 'server exposes h264.sock on macOS only', timeout: 90000 }, t => relayCase(t, 'node'));

// ── 直连（P2P）──
//
// werift 当浏览器端，走「隧道 → 真 server.js → Node 转发层 → Rust multicc-remote」
// 整条真链路。服务端在 WS 上发 rtc-hello，客户端回 offer，DataChannel 打开后桥把帧
// 改从直连发（rtc-active{on:true}），输入也走直连；断开后服务端发 rtc-active{on:false}，
// 帧回到 WS 中继。MULTICC_REMOTE_STUN 置空 = 只用本机/局域网候选，不连外部 STUN。

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parseFrames(hex) {
  // [type u8][len u32 BE][payload]，与 h264.sock 同一套分帧。
  const bytes = Buffer.from(hex, 'hex');
  const out = [];
  for (let off = 0; off + 5 <= bytes.length;) {
    const len = bytes.readUInt32BE(off + 1);
    if (off + 5 + len > bytes.length) break;
    out.push({ type: bytes[off], hex: bytes.subarray(off, off + 5 + len).toString('hex') });
    off += 5 + len;
  }
  return out;
}

async function p2pCase(t, backend) {
    let RTCPeerConnection;
    try { ({ RTCPeerConnection } = require('werift')); } catch { t.skip('werift not installed'); return; }

    // 空串 = 不用 STUN（本机回环直连）；Rust 进程继承 server.js 的环境变量。
    const savedStun = process.env.MULTICC_REMOTE_STUN;
    process.env.MULTICC_REMOTE_STUN = '';
    const h = await startHarness({ fixtureDir: FIXTURE_DIR, p2pStats: true, backend });
    t.after(async () => {
      if (savedStun === undefined) delete process.env.MULTICC_REMOTE_STUN;
      else process.env.MULTICC_REMOTE_STUN = savedStun;
      await h.close();
    });

    const issued = await ticket(h);
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const wsBase = h.server.replace(/^http/, 'ws') + '/ws/remote-screen?mode=h264';
    const live = open(`${wsBase}&ticket=${encodeURIComponent(issued.body.ticket)}`);
    await live.opened;
    t.after(() => live.ws.terminate());

    // 1. 桥在 WS 上发 rtc-hello（带着 iceServers = []）。
    await until(() => live.text.some(m => safeParse(m)?.t === 'rtc-hello'), 10000, 'rtc-hello');
    const hello = live.text.map(safeParse).find(m => m?.t === 'rtc-hello');
    assert.deepEqual(hello.iceServers, [], 'empty STUN env → no ice servers');

    // 2. 真 offer → answer → DataChannel 打开 → rtc-active{on:true}。
    const pc = new RTCPeerConnection({ iceServers: hello.iceServers });
    t.after(() => { try { pc.close(); } catch {} });
    const dc = pc.createDataChannel('screen', { ordered: true });
    dc.binaryType = 'arraybuffer';
    const dcFrames = [];
    let dcBuf = Buffer.alloc(0);
    dc.onMessage.subscribe(data => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      dcBuf = Buffer.concat([dcBuf, chunk]);
      for (;;) {
        if (dcBuf.length < 5) return;
        const len = dcBuf.readUInt32BE(1);
        if (dcBuf.length < 5 + len) return;
        dcFrames.push({ type: dcBuf[0], hex: dcBuf.subarray(0, 5 + len).toString('hex') });
        dcBuf = dcBuf.subarray(5 + len);
      }
    });
    let dcOpen = false;
    dc.stateChanged.subscribe(state => { if (state === 'open') dcOpen = true; });
    pc.onIceCandidate.subscribe(candidate => {
      if (!candidate) return;
      let init;
      try { init = typeof candidate.toJSON === 'function' ? candidate.toJSON() : candidate; } catch { init = candidate; }
      live.ws.send(JSON.stringify({ t: 'rtc-ice', candidate: init }));
    });

    // 服务端的 answer / 候选按顺序套用（setRemoteDescription 是异步的）。
    let chain = Promise.resolve();
    live.ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const msg = safeParse(String(raw));
      if (msg?.t === 'rtc-answer') chain = chain.then(() => pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })).catch(() => {});
      else if (msg?.t === 'rtc-ice' && msg.candidate) chain = chain.then(() => pc.addIceCandidate(msg.candidate)).catch(() => {});
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    live.ws.send(JSON.stringify({ t: 'rtc-offer', sdp: pc.localDescription.sdp }));

    const activeOn = () => live.text.map(safeParse).filter(m => m?.t === 'rtc-active' && m.on === true).length;
    await until(() => activeOn() >= 1, 15000, 'rtc-active{on:true}');
    await until(() => dcOpen, 10000, 'DataChannel open');

    // 3. 直连上的帧与假 Agent 写出的帧逐字节一致，且从关键帧起（切换时桥会补要 K）。
    await until(() => dcFrames.length >= 5, 10000, 'frames over the DataChannel');
    // config（type 1）永远直通，可能夹在中间；真正的画面流必须从关键帧重新起步。
    assert.equal(dcFrames.find(f => f.type !== 1)?.type, 2, 'the stream resumes at a key frame');
    const agent = h.agent.snapshot();
    assert.equal(agent.connections.length, 1, 'one h264 connection');
    const sent = new Set(agent.connections[0].sent);
    for (const frame of dcFrames) {
      assert.ok(sent.has(frame.hex), `DataChannel frame is byte-identical to what the agent wrote: ${frame.hex.slice(0, 24)}…`);
    }

    // 4. 悬停 PointerEvent（mask 0）经 DataChannel 到达 Agent；中继 WS 上没有客户端二进制帧。
    const stat = async () => (await fetch(`${h.control}/p2p`)).json();
    // 观测文件 200ms 一笔 —— 直连刚开完就立刻读会读到切换前那一笔，必须等它落盘。
    await until(async () => (await stat()).stats?.transport === 'p2p', 5000, 'bridge transport = p2p');
    const before = await stat();
    assert.equal(before.stats?.transport, 'p2p', `bridge transport: ${JSON.stringify(before)}`);
    assert.ok(before.stats?.p2pOpened >= 1, `p2pOpened: ${JSON.stringify(before)}`);
    const px = 160, py = 120;
    const hover = Buffer.from([5, 0, px >> 8, px & 0xff, py >> 8, py & 0xff]);
    dc.send(hover);
    const want = hover.toString('hex');
    await until(() => h.agent.snapshot().connections.some(c => c.raw.includes(want)), 5000, 'hover PointerEvent at the agent');
    await sleep(400); // 观测文件 200ms 一笔
    const after = await stat();
    assert.equal(after.stats?.transport, 'p2p');
    assert.equal(after.wsBinary, before.wsBinary, 'input went over the DataChannel, not the relay WS');

    // 5. 断开 DataChannel：服务端发 rtc-active{on:false}，帧回到 WS。
    const relayedBefore = live.binary.length;
    dc.close();
    await until(() => activeOn() >= 1 && live.text.map(safeParse).filter(m => m?.t === 'rtc-active' && m.on === false).length >= 1,
      10000, 'rtc-active{on:false}');
    await until(() => live.binary.length > relayedBefore + 5, 10000, 'frames back on the relay WS');
    const relayHex = Buffer.concat(live.binary).toString('hex');
    const relayFrames = parseFrames(relayHex);
    assert.ok(relayFrames.length > 0 && relayFrames.every(f => sent.has(f.hex)), 'relayed frames are the same agent bytes');
    await until(async () => (await stat()).stats?.transport === 'relay', 5000, 'bridge transport back to relay');
}

test('remote-screen e2e harness: a werift peer moves frames and input onto the DataChannel and back to the relay when it closes',
  { skip: !darwin && 'server exposes h264.sock on macOS only', timeout: 120000 }, t => p2pCase(t, 'rust'));
test('remote-screen e2e harness: the Node fallback keeps the same P2P DataChannel contract',
  { skip: !darwin && 'server exposes h264.sock on macOS only', timeout: 120000 }, t => p2pCase(t, 'node'));

// ── Node 后端不启动 Rust 远控进程 ──

// ps 全表里的子孙进程（只看本测试起的 server.js 那一支，别把本机常驻服务算进来）。
function processTable() {
  const out = spawnSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).stdout || '';
  return out.split('\n').map(line => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return m && { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] };
  }).filter(Boolean);
}

function descendants(rootPid) {
  const table = processTable();
  const found = [];
  const queue = [rootPid];
  while (queue.length) {
    const parent = queue.shift();
    for (const proc of table) {
      if (proc.ppid !== parent) continue;
      found.push(proc);
      queue.push(proc.pid);
    }
  }
  return found;
}

test('remote-screen e2e harness: node backend never spawns the multicc-remote process',
  { skip: !darwin && 'server exposes h264.sock on macOS only', timeout: 90000 }, async t => {
    const h = await startHarness({ fixtureDir: FIXTURE_DIR, backend: 'node' });
    t.after(() => h.close());
    assert.equal(h.backend, 'node');
    // 访问远控路由，确保 Node 实现真的被加载和调用过（而不是根本没走到）。
    const caps = await (await fetch(`${h.direct}/api/remote-screen/capabilities`, {
      headers: { 'X-Access-Token': h.token },
    })).json();
    assert.equal(caps.streams?.h264, true, JSON.stringify(caps));
    assert.ok(processTable().some(proc => proc.pid === h.childPid), 'ps 表里应能看到测试 server');
    const remote = descendants(h.childPid).filter(proc => /multicc-remote/.test(proc.command));
    assert.deepEqual(remote, [], `node 后端不应有远控子进程：${JSON.stringify(remote)}`);
  });

// ── HTTP 面（真 binary，经隧道 + 令牌）──
//
// 这条用同一台真服务补上 HTTP 语义：capabilities 的 streams、取帧/裁剪头、
// 输入白名单、唤屏同意值三态、以及「截图 → 标注 → Agent 真的收到 click」整条链。
test('remote-screen e2e harness: the real binary serves frames, input, wake consent and annotation', { skip: !darwin && 'server exposes h264.sock on macOS only', timeout: 120000 }, async t => {
  const h = await startHarness({ fixtureDir: FIXTURE_DIR });
  t.after(() => h.close());
  const auth = { 'X-Access-Token': h.token };
  const api = `${h.server}/api/remote-screen`;

  // 1. capabilities：形状里必须有 streams，且这台 Mac 上 h264 有 socket。
  const caps = await (await fetch(`${api}/capabilities`, { headers: auth })).json();
  assert.equal(caps.streams?.h264, true, `capabilities: ${JSON.stringify(caps)}`);
  assert.equal(typeof caps.streams?.rfb, 'boolean');

  // 2. GET 整屏帧：JPEG + 尺寸头 + no-store。
  const plain = await fetch(`${api}/frame`, { headers: auth });
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('content-type'), 'image/jpeg');
  assert.ok(Number(plain.headers.get('x-screen-width')) > 0, String(plain.headers.get('x-screen-width')));
  assert.ok(Number(plain.headers.get('x-screen-height')) > 0);
  assert.equal(plain.headers.get('cache-control'), 'no-store');
  await plain.arrayBuffer();

  // 3. 裁剪：GET 与 HEAD 都带回 x-region-*（服务端按物理像素取整后再换回逻辑点，
  //    所以允许 ±10 的舍入差；真机 Finder bounds 与假 Agent 的 1024×768 不必相等）。
  const regionQuery = 'x=100&y=80&width=400&height=240';
  const cropped = await fetch(`${api}/frame?${regionQuery}`, { headers: auth });
  assert.equal(cropped.status, 200);
  const rx = Number(cropped.headers.get('x-region-x'));
  const rw = Number(cropped.headers.get('x-region-width'));
  assert.ok(Math.abs(rx - 100) <= 10, `x-region-x=${rx}`);
  assert.ok(Math.abs(rw - 400) <= 10, `x-region-width=${rw}`);
  await cropped.arrayBuffer();
  const head = await fetch(`${api}/frame?${regionQuery}`, { method: 'HEAD', headers: auth });
  assert.equal(head.status, 200);
  assert.ok(Math.abs(Number(head.headers.get('x-region-width')) - 400) <= 10);

  // 4. 输入白名单：unlock 之类只能走唤屏，普通 input 一律 400（到不了 Agent）。
  const rejected = await fetch(`${api}/input`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'unlock', x: 1, y: 2 }),
  });
  assert.equal(rejected.status, 400);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.ok, false);
  assert.match(String(rejectedBody.error), /op not allowed/);
  assert.equal(h.agent.snapshot().inputs.filter(x => x.op === 'unlock').length, 0, '白名单在转发前就拦住');

  // 5. 唤屏 GET：三态同意值 + 所有分支 no-store。
  const wake = async () => fetch(`${api}/wake`, { headers: auth });
  const withConsent = async value => {
    fs.writeFileSync(h.powerConsentFile, value);
    return wake();
  };
  const on = await withConsent('1');
  assert.equal(on.status, 200);
  assert.equal(on.headers.get('cache-control'), 'no-store');
  const onBody = await on.json();
  assert.equal(onBody.autoUnlockEnabled, true);
  assert.equal(onBody.canWake, true);

  const off = await withConsent('0');
  assert.equal(off.status, 200, '同意关闭是合法状态，不是错误');
  assert.equal(off.headers.get('cache-control'), 'no-store');
  const offBody = await off.json();
  assert.equal(offBody.autoUnlockEnabled, false);
  assert.equal(offBody.reason, 'auto-unlock-disabled');

  const failed = await withConsent('error');
  assert.equal(failed.status, 503, '读不到电源设置 = 状态不可用，不能谎报「没开启」');
  assert.equal(failed.headers.get('cache-control'), 'no-store');
  assert.equal((await failed.json()).error, 'agent-unavailable');
  fs.writeFileSync(h.powerConsentFile, '1');

  // 6. 截图 → annotation-live 标注 → 假 Agent 收到一次落在标注点的 click。
  h.agent.reset();
  const shotRes = await fetch(`${api}/snapshot`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ x: 100, y: 80, width: 400, height: 240 }),
  });
  assert.equal(shotRes.status, 200, h.serverLog().slice(-1500));
  const shot = await shotRes.json();
  assert.equal(shot.ok, true);
  assert.match(String(shot.path), /shot-\d+\.png$/);
  assert.ok(shot.url);
  // 标注器送的是**图片像素尺寸**（服务端按它把标注点换算回逻辑点），不是 shot.width
  // （那是整屏逻辑宽度）。这里直接读 PNG 的 IHDR 和选区 sidecar，算出期望落点。
  const png = fs.readFileSync(shot.path);
  const imageWidth = png.readUInt32BE(16);
  const imageHeight = png.readUInt32BE(20);
  const region = JSON.parse(fs.readFileSync(`${shot.path}.json`, 'utf8'));
  const point = { x: 200, y: 120 };

  const annotated = await fetch(`${h.server}/api/annotation-live`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ src: shot.path, width: imageWidth, height: imageHeight, kind: 'point', a: point }),
  });
  assert.equal(annotated.status, 200, h.serverLog().slice(-1500));
  const annotateBody = await annotated.json();
  assert.equal(annotateBody.ok, true);
  assert.equal(annotateBody.relayed, 1);
  assert.equal(annotateBody.results?.[0]?.ok, true, JSON.stringify(annotateBody));
  assert.equal(annotateBody.results?.[0]?.refresh, true);

  const clicks = h.agent.snapshot().inputs.filter(x => x.op === 'click');
  assert.equal(clicks.length, 1, `agent inputs: ${JSON.stringify(h.agent.snapshot().inputs)}`);
  const expectedX = region.x + (point.x / imageWidth) * region.width;
  const expectedY = region.y + (point.y / imageHeight) * region.height;
  assert.ok(Math.abs(clicks[0].x - expectedX) <= 3, `click x=${clicks[0].x} want≈${expectedX}`);
  assert.ok(Math.abs(clicks[0].y - expectedY) <= 3, `click y=${clicks[0].y} want≈${expectedY}`);
  // 落点必须还在选区内：换算错（比如把整屏宽度当图片宽度）会飞出去。
  assert.ok(clicks[0].x >= region.x && clicks[0].x <= region.x + region.width, `click x=${clicks[0].x} 不在选区`);
  assert.ok(clicks[0].y >= region.y && clicks[0].y <= region.y + region.height, `click y=${clicks[0].y} 不在选区`);
});
