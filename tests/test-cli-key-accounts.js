'use strict';

// Per-session API-key accounts for Command Code / OpenCode
// (src/cli-key-accounts.js + src/routes/cli-key-accounts.js): the store never
// hands a key back out, the spawn env carries exactly the picked account, a
// vanished pick fails closed instead of falling back to the CLI's own login,
// and session PATCH / fork / account delete keep the picks consistent.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-key-accounts-'));
process.env.MULTICC_DATA_DIR = path.join(tmpRoot, 'data');
process.env.HOME = path.join(tmpRoot, 'home');
fs.mkdirSync(process.env.MULTICC_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });

const {
  OPENCODE_KEY_ENV,
  OPENCODE_ACCOUNT_PROVIDERS,
  createCliKeyAccountStore,
  applyCliKeyAccountEnv,
  mergeCliAccountsPatch,
  retainExistingCliAccounts,
  releaseCliAccountReferences,
} = require('../src/cli-key-accounts');
const { mountCliKeyAccountRoutes } = require('../src/routes/cli-key-accounts');
const { readCommandcodeLogin, mountCommandcodeAuthRoutes } = require('../src/routes/commandcode-auth');
const { createProviderRouterRuntime } = require('../src/providers/router-runtime');
const { REQUIRED_CAPABILITIES } = require('../src/providers/router-port');
const providers = require('../src/providers/core.js');
const { createSessionPolicy } = require('../src/cli/session-policy.js');
const { createSessionProfileRoutes } = require('../src/routes/session-profile.js');

const CC_KEY = 'user_cc_test_key_0000000000000000000001';
const OC_KEY = 'sk-oc-test-key-00000000000000000000000002';

function freshStore() {
  return createCliKeyAccountStore({ root: fs.mkdtempSync(path.join(tmpRoot, 'store-')) });
}

test('官方登录状态只返回身份摘要，区分本地凭据和环境密钥，不泄漏凭据', () => {
  const home = fs.mkdtempSync(path.join(tmpRoot, 'commandcode-home-'));
  const dir = path.join(home, '.commandcode');
  fs.mkdirSync(dir);
  const status = env => readCommandcodeLogin({ home, env });
  assert.deepEqual(status({}), { credentialSaved: false, userName: '', environmentKey: false });
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ apiKey: CC_KEY, userName: '测试用户', extraSecret: OC_KEY }));
  assert.deepEqual(status({}), { credentialSaved: true, userName: '测试用户', environmentKey: false });
  assert.equal(status({ COMMAND_CODE_API_KEY: OC_KEY }).environmentKey, true);
  assert.equal(JSON.stringify(status({})).includes(CC_KEY), false);
  assert.equal(JSON.stringify(status({})).includes(OC_KEY), false);
  assert.equal(status({ COMMANDCODE_API_ENV: 'staging' }).credentialSaved, false);
  fs.writeFileSync(path.join(dir, 'auth.staging.json'), JSON.stringify({ apiKey: OC_KEY, userName: '测试环境' }));
  assert.equal(status({ COMMANDCODE_API_ENV: 'staging' }).userName, '测试环境');
  for (const value of ['{损坏', 'null', '[]', JSON.stringify({ userName: '过期文件' })]) {
    fs.writeFileSync(path.join(dir, 'auth.json'), value);
    assert.deepEqual(status({}), { credentialSaved: false, userName: '', environmentKey: false });
  }
});

test('官方登录接口每次新起登录终端，不接受客户端命令或密钥', async () => {
  const app = fakeApp();
  const created = [];
  const disposed = [];
  mountCommandcodeAuthRoutes(app, {
    directories: new Map([['project', { id: 'project', path: '/project' }]]),
    disposeLoginTerminal: async loginFlow => { disposed.push(loginFlow); return 0; },
    getStatus: () => ({ credentialSaved: true, userName: '测试用户', environmentKey: false }),
    createSessionRecord: async input => { created.push(input); return { ok: true, id: input.id }; },
  });
  const invoke = async (route) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await app.routes.get(route)({ body: { command: '不应执行', apiKey: CC_KEY } }, res);
    return res;
  };
  assert.equal((await invoke('GET /api/commandcode/auth/status')).body.userName, '测试用户');
  const first = await invoke('POST /api/commandcode/auth/login');
  const second = await invoke('POST /api/commandcode/auth/login');
  assert.equal(first.body.sessionId, 'commandcode-login');
  assert.equal(second.body.sessionId, 'commandcode-login');
  // 登录终端是一次性的：每次请求先清掉上一个（连同 tmux 面板）再新建，
  // 不会把上次登录完留下的终端复用给下一次。
  assert.deepEqual(disposed, ['commandcode-login', 'commandcode-login']);
  assert.equal(created.length, 2);
  assert.equal(created[0].loginFlow, 'commandcode-login');
  assert.equal(created[0].kind, 'terminal');
  assert.equal(created[0].provider, null);
  assert.equal(JSON.stringify(created).includes(CC_KEY), false);
});

test('官方登录接口对缺少目录和创建失败返回中文错误，不暴露内部异常', async () => {
  for (const scenario of ['no-dir', 'failed', 'throws']) {
    const app = fakeApp();
    mountCommandcodeAuthRoutes(app, {
      directories: new Map(scenario === 'no-dir' ? [] : [['p', { path: '/project' }]]),
      createSessionRecord: async () => { if (scenario === 'throws') throw new Error(CC_KEY); return { ok: false, error: CC_KEY }; },
    });
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await app.routes.get('POST /api/commandcode/auth/login')({}, res);
    assert.equal(res.statusCode, scenario === 'no-dir' ? 409 : 500);
    assert.equal(JSON.stringify(res.body).includes(CC_KEY), false);
  }
});

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

// ── store ────────────────────────────────────────────────────────────────────

test('store keeps keys private: 0600 files, list/get expose only a tail hint', () => {
  const store = freshStore();
  const account = store.create('commandcode', { label: ' 工作号\u0007 ', apiKey: `  ${CC_KEY}  ` });
  assert.match(account.id, /^[a-f0-9]{16}$/);
  assert.equal(account.label, '工作号');
  assert.equal(account.keyHint, `…${CC_KEY.slice(-4)}`);
  assert.equal(JSON.stringify(store.list('commandcode')).includes(CC_KEY), false, 'list must not leak the key');
  assert.equal(JSON.stringify(store.get('commandcode', account.id)).includes(CC_KEY), false, 'get must not leak the key');
  assert.equal(store.readKey('commandcode', account.id), CC_KEY, 'readKey trims and returns the stored key');

  const file = path.join(store.root, 'commandcode', `${account.id}.json`);
  assert.equal(mode(file), 0o600);
  assert.equal(mode(path.dirname(file)), 0o700);
  assert.deepEqual(store.list('opencode'), [], 'lanes are separate');
  assert.equal(store.has('opencode', account.id), false);
});

test('store validates lane, key shape and id; update re-keys and renames; remove deletes', () => {
  const store = freshStore();
  assert.throws(() => store.create('claude', { apiKey: CC_KEY }), error => error.code === 'CLI_KEY_ACCOUNT_CLI_UNSUPPORTED');
  assert.throws(() => store.list('codex'), error => error.code === 'CLI_KEY_ACCOUNT_CLI_UNSUPPORTED');
  assert.throws(() => store.create('opencode', { apiKey: 'short' }), error => error.code === 'CLI_KEY_ACCOUNT_INVALID');
  assert.throws(() => store.create('opencode', { apiKey: 'has a space inside it' }), error => error.code === 'CLI_KEY_ACCOUNT_INVALID');
  assert.equal(store.get('opencode', '../../etc/passwd'), null);
  assert.equal(store.readKey('opencode', 'not-an-id'), null);
  assert.throws(() => store.remove('opencode', '../x'), error => error.code === 'CLI_KEY_ACCOUNT_ID_INVALID');

  const account = store.create('opencode', { label: 'A', apiKey: OC_KEY });
  const renamed = store.update('opencode', account.id, { label: 'B', apiKey: '' });
  assert.equal(renamed.label, 'B');
  assert.equal(store.readKey('opencode', account.id), OC_KEY, 'an empty apiKey keeps the existing key');
  store.update('opencode', account.id, { apiKey: CC_KEY });
  assert.equal(store.readKey('opencode', account.id), CC_KEY);
  assert.equal(store.update('opencode', 'ffffffffffffffff', { label: 'x' }), null);
  assert.equal(store.remove('opencode', account.id), true);
  assert.equal(store.remove('opencode', account.id), false);
  assert.deepEqual(store.list('opencode'), []);
});

// ── spawn env ────────────────────────────────────────────────────────────────

test('commandcode pick sets COMMAND_CODE_API_KEY on a copy; no pick returns the env untouched', () => {
  const store = freshStore();
  const account = store.create('commandcode', { apiKey: CC_KEY });
  const base = { PATH: '/bin', COMMAND_CODE_API_KEY: 'inherited-from-server' };
  const session = { cli: 'commandcode', cliAccounts: { commandcode: account.id } };
  const env = applyCliKeyAccountEnv(base, session, store);
  assert.equal(env.COMMAND_CODE_API_KEY, CC_KEY, 'the pick outranks an inherited key');
  assert.equal(base.COMMAND_CODE_API_KEY, 'inherited-from-server', 'input env is not mutated');
  assert.equal(env.PATH, '/bin');

  assert.equal(applyCliKeyAccountEnv(base, { cli: 'commandcode' }, store), base);
  assert.equal(applyCliKeyAccountEnv(base, { cli: 'claude', cliAccounts: { commandcode: account.id } }, store), base,
    'a non key-account lane is never touched');
  assert.equal(applyCliKeyAccountEnv(base, { cli: 'opencode', cliAccounts: { commandcode: account.id } }, store), base,
    'a pick only applies to its own lane');
});

test('opencode pick merges the key reference into every opencode.ai line, keeping managed/MCP config', () => {
  const store = freshStore();
  const account = store.create('opencode', { apiKey: OC_KEY });
  const existing = {
    enabled_providers: ['multicc-p1'],
    provider: {
      'multicc-p1': { npm: '@ai-sdk/openai', options: { baseURL: 'https://example.test/v1', apiKey: 'managed' } },
      opencodego: { options: { baseURL: 'https://opencode.ai/zen/go/v1', setCacheKey: true } },
    },
    mcp: { multicc_router: { type: 'local', command: ['node', 'x.js'] } },
  };
  const env = applyCliKeyAccountEnv({ OPENCODE_CONFIG_CONTENT: JSON.stringify(existing) },
    { cli: 'opencode', cliAccounts: { opencode: account.id } }, store);
  assert.equal(env[OPENCODE_KEY_ENV], OC_KEY);
  assert.equal(env.OPENCODE_CONFIG_CONTENT.includes(OC_KEY), false, 'the config names the env var, never the key');
  const merged = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  for (const id of OPENCODE_ACCOUNT_PROVIDERS) {
    assert.equal(merged.provider[id].options.apiKey, `{env:${OPENCODE_KEY_ENV}}`, id);
  }
  assert.equal(merged.provider.opencodego.options.baseURL, 'https://opencode.ai/zen/go/v1');
  assert.equal(merged.provider.opencodego.options.setCacheKey, true);
  assert.deepEqual(merged.provider['multicc-p1'], existing.provider['multicc-p1'], 'managed route untouched');
  assert.deepEqual(merged.enabled_providers, ['multicc-p1']);
  assert.deepEqual(merged.mcp, existing.mcp);

  const fromNothing = JSON.parse(applyCliKeyAccountEnv({}, { cli: 'opencode', cliAccounts: { opencode: account.id } }, store)
    .OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(Object.keys(fromNothing.provider).sort(), [...OPENCODE_ACCOUNT_PROVIDERS].sort());
});

test('a pick whose account is gone fails closed instead of spawning on the CLI login', () => {
  const store = freshStore();
  for (const [cli, cliAccounts] of [
    ['commandcode', { commandcode: 'ffffffffffffffff' }],
    ['opencode', { opencode: 'not-a-valid-id' }],
  ]) {
    assert.throws(() => applyCliKeyAccountEnv({}, { cli, cliAccounts }, store),
      error => error.code === 'CLI_KEY_ACCOUNT_MISSING' && /重新选择账户/.test(error.message), cli);
  }
});

// ── session pick helpers ─────────────────────────────────────────────────────

test('PATCH merge sets, clears and rejects picks per lane', () => {
  const store = freshStore();
  const cc = store.create('commandcode', { apiKey: CC_KEY });
  const oc = store.create('opencode', { apiKey: OC_KEY });
  assert.deepEqual(mergeCliAccountsPatch(null, { commandcode: cc.id }, store), { ok: true, value: { commandcode: cc.id } });
  assert.deepEqual(mergeCliAccountsPatch({ commandcode: cc.id }, { opencode: oc.id }, store),
    { ok: true, value: { commandcode: cc.id, opencode: oc.id } });
  assert.deepEqual(mergeCliAccountsPatch({ commandcode: cc.id, opencode: oc.id }, { opencode: null }, store),
    { ok: true, value: { commandcode: cc.id } });
  assert.deepEqual(mergeCliAccountsPatch({ commandcode: cc.id }, { commandcode: '' }, store), { ok: true, value: null });
  assert.deepEqual(mergeCliAccountsPatch({ commandcode: cc.id }, null, store), { ok: true, value: null });
  assert.equal(mergeCliAccountsPatch(null, { claude: cc.id }, store).ok, false);
  assert.equal(mergeCliAccountsPatch(null, { opencode: cc.id }, store).ok, false, 'an id from another lane is rejected');
  assert.equal(mergeCliAccountsPatch(null, ['x'], store).ok, false);
});

test('retain keeps only live picks; release drops one account from every session', () => {
  const store = freshStore();
  const cc = store.create('commandcode', { apiKey: CC_KEY });
  assert.deepEqual(retainExistingCliAccounts({ commandcode: cc.id, opencode: 'ffffffffffffffff', claude: cc.id }, store),
    { commandcode: cc.id });
  assert.equal(retainExistingCliAccounts({ opencode: 'ffffffffffffffff' }, store), null);

  const records = new Map([
    ['a', { id: 'a', cliAccounts: { commandcode: cc.id } }],
    ['b', { id: 'b', cliAccounts: { commandcode: cc.id, opencode: 'eeeeeeeeeeeeeeee' } }],
    ['c', { id: 'c', cliAccounts: { commandcode: 'dddddddddddddddd' } }],
    ['d', { id: 'd' }],
  ]);
  assert.equal(releaseCliAccountReferences(records, 'commandcode', cc.id), 2);
  assert.equal('cliAccounts' in records.get('a'), false);
  assert.deepEqual(records.get('b').cliAccounts, { opencode: 'eeeeeeeeeeeeeeee' });
  assert.deepEqual(records.get('c').cliAccounts, { commandcode: 'dddddddddddddddd' });
});

// ── router runtime: both launch paths, every mode ────────────────────────────

function fakeProviders() {
  return {
    CODEX_HOMES_DIR: '/multicc/codex-homes',
    getProvider: () => null,
    getProviderSummary: () => null,
    resolveSpawnEnv: () => ({ env: { FROM: 'route' }, providerName: null, providerModel: null, providerModels: [],
      skipDefaultModel: false, aliasOnly: false }),
    buildChildEnv: (base, _binding, extra) => ({ env: { ...base, ...extra, FROM: 'route' }, skipDefaultModel: false }),
    resolveSessionWireModel: model => model,
  };
}

function fakeRouter() {
  return {
    API_VERSION: '1.2.0',
    CAPABILITIES: Object.fromEntries(Object.keys(REQUIRED_CAPABILITIES).map(name => [name, '1.0.0'])),
    resolveSpawnEnv: () => ({ env: { FROM: 'cpr' }, providerName: null, providerModel: null, providerModels: [],
      skipDefaultModel: false, aliasOnly: false }),
    buildChildEnv: (base, _input, extra) => ({ env: { ...base, ...extra, FROM: 'cpr' } }),
    resolveSessionWireModel: model => model,
    getProviderSummary: () => null,
    getProvider: () => null,
    normalizeUsageEvent: input => input,
    mountClaudeProxy: () => null,
    mountCodexProxy: () => null,
  };
}

test('router runtime layers the pick onto chat (buildChildEnv) and terminal (resolveSpawnEnv) envs in every mode', () => {
  const store = freshStore();
  const cc = store.create('commandcode', { apiKey: CC_KEY });
  const session = { id: 's1', cli: 'commandcode', provider: null, cliAccounts: { commandcode: cc.id } };
  for (const runtimeMode of ['legacy', 'cpr', 'shadow']) {
    const runtime = createProviderRouterRuntime({
      mode: runtimeMode, providers: fakeProviders(), router: fakeRouter(), keyAccounts: store,
      env: { MULTICC_CPR_BACKEND: 'node' },
      dataRoot: '/multicc/data', codexHomesDir: '/multicc/codex-homes',
    });
    const child = runtime.buildChildEnv({ PATH: '/bin' }, session, { TERM: 'dumb' });
    assert.equal(child.env.COMMAND_CODE_API_KEY, CC_KEY, `${runtimeMode} chat child`);
    assert.equal(child.env.TERM, 'dumb');
    assert.equal(child.skipDefaultModel === undefined || child.skipDefaultModel === false, true);
    assert.equal(runtime.resolveSpawnEnv(session).env.COMMAND_CODE_API_KEY, CC_KEY, `${runtimeMode} terminal`);
    const plain = runtime.buildChildEnv({ PATH: '/bin' }, { id: 's2', cli: 'commandcode' }, {});
    assert.equal('COMMAND_CODE_API_KEY' in plain.env, false, `${runtimeMode} no pick → CLI login`);
  }
  const unwired = createProviderRouterRuntime({
    providers: fakeProviders(), router: fakeRouter(), dataRoot: '/multicc/data', codexHomesDir: '/multicc/codex-homes',
    env: { MULTICC_CPR_BACKEND: 'node' },
  });
  assert.throws(() => unwired.buildChildEnv({}, session, {}), error => error.code === 'CLI_KEY_ACCOUNT_MISSING',
    'a runtime without a store still refuses to spawn a picked account on the CLI login');
});

// ── account routes ───────────────────────────────────────────────────────────

function fakeApp() {
  const routes = new Map();
  const register = method => (route, handler) => routes.set(`${method} ${route}`, handler);
  return { routes, get: register('GET'), post: register('POST'), patch: register('PATCH'), delete: register('DELETE') };
}

function call(app, key, { params = {}, body } = {}) {
  const response = { statusCode: 200, body: undefined };
  const res = {
    status(code) { response.statusCode = code; return this; },
    json(value) { response.body = value; return this; },
  };
  app.routes.get(key)({ params, body }, res);
  return response;
}

test('account routes add, list, re-key and delete without ever returning a key', () => {
  const store = freshStore();
  const records = new Map([['s1', { id: 's1', cli: 'opencode', cliAccounts: {} }]]);
  const mutations = [];
  const app = fakeApp();
  mountCliKeyAccountRoutes(app, {
    store,
    sessionPersistence: { mutate: (source, fn) => { mutations.push(source); return fn(records); } },
  });

  assert.equal(call(app, 'GET /api/cli-accounts/:cli', { params: { cli: 'claude' } }).statusCode, 404);
  const bad = call(app, 'POST /api/cli-accounts/:cli', { params: { cli: 'opencode' }, body: { apiKey: 'x' } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body.error, /API Key/);

  const created = call(app, 'POST /api/cli-accounts/:cli', { params: { cli: 'opencode' }, body: { label: '个人', apiKey: OC_KEY } });
  assert.equal(created.statusCode, 201);
  const id = created.body.account.id;
  records.get('s1').cliAccounts = { opencode: id };
  const listed = call(app, 'GET /api/cli-accounts/:cli', { params: { cli: 'opencode' } });
  assert.deepEqual(listed.body.accounts.map(a => a.label), ['个人']);
  for (const response of [created, listed]) assert.equal(JSON.stringify(response.body).includes(OC_KEY), false);

  const rekeyed = call(app, 'PATCH /api/cli-accounts/:cli/:id', { params: { cli: 'opencode', id }, body: { apiKey: CC_KEY } });
  assert.equal(rekeyed.statusCode, 200);
  assert.equal(JSON.stringify(rekeyed.body).includes(CC_KEY), false);
  assert.equal(store.readKey('opencode', id), CC_KEY);
  assert.equal(call(app, 'PATCH /api/cli-accounts/:cli/:id', { params: { cli: 'opencode', id: 'ffffffffffffffff' }, body: {} }).statusCode, 404);

  const removed = call(app, 'DELETE /api/cli-accounts/:cli/:id', { params: { cli: 'opencode', id } });
  assert.deepEqual(removed.body, { ok: true, releasedSessions: 1 });
  assert.deepEqual(mutations, ['http.cli-account-delete']);
  assert.equal('cliAccounts' in records.get('s1'), false, 'the session falls back to the CLI login');
  assert.equal(store.has('opencode', id), false);
  assert.equal(call(app, 'DELETE /api/cli-accounts/:cli/:id', { params: { cli: 'opencode', id } }).statusCode, 404);
});

// ── session PATCH + fork ─────────────────────────────────────────────────────

function profileFixture(session, store, { createSessionRecord = async () => ({ ok: false, error: 'unused' }), chatState = null } = {}) {
  const persistedSessions = new Map([['s1', session]]);
  const providerRouterRuntime = { getProviderSummary: () => null };
  const sessionPolicy = createSessionPolicy({
    providerRouter: providerRouterRuntime,
    providers: { appTypeForCli: providers.appTypeForCli },
    env: {},
    homeDir: () => process.env.HOME,
  });
  const app = fakeApp();
  createSessionProfileRoutes({
    persistedSessions,
    directories: new Map([['d1', { id: 'd1', path: '/tmp/d1' }]]),
    sessionPersistence: { begin: () => ({ commit() {}, rollback() {} }), mutate: (_reason, fn) => fn() },
    sessionPolicy,
    providers: {
      appTypeForCli: providers.appTypeForCli,
      modelValidForProvider: providers.modelValidForProvider,
      codexProviderProxyable: providers.codexProviderProxyable,
      synchronizeCodexSessionRoute: () => ({ synchronized: false }),
      CODEX_HOMES_DIR: providers.CODEX_HOMES_DIR,
    },
    providerRouterRuntime,
    cliKeyAccounts: store,
    getChatStream: () => ({ close() {} }),
    getChatState: () => chatState,
    hasLiveBackgroundTasks: () => false,
    validProviderId: (_cli, id) => ({ ok: true, value: id || null }),
    asyncHandler: handler => handler,
    appendEvent: () => {},
    workspaceBroadcast: () => {},
    chatBroadcast: () => {},
    getTaskState: () => null,
    rememberActiveCliState: () => {},
    buildHandoffCheckpoint: () => ({ createdAt: 0 }),
    cliStateSummary: () => ({}),
    cliAvailabilitySummary: () => ({}),
    cliHandoffSummary: () => null,
    createSessionRecord,
    loadChatHistory: () => [{ id: 'm0', role: 'assistant', content: 'hi' }],
    newChatMsgId: () => 'm1',
    getChatHistoryService: () => ({ replace() {} }),
    getFolderMemory: () => ({ sessionDir: () => path.join(tmpRoot, 'mem') }),
    getCliSwitchGitSnapshot: () => async () => ({}),
  }).mountRoutes(app);
  return app;
}

test('session PATCH stores per-lane picks, rejects unknown accounts, and applies even while busy', () => {
  const store = freshStore();
  const cc = store.create('commandcode', { apiKey: CC_KEY });
  const session = { id: 's1', dirId: 'd1', cli: 'commandcode', kind: 'chat' };
  const app = profileFixture(session, store);
  const patch = body => call(app, 'PATCH /api/sessions/:id', { params: { id: 's1' }, body });

  const ok = patch({ cliAccounts: { commandcode: cc.id } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(session.cliAccounts, { commandcode: cc.id });
  assert.deepEqual(ok.body.cliAccounts, { commandcode: cc.id });

  const rejected = patch({ cliAccounts: { commandcode: 'ffffffffffffffff' }, label: 'renamed' });
  assert.equal(rejected.statusCode, 400);
  assert.deepEqual(session.cliAccounts, { commandcode: cc.id }, 'a rejected PATCH leaves the pick alone');

  assert.equal(patch({ cliAccounts: { commandcode: null } }).statusCode, 200);
  assert.equal('cliAccounts' in session, false);

  // A running turn stages route fields for the next turn; the account pick rides
  // along and is written right away (it is only read at the next spawn).
  const busySession = { id: 's1', dirId: 'd1', cli: 'commandcode', kind: 'chat' };
  const busyApp = profileFixture(busySession, store, { chatState: { isStreaming: true } });
  const staged = call(busyApp, 'PATCH /api/sessions/:id', { params: { id: 's1' },
    body: { model: 'deepseek/deepseek-v4-flash', cliAccounts: { commandcode: cc.id } } });
  assert.equal(staged.statusCode, 200);
  assert.equal(staged.body.deferred, true);
  assert.deepEqual(busySession.cliAccounts, { commandcode: cc.id });
  assert.equal(busySession.model, undefined, 'the route field itself waits for the next turn');
});

test('fork carries the live account picks and drops vanished ones', async () => {
  const store = freshStore();
  const cc = store.create('commandcode', { apiKey: CC_KEY });
  const attempts = [];
  const source = { id: 's1', dirId: 'd1', cli: 'commandcode', kind: 'chat',
    cliAccounts: { commandcode: cc.id, opencode: 'ffffffffffffffff' } };
  const app = profileFixture(source, store, {
    createSessionRecord: async input => { attempts.push(input); return { ok: true, id: 'new', session: { ...input, id: 'new' } }; },
  });
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await app.routes.get('POST /api/sessions/:id/fork')({ params: { id: 's1' }, body: { atMessageId: 'm0', includeMemory: false } }, response);
  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  assert.deepEqual(attempts[0].cliAccounts, { commandcode: cc.id });
});
