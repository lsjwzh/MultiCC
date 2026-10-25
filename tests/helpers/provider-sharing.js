'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const providerRouter = require('cli-provider-router');
const { assertTestDir } = require('../../src/paths');
const { isLocalRequest, isPrivateRequestPeer } = require('../../src/request-locality');
const { createProviderRouterRuntime } = require('../../src/providers/router-runtime');
const { createAuthRuntime } = require('../../src/routes/auth');
const { createProviderRoutes } = require('../../src/routes/providers');
const { createProviderRelayShareStore } = require('../../src/providers/relay-share-store');

const RELAY_UI_FILE = path.join(__dirname, '..', '..', 'public', 'manage-provider-relay.js');
const ACCESS_TOKEN = 'two-ip-admin-secret';
const RELAY_TOKEN = 'manual-two-ip-relay-secret';
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
    resolveSpawnEnv: () => ({ env: {} }),
    buildChildEnv: () => ({ env: {} }),
    resolveSessionWireModel: model => model,
  };
}

function providerRouteDeps(providers, providerRelayShares, defaultsFile) {
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
    providerRelayShares,
    http,
    https,
    logger: { error() {} },
  };
}

function mountAuth(app, metrics, providerRelayShares) {
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
    authorizeProviderRelayRequest: input => providerRelayShares.authorize(input),
    isRequestPeerAllowed: isPrivateRequestPeer,
  });
  runtime.mountRoutes(app);
}

function createInstance({ providers, providerRelayShares, defaultsFile, activity, backend,
  authorizeProxyRequest = () => ({ ok: false, code: 'no-active-attempt' }) }) {
  const app = express();
  const metrics = [];
  app.disable('x-powered-by');
  app.use((req, _res, next) => {
    req.id = 'provider-two-ip';
    req.correlationId = 'provider-two-ip';
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  mountAuth(app, metrics, providerRelayShares);
  createProviderRoutes(providerRouteDeps(providers, providerRelayShares, defaultsFile))
    .mountManagementRoutes(app);
  const root = path.dirname(defaultsFile);
  const runtime = createProviderRouterRuntime({ providers, mode: 'legacy',
    env: backend ? { MULTICC_CPR_BACKEND: backend } : {},
    dataRoot: root, codexHomesDir: path.join(root, 'codex-homes') });
  const usage = [], rates = [];
  const mounted = runtime.mountProtocolProxies(app, {
    protocols: ['claude', 'codex'], codexProxyTrace: false,
    authorizeProxyRequest,
    onActivity: event => activity.push(event),
    onUsageObserved: event => usage.push(event),
    onRateLimit: event => rates.push(event),
    claudeProxy: { captureEnabled: false },
  });
  return { app, metrics, runtime, usage, rates,
    close: () => Promise.all(Object.values(mounted).map(proxy => proxy?.close?.())) };
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), ...init });
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

module.exports = { findLanIPv4, listen, listenHttp, closeServer, serverOrigin, loadRelayUiModule,
  providerFacade, createInstance, postJson, requestJson, ACCESS_TOKEN, RELAY_TOKEN, UPSTREAM_TOKEN, CLIENT_TOKEN, MODEL };
