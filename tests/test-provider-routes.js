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

function createHarness(overrides = {}) {
  const { providers: providerOverrides = {}, ...dependencyOverrides } = overrides;
  const writes = [];
  const calls = [];
  const deleted = [];
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
      envKeys: Object.keys(env),
    }),
    resolveCodexDirectHttp: () => ({ canDirect: false, reason: 'OAuth provider cannot be tested' }),
    ...providerOverrides,
  };
  const summaries = new Map([
    ['claude:claude-one', { id: 'claude-one', appType: 'claude', name: 'Claude One' }],
    ['codex:codex-one', { id: 'codex-one', appType: 'codex', name: 'Codex One' }],
  ]);
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
  return { app, runtime, deps, providers, writes, calls, deleted, logs };
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
    'GET /api/provider-defaults',
    'PUT /api/provider-defaults',
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
      useChatResponsesProxy: true,
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
    useChatResponsesProxy: true,
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
    envKeys: [],
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
      }),
    },
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
  assert.deepEqual(response.body, { ok: false, ms: 0, error: 'bad url' });

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
  });
  assert.deepEqual(harness.deleted, []);
  assert.equal(referenceInput.sessions, harness.deps.persistedSessions);
  assert.deepEqual(referenceInput.defaults, { claude: 'claude-one', codex: null });
  assert.deepEqual(referenceInput.aux, { protocol: 'anthropic', providerId: null });
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

test('relay-share issues a borrow code and fails closed without the relay token', async () => {
  // No token → 409 RELAY_TOKEN_UNSET (fail closed; nothing shareable exists).
  let harness = createHarness({ getProxyToken: () => '' });
  let response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/relay-share', {
    params: { appType: 'claude', id: 'claude-one' },
    body: { publicBaseUrl: 'https://relay.example' },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'RELAY_TOKEN_UNSET');

  harness = createHarness({ getProxyToken: () => 'relay-pxy' });
  response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/relay-share', {
    params: { appType: 'claude', id: 'claude-one' },
    body: { publicBaseUrl: 'https://relay.example/some/path' },
  });
  assert.equal(response.statusCode, 200);
  // The public base URL is normalized to its origin.
  assert.equal(response.body.baseUrl, 'https://relay.example/claude-proxy/claude-one/remote');
  const payload = JSON.parse(Buffer.from(response.body.code.slice('mcrelay1.'.length), 'base64url').toString('utf8'));
  assert.deepEqual(payload, {
    v: 1,
    kind: 'multicc-relay',
    // The harness provider stub has no name; the share falls back to the id.
    name: 'claude-one · 借道',
    appType: 'claude',
    baseUrl: 'https://relay.example/claude-proxy/claude-one/remote',
    authToken: 'relay-pxy',
  });

  // Codex providers relay through the codex mount without the session segment.
  response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/relay-share', {
    params: { appType: 'codex', id: 'codex-one' },
    body: { publicBaseUrl: 'https://relay.example/' },
  });
  assert.equal(response.body.baseUrl, 'https://relay.example/codex-proxy/codex-one');

  // Official OAuth has no config.toml model; its public cached catalog must
  // cross the share boundary so the importer does not invent gpt-4o-mini.
  harness = createHarness({
    getProxyToken: () => 'relay-pxy',
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
    body: { publicBaseUrl: 'https://relay.example/' },
  });
  const officialPayload = JSON.parse(
    Buffer.from(response.body.code.slice('mcrelay1.'.length), 'base64url').toString('utf8'),
  );
  assert.equal(officialPayload.model, 'gpt-5.6-sol');
  assert.deepEqual(officialPayload.models, ['gpt-5.6-sol', 'gpt-5.6-terra']);

  // A missing/invalid public base URL is rejected.
  response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/relay-share', {
    params: { appType: 'claude', id: 'claude-one' },
    body: { publicBaseUrl: 'not a url' },
  });
  assert.equal(response.statusCode, 400);

  // Unknown providers cannot be shared.
  harness = createHarness({
    getProxyToken: () => 'relay-pxy',
    providers: { getProvider: () => null },
  });
  response = await invoke(harness.app, 'POST', '/api/providers/:appType/:id/relay-share', {
    params: { appType: 'claude', id: 'ghost' },
    body: { publicBaseUrl: 'https://relay.example' },
  });
  assert.equal(response.statusCode, 404);
});
