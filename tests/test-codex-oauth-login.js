'use strict';

// Codex account login is multicc's own PKCE flow now (src/codex-auth/
// official-oauth.js): an authorize link, a one-shot loopback listener on the
// public Codex client's registered ports, and — the reason this exists — a
// paste-the-callback escape hatch for browsers that cannot reach this machine.
// These tests pin the protocol constants (they must match codex-cli, or the
// token endpoint refuses the exchange), the auth.json shape the CLI and relay
// read, the paste validation, and the route wiring that lands the credential.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const {
  CLIENT_ID,
  CALLBACK_PATH,
  CALLBACK_PORTS,
  SCOPE,
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  buildAuthFile,
  exchangeCode,
  openCallback,
  parseIdTokenClaims,
} = require('../src/codex-auth/official-oauth');
const { mountCodexAccountRoutes } = require('../src/routes/codex-accounts');

const ACCOUNT = 'ab'.repeat(8);

function fakeJwt(payload) {
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(payload)}.sig`;
}

function routeApp() {
  const routes = new Map();
  return {
    routes,
    get: (path, handler) => routes.set(`GET ${path}`, handler),
    post: (path, handler) => routes.set(`POST ${path}`, handler),
    delete: (path, handler) => routes.set(`DELETE ${path}`, handler),
  };
}

function call(app, method, path, { params = {}, body = {} } = {}) {
  const handler = app.routes.get(`${method} ${path}`);
  assert.ok(handler, `${method} ${path} must be mounted`);
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return Promise.resolve(handler({ params, body }, res)).then(() => res);
}

test('the authorize URL carries the Codex client id, scopes and PKCE', () => {
  const { codeChallenge } = generatePkce();
  const state = generateState();
  const redirectUri = 'http://127.0.0.1:1455/auth/callback';
  const url = new URL(buildAuthorizeUrl({ state, codeChallenge, redirectUri }));
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(CLIENT_ID, 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(url.searchParams.get('scope'), SCOPE);
  assert.match(url.searchParams.get('scope'), /offline_access/);
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(url.searchParams.get('code_challenge'), codeChallenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('id_token_add_organizations'), 'true');
  assert.equal(url.searchParams.get('codex_cli_simplified_flow'), 'true');
  assert.equal(url.searchParams.get('originator'), 'codex_cli_rs');
  assert.deepEqual(CALLBACK_PORTS, [1455, 1457], 'the ports registered for the public client');
  assert.equal(CALLBACK_PATH, '/auth/callback');
  assert.throws(() => buildAuthorizeUrl({ state, codeChallenge }), /redirectUri is required/);
});

test('auth.json is written in the CLI shape and derives the account id from the id_token', () => {
  const idToken = fakeJwt({
    email: 'me@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123', chatgpt_plan_type: 'plus' },
  });
  const now = Date.parse('2026-10-22T00:00:00.000Z');
  const { auth, email, accountId } = buildAuthFile(
    { id_token: idToken, access_token: 'at', refresh_token: 'rt' },
    { now: () => now },
  );
  assert.equal(email, 'me@example.com');
  assert.equal(accountId, 'acct-123');
  assert.deepEqual(auth, {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: idToken, access_token: 'at', refresh_token: 'rt', account_id: 'acct-123' },
    last_refresh: new Date(now).toISOString(),
  });
  assert.equal(parseIdTokenClaims(idToken).auth.chatgpt_plan_type, 'plus');
  assert.deepEqual(parseIdTokenClaims('not-a-jwt'), {});
  assert.throws(() => buildAuthFile({ id_token: idToken, refresh_token: 'rt' }), /access_token/);
  assert.throws(() => buildAuthFile({ id_token: idToken, access_token: 'at' }), /refresh_token/);
});

test('the code is exchanged form-encoded, the way codex-cli sends it', async () => {
  const idToken = fakeJwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } });
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    return {
      status: 200,
      text: async () => JSON.stringify({ id_token: idToken, access_token: 'at', refresh_token: 'rt' }),
    };
  };
  const credential = await exchangeCode(fetchImpl, {
    code: 'the-code',
    codeVerifier: 'verifier',
    redirectUri: 'http://127.0.0.1:1455/auth/callback',
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://auth.openai.com/oauth/token');
  assert.equal(seen[0].options.method, 'POST');
  assert.match(seen[0].options.headers['Content-Type'], /application\/x-www-form-urlencoded/);
  const body = new URLSearchParams(String(seen[0].options.body));
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('client_id'), CLIENT_ID);
  assert.equal(body.get('code'), 'the-code');
  assert.equal(body.get('code_verifier'), 'verifier');
  assert.equal(body.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
  assert.equal(credential.auth.tokens.account_id, 'acct-1');

  await assert.rejects(
    exchangeCode(async () => ({ status: 400, text: async () => 'invalid_grant' }), {
      code: 'x', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:1455/auth/callback',
    }),
    /token endpoint HTTP 400: invalid_grant/,
  );
});

test('the loopback listener completes from the browser redirect', async () => {
  const listener = await openCallback({ ports: [0], timeoutMs: 5000 });
  try {
    assert.match(listener.redirectUri, new RegExp(`^http://127\\.0\\.0\\.1:${listener.port}/auth/callback$`));
    const status = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${listener.port}/other?code=x`, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(status, 404, 'only /auth/callback is answered');
    const ok = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${listener.port}/auth/callback?code=good&state=st`, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(ok, 200);
    assert.deepEqual(await listener.promise, { code: 'good', state: 'st' });
  } finally {
    listener.cancel();
  }
});

test('a pasted callback is accepted only for this login\'s own address', async () => {
  const listener = await openCallback({ ports: [0], timeoutMs: 5000 });
  const otherPort = listener.port === 65535 ? 65534 : listener.port + 1;
  const at = (port, query) => `http://127.0.0.1:${port}/auth/callback?${query}`;
  try {
    assert.throws(() => listener.submit(''), /paste the address/);
    assert.throws(() => listener.submit(at(otherPort, 'code=a&state=st'), { expectedState: 'st' }), /port mismatch/);
    assert.throws(() => listener.submit('https://evil.example/auth/callback?code=a', { expectedState: 'st' }), /not a loopback callback/);
    assert.throws(() => listener.submit(`http://127.0.0.1:${listener.port}/callback?code=a&state=st`, { expectedState: 'st' }), /not a sign-in callback/);
    assert.throws(() => listener.submit(at(listener.port, 'state=st'), { expectedState: 'st' }), /no code/);
    assert.throws(() => listener.submit(at(listener.port, 'code=a&state=other'), { expectedState: 'st' }), /state mismatch/);
    listener.submit(at(listener.port, 'code=good&state=st'), { expectedState: 'st' });
    assert.deepEqual(await listener.promise, { code: 'good', state: 'st' });
    assert.throws(() => listener.submit(at(listener.port, 'code=again&state=st')), /this sign-in is over/);
  } finally {
    listener.cancel();
  }
});

test('when the first registered port is busy the listener falls to the next one', async () => {
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const busy = blocker.address().port;
  const listener = await openCallback({ ports: [busy, 0], timeoutMs: 5000 });
  try {
    assert.notEqual(listener.port, busy);
    assert.match(listener.redirectUri, new RegExp(`:${listener.port}/auth/callback$`));
  } finally {
    listener.cancel();
    await new Promise(resolve => blocker.close(resolve));
  }
});

test('the account routes hand out a link and land the credential from a pasted callback', async () => {
  const app = routeApp();
  const written = [];
  const exchanges = [];
  let listener;
  const accounts = {
    listCodexAccounts: () => [{ id: ACCOUNT, label: '小号', loggedIn: written.length > 0 }],
    createCodexAccount: () => ({ id: ACCOUNT }),
    deleteCodexAccount() {},
    writeCodexCredential: (id, auth) => written.push({ id, auth }),
  };
  const providers = {
    listProviders: () => [],
    getProvider: () => null,
    getOfficialAccountSelection: () => null,
    createProvider: () => ({ id: `codex-official-${ACCOUNT}` }),
    deleteProvider() {},
    selectOfficialAccount() {},
  };
  const idToken = fakeJwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-9' } });
  const fetchImpl = async (url, options) => {
    exchanges.push({ url, body: String(options.body) });
    return { status: 200, text: async () => JSON.stringify({ id_token: idToken, access_token: 'at', refresh_token: 'rt' }) };
  };
  const waitForCallback = () => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    listener = {
      redirectUri: 'http://127.0.0.1:1455/auth/callback',
      promise,
      cancelled: false,
      submitted: null,
      cancel() { listener.cancelled = true; },
      submit(raw, { expectedState } = {}) {
        // The real listener validates the address; the stub only has to keep
        // the same contract for the state check the route delegates to it.
        listener.submitted = { raw, expectedState };
        const state = new URL(raw).searchParams.get('state');
        if (expectedState && state !== expectedState) {
          throw new Error('state mismatch (possible CSRF) — login discarded');
        }
        resolve({ code: 'the-code', state });
      },
    };
    return listener;
  };
  const refreshes = [];
  mountCodexAccountRoutes(app, { accounts, providers, waitForCallback, fetch: fetchImpl,
    modelCatalogRuntime: { refreshAccount(id, options) {
      assert.equal(written.length, 1, '先保存凭据，再刷新模型');
      refreshes.push({ id, options });
      return Promise.reject(new Error('模拟 CLI 刷新失败'));
    } },
  });

  const created = await call(app, 'POST', '/api/codex/accounts', { body: { label: '小号' } });
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.accountId, ACCOUNT);
  assert.match(created.body.oauthUrl, /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
  assert.match(decodeURIComponent(created.body.oauthUrl), /redirect_uri=http:\/\/127\.0\.0\.1:1455\/auth\/callback/);
  const state = new URL(created.body.oauthUrl).searchParams.get('state');

  const pending = await call(app, 'GET', '/api/codex/accounts/:id/login-status', { params: { id: ACCOUNT } });
  assert.equal(pending.body.state, 'pending');
  assert.equal(pending.body.oauthUrl, created.body.oauthUrl, 'a reload can resume from the stored link');

  const missing = await call(app, 'GET', '/api/codex/accounts/:id/login-status', { params: { id: 'ffff' } });
  assert.equal(missing.statusCode, 404);

  const badState = await call(app, 'POST', '/api/codex/accounts/:id/login-callback', {
    params: { id: ACCOUNT },
    body: { callback: 'http://127.0.0.1:1455/auth/callback?code=c&state=wrong' },
  });
  assert.equal(badState.statusCode, 400);
  assert.match(badState.body.error, /state mismatch/);

  const pasted = await call(app, 'POST', '/api/codex/accounts/:id/login-callback', {
    params: { id: ACCOUNT },
    body: { callback: `http://127.0.0.1:1455/auth/callback?code=the-code&state=${state}` },
  });
  assert.equal(pasted.statusCode, 200);
  assert.equal(pasted.body.accepted, true);
  assert.equal(listener.submitted.expectedState, state, 'the listener verifies the flow state itself');

  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(written.length, 1);
  assert.equal(written[0].id, ACCOUNT);
  assert.equal(written[0].auth.auth_mode, 'chatgpt');
  assert.equal(written[0].auth.tokens.account_id, 'acct-9');
  assert.equal(exchanges.length, 1);
  assert.equal(new URLSearchParams(exchanges[0].body).get('code'), 'the-code');

  const done = await call(app, 'GET', '/api/codex/accounts/:id/login-status', { params: { id: ACCOUNT } });
  assert.equal(done.body.state, 'complete');
  assert.equal(done.body.email, 'me@example.com');
  assert.deepEqual(refreshes, [{ id: ACCOUNT, options: { force: true } }]);

  const again = await call(app, 'POST', '/api/codex/accounts/:id/login-callback', {
    params: { id: ACCOUNT },
    body: { callback: 'http://127.0.0.1:1455/auth/callback?code=x&state=y' },
  });
  assert.equal(again.body.state, 'complete');
  assert.equal(again.body.accepted, false);

  const listed = await call(app, 'GET', '/api/codex/accounts');
  assert.equal(listed.body.accounts[0].loggedIn, true);
  assert.equal(listed.body.accounts[0].login.state, 'complete');
});

test('a login whose listener cannot start reports it instead of hanging', async () => {
  const app = routeApp();
  const accounts = {
    listCodexAccounts: () => [{ id: ACCOUNT, label: '', loggedIn: false }],
    createCodexAccount: () => ({ id: ACCOUNT }),
    deleteCodexAccount() {},
    writeCodexCredential() {},
  };
  const providers = {
    listProviders: () => [], getProvider: () => null, getOfficialAccountSelection: () => null,
    createProvider: () => ({ id: 'p' }), deleteProvider() {}, selectOfficialAccount() {},
  };
  mountCodexAccountRoutes(app, {
    accounts,
    providers,
    waitForCallback: async () => { throw new Error('codex 回调端口都被占用（1455: in use）'); },
  });
  const created = await call(app, 'POST', '/api/codex/accounts', { body: {} });
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.oauthUrl, null);
  assert.match(created.body.loginError, /1455/);
  const status = await call(app, 'GET', '/api/codex/accounts/:id/login-status', { params: { id: ACCOUNT } });
  assert.equal(status.body.state, 'error');
  const noPending = await call(app, 'POST', '/api/codex/accounts/:id/login-callback', {
    params: { id: ACCOUNT }, body: { callback: 'http://127.0.0.1:1455/auth/callback?code=c&state=s' },
  });
  assert.equal(noPending.statusCode, 409);
});
