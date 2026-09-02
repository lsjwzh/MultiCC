'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const express = require('express');
const providerRouter = require('cli-provider-router');
const { assertTestDir } = require('../src/paths');
const { isLocalRequest, isPrivateRequestPeer } = require('../src/request-locality');
const {
  createProviderProxyAdmission,
  createProviderProxyGuard,
} = require('../src/provider-proxy-guard');
const { createAuthRuntime } = require('../src/routes/auth');
const { createProviderRoutes } = require('../src/routes/providers');

const RELAY_UI_FILE = path.join(__dirname, '..', 'public', 'manage-provider-relay.js');
const ACCESS_TOKEN = 'two-ip-admin-secret';
const RELAY_TOKEN = 'mcpr_two_ip_relay_secret';
const UPSTREAM_TOKEN = 'two-ip-upstream-secret';
const CLIENT_TOKEN = 'two-ip-client-virtual-token';
const MODEL = 'claude-shared-two-ip';

function isPrivateLanIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function findLanIPv4() {
  const available = Object.values(os.networkInterfaces())
    .flatMap(entries => entries || [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal)
    .map(entry => entry.address);
  const configured = String(process.env.MULTICC_TEST_LAN_IP || '').trim();
  if (configured) {
    assert.equal(isPrivateLanIPv4(configured), true,
      'MULTICC_TEST_LAN_IP must be an RFC1918 IPv4 address');
    assert.equal(available.includes(configured), true,
      `MULTICC_TEST_LAN_IP is not assigned to this machine: ${configured}`);
    return configured;
  }
  return available.find(isPrivateLanIPv4) || null;
}

function listen(app, host) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, host);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

function listenHttp(handler, host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
    server.listen(0, host);
  });
}

function closeServer(server) {
  if (!server || !server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  });
}

function serverOrigin(server) {
  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

function loadRelayUiModule() {
  const context = vm.createContext({
    atob,
    document: {
      createElement: () => ({ style: {}, querySelector: () => null }),
      body: { appendChild() {} },
    },
    location: { origin: 'http://127.0.0.1' },
    navigator: {},
  });
  vm.runInContext(fs.readFileSync(RELAY_UI_FILE, 'utf8'), context, {
    filename: 'manage-provider-relay.js',
  });
  return context;
}

function providerFacade(store) {
  return {
    ...store,
    WIRE_DEFAULT_MODEL: MODEL,
    appTypeForCli: cli => cli === 'codex' ? 'codex' : 'claude',
    appTypesForCli: cli => (cli === 'opencode' || cli === 'zcode')
      ? ['claude', 'codex']
      : [cli === 'codex' ? 'codex' : 'claude'],
    providerSupportsCli: (provider, cli) => !!provider
      && (cli === 'opencode' || cli === 'zcode'
        || provider.appType === (cli === 'codex' ? 'codex' : 'claude')),
    getCcSwitchStatus: () => ({ available: false, dbFound: false }),
    getProviderUsageStats: () => ({ stats: [], windows: {} }),
    importFromCcSwitch: () => ({ imported: 0, updated: 0, total: 0 }),
    probeRelayModels: async () => ({ tested: [], accepted: [] }),
  };
}

function providerRouteDeps(providers, proxyToken, defaultsFile) {
  return {
    fs,
    providerDefaultsFile: defaultsFile,
    atomicWriteJson() {},
    providers,
    providerRouterRuntime: {
      getProviderSummary: (appType, id) => providers.getProviderSummary(appType, id),
    },
    findProviderReferences: () => [],
    persistedSessions: new Map(),
    getAuxConfig: () => ({ protocol: 'anthropic', providerId: null }),
    claudeCmd: process.execPath,
    getPort: () => 0,
    getClaudeOfficialViaProxy: () => false,
    getProxyToken: () => proxyToken,
    http,
    https,
    logger: { error() {} },
  };
}

function mountAuth(app, metrics, proxyToken) {
  const authSecurity = {
    createCookie: () => 'unused-cookie',
    verifyCookie: () => false,
    verifyAccessToken: value => value === ACCESS_TOKEN,
    issueWsTicket: () => ({ ticket: 'unused' }),
    issueDownloadTicket: () => ({ ticket: 'unused', target: '/' }),
    verifyDownloadTicket: () => false,
  };
  const runtime = createAuthRuntime({
    express,
    authSecurity,
    isLocalRequest,
    parseCookies: () => ({}),
    normalizeRedirect: () => '/',
    escapeHtmlAttribute: value => String(value),
    metrics: { inc: name => metrics.push(name) },
    logger: { warn() {} },
    createErrorDto: dto => ({ error: dto }),
    getAccessToken: () => ACCESS_TOKEN,
    getShuttingDown: () => false,
    getProxyToken: () => proxyToken,
    isRequestPeerAllowed: isPrivateRequestPeer,
  });
  runtime.mountRoutes(app);
}

function createInstance({ providers, proxyToken, defaultsFile, activity, authorizeProxyRequest }) {
  const app = express();
  const metrics = [];
  app.disable('x-powered-by');
  app.use((req, _res, next) => {
    req.id = 'provider-two-ip';
    req.correlationId = 'provider-two-ip';
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  mountAuth(app, metrics, proxyToken);
  createProviderRoutes(providerRouteDeps(providers, proxyToken, defaultsFile))
    .mountManagementRoutes(app);
  const getProvider = (appType, id) => providers.getProvider(appType, id);
  const admission = createProviderProxyAdmission({
    protocol: 'claude', app, getProvider, authorizeProxyRequest,
    onActivity: event => activity.push(event),
  });
  app.use('/claude-proxy', createProviderProxyGuard({
    protocol: 'claude', authorizeProxyRequest,
  }));
  providerRouter.mountClaudeProxy(admission.app, {
    getProvider: admission.getProvider,
    hopCredentials: { verify: () => ({ ok: false, managed: false, reason: 'unmanaged-route' }) },
    onActivity: admission.onActivity,
  });
  return { app, metrics };
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch (_) { assert.fail(`expected JSON from ${url}, received: ${text.slice(0, 200)}`); }
  return { response, body };
}

function postJson(url, body, headers = {}) {
  return requestJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('shared Provider works from a loopback Assist request through a LAN-bound CPR host', async t => {
  const lanIp = findLanIPv4();
  if (!lanIp) {
    t.skip('requires an active RFC1918 LAN IPv4 address (or MULTICC_TEST_LAN_IP)');
    return;
  }

  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-provider-two-ip-')));
  const sourceStore = providerRouter.createStore({
    dataFile: path.join(root, 'source', 'providers.json'),
    ccSwitchDb: path.join(root, 'missing-source-cc-switch.db'),
  });
  const targetStore = providerRouter.createStore({
    dataFile: path.join(root, 'target', 'providers.json'),
    ccSwitchDb: path.join(root, 'missing-target-cc-switch.db'),
  });
  const sourceProviders = providerFacade(sourceStore);
  const targetProviders = providerFacade(targetStore);
  const upstreamRequests = [];
  const sourceActivity = [];
  const targetActivity = [];
  let upstreamServer;
  let sourceServer;
  let targetServer;

  t.after(async () => {
    await closeServer(targetServer);
    await closeServer(sourceServer);
    await closeServer(upstreamServer);
    assertTestDir(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  upstreamServer = await listenHttp((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      upstreamRequests.push({ url: request.url, headers: request.headers, body });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'msg_shared_two_ip',
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [{ type: 'text', text: 'SHARED_PROVIDER_TWO_IP_OK' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 4 },
      }));
    });
  }, '127.0.0.1');

  sourceStore.saveStore([{
    id: 'source-provider',
    appType: 'claude',
    name: 'LAN Source Claude',
    source: 'local',
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: serverOrigin(upstreamServer),
        ANTHROPIC_AUTH_TOKEN: UPSTREAM_TOKEN,
        ANTHROPIC_MODEL: MODEL,
      },
      modelCatalog: { models: [{ model: MODEL }, { model: `${MODEL}-fallback` }] },
    },
  }]);

  const source = createInstance({
    providers: sourceProviders,
    proxyToken: RELAY_TOKEN,
    defaultsFile: path.join(root, 'source', 'provider-defaults.json'),
    activity: sourceActivity,
    authorizeProxyRequest: () => ({ ok: false, code: 'no-active-attempt' }),
  });
  const target = createInstance({
    providers: targetProviders,
    proxyToken: '',
    defaultsFile: path.join(root, 'target', 'provider-defaults.json'),
    activity: targetActivity,
    authorizeProxyRequest: () => ({ ok: false, code: 'no-active-attempt' }),
  });
  sourceServer = await listen(source.app, lanIp);
  targetServer = await listen(target.app, '127.0.0.1');
  const sourceOrigin = serverOrigin(sourceServer);
  const targetOrigin = serverOrigin(targetServer);

  assert.equal(sourceServer.address().address, lanIp);
  assert.equal(targetServer.address().address, '127.0.0.1');
  assert.notEqual(sourceServer.address().address, targetServer.address().address);

  const shared = await postJson(
    `${sourceOrigin}/api/providers/claude/source-provider/relay-share`,
    { publicBaseUrl: sourceOrigin },
    { 'x-access-token': ACCESS_TOKEN },
  );
  assert.equal(shared.response.status, 200);
  assert.equal(shared.body.ok, true);
  assert.equal(new URL(shared.body.baseUrl).hostname, lanIp,
    'the shared Provider advertises the real LAN address');
  assert.equal(JSON.stringify(shared.body).includes(UPSTREAM_TOKEN), false,
    'the share response never exposes the upstream credential');

  const relayUi = loadRelayUiModule();
  const parsed = relayUi.parseRelayShareCode(shared.body.code);
  assert.equal(parsed.error, undefined);
  const payload = JSON.parse(JSON.stringify(parsed.payload));
  assert.equal(payload.baseUrl, `${sourceOrigin}/claude-proxy/source-provider/remote`);
  assert.equal(payload.authToken, RELAY_TOKEN);
  assert.equal(payload.model, MODEL);
  assert.deepEqual(payload.models, [MODEL, `${MODEL}-fallback`]);
  const providerInput = JSON.parse(JSON.stringify(relayUi.relayProviderInput(parsed.payload)));

  const imported = await postJson(`${targetOrigin}/api/providers`, providerInput);
  assert.equal(imported.response.status, 200);
  assert.equal(imported.body.ok, true);
  const importedSummary = targetStore.getProviderSummary('claude', imported.body.id);
  assert.equal(importedSummary.baseUrl, payload.baseUrl);
  assert.equal(importedSummary.model, MODEL);
  assert.deepEqual(importedSummary.modelOptions, [MODEL, `${MODEL}-fallback`]);

  const prompt = {
    model: MODEL,
    max_tokens: 32,
    messages: [{ role: 'user', content: 'verify shared provider over two IPs' }],
  };
  const wrongToken = await postJson(`${shared.body.baseUrl}/v1/messages`, prompt, {
    'x-api-key': 'wrong-relay-token',
    'anthropic-version': '2023-06-01',
  });
  assert.equal(wrongToken.response.status, 403);
  assert.equal(upstreamRequests.length, 0, 'a bad share token never reaches the upstream');

  const fenced = await postJson(
    `${sourceOrigin}/claude-proxy/source-provider/not-an-attempt/v1/messages`,
    prompt,
    { 'x-access-token': ACCESS_TOKEN, 'anthropic-version': '2023-06-01' },
  );
  assert.equal(fenced.response.status, 409,
    'an unknown session bucket cannot bypass the attempt guard');
  assert.equal(upstreamRequests.length, 0, 'a rejected attempt route never reaches upstream');

  const escalated = await requestJson(`${sourceOrigin}/api/provider-defaults`, {
    headers: { 'x-api-key': RELAY_TOKEN, accept: 'application/json' },
  });
  assert.equal(escalated.response.status, 403,
    'the relay token cannot open non-CPR API routes');

  const relayed = await postJson(
    `${targetOrigin}/claude-proxy/${encodeURIComponent(imported.body.id)}/aux/v1/messages`,
    prompt,
    {
      'x-api-key': CLIENT_TOKEN,
      'anthropic-version': '2023-06-01',
    },
  );
  assert.equal(relayed.response.status, 200);
  assert.equal(relayed.body.content[0].text, 'SHARED_PROVIDER_TWO_IP_OK');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(upstreamRequests.length, 1);
  const upstream = upstreamRequests[0];
  assert.equal(upstream.url, '/v1/messages');
  assert.equal(upstream.headers.authorization, `Bearer ${UPSTREAM_TOKEN}`);
  assert.equal(upstream.headers['x-api-key'], undefined);
  assert.equal(JSON.stringify(upstream.headers).includes(RELAY_TOKEN), false);
  assert.equal(JSON.stringify(upstream.headers).includes(CLIENT_TOKEN), false);
  assert.equal(JSON.parse(upstream.body).model, MODEL);
  assert.ok(source.metrics.includes('multicc_auth_proxy_relay_total'));
  assert.ok(targetActivity.some(event => event.role === 'aux'
    && event.providerId === imported.body.id));
  assert.ok(sourceActivity.some(event => event.role === 'main'
    && event.providerId === 'source-provider'));

  console.log(`provider sharing two-IP integration: target=${targetOrigin} source=${sourceOrigin}`);
});
