'use strict';
// 子任务默认线路（每个 CLI 家族一条 `{providerId, model}`）+ 一键同步到同家族会话。
//
// 覆盖三层：
//   1. Rust 计划经 Node 迁移桥（src/routes/subagent-defaults.js）的契约形状与语义：
//      dry run / apply / clear / codex skip / patch_rejected / unchanged / 排除系统会话；
//   2. 与 providers.js 的接线：provider-defaults.json 的落盘、GET /api/providers
//      的 defaults.subagent、PUT /api/provider-defaults 保留该键、加载时归一化/透传、
//      save_failed 时一个会话都不许动；
//   3. createSessionRecord 的缺省应用：省略 → 默认；显式 null/''/{} → 不要；
//      默认失效（provider 被删、codex 没有主线）→ 静默无子任务，绝不阻断创建。
const test = require('node:test');
const assert = require('node:assert/strict');

// 宿主进程可能带着 MULTICC_RUST_ADDON 指向一个没有本模块的旧 addon；测试显式指定的
// 预编译目录优先，否则这里永远只看到旧模块。
if (process.env.MULTICC_RUST_PREBUILT_DIR) delete process.env.MULTICC_RUST_ADDON;

const nativeRuntime = require('../src/native/runtime');
const addon = nativeRuntime.getNative('subagent_defaults',
  process.env.MULTICC_REQUIRE_RUST_TESTS === '1' ? 'rust' : 'auto');
const available = typeof addon?.normalizeSubagentDefaults === 'function'
  && typeof addon?.planSubagentSync === 'function';
if (process.env.MULTICC_REQUIRE_RUST_TESTS === '1') {
  assert.equal(available, true, '必须构建包含子任务默认线路的 Rust 模块');
}
const rustTest = (name, fn) => test(name, { skip: !available && '未构建可选 Rust 模块' }, fn);

const { mountSubagentDefaultsRoutes } = require('../src/routes/subagent-defaults');
const { createProviderRoutes } = require('../src/routes/providers');
const { createSessionRecordFactory } = require('../src/session/create-record');
const { isResidentSession } = require('../src/cli/cli-capability');
const { withSubagentSource } = require('../src/session/subagent');

const CLAUDE_ROUTE = Object.freeze({ providerId: 'sub-claude', model: 'claude-haiku-4-5' });
const CODEX_ROUTE = Object.freeze({ providerId: 'sub-codex', model: 'gpt-5-codex' });
// 来自全局默认的线路带 inherited；不带的是任务自己单独设置的。
const inherited = route => ({ ...route, inherited: true });
const SENSITIVE = '/Users/alice/private token=abc';

function createApp() {
  const routes = new Map();
  const app = { routes };
  for (const method of ['get', 'post', 'patch', 'delete', 'put']) {
    app[method] = (routePath, handler) => routes.set(`${method.toUpperCase()} ${routePath}`, handler);
  }
  return app;
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function invoke(app, method, routePath, request = {}) {
  const handler = app.routes.get(`${method.toUpperCase()} ${routePath}`);
  assert.equal(typeof handler, 'function', `missing route ${method} ${routePath}`);
  const response = createResponse();
  await handler({ body: {}, query: {}, params: {}, ...request }, response);
  return response;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ────────────────────────── 迁移桥（纯契约） ──────────────────────────
function bridgeHarness(options = {}) {
  const app = createApp();
  const sessions = new Map();
  for (const session of options.sessions || []) sessions.set(session.id, session);
  const writes = [];
  const applied = [];
  const previewed = [];
  const rejected = new Set(options.rejected || []);
  const throwing = new Set(options.throwing || []);
  const deferred = new Set(options.deferred || []);
  const validIds = new Set(options.validIds || ['sub-claude', 'sub-codex', 'main']);
  const proxyable = new Set(options.proxyable || ['sub-codex']);
  const officials = new Set(options.officials || []);
  const providerDefaults = options.defaults ? clone(options.defaults) : {};
  const providers = {
    getProvider(appType, id) {
      if (appType !== 'codex') return null;
      return { id, appType };
    },
    codexProviderProxyable: id => proxyable.has(id),
    isOfficialCodexOAuthProvider: provider => officials.has(provider?.id),
  };
  mountSubagentDefaultsRoutes(app, {
    providerDefaults,
    sessions,
    validProviderId: (cli, id) => (validIds.has(id) ? { ok: true, value: id } : { ok: false }),
    providers,
    applySessionPatch(sessionId, body) {
      applied.push({ sessionId, body: clone(body) });
      const session = sessions.get(sessionId);
      if (!session) return { status: 404, body: { error: 'session not found' } };
      if (throwing.has(sessionId)) throw new Error(SENSITIVE);
      if (rejected.has(sessionId)) return { status: 400, body: { error: SENSITIVE } };
      if (deferred.has(sessionId)) return { status: 200, body: { deferred: true } };
      if (body.subagent) {
        session.subagent = withSubagentSource(clone(body.subagent), session.subagent, body.subagentInherited === true);
      } else delete session.subagent;
      return { status: 200, body: { subagent: clone(body.subagent) } };
    },
    previewSessionPatch(sessionId, body) {
      previewed.push({ sessionId, body: clone(body) });
      if (!sessions.has(sessionId)) return { status: 404, body: { error: 'session not found' } };
      if (rejected.has(sessionId)) return { status: 400, body: { error: SENSITIVE } };
      return { status: 200, body: { subagent: clone(body.subagent) } };
    },
    persistDefaults(next) { writes.push(clone(next)); },
    getNative: options.getNative || (() => addon),
  });
  return { app, providerDefaults, sessions, writes, applied, previewed };
}

function claudeSession(id, extra = {}) {
  return {
    id, dirId: 'd1', cli: 'claude', kind: 'chat', label: id, provider: 'main',
    ...extra,
  };
}

rustTest('dry run plans without writing defaults or sessions', async () => {
  const harness = bridgeHarness({
    sessions: [
      claudeSession('apply-me'),
      claudeSession('same', { subagent: inherited(CLAUDE_ROUTE) }),
      claudeSession('pending', { pendingConfiguration: { cli: 'claude', profile: { subagent: null } } }),
      claudeSession('own', { subagent: clone(CLAUDE_ROUTE) }),
    ],
  });
  const response = await invoke(harness.app, 'POST', '/api/subagent-defaults/sync', {
    body: { cli: 'claude', subagent: clone(CLAUDE_ROUTE), dryRun: true },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    dryRun: true,
    family: 'claude',
    subagent: CLAUDE_ROUTE,
    defaults: { claude: CLAUDE_ROUTE, codex: null },
    counts: { applied: 1, deferred: 1, unchanged: 1, skipped: 0, kept: 1 },
    sessions: [
      { sessionId: 'apply-me', sessionName: 'apply-me', cli: 'claude', outcome: 'applied' },
      { sessionId: 'pending', sessionName: 'pending', cli: 'claude', outcome: 'deferred' },
      { sessionId: 'same', sessionName: 'same', cli: 'claude', outcome: 'unchanged' },
      { sessionId: 'own', sessionName: 'own', cli: 'claude', outcome: 'kept' },
    ],
    truncated: false,
  });
  assert.deepEqual(harness.writes, [], 'dry run must not persist defaults');
  assert.deepEqual(harness.applied, [], 'dry run must never apply a patch');
  assert.deepEqual(harness.previewed.map(entry => entry.sessionId), ['apply-me', 'pending']);
  assert.equal(harness.sessions.get('apply-me').subagent, undefined);
  assert.equal(harness.providerDefaults.subagent, undefined);
});

rustTest('apply persists defaults first and moves only sessions without an own route', async () => {
  const harness = bridgeHarness({
    sessions: [
      claudeSession('apply-me'),
      claudeSession('same', { subagent: inherited(CLAUDE_ROUTE) }),
      claudeSession('busy', { provider: 'main', pendingConfiguration: { cli: 'claude', profile: {} } }),
      claudeSession('old-global', { subagent: inherited({ providerId: 'main', model: 'old-model' }) }),
      claudeSession('own', { subagent: { providerId: 'main', model: 'own-model' } }),
    ],
    deferred: ['busy'],
  });
  const response = await invoke(harness.app, 'POST', '/api/subagent-defaults/sync', {
    body: { cli: 'claude', subagent: clone(CLAUDE_ROUTE) },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.dryRun, false);
  assert.deepEqual(response.body.counts, { applied: 2, deferred: 1, unchanged: 1, skipped: 0, kept: 1 });
  assert.deepEqual(response.body.sessions.map(entry => [entry.sessionId, entry.outcome]), [
    ['apply-me', 'applied'], ['old-global', 'applied'], ['busy', 'deferred'], ['same', 'unchanged'], ['own', 'kept'],
  ]);
  assert.deepEqual(harness.writes, [{ subagent: { claude: CLAUDE_ROUTE, codex: null } }]);
  assert.deepEqual(harness.providerDefaults.subagent, { claude: CLAUDE_ROUTE, codex: null });
  assert.deepEqual(harness.sessions.get('apply-me').subagent, inherited(CLAUDE_ROUTE));
  assert.deepEqual(harness.sessions.get('old-global').subagent, inherited(CLAUDE_ROUTE));
  assert.deepEqual(harness.sessions.get('own').subagent, { providerId: 'main', model: 'own-model' });
  assert.deepEqual(harness.applied.map(entry => entry.sessionId), ['apply-me', 'busy', 'old-global']);
  for (const entry of harness.applied) {
    assert.deepEqual(entry.body, { subagent: CLAUDE_ROUTE, subagentInherited: true });
  }
});

rustTest('null / empty string / empty object clears the default and only the routes that followed it', async () => {
  for (const target of [null, '', {}]) {
    const harness = bridgeHarness({
      sessions: [
        claudeSession('has-route', { subagent: inherited(CLAUDE_ROUTE) }),
        claudeSession('plain'),
        claudeSession('own', { subagent: clone(CLAUDE_ROUTE) }),
      ],
      defaults: { claude: CLAUDE_ROUTE, codex: null },
    });
    const response = await invoke(harness.app, 'POST', '/api/subagent-defaults/sync', {
      body: { cli: 'claude', subagent: target },
    });
    assert.equal(response.statusCode, 200, JSON.stringify(target));
    assert.equal(response.body.subagent, null);
    assert.deepEqual(response.body.defaults, { claude: null, codex: null });
    assert.deepEqual(response.body.counts, { applied: 1, deferred: 0, unchanged: 1, skipped: 0, kept: 1 });
    assert.deepEqual(harness.applied, [{ sessionId: 'has-route', body: { subagent: null } }]);
    assert.equal(harness.sessions.get('has-route').subagent, undefined);
    assert.deepEqual(harness.sessions.get('own').subagent, CLAUDE_ROUTE, 'own routes survive a clear');
    assert.deepEqual(harness.writes, [{
      claude: CLAUDE_ROUTE,
      codex: null,
      subagent: { claude: null, codex: null },
    }]);
  }
});

rustTest('codex: sessions without a main provider are skipped, not failed', async () => {
  const harness = bridgeHarness({
    sessions: [
      { id: 'with-main', cli: 'codex', kind: 'chat', provider: 'main' },
      { id: 'no-main', cli: 'codex', kind: 'chat', provider: null },
      { id: 'same', cli: 'codex-exp', kind: 'chat', provider: 'main', subagent: inherited(CODEX_ROUTE) },
      { id: 'claude-other', cli: 'claude', kind: 'chat', provider: 'main' },
    ],
  });
  const response = await invoke(harness.app, 'POST', '/api/subagent-defaults/sync', {
    body: { cli: 'codex-exp', subagent: clone(CODEX_ROUTE) },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.family, 'codex');
  assert.deepEqual(response.body.counts, { applied: 1, deferred: 0, unchanged: 1, skipped: 1, kept: 0 });
  assert.deepEqual(response.body.sessions, [
    { sessionId: 'with-main', sessionName: 'with-main', cli: 'codex', outcome: 'applied' },
    { sessionId: 'no-main', sessionName: 'no-main', cli: 'codex', outcome: 'skipped',
      reason: 'codex_requires_main_provider' },
    { sessionId: 'same', sessionName: 'same', cli: 'codex-exp', outcome: 'unchanged' },
  ]);
  assert.deepEqual(harness.applied.map(entry => entry.sessionId), ['with-main']);
});

rustTest('a rejected patch is reported as skipped with a sanitized detail', async () => {
  const harness = bridgeHarness({
    sessions: [claudeSession('ok'), claudeSession('rejected')],
    rejected: ['rejected'],
  });
  const response = await invoke(harness.app, 'POST', '/api/subagent-defaults/sync', {
    body: { cli: 'claude', subagent: clone(CLAUDE_ROUTE) },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.counts, { applied: 1, deferred: 0, unchanged: 0, skipped: 1, kept: 0 });
  const skipped = response.body.sessions.at(-1);
  assert.deepEqual(skipped, {
    sessionId: 'rejected', sessionName: 'rejected', cli: 'claude',
    outcome: 'skipped', reason: 'patch_rejected', detail: 'session patch rejected',
  });
  assert.equal(harness.writes.length, 1, 'defaults persist even when one session rejects');
});

rustTest('a patch that throws is reported for that session; the others still move', async () => {
  const harness = bridgeHarness({
    sessions: [claudeSession('first'), claudeSession('boom'), claudeSession('last')],
    throwing: ['boom'],
  });
  const response = await invoke(harness.app, 'POST', '/api/subagent-defaults/sync', {
    body: { cli: 'claude', subagent: clone(CLAUDE_ROUTE) },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.counts, { applied: 2, deferred: 0, unchanged: 0, skipped: 1, kept: 0 });
  assert.deepEqual(harness.applied.map(entry => entry.sessionId), ['first', 'boom', 'last']);
  assert.deepEqual(harness.sessions.get('last').subagent, inherited(CLAUDE_ROUTE));
  const skipped = response.body.sessions.find(entry => entry.sessionId === 'boom');
  assert.deepEqual(skipped, {
    sessionId: 'boom', sessionName: 'boom', cli: 'claude',
    outcome: 'skipped', reason: 'patch_rejected', detail: 'session patch rejected',
  });
});

rustTest('dry run also previews rejections without writing', async () => {
  const harness = bridgeHarness({
    sessions: [claudeSession('rejected')],
    rejected: ['rejected'],
  });
  const response = await invoke(harness.app, 'POST', '/api/subagent-defaults/sync', {
    body: { cli: 'claude', subagent: clone(CLAUDE_ROUTE), dryRun: true },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.sessions, [{
    sessionId: 'rejected', sessionName: 'rejected', cli: 'claude',
    outcome: 'skipped', reason: 'patch_rejected', detail: 'session patch rejected',
  }]);
  assert.deepEqual(harness.writes, []);
});

rustTest('system, terminal, ephemeral, login and foreign-CLI sessions are silently excluded', async () => {
  const harness = bridgeHarness({
    sessions: [
      claudeSession('keep'),
      claudeSession('aux', { type: 'aux' }),
      claudeSession('gateway', { type: 'gateway' }),
      claudeSession('terminal', { kind: 'terminal' }),
      claudeSession('ephemeral', { ephemeral: true }),
      claudeSession('login', { loginFlow: 'claude-auth-login' }),
      { id: 'opencode', cli: 'opencode', kind: 'chat', provider: 'main' },
      { id: 'codex', cli: 'codex', kind: 'chat', provider: 'main' },
    ],
  });
  const response = await invoke(harness.app, 'POST', '/api/subagent-defaults/sync', {
    body: { cli: 'claude', subagent: clone(CLAUDE_ROUTE), dryRun: true },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.sessions.map(entry => entry.sessionId), ['keep']);
  assert.deepEqual(response.body.counts, { applied: 1, deferred: 0, unchanged: 0, skipped: 0, kept: 0 });
});

rustTest('pending configuration decides the desired CLI and subagent', async () => {
  // A busy codex session staged to become claude with no subagent: the claude
  // sync must see it as an eligible, non-unchanged target.
  const harness = bridgeHarness({
    sessions: [{
      id: 'staged', cli: 'codex', kind: 'chat', provider: 'main',
      pendingConfiguration: { cli: 'claude', profile: { subagent: null } },
    }],
  });
  const response = await invoke(harness.app, 'POST', '/api/subagent-defaults/sync', {
    body: { cli: 'claude', subagent: clone(CLAUDE_ROUTE), dryRun: true },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.sessions.map(entry => entry.outcome), ['deferred']);
  assert.deepEqual(response.body.sessions[0].cli, 'claude');
});

rustTest('invalid targets answer the contract error codes', async () => {
  const harness = bridgeHarness();
  const cases = [
    [{ cli: 'opencode', subagent: clone(CLAUDE_ROUTE) }, 400, 'unsupported_cli'],
    [{ cli: 'claude', subagent: { providerId: 'ghost-route', model: 'm' } }, 400, 'invalid_provider'],
    [{ cli: 'claude', subagent: { providerId: '', model: 'm' } }, 400, 'invalid_provider'],
    [{ cli: 'claude', subagent: { providerId: 'sub-claude', model: 'bad model' } }, 400, 'invalid_subagent'],
    [{ cli: 'claude', subagent: { providerId: 'sub-claude' } }, 400, 'invalid_subagent'],
    [{ cli: 'claude', subagent: 'nope' }, 400, 'invalid_subagent'],
    [{ cli: 'codex', subagent: { providerId: 'sub-claude', model: 'gpt-5-codex' } }, 400, 'provider_not_proxyable'],
  ];
  for (const [body, status, code] of cases) {
    const response = await invoke(harness.app, 'POST', '/api/subagent-defaults/sync', { body });
    assert.equal(response.statusCode, status, JSON.stringify(body));
    assert.equal(response.body.code, code, JSON.stringify(body));
    assert.equal(typeof response.body.error, 'string');
  }
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.applied, []);
});

rustTest('the official codex provider cannot be a sub-task route', async () => {
  const harness = bridgeHarness({
    validIds: ['sub-claude', 'sub-codex', 'main', 'official-codex'],
    proxyable: ['official-codex'],
    officials: ['official-codex'],
  });
  const response = await invoke(harness.app, 'POST', '/api/subagent-defaults/sync', {
    body: { cli: 'codex', subagent: { providerId: 'official-codex', model: 'gpt-5-codex' } },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'provider_not_proxyable');
});

test('missing native functions answer 503 rust_backend_unavailable', async () => {
  const harness = bridgeHarness({ sessions: [claudeSession('a')], getNative: () => ({}) });
  for (const [method, routePath, body] of [
    ['GET', '/api/subagent-defaults', {}],
    ['POST', '/api/subagent-defaults/sync', { body: { cli: 'claude', subagent: null } }],
  ]) {
    const response = await invoke(harness.app, method, routePath, body);
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'rust_backend_unavailable');
    assert.equal(typeof response.body.error, 'string');
  }
  assert.deepEqual(harness.writes, []);
});

rustTest('GET returns both families even when nothing is stored', async () => {
  const harness = bridgeHarness({ defaults: { claude: null, codex: null } });
  const response = await invoke(harness.app, 'GET', '/api/subagent-defaults');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, defaults: { claude: null, codex: null } });
});

rustTest('responses are bounded to 200 entries but counts stay complete', async () => {
  const sessions = Array.from({ length: 205 }, (_, index) => claudeSession(`s${index}`));
  const harness = bridgeHarness({ sessions });
  const response = await invoke(harness.app, 'POST', '/api/subagent-defaults/sync', {
    body: { cli: 'claude', subagent: clone(CLAUDE_ROUTE), dryRun: true },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.sessions.length, 200);
  assert.equal(response.body.truncated, true);
  assert.equal(response.body.counts.applied, 205);
});

// ────────────────────────── providers.js 接线 ──────────────────────────
function providerHarness(options = {}) {
  const writes = [];
  const applied = [];
  const sessions = new Map();
  for (const session of options.sessions || []) sessions.set(session.id, session);
  const providers = {
    appTypeForCli(cli) {
      if (cli === 'codex') return 'codex';
      if (cli === 'claude') return 'claude';
      return null;
    },
    appTypesForCli(cli) {
      const type = this.appTypeForCli(cli);
      return type ? [type] : [];
    },
    providerSupportsCli: () => true,
    getCcSwitchStatus: () => ({ available: false }),
    normalizeOfficialProviderId: (_cli, id) => id ?? null,
    getProvider: (appType, id) => ({ id, appType: appType || 'codex' }),
    codexProviderProxyable: id => id === 'sub-codex',
    isOfficialCodexOAuthProvider: provider => provider?.id === 'official-codex',
    listProviders: () => [],
    getProviderUsageStats: () => ({ stats: [], windows: {} }),
    importFromCcSwitch: () => ({}),
    createProvider: () => ({}),
    updateProvider: () => {},
    deleteProvider: () => true,
  };
  const providerRouterRuntime = {
    getProviderSummary: (appType, id) => (id ? { id, appType: appType || 'claude', name: id } : null),
  };
  const routes = createProviderRoutes({
    fs: {
      readFileSync() {
        return JSON.stringify(options.stored === undefined ? { claude: null, codex: null } : options.stored);
      },
    },
    providerDefaultsFile: '/runtime/provider-defaults.json',
    atomicWriteJson(file, value) {
      if (options.writeError) throw options.writeError;
      writes.push({ file, value: clone(value) });
    },
    providers,
    providerRouterRuntime,
    findProviderReferences: () => [],
    persistedSessions: sessions,
    providerRelayShares: { create() {}, list: () => [], getCredential: () => null, revoke: () => null, revokeProvider: () => 0 },
    getAuxConfig: () => ({ protocol: 'anthropic', providerId: null }),
    clearAuxProvider: () => {},
    applySessionPatch(sessionId, body) {
      applied.push({ sessionId, body: clone(body) });
      const session = sessions.get(sessionId);
      if (session && body.subagent) session.subagent = clone(body.subagent);
      return { status: 200, body: {} };
    },
    previewSessionPatch: () => ({ status: 200, body: {} }),
    claudeCmd: '/usr/local/bin/claude',
    getPort: () => 4321,
    getClaudeOfficialViaProxy: () => false,
    http: { request() { throw new Error('unexpected HTTP'); } },
    https: { request() { throw new Error('unexpected HTTP'); } },
    logger: { error() {} },
    ...(options.getNative ? { getNative: options.getNative } : {}),
  });
  const app = createApp();
  routes.mountCatalogRoutes(app);
  routes.mountManagementRoutes(app);
  return { app, routes, providerDefaults: routes.providerDefaults, writes, applied, sessions };
}

rustTest('a never-used feature keeps the exact legacy defaults shape; a sync adds the key', async () => {
  const harness = providerHarness({
    stored: { claude: 'claude-one', codex: null },
    sessions: [claudeSession('a')],
    getNative: () => addon,
  });
  // No key yet: response shapes stay exactly as before this feature.
  let response = await invoke(harness.app, 'GET', '/api/providers');
  assert.deepEqual(response.body.defaults, { claude: 'claude-one', codex: null });
  assert.equal(Object.prototype.hasOwnProperty.call(response.body.defaults, 'subagent'), false);

  // Dry run also must not create it.
  response = await invoke(harness.app, 'POST', '/api/subagent-defaults/sync', {
    body: { cli: 'claude', subagent: clone(CLAUDE_ROUTE), dryRun: true },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(harness.writes, []);
  assert.equal(Object.prototype.hasOwnProperty.call(harness.providerDefaults, 'subagent'), false);

  // First real sync persists the key through the existing atomic write path.
  response = await invoke(harness.app, 'POST', '/api/subagent-defaults/sync', {
    body: { cli: 'claude', subagent: clone(CLAUDE_ROUTE) },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.defaults, { claude: CLAUDE_ROUTE, codex: null });
  assert.deepEqual(harness.writes, [{
    file: '/runtime/provider-defaults.json',
    value: { claude: 'claude-one', codex: null, subagent: { claude: CLAUDE_ROUTE, codex: null } },
  }]);
  assert.deepEqual(harness.applied, [{ sessionId: 'a', body: { subagent: CLAUDE_ROUTE, subagentInherited: true } }]);

  response = await invoke(harness.app, 'GET', '/api/provider-defaults');
  assert.deepEqual(response.body, { claude: 'claude-one', codex: null, subagent: { claude: CLAUDE_ROUTE, codex: null } });
  response = await invoke(harness.app, 'GET', '/api/providers');
  assert.deepEqual(response.body.defaults.subagent, { claude: CLAUDE_ROUTE, codex: null });
  response = await invoke(harness.app, 'GET', '/api/subagent-defaults');
  assert.deepEqual(response.body, { ok: true, defaults: { claude: CLAUDE_ROUTE, codex: null } });

  // PUT /api/provider-defaults keeps the key intact.
  response = await invoke(harness.app, 'PUT', '/api/provider-defaults', { body: { claude: '' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.defaults, { claude: null, codex: null, subagent: { claude: CLAUDE_ROUTE, codex: null } });
  assert.deepEqual(harness.writes.at(-1).value.subagent, { claude: CLAUDE_ROUTE, codex: null });
});

rustTest('stored defaults are normalized on load, including malformed entries', async () => {
  const harness = providerHarness({
    stored: {
      claude: null, codex: null,
      subagent: { claude: { providerId: ' sub-claude ', model: 'claude-haiku-4-5' }, codex: 'junk' },
    },
    getNative: () => addon,
  });
  assert.deepEqual(harness.providerDefaults.subagent, { claude: CLAUDE_ROUTE, codex: null });
  const response = await invoke(harness.app, 'GET', '/api/subagent-defaults');
  assert.deepEqual(response.body.defaults, { claude: CLAUDE_ROUTE, codex: null });
});

test('without the native module the stored value passes through untouched', async () => {
  const raw = { claude: { providerId: 'p', model: 'm' }, codex: 'junk' };
  const harness = providerHarness({
    stored: { claude: null, codex: null, subagent: raw },
    getNative: () => ({}),
  });
  assert.deepEqual(harness.providerDefaults.subagent, raw);
  const response = await invoke(harness.app, 'GET', '/api/subagent-defaults');
  assert.equal(response.statusCode, 503);
  // A later save must not drop the raw key.
  const put = await invoke(harness.app, 'PUT', '/api/provider-defaults', { body: { claude: 'x' } });
  assert.deepEqual(put.body.defaults.subagent, raw);
});

rustTest('save_failed answers 500 and touches no session', async () => {
  const harness = providerHarness({
    sessions: [claudeSession('a')],
    getNative: () => addon,
    writeError: new Error('disk full'),
  });
  const response = await invoke(harness.app, 'POST', '/api/subagent-defaults/sync', {
    body: { cli: 'claude', subagent: clone(CLAUDE_ROUTE) },
  });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, { error: '无法保存子任务默认线路', code: 'save_failed' });
  assert.deepEqual(harness.applied, [], 'a failed save must not touch any session');
  assert.equal(harness.sessions.get('a').subagent, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(harness.providerDefaults, 'subagent'), false);
});

// ─────────────────── createSessionRecord 缺省应用 ───────────────────
function createHarness(options = {}) {
  const persisted = new Map();
  const valid = options.valid === true;
  const factory = createSessionRecordFactory({
    isResidentSession,
    sharedWorkspace: () => ({ worktreePath: '/wt/shared', branch: 'multicc/shared' }),
    SUPPORTED_CHAT_CLIS: ['claude', 'claude-exp', 'codex', 'codex-exp', 'opencode'],
    validateExperimentalSession: () => ({ ok: true }),
    tuiChatMirrorEnabled: () => false,
    normalizeEffort: value => (value == null ? null : String(value)),
    validEffortForCli: () => true,
    codexDefaultReasoningLevel: () => null,
    normalizeCliAgent: () => null,
    validateProviderSelection: () => ({ ok: true, value: null }),
    providers: {
      normalizeOfficialProviderId: (_cli, id) => (id === undefined ? null : id),
      codexProviderProxyable: () => true,
    },
    primaryProviderCandidate: () => null,
    providerDefaults: options.providerDefaults || {},
    validProviderId: (cli, id) => (id === 'deleted' ? { ok: false }
      : (valid || id === 'main' || id === 'sub-claude' || id === 'sub-codex' ? { ok: true, value: id } : { ok: false })),
    allocateSessionId: () => `sess-${persisted.size + 1}`,
    persistedSessions: persisted,
    ensureDirGitReady: async () => ({ ok: true }),
    friendlyDirReason: reason => String(reason),
    WORKTREE_SUBDIR: '.multicc-worktrees',
    gitWorktreeAdd: async (dirPath, sid) => ({
      worktreePath: `${dirPath}/.multicc-worktrees/${sid}`, branch: `multicc/${sid}`,
    }),
    gitWorktreeRollbackCreate: async () => {},
    sanitizeLoginEnv: () => ({ ok: true }),
    ensureCliStates: () => {},
    sessionPersistence: { mutate: () => {} },
    savePersistedSessionsBestEffort: () => {},
    appendEvent: () => {},
    cliForLoginFlow: () => null,
  });
  return { factory, persisted, dir: { id: 'd', path: '/repo', baseBranch: 'main' } };
}

const DEFAULT_DEFAULTS = Object.freeze({
  claude: null, codex: null,
  subagent: { claude: CLAUDE_ROUTE, codex: CODEX_ROUTE },
});

test('an omitted subagent picks up the CLI family default', async () => {
  const { factory, dir } = createHarness({ providerDefaults: clone(DEFAULT_DEFAULTS) });
  const claude = await factory({ dir, cli: 'claude', kind: 'chat' });
  assert.equal(claude.ok, true, claude.error);
  assert.deepEqual(claude.session.subagent, inherited(CLAUDE_ROUTE));

  const claudeExp = await factory({ dir, cli: 'claude-exp', kind: 'chat' });
  assert.equal(claudeExp.ok, true, claudeExp.error);
  assert.deepEqual(claudeExp.session.subagent, inherited(CLAUDE_ROUTE));

  const codex = await factory({ dir, cli: 'codex', kind: 'chat', provider: 'main' });
  assert.equal(codex.ok, true, codex.error);
  assert.deepEqual(codex.session.subagent, inherited(CODEX_ROUTE));

  // 显式给的线路（哪怕和默认一样）是这个任务自己的设置，不带 inherited。
  const own = await factory({ dir, cli: 'claude', kind: 'chat', subagent: clone(CLAUDE_ROUTE) });
  assert.equal(own.ok, true, own.error);
  assert.deepEqual(own.session.subagent, CLAUDE_ROUTE);
});

test('route provenance: only the default sets inherited; re-saving the same route keeps it', () => {
  const other = { providerId: 'main', model: 'other' };
  assert.deepEqual(withSubagentSource(clone(CLAUDE_ROUTE), null, true), inherited(CLAUDE_ROUTE));
  assert.deepEqual(withSubagentSource(clone(CLAUDE_ROUTE), null), CLAUDE_ROUTE);
  // 对话框只改了主线路、子 agent 原样回存：仍然跟随全局。
  assert.deepEqual(withSubagentSource(clone(CLAUDE_ROUTE), inherited(CLAUDE_ROUTE)), inherited(CLAUDE_ROUTE));
  // 换成别的线路 = 单独设置；选随主 = 没有线路。
  assert.deepEqual(withSubagentSource(clone(other), inherited(CLAUDE_ROUTE)), other);
  assert.equal(withSubagentSource(null, inherited(CLAUDE_ROUTE)), null);
  // 单独设置过的同一条线路不会被「回存」悄悄变成跟随全局。
  assert.deepEqual(withSubagentSource(clone(CLAUDE_ROUTE), clone(CLAUDE_ROUTE)), CLAUDE_ROUTE);
});

test('explicit null / empty string / empty object keeps "no sub-task route"', async () => {
  const { factory, dir } = createHarness({ providerDefaults: clone(DEFAULT_DEFAULTS) });
  for (const subagent of [null, '', {}]) {
    const created = await factory({ dir, cli: 'claude', kind: 'chat', subagent });
    assert.equal(created.ok, true, created.error);
    assert.equal(created.session.subagent, undefined, JSON.stringify(subagent));
  }
});

test('terminal and loginFlow terminals never take the default', async () => {
  const { factory, dir } = createHarness({ providerDefaults: clone(DEFAULT_DEFAULTS) });
  const terminal = await factory({ dir, cli: 'claude', kind: 'terminal' });
  assert.equal(terminal.ok, true, terminal.error);
  assert.equal(terminal.session.subagent, undefined);

  const login = await factory({ dir, cli: 'codex', kind: 'terminal', loginFlow: 'codex-login' });
  assert.equal(login.ok, true, login.error);
  assert.equal(login.session.subagent, undefined);
});

test('ephemeral helper chats never take the default', async () => {
  const { factory, dir } = createHarness({ providerDefaults: clone(DEFAULT_DEFAULTS) });
  const helper = await factory({ dir, cli: 'claude', kind: 'chat', ephemeral: true });
  assert.equal(helper.ok, true, helper.error);
  assert.equal(helper.session.subagent, undefined);

  const explicit = await factory({ dir, cli: 'claude', kind: 'chat', ephemeral: true, subagent: clone(CLAUDE_ROUTE) });
  assert.equal(explicit.ok, true, explicit.error);
  assert.deepEqual(explicit.session.subagent, CLAUDE_ROUTE, 'an explicit route still applies');
});

test('unsupported CLIs never take a default', async () => {
  const { factory, dir } = createHarness({ providerDefaults: clone(DEFAULT_DEFAULTS) });
  const created = await factory({ dir, cli: 'opencode', kind: 'chat' });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.session.subagent, undefined);
});

test('an invalid default never blocks creation, including validateOnly', async () => {
  const { factory, dir } = createHarness({
    providerDefaults: { claude: null, codex: null, subagent: { claude: { providerId: 'deleted', model: 'm' }, codex: null } },
  });
  const created = await factory({ dir, cli: 'claude', kind: 'chat' });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.session.subagent, undefined);

  const validated = await factory({ dir, cli: 'claude', kind: 'chat', validateOnly: true });
  assert.deepEqual(validated, { ok: true });

  // A Codex default without a main provider is invalid at creation time too.
  const codex = createHarness({
    providerDefaults: { claude: null, codex: null, subagent: { claude: null, codex: CODEX_ROUTE } },
  });
  const codexCreated = await codex.factory({ dir: codex.dir, cli: 'codex', kind: 'chat' });
  assert.equal(codexCreated.ok, true, codexCreated.error);
  assert.equal(codexCreated.session.subagent, undefined);
});

test('an explicit route is validated exactly as before', async () => {
  const { factory, dir } = createHarness({ providerDefaults: clone(DEFAULT_DEFAULTS) });
  const created = await factory({ dir, cli: 'claude', kind: 'chat', subagent: { providerId: 'sub-claude', model: 'm' } });
  assert.equal(created.ok, true, created.error);
  assert.deepEqual(created.session.subagent, { providerId: 'sub-claude', model: 'm' });

  const invalid = await factory({ dir, cli: 'claude', kind: 'chat', subagent: { providerId: 'deleted', model: 'm' } });
  assert.deepEqual(invalid, { ok: false, error: 'invalid subagent provider' });
});

test('a default route without a configured key is simply no route', async () => {
  const { factory, dir } = createHarness({ providerDefaults: { claude: null, codex: null } });
  const created = await factory({ dir, cli: 'claude', kind: 'chat' });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.session.subagent, undefined);
});
