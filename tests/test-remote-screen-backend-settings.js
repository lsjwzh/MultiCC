'use strict';

// /api/settings/remote-screen-backend 的接线：Rust 决策（这里用桩替身），Node 只收集
// 宿主事实、落盘单个键，并把 400/409/503 原样透出。切后端不热切换、不重启。

const assert = require('node:assert/strict');
const test = require('node:test');
const { mountRemoteScreenBackendSettingsRoutes } = require('../src/routes/remote-screen-backend-settings');

function fakeApp() {
  const handlers = {};
  return {
    handlers,
    get(route, handler) { handlers[`GET ${route}`] = handler; },
    post(route, handler) { handlers[`POST ${route}`] = handler; },
  };
}

function invoke(handler, body) {
  const req = { body };
  const res = { statusCode: 200, payload: null };
  res.status = code => { res.statusCode = code; return res; };
  res.json = payload => { res.payload = payload; return res; };
  handler(req, res);
  return { status: res.statusCode, body: res.payload };
}

function harness(overrides = {}) {
  const app = fakeApp();
  const envFile = { MULTICC_REMOTE_SCREEN_BACKEND: overrides.configured };
  if (envFile.MULTICC_REMOTE_SCREEN_BACKEND === undefined) delete envFile.MULTICC_REMOTE_SCREEN_BACKEND;
  const writes = [];
  const calls = [];
  const native = overrides.native === undefined ? {
    remoteScreenBackendSettings(input) {
      calls.push(JSON.parse(input));
      return JSON.stringify(overrides.plan(JSON.parse(input)));
    },
  } : overrides.native;
  mountRemoteScreenBackendSettingsRoutes(app, {
    getNative: () => native,
    readEnvFile: () => ({ ...envFile }),
    writeEnvFile: updates => { writes.push(updates); Object.assign(envFile, updates); },
    currentBackend: overrides.currentBackend || 'rust',
    rustAvailable: () => overrides.rustAvailable !== false,
    nodeAvailable: () => overrides.nodeAvailable !== false,
  });
  return { app, envFile, writes, calls };
}

function viewPlan(input) {
  const configured = input.action === 'save' ? input.requestedBackend : (input.configuredBackend || 'rust');
  return {
    status: 200, currentBackend: input.currentBackend, configuredBackend: configured,
    restartRequired: input.currentBackend !== configured,
    rustAvailable: input.rustAvailable, nodeAvailable: input.nodeAvailable,
    ...(input.action === 'save' ? { updates: { MULTICC_REMOTE_SCREEN_BACKEND: configured } } : {}),
  };
}

test('GET 返回当前/配置状态，不写配置', () => {
  const h = harness({ configured: 'node', currentBackend: 'rust', plan: viewPlan });
  const res = invoke(h.app.handlers['GET /api/settings/remote-screen-backend']);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, currentBackend: 'rust', configuredBackend: 'node',
    restartRequired: true, rustAvailable: true, nodeAvailable: true });
  assert.equal(h.writes.length, 0);
  assert.equal(h.calls[0].action, 'read');
  assert.equal(h.calls[0].currentBackend, 'rust');
  assert.equal(h.calls[0].configuredBackend, 'node');
});

test('POST 保存只写单个环境键，并回报「重启后生效」', () => {
  const h = harness({ currentBackend: 'rust', plan: viewPlan });
  const res = invoke(h.app.handlers['POST /api/settings/remote-screen-backend'], { backend: 'node' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, currentBackend: 'rust', configuredBackend: 'node',
    restartRequired: true, rustAvailable: true, nodeAvailable: true });
  assert.deepEqual(h.writes, [{ MULTICC_REMOTE_SCREEN_BACKEND: 'node' }]);
  assert.deepEqual(h.envFile, { MULTICC_REMOTE_SCREEN_BACKEND: 'node' });
  assert.equal(h.calls[0].requestedBackend, 'node');
});

test('400/409 原样透出且不落盘', () => {
  for (const [status, error] of [[400, '远程屏幕后端只支持 node 或 rust'], [409, '不可用']]) {
    const h = harness({ plan: () => ({ status, error }) });
    const res = invoke(h.app.handlers['POST /api/settings/remote-screen-backend'], { backend: 'auto' });
    assert.equal(res.status, status);
    assert.deepEqual(res.body, { error });
    assert.equal(h.writes.length, 0);
  }
});

test('原生模块缺失或抛错时回 503，不猜测结果', () => {
  const app = fakeApp();
  mountRemoteScreenBackendSettingsRoutes(app, { getNative: () => ({}), readEnvFile: () => ({}), writeEnvFile: () => {} });
  const res = invoke(app.handlers['GET /api/settings/remote-screen-backend']);
  assert.equal(res.status, 503);
  assert.match(res.body.error, /尚未就绪/);

  const throwing = fakeApp();
  mountRemoteScreenBackendSettingsRoutes(throwing, {
    getNative: () => { throw new Error('load failed'); },
    readEnvFile: () => ({}), writeEnvFile: () => {},
  });
  const failed = invoke(throwing.handlers['GET /api/settings/remote-screen-backend']);
  assert.equal(failed.status, 503);
  assert.match(failed.body.error, /无法读取或保存/);
});
