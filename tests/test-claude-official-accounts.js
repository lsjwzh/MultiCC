'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createOfficialAccountStore } = require('../src/official-accounts');
const oauth = require('../src/claude-auth/official-oauth');
const { createClaudeAccountCredentialService } = require('../src/claude-auth/account-credentials');
const { createClaudeAccountRefreshSupervisor } = require('../src/claude-auth/accounts-refresh');
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

test('the module no longer speaks the refresh grant — rotation belongs to the CLI', () => {
  assert.equal(oauth.refreshTokens, undefined,
    'a second holder of the single-use refresh token is what caused the invalid_grant storm');
  assert.equal(typeof oauth.exchangeCode, 'function', 'creating an account still works');
  assert.equal(typeof oauth.fetchUsage, 'function', 'reading usage still works');
});

test('429 surfaces Retry-After (seconds / http-date / retry-after-ms), clamped', async () => {
  const retry = (headers) => mockFetch({ 'platform.claude.com': { status: 429, headers, body: 'slow down' } });
  const login = (headers) => oauth.exchangeCode(retry(headers).fetch, { code: 'c', state: 's', codeVerifier: 'v' }).catch(e => e);
  let err = await login({ 'Retry-After': '30' });
  assert.equal(err.status, 429);
  assert.equal(err.retryAfterMs, 30000);
  assert.equal(err.retryable, false, '429 is not retryable immediately');

  err = await login({ 'Retry-After': '1' });
  assert.equal(err.retryAfterMs, 5000, 'clamped to the 5s floor');

  err = await login({ 'Retry-After-Ms': '120000' });
  assert.equal(err.retryAfterMs, 120000);

  err = await login({});
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

test('waitForCallback finishes from a pasted loopback callback (remote browser)', async () => {
  const listener = oauth.waitForCallback({ port: 0, timeoutMs: 5000 });
  await new Promise(resolve => setImmediate(resolve));
  const port = listener.address().port;

  assert.throws(() => listener.submit(`http://evil.example:${port}/callback?code=x&state=st`, { expectedState: 'st' }),
    /loopback/);
  assert.throws(() => listener.submit(`http://localhost:${port}/callback?state=st`, { expectedState: 'st' }),
    /no code/);
  assert.throws(() => listener.submit(`http://localhost:${port + 1}/callback?code=x&state=st`, { expectedState: 'st' }),
    /port mismatch/);
  assert.throws(() => listener.submit(`http://localhost:${port}/callback?code=x&state=wrong`, { expectedState: 'st' }),
    /state mismatch/);

  listener.submit(`http://localhost:${port}/callback?code=pasted-code&state=st`, { expectedState: 'st' });
  assert.deepEqual(await listener.promise, { code: 'pasted-code', state: 'st' });
  assert.throws(() => listener.submit('another#st', { expectedState: 'st' }), /over/);
});

test('waitForCallback accepts the code#state form shown on the page', async () => {
  const listener = oauth.waitForCallback({ port: 0, timeoutMs: 5000 });
  listener.submit('page-code#page-state', { expectedState: 'page-state' });
  assert.deepEqual(await listener.promise, { code: 'page-code', state: 'page-state' });
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

test('a lapsed token is delegated to the CLI owner, and the reader sends no request of its own', async () => {
  const { store, account } = storeWithClaudeAccount({
    access_token: 'oat-dead',
    refresh_token: 'ort-live',
    expired: new Date(Date.now() + 3 * 60_000).toISOString(),
  });
  const { fetch, calls } = mockFetch({});
  const asked = [];
  const svc = createClaudeAccountCredentialService({
    accounts: store,
    fetch,
    onNeedsRefresh: async (id) => {
      asked.push(id);
      store.writeClaudeCredential(id, {
        access_token: 'oat-fresh',
        refresh_token: 'ort-new',
        expired: new Date(Date.now() + 8 * 3600e3).toISOString(),
      });
      return { outcome: 'refreshed' };
    },
  });
  const [r1, r2] = await Promise.all([svc.readAccountToken(account.id), svc.readAccountToken(account.id)]);
  assert.equal(r1.token, 'oat-fresh');
  assert.equal(r2.token, 'oat-fresh');
  assert.equal(calls.length, 0, 'the reader never POSTs the token endpoint');
  assert.deepEqual(asked, [account.id], 'concurrent reads share one delegation');
  assert.equal(store.readClaudeCredential(account.id).label, '工作号', 'the account record survives');
});

test('a delegation that fails says why, and is never retried behind the caller\'s back', async () => {
  const { store, account } = storeWithClaudeAccount({
    access_token: 'oat-dead', refresh_token: 'ort',
    expired: new Date(Date.now() - 1000).toISOString(),
  });
  const { fetch, calls } = mockFetch({});
  let asked = 0;
  const svc = createClaudeAccountCredentialService({
    accounts: store,
    fetch,
    onNeedsRefresh: async () => { asked += 1; return { outcome: 'parked', detail: 'rejected' }; },
  });
  const r1 = await svc.readAccountToken(account.id);
  assert.equal(r1.token, null);
  assert.equal(r1.reason, 'cli_refresh_parked', 'the failure class reaches the 502 text');
  assert.equal(asked, 1);
  assert.equal(calls.length, 0);
});

test('a declined rotation still serves a token that has not actually expired', async () => {
  // Inside the 5 minute safety margin, so the read asks; the CLI declines
  // (token not yet in its window) — the remaining minutes are still usable and
  // failing the turn with a live credential in hand would be the worse answer.
  const { store, account } = storeWithClaudeAccount({
    access_token: 'oat-still-live', refresh_token: 'ort',
    expired: new Date(Date.now() + 3 * 60_000).toISOString(),
  });
  const svc = createClaudeAccountCredentialService({
    accounts: store,
    onNeedsRefresh: async () => ({ outcome: 'deferred' }),
  });
  const r = await svc.readAccountToken(account.id);
  assert.equal(r.token, 'oat-still-live');
});

test('a delegation that never answers fails the read instead of hanging the turn', async () => {
  const { store, account } = storeWithClaudeAccount({
    access_token: 'oat-dead', refresh_token: 'ort',
    expired: new Date(Date.now() - 1000).toISOString(),
  });
  const svc = createClaudeAccountCredentialService({
    accounts: store,
    refreshWaitMs: 20,
    onNeedsRefresh: () => new Promise(() => {}),
  });
  const r = await svc.readAccountToken(account.id);
  assert.equal(r.token, null);
  assert.equal(r.reason, 'cli_refresh_unavailable');
});

test('peekAccountToken reports an expired credential and asks no one', () => {
  const { store, account } = storeWithClaudeAccount({
    access_token: 'oat-dead', refresh_token: 'ort',
    expired: new Date(Date.now() - 1000).toISOString(),
  });
  let asked = 0;
  const svc = createClaudeAccountCredentialService({
    accounts: store,
    fetch: mockFetch({}).fetch,
    onNeedsRefresh: async () => { asked += 1; return { outcome: 'refreshed' }; },
  });
  const read = svc.peekAccountToken(account.id);
  assert.equal(read.token, null);
  assert.equal(read.reason, 'access_token_expired');
  assert.equal(asked, 0, 'showing a usage number must not spend the refresh token');
});

test('missing credential / unreadable file fail closed', async () => {
  const { store, account } = storeWithClaudeAccount({
    access_token: 'oat-dead', expired: new Date(Date.now() - 1000).toISOString(),
  });
  const svc = createClaudeAccountCredentialService({ accounts: store, fetch: mockFetch({}).fetch });
  assert.equal((await svc.readAccountToken(account.id)).reason, 'access_token_expired');

  assert.equal((await svc.readAccountToken('f'.repeat(16))).reason, 'credential_unreadable');
});

test('readOfficialCredential: account context → delegating read, string → shared Keychain reader', async () => {
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

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('仍有效的令牌读取和认证恢复都等待同账号续期，其他账号不受阻塞', async t => {
  const { store, account } = storeWithClaudeAccount({
    access_token: 'old-a', refresh_token: 'refresh-a', expired: new Date(Date.now() + 3600e3).toISOString(),
  });
  t.after(() => fs.rmSync(store.root, { recursive: true, force: true }));
  const other = store.createClaudeAccount({ label: '另一账号' });
  store.writeClaudeCredential(other.id, { access_token: 'live-b', expired: new Date(Date.now() + 3600e3).toISOString() });
  const supervisor = createClaudeAccountRefreshSupervisor({ accounts: store });
  const { fetch, calls } = mockFetch({});
  const service = createClaudeAccountCredentialService({ accounts: store, fetch, exclusive: supervisor.exclusive });
  const started = deferred(), release = deferred();
  t.after(() => release.resolve());
  const rotation = supervisor.exclusive(account.id, async () => {
    started.resolve();
    await release.promise;
    store.writeClaudeCredential(account.id, { access_token: 'new-a', refresh_token: 'refresh-new', expired: new Date(Date.now() + 3600e3).toISOString() });
  });
  await started.promise;
  let finished = 0;
  const reads = Array.from({ length: 8 }, () => service.readAccountToken(account.id).then(r => { finished++; return r; }));
  const recoveries = Array.from({ length: 8 }, () => service.recoverAccountToken(account.id, 'old-a').then(r => { finished++; return r; }));
  assert.equal((await service.readAccountToken(other.id)).token, 'live-b');
  assert.equal(finished, 0, '同账号尚未保存新凭据时不得读旧令牌');
  release.resolve();
  await rotation;
  const results = await Promise.all([...reads, ...recoveries]);
  assert.ok(results.every(r => r.token === 'new-a'));
  assert.equal(calls.length, 0, '等待后台续期，不额外发起续期');
});

test('已续期直接采用新凭据；无变化、已过期或已删除都不盲目重试或强制续期', async t => {
  const { store, account } = storeWithClaudeAccount({
    access_token: 'new-a', refresh_token: 'refresh-a', expired: new Date(Date.now() + 3600e3).toISOString(),
  });
  t.after(() => fs.rmSync(store.root, { recursive: true, force: true }));
  const { fetch, calls } = mockFetch({});
  const service = createClaudeAccountCredentialService({ accounts: store, fetch });
  assert.equal((await service.recoverOfficialCredential({ accountId: account.id }, 'old-a')).token, 'new-a');
  assert.equal((await service.recoverAccountToken(account.id, 'new-a')).token, null);
  assert.equal((await service.recoverAccountToken(account.id, '')).token, null);
  store.writeClaudeCredential(account.id, { expired: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await service.recoverAccountToken(account.id, 'old-a')).token, null);
  store.deleteClaudeAccount(account.id);
  assert.equal((await service.recoverAccountToken(account.id, 'old-a')).token, null);
  assert.equal((await service.recoverOfficialCredential('Claude Code-credentials', 'shared')).reason, 'unmanaged_login');
  assert.equal(calls.length, 0);
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
    const inst = {
      promise,
      cancel: () => {},
      address: () => null,
      resolve: resolvePromise,
      reject: rejectPromise,
      submit(raw, { expectedState } = {}) {
        let code = ''; let state = '';
        try {
          const url = new URL(raw);
          code = url.searchParams.get('code') || '';
          state = url.searchParams.get('state') || '';
        } catch (_) {
          const [c, s] = String(raw).split('#');
          code = c || ''; state = s || '';
        }
        if (!code) throw new Error('no code');
        if (expectedState && state !== expectedState) throw new Error('state mismatch');
        resolvePromise({ code, state });
      },
    };
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

test('pasted callback finishes a remote login; a wrong state is rejected', async () => {
  const store = createOfficialAccountStore({ root: tmpRoot() });
  const listener = listenerStub();
  const credentials = createClaudeAccountCredentialService({ accounts: store, fetch: mockFetch({}).fetch });
  const { fetch } = mockFetch({ 'platform.claude.com': { status: 200, body: TOKEN_OK } });
  const h = routeHarness({ accounts: store, providers: providersStub(), credentials, fetch, waitForCallback: listener.factory });

  const created = await h.invoke('POST', '/api/claude/accounts', { label: '远程号' });
  const accountId = created.body.accountId;
  const state = new URL(created.body.oauthUrl).searchParams.get('state');

  // The page offers the authorize URL even after a reload of the account list.
  const pending = await h.invoke('GET', `/api/claude/accounts/${accountId}/login-status`);
  assert.equal(pending.body.oauthUrl, created.body.oauthUrl);

  const bad = await h.invoke('POST', `/api/claude/accounts/${accountId}/login-callback`, {
    callback: `http://localhost:54545/callback?code=stolen&state=wrong`,
  });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body.error, /state mismatch/);
  assert.equal((await h.invoke('GET', `/api/claude/accounts/${accountId}/login-status`)).body.state, 'pending');

  const ok = await h.invoke('POST', `/api/claude/accounts/${accountId}/login-callback`, {
    callback: `http://localhost:54545/callback?code=pasted-code&state=${state}`,
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.accepted, true);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  const done = await h.invoke('GET', `/api/claude/accounts/${accountId}/login-status`);
  assert.equal(done.body.state, 'complete');
  assert.equal(store.readClaudeCredential(accountId).access_token, 'oat-new');

  const idle = store.createClaudeAccount({ label: '未发起登录' });
  const none = await h.invoke('POST', `/api/claude/accounts/${idle.id}/login-callback`, { callback: 'x#y' });
  assert.equal(none.statusCode, 409);
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

test('登录换码走账号绑定的出口，而不是宿主默认网络', async () => {
  const store = createOfficialAccountStore({ root: tmpRoot() });
  const listener = listenerStub();
  const credentials = createClaudeAccountCredentialService({ accounts: store, fetch: mockFetch({}).fetch });
  const hostFetch = mockFetch({ 'platform.claude.com/v1/oauth/token': { status: 200, body: TOKEN_OK } });
  const egressCalls = [];
  const h = routeHarness({
    accounts: store, providers: providersStub(), credentials,
    fetch: hostFetch.fetch,
    waitForCallback: listener.factory,
    egressFetchForAccount: async () => async (url, init) => {
      egressCalls.push({ url, method: init.method });
      return {
        ok: true, status: 200, headers: {},
        async text() { return JSON.stringify(TOKEN_OK); },
        async json() { return TOKEN_OK; },
      };
    },
  });
  const created = await h.invoke('POST', '/api/claude/accounts', { label: '出口号' });
  const state = new URL(created.body.oauthUrl).searchParams.get('state');
  listener.instances[0].resolve({ code: 'the-code', state });
  for (let i = 0; i < 4; i += 1) await new Promise(resolve => setImmediate(resolve));

  assert.equal(egressCalls.length, 1, 'the token exchange must use the account egress');
  assert.match(egressCalls[0].url, /oauth\/token/);
  assert.equal(egressCalls[0].method, 'POST');
  assert.equal(hostFetch.calls.length, 0, 'no silent direct dial for a bound account');
  const status = await h.invoke('GET', `/api/claude/accounts/${created.body.accountId}/login-status`);
  assert.equal(status.body.state, 'complete');
});
