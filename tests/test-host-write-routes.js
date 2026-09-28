'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { safeErrorHandler } = require('../src/http-errors');
const {
  persistThenApply,
  normalizeTunnelUpdate,
  validateNotifyUrl,
  validateFunnelPort,
  mountHostWriteRoutes,
} = require('../src/routes/host-write');

const EXPECTED_PATHS = [
  'POST /api/settings/notify',
  'POST /api/settings/tunnel',
  'POST /api/tunnel/restart/:provider',
  'POST /api/tunnel/sakurafrp/public-url',
  'POST /api/tunnel/funnel',
  'POST /api/settings/access-token',
  'POST /api/settings/official-oauth',
  'POST /api/settings/power',
  'POST /api/settings/power/auto-unlock',
  'POST /api/settings/power/unlock-password',
  'DELETE /api/settings/power/unlock-password',
  'POST /api/settings/power/unlock-password/authorize',
];

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    locals: {},
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

async function invoke(routes, routePath, request = {}) {
  const method = request.method || 'POST';
  const handler = routes.get(`${method} ${routePath}`);
  assert.equal(typeof handler, 'function', `missing handler: ${method} ${routePath}`);
  const req = {
    body: {},
    params: {},
    ...request,
  };
  const res = createResponse();
  await handler(req, res, (error) => { res.nextError = error; });
  return res;
}

function presentSafely(error) {
  const res = createResponse();
  res.locals = { requestId: 'host-write-test', correlationId: 'host-write-test' };
  safeErrorHandler({ error() {} })(error, {
    id: 'host-write-test',
    correlationId: 'host-write-test',
    method: 'POST',
    path: '/api/settings/test',
  }, res, () => {});
  return res;
}

function createHarness(overrides = {}) {
  const routes = new Map();
  const app = {
    post(routePath, handler) { register('POST', routePath, handler); },
    delete(routePath, handler) { register('DELETE', routePath, handler); },
  };
  function register(method, routePath, handler) {
    const key = `${method} ${routePath}`;
    assert.equal(routes.has(key), false, `duplicate route: ${key}`);
    routes.set(key, handler);
  }
  const state = {
    env: {
      BARK_URL: 'https://api.day.app/device-old',
      WEBHOOK_URL: 'https://hooks.example.test/hook-old',
      ACCESS_TOKEN: 'old-token',
      CLAUDE_OFFICIAL_VIA_PROXY: '0',
    },
    accessToken: 'old-token',
    oauthEnabled: false,
    allowRemote: false,
    envWrites: [],
    events: [],
  };
  const deps = {
    readEnvFile: () => ({ ...state.env }),
    writeEnvFile: updates => {
      state.events.push(['persist', { ...updates }]);
      state.envWrites.push({ ...updates });
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) delete state.env[key];
        else state.env[key] = value;
      }
    },
    push: {
      cfg: {
        BARK_URL: state.env.BARK_URL,
        WEBHOOK_URL: state.env.WEBHOOK_URL,
      },
      applyEnvUpdates: updates => {
        state.events.push(['notify-live', { ...updates }]);
        if (updates.BARK_URL !== undefined) deps.push.cfg.BARK_URL = updates.BARK_URL;
        if (updates.WEBHOOK_URL !== undefined) deps.push.cfg.WEBHOOK_URL = updates.WEBHOOK_URL;
      },
    },
    tunnel: {
      getStatus: () => ({ config: { phddns: { enabled: false }, tailscale: { enabled: false, funnel: false } } }),
      applyConfig: update => ({ ...update, applied: true }),
      restartNow: async provider => ({ ok: true, message: `restarted ${provider}` }),
      setFunnel: async (on, port) => ({ ok: true, message: `${on}:${port}` }),
      funnelStatus: async () => 'funnel-status',
    },
    getAccessToken: () => state.accessToken,
    setAccessToken: token => {
      state.events.push(['access-live', token]);
      state.accessToken = token;
    },
    getAllowRemote: () => state.allowRemote,
    isLocalRequest: req => req.local === true,
    getOfficialOAuthEnabled: () => state.oauthEnabled,
    setOfficialOAuthEnabled: enabled => {
      state.events.push(['oauth-live', enabled]);
      state.oauthEnabled = enabled;
    },
    macosPower: {
      isAvailable: () => true,
      setLidSleepPrevention: async enabled => ({ available: true, enabled }),
      getLidModeSettings: async () => ({ available: true, enabled: true }),
    },
    powerPreferences: { read: () => false, write: () => {} },
    unlockPassword: {
      isAvailable: () => true,
      hasPassword: async () => true,
      setPassword: async () => {},
      clearPassword: async () => {},
    },
    // 真探测会 spawn 本机的 multicc-agent 去读钥匙串：测试里必须永远走桩，
    // 否则一台装着 Agent 的机器上跑测试就会弹系统授权框。
    unlockProbe: {
      isAvailable: () => true,
      probe: async () => ({ state: 'authorized' }),
      runtimeReady: async () => true,
    },
    log: message => state.events.push(['log', message]),
    reportFailure: (stage, category) => state.events.push(['failure', { stage, category }]),
  };
  Object.assign(deps, overrides);
  mountHostWriteRoutes(app, deps);
  return { routes, deps, state };
}

test('mounts the complete host write group behind a narrow dependency boundary', () => {
  const { routes } = createHarness();
  assert.deepEqual([...routes.keys()], EXPECTED_PATHS);
  assert.throws(() => mountHostWriteRoutes({}, {}), /Express app\.post is required/);
  assert.throws(
    () => mountHostWriteRoutes({ post() {} }, {}),
    /host write route dependency missing: readEnvFile/,
  );
  const { deps } = createHarness();
  assert.throws(
    () => mountHostWriteRoutes({ post() {} }, { ...deps, tunnel: {} }),
    /host write route service dependency missing: tunnel\.getStatus/,
  );
});

test('permission matrix preserves authenticated routes and limits only sensitive local settings', async () => {
  const { routes, state } = createHarness();
  for (const routePath of [
    '/api/settings/access-token',
    '/api/settings/official-oauth',
  ]) {
    const response = await invoke(routes, routePath, {
      local: false,
      body: { enabled: true, on: true, token: 'new-token' },
    });
    assert.equal(response.statusCode, 403, routePath);
    assert.equal(typeof response.body.error, 'string', routePath);
  }
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.envWrites, []);

  // These five routes retain their historical permission semantics: the
  // server's global authenticated API middleware protects them, but they do
  // not additionally require a loopback socket.
  for (const [routePath, request] of [
    ['/api/settings/notify', { body: {} }],
    ['/api/settings/tunnel', { body: {} }],
    ['/api/tunnel/restart/:provider', { params: { provider: 'tailscale' } }],
    ['/api/tunnel/funnel', { body: { on: false, port: 3000 } }],
    ['/api/settings/power', { body: { enabled: true } }],
  ]) {
    const response = await invoke(routes, routePath, { local: false, ...request });
    assert.equal(response.statusCode, 200, routePath);
  }
});

test('notification settings preserve placeholders and commit disk before live state', async () => {
  const { routes, deps, state } = createHarness();
  const unchanged = await invoke(routes, '/api/settings/notify', {
    local: true,
    body: {
      barkUrl: 'https://api.day.app/••••',
      webhookUrl: 'https://hooks.example.test/••••',
    },
  });
  assert.deepEqual(unchanged.body, { ok: true });
  assert.deepEqual(state.events, []);

  const changed = await invoke(routes, '/api/settings/notify', {
    local: true,
    body: { barkUrl: '', webhookUrl: 'https://new.example.test/new-hook' },
  });
  assert.deepEqual(changed.body, { ok: true });
  assert.deepEqual(state.events.slice(0, 2), [
    ['persist', { BARK_URL: '', WEBHOOK_URL: 'https://new.example.test/new-hook' }],
    ['notify-live', { BARK_URL: '', WEBHOOK_URL: 'https://new.example.test/new-hook' }],
  ]);
  assert.equal(deps.push.cfg.BARK_URL, '');
  assert.equal(deps.push.cfg.WEBHOOK_URL, 'https://new.example.test/new-hook');
});

test('environment transaction restores disk and live state when publish fails', () => {
  const state = { env: { FLAG: 'old' }, live: 'old', writes: [] };
  const deps = {
    readEnvFile: () => ({ ...state.env }),
    writeEnvFile: update => {
      state.writes.push({ ...update });
      state.env = { ...state.env, ...update };
    },
  };
  assert.throws(() => persistThenApply(
    deps,
    { FLAG: 'new' },
    () => { state.live = 'new'; throw new Error('publish failed'); },
    () => { state.live = 'old'; },
  ), /publish failed/);
  assert.deepEqual(state.writes, [{ FLAG: 'new' }, { FLAG: 'old' }]);
  assert.equal(state.env.FLAG, 'old');
  assert.equal(state.live, 'old');
});

test('environment transaction classifies both rollback failures without exposing raw details', () => {
  const reports = [];
  let writes = 0;
  const deps = {
    readEnvFile: () => ({ FLAG: 'old' }),
    writeEnvFile: () => {
      writes++;
      if (writes > 1) throw new Error('/private/path persistence rollback secret');
    },
    reportFailure: (stage, category) => reports.push({ stage, category }),
  };
  let caught;
  try {
    persistThenApply(
      deps,
      { FLAG: 'new' },
      () => { throw new Error('publish failed'); },
      () => { throw new Error('runtime rollback token=secret'); },
      'test_setting',
    );
  } catch (error) { caught = error; }
  assert.equal(caught.message, 'publish failed');
  assert.equal(caught.rollbackError.message, 'test_setting compensation failed');
  assert.deepEqual(reports, [
    { stage: 'test_setting_persistence_rollback', category: 'compensation_failed' },
    { stage: 'test_setting_runtime_rollback', category: 'compensation_failed' },
  ]);
  assert.equal(JSON.stringify(reports).includes('/private/path'), false);
  assert.equal(JSON.stringify(reports).includes('secret'), false);
});

test('notification persistence failures do not mutate live state or leak details', async () => {
  const secret = '/Users/private/.env token=super-secret';
  const { routes, deps } = createHarness({
    writeEnvFile: () => { throw new Error(secret); },
  });
  const before = { ...deps.push.cfg };
  const response = await invoke(routes, '/api/settings/notify', {
    local: true,
    body: { barkUrl: 'https://new.example.test/private-device' },
  });
  assert.equal(response.body, undefined);
  assert.equal(response.nextError.message, secret);
  assert.deepEqual(deps.push.cfg, before);
  const presented = presentSafely(response.nextError);
  assert.equal(presented.statusCode, 500);
  assert.equal(presented.body.error, 'internal_error');
  assert.equal(JSON.stringify(presented.body).includes('super-secret'), false);
  assert.equal(JSON.stringify(presented.body).includes('/Users/private'), false);
});

test('notification and access-token settings reject injection bytes and unsafe URL schemes', async () => {
  const { routes, state } = createHarness();
  for (const value of [
    'https://hooks.example.test/path\nACCESS_TOKEN=attacker',
    'file:///Users/private/token',
    'javascript:alert(1)',
    `https://example.test/${'x'.repeat(2048)}`,
  ]) {
    const response = await invoke(routes, '/api/settings/notify', {
      local: true,
      body: { webhookUrl: value },
    });
    assert.equal(response.statusCode, 400, value.slice(0, 40));
  }
  assert.equal(validateNotifyUrl('https://hooks.example.test/path'), true);
  assert.equal(validateNotifyUrl('http://127.0.0.1/hook'), true);
  assert.equal(validateNotifyUrl(''), true);
  assert.deepEqual(state.envWrites, []);

  for (const token of ['new\nOTHER=value', 'new\rOTHER=value', 'new\0value']) {
    const response = await invoke(routes, '/api/settings/access-token', {
      local: true,
      body: { token },
    });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(state.accessToken, 'old-token');
  assert.deepEqual(state.envWrites, []);
});

test('tunnel settings validate public access and pass only normalized keys', async () => {
  let received;
  const { routes, state } = createHarness({
    tunnel: {
      getStatus: () => ({ config: {} }),
      applyConfig: update => { received = update; return { ...update, committed: true }; },
      restartNow: async () => ({ ok: true }),
      setFunnel: async () => ({ ok: true }),
      funnelStatus: async () => '',
    },
  });
  state.accessToken = '';
  const guarded = await invoke(routes, '/api/settings/tunnel', {
    local: true,
    body: { tailscale: { enabled: true } },
  });
  assert.equal(guarded.statusCode, 400);
  assert.deepEqual(guarded.body, { error: '开启外网访问前必须先设置 ACCESS_TOKEN' });
  assert.equal(received, undefined);

  const cliGuarded = await invoke(routes, '/api/settings/tunnel', {
    local: true,
    body: { sakurafrp: { enabled: true, url: 'https://sakura.example.test' } },
  });
  assert.equal(cliGuarded.statusCode, 400);
  assert.deepEqual(cliGuarded.body, { error: '开启外网访问前必须先设置 ACCESS_TOKEN' });
  assert.equal(received, undefined);

  state.accessToken = 'token';
  const response = await invoke(routes, '/api/settings/tunnel', {
    local: true,
    body: {
      phddns: { enabled: true, url: '  https://p.example.test  ', ignored: 'drop' },
      tailscale: { enabled: true, url: ' https://t.example.test ', funnel: false, funnelPort: 3456 },
      intervalSec: 40,
      failThreshold: -1,
      ignored: 'drop',
    },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /failThreshold/);
  assert.equal(received, undefined);

  const valid = await invoke(routes, '/api/settings/tunnel', {
    local: true,
    body: {
      phddns: { enabled: true, url: '  https://p.example.test  ', ignored: 'drop' },
      tailscale: { enabled: true, url: ' https://t.example.test ', funnel: true, funnelPort: 3456 },
      natapp: { enabled: false, url: ' https://n.example.test ', authtoken: ' nat-secret ', port: 3100, startCmd: ' natapp -authtoken={authtoken} ', ignored: 'drop' },
      cpolar: { enabled: false, url: '', authtoken: '', port: 3200, startCmd: 'cpolar http {port}' },
      sakurafrp: { enabled: true, url: ' https://sakura.example.test ', authtoken: ' sf-secret ', port: 3300, startCmd: 'frpc -f {authtoken}' },
      intervalSec: 40,
      failThreshold: 2,
      restartCooldownSec: 0,
      maxRestartsPerHour: 5,
      ignored: 'drop',
    },
  });
  assert.deepEqual(received, {
    phddns: { enabled: true, url: 'https://p.example.test' },
    tailscale: { enabled: true, url: 'https://t.example.test' },
    natapp: { enabled: false, url: 'https://n.example.test', authtoken: 'nat-secret', port: 3100, startCmd: 'natapp -authtoken={authtoken}' },
    cpolar: { enabled: false, url: '', authtoken: '', port: 3200, startCmd: 'cpolar http {port}' },
    sakurafrp: { enabled: true, url: 'https://sakura.example.test', authtoken: 'sf-secret', port: 3300, startCmd: 'frpc -f {authtoken}' },
    intervalSec: 40,
    failThreshold: 2,
    restartCooldownSec: 0,
    maxRestartsPerHour: 5,
  });
  assert.deepEqual(valid.body, { ok: true, config: { ...received, committed: true } });
  assert.deepEqual(normalizeTunnelUpdate(null), {});
});

test('tunnel settings reject overflow and fractional guardrails before persistence', async () => {
  let applyCalls = 0;
  const { routes } = createHarness({
    tunnel: {
      getStatus: () => ({ config: {} }),
      applyConfig: update => { applyCalls++; return update; },
      restartNow: async () => ({ ok: true }),
      setFunnel: async () => ({ ok: true }),
      funnelStatus: async () => '',
    },
  });
  for (const body of [
    { intervalSec: 9 },
    { intervalSec: 2147484 },
    { intervalSec: 10.5 },
    { failThreshold: 101 },
    { restartCooldownSec: 86401 },
    { maxRestartsPerHour: 0 },
    { sakurafrp: { url: 'not-a-url' } },
    { sakurafrp: { port: 0 } },
    { sakurafrp: { port: 3000.5 } },
    { sakurafrp: { startCmd: 'frpc\nrm -rf /tmp/x' } },
    { sakurafrp: { authtoken: 'bad\0token' } },
  ]) {
    const response = await invoke(routes, '/api/settings/tunnel', { body });
    assert.equal(response.statusCode, 400, JSON.stringify(body));
  }
  assert.equal(applyCalls, 0);
  assert.equal(validateFunnelPort(1), true);
  assert.equal(validateFunnelPort(65535), true);
  assert.equal(validateFunnelPort(0), false);
  assert.equal(validateFunnelPort(65536), false);
  assert.equal(validateFunnelPort(3000.5), false);
});

test('tunnel restart and funnel keep validation DTO shapes while redacting failures', async () => {
  const secret = '/Users/private/tailscale token=secret';
  let restartResult = { ok: false, error: secret };
  let funnelResult = { ok: false, message: secret };
  const { routes, deps } = createHarness({
    tunnel: {
      getStatus: () => ({ config: {} }),
      applyConfig: update => update,
      restartNow: async () => restartResult,
      setFunnel: async () => funnelResult,
      funnelStatus: async () => 'status',
    },
  });
  const restartFailure = await invoke(routes, '/api/tunnel/restart/:provider', {
    local: true,
    params: { provider: 'tailscale' },
  });
  assert.equal(restartFailure.statusCode, 400);
  assert.deepEqual(restartFailure.body, { ok: false, error: 'tunnel_restart_failed' });
  const funnelFailure = await invoke(routes, '/api/tunnel/funnel', {
    local: true,
    body: { on: false, port: 3000 },
  });
  assert.equal(funnelFailure.statusCode, 400);
  assert.deepEqual(funnelFailure.body, { ok: false, message: 'Funnel 操作失败' });
  assert.equal(JSON.stringify([restartFailure.body, funnelFailure.body]).includes('secret'), false);

  restartResult = { ok: false, error: 'unknown provider' };
  assert.deepEqual((await invoke(routes, '/api/tunnel/restart/:provider', {
    local: true,
    params: { provider: 'other' },
  })).body, { ok: false, error: 'unknown provider' });

  deps.getAccessToken = () => 'token';
  restartResult = { ok: true, message: '已重启' };
  funnelResult = { ok: true, message: '已开启' };
  assert.deepEqual((await invoke(routes, '/api/tunnel/restart/:provider', {
    local: true,
    params: { provider: 'tailscale' },
  })).body, { ok: true, message: '已重启' });
  assert.deepEqual((await invoke(routes, '/api/tunnel/funnel', {
    local: true,
    body: { on: true, port: 4000 },
  })).body, { ok: true, message: '已开启', status: 'status' });
});

test('funnel success stays committed when the diagnostic status probe fails', async () => {
  let committed = false;
  const reports = [];
  const { routes } = createHarness({
    tunnel: {
      getStatus: () => ({ config: {} }),
      applyConfig: update => update,
      restartNow: async () => ({ ok: true }),
      setFunnel: async () => { committed = true; return { ok: true, message: 'committed' }; },
      funnelStatus: async () => { throw new Error('/private/tailscale status secret'); },
    },
    reportFailure: (stage, category) => reports.push({ stage, category }),
  });
  const response = await invoke(routes, '/api/tunnel/funnel', {
    body: { on: true, port: 3000 },
  });
  assert.equal(committed, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, message: 'committed', status: '' });
  assert.equal(response.nextError, undefined);
  assert.deepEqual(reports, [{ stage: 'funnel_status_probe', category: 'status_unavailable' }]);
  assert.equal(JSON.stringify(reports).includes('private'), false);
  assert.equal(JSON.stringify(reports).includes('secret'), false);
});

test('funnel endpoint rejects malformed booleans and ports without external effects', async () => {
  let calls = 0;
  const { routes } = createHarness({
    tunnel: {
      getStatus: () => ({ config: {} }),
      applyConfig: update => update,
      restartNow: async () => ({ ok: true }),
      setFunnel: async () => { calls++; return { ok: true }; },
      funnelStatus: async () => '',
    },
  });
  for (const body of [
    { on: 'true', port: 3000 },
    { on: true, port: 0 },
    { on: true, port: 65536 },
    { on: true, port: 3000.5 },
  ]) {
    const response = await invoke(routes, '/api/tunnel/funnel', { body });
    assert.equal(response.statusCode, 400, JSON.stringify(body));
  }
  assert.equal(calls, 0);
});

test('access-token writes durably before hot reload and refuses unsafe clearing', async () => {
  const { routes, state, deps } = createHarness();
  const updated = await invoke(routes, '/api/settings/access-token', {
    local: true,
    body: { token: '  new-token  ' },
  });
  assert.deepEqual(updated.body, { ok: true, hasToken: true });
  assert.deepEqual(state.events.slice(0, 2), [
    ['persist', { ACCESS_TOKEN: 'new-token' }],
    ['access-live', 'new-token'],
  ]);
  assert.equal(state.accessToken, 'new-token');

  assert.equal((await invoke(routes, '/api/settings/access-token', {
    local: true,
    body: { token: '****oken' },
  })).statusCode, 400);

  state.allowRemote = true;
  const guarded = await invoke(routes, '/api/settings/access-token', {
    local: true,
    body: { token: '' },
  });
  assert.equal(guarded.statusCode, 400);
  assert.equal(state.accessToken, 'new-token');

  const cliTunnel = createHarness({
    tunnel: {
      getStatus: () => ({ config: { sakurafrp: { enabled: true } } }),
      applyConfig: update => update,
      restartNow: async () => ({ ok: true }),
      setFunnel: async () => ({ ok: true }),
      funnelStatus: async () => '',
    },
  });
  const cliGuarded = await invoke(cliTunnel.routes, '/api/settings/access-token', {
    local: true,
    body: { token: '' },
  });
  assert.equal(cliGuarded.statusCode, 400);
  assert.equal(cliTunnel.state.accessToken, 'old-token');
});

test('access-token and boolean persistence failures leave live values unchanged', async () => {
  const secret = 'disk full at /Users/private/.env';
  const { routes, state } = createHarness({
    writeEnvFile: () => { throw new Error(secret); },
  });
  const access = await invoke(routes, '/api/settings/access-token', {
    local: true,
    body: { token: 'new-token' },
  });
  const oauth = await invoke(routes, '/api/settings/official-oauth', {
    local: true,
    body: { enabled: true },
  });
  assert.equal(access.nextError.message, secret);
  assert.equal(oauth.nextError.message, secret);
  assert.equal(state.accessToken, 'old-token');
  assert.equal(state.oauthEnabled, false);
  for (const response of [access, oauth]) {
    const presented = presentSafely(response.nextError);
    assert.equal(presented.body.error, 'internal_error');
    assert.equal(JSON.stringify(presented.body).includes('/Users/private'), false);
  }
});

test('official OAuth validates booleans, preserves response DTOs and persists before going live', async () => {
  const { routes, state } = createHarness();
  assert.deepEqual((await invoke(routes, '/api/settings/official-oauth', {
    local: true,
    body: { enabled: 'true' },
  })).body, { error: 'enabled 必须是布尔' });

  const oauth = await invoke(routes, '/api/settings/official-oauth', {
    local: true,
    body: { enabled: true },
  });
  assert.deepEqual(oauth.body, { ok: true, enabled: true });
  assert.equal(state.oauthEnabled, true);
  const oauthPersist = state.events.findIndex(([type, value]) => type === 'persist' && value.CLAUDE_OFFICIAL_VIA_PROXY === '1');
  const oauthLive = state.events.findIndex(([type]) => type === 'oauth-live');
  assert.ok(oauthPersist >= 0 && oauthPersist < oauthLive);
});

test('power settings preserve success and validation responses and redact thrown errors', async () => {
  const unavailable = createHarness({
    macosPower: { isAvailable: () => false, setLidSleepPrevention: async () => ({}) },
  });
  assert.deepEqual((await invoke(unavailable.routes, '/api/settings/power', {
    local: true,
    body: { enabled: true },
  })).body, { error: 'This setting is only available on macOS' });

  const { routes } = createHarness();
  assert.deepEqual((await invoke(routes, '/api/settings/power', {
    local: true,
    body: { enabled: 'true' },
  })).body, { error: 'enabled must be a boolean' });
  // 权限：这个接口只做一件事（关盖运行），所以没有第二个字段可选。
  assert.deepEqual((await invoke(routes, '/api/settings/power', {
    local: true,
    body: {},
  })).body, { error: 'enabled must be a boolean' });
  assert.deepEqual((await invoke(routes, '/api/settings/power', {
    local: true,
    body: { enabled: true },
  })).body, {
    ok: true,
    available: true,
    enabled: true,
    unlockPassword: { available: true, set: true, canEdit: true, requested: false, enabled: true, requiredByLid: true },
  });

  const failure = createHarness({
    macosPower: {
      isAvailable: () => true,
      setLidSleepPrevention: async () => { throw new Error('/Users/private power secret'); },
    },
  });
  const response = await invoke(failure.routes, '/api/settings/power', {
    local: true,
    body: { enabled: true },
  });
  assert.equal(presentSafely(response.nextError).body.error, 'internal_error');
});

test('power route releases off intent and presents expected failures without leaking command output', async () => {
  const power = require('../plugins/utils/macos-power');
  let intent = 'off';
  const options = { platform: 'darwin', powerdWaitMs: 0,
    powerd: { readIntent: () => intent, setIntent: value => { intent = value ? 'on' : 'off'; return true; } },
    execFile: (file, args, opts, cb) => cb(null, 'SleepDisabled 1\n', '') };
  const { routes } = createHarness({ macosPower: {
    isAvailable: () => true,
    setLidSleepPrevention: enabled => power.setLidSleepPrevention(enabled, options),
    getLidModeSettings: () => power.getLidModeSettings(options),
  } });
  const off = await invoke(routes, '/api/settings/power', { local: true, body: { enabled: false } });
  assert.equal(off.body.ok, true);
  assert.equal(off.body.enabled, false);
  assert.equal(off.body.systemSleepDisabled, true);

  for (const [code, overrides] of [
    ['power_application_pending', { execFile: (file, args, opts, cb) => cb(null, 'SleepDisabled 0\n', '') }],
    ['power_authorization_cancelled', { powerd: { setIntent: () => false },
      execFile: (file, args, opts, cb) => cb(new Error('User canceled. (-128) /Users/private secret'), '', '') }],
  ]) {
    const failed = createHarness({ macosPower: { isAvailable: () => true,
      setLidSleepPrevention: enabled => power.setLidSleepPrevention(enabled, { ...options, ...overrides }) } });
    const response = await invoke(failed.routes, '/api/settings/power', { local: true, body: { enabled: true } });
    const presented = presentSafely(response.nextError);
    assert.equal(presented.statusCode, 409);
    assert.equal(presented.body.code, code);
    assert.doesNotMatch(presented.body.error, /internal_error|private|secret/);
  }
});

test('lid and unlock switches preserve independent consent and reject incomplete setup', async () => {
  let current = false, requested = false, set = true, authorized = true;
  let writes = 0, clears = 0;
  const { routes } = createHarness({
    macosPower: {
      isAvailable: () => true,
      setLidSleepPrevention: async enabled => { current = enabled; writes++; },
      getLidModeSettings: async () => ({ available: true, enabled: current }),
    },
    powerPreferences: { read: () => requested, write: value => { requested = value; } },
    unlockPassword: { isAvailable: () => true, hasPassword: async () => set, clearPassword: async () => { clears++; } },
    unlockProbe: { probe: async () => ({ state: authorized ? 'authorized' : 'waiting-for-user' }), runtimeReady: async () => true },
  });
  const change = (path, enabled) => invoke(routes, '/api/settings/power' + path, { local: true, body: { enabled } });
  set = false;
  assert.equal((await change('', true)).statusCode, 409);
  assert.equal(writes, 0);
  set = true; authorized = false;
  assert.equal((await change('', true)).statusCode, 409);
  assert.equal(writes, 0);
  authorized = true;
  assert.equal((await change('', true)).body.unlockPassword.enabled, true);
  assert.equal(requested, false, 'lid mode does not overwrite independent choice');
  assert.equal((await change('/auto-unlock', false)).statusCode, 409);
  assert.equal((await invoke(routes, '/api/settings/power/unlock-password', { local: true, method: 'DELETE' })).statusCode, 409);
  assert.equal(clears, 0);
  assert.equal((await change('', false)).body.unlockPassword.enabled, false);
  assert.equal((await change('/auto-unlock', true)).body.unlockPassword.enabled, true);
  await change('', true);
  assert.equal((await change('', false)).body.unlockPassword.enabled, true);
  const off = await change('/auto-unlock', false);
  assert.equal(off.body.unlockPassword.enabled, false);
  assert.equal(off.body.unlockPassword.set, true, 'turning off keeps saved password');
  assert.equal(clears, 0);
});

test('unlock password write requires a local socket and never leaks the value', async () => {
  const writes = [];
  const clears = [];
  const { routes } = createHarness({
    macosPower: { isAvailable: () => true, setLidSleepPrevention: async () => {}, getLidModeSettings: async () => ({ available: true, enabled: false }) },
    unlockPassword: {
      isAvailable: () => true,
      hasPassword: async () => true,
      setPassword: async password => { writes.push(password); },
      clearPassword: async () => { clears.push(1); },
    },
  });

  // 远程请求被拒
  const remote = await invoke(routes, '/api/settings/power/unlock-password', {
    local: false,
    body: { password: 'sekret' },
  });
  assert.equal(remote.statusCode, 403);
  assert.deepEqual(writes, []);

  const saved = await invoke(routes, '/api/settings/power/unlock-password', {
    local: true,
    body: { password: 'sekret' },
  });
  assert.equal(saved.statusCode, 200);
  // 保存成功之后必须**当场**回一次「Agent 读不读得到」：没授权时那个系统框要弹在
  // 用户面前（此刻屏幕是解锁的），不能拖到锁屏时才弹——那时点不到，Agent 会卡死。
  assert.deepEqual(saved.body, { ok: true, set: true, authorization: { state: 'authorized' } });
  assert.deepEqual(writes, ['sekret']);

  const invalid = await invoke(routes, '/api/settings/power/unlock-password', {
    local: true,
    body: { password: '' },
  });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(writes, ['sekret'], 'empty password is refused before writing');

  const cleared = await invoke(routes, '/api/settings/power/unlock-password', {
    local: true,
    method: 'DELETE',
  });
  assert.equal(cleared.statusCode, 200);
  assert.deepEqual(cleared.body, { ok: true, set: false });
  assert.deepEqual(clears, [1]);
});

test('unlock authorization can be re-checked without retyping the password', async () => {
  let probes = 0;
  const { routes } = createHarness({
    unlockPassword: {
      isAvailable: () => true,
      hasPassword: async () => true,
      setPassword: async () => {},
      clearPassword: async () => {},
    },
    unlockProbe: {
      isAvailable: () => true,
      probe: async () => { probes += 1; return { state: 'waiting-for-user' }; },
    },
  });

  // 远程请求照样被拒（和写密码同一条本机专属规矩）
  assert.equal((await invoke(routes, '/api/settings/power/unlock-password/authorize', {
    local: false,
  })).statusCode, 403);
  assert.equal(probes, 0);

  const checked = await invoke(routes, '/api/settings/power/unlock-password/authorize', { local: true });
  assert.equal(checked.statusCode, 200);
  assert.deepEqual(checked.body, { ok: true, authorization: { state: 'waiting-for-user' } });
  assert.equal(probes, 1);

  // 没条目时不必去问 Agent（也就不会弹任何框）
  const empty = createHarness({
    unlockPassword: { isAvailable: () => true, hasPassword: async () => false },
    unlockProbe: {
      isAvailable: () => true,
      probe: async () => { throw new Error('must not probe without an item'); },
    },
  });
  assert.deepEqual((await invoke(empty.routes, '/api/settings/power/unlock-password/authorize', {
    local: true,
  })).body, { ok: true, authorization: { state: 'no-password' } });

  // 探测本身炸了（Agent 没装/没在跑）不能说成保存失败：它只是「没能确认」
  const broken = createHarness({
    unlockProbe: { isAvailable: () => true, probe: async () => { throw new Error('spawn ENOENT'); } },
  });
  assert.deepEqual((await invoke(broken.routes, '/api/settings/power/unlock-password', {
    local: true,
    body: { password: 'sekret' },
  })).body, { ok: true, set: true, authorization: { state: 'unavailable', detail: 'probe-failed' } });
});

test('tunnel applyConfig requires durable save before publishing memory', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-host-write-tunnel-'));
  const previousDataDir = process.env.MULTICC_DATA_DIR;
  const modulePath = require.resolve('../src/tunnel');
  process.env.MULTICC_DATA_DIR = dataDir;
  delete require.cache[modulePath];
  const configPath = path.join(dataDir, 'tunnel-config.json');
  fs.mkdirSync(configPath);
  let tunnel;
  try {
    tunnel = require('../src/tunnel');
    const before = JSON.parse(JSON.stringify(tunnel.getStatus().config));
    assert.throws(
      () => tunnel.applyConfig({ phddns: { enabled: true, url: 'https://example.test' } }),
      /EISDIR|directory|rename/i,
    );
    assert.deepEqual(tunnel.getStatus().config, before);
    assert.equal(tunnel.getStatus().monitorRunning, false);
  } finally {
    if (tunnel) tunnel.stop();
    delete require.cache[modulePath];
    if (previousDataDir === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('tunnel applyConfig compensates durable state when scheduler publish fails', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-host-write-scheduler-'));
  const previousDataDir = process.env.MULTICC_DATA_DIR;
  const originalSetInterval = global.setInterval;
  const modulePath = require.resolve('../src/tunnel');
  process.env.MULTICC_DATA_DIR = dataDir;
  delete require.cache[modulePath];
  let tunnel;
  try {
    tunnel = require('../src/tunnel');
    const before = JSON.parse(JSON.stringify(tunnel.getStatus().config));
    let calls = 0;
    global.setInterval = () => {
      calls++;
      throw new Error('scheduler publish failed');
    };
    assert.throws(
      () => tunnel.applyConfig({ phddns: { enabled: true, url: 'https://example.test' } }),
      /scheduler publish failed/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(tunnel.getStatus().config, before);
    assert.equal(tunnel.getStatus().monitorRunning, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'tunnel-config.json'), 'utf8')), before);
  } finally {
    global.setInterval = originalSetInterval;
    if (tunnel) tunnel.stop();
    delete require.cache[modulePath];
    if (previousDataDir === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('PhDDNS restart reports launch failure instead of a false success', async () => {
  const tunnel = require('../src/tunnel');
  const commands = [];
  await assert.rejects(
    tunnel.restartPhddns({
      run: async (command, args) => {
        commands.push([command, args]);
        if (command === '/usr/bin/open') {
          return { ok: false, stderr: '/private/path launch token=secret' };
        }
        return { ok: false, stderr: 'not running' };
      },
      wait: async () => {},
    }),
    error => error.message === 'phddns start failed',
  );
  assert.deepEqual(commands.map(([command]) => command), ['/usr/bin/killall', '/usr/bin/open']);
});

test('Funnel persistence compensation failure marks only a bounded degraded status', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-host-write-funnel-comp-'));
  const previousDataDir = process.env.MULTICC_DATA_DIR;
  const modulePath = require.resolve('../src/tunnel');
  process.env.MULTICC_DATA_DIR = dataDir;
  delete require.cache[modulePath];
  let tunnel;
  try {
    tunnel = require('../src/tunnel');
    const reports = [];
    tunnel.setFailureReporter((stage, category) => reports.push({ stage, category }));
    let commands = 0;
    await assert.rejects(
      tunnel.setFunnel(true, 3000, {
        run: async () => {
          commands++;
          return commands === 1
            ? { ok: true, stdout: '', stderr: '' }
            : { ok: false, stdout: '', stderr: '/private/rollback token=secret' };
        },
        persist: () => { throw new Error('/private/config write failed'); },
      }),
      /config write failed/,
    );
    assert.equal(commands, 2);
    assert.deepEqual(reports, [{ stage: 'funnel_compensation', category: 'compensation_failed' }]);
    assert.equal(tunnel.getStatus().config.tailscale.funnel, false);
    const publicConsistency = tunnel.getStatus().consistency;
    assert.equal(publicConsistency.degraded, true);
    assert.equal(publicConsistency.dirty, true);
    assert.equal(publicConsistency.reason, 'funnel_compensation');
    assert.equal(Number.isFinite(publicConsistency.lastFailureAt), true);
    assert.equal(JSON.stringify(publicConsistency).includes('/private'), false);
    assert.equal(JSON.stringify(publicConsistency).includes('secret'), false);
  } finally {
    if (tunnel) {
      tunnel.stop();
      tunnel.setFailureReporter(null);
    }
    delete require.cache[modulePath];
    if (previousDataDir === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('tunnel config exposes natapp/cpolar/sakurafrp providers with default schema', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-tunnel-providers-'));
  const previousDataDir = process.env.MULTICC_DATA_DIR;
  const modulePath = require.resolve('../src/tunnel');
  process.env.MULTICC_DATA_DIR = dataDir;
  delete require.cache[modulePath];
  let tunnel;
  try {
    tunnel = require('../src/tunnel');
    const status = tunnel.getStatus();
    assert.deepEqual(status.config.natapp, {
      enabled: false, monitorOnly: false, url: '', authtoken: '', port: 3000, startCmd: 'natapp -authtoken={authtoken}',
    });
    assert.deepEqual(status.config.cpolar, {
      enabled: false, monitorOnly: false, url: '', authtoken: '', port: 3000, startCmd: 'cpolar http {port}',
    });
    assert.deepEqual(status.config.sakurafrp, {
      enabled: false, monitorOnly: false, url: '', authtoken: '', port: 3000, startCmd: 'frpc -f {authtoken}',
    });
    for (const name of ['natapp', 'cpolar', 'sakurafrp']) {
      assert.equal(typeof status.availability[name], 'boolean', `availability.${name}`);
      assert.ok(status.providers[name], `providers.${name} present`);
      assert.equal(status.providers[name].checking, false, `providers.${name}.checking`);
    }
    // restartNow dispatches the new restarters via RESTARTERS; an unknown name
    // is still rejected so the route surface is unchanged for foreign input.
    assert.deepEqual(await tunnel.restartNow('nope'), { ok: false, error: 'unknown provider' });
  } finally {
    if (tunnel) tunnel.stop();
    delete require.cache[modulePath];
    if (previousDataDir === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('SakuraFrp settings round-trip through the HTTP boundary and durable reload', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-sakurafrp-roundtrip-'));
  const previousDataDir = process.env.MULTICC_DATA_DIR;
  const modulePath = require.resolve('../src/tunnel');
  process.env.MULTICC_DATA_DIR = dataDir;
  delete require.cache[modulePath];
  let tunnel;
  try {
    tunnel = require('../src/tunnel');
    const { routes } = createHarness({
      tunnel,
      getAccessToken: () => 'configured-access-token',
    });
    const expected = {
      enabled: true,
      monitorOnly: false,
      url: 'https://sakura.example.test/manage',
      authtoken: 'sakura-secret',
      port: 3300,
      startCmd: 'frpc -f {authtoken}',
    };
    const response = await invoke(routes, '/api/settings/tunnel', {
      local: true,
      body: { sakurafrp: { ...expected } },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.deepEqual(response.body.config.sakurafrp, expected);
    assert.deepEqual(tunnel.getStatus().config.sakurafrp, expected);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dataDir, 'tunnel-config.json'), 'utf8')).sakurafrp,
      expected,
    );

    tunnel.stop();
    delete require.cache[modulePath];
    tunnel = require('../src/tunnel');
    tunnel.init();
    assert.deepEqual(tunnel.getStatus().config.sakurafrp, expected);

    // 旧 manage 页那份 host-settings 模块随该页删除；同一条口径（服务端给的
    // message/error 优先于裸 HTTP 状态码）现在落在 Air 唯一的请求出口上。
    const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'air.js'), 'utf8');
    assert.match(ui, /result\.message \|\| result\.error \|\| result\.code \|\| `HTTP \$\{response\.status\}`/);
  } finally {
    if (tunnel) tunnel.stop();
    delete require.cache[modulePath];
    if (previousDataDir === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('tunnel config reports persistence and runtime rollback failures by safe stage', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-host-write-config-comp-'));
  const previousDataDir = process.env.MULTICC_DATA_DIR;
  const modulePath = require.resolve('../src/tunnel');
  process.env.MULTICC_DATA_DIR = dataDir;
  delete require.cache[modulePath];
  let tunnel;
  try {
    tunnel = require('../src/tunnel');
    const reports = [];
    tunnel.setFailureReporter((stage, category) => reports.push({ stage, category }));
    let persistCalls = 0;
    assert.throws(() => tunnel.applyConfig(
      { phddns: { enabled: true, url: 'https://example.test' } },
      {
        persist: () => {
          persistCalls++;
          if (persistCalls > 1) throw new Error('/private/persistence rollback secret');
        },
        publish: () => { throw new Error('/private/runtime publish secret'); },
      },
    ), /runtime publish secret/);
    assert.deepEqual(reports, [
      { stage: 'config_persistence_rollback', category: 'compensation_failed' },
      { stage: 'config_runtime_rollback', category: 'compensation_failed' },
    ]);
    assert.equal(tunnel.getStatus().config.phddns.enabled, false);
    const publicConsistency = tunnel.getStatus().consistency;
    assert.deepEqual({
      degraded: publicConsistency.degraded,
      dirty: publicConsistency.dirty,
      reason: publicConsistency.reason,
    }, {
      degraded: true,
      dirty: true,
      reason: 'config_runtime_rollback',
    });
    assert.equal(JSON.stringify(reports).includes('/private'), false);
    assert.equal(JSON.stringify(publicConsistency).includes('secret'), false);
  } finally {
    if (tunnel) {
      tunnel.stop();
      tunnel.setFailureReporter(null);
    }
    delete require.cache[modulePath];
    if (previousDataDir === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
