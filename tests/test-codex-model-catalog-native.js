'use strict';

// 官方账号模型目录：原生刷新（真 addon）+ 宿主端口（src/routes/model-catalogs-host.js）。
//
// 公开的 GET/POST /api/codex/models 已由 Rust 前门独占
// （native/gateway/src/app/model_catalogs.rs）。Node 侧剩下的只有宿主端口上的两件事：
// provider 分类（存在？Codex？官方 OAuth 还是借道？）与 peek/refreshing 透传、
// 以及后台刷新的启动/等待。HTTP 状态码与响应体由 Rust 的集成测试覆盖。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createCodexAccountModelCatalogRuntime } = require('../src/codex/model-catalog');
const { createModelCatalogsHost } = require('../src/routes/model-catalogs-host');
const { summarize } = require('../src/providers/core');

let addon;
try { addon = process.env.MULTICC_RUST_ADDON ? require(process.env.MULTICC_RUST_ADDON)
  : require('../src/native/runtime').getNative(); } catch (_) {}
const nativeReady = typeof addon?.codexModelsRefresh === 'function';

test('原生目录经账号桥完成冷启动、缓存命中、升级刷新与失败保留', { skip: !nativeReady }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-codex-catalog-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'account');
  fs.mkdirSync(home);
  const cli = path.join(root, 'codex');
  const versionFile = path.join(root, 'version');
  const countFile = path.join(root, 'discoveries');
  fs.writeFileSync(versionFile, '1.0.0');
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('fs'), path = require('path');
const version = fs.readFileSync(process.env.FIXTURE_VERSION, 'utf8');
if (process.argv.includes('--version')) { console.log('codex-cli ' + version); process.exit(0); }
fs.appendFileSync(process.env.FIXTURE_COUNT, 'discovery\\n');
if (version === '3.0.0') process.exit(1);
const model = 'account-model-' + version;
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'models_cache.json'), JSON.stringify({
  fetched_at: new Date().toISOString(), client_version: version,
  models: [{slug:model,display_name:model,visibility:'list',priority:0}]
}));
require('readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  const result = request.method === 'initialize' ? {userAgent:'codex_cli_rs/' + version}
    : {data:[{id:model,model,displayName:model,isDefault:true}],nextCursor:null};
  console.log(JSON.stringify({id:request.id,result}));
});
`, { mode: 0o700 });
  const id = '0123456789abcdef';
  const provider = { id: `codex-official-${id}`, appType: 'codex',
    settingsConfig: { auth: { auth_mode: 'chatgpt' }, config: '', officialAccount: { id } } };
  const runtime = createCodexAccountModelCatalogRuntime({
    accounts: { codexDir: accountId => { assert.equal(accountId, id); return home; } },
    providers: { getProvider: (_type, providerId) => providerId === provider.id ? provider : null,
      listProviders: () => [provider] },
    getNative: () => addon, runNative: operation => operation(), cliBin: cli,
    env: { PATH: process.env.PATH, FIXTURE_VERSION: versionFile, FIXTURE_COUNT: countFile },
    getChildProxyEnv: async env => ({ ...env }),
  });
  const first = await runtime.refreshAccount(id, { force: true });
  assert.equal(first.diagnostic.code, 'ok');
  assert.equal(first.models[0].model, 'account-model-1.0.0');
  assert.deepEqual(summarize(provider, { codexModelCatalogRuntime: runtime }).modelOptions, ['account-model-1.0.0']);
  await runtime.refreshProvider(provider.id);
  assert.equal(fs.readFileSync(countFile, 'utf8').trim().split('\n').length, 1, '一天内不重新发现模型');

  fs.writeFileSync(versionFile, '2.0.0');
  const upgraded = await runtime.refreshProvider(provider.id);
  assert.equal(upgraded.models[0].model, 'account-model-2.0.0');
  assert.equal(fs.readFileSync(countFile, 'utf8').trim().split('\n').length, 2);

  fs.writeFileSync(versionFile, '3.0.0');
  const failed = await runtime.refreshProvider(provider.id);
  assert.equal(failed.stale, true);
  assert.equal(failed.models[0].model, 'account-model-2.0.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'multicc_models_catalog.json'), 'utf8')).cliVersion, '2.0.0');
});

// 宿主端口只回答 Rust 前门的问题：线路是否存在、是否官方、peek/refreshing 与后台刷新。
function hostHarness() {
  const official = { id: 'codex-official-account', appType: 'codex',
    settingsConfig: { auth: { auth_mode: 'chatgpt' }, officialAccount: { id: '0123456789abcdef' } } };
  const relay = { id: 'relay', appType: 'codex', settingsConfig: {
    auth: { OPENAI_API_KEY: 'test-fixture' }, config: 'base_url = "https://relay.invalid/v1"' } };
  let refreshing = false;
  let calls = 0;
  let complete;
  let snapshot = { models: [], source: 'none', diagnostic: { code: 'not_loaded' } };
  const runtime = {
    resolveProvider: value => value === official.id ? official : value === relay.id ? relay : null,
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
  };
  return {
    handle: createModelCatalogsHost({ codexRuntime: runtime }),
    official, relay, calls: () => calls, complete: () => complete(),
  };
}

test('codex-state reports a missing line, and classifies official vs relay', async () => {
  const harness = hostHarness();
  assert.deepEqual(await harness.handle({ op: 'codex-state', providerId: 'missing' }), { found: false });

  const relay = await harness.handle({ op: 'codex-state', providerId: harness.relay.id });
  assert.deepEqual(relay, { found: true, id: harness.relay.id, appType: 'codex', official: false });
  assert.equal(Object.prototype.hasOwnProperty.call(relay, 'peek'), false,
    'a relay line has its own baseURL/key and never peeks the official account catalog');
  assert.equal(Object.prototype.hasOwnProperty.call(relay, 'refreshing'), false);

  const official = await harness.handle({ op: 'codex-state', providerId: harness.official.id });
  assert.deepEqual(official, {
    found: true, id: harness.official.id, appType: 'codex', official: true,
    peek: { models: [], source: 'none', diagnostic: { code: 'not_loaded' } },
    refreshing: false,
  });
});

test('codex-refresh kicks one background refresh and state passes peek/refreshing through', async () => {
  const harness = hostHarness();
  const initial = await harness.handle({ op: 'codex-state', providerId: harness.official.id });
  assert.equal(initial.refreshing, false);
  assert.deepEqual(initial.peek.models, []);

  assert.deepEqual(await harness.handle({ op: 'codex-refresh', providerId: harness.official.id, wait: false }), { ok: true });
  assert.equal(harness.calls(), 1);
  const pending = await harness.handle({ op: 'codex-state', providerId: harness.official.id });
  assert.equal(pending.refreshing, true, 'the same background task is visible while it runs');
  assert.deepEqual(pending.peek.models, [], 'the previous catalog stays visible until the refresh lands');

  harness.complete();
  const ready = await harness.handle({ op: 'codex-state', providerId: harness.official.id });
  assert.equal(ready.refreshing, false);
  assert.equal(ready.peek.models[0].model, 'account-only');
  assert.equal(harness.calls(), 1, 'polling state never starts another refresh');
});

test('codex-refresh with wait:true answers only after the refresh resolves', async () => {
  const harness = hostHarness();
  let settled = false;
  const refresh = harness.handle({ op: 'codex-refresh', providerId: harness.official.id, wait: true })
    .then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'wait:true must not answer before the refresh resolves');
  harness.complete();
  assert.deepEqual(await refresh, { ok: true });
  const state = await harness.handle({ op: 'codex-state', providerId: harness.official.id });
  assert.equal(state.refreshing, false);
  assert.equal(state.peek.models[0].model, 'account-only');
});

test('a runtime that cannot resolve the line answers error:true', async () => {
  const handle = createModelCatalogsHost({
    codexRuntime: { resolveProvider() { throw new Error('store unavailable'); } },
  });
  assert.deepEqual(await handle({ op: 'codex-state', providerId: 'any' }), { error: true });
});
