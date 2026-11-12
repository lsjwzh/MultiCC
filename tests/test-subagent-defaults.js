'use strict';
// 子任务默认线路（每个 CLI 家族一条 `{providerId, model}`）+ 一键同步。
//
// 公开路由 GET /api/subagent-defaults、POST /api/subagent-defaults/sync 已由 Rust
// 前门独占（native/gateway/src/app/subagent_defaults.rs，逐字节对比在
// docs/rust-migration/differential/subagent-defaults.js）。这里覆盖 Node 侧剩下的两层：
//
//   1. 宿主端口（src/routes/subagent-defaults-host.js）：前门回调时读到的会话表投影、
//      provider 事实、默认值落盘（含进程内对象身份）与逐会话 PATCH 预览/执行。
//      规则、校验、计数与错误映射都不在这里，改由 Rust 集成测试覆盖。
//   2. providers.js 接线：provider-defaults.json 的落盘、catalog 事实里的
//      defaults.subagent、defaultsPersist 保留该键、加载时归一化。
//   3. createSessionRecord 的缺省应用：省略 → 默认；显式 null/''/{} → 不要；
//      默认失效（provider 被删、codex 没有主线）→ 静默无子任务，绝不阻断创建。
const test = require('node:test');
const assert = require('node:assert/strict');

const { mountSubagentDefaultsHostRoute, HOST_PATH } = require('../src/routes/subagent-defaults-host');
const { HOST_PATH: PROVIDERS_HOST_PATH } = require('../src/routes/providers-host');
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

// ────────────────────────── 宿主端口（host port） ──────────────────────────
function hostHarness(options = {}) {
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
  mountSubagentDefaultsHostRoute(app, {
    providerDefaults,
    sessions,
    validProviderId: (cli, id) => (validIds.has(id) ? { ok: true, value: id } : { ok: false }),
    providers,
    isLocal: options.isLocal || (() => true),
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
    ...(options.withoutPreview ? {} : {
      previewSessionPatch(sessionId, body) {
        previewed.push({ sessionId, body: clone(body) });
        if (!sessions.has(sessionId)) return { status: 404, body: { error: 'session not found' } };
        if (rejected.has(sessionId)) return { status: 400, body: { error: SENSITIVE } };
        return { status: 200, body: { subagent: clone(body.subagent) } };
      },
    }),
    persistDefaults(next) {
      if (options.writeError) throw options.writeError;
      writes.push(clone(next));
    },
  });
  return { app, providerDefaults, sessions, writes, applied, previewed };
}

function claudeSession(id, extra = {}) {
  return {
    id, dirId: 'd1', cli: 'claude', kind: 'chat', label: id, provider: 'main',
    ...extra,
  };
}

function host(app, body) {
  return invoke(app, 'POST', HOST_PATH, { body });
}

test('state projects the desired session table, pending configuration included', async () => {
  const harness = hostHarness({
    sessions: [
      claudeSession('plain'),
      { id: 'aux', type: 'aux', cli: 'claude', kind: 'chat' },
      { id: 'opencode', cli: 'opencode', kind: 'chat' },
      {
        id: 'staged', cli: 'codex', kind: 'chat', provider: 'main',
        pendingConfiguration: { cli: 'claude', profile: { subagent: inherited(CLAUDE_ROUTE) } },
      },
    ],
    defaults: { subagent: { claude: CLAUDE_ROUTE, codex: null } },
  });
  const response = await host(harness.app, { op: 'state' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.subagent, { claude: CLAUDE_ROUTE, codex: null });
  assert.deepEqual(response.body.sessions.map(session => [session.id, session.cli, session.pending, session.subagent]), [
    // 归属判断读 pending 配置应用后的期望状态：staged 已经是 claude。
    ['plain', 'claude', false, null],
    ['aux', 'claude', false, null],
    ['opencode', 'opencode', false, null],
    ['staged', 'claude', true, inherited(CLAUDE_ROUTE)],
  ]);
});

test('state reports a missing stored default as null, never as a missing key', async () => {
  const harness = hostHarness({});
  const response = await host(harness.app, { op: 'state' });
  assert.deepEqual(response.body, { subagent: null, sessions: [] });
});

test('facts answer the three provider questions the front door cannot', async () => {
  const harness = hostHarness({
    validIds: ['sub-claude', 'sub-codex', 'official-codex'],
    proxyable: ['sub-codex', 'official-codex'],
    officials: ['official-codex'],
  });
  let response = await host(harness.app, { op: 'facts', family: 'codex', providerId: 'sub-codex' });
  assert.deepEqual(response.body, { valid: true, proxyable: true, official: false });
  response = await host(harness.app, { op: 'facts', family: 'codex', providerId: 'official-codex' });
  assert.deepEqual(response.body, { valid: true, proxyable: true, official: true });
  // A Claude provider never asks the Codex-only questions.
  response = await host(harness.app, { op: 'facts', family: 'claude', providerId: 'sub-claude' });
  assert.deepEqual(response.body, { valid: true, proxyable: false, official: false });
  response = await host(harness.app, { op: 'facts', family: 'claude', providerId: 'ghost' });
  assert.deepEqual(response.body, { valid: false, proxyable: false, official: false });
});

test('persist writes through the existing atomic path and keeps the live object identity', async () => {
  const harness = hostHarness({ defaults: { claude: 'claude-one', codex: null } });
  const before = harness.providerDefaults;
  const response = await host(harness.app, { op: 'persist', defaults: { claude: CLAUDE_ROUTE, codex: null } });
  assert.deepEqual(response.body, { ok: true });
  assert.deepEqual(harness.writes, [{
    claude: 'claude-one',
    codex: null,
    subagent: { claude: CLAUDE_ROUTE, codex: null },
  }]);
  assert.equal(harness.providerDefaults, before, 'the same object other routes already hold is updated');
  assert.deepEqual(harness.providerDefaults.subagent, { claude: CLAUDE_ROUTE, codex: null });
});

test('a failed persist answers ok:false and leaves the live object untouched', async () => {
  const harness = hostHarness({ defaults: { claude: null, codex: null }, writeError: new Error('disk full') });
  const response = await host(harness.app, { op: 'persist', defaults: { claude: CLAUDE_ROUTE, codex: null } });
  assert.deepEqual(response.body, { ok: false });
  assert.deepEqual(harness.writes, []);
  assert.equal(Object.prototype.hasOwnProperty.call(harness.providerDefaults, 'subagent'), false);
});

test('patch applies the inherited route, or a null target when clearing', async () => {
  const harness = hostHarness({ sessions: [claudeSession('a')] });
  let response = await host(harness.app, { op: 'patch', sessionId: 'a', subagent: clone(CLAUDE_ROUTE), dryRun: false });
  assert.deepEqual(response.body, { ok: true, status: 200, deferred: false });
  assert.deepEqual(harness.applied, [{ sessionId: 'a', body: { subagent: CLAUDE_ROUTE, subagentInherited: true } }]);
  assert.deepEqual(harness.sessions.get('a').subagent, inherited(CLAUDE_ROUTE));

  response = await host(harness.app, { op: 'patch', sessionId: 'a', subagent: null, dryRun: false });
  assert.deepEqual(response.body, { ok: true, status: 200, deferred: false });
  assert.deepEqual(harness.applied.at(-1).body, { subagent: null });
  assert.equal(harness.sessions.get('a').subagent, undefined);
});

test('a dry run previews instead of applying', async () => {
  const harness = hostHarness({ sessions: [claudeSession('a')] });
  const response = await host(harness.app, { op: 'patch', sessionId: 'a', subagent: clone(CLAUDE_ROUTE), dryRun: true });
  assert.deepEqual(response.body, { ok: true, status: 200, deferred: false });
  assert.deepEqual(harness.previewed.map(entry => entry.sessionId), ['a']);
  assert.deepEqual(harness.applied, []);
});

test('a rejected or throwing patch reports the sanitized detail without leaking it', async () => {
  const harness = hostHarness({
    sessions: [claudeSession('rejected'), claudeSession('boom'), claudeSession('busy')],
    rejected: ['rejected'], throwing: ['boom'], deferred: ['busy'],
  });
  const rejected = await host(harness.app, { op: 'patch', sessionId: 'rejected', subagent: clone(CLAUDE_ROUTE) });
  assert.deepEqual(rejected.body, { ok: true, status: 400, detail: 'session patch rejected' });
  const boom = await host(harness.app, { op: 'patch', sessionId: 'boom', subagent: clone(CLAUDE_ROUTE) });
  assert.deepEqual(boom.body, { ok: true, status: 500, detail: 'session patch rejected' });
  const busy = await host(harness.app, { op: 'patch', sessionId: 'busy', subagent: clone(CLAUDE_ROUTE) });
  assert.deepEqual(busy.body, { ok: true, status: 200, deferred: true });
});

test('without a preview runtime a dry run reports the compatibility answer', async () => {
  const harness = hostHarness({ sessions: [claudeSession('a')], withoutPreview: true });
  const response = await host(harness.app, { op: 'patch', sessionId: 'a', subagent: clone(CLAUDE_ROUTE), dryRun: true });
  assert.deepEqual(response.body, { ok: true, compat: true });
  assert.deepEqual(harness.applied, []);
});

test('the host port only answers loopback requests', async () => {
  const harness = hostHarness({
    sessions: [claudeSession('a')],
    defaults: { subagent: { claude: CLAUDE_ROUTE, codex: null } },
    isLocal: () => false,
  });
  for (const body of [{ op: 'state' }, { op: 'facts', family: 'claude', providerId: 'sub-claude' }, { op: 'persist', defaults: {} }, { op: 'patch', sessionId: 'a' }]) {
    const response = await host(harness.app, body);
    assert.equal(response.statusCode, 404, JSON.stringify(body));
    assert.deepEqual(response.body, { error: 'not found' });
  }
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.applied, []);
});

test('unknown operations and a missing sessionId are rejected', async () => {
  const harness = hostHarness();
  const unknown = await host(harness.app, { op: 'nope' });
  assert.equal(unknown.statusCode, 400);
  const missing = await host(harness.app, { op: 'patch' });
  assert.equal(missing.statusCode, 400);
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
    probeRelayModels: async () => ({ tested: [], accepted: [] }),
    claudeProbeRouteEnv: () => null,
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
    isLocalRequest: () => true,
  });
  const app = createApp();
  routes.mountManagementRoutes(app);
  return { app, routes, providerDefaults: routes.providerDefaults, writes, applied, sessions };
}

test('a never-used feature keeps the exact legacy defaults shape; persisting adds the key', async () => {
  const harness = providerHarness({
    stored: { claude: 'claude-one', codex: null },
    sessions: [claudeSession('a')],
  });
  // No key yet: response shapes stay exactly as before this feature.
  let response = await invoke(harness.app, 'POST', PROVIDERS_HOST_PATH, { body: { op: 'catalog' } });
  assert.deepEqual(response.body.defaults, { claude: 'claude-one', codex: null });
  assert.equal(Object.prototype.hasOwnProperty.call(response.body.defaults, 'subagent'), false);

  // The front door's persist op lands through the existing atomic write path.
  response = await invoke(harness.app, 'POST', HOST_PATH, {
    body: { op: 'persist', defaults: { claude: CLAUDE_ROUTE, codex: null } },
  });
  assert.deepEqual(response.body, { ok: true });
  assert.deepEqual(harness.writes, [{
    file: '/runtime/provider-defaults.json',
    value: { claude: 'claude-one', codex: null, subagent: { claude: CLAUDE_ROUTE, codex: null } },
  }]);

  response = await invoke(harness.app, 'POST', PROVIDERS_HOST_PATH, { body: { op: 'defaultsGet' } });
  assert.deepEqual(response.body, { ok: true, defaults: { claude: 'claude-one', codex: null, subagent: { claude: CLAUDE_ROUTE, codex: null } } });
  response = await invoke(harness.app, 'POST', PROVIDERS_HOST_PATH, { body: { op: 'catalog' } });
  assert.deepEqual(response.body.defaults.subagent, { claude: CLAUDE_ROUTE, codex: null });
  response = await invoke(harness.app, 'POST', HOST_PATH, { body: { op: 'state' } });
  assert.deepEqual(response.body.subagent, { claude: CLAUDE_ROUTE, codex: null });

  // The front door then patches the sessions it planned.
  response = await invoke(harness.app, 'POST', HOST_PATH, {
    body: { op: 'patch', sessionId: 'a', subagent: clone(CLAUDE_ROUTE) },
  });
  assert.deepEqual(response.body, { ok: true, status: 200, deferred: false });
  assert.deepEqual(harness.applied, [{ sessionId: 'a', body: { subagent: CLAUDE_ROUTE, subagentInherited: true } }]);

  // Persisting the main defaults keeps the subagent key intact. The front door
  // normalizes the values before it calls `defaultsPersist`; Node only assigns.
  response = await invoke(harness.app, 'POST', PROVIDERS_HOST_PATH, {
    body: { op: 'defaultsPersist', next: { claude: null } },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.defaults, { claude: null, codex: null, subagent: { claude: CLAUDE_ROUTE, codex: null } });
  assert.deepEqual(harness.writes.at(-1).value.subagent, { claude: CLAUDE_ROUTE, codex: null });
});

test('stored defaults are normalized on load, including malformed entries', async () => {
  const harness = providerHarness({
    stored: {
      claude: null, codex: null,
      subagent: { claude: { providerId: ' sub-claude ', model: 'claude-haiku-4-5' }, codex: 'junk' },
    },
  });
  assert.deepEqual(harness.providerDefaults.subagent, { claude: CLAUDE_ROUTE, codex: null });
  const response = await invoke(harness.app, 'POST', HOST_PATH, { body: { op: 'state' } });
  assert.deepEqual(response.body.subagent, { claude: CLAUDE_ROUTE, codex: null });
});

test('a failed write answers ok:false and touches no session', async () => {
  const harness = providerHarness({
    sessions: [claudeSession('a')],
    writeError: new Error('disk full'),
  });
  const response = await invoke(harness.app, 'POST', HOST_PATH, {
    body: { op: 'persist', defaults: { claude: CLAUDE_ROUTE, codex: null } },
  });
  assert.deepEqual(response.body, { ok: false });
  assert.deepEqual(harness.writes, []);
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
