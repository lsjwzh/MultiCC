'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createOfficialCatalog, normalizeOfficialSessionReferences } = require('../src/providers/official-catalog');
const { mountCodexAccountRoutes } = require('../src/routes/codex-accounts');
const { mountClaudeAccountRoutes } = require('../src/routes/claude-accounts');
const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb';
function fixture({ accounts = { claude: [A, B], codex: [A, B] }, loggedOut = [] } = {}) {
  let selection = {};
  const records = ['claude', 'codex'].flatMap(appType => [A, B].map(id => ({
    id: `${appType}-${id}`, appType, name: id,
    settingsConfig: { ...(appType === 'codex' ? { auth: { auth_mode: 'chatgpt' }, config: '' } : { env: {} }), officialAccount: { id } },
  })));
  records.push({ id: 'relay', appType: 'codex', settingsConfig: { auth: { OPENAI_API_KEY: 'test-key' }, config: 'base_url="https://relay.example"' } });
  const listAccounts = type => (accounts[type] || []).map(id => ({ id, label: id === A ? 'work' : '', email: `${id.slice(0, 1)}@example.com`, loggedIn: !loggedOut.includes(id) }));
  const catalog = createOfficialCatalog({ readRecords: () => records, readSelection: () => selection, writeSelection: s => { selection = s; }, listAccounts });
  return { catalog, records };
}
test('terminal routes stay fixed while every signed-in account is its own provider', () => {
  const { catalog, records } = fixture();
  assert.deepEqual(catalog.list().map(p => p.id), ['claude-official', `claude-official-${A}`, `claude-official-${B}`, 'codex-official', `codex-official-${A}`, `codex-official-${B}`, 'relay']);
  assert.deepEqual(catalog.list('claude').map(p => p.name), ['同 Claude 终端', 'Claude 账号 · work', 'Claude 账号 · b@example.com']);
  assert.ok(catalog.list().filter(p => p.builtinOfficial).every(p => p.needsLogin === false));
  for (const type of ['claude', 'codex']) {
    assert.equal(catalog.normalize(type, null), `${type}-official`, 'the alias stays an alias');
    assert.equal(catalog.normalize(type, `${type}-official`), `${type}-official`);
    assert.equal(catalog.normalize(type, `${type}-${A}`), `${type}-official-${A}`, 'legacy record → its account');
    assert.equal(catalog.normalize(type, `${type}-official-${B}`), `${type}-official-${B}`);
    assert.equal(catalog.normalize(type, `${type}-official-cccccccccccccccc`), `${type}-official`, 'deleted account → alias');
    assert.equal(catalog.get(type, `${type}-official`).settingsConfig.officialAccount, undefined, 'terminal route never borrows a managed account');
    assert.equal(catalog.list(type).find(p => p.isDefaultOfficial).id, `${type}-official-${A}`);
    catalog.select(type, B);
    assert.equal(catalog.get(type, `${type}-official`).settingsConfig.officialAccount, undefined);
    assert.equal(catalog.list(type).find(p => p.isDefaultOfficial).id, `${type}-official-${B}`);
    assert.equal(catalog.get(type, `${type}-official-${A}`).settingsConfig.officialAccount.id, A, 'per-account ids never follow the selection');
    assert.equal(catalog.get(type, `${type}-official-cccccccccccccccc`), null);
  }
  assert.equal(records.length, 5, 'legacy records retained for history');
  assert.equal(catalog.get('codex', 'relay'), records[4]);
  assert.equal(catalog.normalize('qoder', null), null);
});
test('terminal routes remain visible and usable even when no managed account is signed in', () => {
  const { catalog } = fixture({ accounts: { claude: [A], codex: [] }, loggedOut: [A] });
  const official = catalog.list().filter(p => p.builtinOfficial);
  assert.deepEqual(official.map(p => [p.id, p.name, p.needsLogin]), [
    ['claude-official', '同 Claude 终端', false],
    ['codex-official', '同 Codex 终端', false],
  ]);
  assert.equal(official[0].settingsConfig.officialAccount, undefined, 'routes through the CLI login');
  catalog.select('claude', A);
  const kept = catalog.get('claude', 'claude-official');
  assert.equal(kept.settingsConfig.officialAccount, undefined);
  assert.equal(kept.name, '同 Claude 终端');
  assert.equal(kept.needsLogin, false);
});
test('saved invalid selection and persistence failure do not silently change accounts', () => {
  const bad = createOfficialCatalog({ readRecords: () => [], readSelection: () => ({ codex: '../invalid' }), writeSelection() {} });
  assert.throws(() => bad.list('codex'), /invalid saved/);
  const catalog = createOfficialCatalog({ readRecords: () => [], readSelection: () => ({ codex: A }), writeSelection() { throw new Error('disk full'); } });
  assert.throws(() => catalog.select('codex', B), /disk full/);
  assert.equal(catalog.active('codex'), A);
});
test('migration covers main, per-CLI, subagent and auto references, preserves login terminal isolation', () => {
  const { catalog } = fixture();
  const session = { cli: 'codex', provider: `codex-${A}`, subagent: { providerId: `codex-${B}` },
    providerSelection: { candidates: [{ providerId: `codex-${A}`, model: 'gpt', enabled: true }, { providerId: `codex-${B}`, model: 'gpt', enabled: true }, { providerId: 'relay', model: 'gpt', enabled: true }] },
    cliStates: { claude: { provider: null }, codex: { provider: `codex-${A}` } } };
  assert.equal(normalizeOfficialSessionReferences(session, catalog.normalize), true);
  assert.equal(session.provider, `codex-official-${A}`);
  assert.equal(session.subagent.providerId, `codex-official-${B}`);
  assert.equal(session.cliStates.claude.provider, 'claude-official');
  assert.deepEqual(session.providerSelection.candidates.map(c => c.providerId), [`codex-official-${A}`, `codex-official-${B}`, 'relay'], 'two accounts stay two failover lines');
  assert.equal(normalizeOfficialSessionReferences(session, catalog.normalize), false);
  const signedOut = fixture({ accounts: { claude: [], codex: [] } }).catalog;
  const onlyOfficial = { cli: 'codex', provider: `codex-${A}`, providerSelection: { mode: 'auto', candidates: [
    { providerId: `codex-${A}`, model: 'gpt', enabled: false },
    { providerId: `codex-${B}`, model: 'gpt', enabled: true },
  ] } };
  normalizeOfficialSessionReferences(onlyOfficial, signedOut.normalize);
  assert.equal(onlyOfficial.providerSelection, null, 'collapsed Auto pool becomes a valid manual route');
  assert.equal(onlyOfficial.provider, 'codex-official');
  assert.equal(onlyOfficial.model, 'gpt');
  const login = { cli: 'codex', provider: null, loginFlow: 'codex-login' };
  assert.equal(normalizeOfficialSessionReferences(login, catalog.normalize), false);
  assert.equal(login.provider, null);
});
for (const vendor of ['codex', 'claude']) test(`${vendor} account activation validates login and every managed account remains deletable`, async () => {
  const { catalog } = fixture({ loggedOut: [B] });
  const handlers = new Map();
  const app = Object.fromEntries(['get', 'post', 'delete'].map(method => [method, (url, fn) => handlers.set(`${method} ${url}`, fn)]));
  let createdProviders = 0, deletedProviders = 0, deletedAccounts = 0;
  const providers = { listProviders: catalog.list, getProvider: catalog.get,
    getOfficialAccountSelection: catalog.active, selectOfficialAccount: catalog.select,
    createProvider() { createdProviders++; }, deleteProvider() { deletedProviders++; } };
  const cap = vendor === 'codex' ? 'Codex' : 'Claude';
  const accounts = { [`list${cap}Accounts`]: () => [{ id: A, loggedIn: true }, { id: B, loggedIn: false }],
    [`create${cap}Account`]: () => ({ id: B }), [`delete${cap}Account`]: () => { deletedAccounts++; }, codexDir: () => '/tmp/account' };
  const deps = { providers, accounts, directories: new Map([['dir', { path: '/tmp' }]]), createSessionRecord: async () => ({ ok: true, id: 'login' }), credentials: { status: () => ({}) }, waitForCallback: () => ({ promise: new Promise(() => {}), cancel() {} }) };
  (vendor === 'codex' ? mountCodexAccountRoutes : mountClaudeAccountRoutes)(app, deps);
  async function call(method, suffix, id) {
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
    await handlers.get(`${method} /api/${vendor}/accounts${suffix}`)({ params: { id }, body: {} }, res);
    return res;
  }
  let res = await call('get', '');
  assert.equal(res.body.accounts[0].id, 'global');
  assert.equal(res.body.accounts[0].active, true);
  assert.equal(res.body.accounts[1].providerId, `${vendor}-official-${A}`, 'each account reports its own provider');
  assert.equal((await call('post', '/:id/activate', B)).statusCode, 409);
  assert.equal((await call('post', '/:id/activate', 'missing')).statusCode, 404);
  assert.equal(catalog.active(vendor), 'global');
  assert.equal((await call('post', '/:id/activate', A)).statusCode, 200);
  assert.equal(catalog.get(vendor, `${vendor}-official`).settingsConfig.officialAccount, undefined);
  assert.equal((await call('delete', '/:id', A)).statusCode, 200);
  assert.equal(catalog.active(vendor), 'global', 'deleting the selected account falls back to the terminal route');
  assert.equal((await call('delete', '/:id', 'global')).statusCode, 409);
  const created = await call('post', '');
  assert.equal(created.body.providerId, `${vendor}-official-${B}`);
  assert.equal(createdProviders, 0);
  assert.equal(catalog.active(vendor), 'global', 'adding an account does not switch away from the terminal route');
  await call('delete', '/:id', B);
  assert.equal(deletedAccounts, 2);
  assert.equal(deletedProviders, 0);
  await call('post', '/:id/activate', 'global');
  assert.equal(catalog.active(vendor), 'global');
});
test('production core initializes from prior default account, persists switches and forces official Claude through proxy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-unified-'));
  try {
    const { records } = fixture();
    fs.writeFileSync(path.join(root, 'providers.json'), JSON.stringify(records));
    fs.writeFileSync(path.join(root, 'provider-defaults.json'), JSON.stringify({ codex: `codex-${A}` }));
    // The official-account store lives under ~/.multicc; a hermetic HOME keeps
    // the host's real signed-in accounts out of the catalog.
    const fakeHome = path.join(root, 'fake-home');
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    const run = (script, extraEnv = {}) => execFileSync(process.execPath, ['-e', `const p=require('./src/providers/core');p.enableUnifiedOfficialProviders();${script}`], { cwd: path.join(__dirname, '..'), env: { ...process.env, MULTICC_DATA_DIR: root, HOME: fakeHome, ...extraEnv }, encoding: 'utf8' }).trim();
    assert.equal(run("process.stdout.write(p.getOfficialAccountSelection('codex'));"), A);
    run(`p.selectOfficialAccount('codex','${B}');`);
    assert.equal(run("process.stdout.write(p.getOfficialAccountSelection('codex'));"), B);
    run(`const a=require('node:assert/strict');a.equal(p.listProviders().filter(x=>x.builtinOfficial).length,2);a.throws(()=>p.deleteProvider('codex','codex-official'));const e={};a.equal(p.applyClaudeProxyEnv(e,{providerId:'claude-official',sessionId:'test',port:9111,enabled:false,officialOAuth:false}),true);a.match(e.ANTHROPIC_BASE_URL,/claude-proxy/);`);
    run(`const a=require('node:assert/strict');const r=require('./src/providers/router-runtime').createProviderRouterRuntime({providers:p,dataRoot:process.env.MULTICC_DATA_DIR,codexHomesDir:process.env.MULTICC_DATA_DIR+'/codex-homes'});a.equal(r.createBinding({id:'chat',cli:'codex',provider:null}).providerId,'codex-official');a.equal(r.createBinding({id:'login',cli:'codex',provider:null,loginFlow:'codex-login'}).providerId,null);`);
    // The codex-official model list comes from the codex CLI's own models cache
    // (~/.codex/models_cache.json); a bare CI runner has none, so seed a hermetic
    // HOME instead of depending on the host's CLI state.
    fs.writeFileSync(path.join(fakeHome, '.codex', 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'gpt-5-codex', visibility: 'list', priority: 1 },
      { slug: 'gpt-5', visibility: 'list', priority: 2 },
      { slug: 'hidden-draft', visibility: 'hide', priority: 0 },
    ] }));
    run(`const a=require('node:assert/strict');const target=p.resolveAuxHttpTarget('openai','codex-official',{port:9111});a.equal(target.available,true);a.equal(target.wireApi,'responses');a.match(target.url,/codex-proxy\\/codex-official\\/responses$/);a.ok(target.modelOptions.length>0);a.equal(target.apiKey,'multicc-aux');a.equal(p.resolveAuxHttpTarget('openai','codex-official').available,false);`, { HOME: fakeHome });
    // Two signed-in Claude accounts in the store → two per-account providers,
    // each routed through the proxy with its own account marker.
    for (const id of [A, B]) {
      fs.mkdirSync(path.join(fakeHome, '.multicc', 'official-accounts', 'claude'), { recursive: true });
      fs.writeFileSync(path.join(fakeHome, '.multicc', 'official-accounts', 'claude', `${id}.json`), JSON.stringify({ label: id === A ? 'work' : 'home', email: `${id.slice(0, 1)}@example.com`, access_token: 'x', refresh_token: 'y', expired: new Date(Date.now() + 3600e3).toISOString() }));
    }
    run(`const a=require('node:assert/strict');const ids=p.listProviders('claude').filter(x=>x.builtinOfficial).map(x=>x.id);a.deepEqual(ids.sort(),['claude-official','claude-official-${A}','claude-official-${B}']);a.equal(p.getProvider('claude','claude-official-${B}').settingsConfig.officialAccount.id,'${B}');a.equal(p.normalizeOfficialProviderId('claude','claude-official'),'claude-official');a.throws(()=>p.deleteProvider('claude','claude-official'));a.equal(p.deleteProvider('claude','claude-official-${A}'),true);const e={};a.equal(p.applyClaudeProxyEnv(e,{providerId:'claude-official-${B}',sessionId:'test',port:9111,enabled:false,officialOAuth:false}),true);a.match(e.ANTHROPIC_BASE_URL,/claude-proxy/);`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'providers.json'))).length, records.length);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
