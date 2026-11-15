'use strict';

// 宿主端口（host port）：POST /api/__host/host-ops。
//
// 宿主与系统操作 40 条公开路由已由 Rust 前门独占
// （native/gateway/src/app/host_ops_routes.rs，规则在
// native/core/src/host_ops_routes.rs，集成测试在
// native/gateway/tests/host_ops_routes.rs，差分在
// docs/rust-migration/differential/host-ops-routes.js）。路径匹配、参数解码、
// Express 自动 OPTIONS 并集、会话准入守卫都在 Rust。本文件只断言宿主端口自己：
// op 表与 40 条一一对应、十个退休模块真的注册在捕获应用上、回环闸门、未知 op、
// 错误信封，以及“本机判定是前门给的事实”（不是宿主端口自己的回环连接）。
//
// 完全 hermetic：不起端口、不碰 data 根、不执行任何重启 / 更新 / 系统调用 ——
// 重启与更新路由用只记录调用的替身，处理器只被调用一次。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHostOpsHost, HOST_PATH, OPS } = require('../src/routes/host-ops-host');

function fakeExpress() {
  const express = () => ({});
  express.json = () => () => {};
  return express;
}

function recordingRoute(routes) {
  return {
    mountRoutes(app) {
      for (const [method, route] of routes) app[method](route, (req, res) => {
        calls.push([`${method.toUpperCase()} ${route}`, req.body]);
        res.json({ ok: true });
      });
    },
  };
}
const calls = [];

function build(overrides = {}) {
  const writes = [];
  const host = createHostOpsHost({
    express: fakeExpress(),
    serverRestart: recordingRoute([['post', '/api/restart'], ['post', '/api/desktop-shutdown']]),
    update: recordingRoute([['get', '/api/update/status'], ['post', '/api/update']]),
    hostWrite: {
      readEnvFile: () => ({}),
      writeEnvFile: updates => writes.push(updates),
      push: { applyEnvUpdates() {}, cfg: {} },
      tunnel: { getStatus() {}, applyConfig() {}, restartNow() {}, setFunnel() {}, funnelStatus() {} },
      getAccessToken: () => 'secret-token-canary',
      setAccessToken() {},
      getAllowRemote: () => false,
      // 真实 isLocalRequest 在宿主端口里永远误判；这里故意给一个永远拒绝的，
      // 证明处理器改读前门给的 `local` 事实。
      isLocalRequest: () => false,
      macosPower: { isAvailable: () => false, setLidSleepPrevention() {} }, batteryGuard: {},
      taskAttributionMode: { get: () => 'suggest', set() {} },
      log() {}, reportFailure() {},
    },
    skillSync: { getStatus: () => ({ ok: true }), runNow: () => ({ ok: true }) },
    envDoctor: { start() {}, get() {}, cancel() {} },
    doctor: { start() {}, list() {}, get() {}, cancel() {} },
    ...overrides,
  });
  return { host, writes };
}

function mount(host, isLocal = () => true) {
  let handler = null;
  host.mountRoute({ post: (route, fn) => { assert.equal(route, HOST_PATH); handler = fn; } }, { isLocal });
  return handler;
}

async function call(handler, body, req = {}) {
  let status = 200;
  let payload;
  await new Promise((resolve) => {
    const res = {
      status(code) { status = code; return res; },
      json(value) { payload = value; resolve(); return res; },
    };
    handler({ body, ...req }, res);
  });
  return { status, payload };
}

test('the op table names exactly the 40 retired routes and every one is registered', () => {
  assert.equal(Object.keys(OPS).length, 40);
  const { host } = build();
  assert.equal(new Set(Object.values(OPS).map(spec => `${spec.method} ${spec.path}`)).size, 40);
  for (const [op, spec] of Object.entries(OPS)) {
    assert.equal(typeof host.handlers.get(`${spec.method} ${spec.path}`), 'function', `${op} has no handler`);
  }
  assert.equal(typeof host.mountRoute, 'function');
});

test('non-loopback callers get the same 404 as an unknown path', async () => {
  const { host } = build();
  const handler = mount(host, () => false);
  const result = await call(handler, { op: 'restart' });
  assert.equal(result.status, 404);
  assert.deepEqual(result.payload, { error: 'not found' });
});

test('an unknown op is a 400 and never reaches a handler', async () => {
  const { host } = build();
  const handler = mount(host);
  const result = await call(handler, { op: 'format-disk' });
  assert.equal(result.status, 400);
  assert.deepEqual(result.payload, { error: 'unknown host operation' });
  assert.equal((await call(handler, null)).status, 400);
});

test('restart and update run the injected launcher exactly once and nothing else', async () => {
  calls.length = 0;
  const { host } = build();
  const handler = mount(host);
  const restart = await call(handler, { op: 'restart', body: {}, local: true });
  assert.equal(restart.status, 200);
  assert.equal(restart.payload.ok, true);
  assert.deepEqual(calls.map(c => c[0]), ['POST /api/restart']);
  await call(handler, { op: 'update', body: {}, local: true });
  assert.deepEqual(calls.map(c => c[0]), ['POST /api/restart', 'POST /api/update']);
});

test('host-write trusts the front door local fact, not the host port socket', async () => {
  const { host, writes } = build();
  const handler = mount(host);
  // 任务归属路由原样保留退休时的缺陷：它调 requireLocal(deps, req) 少传了 res，
  // 远端请求在写 403 时抛 TypeError -> 500（safeErrorHandler 信封）。差分逐字节
  // 对齐这一点；这里只证明远端从不写 .env。
  const origError = console.error;
  console.error = () => {};
  let remote;
  try { remote = await call(handler, { op: 'settings-task-attribution', body: { mode: 'auto' }, local: false }); } finally { console.error = origError; }
  assert.equal(remote.payload.value.threw, true);
  assert.equal(remote.payload.value.status, 500);
  assert.equal(writes.length, 0);
  const denied = await call(handler, { op: 'settings-access-token', body: { token: 'x-new-token' }, local: false });
  assert.equal(denied.payload.value.status, 403);
  assert.equal(writes.length, 0);
  const local = await call(handler, { op: 'settings-task-attribution', body: { mode: 'auto' }, local: true });
  assert.equal(local.payload.value.status, 200);
  assert.equal(local.payload.value.body.ok, true);
  assert.equal(writes.length, 1);
});

test('a handler that throws becomes a sanitized envelope, never its message', async () => {
  const { host } = build({
    skillSync: { getStatus() { throw new Error('/Users/someone/secret-path boom'); }, runNow: () => ({}) },
  });
  const handler = mount(host);
  const origError = console.error;
  console.error = () => {};
  let result;
  try { result = await call(handler, { op: 'skill-sync-status', local: true }); } finally { console.error = origError; }
  const value = result.payload.value;
  assert.equal(value.threw, true);
  assert.equal(value.status, 500);
  assert.ok(!JSON.stringify(value).includes('secret-path'));
});
