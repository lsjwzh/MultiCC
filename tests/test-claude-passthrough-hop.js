'use strict';

// End-to-end evidence for the "OAuth passthrough provider" shape: a base-less
// claude entry that carries its own token. It used to skip the hop entirely (the
// CLI dialed api.anthropic.com with the record's token), and an early version of
// this fix 502'd it at the hop instead ("provider '…' has no baseUrl", because
// cli-provider-router's official branch only serves the canonical official id or
// an account-marked record). This test drives the REAL hop — CPR's claude handler
// mounted the way src/providers/router-port mounts it — and asserts the request
// leaves for api.anthropic.com with the record's own credential, through the
// local route.
//
// Nothing here touches the network or the Keychain: the credential reader is
// stubbed, and https.request is redirected to a local capture server.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-claude-passthrough-hop-'));
const original = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  MULTICC_DATA_DIR: process.env.MULTICC_DATA_DIR,
  CLAUDE_OFFICIAL_VIA_PROXY: process.env.CLAUDE_OFFICIAL_VIA_PROXY,
};
process.env.HOME = path.join(root, 'home');
process.env.USERPROFILE = process.env.HOME;
process.env.MULTICC_DATA_DIR = path.join(root, 'data');
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.MULTICC_DATA_DIR, { recursive: true });
// The hop's official branch is gated on this host toggle; the passthrough route
// below must not depend on it, so it is set here to the value a live install has.
process.env.CLAUDE_OFFICIAL_VIA_PROXY = '1';

const providers = require('../src/providers/core');
const { createProviderStoreAdapter } = require('../src/providers/router-adapter');
const { createHandler } = require('cli-provider-router/proxy/claude');

test.after(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

// A stand-in for api.anthropic.com. It records what the hop sent it, so the
// assertion is about the request that actually left the proxy.
async function startUpstream() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: message_stop\ndata: {}\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    port: server.address().port,
    close: () => new Promise(resolve => {
      server.close(resolve);
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    }),
  };
}

// Mount the hop the way the host does, and answer one request through it.
async function requestThroughHop({ providerId, sessionId = 'probe', getProvider }) {
  const upstream = await startUpstream();
  const realRequest = https.request;
  const dialed = [];
  https.request = (options, callback) => {
    dialed.push(options);
    return http.request({
      method: options.method,
      hostname: '127.0.0.1',
      port: upstream.port,
      path: options.path,
      headers: options.headers,
    }, callback);
  };
  const handler = createHandler({
    getProvider,
    // No Keychain: the official branch is only ever *reached*, never satisfied.
    readOfficialCredential: () => ({ token: null, reason: 'stub-no-keychain' }),
    keychainService: 'multicc-test-service',
    hopCredentials: { authorize: () => ({ ok: true }), verify: () => ({ ok: true }) },
  });
  const server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const body = JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
  const response = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port,
      path: `/claude-proxy/${encodeURIComponent(providerId)}/${encodeURIComponent(sessionId)}/v1/messages`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  }).finally(async () => {
    https.request = realRequest;
    await new Promise(resolve => {
      server.close(resolve);
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
    await upstream.close();
  });
  return { ...response, dialed, upstreamRequests: upstream.requests };
}

test('a base-less entry with its own token is served by the hop, on that token', async () => {
  const provider = providers.createProvider({
    appType: 'claude', name: 'Passthrough fixture', authToken: 'passthrough-fixture-token',
  });
  const store = createProviderStoreAdapter(providers);
  const result = await requestThroughHop({ providerId: provider.id, getProvider: store.getProvider });
  assert.equal(result.status, 200, result.body);
  assert.equal(result.dialed.length, 1, 'exactly one upstream dial');
  // The upstream the record implies by naming no base URL: Anthropic's own.
  assert.equal(result.dialed[0].hostname, 'api.anthropic.com');
  assert.equal(result.dialed[0].port, 443);
  assert.match(result.dialed[0].path, /^\/v1\/messages/);
  const forwarded = result.upstreamRequests[0];
  assert.equal(forwarded.headers.authorization, 'Bearer passthrough-fixture-token',
    'the record’s own credential — never the host subscription login');
  assert.equal(forwarded.headers['x-api-key'], undefined);
  assert.match(forwarded.body, /"model":"claude-sonnet-4-5"/);
});

test('without the routing view the same entry would be refused at the hop', async () => {
  // Negative control: the store adapter is what supplies the implied upstream, so
  // the raw getProvider must still produce the 502 this test file exists to rule
  // out — otherwise the assertion above would pass for the wrong reason.
  const provider = providers.createProvider({
    appType: 'claude', name: 'Passthrough fixture', authToken: 'passthrough-fixture-token',
  });
  const result = await requestThroughHop({
    providerId: provider.id,
    getProvider: (appType, id) => providers.getProvider(appType, id),
  });
  assert.equal(result.status, 502);
  assert.match(result.body, /has no baseUrl/);
  assert.equal(result.dialed.length, 0, 'nothing was dialed');
});

test('a base-less entry with no credential still belongs to the official branch', async () => {
  // The boundary that is left: the official branch is keyed on the provider id in
  // the route, so only the canonical entry (or one marked with an official
  // account) is served from a login. Session bindings normalize these records to
  // the canonical id (providers.normalizeOfficialProviderId), which is why this
  // remaining shape is only reachable with a stale reference.
  const provider = providers.createProvider({
    appType: 'claude', name: 'Login-only fixture', settingsConfig: '{"env":{}}',
  });
  const store = createProviderStoreAdapter(providers);
  const result = await requestThroughHop({ providerId: provider.id, getProvider: store.getProvider });
  assert.equal(result.status, 502);
  assert.match(result.body, /has no baseUrl/);
});
