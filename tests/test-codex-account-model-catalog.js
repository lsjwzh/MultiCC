'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexAccountModelCatalogRuntime } = require('../src/codex/model-catalog');
const { summarize } = require('../src/providers/core');
const { createProviderRelayModelCatalogRuntime } = require('../src/providers/relay-model-catalog');
const A = 'a'.repeat(16), B = 'b'.repeat(16);
function provider(id) { return { id: `codex-official-${id}`, appType: 'codex', activeAccountId: id,
  settingsConfig: { auth: { auth_mode: 'chatgpt' }, config: '',
    ...(id === 'global' ? {} : { officialAccount: { id } }) } }; }
function setup(extra = {}) {
  const calls = [], snapshots = new Map();
  const records = [provider(A), provider(B), provider('global')];
  const runtime = createCodexAccountModelCatalogRuntime({
    accounts: { codexDir: id => `/accounts/${id}` }, globalHome: '/global-codex',
    providers: { getProvider: (_, id) => records.find(p => p.id === id), listProviders: () => records },
    env: { PATH: '/bin', CODEX_HOME: '/wrong-home', CODEX_API_KEY: 'not-for-official', OPENAI_API_KEY: 'not-for-official', OPENAI_BASE_URL: 'https://third-party.invalid' },
    cliBin: '/fake/codex', getChildProxyEnv: async env => ({ ...env, HTTPS_PROXY: 'http://global-proxy' }),
    runNative: operation => operation(),
    getNative: () => ({
      codexModelsPeek: home => JSON.stringify(snapshots.get(home) || { models: [], stale: true }),
      codexModelsRefresh: async input => { const value = JSON.parse(input); calls.push(value);
        const result = { models: [{ model: `model-${value.home.split('/').pop()}` }], fetchedAt: 12, stale: false };
        snapshots.set(value.home, result); return JSON.stringify(result); },
    }), ...extra,
  });
  return { runtime, calls, records, snapshots };
}

test('账号目录与环境隔离，刷新后摘要不会混入全局模型', async () => {
  const { runtime, calls, records } = setup();
  await runtime.refreshAccount(A, { force: true });
  await runtime.refreshAccount(B);
  await runtime.refreshProvider(records[2]);
  assert.deepEqual(calls.map(call => call.home), [`/accounts/${A}`, `/accounts/${B}`, '/global-codex']);
  assert.equal(calls[0].force, true);
  for (const call of calls) {
    assert.equal(call.env.CODEX_HOME, call.home);
    assert.equal(call.env.OPENAI_API_KEY, undefined);
    assert.equal(call.env.CODEX_API_KEY, undefined);
    assert.equal(call.env.OPENAI_BASE_URL, undefined);
    assert.equal(call.env.HTTPS_PROXY, 'http://global-proxy');
  }
  assert.deepEqual(summarize(records[0], { codexModelCatalogRuntime: runtime }).modelOptions, [`model-${A}`]);
  assert.deepEqual(summarize(records[1], { codexModelCatalogRuntime: runtime }).modelOptions, [`model-${B}`]);
});

test('专属出口覆盖继承代理，出口解析失败不会调用 CLI 或直连', async () => {
  const { runtime, calls, records } = setup({ resolveProxyUrl: async () => 'http://dedicated-proxy' });
  records[0].egressBinding = { pluginId: 'proxy', profileId: 'a' };
  await runtime.refreshProvider(records[0]);
  assert.equal(calls[0].env.HTTPS_PROXY, 'http://dedicated-proxy');
  assert.equal(calls[0].env.NO_PROXY, 'localhost,127.0.0.1,::1');
  const failed = setup({ resolveProxyUrl: async () => { throw new Error('插件未安装'); } });
  failed.records[0].egressBinding = records[0].egressBinding;
  const result = await failed.runtime.refreshProvider(failed.records[0]);
  assert.equal(failed.calls.length, 0);
  assert.equal(result.diagnostic.code, 'refresh_unavailable');
});

test('原生接口缺失和异常安全失败，不运行 Node 发现兜底', async () => {
  for (const getNative of [() => null, () => { throw new Error('absent'); }]) {
    const { runtime, records } = setup({ getNative });
    assert.deepEqual(runtime.peekProvider(records[0]).models, []);
    const result = await runtime.refreshProvider(records[0]);
    assert.deepEqual(result.models, []);
    assert.equal(runtime.isRefreshing(records[0]), false);
  }
});

test('后台原生调用可观测且同账号并发复用，不等待模型返回即可读取快照', async () => {
  let release;
  const { runtime, records } = setup({ getNative: () => ({
    codexModelsPeek: () => JSON.stringify({ models: [] }),
    codexModelsRefresh: () => new Promise(resolve => { release = resolve; }),
  }) });
  const pending = runtime.refreshProvider(records[0]);
  assert.equal(runtime.isRefreshing(records[0]), true);
  assert.equal(runtime.refreshProvider(records[0]), pending);
  assert.deepEqual(runtime.peekProvider(records[0]).models, []);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release(JSON.stringify({ models: [] }));
  await pending;
  assert.equal(runtime.isRefreshing(records[0]), false);
});

test('旧全局运行时不能给受管账号的借道目录补入其他账号模型', async () => {
  const record = provider(A);
  const runtime = createProviderRelayModelCatalogRuntime({
    providers: { getProviderSummary: () => ({ ...record, isOfficial: true, modelOptions: ['account-model'] }),
      getProvider: () => record, listProviders: () => [], getProviderLimitTarget() {}, updateProviderRelayModelCatalog() {} },
    codexModelsRuntime: { peek: () => ({ models: [{ model: 'global-model' }] }) },
  });
  const facts = await runtime.sourceCatalogFacts('codex', record.id);
  assert.deepEqual(facts.summary.modelOptions, ['account-model']);
  assert.equal(facts.catalog, null, '不得把旧全局目录当成受管账号快照');
});

test('登录强制刷新排在已运行的普通刷新后，不被旧账号快照吞掉', async () => {
  const releases = [], calls = [];
  const { runtime, records } = setup({ getNative: () => ({
    codexModelsPeek: () => JSON.stringify({ models: [] }),
    codexModelsRefresh: input => { calls.push(JSON.parse(input));
      return new Promise(resolve => releases.push(resolve)); },
  }) });
  const normal = runtime.refreshProvider(records[0]);
  const forced = runtime.refreshAccount(A, { force: true });
  assert.equal(runtime.peekProvider(records[0]).diagnostic.code, 'refreshing');
  while (!releases.length) await new Promise(resolve => setImmediate(resolve));
  releases.shift()(JSON.stringify({ models: [] }));
  await normal;
  while (!releases.length) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.map(call => call.force), [false, true]);
  releases.shift()(JSON.stringify({ models: [] }));
  await forced;
});

test('重登录遇到出口故障保留失效门，恢复后强制刷新而不是暴露旧模型', async () => {
  let offline = false;
  const { runtime, records, calls } = setup({ resolveProxyUrl: async () => {
    if (offline) throw new Error('出口故障'); return 'http://dedicated-proxy';
  } });
  records[0].egressBinding = { pluginId: 'proxy', profileId: 'a' };
  await runtime.refreshProvider(records[0]);
  assert.equal(runtime.peekProvider(records[0]).models.length, 1);
  offline = true;
  await runtime.refreshAccount(A, { force: true });
  assert.deepEqual(runtime.peekProvider(records[0]).models, []);
  offline = false;
  await runtime.refreshProvider(records[0]);
  assert.equal(calls.at(-1).force, true);
  assert.equal(runtime.peekProvider(records[0]).models.length, 1);
});

test('连续两次登录各自强制刷新，前一次完成不能清除后一次身份失效门', async () => {
  const releases = [], calls = [];
  const { runtime, records } = setup({ getNative: () => ({
    codexModelsPeek: () => JSON.stringify({ models: [{ model: 'old-account' }] }),
    codexModelsRefresh: input => { calls.push(JSON.parse(input));
      return new Promise(resolve => releases.push(resolve)); },
  }) });
  const first = runtime.refreshAccount(A, { force: true });
  const second = runtime.refreshAccount(A, { force: true });
  while (!releases.length) await new Promise(resolve => setImmediate(resolve));
  releases.shift()(JSON.stringify({ models: [] }));
  await first;
  assert.deepEqual(runtime.peekProvider(records[0]).models, []);
  while (!releases.length) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.map(call => call.force), [true, true]);
  releases.shift()(JSON.stringify({ models: [] }));
  await second;
  assert.equal(runtime.isRefreshing(records[0]), false);
});

test('启动恢复仅异步加载账号各自持久化目录，不调用 CLI 发现', async () => {
  const loaded = [], snapshots = new Map();
  const { runtime, records } = setup({ getNative: () => ({
    codexModelsPeek: home => JSON.stringify(snapshots.get(home) || { models: [] }),
    codexModelsLoad: async home => { loaded.push(home);
      snapshots.set(home, { models: [{ model: home.endsWith(A) ? 'model-a' : 'other-model' }] });
    },
    codexModelsRefresh: () => { throw new Error('启动不允许发现'); },
  }) });
  await runtime.hydrate();
  assert.deepEqual(loaded, [`/accounts/${A}`, `/accounts/${B}`, '/global-codex']);
  assert.deepEqual(runtime.peekProvider(records[0]).models, [{ model: 'model-a' }]);
});
