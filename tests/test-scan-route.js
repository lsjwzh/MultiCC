'use strict';

// `/api/scan/history` 已经由 Rust 前门独占（native/gateway/src/app/scan.rs；
// limit 的 parseInt 语义在 multicc_core::system_info，逐字节对比在
// docs/rust-migration/differential/system-scan.js）。这里覆盖 Node 侧剩下的
// 宿主端口（src/routes/scan-history-host.js）：回环闸门、`Math.min(limit,
// maxPasses)` 封顶与 `slice(0, limit)` 的负数语义。

const assert = require('node:assert/strict');
const test = require('node:test');
const { mountScanHistoryHostRoute, HOST_PATH } = require('../src/routes/scan-history-host');

function createApp() {
  const routes = new Map();
  return {
    routes,
    post(routePath, handler) { routes.set(`POST ${routePath}`, handler); },
  };
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function mount(scanHistory, maxPasses = 2, isLocal = () => true) {
  const app = createApp();
  mountScanHistoryHostRoute(app, { scanHistory, maxPasses, isLocal });
  const handler = app.routes.get(`POST ${HOST_PATH}`);
  assert.equal(typeof handler, 'function');
  return handler;
}

function invoke(handler, body = { op: 'snapshot' }, local = true) {
  const res = createResponse();
  handler({ body, socket: {}, isLocal: local }, res);
  return res;
}

test('host snapshot applies the cap and keeps the legacy DTO shape', () => {
  const scanHistory = { seq: 9, passes: [{ id: 3 }, { id: 2 }, { id: 1 }] };
  const handler = mount(scanHistory, 2);
  const res = invoke(handler, { op: 'snapshot', limit: 20 });
  assert.deepEqual(res.body, { seq: 9, kept: 3, passes: [{ id: 3 }, { id: 2 }] });
  assert.equal(invoke(handler, { op: 'snapshot', limit: 1 }).body.passes.length, 1);
  assert.equal(invoke(handler, { op: 'snapshot', limit: 999 }).body.passes.length, 2);
});

test('host snapshot keeps the negative-slice semantics in JS', () => {
  const scanHistory = { seq: 4, passes: [{ id: 5 }, { id: 4 }, { id: 3 }, { id: 2 }, { id: 1 }] };
  const handler = mount(scanHistory, 100);
  // Rust 把 parseInt 的负数结果原样传来：slice(0, -2) 去掉末尾两条。
  const res = invoke(handler, { op: 'snapshot', limit: -2 });
  assert.deepEqual(res.body.passes, [{ id: 5 }, { id: 4 }, { id: 3 }]);
  // 非数值是前门的防御缺口，退回默认 20 而不是抛错。
  assert.equal(invoke(handler, { op: 'snapshot', limit: 'oops' }).body.passes.length, 5);
  assert.equal(invoke(handler, { op: 'snapshot' }).body.passes.length, 5);
});

test('host port refuses anything but loopback and unknown ops', () => {
  const handler = mount({ seq: 0, passes: [] }, 20, req => req.isLocal === true);
  const remote = invoke(handler, { op: 'snapshot', limit: 5 }, false);
  assert.equal(remote.statusCode, 404);
  assert.deepEqual(remote.body, { error: 'not found' });
  const unknown = invoke(handler, { op: 'nope' });
  assert.equal(unknown.statusCode, 400);
  assert.deepEqual(unknown.body, { error: 'unknown host operation' });
});

test('host mount registers only the internal POST endpoint', () => {
  const app = createApp();
  mountScanHistoryHostRoute(app, { scanHistory: { seq: 0, passes: [] }, maxPasses: 20 });
  assert.deepEqual([...app.routes.keys()], [`POST ${HOST_PATH}`]);
});

test('host mount validates its dependencies like the retired route did', () => {
  assert.throws(() => mountScanHistoryHostRoute(createApp(), {}), /scanHistory\.passes/);
  assert.throws(
    () => mountScanHistoryHostRoute(createApp(), { scanHistory: { seq: 0, passes: [] }, maxPasses: 0 }),
    /maxPasses/,
  );
  assert.throws(() => mountScanHistoryHostRoute(null, { scanHistory: { seq: 0, passes: [] }, maxPasses: 1 }), /Express/);
});
