'use strict';

// Host read routes are now answered by the Rust front door
// (native/gateway/src/app/host_read.rs). What is left in Node is one internal
// host port (src/routes/host-read-host.js) that hands over the runtime facts
// Rust cannot see: push Maps and config, tunnel clients, macOS power services
// and the battery probe. This file covers that port and the notify helpers
// that the write path still shares (src/notify-settings.js). Response shapes,
// masking and classification are covered by the Rust tests and the
// differential run (docs/rust-migration/differential/host-read.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createHostReadHost, mountHostReadHostRoute, HOST_PATH } = require('../src/routes/host-read-host');
const { resolveNotifySettingsUpdates } = require('../src/notify-settings');

function createDeps(overrides = {}) {
  return {
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
      sakuraAccess: async () => ({ ok: false, reason: 'no_token' }),
    },
    getAccessToken: () => '',
    macosPower: {
      isAvailable: () => false,
      getLidModeSettings: async () => ({ available: true, enabled: true }),
    },
    unlockProbe: { desktopPermissions: async () => ({ state: 'authorized' }) },
    powerPreferences: { read: () => false },
    unlockPassword: {
      isAvailable: () => true,
      hasPassword: async () => false,
    },
    ...overrides,
  };
}

test('mounts exactly one internal host port and validates its dependencies', () => {
  const routes = new Map();
  const app = {
    post(routePath, handler) {
      assert.equal(routes.has(routePath), false, `duplicate route: ${routePath}`);
      routes.set(routePath, handler);
    },
  };
  mountHostReadHostRoute(app, createDeps());
  assert.deepEqual([...routes.keys()], [HOST_PATH]);
  assert.throws(() => mountHostReadHostRoute({}, createDeps()), /Express-compatible app is required/);
  assert.throws(() => createHostReadHost({}), /dependency missing: getVapidPublicKey/);
  assert.throws(
    () => createHostReadHost({ getVapidPublicKey() {}, getAccessToken() {} }),
    /service dependencies are required/,
  );
});

test('the host port refuses anything that is not a loopback call', async () => {
  let mounted = null;
  mountHostReadHostRoute({ post(_path, handler) { mounted = handler; } }, createDeps());
  const answers = [];
  const res = (code) => ({
    status(value) { this.code = value; return this; },
    json(body) { answers.push([this.code || code || 200, body]); return this; },
  });
  mounted({ headers: {} }, res());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(answers, [[404, { error: 'not found' }]]);
});

test('push facts cross the boundary as raw state, not as a DTO', async () => {
  const endpoint = 'https://push.example.test/device-token';
  const handle = createHostReadHost(createDeps({
    push: {
      subscriptions: new Map([[endpoint, {}]]),
      healthStats: new Map([[endpoint, { successCount: 7, failCount: 2 }]]),
      globalStats: { totalSent: 9 },
      cfg: { BARK_URL: 'https://api.day.app/key', WEBHOOK_URL: '' },
      barkHealth: { lastSendTime: 55 },
      webhookHealth: {},
      hasBarkDevices: () => true,
      barkDevices: { list: () => [{ id: 'd1' }] },
    },
  }));
  assert.deepEqual(await handle({ op: 'push-health' }), {
    ok: true,
    payload: {
      endpoints: [endpoint],
      health: [{ successCount: 7, failCount: 2 }],
      size: 1,
      globalStats: { totalSent: 9 },
      barkConfigured: true,
      barkHealth: { lastSendTime: 55 },
      webhookConfigured: false,
      webhookHealth: {},
    },
  });
  assert.deepEqual(await handle({ op: 'notify' }), {
    ok: true,
    payload: {
      barkUrl: 'https://api.day.app/key',
      webhookUrl: '',
      hasBark: true,
      barkDevices: [{ id: 'd1' }],
    },
  });
  assert.deepEqual(await handle({ op: 'vapid-key' }), { ok: true, payload: 'vapid-public' });
  assert.deepEqual(await handle({ op: 'unknown' }), { ok: false });
  assert.deepEqual(await handle(null), { ok: false });
});

test('health entries absent from the Map are handed over as null', async () => {
  const endpoint = 'https://push.example.test/missing-health';
  const handle = createHostReadHost(createDeps({
    push: {
      subscriptions: new Map([[endpoint, {}]]),
      healthStats: new Map(),
      globalStats: {},
      cfg: { BARK_URL: '', WEBHOOK_URL: '' },
      barkHealth: {},
      webhookHealth: {},
    },
  }));
  const answer = await handle({ op: 'push-health' });
  assert.deepEqual(answer.payload.health, [null]);
  assert.equal(answer.payload.barkConfigured, false);
});

test('tunnel clients are awaited and their payloads passed through', async () => {
  const handle = createHostReadHost(createDeps());
  assert.deepEqual(await handle({ op: 'tunnel' }), {
    ok: true,
    payload: { config: { intervalSec: 30 }, healthy: true },
  });
  assert.deepEqual(await handle({ op: 'funnel' }), { ok: true, payload: { enabled: true, port: 3000 } });
  assert.deepEqual(await handle({ op: 'ipv6' }), { ok: true, payload: { available: true, direct: false } });
  assert.deepEqual(await handle({ op: 'sakurafrp' }), { ok: true, payload: { ok: false, reason: 'no_token' } });
});

test('a thrown tunnel error becomes a safe-error descriptor, not a 500 body', async () => {
  const error = new Error('funnel failed /Users/private token=secret');
  error.code = 'EBOOM';
  const handle = createHostReadHost(createDeps({
    tunnel: { getStatus: () => ({}), funnelStatus: async () => { throw error; } },
  }));
  assert.deepEqual(await handle({ op: 'funnel' }), {
    ok: false,
    status: 500,
    code: 'EBOOM',
    safeMessage: null,
    detail: 'funnel failed /Users/private token=secret',
  });
});

test('access tokens cross the boundary raw and live, never snapshotted', async () => {
  let token = 'secret-123456';
  const handle = createHostReadHost(createDeps({ getAccessToken: () => token }));
  assert.deepEqual(await handle({ op: 'access-token' }), { ok: true, payload: { token: 'secret-123456' } });
  token = 'abc';
  assert.deepEqual(await handle({ op: 'access-token' }), { ok: true, payload: { token: 'abc' } });
  token = '';
  assert.deepEqual(await handle({ op: 'access-token' }), { ok: true, payload: { token: '' } });
});

test('power reads the live services and takes canEdit from the front door', async () => {
  const unavailable = createHostReadHost(createDeps());
  assert.deepEqual(await unavailable({ op: 'power', canEdit: true }), {
    ok: true,
    payload: { available: false, enabled: false },
  });

  const available = createHostReadHost(createDeps({
    macosPower: {
      isAvailable: () => true,
      getLidModeSettings: async () => ({ available: true, enabled: true, source: 'pmset' }),
    },
  }));
  assert.deepEqual(await available({ op: 'power', canEdit: false }), {
    ok: true,
    payload: {
      available: true,
      enabled: true,
      source: 'pmset',
      unlockPassword: {
        available: true, set: false, canEdit: false, requested: false,
        enabled: false, requiredByLid: true,
      },
    },
  });

  const hasPassword = createHostReadHost(createDeps({
    macosPower: {
      isAvailable: () => true,
      getLidModeSettings: async () => ({ available: true, enabled: true }),
    },
    unlockPassword: { isAvailable: () => true, hasPassword: async () => true },
  }));
  assert.deepEqual((await hasPassword({ op: 'power', canEdit: true })).payload.unlockPassword,
    { available: true, set: true, canEdit: true, requested: false, enabled: true, requiredByLid: true });
});

test('saved unlock consent is not reported ready after desktop permissions are revoked', async () => {
  let ready = false;
  const handle = createHostReadHost(createDeps({
    macosPower: { isAvailable: () => true, getLidModeSettings: async () => ({ available: true, enabled: false }) },
    powerPreferences: { read: () => true },
    unlockPassword: { isAvailable: () => true, hasPassword: async () => true },
    unlockProbe: { desktopPermissions: async () => ({ state: ready ? 'authorized' : 'permissions-required' }) },
  }));
  const revoked = (await handle({ op: 'power', canEdit: true })).payload.unlockPassword;
  assert.equal(revoked.requested, true);
  assert.equal(revoked.enabled, false);
  assert.equal(revoked.authorization.state, 'permissions-required');
  ready = true;
  assert.equal((await handle({ op: 'power', canEdit: true })).payload.unlockPassword.enabled, true);
});

test('power failures carry the error code and status for the front door', async () => {
  const operationError = new Error('pmset denied /Users/private token=secret');
  const failing = createHostReadHost(createDeps({
    macosPower: {
      isAvailable: () => true,
      getLidModeSettings: async () => { throw operationError; },
    },
  }));
  const answer = await failing({ op: 'power', canEdit: true });
  assert.equal(answer.ok, false);
  assert.equal(answer.status, 500);
  assert.equal(answer.code, null);
  assert.match(answer.detail, /pmset denied/);

  const availabilityError = new Error('availability failed');
  availabilityError.code = 'EACCES';
  const availabilityFailing = createHostReadHost(createDeps({
    macosPower: {
      isAvailable: () => { throw availabilityError; },
      getLidModeSettings: async () => ({ available: true, enabled: true }),
    },
  }));
  const coded = await availabilityFailing({ op: 'power', canEdit: true });
  assert.equal(coded.code, 'EACCES');
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
  assert.deepEqual(resolveNotifySettingsUpdates({ barkUrl: 42 }, current), {});
});

test('server mounts the host port and retains no inline host read GETs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const writeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'host-write.js'), 'utf8');
  assert.match(source, /mountHostReadHostRoute\(app, \{/);
  assert.match(source, /mountHostWriteRoutes\(app, \{/);
  assert.match(writeSource, /resolveNotifySettingsUpdates\(req\.body \|\| \{\}, current\)/);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'routes', 'host-read.js')), false);
  for (const routePath of [
    '/api/push/vapid-key',
    '/api/push/health',
    '/api/settings/notify',
    '/api/settings/tunnel',
    '/api/tunnel/funnel',
    '/api/tunnel/ipv6',
    '/api/tunnel/sakurafrp',
    '/api/settings/access-token',
    '/api/settings/power',
    '/api/host/battery',
  ]) {
    assert.equal(source.includes(`app.get('${routePath}'`), false, routePath);
  }
  const rust = fs.readFileSync(path.join(__dirname, '..', 'native', 'gateway', 'src', 'app', 'host_read.rs'), 'utf8');
  assert.match(rust, /http_gate::is_local_request\(peer, &ctx\.headers\)/);
});
