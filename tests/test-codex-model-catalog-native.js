'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createCodexAccountModelCatalogRuntime } = require('../src/codex/model-catalog');
const { summarize } = require('../src/providers/core');
const { mountCodexModelRoutes } = require('../src/routes/codex-models');

let addon;
try { addon = process.env.MULTICC_RUST_ADDON ? require(process.env.MULTICC_RUST_ADDON)
  : require('../src/native/runtime').getNative(); } catch (_) {}
const nativeReady = typeof addon?.codexModelsRefresh === 'function';

test('原生目录经账号桥和模型接口完成冷启动、缓存命中、升级刷新与失败保留', { skip: !nativeReady }, async t => {
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
  const routes = new Map();
  mountCodexModelRoutes({ get: (p, fn) => routes.set(p, fn) }, undefined, runtime);
  const read = async poll => {
    let body;
    await routes.get('/api/codex/models')({ query: { providerId: provider.id, ...(poll ? { poll: '1' } : {}) } },
      { set() {}, json(value) { body = value; } });
    return body;
  };
  const immediate = await read(false);
  assert.equal(immediate.models[0].model, 'account-model-1.0.0', '后台更新前先显示已有目录');
  assert.equal(immediate.refreshing, true);
  await runtime.refreshProvider(provider.id); // 合并同一后台任务
  const upgraded = await read(true);
  assert.equal(upgraded.models[0].model, 'account-model-2.0.0');
  assert.equal(upgraded.refreshing, false);
  assert.equal(fs.readFileSync(countFile, 'utf8').trim().split('\n').length, 2);

  fs.writeFileSync(versionFile, '3.0.0');
  const failed = await runtime.refreshProvider(provider.id);
  assert.equal(failed.stale, true);
  assert.equal(failed.models[0].model, 'account-model-2.0.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'multicc_models_catalog.json'), 'utf8')).cliVersion, '2.0.0');
});
