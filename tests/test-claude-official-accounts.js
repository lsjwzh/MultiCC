'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createOfficialAccountStore } = require('../src/official-accounts');
const oauth = require('../src/claude-official-oauth');
const { createClaudeAccountCredentialService } = require('../src/claude-account-credentials');
const { mountClaudeAccountRoutes } = require('../src/routes/claude-accounts');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-claude-acct-test-'));
}

// Scripted fetch: map of url → response spec, records calls.
function mockFetch(handlers) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, spec] of Object.entries(handlers)) {
      if (String(url).includes(match)) {
        // real Headers are case-insensitive — emulate that
        const lowered = {};
        for (const [k, v] of Object.entries(spec.headers || {})) lowered[k.toLowerCase()] = v;
        return {
          ok: spec.status >= 200 && spec.status < 300,
          status: spec.status,
          headers: new Map(Object.entries(lowered)),
          json: async () => spec.body,
          text: async () => (typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body)),
        };
      }
    }
    throw new Error(`unstubbed fetch: ${url}`);
  };
  return { fetch, calls };
}

const TOKEN_OK = {
  access_token: 'oat-new', refresh_token: 'ort-new', expires_in: 3600,
  account: { uuid: 'acct-uuid', email_address: 'me@example.com' },
  organization: { uuid: 'org-uuid', name: 'My Org' },
};

// ── protocol module ──────────────────────────────────────────────────────────

test('PKCE + authorize URL carry the native client shape', () => {
  const { codeVerifier, codeChallenge } = oauth.generatePkce();
  assert.match(codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(codeChallenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(codeVerifier, codeChallenge);

  const url = new URL(oauth.buildAuthorizeUrl({ state: 'st', codeChallenge }));
  assert.equal(url.origin + url.pathname, 'https://claude.ai/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), oauth.CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:54545/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge'), codeChallenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.match(url.searchParams.get('scope'), /user:inference/);
});

test('exchangeCode splits code#state and posts the native field order', async () => {
  const { fetch, calls } = mockFetch({ 'platform.claude.com/v1/oauth/token': { status: 200, body: TOKEN_OK } });
  const data = await oauth.exchangeCode(fetch, { code: 'the-code#fragment-state', state: 'query-state', codeVerifier: 'ver' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers['User-Agent'], 'axios/1.15.2');
  // Fragment state wins over the query state (CPA parseCodeAndState).
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    grant_type: 'authorization_code',
    code: 'the-code',
    redirect_uri: 'http://localhost:54545/callback',
    client_id: oauth.CLIENT_ID,
    code_verifier: 'ver',
    state: 'fragment-state',
  });
  assert.equal(data.access_token, 'oat-new');
  assert.equal(data.refresh_token, 'ort-new');
  assert.equal(data.email, 'me@example.com');
  assert.equal(data.organization_name, 'My Org');
  assert.ok(Date.parse(data.expired) > Date.now());
});

test('refreshTokens keeps the old refresh_token when the response omits it', async () => {
  const { fetch, calls } = mockFetch({
    'platform.claude.com': { status: 200, body: { access_token: 'oat-2', expires_in: 600 } },
  });
  const data = await oauth.refreshTokens(fetch, { refreshToken: 'ort-old' });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    client_id: oauth.CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: 'ort-old',
    scope: oauth.SCOPE,
  });
  assert.equal(data.access_token, 'oat-2');
  assert.equal(data.refresh_token, 'ort-old', 'fallback retains the old refresh token');
});

test('429 surfaces Retry-After (seconds / http-date / retry-after-ms), clamped', async () => {
  const retry = (headers) => mockFetch({ 'platform.claude.com': { status: 429, headers, body: 'slow down' } });
  let err = await oauth.refreshTokens(retry({ 'Retry-After': '30' }).fetch, { refreshToken: 'r' }).catch(e => e);
  assert.equal(err.status, 429);
  assert.equal(err.retryAfterMs, 30000);
  assert.equal(err.retryable, false, '429 is not retryable immediately');

  err = await oauth.refreshTokens(retry({ 'Retry-After': '1' }).fetch, { refreshToken: 'r' }).catch(e => e);
  assert.equal(err.retryAfterMs, 5000, 'clamped to the 5s floor');

  err = await oauth.refreshTokens(retry({ 'Retry-After-Ms': '120000' }).fetch, { refreshToken: 'r' }).catch(e => e);
  assert.equal(err.retryAfterMs, 120000);

  err = await oauth.refreshTokens(retry({}).fetch, { refreshToken: 'r' }).catch(e => e);
  assert.equal(err.retryAfterMs, 5000, 'missing header → floor');
});

test('waitForCallback resolves code+state and answers a browser page', async () => {
  const listener = oauth.waitForCallback({ port: 0, timeoutMs: 5000 });
  // find the actual port once listening
  await new Promise(resolve => setImmediate(resolve));
  const port = listener.address().port;
  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/callback?code=abc%23def&state=st`, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
  assert.equal(body.status, 200);
  assert.match(body.text, /登录完成/);
  const result = await listener.promise;
  assert.deepEqual(result, { code: 'abc#def', state: 'st' });
});

// ── credential service ───────────────────────────────────────────────────────

function storeWithClaudeAccount(cred) {
  const store = createOfficialAccountStore({ root: tmpRoot() });
  const account = store.createClaudeAccount({ label: '工作号' });
  if (cred) store.writeClaudeCredential(account.id, cred);
  return { store, account };
}

test('credential service returns a live stored token without any network', async () => {
  const { store, account } = storeWithClaudeAccount({
    access_token: 'oat-live',
    refresh_token: 'ort',
    expired: new Date(Date.now() + 3600e3).toISOString(),
  });
  const { fetch, calls } = mockFetch({});
  const svc = createClaudeAccountCredentialService({ accounts: store, fetch });
  const r = await svc.readAccountToken(account.id);
  assert.equal(r.token, 'oat-live');
  assert.equal(calls.length, 0);
});

test('expired token → singleflight refresh, concurrent readers share one POST', async () => {
  const { store, account } = storeWithClaudeAccount({
    access_token: 'oat-dead',
    refresh_token: 'ort-live',
    expired: new Date(Date.now() - 1000).toISOString(),
  });
  const { fetch, calls } = mockFetch({
    '/v1/oauth/token': { status: 200, body: { access_token: 'oat-fresh', expires_in: 3600 } },
    '/api/oauth/profile': { status: 200, body: { account: { uuid: 'u', email: 'w@example.com' }, organization: { uuid: 'o', name: 'Org' } } },
  });
  const svc = createClaudeAccountCredentialService({ accounts: store, fetch });
  const [r1, r2] = await Promise.all([svc.readAccountToken(account.id), svc.readAccountToken(account.id)]);
  assert.equal(r1.token, 'oat-fresh');
  assert.equal(r2.token, 'oat-fresh');
  assert.equal(calls.filter(c => c.url.includes('/v1/oauth/token')).length, 1, 'singleflight: exactly one refresh POST');
  // persisted back to the account file, label preserved
  const stored = store.readClaudeCredential(account.id);
  assert.equal(stored.access_token, 'oat-fresh');
  assert.equal(stored.refresh_token, 'ort-live', 'refresh_token fallback persisted');
  assert.equal(stored.email, 'w@example.com', 'profile filled identity');
  assert.equal(stored.label, '工作号');
  assert.equal(svc.status(account.id).refreshCount, 1);
});

test('refresh 429 blocks further attempts until Retry-After elapses', async () => {
  let clock = 1_000_000;
  const { store, account } = storeWithClaudeAccount({
    access_token: 'oat-dead', refresh_token: 'ort',
    expired: new Date(clock - 1000).toISOString(), // expired relative to the fake clock
  });
  const { fetch, calls } = mockFetch({ '/v1/oauth/token': { status: 429, headers: { 'Retry-After': '60' }, body: 'slow' } });
  const svc = createClaudeAccountCredentialService({ accounts: store, fetch, now: () => clock });
  const r1 = await svc.readAccountToken(account.id);
  assert.equal(r1.token, null);
  assert.match(r1.reason, /refresh_failed/);
  assert.equal(calls.length, 1);

  const r2 = await svc.readAccountToken(account.id);
  assert.match(r2.reason, /temporarily blocked/);
  assert.equal(calls.length, 1, 'blocked — no second POST');

  clock += 61_000; // past the block
  const r3 = await svc.readAccountToken(account.id);
  assert.equal(calls.length, 2, 'block elapsed → refresh retried');
  assert.equal(r3.token, null);
});

test('missing refresh token / unreadable file fail closed', async () => {
  const { store, account } = storeWithClaudeAccount({
    access_token: 'oat-dead', expired: new Date(Date.now() - 1000).toISOString(),
  });
  const svc = createClaudeAccountCredentialService({ accounts: store, fetch: mockFetch({}).fetch });
  assert.match((await svc.readAccountToken(account.id)).reason, /refresh_token_missing/);

  assert.equal((await svc.readAccountToken('f'.repeat(16))).reason, 'credential_unreadable');
});

test('readOfficialCredential: account context → refresh-on-read, string → shared Keychain reader', async () => {
  const { store, account } = storeWithClaudeAccount({
    access_token: 'oat-live',
    expired: new Date(Date.now() + 3600e3).toISOString(),
  });
  const sharedCalls = [];
  const svc = createClaudeAccountCredentialService({
    accounts: store,
    fetch: mockFetch({}).fetch,
    sharedLoginReader: (arg) => { sharedCalls.push(arg); return { token: 'oat-keychain' }; },
  });
  const accountResult = await svc.readOfficialCredential({ accountId: account.id, providerId: 'p', provider: null });
  assert.equal(accountResult.token, 'oat-live');
  assert.equal(sharedCalls.length, 0);

  const sharedResult = await svc.readOfficialCredential('Claude Code-credentials');
  assert.equal(sharedResult.token, 'oat-keychain');
  assert.deepEqual(sharedCalls, ['Claude Code-credentials']);
});

// ── routes ───────────────────────────────────────────────────────────────────

function providersStub() {
  const byId = new Map();
  let seq = 0;
  return {
    listProviders: appType => [...byId.values()].filter(p => p.appType === appType).map(p => ({ id: p.id })),
    getProvider: (appType, id) => byId.get(id) || null,
    createProvider: (record) => {
      const id = `prov-${++seq}`;
      byId.set(id, { id, ...record });
      return { id };
    },
    deleteProvider: (appType, id) => { byId.delete(id); },
    _byId: byId,
  };
}

function routeHarness(deps) {
  const routes = {};
  const app = {
    get: (p, h) => { routes[`GET ${p}`] = h; },
    post: (p, h) => { routes[`POST ${p}`] = h; },
    delete: (p, h) => { routes[`DELETE ${p}`] = h; },
  };
  mountClaudeAccountRoutes(app, deps);
  return {
    invoke: (method, path, body) => new Promise((resolve, reject) => {
      const key = `${method} ${path}`;
      // match concrete paths against registered :param patterns
      const entry = Object.entries(routes).find(([registered]) => {
        const [rMethod, rPath] = registered.split(' ');
        if (rMethod !== method) return false;
        const pattern = '^' + rPath.replace(/:[^/]+/g, '[^/]+') + '$';
        return new RegExp(pattern).test(path);
      });
      if (!entry) return reject(new Error(`no route ${key}`));
      const handler = entry[1];
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { resolve({ statusCode: this.statusCode, body: payload }); return this; },
      };
      // path param extraction for the :id routes
      const id = (path.match(/accounts\/([a-f0-9]{16})/) || [])[1] || '';
      try {
        const out = handler({ body: body || {}, params: { id }, query: {} }, res);
        if (out && typeof out.catch === 'function') out.catch(reject);
      } catch (error) { reject(error); }
    }),
  };
}

// A deferred loopback listener the test drives manually.
function listenerStub() {
  const instances = [];
  const factory = () => {
    let resolvePromise; let rejectPromise;
    const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    const inst = { promise, cancel: () => {}, address: () => null, resolve: resolvePromise, reject: rejectPromise };
    instances.push(inst);
    return inst;
  };
  return { factory, instances };
}

test('claude account lifecycle: create → login callback → credential stored → delete', async () => {
  const store = createOfficialAccountStore({ root: tmpRoot() });
  const providers = providersStub();
  const listener = listenerStub();
  const credentials = createClaudeAccountCredentialService({ accounts: store, fetch: mockFetch({}).fetch });
  const { fetch } = mockFetch({ 'platform.claude.com': { status: 200, body: TOKEN_OK } });
  const h = routeHarness({
    accounts: store, providers, credentials, fetch,
    waitForCallback: listener.factory,
  });

  const created = await h.invoke('POST', '/api/claude/accounts', { label: '个人号' });
  assert.equal(created.statusCode, 201);
  assert.ok(created.body.oauthUrl.includes('claude.ai/oauth/authorize'));
  const accountId = created.body.accountId;
  assert.ok(created.body.providerId);

  // provider carries the marker, no baseUrl
  const provider = providers.getProvider('claude', created.body.providerId);
  assert.equal(provider.settingsConfig.officialAccount.id, accountId);
  assert.deepEqual(provider.settingsConfig.env, {});

  // login pending
  let status = await h.invoke('GET', `/api/claude/accounts/${accountId}/login-status`);
  assert.equal(status.body.state, 'pending');

  // browser comes back
  assert.equal(listener.instances.length, 1);
  const stateParam = new URL(created.body.oauthUrl).searchParams.get('state');
  listener.instances[0].resolve({ code: 'the-code', state: stateParam });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  status = await h.invoke('GET', `/api/claude/accounts/${accountId}/login-status`);
  assert.equal(status.body.state, 'complete');
  assert.equal(status.body.email, 'me@example.com');

  const listed = await h.invoke('GET', '/api/claude/accounts');
  assert.equal(listed.body.accounts.length, 1);
  assert.equal(listed.body.accounts[0].loggedIn, true);
  assert.equal(listed.body.accounts[0].email, 'me@example.com');
  assert.equal(listed.body.accounts[0].providerId, created.body.providerId);

  const deleted = await h.invoke('DELETE', `/api/claude/accounts/${accountId}`);
  assert.equal(deleted.body.deletedProviderId, created.body.providerId);
  assert.equal(store.listClaudeAccounts().length, 0);
  assert.equal(providers.listProviders('claude').length, 0);
});

test('login state mismatch discards the callback', async () => {
  const store = createOfficialAccountStore({ root: tmpRoot() });
  const listener = listenerStub();
  const credentials = createClaudeAccountCredentialService({ accounts: store, fetch: mockFetch({}).fetch });
  const h = routeHarness({
    accounts: store, providers: providersStub(), credentials,
    fetch: mockFetch({ 'platform.claude.com': { status: 200, body: TOKEN_OK } }).fetch,
    waitForCallback: listener.factory,
  });
  const created = await h.invoke('POST', '/api/claude/accounts', {});
  listener.instances[0].resolve({ code: 'x', state: 'wrong-state' });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const status = await h.invoke('GET', `/api/claude/accounts/${created.body.accountId}/login-status`);
  assert.equal(status.body.state, 'error');
  assert.match(status.body.error, /state mismatch/);
  assert.equal(store.readClaudeCredential(created.body.accountId).access_token, undefined);
});

test('per-account quota route reads usage with the account token', async () => {
  const store = createOfficialAccountStore({ root: tmpRoot() });
  const account = store.createClaudeAccount({ label: 'q' });
  store.writeClaudeCredential(account.id, {
    access_token: 'oat-quota',
    expired: new Date(Date.now() + 3600e3).toISOString(),
  });
  const usageBody = { five_hour: { utilization: 0.31, resets_at: '2026-09-02T10:00:00Z' } };
  const { fetch, calls } = mockFetch({ '/api/oauth/usage': { status: 200, body: usageBody } });
  const credentials = createClaudeAccountCredentialService({ accounts: store, fetch });
  const h = routeHarness({ accounts: store, providers: providersStub(), credentials, fetch, waitForCallback: listenerStub().factory });

  const res = await h.invoke('GET', `/api/claude/accounts/${account.id}/quota`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.usage.five_hour.utilization, 0.31);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer oat-quota');
  assert.equal(calls[0].init.headers['anthropic-beta'], 'oauth-2025-04-20');

  // unknown + never-logged-in accounts fail closed
  const missing = await h.invoke('GET', `/api/claude/accounts/${'e'.repeat(16)}/quota`);
  assert.equal(missing.statusCode, 404);
  const empty = store.createClaudeAccount({ label: '' });
  const noAuth = await h.invoke('GET', `/api/claude/accounts/${empty.id}/quota`);
  assert.equal(noAuth.statusCode, 401);
  assert.equal(noAuth.body.status, 'no_auth');
});

test('per-account quota maps a 401 from the usage endpoint to no_auth (relogin hint)', async () => {
  // The token was revoked / expired beyond refresh: fetchUsage throws a
  // ClaudeOAuthError with status 401. The route must NOT fold that into the
  // generic 502 'unavailable' branch — the UI needs 'no_auth' to point the user
  // at relogin.
  const store = createOfficialAccountStore({ root: tmpRoot() });
  const account = store.createClaudeAccount({ label: 'dead' });
  store.writeClaudeCredential(account.id, {
    access_token: 'oat-revoked',
    expired: new Date(Date.now() + 3600e3).toISOString(),
  });
  const { fetch } = mockFetch({ '/api/oauth/usage': { status: 401, body: { error: 'invalid_token' } } });
  const credentials = createClaudeAccountCredentialService({ accounts: store, fetch });
  const h = routeHarness({ accounts: store, providers: providersStub(), credentials, fetch, waitForCallback: listenerStub().factory });

  const res = await h.invoke('GET', `/api/claude/accounts/${account.id}/quota`);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.status, 'no_auth');
  assert.match(res.body.error, /重新登录/);
});
