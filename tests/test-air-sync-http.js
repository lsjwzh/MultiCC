'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http'), { once } = require('node:events');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const express = require('express'), WebSocket = require('ws');
const { mountAirRoutes } = require('../src/workspace/air-routes');

test('真实 HTTP/WS：1277 张卡、20 客户端、重连补齐、健康检查与消息心跳并行', async t => {
  const app = express(), server = http.createServer(app), wss = new WebSocket.WebSocketServer({ noServer: true });
  const sockets = new Set(), requests = [], board = { tasks: {} }; let reads = 0;
  for (let i = 0; i < 1277; i++) board.tasks['t' + i] = { id: 't' + i, title: '任务 ' + i,
    status: 'active', refs: [{ sessionId: 's', dirId: 'd1' }], updatedAt: i + 1 };
  const runtime = mountAirRoutes(app, {
    admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }), capacityReason: () => null },
    records: new Map([['s', { id: 's', dirId: 'd1', kind: 'chat', cli: 'codex' }]]),
    directories: new Map([['d1', { id: 'd1', name: '项目', path: '/repo' }]]), getBoard: () => board, clis: ['codex'],
    shell: { taskAccess: () => { reads++; return { readOnly: true }; } }, registerSync() {},
    send: (socket, event) => socket.send(JSON.stringify(event)),
  });
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/ws/meta') runtime.attach(ws, url);
    else ws.on('message', data => ws.send(data)); // 内部消息心跳探针，与摘要使用同一事件循环。
  }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await runtime.close(); for (const ws of wss.clients) ws.terminate(); wss.close(); for (const s of sockets) s.destroy(); await new Promise(r => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function get(path) { const start = performance.now(); const r = await fetch(base + path); const body = await r.text();
    assert.equal(r.status, 200, body); requests.push({ path, ms: performance.now() - start, bytes: Buffer.byteLength(body) }); return JSON.parse(body); }
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable(); t.after(() => loop.disable());
  assert.equal(runtime.index.backend, 'rust');
  const bootstrap = await get('/api/air/sync'); assert.equal(bootstrap.taskStats.all.total, 1277);
  assert.ok(bootstrap.tasks.length <= 30); assert.equal(reads, 1277);
  const clients = await Promise.all(Array.from({ length: 20 }, async () => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws/meta?air=1&cursor=' + bootstrap.cursor);
    ws.frames = []; ws.on('message', raw => ws.frames.push(JSON.parse(raw)));
    await once(ws, 'open'); return ws;
  }));
  const heartbeat = new WebSocket(base.replace('http:', 'ws:') + '/ws/chat-probe'); await once(heartbeat, 'open');
  const heartbeatTimes = [];
  const ping = async () => { const start = performance.now(), pong = once(heartbeat, 'message'); heartbeat.send('heartbeat'); await pong; heartbeatTimes.push(performance.now() - start); };
  const latencies = [];
  await Promise.all(Array.from({ length: 8 }, async (_, client) => {
    for (let i = 0; i < 20; i++) {
      const page = await get('/api/air/page?status=all&page=' + ((client + i) % 64 + 1)); assert.ok(page.tasks.length <= 20);
      const start = performance.now(); await get('/healthz'); latencies.push(performance.now() - start);
      if (!client) await ping();
    }
  }));
  assert.equal(reads, 1277, '分页、校准与多客户端不能重复构建摘要');
  const before = runtime.index.cursor(); clients[0].terminate(); await once(clients[0], 'close');
  board.tasks.t0.title = '推送后的任务'; runtime.invalidate(['t0']);
  const deadline = Date.now() + 3000;
  while (runtime.index.cursor() === before && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.notEqual(runtime.index.cursor(), before); assert.equal(reads, 1278);
  for (const ws of clients.slice(1)) {
    // Delivery rides the socket, so the frame lands after flush() returns; wait
    // for it instead of assuming one turn of the loop is enough (CI is slow).
    const deltaDeadline = Date.now() + 3000;
    while (!ws.frames.some(e => e.type === 'air_delta') && Date.now() < deltaDeadline) {
      await new Promise(r => setTimeout(r, 20));
    }
    assert.equal(ws.frames.find(e => e.type === 'air_delta').tasks[0].title, '推送后的任务');
  }
  const recovered = await get('/api/air/sync?cursor=' + bootstrap.cursor);
  assert.equal(recovered.events[0].tasks[0].title, '推送后的任务');
  const replay = new WebSocket(base.replace('http:', 'ws:') + '/ws/meta?air=1&cursor=' + bootstrap.cursor);
  const frame = once(replay, 'message'); await once(replay, 'open');
  assert.equal(JSON.parse((await frame)[0]).tasks[0].id, 't0');
  const legacy = await fetch(base + '/api/air'), etag = legacy.headers.get('etag'); await legacy.text();
  const same = await fetch(base + '/api/air', { headers: { 'If-None-Match': etag } }); assert.equal(same.status, 304);
  assert.equal(reads, 1278, '兼容全量读取也复用摘要和序列化正文');
  await ping();
  for (const task of Object.values(board.tasks)) task.title += ' 整批变更';
  runtime.invalidate();
  await Promise.all([runtime.flush(), (async () => {
    for (let i = 0; i < 20; i++) { const start = performance.now(); await get('/healthz'); latencies.push(performance.now() - start); await ping(); }
  })()]);
  assert.equal(reads, 2555, '整批变化只由共享生产者分批重建一次');
  // The reset is pushed, not requested: give the socket its bounded window
  // before judging what the client received.
  const resetDeadline = Date.now() + 3000;
  while (!clients[1].frames.some(e => e.type === 'air_reset') && Date.now() < resetDeadline) {
    await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(clients[1].frames.some(e => e.type === 'air_reset'), '大变更使用有界重置而不是向每个客户端推全量卡片');
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
  const pages = requests.filter(r => r.path.includes('/page'));
  t.diagnostic(JSON.stringify({ tasks: 1277, wsClients: 20, pageRequests: pages.length,
    bootstrapBytes: requests[0].bytes, pageP95Ms: percentile(pages.map(r => r.ms), .95).toFixed(1),
    healthP95Ms: percentile(latencies, .95).toFixed(1), messageHeartbeatMaxMs: Math.max(...heartbeatTimes).toFixed(1),
    eventLoopP99Ms: (loop.percentile(99) / 1e6).toFixed(1), summaryReads: reads }));
});
