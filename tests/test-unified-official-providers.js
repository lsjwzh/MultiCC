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
function fixture() {
  let selection = {};
  const records = ['claude', 'codex'].flatMap(appType => [A, B].map(id => ({
    id: `${appType}-${id}`, appType, name: id,
    settingsConfig: { ...(appType === 'codex' ? { auth: { auth_mode: 'chatgpt' }, config: '' } : { env: {} }), officialAccount: { id } },
  })));
  records.push({ id: 'relay', appType: 'codex', settingsConfig: { auth: { OPENAI_API_KEY: 'test-key' }, config: 'base_url="https://relay.example"' } });
  const catalog = createOfficialCatalog({ readRecords: () => records, readSelection: () => selection, writeSelection: s => { selection = s; } });
  return { catalog, records };
}
test('one official identity per vendor; aliases and defaults follow a durable independent account selection', () => {
  const { catalog, records } = fixture();
  assert.deepEqual(catalog.list().map(p => p.id), ['claude-official', 'codex-official', 'relay']);
  for (const type of ['claude', 'codex']) {
    assert.equal(catalog.normalize(type, null), `${type}-official`);
    assert.equal(catalog.normalize(type, `${type}-${A}`), `${type}-official`);
    catalog.select(type, A);
    const started = catalog.get(type, `${type}-official`);
    catalog.select(type, B);
    assert.equal(started.settingsConfig.officialAccount.id, A);
    assert.equal(catalog.get(type, `${type}-official`).settingsConfig.officialAccount.id, B);
    assert.equal(catalog.get(type, `${type}-${A}`).settingsConfig.officialAccount.id, B);
    catalog.select(type, 'global');
    assert.equal(catalog.get(type, `${type}-official`).settingsConfig.officialAccount, undefined);
  }
  assert.equal(records.length, 5, 'legacy records retained for history');
  assert.equal(catalog.get('codex', 'relay'), records[4]);
  assert.equal(catalog.normalize('qoder', null), null);
});
test('saved invalid selection and persistence failure do not silently change accounts', () => {
  const bad = createOfficialCatalog({ readRecords: () => [], readSelection: () => ({ codex: '../invalid' }), writeSelection() {} });
  assert.throws(() => bad.get('codex', 'codex-official'), /invalid saved/);
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
  assert.equal(session.provider, 'codex-official');
  assert.equal(session.subagent.providerId, 'codex-official');
  assert.equal(session.cliStates.claude.provider, 'claude-official');
  assert.deepEqual(session.providerSelection.candidates.map(c => c.providerId), ['codex-official', 'relay']);
  assert.equal(normalizeOfficialSessionReferences(session, catalog.normalize), false);
  const onlyOfficial = { cli: 'codex', provider: `codex-${A}`, providerSelection: { mode: 'auto', candidates: [
    { providerId: `codex-${A}`, model: 'gpt', enabled: false },
    { providerId: `codex-${B}`, model: 'gpt', enabled: true },
  ] } };
  normalizeOfficialSessionReferences(onlyOfficial, catalog.normalize);
  assert.equal(onlyOfficial.providerSelection, null, 'collapsed Auto pool becomes a valid manual route');
  assert.equal(onlyOfficial.provider, 'codex-official');
  assert.equal(onlyOfficial.model, 'gpt');
  const login = { cli: 'codex', provider: null, loginFlow: 'codex-login' };
  assert.equal(normalizeOfficialSessionReferences(login, catalog.normalize), false);
  assert.equal(login.provider, null);
});
for (const vendor of ['codex', 'claude']) test(`${vendor} account activation validates login, changes singleton and protects current account deletion`, async () => {
  const { catalog } = fixture();
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
  assert.equal((await call('post', '/:id/activate', B)).statusCode, 409);
  assert.equal((await call('post', '/:id/activate', 'missing')).statusCode, 404);
  assert.equal(catalog.active(vendor), 'global');
  assert.equal((await call('post', '/:id/activate', A)).statusCode, 200);
  assert.equal(catalog.get(vendor, `${vendor}-official`).settingsConfig.officialAccount.id, A);
  assert.equal((await call('delete', '/:id', A)).statusCode, 409);
  assert.equal((await call('delete', '/:id', 'global')).statusCode, 409);
  await call('post', '');
  assert.equal(createdProviders, 0);
  assert.equal(catalog.active(vendor), A, 'adding an account does not switch the current account');
  await call('delete', '/:id', B);
  assert.equal(deletedAccounts, 1);
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
    const run = script => execFileSync(process.execPath, ['-e', `const p=require('./src/providers/core');p.enableUnifiedOfficialProviders();${script}`], { cwd: path.join(__dirname, '..'), env: { ...process.env, MULTICC_DATA_DIR: root }, encoding: 'utf8' }).trim();
    assert.equal(run("process.stdout.write(p.getOfficialAccountSelection('codex'));"), A);
    run(`p.selectOfficialAccount('codex','${B}');`);
    assert.equal(run("process.stdout.write(p.getOfficialAccountSelection('codex'));"), B);
    run(`const a=require('node:assert/strict');a.equal(p.listProviders().filter(x=>x.builtinOfficial).length,2);a.throws(()=>p.deleteProvider('codex','codex-official'));const e={};a.equal(p.applyClaudeProxyEnv(e,{providerId:'claude-official',sessionId:'test',port:9111,enabled:false,officialOAuth:false}),true);a.match(e.ANTHROPIC_BASE_URL,/claude-proxy/);`);
    run(`const a=require('node:assert/strict');const r=require('./src/providers/router-runtime').createProviderRouterRuntime({providers:p,dataRoot:process.env.MULTICC_DATA_DIR,codexHomesDir:process.env.MULTICC_DATA_DIR+'/codex-homes'});a.equal(r.createBinding({id:'chat',cli:'codex',provider:null}).providerId,'codex-official');a.equal(r.createBinding({id:'login',cli:'codex',provider:null,loginFlow:'codex-login'}).providerId,null);`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'providers.json'))).length, records.length);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
