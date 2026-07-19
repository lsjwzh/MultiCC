'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { safeErrorHandler } = require('../src/http-errors');

const {
  fingerprintEndpoint,
  resolveNotifySettingsUpdates,
  mountHostReadRoutes,
} = require('../src/routes/host-read');

const EXPECTED_PATHS = [
  '/api/push/vapid-key',
  '/api/push/health',
  '/api/settings/notify',
  '/api/settings/tunnel',
  '/api/tunnel/funnel',
  '/api/tunnel/ipv6',
  '/api/settings/access-token',
  '/api/settings/proxy',
  '/api/settings/official-oauth',
  '/api/settings/power',
];

function createHarness(overrides = {}) {
  const routes = new Map();
  const app = {
    get(routePath, handler) {
      assert.equal(routes.has(routePath), false, `duplicate route: ${routePath}`);
      routes.set(routePath, handler);
    },
  };
  const deps = {
    getVapidPublicKey: () => 'vapid-public',
    push: {
      subscriptions: new Map(),
      healthStats: new Map(),
      globalStats: { sent: 3, failed: 1 },
      cfg: { BARK_URL: '', WEBHOOK_URL: '' },
      barkHealth: { lastSuccessTime: 11 },
      webhookHealth: { lastFailTime: 22 },
    },
    tunnel: {
      getStatus: () => ({ config: { intervalSec: 30 }, healthy: true }),
      funnelStatus: async () => ({ enabled: true, port: 3000 }),
      ipv6Status: async () => ({ available: true, direct: false }),
    },
    getAccessToken: () => '',
    isLocalRequest: () => false,
    getProxyEnabled: () => true,
    getOfficialOAuthEnabled: () => false,
    macosPower: {
      isAvailable: () => false,
      getLidSleepPrevention: async () => ({ available: true, enabled: true }),
    },
    ...overrides,
  };
  mountHostReadRoutes(app, deps);
  return { routes, deps };
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function invoke(routes, routePath, req = {}) {
  const handler = routes.get(routePath);
  assert.equal(typeof handler, 'function', `missing handler: ${routePath}`);
  const res = createResponse();
  await handler(req, res, (error) => { res.nextError = error; });
  return res;
}

function presentSafely(error) {
  const res = createResponse();
  res.locals = { requestId: 'host-read-test', correlationId: 'host-read-test' };
  safeErrorHandler({ error() {} })(error, {
    id: 'host-read-test',
    correlationId: 'host-read-test',
    method: 'GET',
    path: '/api/test',
  }, res, () => {});
  return res;
}

test('mounts the complete host read route group exactly once', () => {
  const { routes } = createHarness();
  assert.deepEqual([...routes.keys()], EXPECTED_PATHS);
  assert.throws(() => mountHostReadRoutes({}, {}), /Express app\.get is required/);
  assert.throws(
    () => mountHostReadRoutes({ get() {} }, {}),
    /host read route dependency missing: getVapidPublicKey/,
  );
});

test('returns VAPID key and notification summaries without URL secrets', async () => {
  const barkSecret = 'https://device:password@api.day.app/device-key?token=query-secret#fragment-secret';
  const webhookSecret = 'https://hooks.example.test/private/path/webhook-token?sig=query-secret#fragment';
  const { routes } = createHarness({
    getVapidPublicKey: () => 'public-key-123',
    push: {
      subscriptions: new Map(),
      healthStats: new Map(),
      globalStats: {},
      cfg: {
        BARK_URL: barkSecret,
        WEBHOOK_URL: webhookSecret,
      },
      barkHealth: {},
      webhookHealth: {},
    },
  });
  assert.deepEqual((await invoke(routes, '/api/push/vapid-key')).body, { publicKey: 'public-key-123' });
  assert.deepEqual((await invoke(routes, '/api/settings/notify')).body, {
    barkUrl: 'https://api.day.app/••••',
    barkOrigin: 'https://api.day.app',
    hasBark: true,
    webhookUrl: 'https://hooks.example.test/••••',
    webhookOrigin: 'https://hooks.example.test',
    hasWebhook: true,
  });
  const serialized = JSON.stringify((await invoke(routes, '/api/settings/notify')).body);
  for (const secret of ['device', 'password', 'device-key', 'query-secret', 'fragment-secret', 'private/path', 'webhook-token']) {
    assert.equal(serialized.includes(secret), false, secret);
  }

  const opaque = createHarness({
    push: {
      subscriptions: new Map(),
      healthStats: new Map(),
      globalStats: {},
      cfg: { BARK_URL: 'opaque-device-secret', WEBHOOK_URL: 'not-a-url/private-token' },
      barkHealth: {},
      webhookHealth: {},
    },
  });
  assert.deepEqual((await invoke(opaque.routes, '/api/settings/notify')).body, {
    barkUrl: '••••',
    barkOrigin: '',
    hasBark: true,
    webhookUrl: '••••',
    webhookOrigin: '',
    hasWebhook: true,
  });
});

test('notification placeholders preserve current values while empty strings clear them', () => {
  const current = {
    BARK_URL: 'https://api.day.app/device-secret',
    WEBHOOK_URL: 'https://hooks.example.test/private?token=secret',
  };
  assert.deepEqual(resolveNotifySettingsUpdates({
    barkUrl: 'https://api.day.app/••••',
    webhookUrl: 'https://hooks.example.test/••••',
  }, current), {});
  assert.deepEqual(resolveNotifySettingsUpdates({ barkUrl: '', webhookUrl: '' }, current), {
    BARK_URL: '',
    WEBHOOK_URL: '',
  });
  assert.deepEqual(resolveNotifySettingsUpdates({
    barkUrl: 'https://new.example.test/new-key',
    webhookUrl: 'https://new-hooks.example.test/new-hook',
  }, current), {
    BARK_URL: 'https://new.example.test/new-key',
    WEBHOOK_URL: 'https://new-hooks.example.test/new-hook',
  });
});

test('push health exposes fingerprints and explicit safe health DTOs only', async () => {
  const longEndpoint = `https://push.example.test/${'x'.repeat(55)}`;
  const shortEndpoint = 'https://push.test/short';
  const push = {
    subscriptions: new Map([[longEndpoint, {}], [shortEndpoint, {}]]),
    healthStats: new Map([[longEndpoint, {
      successCount: 7,
      failCount: 2,
      lastFailTime: 33,
      lastFailReason: 'request to /Users/private failed: token=super-secret',
      custom: 'must-not-cross-dto',
    }]]),
    globalStats: {
      totalSent: 9,
      totalSuccess: 7,
      totalFail: 2,
      lastPushTime: 44,
      lastPushType: 'secret-token-value',
      lastPushSessionId: 'private-session-id',
      custom: 'must-not-cross-dto',
    },
    cfg: { BARK_URL: 'bark', WEBHOOK_URL: '' },
    barkHealth: { lastSendTime: 55, lastSuccess: false, lastError: 'HTTP 401 /secret' },
    webhookHealth: { lastSendTime: 0, lastSuccess: true, custom: 'drop-me' },
  };
  const { routes } = createHarness({ push });
  const response = await invoke(routes, '/api/push/health');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    subscriptions: [
      {
        endpointFingerprint: fingerprintEndpoint(longEndpoint),
        successCount: 7,
        failCount: 2,
        lastSuccessTime: 0,
        lastFailTime: 33,
        lastFailReason: 'authentication_error',
        consecutiveFails: 0,
      },
      {
        endpointFingerprint: fingerprintEndpoint(shortEndpoint),
        successCount: 0,
        failCount: 0,
        lastSuccessTime: 0,
        lastFailTime: 0,
        lastFailReason: '',
        consecutiveFails: 0,
      },
    ],
    subscriptionCount: 2,
    global: {
      totalSent: 9,
      totalSuccess: 7,
      totalFail: 2,
      lastPushTime: 44,
      lastPushType: 'other',
    },
    bark: {
      configured: true,
      lastSendTime: 55,
      lastSuccess: false,
      lastError: 'http_4xx',
    },
    webhook: {
      configured: false,
      lastSendTime: 0,
      lastSuccess: true,
      lastError: '',
    },
  });
  const serialized = JSON.stringify(response.body);
  for (const secret of [longEndpoint, shortEndpoint, '/Users/private', 'super-secret', 'secret-token-value', 'private-session-id', 'must-not-cross-dto']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('settings read live token and proxy values instead of mount-time snapshots', async () => {
  let token = 'secret-123456';
  let proxyEnabled = true;
  let officialEnabled = false;
  const localRequest = { ip: '127.0.0.1' };
  const { routes } = createHarness({
    getAccessToken: () => token,
    isLocalRequest: (req) => req === localRequest,
    getProxyEnabled: () => proxyEnabled,
    getOfficialOAuthEnabled: () => officialEnabled,
  });
  assert.deepEqual((await invoke(routes, '/api/settings/access-token', localRequest)).body, {
    hasToken: true,
    masked: '****3456',
    canEdit: true,
  });
  assert.deepEqual((await invoke(routes, '/api/settings/proxy')).body, { enabled: true });
  assert.deepEqual((await invoke(routes, '/api/settings/official-oauth')).body, { enabled: false });

  token = 'abc';
  proxyEnabled = false;
  officialEnabled = true;
  assert.deepEqual((await invoke(routes, '/api/settings/access-token', {})).body, {
    hasToken: true,
    masked: '****',
    canEdit: false,
  });
  assert.deepEqual((await invoke(routes, '/api/settings/proxy')).body, { enabled: false });
  assert.deepEqual((await invoke(routes, '/api/settings/official-oauth')).body, { enabled: true });
});

test('tunnel settings and diagnostics preserve success payloads', async () => {
  const status = { config: { intervalSec: 15 }, runtime: { phddns: 'ok' } };
  const { routes } = createHarness({
    tunnel: {
      getStatus: () => status,
      funnelStatus: async () => ({ enabled: false, output: 'off' }),
      ipv6Status: async () => ({ available: true, direct: true, address: '::1' }),
    },
  });
  assert.equal((await invoke(routes, '/api/settings/tunnel')).body, status);
  assert.deepEqual((await invoke(routes, '/api/tunnel/funnel')).body, {
    status: { enabled: false, output: 'off' },
  });
  assert.deepEqual((await invoke(routes, '/api/tunnel/ipv6')).body, {
    available: true,
    direct: true,
    address: '::1',
  });
});

test('tunnel diagnostic failures delegate raw errors to the safe error boundary', async () => {
  const funnelError = new Error('funnel failed /Users/private token=secret');
  const ipv6Error = new Error('ipv6 failed /private/path?token=secret');
  const { routes } = createHarness({
    tunnel: {
      getStatus: () => ({}),
      funnelStatus: async () => { throw funnelError; },
      ipv6Status: async () => { throw ipv6Error; },
    },
  });
  const funnel = await invoke(routes, '/api/tunnel/funnel');
  assert.equal(funnel.statusCode, 200);
  assert.equal(funnel.body, undefined);
  assert.equal(funnel.nextError, funnelError);
  assert.equal(presentSafely(funnel.nextError).body.error, 'internal_error');
  assert.doesNotMatch(JSON.stringify(presentSafely(funnel.nextError).body), /Users|private|secret/);
  const ipv6 = await invoke(routes, '/api/tunnel/ipv6');
  assert.equal(ipv6.statusCode, 200);
  assert.equal(ipv6.body, undefined);
  assert.equal(ipv6.nextError, ipv6Error);
  assert.doesNotMatch(JSON.stringify(presentSafely(ipv6.nextError).body), /private|secret/);
});

test('power settings preserve success branches and delegate all errors', async () => {
  const unavailable = createHarness();
  assert.deepEqual((await invoke(unavailable.routes, '/api/settings/power')).body, {
    available: false,
    enabled: false,
  });

  const available = createHarness({
    macosPower: {
      isAvailable: () => true,
      getLidSleepPrevention: async () => ({ available: true, enabled: true, source: 'pmset' }),
    },
  });
  assert.deepEqual((await invoke(available.routes, '/api/settings/power')).body, {
    available: true,
    enabled: true,
    source: 'pmset',
  });

  const operationError = new Error('pmset denied /Users/private token=secret');
  const failing = createHarness({
    macosPower: {
      isAvailable: () => true,
      getLidSleepPrevention: async () => { throw operationError; },
    },
  });
  const response = await invoke(failing.routes, '/api/settings/power');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, undefined);
  assert.equal(response.nextError, operationError);
  assert.doesNotMatch(JSON.stringify(presentSafely(response.nextError).body), /Users|private|secret/);

  const availabilityError = new Error('availability failed /private/path?secret=yes');
  const availabilityFailing = createHarness({
    macosPower: {
      isAvailable: () => { throw availabilityError; },
      getLidSleepPrevention: async () => ({ available: true, enabled: true }),
    },
  });
  const availabilityResponse = await invoke(availabilityFailing.routes, '/api/settings/power');
  assert.equal(availabilityResponse.body, undefined);
  assert.equal(availabilityResponse.nextError, availabilityError);
  assert.doesNotMatch(JSON.stringify(presentSafely(availabilityResponse.nextError).body), /private|secret/);
});

test('server delegates every migrated GET without retaining inline duplicates', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const writeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'host-write.js'), 'utf8');
  assert.match(source, /mountHostReadRoutes\(app, \{/);
  assert.match(source, /mountHostWriteRoutes\(app, \{/);
  assert.match(writeSource, /resolveNotifySettingsUpdates\(req\.body \|\| \{\}, current\)/);
  for (const routePath of EXPECTED_PATHS) {
    assert.equal(source.includes(`app.get('${routePath}'`), false, routePath);
  }
});
