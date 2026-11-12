'use strict';

// The 16 public provider routes now belong to the Rust front door
// (native/gateway/src/app/providers.rs). What Node still owns is the host port
// the front door calls back on plus the streamed speed test. This file pins
// that host contract op by op: the loopback gate, the unknown-op answer, and
// the exact input/output shapes the front door was written against.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createProviderRoutes } = require('../src/routes/providers');
const { HOST_PATH } = require('../src/routes/providers-host');

function createApp() {
  const routes = [];
  const handlers = new Map();
  const app = { routes, handlers };
  for (const method of ['get', 'post', 'patch', 'delete', 'put']) {
    app[method] = (routePath, handler) => {
      const key = `${method.toUpperCase()} ${routePath}`;
      routes.push(key);
      handlers.set(key, handler);
    };
  }
  return app;
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    jsonCalls: 0,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonCalls++; this.body = body; return this; },
  };
}

async function invoke(app, method, routePath, request = {}) {
  const handler = app.handlers.get(`${method} ${routePath}`);
  assert.equal(typeof handler, 'function', `missing route ${method} ${routePath}`);
  const response = createResponse();
  await handler({ body: {}, query: {}, params: {}, ...request }, response);
  return response;
}

function host(app, body) {
  return invoke(app, 'POST', HOST_PATH, { body });
}

function idleHttp() {
  return {
    request() {
      throw new Error('unexpected HTTP request');
    },
  };
}

// Loopback client for the host-owned speed test routes: records the request and
// answers 200 with no body (the DTO only reports the status).
function okHttp(requests = []) {
  return {
    request(options, onResponse) {
      requests.push(options);
      const request = new EventEmitter();
      request.write = (chunk) => { options.body = `${options.body || ''}${chunk}`; };
      request.setTimeout = () => {};
      request.destroy = () => {};
      request.end = () => queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        onResponse(response);
        response.emit('end');
      });
      return request;
    },
  };
}

function createHarness(overrides = {}) {
  const { providers: providerOverrides = {}, ...dependencyOverrides } = overrides;
  const writes = [];
  const calls = [];
  const deleted = [];
  const relayShares = [];
  const logs = [];
  const defaultsFile = '/runtime/provider-defaults.json';
  const providers = {
    WIRE_DEFAULT_MODEL: 'claude-wire-default',
    appTypeForCli(cli) {
      if (cli === 'codex') return 'codex';
      if (cli === 'claude' || cli === 'opencode') return 'claude';
      return null;
    },
    appTypesForCli(cli) {
      if (cli === 'opencode' || cli === 'zcode') return ['claude', 'codex'];
      const type = this.appTypeForCli(cli);
      return type ? [type] : [];
    },
    providerSupportsCli(provider, cli) {
      return !!provider && (cli === 'opencode' || cli === 'zcode'
        || provider.appType === (cli === 'codex' ? 'codex' : 'claude'));
    },
    getCcSwitchStatus: () => ({ available: true, dbFound: true, dbPath: '/private/cc-switch.db' }),
    listProviders(appType) {
      calls.push({ method: 'listProviders', appType });
      return [{ id: `${appType || 'all'}-one`, appType: appType || 'claude', name: 'One' }];
    },
    getProviderUsageStats: () => ({ stats: [{ providerId: 'claude-one', totalTokens: 3 }], windows: {} }),
    importFromCcSwitch: () => ({ imported: 2, updated: 1, total: 3 }),
    createProvider(input) {
      calls.push({ method: 'createProvider', input });
      return { id: 'created-id', appType: input.appType, name: input.name };
    },
    updateProvider(appType, id, input) {
      calls.push({ method: 'updateProvider', appType, id, input });
    },
    deleteProvider(appType, id) {
      deleted.push({ appType, id });
      return true;
    },
    getProvider(appType, id) {
      return { id, appType, name: `${id} name`, settingsConfig: { env: {} } };
    },
    probeRelayModels: async (env, candidates, command) => ({
      tested: [{ model: candidates[0], ok: true, sample: 'probe ok' }],
      accepted: [candidates[0]],
      command,
      baseUrl: env.ANTHROPIC_BASE_URL,
      envKeys: Object.keys(env),
    }),
    // The probe runs against the loopback route, never the entry's own endpoint
    // (see core.claudeProbeRouteEnv); null models "nothing to probe".
    claudeProbeRouteEnv: (appType, id, port) => ({
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/claude-proxy/${id}/probe`,
      ANTHROPIC_AUTH_TOKEN: 'cpr-probe',
    }),
    resolveCodexDirectHttp: () => ({ canDirect: false, reason: 'OAuth provider cannot be tested' }),
    ...providerOverrides,
  };
  const summaries = new Map([
    ['claude:claude-one', { id: 'claude-one', appType: 'claude', name: 'Claude One' }],
    ['codex:codex-one', { id: 'codex-one', appType: 'codex', name: 'Codex One' }],
  ]);
  const providerRelayShares = {
    create(input) {
      if (!input.token || String(input.token).length < 8) {
        const error = new Error('relay token is required'); error.code = 'RELAY_TOKEN_INVALID'; throw error;
      }
      calls.push({ method: 'createRelayShare', input });
      const share = {
        id: 'abcdefghijklmnop', appType: input.appType, providerId: input.providerId,
        providerName: input.providerName, label: input.label || null,
        publicBaseUrl: input.publicBaseUrl, relayBaseUrl: input.relayBaseUrl,
        tokenFingerprint: '0123456789ab', status: 'active', createdAt: 100,
        revokedAt: null, accessCount: 0, lastUsedAt: null,
      };
      relayShares.push(share);
      return { share, credential: `mcr1.${share.id}.${input.token}` };
    },
    list(filter = {}) {
      return relayShares.filter(share => (!filter.appType || share.appType === filter.appType)
        && (!filter.providerId || share.providerId === filter.providerId));
    },
    getCredential(id) {
      const share = relayShares.find(item => item.id === id);
      if (!share) return { ok: false, code: 'not_found' };
      if (share.status === 'revoked') return { ok: false, code: 'revoked' };
      if (share.legacy) return { ok: false, code: 'not_recoverable' };
      return { ok: true, share, credential: `mcr1.${share.id}.${share.secret || 'manual-secret'}` };
    },
    revoke(id) {
      const share = relayShares.find(item => item.id === id);
      if (!share) return null;
      share.status = 'revoked'; share.revokedAt = 101;
      return share;
    },
    revokeProvider(appType, providerId) {
      calls.push({ method: 'revokeRelayProvider', appType, providerId });
      return 0;
    },
  };
  const deps = {
    fs: {
      readFileSync(file) {
        assert.equal(file, defaultsFile);
        return JSON.stringify({ claude: 'claude-one', codex: null });
      },
    },
    providerDefaultsFile: defaultsFile,
    atomicWriteJson(file, value) {
      writes.push({ file, value: JSON.parse(JSON.stringify(value)) });
    },
    providers,
    providerRouterRuntime: {
      getProviderSummary(appType, id) {
        if (appType == null) {
          return summaries.get(`claude:${id}`) || summaries.get(`codex:${id}`) || null;
        }
        return summaries.get(`${appType}:${id}`) || null;
      },
    },
    findProviderReferences: () => [],
    persistedSessions: new Map(),
    providerRelayShares,
    getAuxConfig: () => ({ protocol: 'anthropic', providerId: null }),
    claudeCmd: '/usr/local/bin/claude',
    getPort: () => 4321,
    getClaudeOfficialViaProxy: () => false,
    http: idleHttp(),
    logger: { error(...args) { logs.push(args); }, warn() {} },
    now: () => 100,
    // The host port is loopback-only; tests that care about the gate swap this.
    isLocalRequest: () => true,
    ...dependencyOverrides,
  };
  const app = createApp();
  const runtime = createProviderRoutes(deps);
  runtime.mountManagementRoutes(app);
  return { app, runtime, deps, providers, writes, calls, deleted, relayShares, logs };
}

test('the Node surface is the provider host port plus the streamed speed test', () => {
  const harness = createHarness();
  assert.deepEqual(harness.app.routes, [
    'POST /api/__host/providers',
    'POST /api/__host/subagent-defaults',
    'POST /api/providers/:appType/:id/speedtest',
    'POST /api/auto-provider/routing/test',
  ]);
  // The 16 migrated routes are gone from Node, not merely shadowed.
  for (const gone of ['GET /api/providers', 'GET /api/providers/stats', 'POST /api/providers/import',
    'POST /api/providers', 'PATCH /api/providers/:appType/:id', 'DELETE /api/providers/:appType/:id',
    'POST /api/providers/:appType/:id/probe', 'GET /api/provider-defaults', 'PUT /api/provider-defaults']) {
    assert.equal(harness.app.handlers.has(gone), false, gone);
  }
});

test('the host port only answers loopback requests and rejects unknown operations', async () => {
  const harness = createHarness({ isLocalRequest: () => false });
  for (const body of [
    { op: 'catalog' },
    { op: 'deleteExec', appType: 'claude', id: 'claude-one', references: [] },
    { op: 'defaultsPersist', next: { claude: null } },
  ]) {
    const response = await host(harness.app, body);
    assert.equal(response.statusCode, 404, JSON.stringify(body));
    assert.deepEqual(response.body, { error: 'not found' });
  }
  assert.deepEqual(harness.deleted, []);
  assert.deepEqual(harness.writes, []);

  const open = createHarness();
  const unknown = await host(open.app, { op: 'nope' });
  assert.equal(unknown.statusCode, 400);
  assert.deepEqual(unknown.body, { error: 'unknown host operation' });
});

test('catalog assembles the provider facts the front door cannot compute', async () => {
  const refreshes = [];
  const harness = createHarness({
    relayModelCatalogRuntime: {
      async refreshDue(filter) { refreshes.push(filter); return { checked: 1 }; },
    },
  });
  const response = await host(harness.app, { op: 'catalog', appType: 'claude', cli: 'opencode' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(refreshes, [{ appType: 'claude', cli: 'opencode' }]);
  assert.deepEqual(response.body, {
    ok: true,
    ccSwitchStatus: { available: true, dbFound: true, dbPath: '/private/cc-switch.db' },
    providers: [{ id: 'claude-one', appType: 'claude', name: 'One' }],
    stats: [{ providerId: 'claude-one', totalTokens: 3 }],
    defaults: { claude: 'claude-one', codex: null },
    limitCacheStaleMs: null,
  });
});

test('catalog refreshes official Codex account catalogs fire-and-forget unless poll=1', async () => {
  const refreshed = [];
  const providers = {
    getCcSwitchStatus: () => ({ available: true }),
    listProviders: () => [{ id: 'codex-official', appType: 'codex', isOfficial: true, name: 'Official' }],
    providerSupportsCli: () => true,
  };
  const codexAccountModelCatalogRuntime = {
    refreshProvider(id) { refreshed.push(id); return Promise.resolve(); },
  };

  let harness = createHarness({ providers, codexAccountModelCatalogRuntime });
  await host(harness.app, { op: 'catalog', appType: 'codex' });
  assert.deepEqual(refreshed, ['codex-official']);

  refreshed.length = 0;
  harness = createHarness({ providers, codexAccountModelCatalogRuntime });
  await host(harness.app, { op: 'catalog', appType: 'codex', poll: '1' });
  assert.deepEqual(refreshed, [], 'poll=1 reads the in-memory snapshot and never spawns a refresh');
});

test('catalog attaches the persisted limit summary, freshness and virtual status', async () => {
  const { createProviderLimitCache } = require('../src/quota/provider-limit-cache');
  const { createLimitRecorder } = require('../src/quota/limit-cache-recorder');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-provider-host-'));
  const cache = createProviderLimitCache({ file: path.join(dir, 'provider-limit-cache.db'), now: () => 1000 });
  cache.record('claude', 'claude-one', {
    kind: 'window',
    summary: { kind: 'window', provider: 'glm', status: 'allowed', usedPercentage: 20, resetsAtMs: 3_601_000 },
    summaryText: '5h 80%',
    barText: '5h 80% {cd:123}',
    fetchedAt: 900,
  });
  const recorder = createLimitRecorder({
    cache,
    persistedSessions: new Map([['s1', { cli: 'claude', provider: 'claude-one' }]]),
    providers: {
      appTypeForCli: () => 'claude',
      listProviders() { return [{ id: 'claude-one', appType: 'claude', name: 'One' }]; },
      getProviderLimitTarget: () => null,
    },
  });
  const harness = createHarness({ providerLimitCache: cache, limitRecorder: recorder });
  const response = await host(harness.app, { op: 'catalog', appType: 'claude' });
  assert.equal(response.body.limitCacheStaleMs, 10 * 60 * 1000);
  assert.equal(response.body.providers.length, 1);
  const limit = response.body.providers[0].limit;
  assert.equal(limit.kind, 'window');
  assert.equal(limit.summaryText, '5h 80%');
  assert.equal(limit.stale, false);
  assert.equal(limit.summary.usedPercentage, 20);
  assert.equal(limit.bar.text, '5h 80% {cd:3601000|5h} · 更新于 {ago:900}');
  assert.equal(require('../public/quota-bar-view').resolveQuotaBar(limit.bar, { now: 1000 }).text,
    '5h 80% 1h · 更新于 刚刚');
  assert.equal(Object.hasOwn(limit, 'barText'), false);
});

test('catalog reports a virtual provider status or the Rust-module fallback', async () => {
  const virtual = { id: 'pool', appType: 'claude', name: 'Pool', virtual: true };
  const harness = createHarness({ providers: { listProviders: () => [virtual] } });
  const response = await host(harness.app, { op: 'catalog' });
  // The virtual status helper is a real module; assert only that the key exists
  // and the provider still renders when the module answers.
  assert.equal(response.body.providers[0].id, 'pool');
  assert.ok(response.body.providers[0].virtualStatus);
});

test('usageStats, import, create and update pass their ok/error shapes through', async () => {
  const harness = createHarness();
  let response = await host(harness.app, { op: 'usageStats' });
  assert.deepEqual(response.body, { ok: true, stats: { stats: [{ providerId: 'claude-one', totalTokens: 3 }], windows: {} } });

  response = await host(harness.app, { op: 'import' });
  assert.deepEqual(response.body, { ok: true, result: { imported: 2, updated: 1, total: 3 } });

  // The front door owns request normalisation (trim, egress parsing); the host
  // hands the already-normalised payload to createProvider verbatim.
  const payload = {
    appType: 'codex',
    name: 'Local Codex',
    baseUrl: 'https://relay.test/v1',
    authToken: 'test-token',
    model: 'gpt-test',
    models: ['gpt-test'],
    aliasMap: { fast: 'gpt-test' },
    egressIpAllowlist: ['203.0.113.7'],
  };
  response = await host(harness.app, { op: 'create', body: payload });
  assert.deepEqual(response.body, { ok: true, result: { id: 'created-id', appType: 'codex', name: 'Local Codex' } });
  assert.deepEqual(harness.calls.at(-1).input, payload);

  // No duplicate validation on the host side: the front door already rejected
  // malformed allowlists, so whatever reaches the host is passed through.
  response = await host(harness.app, { op: 'create', body: { appType: ' codex ', egressIpAllowlist: 'not-an-array' } });
  assert.equal(response.body.ok, true);
  assert.deepEqual(harness.calls.at(-1).input, { appType: ' codex ', egressIpAllowlist: 'not-an-array' });

  response = await host(harness.app, {
    op: 'update',
    appType: 'claude',
    id: 'claude-one',
    body: { name: 'Renamed', egressBinding: { pluginId: 'chrome-proxy-launcher', profileId: 'us-home' } },
  });
  assert.deepEqual(response.body, { ok: true });
  assert.equal(harness.calls.at(-1).method, 'updateProvider');
  assert.equal(harness.calls.at(-1).appType, 'claude');
  assert.deepEqual(harness.calls.at(-1).input.egressBinding,
    { pluginId: 'chrome-proxy-launcher', profileId: 'us-home' });
  assert.equal('egressIpAllowlist' in harness.calls.at(-1).input, false,
    'an absent allowlist stays absent, so the stored one is not cleared');
});

test('public errors redact secrets and absolute paths without changing the DTO fields', async () => {
  const secretError = new Error('/Users/alice/.config/providers.json Authorization: Bearer route-secret');
  secretError.code = 'CC_SWITCH_UNAVAILABLE';
  secretError.reason = 'database /Users/alice/.cc-switch/cc-switch.db token=route-secret';
  const harness = createHarness({
    providers: {
      getProviderUsageStats() { throw secretError; },
      importFromCcSwitch() { throw secretError; },
      createProvider() { throw secretError; },
      updateProvider() { throw secretError; },
    },
  });

  let response = await host(harness.app, { op: 'usageStats' });
  assert.deepEqual(response.body, { ok: false, error: { message: 'provider stats failed' } });

  response = await host(harness.app, { op: 'import' });
  assert.deepEqual(response.body, {
    ok: false,
    error: {
      message: 'provider import failed',
      code: 'CC_SWITCH_UNAVAILABLE',
      reason: 'provider import failed',
    },
  });

  response = await host(harness.app, { op: 'create', body: { appType: 'claude' } });
  assert.deepEqual(response.body, { ok: false, error: { message: 'provider create failed' } });

  response = await host(harness.app, { op: 'update', appType: 'claude', id: 'x', body: {} });
  assert.deepEqual(response.body, { ok: false, error: { message: 'provider update failed' } });

  assert.doesNotMatch(JSON.stringify([response.body]), /route-secret|\/Users\/alice/);
});

test('deleteFacts enumerates references and whether force deletion is possible', async () => {
  const references = [
    { kind: 'main', sessionId: 'session-one', sessionName: 'One' },
    { kind: 'default', cli: 'claude' },
  ];
  let referenceInput;
  const harness = createHarness({
    findProviderReferences(input) { referenceInput = input; return references; },
    applySessionPatch: () => ({ status: 200, body: {} }),
    clearAuxProvider: () => true,
  });
  const response = await host(harness.app, { op: 'deleteFacts', appType: 'claude', id: 'claude-one' });
  assert.deepEqual(response.body, { ok: true, references, forceable: true });
  assert.equal(referenceInput.sessions, harness.deps.persistedSessions);
  assert.deepEqual(referenceInput.defaults, { claude: 'claude-one', codex: null });
  assert.deepEqual(referenceInput.aux, { protocol: 'anthropic', providerId: null });

  const noRuntime = createHarness({ findProviderReferences: () => [] });
  const plain = await host(noRuntime.app, { op: 'deleteFacts', appType: 'claude', id: 'claude-one' });
  assert.deepEqual(plain.body, { ok: true, references: [], forceable: false });
});

test('deleteExec unwires every reference through the session PATCH path, then deletes', async () => {
  const sessions = new Map([
    ['s-main', { id: 's-main', label: 'Main', cli: 'claude', provider: 'claude-one' }],
    ['s-auto', { id: 's-auto', label: 'Auto', cli: 'claude', provider: 'claude-one', providerSelection: {
      version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts: 3,
      candidates: [
        { providerId: 'claude-one', enabled: true },
        { providerId: 'claude-two', enabled: true },
        { providerId: 'claude-three', enabled: true },
      ],
    } }],
    ['s-sub', { id: 's-sub', label: 'Sub', cli: 'claude', provider: null, subagent: { providerId: 'claude-one', model: 'm' } }],
  ]);
  const patches = [];
  const auxCleared = [];
  const references = [
    { kind: 'main', sessionId: 's-main', sessionName: 'Main' },
    { kind: 'main', sessionId: 's-auto', sessionName: 'Auto' },
    { kind: 'auto_candidate', sessionId: 's-auto', sessionName: 'Auto' },
    { kind: 'subagent', sessionId: 's-sub', sessionName: 'Sub' },
    { kind: 'default', cli: 'claude' },
    { kind: 'aux', protocol: 'anthropic' },
  ];
  const harness = createHarness({
    persistedSessions: sessions,
    findProviderReferences: () => references,
    applySessionPatch(sessionId, body) {
      patches.push({ sessionId, body });
      return { status: 200, body: sessionId === 's-main' ? { deferred: true } : {} };
    },
    clearAuxProvider(id) { auxCleared.push(id); return true; },
  });
  const response = await host(harness.app, {
    op: 'deleteExec', appType: 'claude', id: 'claude-one', references,
  });
  assert.deepEqual(response.body.ok, true);
  assert.equal(response.body.deleteOk, true);
  assert.equal(response.body.detached.length, 5);
  assert.equal(response.body.detached.filter(item => item.deferred).length, 1);
  assert.deepEqual(response.body.failed, []);
  assert.deepEqual(patches.map(item => item.sessionId), ['s-main', 's-auto', 's-sub']);
  assert.deepEqual(patches[0].body, { provider: null });
  assert.deepEqual(patches[1].body.providerSelection.candidates.map(item => item.providerId), ['claude-two', 'claude-three']);
  assert.equal(patches[1].body.providerSelection.maxAttempts, 2);
  assert.deepEqual(patches[2].body, { subagent: null });
  assert.deepEqual(auxCleared, ['claude-one']);
  assert.deepEqual(harness.writes.at(-1).value, { claude: null, codex: null });
  assert.deepEqual(harness.deleted, [{ appType: 'claude', id: 'claude-one' }]);
});

test('deleteExec keeps the provider when a reference cannot be detached', async () => {
  const harness = createHarness({
    persistedSessions: new Map([['s1', { id: 's1', label: 'One', cli: 'claude', provider: 'claude-one' }]]),
    applySessionPatch: () => ({ status: 400, body: { error: 'invalid provider' } }),
    clearAuxProvider: () => false,
  });
  const response = await host(harness.app, {
    op: 'deleteExec',
    appType: 'claude',
    id: 'claude-one',
    references: [{ kind: 'main', sessionId: 's1', sessionName: 'One' }],
  });
  assert.equal(response.body.ok, true);
  assert.equal(response.body.deleteOk, false);
  assert.deepEqual(response.body.failed, [{ kind: 'session', sessionId: 's1', sessionName: 'One', error: 'invalid provider' }]);
  assert.deepEqual(harness.deleted, []);
});

test('deleteExec revokes all relay credentials scoped to the deleted provider', async () => {
  const harness = createHarness({ findProviderReferences: () => [] });
  const response = await host(harness.app, { op: 'deleteExec', appType: 'claude', id: 'claude-one', references: [] });
  assert.deepEqual(response.body, { ok: true, deleteOk: true, detached: [], failed: [] });
  assert.deepEqual(harness.deleted, [{ appType: 'claude', id: 'claude-one' }]);
  assert.deepEqual(harness.calls.at(-1), {
    method: 'revokeRelayProvider',
    appType: 'claude',
    providerId: 'claude-one',
  });
});

test('probeFacts answers whether the provider record exists', async () => {
  let harness = createHarness();
  let response = await host(harness.app, { op: 'probeFacts', appType: 'claude', id: 'claude-one' });
  assert.deepEqual(response.body, { ok: true, exists: true });

  harness = createHarness({ providers: { getProvider: () => null } });
  response = await host(harness.app, { op: 'probeFacts', appType: 'claude', id: 'ghost' });
  assert.deepEqual(response.body, { ok: true, exists: false });
});

test('probeExec runs the loopback route and sanitizes the probe output', async () => {
  const asked = [];
  const harness = createHarness({
    providers: {
      claudeProbeRouteEnv(appType, id, port) {
        asked.push({ appType, id, port });
        return {
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/claude-proxy/${id}/probe`,
          ANTHROPIC_AUTH_TOKEN: 'cpr-probe',
          ANTHROPIC_MODEL: 'relay-model',
        };
      },
    },
  });
  const response = await host(harness.app, {
    op: 'probeExec', appType: 'claude', id: 'claude-one', candidates: ['claude-opus-5'],
  });
  assert.deepEqual(asked, [{ appType: 'claude', id: 'claude-one', port: 4321 }]);
  assert.deepEqual(response.body, {
    ok: true,
    result: {
      tested: [{ model: 'claude-opus-5', ok: true, sample: 'probe ok' }],
      accepted: ['claude-opus-5'],
      command: '/usr/local/bin/claude',
      baseUrl: 'http://127.0.0.1:4321/claude-proxy/claude-one/probe',
      envKeys: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL'],
    },
  });

  const secret = createHarness({
    providers: {
      probeRelayModels: async () => ({
        tested: [{
          model: 'safe-model',
          ok: false,
          reason: 'token=probe-secret',
          sample: '/Users/alice/private/probe.log',
        }],
        accepted: [],
        error: 'Authorization: Bearer probe-secret',
      }),
    },
  });
  const sanitized = await host(secret.app, {
    op: 'probeExec', appType: 'claude', id: 'relay', candidates: ['safe-model'],
  });
  assert.deepEqual(sanitized.body.result, {
    tested: [{
      model: 'safe-model',
      ok: false,
      reason: 'provider probe failed',
      sample: 'provider probe output hidden',
    }],
    accepted: [],
    error: 'provider probe failed',
  });
  assert.doesNotMatch(JSON.stringify(sanitized.body), /probe-secret|\/Users\/alice/);
});

test('probeExec reports the no-base-url shape without spawning the CLI', async () => {
  let probeCalls = 0;
  const harness = createHarness({
    providers: {
      claudeProbeRouteEnv: () => null,
      probeRelayModels: async () => { probeCalls += 1; return { tested: [], accepted: [] }; },
    },
  });
  const response = await host(harness.app, {
    op: 'probeExec', appType: 'claude', id: 'claude-official', candidates: ['claude-opus-5'],
  });
  assert.deepEqual(response.body, { ok: true, result: { tested: [], accepted: [], error: 'no base url' } });
  assert.equal(probeCalls, 0);
});

test('probeExec without a provider record answers an error instead of probing nothing', async () => {
  const harness = createHarness({ providers: { getProvider: () => null } });
  const response = await host(harness.app, { op: 'probeExec', appType: 'claude', id: 'ghost' });
  assert.deepEqual(response.body, { ok: false, error: { message: 'provider not found' } });
});

test('reassignFacts and reassignTarget answer the front door before it plans a move', async () => {
  const harness = createHarness({ applySessionPatch: () => ({ status: 200, body: {} }) });
  let response = await host(harness.app, { op: 'reassignFacts', appType: 'claude', id: 'claude-one' });
  assert.deepEqual(response.body, { ok: true, sourceExists: true, patchRuntime: true });

  response = await host(harness.app, { op: 'reassignFacts', appType: 'claude', id: 'ghost' });
  assert.deepEqual(response.body, { ok: true, sourceExists: true, patchRuntime: true });
  const missingSource = createHarness({
    providers: { getProvider: () => null },
    applySessionPatch: () => ({ status: 200, body: {} }),
  });
  response = await host(missingSource.app, { op: 'reassignFacts', appType: 'claude', id: 'ghost' });
  assert.deepEqual(response.body, { ok: true, sourceExists: false, patchRuntime: true });

  const withoutPatch = createHarness();
  response = await host(withoutPatch.app, { op: 'reassignFacts', appType: 'claude', id: 'claude-one' });
  assert.deepEqual(response.body, { ok: true, sourceExists: true, patchRuntime: false });

  response = await host(harness.app, { op: 'reassignTarget', targetProviderId: 'codex-one' });
  assert.deepEqual(response.body, {
    ok: true,
    target: { id: 'codex-one', appType: undefined, name: 'codex-one name', settingsConfig: { env: {} } },
  });
  response = await host(harness.app, { op: 'reassignTarget', targetProviderId: '' });
  assert.deepEqual(response.body, { ok: true, target: null });
});

test('relay-share facts expose the provider name and router summary', async () => {
  const harness = createHarness();
  const response = await host(harness.app, { op: 'relayShareFacts', appType: 'claude', id: 'claude-one' });
  assert.deepEqual(response.body, {
    ok: true,
    provider: { name: 'claude-one name' },
    summary: { id: 'claude-one', appType: 'claude', name: 'Claude One' },
  });

  const missing = createHarness({ providers: { getProvider: () => null } });
  const ghost = await host(missing.app, { op: 'relayShareFacts', appType: 'claude', id: 'ghost' });
  assert.deepEqual(ghost.body.provider, null);
});

test('relayShareCreate mints a provider-scoped credential or reports RELAY_TOKEN_INVALID', async () => {
  const harness = createHarness();
  let response = await host(harness.app, {
    op: 'relayShareCreate',
    appType: 'claude',
    id: 'claude-one',
    providerName: 'Claude One',
    publicBaseUrl: 'https://relay.example',
    relayBaseUrl: 'https://relay.example/claude-proxy/claude-one/remote',
  });
  assert.deepEqual(response.body, {
    ok: false,
    code: 'RELAY_TOKEN_INVALID',
    error: { message: '共享凭据必须为 8–128 位无空格 ASCII 字符' },
  });

  response = await host(harness.app, {
    op: 'relayShareCreate',
    appType: 'claude',
    id: 'claude-one',
    providerName: 'Claude One',
    publicBaseUrl: 'https://relay.example',
    relayBaseUrl: 'https://relay.example/claude-proxy/claude-one/remote',
    token: 'manual-secret',
    label: 'office mac',
  });
  assert.equal(response.body.ok, true);
  assert.equal(response.body.credential, 'mcr1.abcdefghijklmnop.manual-secret');
  assert.equal(response.body.share.label, 'office mac');
  assert.equal(JSON.stringify(response.body.share).includes('manual-secret'), false);
  assert.deepEqual(harness.calls.at(-1).input, {
    appType: 'claude',
    providerId: 'claude-one',
    providerName: 'Claude One',
    publicBaseUrl: 'https://relay.example',
    relayBaseUrl: 'https://relay.example/claude-proxy/claude-one/remote',
    token: 'manual-secret',
    label: 'office mac',
  });
});

test('relayModelsSync distinguishes a missing provider from an unavailable runtime', async () => {
  const calls = [];
  const runtime = {
    async syncProvider(appType, id, options) {
      calls.push({ appType, id, options });
      return { ok: true, changed: true, appType, providerId: id, models: ['gpt-6.1-sol', 'gpt-6-astra'] };
    },
  };
  let harness = createHarness({ relayModelCatalogRuntime: runtime });
  let response = await host(harness.app, { op: 'relayModelsSync', appType: 'codex', id: 'codex-one' });
  assert.equal(response.body.found, true);
  assert.equal(response.body.available, true);
  assert.deepEqual(response.body.result.models, ['gpt-6.1-sol', 'gpt-6-astra']);
  assert.deepEqual(calls, [{ appType: 'codex', id: 'codex-one', options: { force: true } }]);

  harness = createHarness({ providers: { getProvider: () => null }, relayModelCatalogRuntime: runtime });
  response = await host(harness.app, { op: 'relayModelsSync', appType: 'codex', id: 'ghost' });
  assert.deepEqual(response.body, { ok: true, found: false, available: true, result: null });

  harness = createHarness();
  response = await host(harness.app, { op: 'relayModelsSync', appType: 'codex', id: 'codex-one' });
  assert.deepEqual(response.body, { ok: true, found: true, available: false, result: null });
});

test('relay shares list, revoke and re-copy their sealed credential', async () => {
  const harness = createHarness();
  await host(harness.app, {
    op: 'relayShareCreate',
    appType: 'claude',
    id: 'claude-one',
    providerName: 'Claude One',
    publicBaseUrl: 'https://relay.example',
    relayBaseUrl: 'https://relay.example/claude-proxy/claude-one/remote',
    token: 'manual-secret',
  });

  let response = await host(harness.app, { op: 'relaySharesList', appType: 'claude', providerId: 'claude-one' });
  assert.equal(response.body.shares.length, 1);
  assert.equal(response.body.shares[0].status, 'active');
  assert.equal(JSON.stringify(response.body).includes('manual-secret'), false);

  response = await host(harness.app, { op: 'relayShareCodeFacts', id: 'abcdefghijklmnop' });
  assert.equal(response.body.found.ok, true);
  assert.equal(response.body.found.credential, 'mcr1.abcdefghijklmnop.manual-secret');
  assert.deepEqual(response.body.provider, { name: 'claude-one name' });
  assert.deepEqual(response.body.summary, { id: 'claude-one', appType: 'claude', name: 'Claude One' });

  response = await host(harness.app, { op: 'relayShareCodeFacts', id: 'missing' });
  assert.deepEqual(response.body, { ok: true, found: { ok: false, code: 'not_found' } });

  response = await host(harness.app, { op: 'relayShareRevoke', id: 'abcdefghijklmnop' });
  assert.equal(response.body.ok, true);
  assert.equal(response.body.share.status, 'revoked');
  response = await host(harness.app, { op: 'relayShareRevoke', id: 'missing' });
  assert.deepEqual(response.body, { ok: true, share: null });
});

test('relayImportFacts returns the provider, summary and stored import token', async () => {
  const harness = createHarness({
    providers: { getRelayImportToken: () => 'mcr1.fkcxUoqLAyIIVHvF.secret-value' },
    providerRouterRuntime: {
      getProviderSummary: () => ({
        id: 'imp', appType: 'claude', name: 'Claude 账号 · x · 远程共享', model: 'm1', modelOptions: ['m1', 'm2'],
        baseUrl: 'https://lender.example:3000/claude-proxy/claude-official-6dae/remote/v1',
      }),
    },
  });
  const response = await host(harness.app, { op: 'relayImportFacts', appType: 'claude', id: 'imp' });
  assert.deepEqual(response.body, {
    ok: true,
    provider: { name: 'imp name' },
    summary: {
      id: 'imp', appType: 'claude', name: 'Claude 账号 · x · 远程共享', model: 'm1', modelOptions: ['m1', 'm2'],
      baseUrl: 'https://lender.example:3000/claude-proxy/claude-official-6dae/remote/v1',
    },
    token: 'mcr1.fkcxUoqLAyIIVHvF.secret-value',
  });
});

test('defaultsGet, defaultsValidate and defaultsPersist keep the live object identity', async () => {
  const harness = createHarness();
  const live = harness.runtime.providerDefaults;

  let response = await host(harness.app, { op: 'defaultsGet' });
  assert.deepEqual(response.body, { ok: true, defaults: { claude: 'claude-one', codex: null } });

  response = await host(harness.app, { op: 'defaultsValidate', cli: 'zcode', id: '' });
  assert.deepEqual(response.body, { ok: true, valid: true, value: null });
  response = await host(harness.app, { op: 'defaultsValidate', cli: 'zcode', id: 'codex-one' });
  assert.deepEqual(response.body, { ok: true, valid: true, value: 'codex-one' });
  response = await host(harness.app, { op: 'defaultsValidate', cli: 'qoder', id: 'claude-one' });
  assert.deepEqual(response.body, { ok: true, valid: false, value: null });

  response = await host(harness.app, { op: 'defaultsPersist', next: { claude: null, codex: 'codex-one' } });
  assert.deepEqual(response.body, { ok: true, defaults: { claude: null, codex: 'codex-one' } });
  assert.equal(harness.runtime.providerDefaults, live, 'the same object other routes already hold is updated');
  assert.deepEqual(harness.writes, [{
    file: '/runtime/provider-defaults.json',
    value: { claude: null, codex: 'codex-one' },
  }]);
});

test('defaultsPersist keeps best-effort persistence while redacting write failures', async () => {
  const logs = [];
  const harness = createHarness({
    atomicWriteJson() {
      throw new Error('/Users/alice/private/provider-defaults.json token=defaults-secret');
    },
    logger: { error(...args) { logs.push(args); }, warn() {} },
  });
  const response = await host(harness.app, { op: 'defaultsPersist', next: { codex: 'codex-one' } });
  assert.deepEqual(response.body, {
    ok: true,
    defaults: { claude: 'claude-one', codex: 'codex-one' },
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].at(-1), 'save failed');
  assert.doesNotMatch(JSON.stringify(logs), /defaults-secret|\/Users\/alice/);
});

// ── The speed test stays on Node ────────────────────────────────────────────

test('provider speedtest timeout settles once when destroy also emits an error', async () => {
  function timeoutClient() {
    return {
      request() {
        const request = new EventEmitter();
        request.write = () => {};
        request.setTimeout = (delay, callback) => {
          assert.equal(delay, 15000);
          request.timeoutCallback = callback;
        };
        request.destroy = () => request.emit('error', new Error('socket destroyed'));
        request.end = () => queueMicrotask(() => request.timeoutCallback());
        return request;
      },
    };
  }

  for (const appType of ['codex', 'claude']) {
    const client = timeoutClient();
    const harness = createHarness({
      http: client,
      providers: {
        getProvider: () => ({
          settingsConfig: {
            env: {
              ANTHROPIC_BASE_URL: 'https://relay.test',
              ANTHROPIC_API_KEY: 'test-key',
            },
          },
        }),
        resolveCodexDirectHttp: () => ({
          canDirect: true,
          url: 'https://relay.test/v1/chat/completions',
          apiKey: 'test-key',
          model: 'gpt-test',
          wireApi: 'chat-completions',
        }),
      },
    });
    const response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/speedtest', {
      params: { appType, id: `${appType}-one` },
    });
    assert.equal(response.jsonCalls, 1, `${appType} timeout must send exactly one response`);
    assert.deepEqual(response.body, { ok: false, ms: 0, error: 'timeout' });
  }
});

test('provider speedtest bounds an oversized streaming response', async () => {
  const client = {
    request(options, onResponse) {
      const request = new EventEmitter();
      request.write = () => {};
      request.setTimeout = () => {};
      request.destroy = () => request.emit('error', new Error('destroyed after limit'));
      request.end = () => queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 502;
        onResponse(response);
        response.emit('data', Buffer.alloc((64 * 1024) + 1, 65));
        response.emit('end');
      });
      return request;
    },
  };
  const harness = createHarness({
    http: client,
    providers: {
      getProvider: () => ({
        settingsConfig: {
          env: {
            ANTHROPIC_BASE_URL: 'https://relay.test',
            ANTHROPIC_API_KEY: 'test-key',
          },
        },
      }),
    },
  });
  const response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/speedtest', {
    params: { appType: 'claude', id: 'claude-one' },
  });
  assert.equal(response.jsonCalls, 1);
  assert.deepEqual(response.body, {
    ok: false,
    ms: 0,
    status: 502,
    model: 'claude-wire-default',
    error: 'response too large',
  });
});

test('a third-party codex speed test dials the loopback hop, never the vendor', async () => {
  const requests = [];
  const harness = createHarness({
    http: okHttp(requests),
    providers: {
      getProvider: () => ({ settingsConfig: { env: {} } }),
      resolveCodexDirectHttp: () => ({
        canDirect: true,
        url: 'https://vendor.example/v1',
        apiKey: 'codex-vendor-secret',
        model: 'gpt-test',
      }),
    },
  });
  const response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/speedtest', {
    params: { appType: 'codex', id: 'codex-one' },
  });
  assert.equal(requests.length, 1, 'exactly one request, to the local hop');
  assert.equal(requests[0].hostname, '127.0.0.1');
  assert.equal(requests[0].port, 4321);
  assert.equal(requests[0].path, '/codex-proxy/codex-one/responses');
  assert.equal(requests[0].headers.Authorization, undefined, 'the vendor key stays host-side');
  assert.deepEqual(response.body, { ok: true, ms: 0, status: 200, model: 'gpt-test' });
});

test('a borrowed Claude speed test probes a model the lender serves, not the retired wire default', async () => {
  const requests = [];
  const relayBase = 'https://lender.example:3000/claude-proxy/claude-official-abc/remote';
  const relayProvider = {
    id: 'relay', appType: 'claude', name: 'Claude 账号 · x · 远程共享',
    settingsConfig: {
      env: { ANTHROPIC_BASE_URL: relayBase, ANTHROPIC_AUTH_TOKEN: 'mcr1.abcdefghijklmnop.secret' },
    },
  };

  let harness = createHarness({
    http: okHttp(requests),
    providers: { getProvider: () => relayProvider },
    providerRouterRuntime: {
      getProviderSummary: () => ({
        id: 'relay', appType: 'claude', name: relayProvider.name, isOfficial: false,
        model: '', modelOptions: [], baseUrl: relayBase,
      }),
    },
  });
  let response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/speedtest', {
    params: { appType: 'claude', id: 'relay' },
  });
  assert.equal(response.body.ok, true);
  const firstBody = JSON.parse(requests.at(-1).body);
  assert.equal(firstBody.model, 'claude-haiku-4-5');
  assert.notEqual(firstBody.model, 'claude-wire-default');

  requests.length = 0;
  harness = createHarness({
    http: okHttp(requests),
    providers: { getProvider: () => relayProvider },
    providerRouterRuntime: {
      getProviderSummary: () => ({
        id: 'relay', appType: 'claude', name: relayProvider.name, isOfficial: false,
        model: '', modelOptions: ['claude-opus-5[1m]', 'claude-sonnet-5', 'claude-haiku-4-5'],
        baseUrl: relayBase,
      }),
    },
  });
  response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/speedtest', {
    params: { appType: 'claude', id: 'relay' },
  });
  assert.equal(response.body.ok, true);
  const syncedBody = JSON.parse(requests.at(-1).body);
  assert.equal(syncedBody.model, 'claude-haiku-4-5');
});

test('the host port and the speed test cannot reach CPR lifecycle or CC-Switch write APIs', () => {
  let forbiddenRuntimeRead = false;
  const runtime = new Proxy({
    getProviderSummary: () => ({ id: 'claude-one', appType: 'claude' }),
  }, {
    get(target, property, receiver) {
      if (/takeover|restore/i.test(String(property))) forbiddenRuntimeRead = true;
      return Reflect.get(target, property, receiver);
    },
  });
  const harness = createHarness({ providerRouterRuntime: runtime });
  return host(harness.app, { op: 'defaultsGet' }).then(() => {
    assert.equal(forbiddenRuntimeRead, false);

    const providerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'providers.js'), 'utf8');
    const hostSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'providers-host.js'), 'utf8');
    assert.match(hostSource, /providers\.importFromCcSwitch\(\)/);
    for (const source of [providerSource, hostSource]) {
      assert.doesNotMatch(source, /providerRouterRuntime\.[A-Za-z]*(?:takeover|restore)/i);
      assert.doesNotMatch(source, /(?:open|write|update|delete).*cc.?switch/i);
    }
  });
});
