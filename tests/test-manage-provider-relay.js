'use strict';

// Client-side guard for public/manage-provider-relay.js: the share-code parser
// must round-trip the server's relay-share payload (src/routes/providers.js)
// and reject anything malformed — the import dialog pastes untrusted text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'public', 'manage-provider-relay.js');

function loadModule() {
  const context = vm.createContext({
    atob,
    document: { createElement: () => ({ style: {}, querySelector: () => null }), body: { appendChild() {} } },
    location: { origin: 'http://127.0.0.1:3000' },
    navigator: {},
  });
  vm.runInContext(fs.readFileSync(SOURCE_PATH, 'utf8'), context, { filename: 'manage-provider-relay.js' });
  return context;
}

function encode(payload) {
  return 'mcrelay1.' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

test('parseRelayShareCode round-trips the server relay-share payload', () => {
  const ctx = loadModule();
  const payload = {
    v: 1,
    kind: 'multicc-relay',
    name: 'GLM · 借道',
    appType: 'claude',
    baseUrl: 'https://relay.example/claude-proxy/glm/remote',
    authToken: 'relay-pxy',
  };
  const { payload: parsed, error } = ctx.parseRelayShareCode(encode(payload));
  assert.equal(error, undefined);
  // JSON-normalize: the parsed object lives in the vm realm, so its prototype
  // is not this realm's Object.prototype and deepStrictEqual would trip.
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), payload);
});

test('relayProviderInput carries the shared model catalog into provider creation', () => {
  const ctx = loadModule();
  const input = ctx.relayProviderInput({
    appType: 'codex',
    name: 'OpenAI Official · 借道',
    baseUrl: 'https://relay.example/codex-proxy/official',
    authToken: 'relay-pxy',
    model: 'gpt-5.6-sol',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-sol', ''],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(input)), {
    appType: 'codex',
    name: 'OpenAI Official · 借道',
    baseUrl: 'https://relay.example/codex-proxy/official',
    authToken: 'relay-pxy',
    model: 'gpt-5.6-sol',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
  });
});

test('v2 share codes preserve the independently-scoped relay credential', () => {
  const ctx = loadModule();
  const payload = {
    v: 2,
    kind: 'multicc-relay',
    relayShareId: 'abcdefghijklmnop',
    name: 'GLM · 借道',
    appType: 'claude',
    baseUrl: 'https://relay.example/claude-proxy/glm/remote',
    authToken: 'mcr1.abcdefghijklmnop.manual-secret',
  };
  const parsed = ctx.parseRelayShareCode(encode(payload));
  assert.equal(parsed.error, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.payload)), payload);
});

test('parseRelayShareCode rejects malformed or untrusted codes', () => {
  const ctx = loadModule();
  const bad = [
    ['', 'empty'],
    ['not-a-code', 'missing prefix'],
    ['mcrelay1.!!!', 'corrupt base64'],
    [encode({ kind: 'other' }), 'wrong kind'],
    [encode({ kind: 'multicc-relay', appType: 'gpt', baseUrl: 'https://x', authToken: 't' }), 'bad appType'],
    [encode({ kind: 'multicc-relay', appType: 'claude', baseUrl: 'javascript:alert(1)', authToken: 't' }), 'non-http baseUrl'],
    [encode({ kind: 'multicc-relay', appType: 'codex', baseUrl: 'https://x', authToken: '' }), 'missing token'],
  ];
  for (const [code, label] of bad) {
    const result = ctx.parseRelayShareCode(code);
    assert.ok(result.error, `must reject: ${label}`);
    assert.equal(result.payload, undefined, `must not leak payload: ${label}`);
  }
});

test('_relayBaseOptions collects, filters and dedupes candidate addresses', async () => {
  const ctx = loadModule();
  ctx.providerApi = {
    json: async (url) => {
      if (url === '/api/server-info') return {
        ip: '192.168.1.10', port: 3000,
        lanUrls: ['http://192.168.1.10:3000', 'http://10.0.0.10:3000'],
      };
      if (url === '/api/settings/tunnel') return {
        config: {
          tailscale: { url: '' },
          phddns: { url: 'https://abc.vicp.fun/manage' },
          natapp: { url: 'ftp://bad-scheme' },
        },
        providers: { tailscale: { publicUrl: 'https://x.tailnet.ts.net/' }, phddns: {} },
      };
      throw new Error(`unexpected url: ${url}`);
    },
  };
  const opts = JSON.parse(JSON.stringify(await ctx._relayBaseOptions()));
  assert.deepEqual(opts.map(o => o.url), [
    'http://127.0.0.1:3000',
    'http://192.168.1.10:3000',
    'http://10.0.0.10:3000',
    'https://x.tailnet.ts.net',
    'https://abc.vicp.fun/manage',
  ]);
});

test('manage.html loads the relay module before the manage facade', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'manage.html'), 'utf8');
  const relay = html.indexOf('<script src="manage-provider-relay.js"></script>');
  const manage = html.indexOf('<script src="manage.js"></script>');
  assert.ok(relay >= 0 && manage > relay, 'relay module must be loaded before manage.js');
  assert.match(html, /id="prov-relay-records-btn"[^>]+manageRelayShares/);
});

test('new relay creation requires a per-link token and exposes inventory/revocation controls', () => {
  const source = fs.readFileSync(SOURCE_PATH, 'utf8');
  assert.match(source, /data-k="token" type="password"/);
  assert.match(source, /json: \{ publicBaseUrl:[^}]+token: tokenInput\.value/);
  assert.match(source, /\/api\/provider-relay-shares\?/);
  assert.match(source, /method: 'DELETE'/);
  assert.doesNotMatch(source, /\/api\/settings\/proxy-token/);
  assert.doesNotMatch(source, /RELAY_TOKEN_UNSET/);
});
