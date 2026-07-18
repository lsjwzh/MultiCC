'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('runtime defaults to legacy and installed CPR 0.2 is never advertised as production cpr', () => {
  assert.equal(resolveMode({}), 'legacy');
  const providers = fakeProviders();
  const legacy = createProviderRouterRuntime({
    providers,
    router: fakeRouter([], { API_VERSION: '0.2.0' }),
    ...HOST,
  });
  assert.equal(legacy.mode, 'legacy');

  assert.throws(
    () => createProviderRouterRuntime({ mode: 'cpr', providers, ...HOST }),
    error => error.code === 'CPR_LEGACY_ONLY' && /0\.2\.0/.test(error.message),
  );
  assert.throws(
    () => createProviderRouterRuntime({ mode: 'shadow', providers, ...HOST }),
    error => error.code === 'CPR_LEGACY_ONLY',
  );
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
  assert.match(server, /providers\.importFromCcSwitch\(\)/);
  assert.match(server, /res\.status\(409\).*PROVIDER_IN_USE/s);
  assert.equal(/providerRouterRuntime\.[A-Za-z]*(?:takeover|restore)/i.test(server), false);
});
