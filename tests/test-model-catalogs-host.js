'use strict';

// 宿主端口（host port）：POST /api/__host/model-catalogs。
//
// 8 条公开模型目录路由已由 Rust 前门独占（native/gateway/src/app/model_catalogs.rs，
// 逐字节差异测试在 native/gateway/tests/model_catalogs.rs）。Node 侧只剩这份宿主契约：
// CLI 枚举 + 进程内缓存、provider store 投影、官方账号目录运行时。路径匹配、查询串、
// 状态码与响应形状都不在这里，所以本文件只断言回调映射与透传。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createModelCatalogsHost,
  mountModelCatalogsHostRoute,
  HOST_PATH,
} = require('../src/routes/model-catalogs-host');

const CLI_MODULES = {
  opencode: require('../src/routes/opencode-models'),
  qoder: require('../src/routes/qoder-models'),
  grok: require('../src/routes/grok-models'),
  commandcode: require('../src/routes/commandcode-models'),
  codebuddy: require('../src/routes/codebuddy-models'),
};
const CLI_LIST_EXPORTS = {
  opencode: 'listOpenCodeModels',
  qoder: 'listQoderModels',
  grok: 'listGrokModels',
  commandcode: 'listCommandcodeModels',
  codebuddy: 'listCodebuddyModels',
};
// 退役的 mount* 里给出的 503 文案，Rust 原样转发给客户端。
const CLI_UNAVAILABLE = {
  opencode: 'opencode models unavailable',
  qoder: 'qoder models unavailable',
  grok: 'grok models unavailable',
  commandcode: 'commandcode models unavailable',
  codebuddy: 'codebuddy models unavailable',
};
const ORIGINAL_LIST = new Map(Object.entries(CLI_LIST_EXPORTS)
  .map(([op, exportName]) => [op, CLI_MODULES[op][exportName]]));

test.afterEach(() => {
  for (const [op, original] of ORIGINAL_LIST) CLI_MODULES[op][CLI_LIST_EXPORTS[op]] = original;
});

function stubCli(op, list) {
  CLI_MODULES[op][CLI_LIST_EXPORTS[op]] = list;
}

function createApp() {
  const routes = new Map();
  const app = { routes };
  app.post = (routePath, handler) => routes.set(`POST ${routePath}`, handler);
  return app;
}

function mount(options = {}) {
  const app = createApp();
  mountModelCatalogsHostRoute(app, { isLocal: () => true, ...options });
  return app;
}

async function invoke(app, body) {
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
  await handler({ body }, res);
  return responded;
}

test('mounting registers exactly POST /api/__host/model-catalogs', () => {
  const app = mount();
  assert.deepEqual([...app.routes.keys()], [`POST ${HOST_PATH}`]);
});

test('the host port only answers loopback requests and never runs the operation otherwise', async () => {
  const app = mount({ isLocal: () => false });
  let cliCalls = 0;
  stubCli('qoder', (callback) => { cliCalls += 1; callback(null, [{ model: 'cached' }], 'cache'); });
  const providerCalls = [];
  const other = mount({
    isLocal: () => false,
    providerRuntime: { listProviderModels(id) { providerCalls.push(id); return Promise.resolve({ status: 200, body: {} }); } },
  });
  for (const body of [{ op: 'qoder' }, { op: 'provider', providerId: 'relay-1' }]) {
    const response = await invoke(app, body);
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, { error: 'not found' });
  }
  const providerResponse = await invoke(other, { op: 'provider', providerId: 'relay-1' });
  assert.equal(providerResponse.statusCode, 404);
  assert.equal(cliCalls, 0);
  assert.deepEqual(providerCalls, []);
});

test('each CLI op maps a callback result to {ok, models, source}', async () => {
  const app = mount();
  for (const op of Object.keys(CLI_MODULES)) {
    const seen = [];
    stubCli(op, (callback, options) => {
      seen.push(options);
      callback(null, [{ model: `${op}-live` }], 'cli');
    });
    const response = await invoke(app, { op, refresh: true });
    assert.equal(response.statusCode, 200, op);
    assert.deepEqual(response.body, { ok: true, models: [{ model: `${op}-live` }], source: 'cli' }, op);
    assert.deepEqual(seen, [{ refresh: true }], `${op} forwards refresh`);
    // Without body.refresh only a strict true skips the cache.
    await invoke(app, { op, refresh: '1' });
    assert.deepEqual(seen.at(-1), { refresh: false }, `${op} never coerces the query string`);
  }
});

test('each CLI op maps a callback error to its retired unavailable wording', async () => {
  const app = mount();
  for (const op of Object.keys(CLI_MODULES)) {
    stubCli(op, (callback) => callback(new Error('cli exploded')));
    const response = await invoke(app, { op });
    assert.equal(response.statusCode, 200, op);
    assert.deepEqual(response.body, { ok: false, error: CLI_UNAVAILABLE[op] }, op);
  }
});

test('a throwing CLI list or a non-array result is still a well-formed answer', async () => {
  const app = mount();
  stubCli('codebuddy', () => { throw new Error('spawn failed'); });
  assert.deepEqual((await invoke(app, { op: 'codebuddy' })).body,
    { ok: false, error: 'codebuddy models unavailable' });
  stubCli('grok', (callback) => callback(null, undefined, undefined));
  assert.deepEqual((await invoke(app, { op: 'grok' })).body, { ok: true, models: [], source: '' });
});

test('provider op forwards id/refresh and returns {status, body} unchanged', async () => {
  const calls = [];
  const responses = {
    live: { status: 200, body: { models: [{ model: 'relay-live' }], source: 'live' } },
    missing: { status: 404, body: { error: 'provider not found' } },
  };
  const handle = createModelCatalogsHost({
    providerRuntime: {
      listProviderModels(id, options) {
        calls.push({ id, options });
        return Promise.resolve(id === 'missing' ? responses.missing : responses.live);
      },
    },
  });
  assert.deepEqual(await handle({ op: 'provider', providerId: 'relay-1', refresh: true }), responses.live);
  assert.deepEqual(await handle({ op: 'provider', providerId: 'relay-1' }), responses.live);
  assert.deepEqual(await handle({ op: 'provider', providerId: 'missing', refresh: false }), responses.missing);
  assert.deepEqual(calls, [
    { id: 'relay-1', options: { refresh: true } },
    { id: 'relay-1', options: { refresh: false } },
    { id: 'missing', options: { refresh: false } },
  ]);
});

function codexHarness() {
  const official = { id: 'codex-official-account', appType: 'codex',
    settingsConfig: { auth: { auth_mode: 'chatgpt' }, officialAccount: { id: '0123456789abcdef' } } };
  const relay = { id: 'relay', appType: 'codex', settingsConfig: {
    auth: { OPENAI_API_KEY: 'test-fixture' }, config: 'base_url = "https://relay.invalid/v1"' } };
  let refreshing = false;
  let calls = 0;
  let complete;
  let snapshot = { models: [], source: 'none' };
  const handle = createModelCatalogsHost({
    codexRuntime: {
      resolveProvider: value => (value === official.id ? official : value === relay.id ? relay : null),
      peekProvider: () => snapshot,
      isRefreshing: () => refreshing,
      refreshProvider: () => {
        calls += 1;
        refreshing = true;
        return new Promise(resolve => {
          complete = () => {
            snapshot = { models: [{ model: 'account-only', label: 'Account only' }], source: 'account_cache' };
            refreshing = false;
            resolve(snapshot);
          };
        });
      },
    },
  });
  return { handle, official, relay, calls: () => calls, complete: () => complete() };
}

test('codex-state answers not found, or the official fact set with peek/refreshing', async () => {
  const harness = codexHarness();
  assert.deepEqual(await harness.handle({ op: 'codex-state', providerId: 'missing' }), { found: false });

  const relay = await harness.handle({ op: 'codex-state', providerId: harness.relay.id });
  assert.deepEqual(relay, { found: true, id: harness.relay.id, appType: 'codex', official: false });
  assert.equal(Object.prototype.hasOwnProperty.call(relay, 'peek'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(relay, 'refreshing'), false);

  assert.deepEqual(await harness.handle({ op: 'codex-state', providerId: harness.official.id }), {
    found: true, id: harness.official.id, appType: 'codex', official: true,
    peek: { models: [], source: 'none' },
    refreshing: false,
  });
});

test('codex-refresh with wait:false returns before the fake refresh resolves', async () => {
  const harness = codexHarness();
  assert.deepEqual(await harness.handle({ op: 'codex-refresh', providerId: harness.official.id, wait: false }), { ok: true });
  assert.equal(harness.calls(), 1);
  const pending = await harness.handle({ op: 'codex-state', providerId: harness.official.id });
  assert.equal(pending.refreshing, true);
  harness.complete();
  const ready = await harness.handle({ op: 'codex-state', providerId: harness.official.id });
  assert.equal(ready.refreshing, false);
  assert.equal(ready.peek.models[0].model, 'account-only');
  assert.equal(harness.calls(), 1);
});

test('codex-refresh with wait:true waits for the refresh to resolve', async () => {
  const harness = codexHarness();
  let settled = false;
  const refresh = harness.handle({ op: 'codex-refresh', providerId: harness.official.id, wait: true })
    .then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  harness.complete();
  assert.deepEqual(await refresh, { ok: true });
});

test('an unknown op and a non-object body answer error:true', async () => {
  const handle = createModelCatalogsHost({});
  assert.deepEqual(await handle({ op: 'nope' }), { error: true });
  assert.deepEqual(await handle({}), { error: true });
  assert.deepEqual(await handle(null), { error: true });
});

test('the mounted route surfaces an unknown op through its JSON path', async () => {
  const response = await invoke(mount(), { op: 'nope' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { error: true });
});
