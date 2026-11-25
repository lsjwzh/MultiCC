'use strict';

// 宿主端口（host port）：POST /api/__host/orchestration。
//
// 编排与无人值守 30 条公开路由已由 Rust 前门独占
// （native/gateway/src/app/orchestration_routes.rs，规则在
// native/core/src/orchestration_routes.rs，集成测试在
// native/gateway/tests/orchestration_routes.rs，差分在
// docs/rust-migration/differential/orchestration-routes.js）。路径匹配、参数解码、
// Express 自动 OPTIONS 并集、会话准入守卫（含 v1 信封）都在 Rust。本文件只断言宿主
// 端口自己：op 表与 30 条一一对应、四个退休模块真的注册在捕获应用上、第二批搬入的
// 7 条（wait 注入器 / detached 集）确实在捕获应用上且 orchestration.js 不再有公开
// 挂载、回环闸门、未知 op、错误信封，以及请求头 / 请求 id 的传递。
//
// 完全 hermetic：不起端口、不碰 data 根；世界（tests/helpers/legacy-orchestration-
// routes/world.js）是内存替身，配置文件写在 mkdtemp 的临时目录里。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createOrchestrationHost, HOST_PATH, OPS } = require('../src/routes/orchestration-host');
const { createWorld, FROZEN_NOW } = require('./helpers/legacy-orchestration-routes/world');
const { mountUnattendedRoutes } = require('../src/unattended/routes');
const { mountAuxGoalRoutes } = require('../src/routes/aux-goal');
const { createAuxRunRoutes } = require('../src/routes/orchestration-host');
const { createOrchestrationRoutes } = require('../src/routes/orchestration');

// 第二批搬进宿主端口的 wait 注入器 / detached 集。
const SECOND_BATCH = [
  'POST /api/sessions/:id/wait',
  'POST /api/wait/:wid/resolve',
  'GET /api/sessions/:id/waits',
  'DELETE /api/wait/:wid',
  'POST /api/sessions/:id/run-detached',
  'GET /api/sessions/:id/detached',
  'GET /api/detached/:taskId',
];

function fakeExpress() {
  const express = () => ({});
  express.json = () => () => {};
  return express;
}

function recordingApp() {
  const routes = new Map();
  const add = method => (route, handler) => routes.set(`${method} ${route}`, handler);
  return { routes, get: add('GET'), post: add('POST'), delete: add('DELETE') };
}

function build(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-host-'));
  const world = createWorld({ dir, controlFile: path.join(dir, 'control.json') });
  const host = createOrchestrationHost({ express: fakeExpress() });
  mountUnattendedRoutes(host.app, world.unattendedDeps);
  mountAuxGoalRoutes(host.app, world.auxDeps);
  createAuxRunRoutes({ records: world.records, getLog: () => world.auxRunLog }).mountRoutes(host.app);
  const routes = createOrchestrationRoutes({ ...world.orchestrationDeps, ...options.deps });
  routes.mountHostRoutes(host.app);
  return { host, world, routes, dir };
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

test('the op table names exactly the 30 retired routes and every one is registered', () => {
  assert.equal(Object.keys(OPS).length, 30);
  const { host } = build();
  assert.equal(new Set(Object.values(OPS).map(spec => `${spec.method} ${spec.path}`)).size, 30);
  for (const [op, spec] of Object.entries(OPS)) {
    assert.equal(typeof host.handlers.get(`${spec.method} ${spec.path}`), 'function', `${op} has no handler`);
  }
  assert.equal(host.handlers.size, 30, 'the capture app holds nothing but the 30 routes');
});

test('the wait injector and detached set are ops on the capture app, with no public mount left', () => {
  const { host, routes } = build();
  const ops = new Set(Object.values(OPS).map(spec => `${spec.method} ${spec.path}`));
  for (const key of SECOND_BATCH) {
    assert.ok(ops.has(key), `${key} must be an op`);
    assert.equal(typeof host.handlers.get(key), 'function', `${key} must be captured`);
  }
  // The module exposes nothing that could put a route back on the real app: a
  // second answer for a claimed path is the one failure the front door cannot
  // see (Express would answer first for whatever it still has mounted).
  assert.deepEqual(Object.keys(routes), ['mountHostRoutes']);
  // Both waits listings are captured now, and they stay two distinct handlers.
  assert.ok(host.handlers.has('GET /api/v1/sessions/:id/waits'));
  assert.ok(host.handlers.has('GET /api/sessions/:id/waits'));
  assert.notEqual(
    host.handlers.get('GET /api/v1/sessions/:id/waits'),
    host.handlers.get('GET /api/sessions/:id/waits'),
  );
});

test('non-loopback callers get the same 404 as an unknown path', async () => {
  const { host } = build();
  const handler = mount(host, () => false);
  const result = await call(handler, { op: 'aux-status' });
  assert.equal(result.status, 404);
  assert.deepEqual(result.payload, { error: 'not found' });
});

test('an unknown op is a 400 and never reaches a handler', async () => {
  const { host, world } = build();
  const handler = mount(host);
  // Near-misses of real op names: `session-wait` lacks the `-post` suffix,
  // `session-detached-task` and `wait-resolve-callback` do not exist at all.
  for (const op of ['format-disk', 'session-wait', 'session-detached-task', 'wait-resolve-callback']) {
    const result = await call(handler, { op });
    assert.equal(result.status, 400, op);
    assert.deepEqual(result.payload, { error: 'unknown host operation' });
  }
  assert.equal((await call(handler, null)).status, 400);
  assert.equal(world.calls.length, 0);
});

test('a handler answer is relayed as { status, body, headers } with params, query, body and header facts', async () => {
  const { host, world } = build();
  const handler = mount(host);
  const queued = await call(handler, {
    op: 'scheduled-message-post', id: 's1', body: { message: 'later', delaySeconds: 3 },
    headers: { 'idempotency-key': 'idem-1' }, requestId: 'r-1', correlationId: 'c-1', local: true,
  });
  assert.equal(queued.status, 200);
  assert.equal(queued.payload.ok, true);
  assert.equal(queued.payload.value.status, 201);
  assert.equal(queued.payload.value.body.scheduledMessage.clientScheduleId, 'idem-1');
  assert.equal(world.calls[0].name, 'scheduleMessage');

  const tasks = await call(handler, {
    op: 'session-tasks', id: 's1', query: { taskIds: ['a', 'b'] },
  });
  assert.deepEqual(tasks.payload.value.body.tasks[0].received, ['a', 'b']);

  const run = await call(handler, { op: 'session-aux-run', id: 's1', runId: 'r2' });
  assert.equal(run.payload.value.body.run.runId, 'r2');
  const missing = await call(handler, { op: 'session-aux-run', id: 'ghost', runId: 'r2' });
  assert.equal(missing.payload.value.status, 404);
  assert.deepEqual(missing.payload.value.body, { error: 'session not found' });
});

test('the v1 waits projection takes its envelope ids from the front door', async () => {
  const { host } = build();
  const handler = mount(host);
  const ok = await call(handler, { op: 'v1-session-waits', id: 's1', requestId: 'req-9', correlationId: 'corr-9' });
  assert.equal(ok.payload.value.status, 200);
  assert.equal(ok.payload.value.body.apiVersion, 'v1');
  assert.equal(ok.payload.value.body.requestId, 'req-9');
  assert.equal(ok.payload.value.body.correlationId, 'corr-9');
  assert.equal(ok.payload.value.body.count, 2);
  const gone = await call(handler, { op: 'v1-session-waits', id: 'ghost', requestId: 'req-9', correlationId: 'corr-9' });
  assert.equal(gone.payload.value.status, 404);
  assert.equal(gone.payload.value.body.code, 'session_not_found');
  assert.equal(gone.payload.value.body.requestId, 'req-9');
  const broken = await call(handler, { op: 'v1-session-waits', id: 's2', requestId: 'req-9', correlationId: 'corr-9' });
  assert.equal(broken.payload.value.status, 500);
  assert.equal(broken.payload.value.body.code, 'wait_list_failed');
});

test('the queue actions reach the scheduler in the retired order and nothing else', async () => {
  const { host, world } = build();
  const handler = mount(host);
  const refused = await call(handler, { op: 'session-queue-action', id: 's1', body: { action: 'retry' } });
  assert.equal(refused.payload.value.status, 409);
  assert.equal(world.calls.length, 0, 'an unconfirmed action touches nothing');
  const invalid = await call(handler, { op: 'session-queue-action', id: 's1', body: { action: 'nuke', confirm: true } });
  assert.equal(invalid.payload.value.status, 400);
  assert.equal(world.calls.length, 0);
  await call(handler, { op: 'session-queue-action', id: 's1', body: { action: 'cancel_queued', confirm: true, entryId: 'e-q1' } });
  assert.deepEqual(world.calls.map(call => call.name), ['sessionScheduler.cancelQueued', 'tick']);
});

test('a handler that throws becomes a sanitized envelope, never its message', async () => {
  const { host } = build({
    deps: { dismissUserInput: async () => { throw Object.assign(new Error('/Users/someone/secret-path boom'), { status: 502 }); } },
  });
  const handler = mount(host);
  // The retired handler catches this itself (500 with the raw message); the
  // envelope path is for a throw that escapes the handler entirely.
  const caught = await call(handler, { op: 'user-input-dismiss', id: 's1', body: { requestId: 'r' } });
  assert.equal(caught.payload.value.status, 500);

  const { host: broken } = build();
  broken.handlers.set('GET /api/aux/status', () => { throw Object.assign(new Error('/Users/someone/secret-path boom'), { status: 502 }); });
  const origError = console.error;
  console.error = () => {};
  let result;
  try { result = await call(mount(broken), { op: 'aux-status' }); } finally { console.error = origError; }
  const value = result.payload.value;
  assert.equal(value.threw, true);
  assert.equal(value.status, 502);
  assert.ok(!JSON.stringify(value).includes('secret-path'));
});

test('an op whose conditional route was not mounted is an unknown operation, not a crash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-host-'));
  const world = createWorld({ dir, controlFile: path.join(dir, 'control.json') });
  const host = createOrchestrationHost({ express: fakeExpress() });
  const { sessionScheduler, ...runtime } = world.orchestrationDeps.runtime;
  const { dismissUserInput, ...deps } = world.orchestrationDeps;
  createOrchestrationRoutes({ ...deps, runtime }).mountHostRoutes(host.app);
  const handler = mount(host);
  for (const op of ['session-queue', 'session-queue-action', 'user-input-dismiss']) {
    assert.equal((await call(handler, { op, id: 's1' })).status, 400, op);
  }
  assert.equal((await call(handler, { op: 'session-tasks', id: 's1' })).status, 200);
});

test('server.js wires the capture app for all four retired modules and no public mount', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /createOrchestrationHost\(\{ express \}\)/);
  assert.match(server, /sessionAdmin\.mountRoutes\(app, \{ unattendedApp: orchestrationHost\.app \}\)/);
  assert.match(server, /mountAuxGoalRoutes\(orchestrationHost\.app, \{/);
  assert.match(server, /createAuxRunRoutes\(\{ records: persistedSessions, getLog: \(\) => auxRunLog \}\)\.mountRoutes\(orchestrationHost\.app\)/);
  assert.match(server, /orchestrationRoutes\.mountHostRoutes\(orchestrationHost\.app\)/);
  assert.match(server, /orchestrationHost\.mountRoute\(app\)/);
  // Never the public app for a retired module -- including the wait injector and
  // detached set, which the second batch took: only the host endpoint is public.
  assert.doesNotMatch(server, /orchestrationRoutes\.mountRoutes\(/);
  assert.doesNotMatch(server, /mountAuxGoalRoutes\(app,/);
  assert.doesNotMatch(server, /createAuxRunRoutes\([^)]*\)\.mountRoutes\(app\)/);
  assert.doesNotMatch(server, /mountUnattendedRoutes\(app/);
  assert.equal(FROZEN_NOW > 0, true);
});
