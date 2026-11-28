'use strict';
const { createAirSyncRuntime } = require('../../src/native/binding').airSyncRuntime;
const { createAirReadIndex } = require('./legacy-air-read-index');
const { WebSocketServer } = require('ws');

// 旧 UI 场景仍用完整 fixture 描述数据。通过真实读索引/同步协议提供给新版首页，
// 不让产品为测试桩保留正常路径上的全量轮询。
function installAirSyncFixture(routes, server) {
  if (!routes['/api/air'] || !routes['/air-sync.js'] || routes['/api/air/sync']) return null;
  const runtime = createAirSyncRuntime({ index: createAirReadIndex(), reconcileMs: 100, logger: { warn() {} },
    build: async () => {
      const route = routes['/api/air'];
      const spec = typeof route === 'function' ? await route({ req: { headers: {} }, url: new URL('http://fixture/api/air') }) : route;
      return JSON.parse(Buffer.isBuffer(spec.body) ? spec.body.toString() : spec.body);
    }, send: (socket, frame) => socket.send(JSON.stringify(frame)),
  });
  // 生产宿主在这些写操作结束后失效摘要元数据；fixture 必须保持相同顺序，
  // 否则写后读取屏障无法知道旧索引已过期。
  for (const path of ['/api/air/pins', '/api/air/pins/toggle', '/api/air/todos',
    '/api/air/todos/toggle', '/api/air/todos/ignore']) {
    const key = `POST ${path}`, route = routes[key] ?? routes[path];
    if (route == null) continue;
    routes[key] = async context => {
      try { return typeof route === 'function' ? await route(context) : route; }
      finally { runtime.invalidate([]); }
    };
  }
  // 公开注册已迁 Rust 前门；fixture 直挂处理器原体（q 的形状与 req.query 一致）。
  const wire = run => async ({ url }) => ({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await run(Object.fromEntries(url.searchParams))),
  });
  routes['/api/air/sync'] = wire(query => runtime.syncHttp(query));
  routes['/api/air/page'] = wire(query => runtime.pageHttp(query));
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname !== '/ws/meta' || url.searchParams.get('air') !== '1') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => runtime.attach(ws, url));
  });
  return { close() { runtime.close(); for (const ws of wss.clients) ws.terminate(); wss.close(); } };
}
module.exports = { installAirSyncFixture };
