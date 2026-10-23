'use strict';

// 真 server.js 的「🖥 屏幕」H.264 中继，经模拟隧道（外网请求：要令牌、要换票），对上
// 回放 Agent 真编码器字节流的假 Agent（tests/helpers/remote-screen-e2e-harness.js）。
// 钉住服务端这一跳：鉴权拦得住、帧一字不差逐条到达、输入逐字节回到 Agent、Agent 断流
// 时 WS 跟着断（App 才会回退）。App 侧同一台测试台见 app/test/remote_screen_e2e_test.dart。
// 只有 macOS 上服务端才有 h264.sock，其他平台跳过。

const test = require('node:test');
const assert = require('node:assert/strict');
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

test('remote-screen e2e harness: the real server relays the agent stream behind tunnel auth', { skip: !darwin && 'server exposes h264.sock on macOS only', timeout: 90000 }, async t => {
  const h = await startHarness({ fixtureDir: FIXTURE_DIR });
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
});
