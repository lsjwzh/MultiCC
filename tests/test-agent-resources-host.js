'use strict';

// 宿主端口（host port）：POST /api/__host/agent-resources。
//
// 6 条公开 agent-resources 路由已由 Rust 前门独占（native/gateway/src/app/agent_resources.rs，
// 集成测试在 native/gateway/tests/agent_resources.rs）。Node 侧只剩宿主契约：presets
// 文件缓存与 commander 覆盖、skills 扫描、Claude 历史读写。路径匹配、olderThanDays
// 校验、purge 循环、计数与状态码都在 Rust，所以本文件只断言 op 映射与透传。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAgentResourcesHost,
  mountAgentResourcesHostRoute,
  HOST_PATH,
} = require('../src/routes/agent-resources-host');

function fakeRuntime(overrides = {}) {
  const calls = [];
  const runtime = {
    installedSkills() { calls.push(['installedSkills']); return [{ name: 's' }]; },
    presetsList() { calls.push(['presetsList']); return { ok: true, presets: [] }; },
    presetLookup(id) { calls.push(['presetLookup', id]); return { ok: true, found: false }; },
    claudeSessions() { calls.push(['claudeSessions']); return [{ id: 'a' }]; },
    removeClaudeSession(project, id) {
      calls.push(['removeClaudeSession', project, id]);
      return { ok: true, freed: 3 };
    },
    ...overrides,
  };
  return { runtime, calls };
}

function createApp() {
  const routes = new Map();
  const app = { routes };
  app.post = (routePath, handler) => routes.set(`POST ${routePath}`, handler);
  return app;
}

function mount(options = {}) {
  const app = createApp();
  mountAgentResourcesHostRoute(app, { isLocal: () => true, ...options });
  return app;
}

function respond(app, body) {
  const handler = app.routes.get(`POST ${HOST_PATH}`);
  assert.equal(typeof handler, 'function', `missing route POST ${HOST_PATH}`);
  let settle;
  const responded = new Promise(resolve => { settle = resolve; });
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; settle(this); return this; },
  };
  handler({ body }, res);
  return responded;
}

test('mounting registers exactly POST /api/__host/agent-resources', () => {
  const { runtime } = fakeRuntime();
  const app = mount({ runtime });
  assert.deepEqual([...app.routes.keys()], [`POST ${HOST_PATH}`]);
  assert.throws(() => mount(), /runtime is required/);
  assert.throws(() => createAgentResourcesHost(null), /runtime is required/);
});

test('the host port only answers loopback requests and never runs the operation otherwise', async () => {
  const { runtime, calls } = fakeRuntime();
  const app = mount({ runtime, isLocal: () => false });
  for (const body of [{ op: 'skills' }, { op: 'presets' }]) {
    const response = await respond(app, body);
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, { error: 'not found' });
  }
  assert.deepEqual(calls, []);
});

test('each op maps to the runtime method the Rust front door expects', async () => {
  const { runtime, calls } = fakeRuntime();
  const handle = createAgentResourcesHost(runtime);
  assert.deepEqual(handle({ op: 'skills' }), { ok: true, skills: [{ name: 's' }] });
  assert.deepEqual(handle({ op: 'presets' }), { ok: true, presets: [] });
  assert.deepEqual(handle({ op: 'preset', id: 'xf' }), { ok: true, found: false });
  assert.deepEqual(handle({ op: 'claude-sessions' }), { ok: true, sessions: [{ id: 'a' }] });
  assert.deepEqual(handle({ op: 'claude-session-delete', project: 'p', id: 'i' }),
    { ok: true, freed: 3 });
  assert.deepEqual(calls, [
    ['installedSkills'],
    ['presetsList'],
    ['presetLookup', 'xf'],
    ['claudeSessions'],
    ['removeClaudeSession', 'p', 'i'],
  ]);
});

test('missing or non-string fields are passed as empty strings, never as undefined', () => {
  const seen = [];
  const handle = createAgentResourcesHost({
    presetLookup(id) { seen.push(['presetLookup', id]); return { ok: true, found: false }; },
    removeClaudeSession(project, id) {
      seen.push(['removeClaudeSession', project, id]);
      return { ok: false, error: 'not found' };
    },
  });
  assert.deepEqual(handle({ op: 'preset' }), { ok: true, found: false });
  assert.deepEqual(handle({ op: 'claude-session-delete', project: 7 }), { ok: false, error: 'not found' });
  assert.deepEqual(seen, [
    ['presetLookup', ''],
    ['removeClaudeSession', '', ''],
  ]);
});

test('an unknown op answers ok:false and a non-object body never throws', () => {
  const { runtime } = fakeRuntime();
  const handle = createAgentResourcesHost(runtime);
  assert.deepEqual(handle({ op: 'nope' }), { ok: false });
  assert.deepEqual(handle({}), { ok: false });
  assert.deepEqual(handle(null), { ok: false });
  assert.deepEqual(handle({ op: 'skills', extra: true }), { ok: true, skills: [{ name: 's' }] });
});

test('a throwing operation surfaces as the host failure status', async () => {
  const { runtime } = fakeRuntime({
    presetsList() { throw new Error('disk exploded'); },
  });
  const response = await respond(mount({ runtime }), { op: 'presets' });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, { error: 'host operation failed' });
});

test('the mounted route serializes the runtime answer through res.json', async () => {
  const { runtime } = fakeRuntime();
  const response = await respond(mount({ runtime }), { op: 'claude-sessions' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, sessions: [{ id: 'a' }] });
});
