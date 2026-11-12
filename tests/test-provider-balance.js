'use strict';

// Node 仅验证宿主事实/副作用与反向桥接；余额业务由 Rust 测试覆盖。
const assert = require('node:assert/strict');
const test = require('node:test');
let fetchImpl = async () => { throw new Error('unexpected outbound'); };
test.mock.method(require('../src/network/outbound'), 'outboundFetch', (...args) => fetchImpl(...args));
const { createProviderBalanceRuntime, mountProviderBalanceRoutes, mountProviderRelayQuotaRoutes } = require('../src/routes/provider-balance');
const { HOST_PATH } = require('../src/routes/provider-balance-host');

function hostHarness(extra = {}) {
  const routes = [];
  const app = { post: (path, handler) => routes.push({ path, handler }) };
  const providers = [{ id: 'work', appType: 'claude', name: 'Work', private: 'not a catalog field' }];
  const deps = { isLocal: () => true, getPort: () => 43210,
    listProviders: () => providers,
    getProvider: (appType, id) => providers.find(p => p.appType === appType && p.id === id),
    getProviderLimitTarget: () => ({ strategy: 'deepseek-balance', host: 'api.deepseek.com', apiKey: 'fixture-key' }),
    ...extra };
  const runtime = mountProviderBalanceRoutes(app, deps);
  const call = async body => {
    const response = { statusCode: 200, body: null,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; } };
    await routes[0].handler({ body }, response);
    return response;
  };
  return { app, deps, routes, runtime, call };
}

test('余额与借道挂载点只注册一个内部宿主端口', () => {
  const h = hostHarness();
  mountProviderRelayQuotaRoutes(h.app, h.deps);
  assert.deepEqual(h.routes.map(r => r.path), [HOST_PATH]);
});

test('宿主拒绝非本地调用', async () => {
  const h = hostHarness({ isLocal: () => false });
  assert.equal((await h.call({ op: 'list' })).statusCode, 404);
});

test('宿主目录仅返回身份与名称，并区分未知线路', async () => {
  const h = hostHarness();
  assert.deepEqual((await h.call({ op: 'list' })).body, { ok: true, providers: [{ appType: 'claude', id: 'work', name: 'Work' }] });
  assert.deepEqual((await h.call({ op: 'facts', appType: 'claude', id: 'missing' })).body, { ok: true, found: false });
});

test('查询事实只读取 target 与出站限制，不执行厂商请求', async () => {
  const h = hostHarness();
  const answer = (await h.call({ op: 'facts', appType: 'claude', id: 'work' })).body;
  assert.equal(answer.ok, true);
  assert.equal(answer.provider.id, 'work');
  assert.equal(answer.target.strategy, 'deepseek-balance');
  assert.equal(answer.egress.allowed, true);
});

test('缓存读取与结果记录由现有缓存和 recorder 承担', async () => {
  const recorded = [];
  const h = hostHarness({ lookupCached: () => null, onResult: (...args) => { recorded.push(args); return null; } });
  assert.deepEqual((await h.call({ op: 'cached', appType: 'claude', id: 'work', now: 1000 })).body,
    { ok: true, found: true, entry: null, snapshot: null });
  const result = { ok: false, reason: 'fetch_failed' };
  assert.deepEqual((await h.call({ op: 'record', appType: 'claude', id: 'work', result, now: 1000 })).body,
    { ok: true, snapshot: null });
  assert.deepEqual(recorded, [['claude', 'work', result]]);
});

test('反向桥接编码线路参数并透传 Rust 的缓存与失败 DTO', async () => {
  const requests = [];
  const dto = { ok: false, reason: 'unsupported' };
  fetchImpl = async (url, options) => { requests.push({ url, options }); return { json: async () => dto }; };
  const runtime = createProviderBalanceRuntime({ getPort: () => 43210 });
  assert.deepEqual(await runtime.queryOne('claude', 'a/b'), dto);
  await runtime.readCached('claude', 'a/b');
  await runtime.queryAll();
  assert.deepEqual(requests.map(r => r.url), [
    'http://127.0.0.1:43210/api/providers/claude/a%2Fb/balance',
    'http://127.0.0.1:43210/api/providers/claude/a%2Fb/balance?cached=1',
    'http://127.0.0.1:43210/api/providers/balances',
  ]);
  assert.ok(requests.every(r => r.options.signal instanceof AbortSignal));
});

test('反向刷新失败保留旧回调的 null 契约', async () => {
  fetchImpl = async () => { throw new Error('offline'); };
  const runtime = createProviderBalanceRuntime({ getPort: () => 43210 });
  assert.equal(await runtime.refreshOne('claude', 'work'), null);
  await assert.rejects(runtime.queryAll(), /offline/);
});

test('缺少前门端口不回退到硬编码服务器', async () => {
  const runtime = createProviderBalanceRuntime();
  await assert.rejects(runtime.queryAll(), /gateway port unavailable/);
});
