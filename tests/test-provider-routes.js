'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createProviderRoutes } = require('../src/routes/providers');

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
      request.write = () => {};
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
      return { id, appType, settingsConfig: { env: {} } };
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
    https: idleHttp(),
    logger: { error(...args) { logs.push(args); } },
    now: () => 100,
    ...dependencyOverrides,
  };
  const app = createApp();
  const runtime = createProviderRoutes(deps);
  runtime.mountCatalogRoutes(app);
  runtime.mountManagementRoutes(app);
  return { app, runtime, deps, providers, writes, calls, deleted, relayShares, logs };
}

test('provider route extraction preserves the mounted surface and response DTOs', async () => {
  const harness = createHarness();
  assert.deepEqual(harness.app.routes, [
    'GET /api/providers',
    'GET /api/providers/stats',
    'POST /api/providers/import',
    'POST /api/providers',
    'PATCH /api/providers/:appType/:id',
    'DELETE /api/providers/:appType/:id',
    'POST /api/providers/:appType/:id/probe',
    'POST /api/providers/:appType/:id/speedtest',
    'POST /api/providers/:appType/:id/relay-share',
    'GET /api/provider-relay-shares',
    'DELETE /api/provider-relay-shares/:id',
    'GET /api/provider-defaults',
    'PUT /api/provider-defaults',
    'POST /api/auto-provider/routing/test',
  ]);

  let response = await invoke(harness.app, 'GET', '/api/providers', {
    query: { appType: 'claude' },
  });
  assert.deepEqual(response.body, {
    available: true,
    ccSwitchAvailable: true,
    ccSwitchStatus: { available: true, dbFound: true, dbPath: '/private/cc-switch.db' },
    providers: [{ id: 'claude-one', appType: 'claude', name: 'One' }],
    defaults: { claude: 'claude-one', codex: null },
    stats: [{ providerId: 'claude-one', totalTokens: 3 }],
    // The provider-limit cache is optional in this harness; a null value means
    // no cache is wired (production always wires one).
    limitCacheStaleMs: null,
  });

  response = await invoke(harness.app, 'GET', '/api/providers/stats');
  assert.deepEqual(response.body, {
    stats: [{ providerId: 'claude-one', totalTokens: 3 }],
    windows: {},
  });

  response = await invoke(harness.app, 'POST', '/api/providers/import');
  assert.deepEqual(response.body, { ok: true, imported: 2, updated: 1, total: 3 });

  response = await invoke(harness.app, 'POST', '/api/providers', {
    body: {
      appType: ' codex ',
      name: 'Local Codex',
      baseUrl: ' https://relay.test/v1 ',
      authToken: ' test-token ',
      model: ' gpt-test ',
      models: ['gpt-test'],
      aliasMap: { fast: 'gpt-test' },
    },
  });
  assert.deepEqual(response.body, {
    ok: true,
    id: 'created-id',
    appType: 'codex',
    name: 'Local Codex',
  });
  assert.deepEqual(harness.calls.at(-1).input, {
    appType: 'codex',
    name: 'Local Codex',
    baseUrl: 'https://relay.test/v1',
    authToken: 'test-token',
    model: 'gpt-test',
    models: ['gpt-test'],
    settingsConfig: undefined,
    aliasMap: { fast: 'gpt-test' },
  });

  response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/probe', {
    params: { appType: 'claude', id: 'claude-one' },
    body: { candidates: ['claude-test'] },
  });
  assert.deepEqual(response.body, {
    tested: [{ model: 'claude-test', ok: true, sample: 'probe ok' }],
    accepted: ['claude-test'],
    command: '/usr/local/bin/claude',
    baseUrl: 'http://127.0.0.1:4321/claude-proxy/claude-one/probe',
    envKeys: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'],
  });

  response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/speedtest', {
    params: { appType: 'codex', id: 'codex-one' },
  });
  assert.deepEqual(response.body, {
    ok: false,
    ms: 0,
    error: 'OAuth provider cannot be tested',
  });

  response = await invoke(harness.app, 'PUT', '/api/provider-defaults', {
    body: { claude: '', codex: 'codex-one' },
  });
  assert.deepEqual(response.body, {
    ok: true,
    defaults: { claude: null, codex: 'codex-one' },
  });
  assert.deepEqual(harness.writes, [{
    file: '/runtime/provider-defaults.json',
    value: { claude: null, codex: 'codex-one' },
  }]);
  assert.deepEqual(harness.runtime.validProviderId('zcode', ''), { ok: true, value: null });
  assert.deepEqual(harness.runtime.validProviderId('zcode', 'claude-one'), { ok: true, value: 'claude-one' });
  assert.deepEqual(harness.runtime.validProviderId('zcode', 'codex-one'), { ok: true, value: 'codex-one' });
  assert.deepEqual(harness.runtime.validProviderId('qoder', 'claude-one'), { ok: false });
});

test('provider route public errors redact secrets and absolute paths without changing DTO fields', async () => {
  const secretError = new Error('/Users/alice/.config/providers.json Authorization: Bearer route-secret');
  secretError.code = 'CC_SWITCH_UNAVAILABLE';
  secretError.reason = 'database /Users/alice/.cc-switch/cc-switch.db token=route-secret';
  const harness = createHarness({
    providers: {
      getCcSwitchStatus: () => ({ available: false }),
      listProviders: () => [],
      getProviderUsageStats() { throw secretError; },
      importFromCcSwitch() { throw secretError; },
      createProvider() { throw secretError; },
      getProvider: () => ({
        settingsConfig: { env: { ANTHROPIC_BASE_URL: 'https://relay.test' } },
      }),
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
      resolveCodexDirectHttp: () => ({
        canDirect: true,
        url: 'not a url token=codex-secret /Users/alice/private',
        apiKey: 'codex-secret',
        model: 'gpt-test',
      }),
      claudeProbeRouteEnv: () => ({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4321/claude-proxy/relay/probe',
        ANTHROPIC_AUTH_TOKEN: 'cpr-probe',
      }),
    },
    // The codex speed test no longer parses that url or dials it: it posts to
    // the loopback hop, so the secret-laden vendor url is never read.
    http: okHttp(),
    https: okHttp(),
  });

  let response = await invoke(harness.app, 'GET', '/api/providers/stats');
  assert.deepEqual(response.body, { error: 'provider stats failed' });

  response = await invoke(harness.app, 'POST', '/api/providers/import');
  assert.deepEqual(response.body, {
    error: 'provider import failed',
    code: 'CC_SWITCH_UNAVAILABLE',
    reason: 'provider import failed',
  });

  response = await invoke(harness.app, 'POST', '/api/providers', {
    body: { appType: 'claude' },
  });
  assert.deepEqual(response.body, { error: 'provider create failed' });

  response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/probe', {
    params: { appType: 'claude', id: 'relay' },
    body: { candidates: ['safe-model'] },
  });
  assert.deepEqual(response.body, {
    tested: [{
      model: 'safe-model',
      ok: false,
      reason: 'provider probe failed',
      sample: 'provider probe output hidden',
    }],
    accepted: [],
    error: 'provider probe failed',
  });

  response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/speedtest', {
    params: { appType: 'codex', id: 'relay' },
  });
  assert.deepEqual(response.body, { ok: true, ms: 0, status: 200, model: 'gpt-test' });

  const serialized = JSON.stringify([
    response.body,
    ...(await Promise.all([
      invoke(harness.app, 'GET', '/api/providers/stats'),
      invoke(harness.app, 'POST', '/api/providers/import'),
    ])).map(item => item.body),
  ]);
  assert.doesNotMatch(serialized, /route-secret|probe-secret|codex-secret|\/Users\/alice/);
});

test('provider deletion retains the exact reference-protection 409 contract', async () => {
  const references = [
    { kind: 'main', sessionId: 'session-one', sessionName: 'One' },
    { kind: 'default', cli: 'claude' },
  ];
  let referenceInput;
  const harness = createHarness({
    findProviderReferences(input) {
      referenceInput = input;
      return references;
    },
  });
  const response = await invoke(harness.app, 'DELETE', '/api/providers/:appType/:id', {
    params: { appType: 'claude', id: 'claude-one' },
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body, {
    error: 'provider is still referenced',
    code: 'PROVIDER_IN_USE',
    references,
    forceable: false,
  });
  assert.deepEqual(harness.deleted, []);
  assert.equal(referenceInput.sessions, harness.deps.persistedSessions);
  assert.deepEqual(referenceInput.defaults, { claude: 'claude-one', codex: null });
  assert.deepEqual(referenceInput.aux, { protocol: 'anthropic', providerId: null });
});

test('force deletion unwires every reference through the session PATCH path, then deletes', async () => {
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
  const harness = createHarness({
    persistedSessions: sessions,
    findProviderReferences: () => [
      { kind: 'main', sessionId: 's-main', sessionName: 'Main' },
      { kind: 'main', sessionId: 's-auto', sessionName: 'Auto' },
      { kind: 'auto_candidate', sessionId: 's-auto', sessionName: 'Auto' },
      { kind: 'subagent', sessionId: 's-sub', sessionName: 'Sub' },
      { kind: 'default', cli: 'claude' },
      { kind: 'aux', protocol: 'anthropic' },
    ],
    applySessionPatch(sessionId, body) {
      patches.push({ sessionId, body });
      return { status: 200, body: sessionId === 's-main' ? { deferred: true } : {} };
    },
    clearAuxProvider(id) { auxCleared.push(id); return true; },
    logger: { error() {}, warn() {} },
  });
  const response = await invoke(harness.app, 'DELETE', '/api/providers/:appType/:id', {
    params: { appType: 'claude', id: 'claude-one' },
    query: { force: '1' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.forced, true);
  assert.equal(response.body.detached.length, 5);
  assert.equal(response.body.detached.filter(item => item.deferred).length, 1);
  assert.deepEqual(patches.map(item => item.sessionId), ['s-main', 's-auto', 's-sub']);
  assert.deepEqual(patches[0].body, { provider: null });
  assert.deepEqual(patches[1].body.providerSelection.candidates.map(item => item.providerId), ['claude-two', 'claude-three']);
  assert.equal(patches[1].body.providerSelection.maxAttempts, 2);
  assert.deepEqual(patches[2].body, { subagent: null });
  assert.deepEqual(auxCleared, ['claude-one']);
  assert.deepEqual(harness.writes.at(-1).value, { claude: null, codex: null });
  assert.deepEqual(harness.deleted, [{ appType: 'claude', id: 'claude-one' }]);
});

test('force deletion keeps the provider when a reference cannot be detached', async () => {
  const harness = createHarness({
    persistedSessions: new Map([['s1', { id: 's1', label: 'One', cli: 'claude', provider: 'claude-one' }]]),
    findProviderReferences: () => [{ kind: 'main', sessionId: 's1', sessionName: 'One' }],
    applySessionPatch: () => ({ status: 400, body: { error: 'invalid provider' } }),
    clearAuxProvider: () => false,
  });
  const response = await invoke(harness.app, 'DELETE', '/api/providers/:appType/:id', {
    params: { appType: 'claude', id: 'claude-one' },
    query: { force: 'true' },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'PROVIDER_DETACH_FAILED');
  assert.deepEqual(response.body.references, [{ kind: 'session', sessionId: 's1', sessionName: 'One', error: 'invalid provider' }]);
  assert.deepEqual(harness.deleted, []);
});

test('force detach plan falls back to manual when the trimmed Auto pool no longer validates', () => {
  const { sessionDetachPlan } = require('../src/providers/force-detach');
  const twoCandidates = sessionDetachPlan({ provider: 'a', providerSelection: {
    mode: 'auto', candidates: [{ providerId: 'a', enabled: true }, { providerId: 'b', enabled: true }],
  } }, 'a');
  assert.deepEqual(twoCandidates, { body: { providerSelection: null, provider: 'b' }, fallback: null });
  const threeCandidates = sessionDetachPlan({ provider: 'b', providerSelection: {
    mode: 'auto', maxAttempts: 3, candidates: [
      { providerId: 'a', enabled: true }, { providerId: 'b', enabled: true }, { providerId: 'c', enabled: true },
    ],
  }, subagent: { providerId: 'a', model: 'x' } }, 'a');
  assert.equal(threeCandidates.body.subagent, null);
  assert.deepEqual(threeCandidates.fallback, { providerSelection: null, provider: 'b' });
  // A staged (next-turn) edit is the state being detached, not the live one.
  const staged = sessionDetachPlan({ provider: 'a', pendingConfiguration: { cli: 'claude', profile: { provider: 'z' } } }, 'a');
  assert.deepEqual(staged.body, {});
});

test('provider deletion revokes all credentials scoped to that provider', async () => {
  const harness = createHarness({ findProviderReferences: () => [] });
  const response = await invoke(harness.app, 'DELETE', '/api/providers/:appType/:id', {
    params: { appType: 'claude', id: 'claude-one' },
  });
  assert.deepEqual(response.body, { ok: true });
  assert.deepEqual(harness.deleted, [{ appType: 'claude', id: 'claude-one' }]);
  assert.deepEqual(harness.calls.at(-1), {
    method: 'revokeRelayProvider',
    appType: 'claude',
    providerId: 'claude-one',
  });
});

test('provider defaults keep best-effort persistence while redacting write failures', async () => {
  const logs = [];
  const harness = createHarness({
    atomicWriteJson() {
      throw new Error('/Users/alice/private/provider-defaults.json token=defaults-secret');
    },
    logger: { error(...args) { logs.push(args); } },
  });
  const response = await invoke(harness.app, 'PUT', '/api/provider-defaults', {
    body: { codex: 'codex-one' },
  });
  assert.deepEqual(response.body, {
    ok: true,
    defaults: { claude: 'claude-one', codex: 'codex-one' },
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].at(-1), 'save failed');
  assert.doesNotMatch(JSON.stringify(logs), /defaults-secret|\/Users\/alice/);
});

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
      https: client,
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

test('provider probe validates bounded model candidates before spawning the CLI', async () => {
  let probeCalls = 0;
  const harness = createHarness({
    providers: {
      probeRelayModels: async (env, candidates) => {
        probeCalls++;
        return { tested: [], accepted: candidates || [] };
      },
    },
  });
  let response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/probe', {
    params: { appType: 'claude', id: 'claude-one' },
    body: { candidates: Array.from({ length: 21 }, (_, index) => `model-${index}`) },
  });
  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.body, { error: 'too many probe candidates' });
  assert.equal(probeCalls, 0);

  response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/probe', {
    params: { appType: 'claude', id: 'claude-one' },
    body: { candidates: ['x'.repeat(201)] },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { error: 'invalid probe candidate' });
  assert.equal(probeCalls, 0);

  response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/probe', {
    params: { appType: 'claude', id: 'claude-one' },
    body: { candidates: [' model-a ', 'model-a', 'model-b'] },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.accepted, ['model-a', 'model-b']);
  assert.equal(probeCalls, 1);
});

test('the model probe runs on the loopback route, not the provider endpoint', async () => {
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
  const summary = harness.deps.providerRouterRuntime.getProviderSummary('claude', 'claude-one');
  const response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/probe', {
    params: { appType: 'claude', id: 'claude-one' },
    body: { candidates: ['claude-opus-5'] },
  });
  assert.deepEqual(asked, [{ appType: 'claude', id: 'claude-one', port: 4321 }]);
  assert.equal(response.body.baseUrl, 'http://127.0.0.1:4321/claude-proxy/claude-one/probe');
  assert.match(response.body.baseUrl, /^http:\/\/127\.0\.0\.1:/, 'the CLI child is pointed at the hop');
  assert.deepEqual(response.body.accepted, ['claude-opus-5']);
});

test('a probe with no upstream to forward to reports no base url without spawning', async () => {
  let probeCalls = 0;
  const harness = createHarness({
    providers: {
      claudeProbeRouteEnv: () => null,
      probeRelayModels: async () => { probeCalls += 1; return { tested: [], accepted: [] }; },
    },
  });
  const response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/probe', {
    params: { appType: 'claude', id: 'claude-official' },
    body: { candidates: ['claude-opus-5'] },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { tested: [], accepted: [], error: 'no base url' });
  assert.equal(probeCalls, 0);
});

test('a third-party codex speed test dials the loopback hop, never the vendor', async () => {
  const requests = [];
  const harness = createHarness({
    http: okHttp(requests),
    https: okHttp(requests),
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

test('provider defaults validate the full request before changing live state', async () => {
  const harness = createHarness();
  const response = await invoke(harness.app, 'PUT', '/api/provider-defaults', {
    body: { claude: '', codex: 'missing-provider' },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { error: 'invalid codex provider id' });
  assert.deepEqual(harness.runtime.providerDefaults, { claude: 'claude-one', codex: null });
  assert.deepEqual(harness.writes, []);
});

test('provider route composition cannot reach CPR lifecycle or CC-Switch write APIs', async () => {
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
  const response = await invoke(harness.app, 'PUT', '/api/provider-defaults', {
    body: { claude: 'claude-one' },
  });
  assert.equal(response.body.ok, true);
  assert.equal(forbiddenRuntimeRead, false);

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'providers.js'), 'utf8');
  assert.match(source, /providers\.importFromCcSwitch\(\)/);
  assert.doesNotMatch(source, /providerRouterRuntime\.[A-Za-z]*(?:takeover|restore)/i);
  assert.doesNotMatch(source, /\/api\/providers\/(?:takeover|restore)/i);
  assert.doesNotMatch(source, /(?:open|write|update|delete).*cc.?switch/i);
});

test('GET /api/providers attaches the persisted limit summary and freshness', async () => {
  const { createProviderLimitCache } = require('../src/quota/provider-limit-cache');
  const { createLimitRecorder } = require('../src/quota/limit-cache-recorder');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'multicc-provider-routes-'));
  const cacheFile = path.join(dir, 'provider-limit-cache.db');
  const cache = createProviderLimitCache({ file: cacheFile, now: () => 1000 });
  // Seed one provider's last-known-good summary.
  cache.record('claude', 'claude-one', {
    kind: 'window',
    summary: { kind: 'window', provider: 'glm', status: 'allowed', usedPercentage: 20 },
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
  const response = await invoke(harness.app, 'GET', '/api/providers', { query: { appType: 'claude' } });
  assert.equal(response.body.limitCacheStaleMs, 10 * 60 * 1000);
  assert.equal(response.body.providers.length, 1);
  const limit = response.body.providers[0].limit;
  assert.equal(limit.kind, 'window');
  assert.equal(limit.summaryText, '5h 80%');
  assert.equal(limit.stale, false); // fetchedAt 900, now 1000, window 600s
  assert.equal(limit.summary.usedPercentage, 20);
  // The public projection never leaks the raw bar placeholders.
  assert.equal(JSON.stringify(limit).includes('{cd'), false);
  // Deleting the provider prunes the orphan on the next catalog read.
  assert.equal(cache.get('claude', 'claude-one') !== null, true);
});

test('relay-share issues a recorded provider-scoped credential and requires a manual token', async () => {
  let harness = createHarness();
  let response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/relay-share', {
    params: { appType: 'claude', id: 'claude-one' },
    body: { publicBaseUrl: 'https://relay.example' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'RELAY_TOKEN_INVALID');

  response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/relay-share', {
    params: { appType: 'claude', id: 'claude-one' },
    body: {
      publicBaseUrl: 'https://relay.example/some/path',
      token: 'manual-secret',
      label: 'office mac',
    },
  });
  assert.equal(response.statusCode, 200);
  // The public base URL is normalized to its origin.
  assert.equal(response.body.baseUrl, 'https://relay.example/claude-proxy/claude-one/remote');
  const payload = JSON.parse(Buffer.from(response.body.code.slice('mcrelay1.'.length), 'base64url').toString('utf8'));
  assert.deepEqual(payload, {
    v: 2,
    kind: 'multicc-relay',
    // The harness provider stub has no name; the share falls back to the id.
    name: 'claude-one · 借道',
    appType: 'claude',
    baseUrl: 'https://relay.example/claude-proxy/claude-one/remote',
    relayShareId: 'abcdefghijklmnop',
    authToken: 'mcr1.abcdefghijklmnop.manual-secret',
  });
  assert.equal(response.body.share.label, 'office mac');
  assert.equal(JSON.stringify(response.body.share).includes('manual-secret'), false);
  assert.equal(harness.calls.at(-1).method, 'createRelayShare');

  // Codex providers relay through the codex mount without the session segment.
  response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/relay-share', {
    params: { appType: 'codex', id: 'codex-one' },
    body: { publicBaseUrl: 'https://relay.example/', token: 'codex-secret' },
  });
  assert.equal(response.body.baseUrl, 'https://relay.example/codex-proxy/codex-one');

  // Official OAuth has no config.toml model; its public cached catalog must
  // cross the share boundary so the importer does not invent gpt-4o-mini.
  harness = createHarness({
    providers: {
      getProvider: (appType, id) => ({
        id, appType, name: 'OpenAI Official',
        settingsConfig: { auth: { auth_mode: 'chatgpt' } },
      }),
    },
    providerRouterRuntime: {
      getProviderSummary: () => ({
        id: 'official', appType: 'codex', model: '',
        modelOptions: ['gpt-5.6-sol', 'gpt-5.6-terra'],
      }),
    },
  });
  response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/relay-share', {
    params: { appType: 'codex', id: 'official' },
    body: { publicBaseUrl: 'https://relay.example/', token: 'official-secret' },
  });
  const officialPayload = JSON.parse(
    Buffer.from(response.body.code.slice('mcrelay1.'.length), 'base64url').toString('utf8'),
  );
  assert.equal(officialPayload.model, 'gpt-5.6-sol');
  assert.deepEqual(officialPayload.models, ['gpt-5.6-sol', 'gpt-5.6-terra']);

  // A missing/invalid public base URL is rejected.
  response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/relay-share', {
    params: { appType: 'claude', id: 'claude-one' },
    body: { publicBaseUrl: 'not a url', token: 'manual-secret' },
  });
  assert.equal(response.statusCode, 400);

  // Unknown providers cannot be shared.
  harness = createHarness({ providers: { getProvider: () => null } });
  response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/relay-share', {
    params: { appType: 'claude', id: 'ghost' },
    body: { publicBaseUrl: 'https://relay.example' },
  });
  assert.equal(response.statusCode, 404);
});

test('relay-share inventory lists and revokes durable records without returning credentials', async () => {
  const harness = createHarness();
  await invoke(harness.app, 'POST', '/api/providers/:appType/:id/relay-share', {
    params: { appType: 'claude', id: 'claude-one' },
    body: { publicBaseUrl: 'https://relay.example', token: 'manual-secret' },
  });
  let response = await invoke(harness.app, 'GET', '/api/provider-relay-shares', {
    query: { appType: 'claude', providerId: 'claude-one' },
  });
  assert.equal(response.body.shares.length, 1);
  assert.equal(response.body.shares[0].status, 'active');
  assert.equal(JSON.stringify(response.body).includes('manual-secret'), false);

  response = await invoke(harness.app, 'DELETE', '/api/provider-relay-shares/:id', {
    params: { id: 'abcdefghijklmnop' },
  });
  assert.equal(response.body.ok, true);
  assert.equal(response.body.share.status, 'revoked');
  response = await invoke(harness.app, 'DELETE', '/api/provider-relay-shares/:id', {
    params: { id: 'missing-relay-share' },
  });
  assert.equal(response.statusCode, 404);
});
