'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { REQUIRED_CAPABILITIES } = require('../src/provider-router-port');
const {
  createHostEmbeddingPaths,
  createProviderRouterRuntime,
  resolveMode,
} = require('../src/provider-router-runtime');

function capabilitySet(overrides = {}) {
  return {
    ...Object.fromEntries(Object.keys(REQUIRED_CAPABILITIES).map(name => [name, '1.0.0'])),
    ...overrides,
  };
}

function fakeProviders(calls = []) {
  const provider = {
    id: 'p1', appType: 'codex', name: 'Provider One', model: 'm1',
    modelOptions: ['m1'], baseUrl: 'https://example.test/v1?token=summary-secret',
    authToken: 'provider-secret', aliasMap: { opus: { model: 'm1', name: 'One' } },
  };
  return {
    CODEX_HOMES_DIR: '/multicc/codex-homes',
    getProvider(appType, id) {
      calls.push({ method: 'getProvider', appType, id });
      return id === 'p1' ? provider : null;
    },
    getProviderSummary(appType, id) {
      calls.push({ method: 'getProviderSummary', appType, id });
      return id === 'p1' ? provider : null;
    },
    resolveSpawnEnv(binding) {
      calls.push({ method: 'legacyResolveSpawnEnv', binding });
      return {
        env: binding.cli === 'codex' && binding.provider
          ? { CODEX_HOME: `/multicc/codex-homes/${binding.provider}` }
          : {},
        providerName: binding.provider ? 'Provider One' : null,
        providerModel: null,
        providerModels: [],
        skipDefaultModel: false,
        aliasOnly: false,
      };
    },
    buildChildEnv(base, binding, extra) {
      calls.push({ method: 'legacyBuildChildEnv', binding });
      return { env: { ...base, ...extra }, skipDefaultModel: false };
    },
    resolveSessionWireModel(model) {
      calls.push({ method: 'legacyResolveSessionWireModel', model });
      return `legacy:${model}`;
    },
  };
}

function fakeRouter(calls = [], overrides = {}) {
  return {
    API_VERSION: overrides.API_VERSION || '1.2.0',
    CAPABILITIES: overrides.CAPABILITIES || capabilitySet(),
    resolveSpawnEnv(input) {
      calls.push({ method: 'cprResolveSpawnEnv', input });
      return {
        env: input.cli === 'codex' && input.providerId
          ? { CODEX_HOME: path.join(input.codexHomesDir, input.providerId) }
          : {},
        providerName: input.providerId ? 'Provider One' : null,
        providerModel: null,
        providerModels: [],
        skipDefaultModel: false,
        aliasOnly: false,
      };
    },
    buildChildEnv(base, input, extra) {
      calls.push({ method: 'cprBuildChildEnv', input });
      return { env: { ...base, ...extra, ...this.resolveSpawnEnv(input).env } };
    },
    resolveSessionWireModel(model) {
      calls.push({ method: 'cprResolveSessionWireModel', model });
      return `cpr:${model}`;
    },
    normalizeUsageEvent(input) {
      calls.push({ method: 'cprNormalizeUsageEvent' });
      return input;
    },
    mountClaudeProxy(app, options) {
      calls.push({ method: 'mountClaudeProxy', options });
      return 'claude-mounted';
    },
    mountCodexProxy(app, options) {
      calls.push({ method: 'mountCodexProxy', options });
      return 'codex-mounted';
    },
  };
}

const HOST = Object.freeze({ dataRoot: '/multicc/data', codexHomesDir: '/multicc/codex-homes' });

function listenLocal(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      url: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

function closeLocal(server) {
  return new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

function postJson({ port, pathname, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        ...headers,
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

function integrationProviders(upstreamUrl) {
  const values = {
    claude: {
      'claude-local': {
        id: 'claude-local',
        appType: 'claude',
        name: 'Local Claude',
        model: 'claude-wire-model',
        settingsConfig: {
          env: {
            ANTHROPIC_BASE_URL: `${upstreamUrl}/anthropic`,
            ANTHROPIC_AUTH_TOKEN: 'claude-upstream-secret',
          },
        },
      },
    },
    codex: {
      'codex-local': {
        id: 'codex-local',
        appType: 'codex',
        name: 'Local Codex',
        model: 'codex-wire-model',
        settingsConfig: {
          auth: { OPENAI_API_KEY: 'codex-upstream-secret' },
          config: [
            'model_provider = "local"',
            'model = "codex-wire-model"',
            '[model_providers.local]',
            'name = "Local Codex"',
            `base_url = "${upstreamUrl}/openai/v1"`,
            'wire_api = "responses"',
            'requires_openai_auth = true',
            '',
          ].join('\n'),
        },
      },
    },
  };
  return {
    CODEX_HOMES_DIR: '/unused-legacy-codex-homes',
    getProvider(appType, id) { return values[appType] && values[appType][id] || null; },
    getProviderSummary(appType, id) { return this.getProvider(appType, id); },
    resolveSpawnEnv() { return { env: {}, skipDefaultModel: false, aliasOnly: false }; },
    buildChildEnv(base, _binding, extra) { return { env: { ...base, ...extra }, skipDefaultModel: false }; },
    resolveSessionWireModel(model) { return model; },
  };
}

test('runtime defaults to legacy and an explicit CPR 0.2 router is never advertised as production cpr', () => {
  assert.equal(resolveMode({}), 'legacy');
  const providers = fakeProviders();
  const oldRouter = fakeRouter([], { API_VERSION: '0.2.0' });
  const legacy = createProviderRouterRuntime({
    providers,
    router: oldRouter,
    ...HOST,
  });
  assert.equal(legacy.mode, 'legacy');

  assert.throws(
    () => createProviderRouterRuntime({ mode: 'cpr', providers, router: oldRouter, ...HOST }),
    error => error.code === 'CPR_LEGACY_ONLY' && /0\.2\.0/.test(error.message),
  );
  assert.throws(
    () => createProviderRouterRuntime({ mode: 'shadow', providers, router: oldRouter, ...HOST }),
    error => error.code === 'CPR_LEGACY_ONLY',
  );
});

test('installed CPR 0.3 cpr mode proxies Claude and Codex through explicit host paths', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cpr-mode-integration-'));
  const dataRoot = path.join(temp, 'multicc-data');
  const codexHomesDir = path.join(temp, 'multicc-codex-homes');
  const forbiddenDefaultHome = path.join(temp, 'default-cpr-home-must-not-exist');
  const oldCprHome = process.env.CPR_HOME;
  process.env.CPR_HOME = forbiddenDefaultHome;

  const upstreamRequests = [];
  let upstream;
  let proxy;
  try {
    upstream = await listenLocal((request, response) => {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        upstreamRequests.push({ url: request.url, headers: request.headers, body });
        if (request.url === '/anthropic/v1/messages') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            id: 'msg_local',
            type: 'message',
            content: [{ type: 'text', text: 'CLAUDE_LOCAL_OK' }],
            usage: {
              input_tokens: 3,
              output_tokens: 2,
              cache_read_input_tokens: 1,
              cache_creation_input_tokens: 0,
            },
          }));
          return;
        }
        if (request.url === '/openai/v1/responses') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            id: 'resp_local',
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'CODEX_LOCAL_OK' }] }],
            usage: {
              input_tokens: 7,
              input_tokens_details: { cached_tokens: 2 },
              output_tokens: 4,
            },
          }));
          return;
        }
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unexpected local upstream path' }));
      });
    });

    const router = require('cli-provider-router');
    const packageVersion = require('cli-provider-router/package.json').version;
    assert.match(packageVersion, /^0\.3\./);
    assert.match(String(router.API_VERSION), /^1\./);

    const providers = integrationProviders(upstream.url);
    const usageObserved = [];
    const runtime = createProviderRouterRuntime({
      mode: 'cpr',
      providers,
      router,
      dataRoot,
      codexHomesDir,
    });
    assert.equal(runtime.embeddingPaths.cprPaths.home, path.join(dataRoot, '.provider-router-host'));
    assert.equal(runtime.embeddingPaths.codexHomesDir, codexHomesDir);

    const app = express();
    runtime.mountProtocolProxies(app, {
      protocols: ['claude'],
      onUsageObserved: event => usageObserved.push(event),
    });
    app.use(express.json());
    runtime.mountProtocolProxies(app, {
      protocols: ['codex'],
      onUsageObserved: event => usageObserved.push(event),
    });
    proxy = await listenLocal(app);

    const claudeResponse = await postJson({
      port: proxy.port,
      pathname: '/claude-proxy/claude-local/session-claude/v1/messages',
      headers: {
        authorization: 'Bearer virtual-claude-token',
        'x-api-key': 'virtual-claude-key',
      },
      body: { model: 'claude-wire-model', messages: [], stream: false },
    });
    const codexResponse = await postJson({
      port: proxy.port,
      pathname: '/codex-proxy/codex-local/session-codex/main/responses',
      headers: { authorization: 'Bearer virtual-codex-token' },
      body: { model: 'codex-wire-model', input: [], stream: false },
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(claudeResponse.status, 200);
    assert.equal(JSON.parse(claudeResponse.body).content[0].text, 'CLAUDE_LOCAL_OK');
    assert.equal(codexResponse.status, 200);
    assert.equal(JSON.parse(codexResponse.body).output[0].content[0].text, 'CODEX_LOCAL_OK');

    assert.equal(upstreamRequests.length, 2);
    const claudeUpstream = upstreamRequests.find(entry => entry.url === '/anthropic/v1/messages');
    const codexUpstream = upstreamRequests.find(entry => entry.url === '/openai/v1/responses');
    assert.ok(claudeUpstream);
    assert.ok(codexUpstream);
    assert.equal(claudeUpstream.headers.authorization, 'Bearer claude-upstream-secret');
    assert.equal(claudeUpstream.headers['x-api-key'], undefined);
    assert.equal(JSON.parse(claudeUpstream.body).model, 'claude-wire-model');
    assert.equal(codexUpstream.headers.authorization, 'Bearer codex-upstream-secret');
    assert.equal(JSON.parse(codexUpstream.body).model, 'codex-wire-model');

    assert.equal(usageObserved.length, 2);
    const claudeUsage = usageObserved.find(event => event.protocol === 'anthropic-messages');
    const codexUsage = usageObserved.find(event => event.protocol === 'openai-responses');
    assert.deepEqual({
      sessionId: claudeUsage.sessionId,
      providerId: claudeUsage.providerId,
      roleKind: claudeUsage.roleKind,
      routeName: claudeUsage.routeName,
      model: claudeUsage.model,
      tokens: claudeUsage.tokens,
    }, {
      sessionId: 'session-claude',
      providerId: 'claude-local',
      roleKind: 'main',
      routeName: 'main',
      model: 'claude-wire-model',
      tokens: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, total: 5 },
    });
    assert.deepEqual({
      sessionId: codexUsage.sessionId,
      providerId: codexUsage.providerId,
      roleKind: codexUsage.roleKind,
      routeName: codexUsage.routeName,
      model: codexUsage.model,
      tokens: codexUsage.tokens,
    }, {
      sessionId: 'session-codex',
      providerId: 'codex-local',
      roleKind: 'main',
      routeName: 'main',
      model: 'codex-wire-model',
      tokens: { input: 5, output: 4, cacheRead: 2, cacheWrite: 0, total: 9 },
    });

    assert.equal(fs.existsSync(forbiddenDefaultHome), false);
    assert.equal(fs.existsSync(runtime.embeddingPaths.cprPaths.runDir), true);
    assert.equal(fs.existsSync(codexHomesDir), true);
    assert.equal(path.dirname(codexHomesDir), temp);
  } finally {
    if (proxy) await closeLocal(proxy.server);
    if (upstream) await closeLocal(upstream.server);
    if (oldCprHome === undefined) delete process.env.CPR_HOME;
    else process.env.CPR_HOME = oldCprHome;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('installed CPR 0.3 negotiates the production API and required capabilities', (t) => {
  const router = require('cli-provider-router');
  const packageVersion = require('cli-provider-router/package.json').version;
  const routerApiVersion = String(router.API_VERSION || '');
  const routerApiMajor = Number.parseInt(routerApiVersion.split('.')[0], 10);
  const isLegacyRouter = /^0\.2(?:\.|$)/.test(packageVersion) || routerApiMajor === 0;
  if (isLegacyRouter) {
    assert.throws(
      () => createProviderRouterRuntime({ mode: 'cpr', providers: fakeProviders(), router, ...HOST }),
      error => error.code === 'CPR_LEGACY_ONLY',
    );
    if (process.env.MULTICC_REQUIRE_CPR_V1 === '1') {
      assert.fail(`installed CPR ${packageVersion} (API ${routerApiVersion || 'missing'}) does not satisfy the production CPR v1 gate`);
    }
    t.skip(`installed CPR ${packageVersion} (API ${routerApiVersion || 'missing'}) is explicitly blocked; rerun with MULTICC_REQUIRE_CPR_V1=1 after upgrading`);
    return;
  }

  assert.match(packageVersion, /^0\.3\./);
  assert.equal(routerApiMajor, 1, `CPR ${packageVersion} must expose API major 1, received ${routerApiVersion || 'missing'}`);
  const runtime = createProviderRouterRuntime({
    mode: 'cpr', providers: fakeProviders(), router, ...HOST,
  });
  assert.equal(runtime.mode, 'cpr');
  assert.equal(runtime.routerApiVersion, '1.0.0');
  assert.deepEqual(runtime.routerCapabilities, Object.fromEntries(
    Object.keys(REQUIRED_CAPABILITIES).map(name => [name, '1.0']),
  ));
});

test('legacy CPR 0.2 proxy usage enters the standardized UsageObserved callback', () => {
  const calls = [];
  const router = fakeRouter(calls, { API_VERSION: '0.2.0' });
  delete router.normalizeUsageEvent;
  const runtime = createProviderRouterRuntime({ providers: fakeProviders(), router, now: () => 1_750_000_000_000, ...HOST });
  const observed = [];
  runtime.mountProtocolProxies({ use() {} }, {
    protocols: ['claude'],
    onUsageObserved: event => observed.push(event),
  });
  const mounted = calls.find(call => call.method === 'mountClaudeProxy').options;
  assert.equal(mounted.onUsageEvent, undefined);
  assert.equal(typeof mounted.onUsage, 'function');
  mounted.onUsage({
    sessionId: 's1', role: 'sub', providerId: 'p1', providerName: 'Provider One', model: 'm1',
    usage: { inputTokens: 5, outputTokens: 2, cacheRead: 1, cacheWrite: 0 },
  });
  assert.equal(observed.length, 1);
  assert.match(observed[0].eventId, /^uo_[a-f0-9]{32}$/);
  assert.equal(observed[0].coverage, 'observed');
  assert.equal(observed[0].source, 'exact');
  assert.equal(observed[0].roleKind, 'sub');
  assert.equal(observed[0].agentRole, 'default');
  assert.equal(observed[0].routeName, 'default');
  assert.deepEqual(observed[0].tokens, { input: 5, output: 2, cacheRead: 1, cacheWrite: 0, total: 7 });
});

test('cpr runtime fails closed on API major, capability and host path mismatches', () => {
  const providers = fakeProviders();
  assert.throws(
    () => createProviderRouterRuntime({ mode: 'cpr', providers, router: fakeRouter([], { API_VERSION: '2.0.0' }), ...HOST }),
    error => error.code === 'CPR_API_MAJOR_MISMATCH',
  );
  const missing = capabilitySet();
  delete missing.protocolProxy;
  assert.throws(
    () => createProviderRouterRuntime({ mode: 'cpr', providers, router: fakeRouter([], { CAPABILITIES: missing }), ...HOST }),
    error => error.code === 'CPR_CAPABILITY_MISSING',
  );
  assert.throws(
    () => createProviderRouterRuntime({ mode: 'cpr', providers, router: fakeRouter(), dataRoot: 'relative', codexHomesDir: HOST.codexHomesDir }),
    error => error.code === 'CPR_HOST_PATHS_REQUIRED',
  );
});

test('host embedding uses explicit MultiCC paths without reading CPR_HOME or creating it', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-router-paths-'));
  const defaultCprHome = path.join(temp, 'must-not-exist');
  const old = process.env.CPR_HOME;
  process.env.CPR_HOME = defaultCprHome;
  try {
    const embedding = createHostEmbeddingPaths({
      dataRoot: temp,
      codexHomesDir: path.join(temp, 'multicc-codex-homes'),
    });
    assert.equal(embedding.cprPaths.home, path.join(temp, '.provider-router-host'));
    assert.equal(embedding.codexHomesDir, path.join(temp, 'multicc-codex-homes'));
    assert.equal(fs.existsSync(embedding.cprPaths.home), false);
    assert.equal(fs.existsSync(defaultCprHome), false);
  } finally {
    if (old === undefined) delete process.env.CPR_HOME;
    else process.env.CPR_HOME = old;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('cpr receives a narrow binding, explicit CODEX_HOME and no takeover surface', () => {
  const calls = [];
  let takeoverTouched = false;
  const router = new Proxy(fakeRouter(calls), {
    get(target, property, receiver) {
      if (/takeover|restore/i.test(String(property))) {
        takeoverTouched = true;
        throw new Error('management API must not be reached');
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const runtime = createProviderRouterRuntime({ mode: 'cpr', providers: fakeProviders(), router, ...HOST });
  const result = runtime.resolveSpawnEnv({
    id: 's1', cli: 'codex', provider: 'p1', model: 'm1',
    label: 'must-not-cross', authToken: 'must-not-cross', worktreePath: '/secret',
  });
  assert.equal(result.env.CODEX_HOME, '/multicc/codex-homes/p1');
  const input = calls.find(call => call.method === 'cprResolveSpawnEnv').input;
  assert.equal('sessionId' in input, false);
  assert.equal('label' in input, false);
  assert.equal('authToken' in input, false);
  assert.equal(input.codexHomesDir, '/multicc/codex-homes');
  assert.equal(takeoverTouched, false);
  assert.equal(runtime.takeover, undefined);
  assert.equal(runtime.restore, undefined);
  assert.equal(Object.keys(runtime).some(key => /takeover|restore/i.test(key)), false);
});

test('shadow compares only summary/model/spawn, returns legacy, redacts diffs and never double-mounts', () => {
  const providerCalls = [];
  const routerCalls = [];
  const reports = [];
  const runtime = createProviderRouterRuntime({
    mode: 'shadow',
    providers: fakeProviders(providerCalls),
    router: fakeRouter(routerCalls),
    onShadowDiff: report => reports.push(report),
    ...HOST,
  });
  const session = { id: 'shadow-1', cli: 'codex', provider: 'p1', authToken: 'session-secret' };
  assert.equal(runtime.resolveSpawnEnv(session).env.CODEX_HOME, '/multicc/codex-homes/p1');
  assert.equal(runtime.resolveSessionWireModel('m1'), 'legacy:m1');
  assert.equal(runtime.getProviderSummary('codex', 'p1').name, 'Provider One');
  runtime.buildChildEnv({ KEEP: '1' }, session, { EXTRA: '1' });

  const event = runtime.normalizeUsageObserved({
    occurredAt: 1_750_000_000_000,
    sessionId: 'shadow-1', providerId: 'p1', roleKind: 'main', routeName: 'main',
    source: 'exact', coverage: 'observed', status: 'success', protocol: 'openai-responses',
    tokens: { input: 1, output: 2 },
  });
  assert.equal(event.tokens.total, 3);
  runtime.mountProtocolProxies({ use() {} }, { protocols: ['claude'] });

  assert.deepEqual(reports.map(report => report.operation), [
    'resolveSpawn', 'resolveWireModel', 'providerSummary',
  ]);
  assert.equal(JSON.stringify(reports).includes('summary-secret'), false);
  assert.equal(JSON.stringify(reports).includes('provider-secret'), false);
  assert.equal(routerCalls.some(call => call.method === 'cprBuildChildEnv'), false);
  assert.equal(routerCalls.some(call => call.method === 'cprNormalizeUsageEvent'), false);
  assert.equal(routerCalls.filter(call => call.method === 'mountClaudeProxy').length, 1);
  assert.equal(routerCalls.some(call => call.method === 'mountCodexProxy'), false);
  const mount = routerCalls.find(call => call.method === 'mountClaudeProxy');
  assert.equal(mount.options.paths.home, '/multicc/data/.provider-router-host');
  assert.equal(mount.options.cprHome, '/multicc/data/.provider-router-host');
});

test('server is a thin runtime consumer and keeps CC-Switch import read-only', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.equal(/require\(['"]cli-provider-router['"]\)/.test(server), false);
  assert.match(server, /providerRouterRuntime\.mountProtocolProxies/);
  assert.match(server, /onShadowDiff:\s*recordProviderRouterShadowComparison/);
  assert.match(server, /multicc_provider_router_shadow_comparisons_total/);
  assert.match(server, /multicc_provider_router_shadow_differences_total/);
  assert.match(server, /multicc_provider_router_shadow_errors_total/);
  assert.match(server, /logger\.info\('provider_router_runtime'/);
  assert.match(server, /providers\.importFromCcSwitch\(\)/);
  assert.match(server, /res\.status\(409\).*PROVIDER_IN_USE/s);
  assert.equal(/providerRouterRuntime\.[A-Za-z]*(?:takeover|restore)/i.test(server), false);
});
