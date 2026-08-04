'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-kimi-code-'));
const dataDir = path.join(root, 'data');
const fakeHome = path.join(root, 'home');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(fakeHome, { recursive: true });
process.env.MULTICC_DATA_DIR = dataDir;
process.env.HOME = fakeHome;
delete process.env.KIMI_API_KEY;
delete process.env.KIMI_CODE_HOME;

const providers = require('../src/providers');
const kimiAuth = require('../src/cli-adapters/kimi-auth');
const { mountKimiAuthRoutes } = require('../src/routes/kimi-auth');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('registration chain exposes kimi across every integration point', () => {
  const { SUPPORTED_CHAT_CLIS } = require('../src/cli-switch');
  assert.equal(SUPPORTED_CHAT_CLIS.includes('kimi'), true);

  const { SUPPORTED_CLIS } = require('../src/session-dto');
  assert.equal(SUPPORTED_CLIS.has('kimi'), true);

  const schema = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'contracts', 'v1', 'schemas', 'session.schema.json'), 'utf8',
  ));
  assert.equal(schema.properties.cli.enum.includes('kimi'), true);

  const chatHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat.js'), 'utf8');
  assert.match(chatHtml, /kimi:\s*\{\s*label:\s*'Kimi Code'/);

  const { OFFICIAL_INSTALL_SPECS } = require('../src/cli/switch-runtime');
  assert.deepEqual(OFFICIAL_INSTALL_SPECS.kimi, {
    auto: true,
    command: 'npm install -g @moonshot-ai/kimi-code',
    display: 'npm install -g @moonshot-ai/kimi-code',
  });

  const { resolveCliCommands } = require('../src/cli-adapters/commands');
  const commands = resolveCliCommands({
    isWindows: false, env: { KIMI_CMD: '/custom/kimi', PATH: '' }, homeDir: fakeHome,
  });
  assert.equal(commands.kimi, '/custom/kimi');

  assert.deepEqual(providers.appTypesForCli('kimi'), ['claude', 'codex']);
  assert.equal(providers.compatibleClisForFormat('openai_chat').includes('kimi'), true);
  assert.equal(providers.compatibleClisForFormat('openai_responses').includes('kimi'), true);
  assert.equal(providers.compatibleClisForFormat('anthropic').includes('kimi'), false);
});

test('kimi provider routing requires HTTP credentials and stays fail-closed', () => {
  assert.equal(providers.providerSupportsCli({
    appType: 'codex', apiFormat: 'openai_chat',
    baseUrl: 'https://moonshot.example/v1', hasToken: true,
  }, 'kimi'), true);
  assert.equal(providers.providerSupportsCli({
    appType: 'codex', apiFormat: 'openai_chat',
    baseUrl: '', hasToken: false, isOfficial: true,
  }, 'kimi'), false, 'another CLI cannot replay an OAuth-only binding');
  assert.equal(providers.providerSupportsCli({
    appType: 'claude', apiFormat: 'anthropic',
    baseUrl: 'https://anthropic.example', hasToken: true,
  }, 'kimi'), false, 'anthropic-format relays are outside the kimi wire pool');

  assert.throws(
    () => providers.resolveSpawnEnv({ id: 'kimi-missing', cli: 'kimi', provider: 'no-such-provider' }),
    /Kimi Provider/,
  );
});

test('resolveSpawnEnv injects KIMI_API_KEY/KIMI_BASE_URL into an isolated home', () => {
  const providerId = providers.createProvider({
    appType: 'codex', name: 'Kimi Chat', baseUrl: 'https://kimi.example/v1',
    authToken: 'kimi-secret', model: 'kimi-k2', apiFormat: 'openai_chat',
  }).id;

  const spawn = providers.resolveSpawnEnv({
    id: 'kimi-session-1', cli: 'kimi', provider: providerId, model: 'kimi-k2',
  });
  assert.equal(spawn.env.KIMI_API_KEY, 'kimi-secret');
  assert.equal(spawn.env.KIMI_BASE_URL, 'https://kimi.example/v1');
  assert.ok(spawn.env.KIMI_CODE_HOME.startsWith(providers.KIMI_HOMES_DIR));
  assert.ok(spawn.env.KIMI_CODE_HOME.startsWith(path.join(fakeHome, '.multicc')));
  assert.equal(fs.statSync(spawn.env.KIMI_CODE_HOME).isDirectory(), true);
  assert.equal(spawn.providerName, 'Kimi Chat');

  const other = providers.resolveSpawnEnv({
    id: 'kimi-session-2', cli: 'kimi', provider: providerId, model: 'kimi-k2',
  });
  assert.notEqual(other.env.KIMI_CODE_HOME, spawn.env.KIMI_CODE_HOME, 'each session owns an isolated KIMI_CODE_HOME');

  const keyless = providers.createProvider({
    appType: 'codex', name: 'Kimi Keyless', baseUrl: 'https://kimi-keyless.example/v1',
    authToken: '', model: 'kimi-k2', apiFormat: 'openai_chat',
  }).id;
  assert.throws(
    () => providers.resolveSpawnEnv({ id: 'kimi-keyless', cli: 'kimi', provider: keyless }),
    /Kimi Provider/,
  );
});

test('kimi auth status honors env key, credentials dir, and provider bypass', () => {
  const home = path.join(root, 'kimi-home');

  assert.deepEqual(
    kimiAuth.getKimiAuthStatus({ KIMI_API_KEY: 'sk-env', KIMI_CODE_HOME: home }),
    { configured: true, hasKey: true, source: 'env_key' },
  );
  assert.deepEqual(
    kimiAuth.getKimiAuthStatus({ KIMI_CODE_HOME: home }),
    { configured: false, hasKey: false, source: 'none' },
  );

  fs.mkdirSync(path.join(home, 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(home, 'credentials', 'moonshot.json'), JSON.stringify({ token: 'x' }));
  assert.deepEqual(
    kimiAuth.getKimiAuthStatus({ KIMI_CODE_HOME: home }),
    { configured: true, hasKey: true, source: 'credentials' },
  );

  assert.deepEqual(
    kimiAuth.ensureKimiAuth({ provider: 'some-provider' }, { KIMI_CODE_HOME: home }),
    { ok: true, provider: 'some-provider', source: 'multicc_provider' },
  );
  assert.equal(kimiAuth.ensureKimiAuth(null, { KIMI_CODE_HOME: home }).ok, true);
  const missing = kimiAuth.ensureKimiAuth(null, { KIMI_CODE_HOME: path.join(root, 'empty-home') });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'configuration_required');
  assert.match(missing.message, /Kimi Code 尚未登录/);
});

test('verification URL parser only accepts https device-login links', () => {
  assert.equal(
    kimiAuth.parseKimiLoginVerificationUrl('Opening browser for Kimi device login: https://kimi.example/device?user_code=ABCD'),
    'https://kimi.example/device?user_code=ABCD',
  );
  assert.equal(kimiAuth.parseKimiLoginVerificationUrl('Waiting for authorization to complete...'), null);
  assert.equal(kimiAuth.parseKimiLoginVerificationUrl('Kimi device login: http://insecure'), null);
  assert.equal(kimiAuth.parseKimiLoginVerificationUrl(''), null);
});

function createFakeApp() {
  const routes = {};
  return {
    routes,
    get: (route, handler) => { routes[`GET ${route}`] = handler; },
    post: (route, handler) => { routes[`POST ${route}`] = handler; },
    put: (route, handler) => { routes[`PUT ${route}`] = handler; },
  };
}

function invoke(app, key) {
  const handler = app.routes[key];
  assert.ok(handler, `missing route ${key}`);
  let payload = null;
  let statusCode = 200;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return this; },
  };
  handler({}, res);
  return { payload, statusCode };
}

function createFakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

test('kimi auth routes report status and gate the device-code login', async () => {
  const configuredEnv = { KIMI_API_KEY: 'sk-route' };
  const app = createFakeApp();
  mountKimiAuthRoutes(app, {
    kimiAuth: {
      getKimiAuthStatus: (env) => kimiAuth.getKimiAuthStatus(env || configuredEnv),
      isKimiLoginAvailable: () => true,
      ensureKimiAuth: () => ({ ok: true, source: 'env_key' }),
      parseKimiLoginVerificationUrl: kimiAuth.parseKimiLoginVerificationUrl,
      spawnKimiLogin: () => createFakeChild(),
    },
    loginWaitMs: 60000,
    urlCaptureMs: 1000,
  });

  const status = invoke(app, 'GET /api/kimi/auth');
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.payload, { ok: true, configured: true, hasKey: true, source: 'env_key', loginAvailable: true });

  const check = invoke(app, 'GET /api/kimi/auth/check');
  assert.equal(check.statusCode, 200);
  assert.equal(check.payload.ok, true);
});

test('login route opens the managed browser and resolves on CLI exit', async () => {
  const child = createFakeChild();
  let openedUrl = null;
  const app = createFakeApp();
  mountKimiAuthRoutes(app, {
    kimiAuth: {
      getKimiAuthStatus: () => ({ configured: true, hasKey: true, source: 'credentials' }),
      isKimiLoginAvailable: () => true,
      ensureKimiAuth: () => ({ ok: true, source: 'credentials' }),
      parseKimiLoginVerificationUrl: kimiAuth.parseKimiLoginVerificationUrl,
      spawnKimiLogin: () => child,
    },
    getBrowser: () => ({
      openVisibleLogin: async (url) => { openedUrl = url; return { ok: true }; },
    }),
    loginWaitMs: 60000,
    urlCaptureMs: 1000,
  });

  let resolvedPayload = null;
  let resolvedStatus = null;
  const res = {
    status(code) { resolvedStatus = code; return this; },
    json(body) { resolvedPayload = body; return this; },
  };
  app.routes['POST /api/kimi/auth/login']({}, res);

  child.stderr.emit('data', 'Opening browser for Kimi device login: https://kimi.example/device?user_code=ZZZZ\n');
  await new Promise(resolve => setImmediate(resolve));
  child.emit('close', 0);

  assert.equal(openedUrl, 'https://kimi.example/device?user_code=ZZZZ', 'verification URL goes to the managed visible browser');
  assert.equal(resolvedStatus, 200);
  assert.deepEqual(resolvedPayload, {
    ok: true, code: 'login_success', browserOpened: true,
    configured: true, hasKey: true, source: 'credentials',
  });
});

test('login route rejects with cli_not_found and surfaces non-zero exits', () => {
  const unavailableApp = createFakeApp();
  mountKimiAuthRoutes(unavailableApp, {
    kimiAuth: {
      getKimiAuthStatus: () => ({ configured: false, hasKey: false, source: 'none' }),
      isKimiLoginAvailable: () => false,
      ensureKimiAuth: () => ({ ok: false, code: 'configuration_required' }),
      parseKimiLoginVerificationUrl: kimiAuth.parseKimiLoginVerificationUrl,
      spawnKimiLogin: () => { throw new Error('no cli'); },
    },
  });
  const missing = invoke(unavailableApp, 'POST /api/kimi/auth/login');
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.payload.code, 'cli_not_found');
  assert.match(missing.payload.message, /@moonshot-ai\/kimi-code/);

  const failedChild = createFakeChild();
  const failedApp = createFakeApp();
  mountKimiAuthRoutes(failedApp, {
    kimiAuth: {
      getKimiAuthStatus: () => ({ configured: false, hasKey: false, source: 'none' }),
      isKimiLoginAvailable: () => true,
      ensureKimiAuth: () => ({ ok: false, code: 'configuration_required' }),
      parseKimiLoginVerificationUrl: kimiAuth.parseKimiLoginVerificationUrl,
      spawnKimiLogin: () => failedChild,
    },
    loginWaitMs: 60000,
    urlCaptureMs: 1000,
  });
  let failedPayload = null;
  const res = {
    status() { return this; },
    json(body) { failedPayload = body; return this; },
  };
  failedApp.routes['POST /api/kimi/auth/login']({}, res);
  failedChild.emit('close', 1);
  assert.equal(failedPayload.code, 'login_failed');
  assert.equal(failedPayload.exitCode, 1);
});
