'use strict';

// 「🖥 屏幕」H.264 / RFB WS 转发：Node 只搬字节，不解析远控协议。
//
// 迁移前这个文件钉的是 JS 桥的分帧、丢帧与关键帧请求逻辑；那些行为已经随业务
// 进 Rust（native/remote/）并由 Rust 测试覆盖。这里改钉 Node 这一跳最容易出错的
// 地方：线协议金样逐字节透明、上游 URL 不夹带鉴权票据、上游未就绪时的排队上限。

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { WebSocketServer, WebSocket } = require('ws');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-screen-h264-'));
process.env.MULTICC_DATA_DIR = tmp;
const rs = require('../src/remote-screen-rust');
const { installFakeRemote, waitFor, fakeClientWs, fakeUpstreamWs } = require('./helpers/remote-screen-node-harness');
const wire = require('./fixtures/remote-screen-wire.json');

const hex = value => Buffer.from(value, 'hex');

function withFake(t, env) {
  const fake = installFakeRemote(env);
  t.after(async () => { await rs._resetForTests(); fake.cleanup(); });
  return fake;
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('the wire golden passes through byte-for-byte in both directions', async t => {
  withFake(t);
  const previous = rs._deps.connectUpstream;
  t.after(() => { rs._deps.connectUpstream = previous; });
  await rs.capabilities();

  const upstream = fakeUpstreamWs();
  let created = false;
  rs._deps.connectUpstream = () => { created = true; return upstream; };
  const client = fakeClientWs();
  rs.attachH264(client, { url: '/ws/remote-screen?mode=h264' });
  await waitFor(() => created, 2000, 'upstream connect');
  upstream.emit('open');

  // 客户端 → 上游：App 的输入与码率控制原样过，不重组、不丢弃。
  for (const item of [...wire.clientToAgent, ...wire.clientRateControlToAgent]) {
    client.emit('message', hex(item.hex), true);
    assert.equal(upstream.sent.at(-1).data.toString('hex'), item.hex, item.name);
    assert.equal(upstream.sent.at(-1).binary, true, item.name);
  }

  // 上游 → 客户端：Agent 的 config / 关键帧 / 普通帧 / pong 一条一条到达。
  for (const frame of wire.agentToClient) {
    upstream.emit('message', hex(frame.hex), true);
    assert.equal(client.sent.at(-1).data.toString('hex'), frame.hex, frame.name);
    assert.equal(client.sent.at(-1).binary, true, frame.name);
  }

  // 文本信令保持文本：P2P 握手就走这条通道，不能变成二进制帧。
  upstream.emit('message', JSON.stringify({ t: 'rtc-hello', iceServers: [] }), false);
  assert.equal(client.sent.at(-1).binary, false);
  assert.equal(JSON.parse(client.sent.at(-1).data).t, 'rtc-hello');
  client.emit('close', 1000, 'done');
});

test('H.264 attaches ask for mode=h264; RFB keeps its own query', async t => {
  withFake(t);
  const previous = rs._deps.connectUpstream;
  t.after(() => { rs._deps.connectUpstream = previous; });
  await rs.capabilities();

  const urls = [];
  rs._deps.connectUpstream = ({ url }) => { urls.push(url); return fakeUpstreamWs(); };
  const h264 = fakeClientWs();
  rs.attachH264(h264, { url: '/ws/remote-screen?ticket=T&token=X&lang=zh' });
  const rfb = fakeClientWs();
  rs.attachRfb(rfb, { url: '/ws/remote-screen?mode=rfb&ticket=T' });
  await waitFor(() => urls.length === 2, 2000, 'both upstreams');

  assert.match(urls[0], /\/ws\/remote-screen\?(?=.*mode=h264)(?=.*lang=zh)[^?]*$/);
  assert.match(urls[1], /\/ws\/remote-screen\?mode=rfb$/);
  assert.ok(urls.every(url => !/ticket|token/.test(url)), `auth tickets stay on the Node hop: ${urls}`);
  h264.emit('close', 1000, '');
  rfb.emit('close', 1000, '');
});

test('a real WS client queues while the upstream handshake is delayed and overflows with 1013', async t => {
  withFake(t, { FAKE_REMOTE_WS_DELAY_MS: '400' });
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => rs.attachH264(ws, req));
  });
  const port = await listen(server);
  t.after(() => new Promise(resolve => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));

  const client = new WebSocket(`ws://127.0.0.1:${port}/ws/remote-screen?mode=h264`);
  client.on('error', () => {});
  const closed = new Promise(resolve => client.on('close', (code, reason) => resolve({ code, reason: String(reason) })));
  await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
  client.send(Buffer.alloc(1024 * 1024 + 1));
  assert.deepEqual(await closed, { code: 1013, reason: 'queue-overflow' });
});
