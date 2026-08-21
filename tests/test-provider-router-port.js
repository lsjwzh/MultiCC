'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  REQUIRED_CAPABILITIES,
  createProviderRouterPort,
} = require('../src/provider-router-port');
const { createProviderBinding } = require('../src/provider-binding');

const HOST_PATHS = Object.freeze({
  cprPaths: Object.freeze({
    home: '/host/explicit/cpr-home',
    dataDir: '/host/explicit/cpr-home/data',
    capturesDir: '/host/explicit/cpr-home/captures',
    codexHomesDir: '/router/default/must-not-be-used',
  }),
  codexHomesDir: '/host/explicit/multicc-codex-homes',
});

function capabilities(overrides = {}) {
  return Object.fromEntries(
    Object.keys(REQUIRED_CAPABILITIES).map(name => [name, '1.0']).concat(Object.entries(overrides)),
  );
}

function fakeStore() {
  const provider = {
    id: 'provider-1', appType: 'codex', name: 'Provider One',
    baseUrl: 'https://user:password@example.test/v1?token=query-secret',
    model: 'model-1', models: 'model-1', authToken: 'store-secret-token',
    settingsConfig: JSON.stringify({ auth: { OPENAI_API_KEY: 'nested-secret' } }),
  };
  return {
    getProvider: () => provider,
    getProviderSummary: () => provider,
  };
}

function fakeRouter(options = {}) {
  const calls = options.calls || [];
  const router = {
    API_VERSION: options.version || '1.4.2',
    CAPABILITIES: options.capabilities || {
      ...capabilities(),
      ccSwitchTakeover: '1.0',
      directCliTakeover: '1.0',
      takeoverLifecycle: '1.0',
    },
    resolveSpawnEnv(input) {
      calls.push({ method: 'resolveSpawnEnv', input });
      return {
        env: {
          CODEX_HOME: path.join(input.codexHomesDir, input.providerId || 'default'),
          ANTHROPIC_AUTH_TOKEN: 'cpr-shadow-secret',
        },
        providerName: 'CPR Provider',
      };
    },
    buildChildEnv(base, input, extra) {
      calls.push({ method: 'buildChildEnv', input });
      return {
        env: {
          ...base,
          ...extra,
          CODEX_HOME: path.join(input.codexHomesDir, input.providerId || 'default'),
          ANTHROPIC_AUTH_TOKEN: 'cpr-shadow-secret',
        },
      };
    },
    resolveSessionWireModel(model) { return `cpr:${model}`; },
    normalizeUsageEvent(event) { return event; },
    mountClaudeProxy(app, mountOptions) { calls.push({ method: 'mountClaudeProxy', mountOptions }); return 'cpr-claude'; },
    mountCodexProxy(app, mountOptions) { calls.push({ method: 'mountCodexProxy', mountOptions }); return 'cpr-codex'; },
  };
  return router;
}

function fakeLegacy(calls = []) {
  return {
    resolveSpawnEnv(binding) {
      calls.push({ method: 'resolveSpawnEnv', binding });
      return { env: { CODEX_HOME: '/legacy/codex-home', ANTHROPIC_AUTH_TOKEN: 'legacy-shadow-secret' } };
    },
    buildChildEnv(base, binding, extra) {
      calls.push({ method: 'buildChildEnv', binding });
      return { env: { ...base, ...extra, CODEX_HOME: '/legacy/codex-home', ANTHROPIC_AUTH_TOKEN: 'legacy-shadow-secret' } };
    },
    resolveSessionWireModel(model) { return `legacy:${model}`; },
    getProvider: () => fakeStore().getProvider(),
    getProviderSummary: () => fakeStore().getProviderSummary(),
    normalizeUsageEvent: event => event,
    mountClaudeProxy(app, mountOptions) { calls.push({ method: 'mountClaudeProxy', mountOptions }); return 'legacy-claude'; },
    mountCodexProxy(app, mountOptions) { calls.push({ method: 'mountCodexProxy', mountOptions }); return 'legacy-codex'; },
  };
}

function createCprPort(router, overrides = {}) {
  return createProviderRouterPort({
    mode: 'cpr',
    router,
    providerStore: fakeStore(),
    embeddingPaths: HOST_PATHS,
    ...overrides,
  });
}

test('CPR API major and required capabilities fail closed', () => {
  assert.throws(
    () => createCprPort(fakeRouter({ version: '2.0.0' })),
    error => error.code === 'CPR_API_MAJOR_MISMATCH',
  );

  const missing = capabilities();
  delete missing.normalizedUsage;
  assert.throws(
    () => createCprPort(fakeRouter({ capabilities: missing })),
    error => error.code === 'CPR_CAPABILITY_MISSING',
  );

  assert.throws(
    () => createCprPort(fakeRouter({ capabilities: capabilities({ protocolProxy: '2.0' }) })),
    error => error.code === 'CPR_CAPABILITY_INCOMPATIBLE',
  );
  assert.throws(
    () => createCprPort(fakeRouter({ capabilities: capabilities() }), { embeddingPaths: null }),
    error => error.code === 'CPR_PATHS_REQUIRED',
  );
});

test('0.2 compatibility is accepted only by legacy mode', () => {
  const oldRouter = fakeRouter({ version: '0.2.0' });
  const legacy = fakeLegacy();
  const port = createProviderRouterPort({ mode: 'legacy', legacy, router: oldRouter });
  assert.equal(port.mode, 'legacy');
  assert.throws(
    () => createCprPort(oldRouter),
    error => error.code === 'CPR_LEGACY_ONLY',
  );
  assert.throws(
    () => createProviderRouterPort({
      mode: 'shadow', legacy, router: oldRouter,
      providerStore: fakeStore(), embeddingPaths: HOST_PATHS,
    }),
    error => error.code === 'CPR_LEGACY_ONLY',
  );
});

test('CPR receives only narrow binding fields and explicit host CODEX_HOME paths', () => {
  const calls = [];
  const router = fakeRouter({ calls });
  const port = createCprPort(router);
  const binding = createProviderBinding({
    sessionId: 'session-1', cli: 'codex', providerId: 'provider-1', model: 'model-1',
  });
  const result = port.resolveSpawn(binding);
  assert.equal(result.env.CODEX_HOME, '/host/explicit/multicc-codex-homes/provider-1');
  const input = calls[0].input;
  assert.deepEqual(Object.keys(input).sort(), [
    'cli', 'codexHomesDir', 'cprHome', 'model', 'paths', 'providerId', 'store',
  ]);
  assert.equal(input.paths.home, '/host/explicit/cpr-home');
  assert.equal(input.codexHomesDir, '/host/explicit/multicc-codex-homes');
  assert.equal('sessionId' in input, false);
  assert.equal('authToken' in input, false);
  assert.equal('label' in input, false);
});

test('shadow returns legacy behavior and emits only redacted diffs', () => {
  const reports = [];
  const legacyCalls = [];
  const port = createProviderRouterPort({
    mode: 'shadow',
    legacy: fakeLegacy(legacyCalls),
    router: fakeRouter(),
    providerStore: fakeStore(),
    embeddingPaths: HOST_PATHS,
    onShadowDiff: report => reports.push(report),
  });
  const binding = createProviderBinding({
    sessionId: 'session-shadow', cli: 'codex', providerId: 'provider-1',
  });
  const result = port.resolveSpawn(binding);
  assert.equal(result.env.CODEX_HOME, '/legacy/codex-home');
  assert.equal(legacyCalls[0].binding.id, 'session-shadow');
  assert.equal('worktreePath' in legacyCalls[0].binding, false);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].equal, false);
  const serialized = JSON.stringify(reports[0]);
  for (const secret of ['legacy-shadow-secret', 'cpr-shadow-secret', 'store-secret-token', 'nested-secret']) {
    assert.equal(serialized.includes(secret), false, `shadow diagnostics leaked ${secret}`);
  }
  assert.match(serialized, /REDACTED/);
});

test('shadow backend errors never expose the raw CPR error message', () => {
  const reports = [];
  const router = fakeRouter();
  router.resolveSpawnEnv = () => {
    const error = new Error('upstream rejected token=cpr-error-secret');
    error.code = 'UPSTREAM_REJECTED';
    throw error;
  };
  const port = createProviderRouterPort({
    mode: 'shadow', legacy: fakeLegacy(), router,
    providerStore: fakeStore(), embeddingPaths: HOST_PATHS,
    onShadowDiff: report => reports.push(report),
  });
  port.resolveSpawn(createProviderBinding({
    sessionId: 'session-error', cli: 'codex', providerId: 'provider-1',
  }));
  const serialized = JSON.stringify(reports[0]);
  assert.equal(serialized.includes('cpr-error-secret'), false);
  assert.equal(reports[0].error.message, 'CPR shadow evaluation failed');
  assert.equal(reports[0].error.code, 'UPSTREAM_REJECTED');
});

test('provider summaries and port surface do not expose credentials or takeover', () => {
  let takeoverTouched = false;
  const router = new Proxy(fakeRouter(), {
    get(target, property, receiver) {
      if (/takeover/i.test(String(property))) {
        takeoverTouched = true;
        throw new Error('takeover must be unreachable');
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const port = createCprPort(router);
  const summary = port.providerSummary('codex', 'provider-1');
  const serialized = JSON.stringify(summary);
  for (const secret of ['password', 'query-secret', 'store-secret-token', 'nested-secret']) {
    assert.equal(serialized.includes(secret), false, `provider summary leaked ${secret}`);
  }
  assert.equal(summary.hasToken, true);
  assert.equal(summary.modelOptions[0], 'model-1');
  assert.equal(takeoverTouched, false);
  assert.equal(port.ccSwitchTakeover, undefined);
  assert.equal(port.directCliTakeover, undefined);
  assert.equal(port.takeover, undefined);
  assert.equal(Object.keys(port).some(key => /takeover|restore/i.test(key)), false);
  assert.equal(Object.keys(port.routerCapabilities).some(key => /takeover|restore/i.test(key)), false);

  port.resolveSpawn(createProviderBinding({
    sessionId: 'session-2', cli: 'codex', providerId: 'provider-1',
  }));
  assert.equal(takeoverTouched, false);
});

test('shadow mounts only legacy protocol proxies, never CPR management APIs', () => {
  const legacyCalls = [];
  const routerCalls = [];
  const port = createProviderRouterPort({
    mode: 'shadow', legacy: fakeLegacy(legacyCalls), router: fakeRouter({ calls: routerCalls }),
    providerStore: fakeStore(), embeddingPaths: HOST_PATHS,
  });
  const mounted = port.mountProtocolProxies({ use() {} });
  assert.deepEqual(mounted, { claude: 'legacy-claude', codex: 'legacy-codex' });
  assert.deepEqual(legacyCalls.map(call => call.method), ['mountClaudeProxy', 'mountCodexProxy']);
  assert.equal(legacyCalls[0].mountOptions.paths.home, '/host/explicit/cpr-home');
  assert.equal(legacyCalls[0].mountOptions.cprHome, '/host/explicit/cpr-home');
  assert.equal(legacyCalls[0].mountOptions.captureDir, '/host/explicit/cpr-home/captures');
  assert.deepEqual(routerCalls, []);
});

test('shadow never compares write/event operations and can mount one protocol at a time', () => {
  const reports = [];
  const legacyCalls = [];
  const routerCalls = [];
  const port = createProviderRouterPort({
    mode: 'shadow', legacy: fakeLegacy(legacyCalls), router: fakeRouter({ calls: routerCalls }),
    providerStore: fakeStore(), embeddingPaths: HOST_PATHS,
    onShadowDiff: report => reports.push(report),
  });
  const binding = createProviderBinding({ sessionId: 's1', cli: 'claude', providerId: 'provider-1' });
  port.buildChildEnv({}, binding, {});
  port.normalizeUsage({
    occurredAt: 1_750_000_000_000, sessionId: 's1', providerId: 'provider-1',
    roleKind: 'main', routeName: 'main', source: 'exact', coverage: 'observed',
    status: 'success', protocol: 'anthropic-messages', tokens: { input: 1, output: 1 },
  }, binding);
  const mounted = port.mountProtocolProxies({ use() {} }, { protocols: ['claude'] });
  assert.deepEqual(mounted, { claude: 'legacy-claude' });
  assert.deepEqual(reports, []);
  assert.deepEqual(routerCalls, []);
  assert.equal(legacyCalls.filter(call => call.method === 'buildChildEnv').length, 1);
  assert.equal(legacyCalls.filter(call => call.method === 'mountClaudeProxy').length, 1);
  assert.equal(legacyCalls.filter(call => call.method === 'mountCodexProxy').length, 0);
});

test('Official OAuth relay mounts before the generic CPR Codex proxy', () => {
  const order = [];
  const router = fakeRouter({ calls: [] });
  router.mountCodexProxy = (app, mountOptions) => {
    order.push({ kind: 'cpr', mountOptions });
    return 'cpr-codex';
  };
  const app = {
    use() {},
    post(route) { order.push({ kind: 'official', route }); },
  };
  const port = createCprPort(router);
  const mounted = port.mountProtocolProxies(app, {
    protocols: ['codex'],
    codexProxyPath: '/custom-codex',
  });
  assert.deepEqual(mounted, { codex: 'cpr-codex' });
  assert.deepEqual(order.map(item => item.kind), ['official', 'cpr']);
  assert.equal(order[0].route, '/custom-codex/:providerId/responses');
  assert.equal(order[1].mountOptions.codexProxyPath, '/custom-codex');
});

test('protocol mounts preserve request activity for liveness and TaskRun drain fencing', () => {
  const calls = [];
  const port = createCprPort(fakeRouter({ calls }));
  const onActivity = () => {};
  port.mountProtocolProxies({ use() {} }, {
    protocols: ['claude'],
    onActivity,
  });
  const mounted = calls.find(call => call.method === 'mountClaudeProxy').mountOptions;
  assert.equal(mounted.onActivity, onActivity);
});
