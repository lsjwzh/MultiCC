'use strict';

// The codex OAuth surface is deliberately thin: a status read that maps the
// refresher's needs_login terminal state, and a login opener that creates (or
// reuses) a whitelisted interactive `codex login` terminal session. These
// tests pin both, plus the session-record arguments the opener must use —
// the wrong provider or CLI home would log into the wrong account.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  mountCodexOAuthRoutes,
  createLoginSessionOpener,
  CODEX_LOGIN_SESSION_ID,
} = require('../src/routes/codex-oauth');

function fakeApp() {
  const routes = { get: [], post: [] };
  return {
    routes,
    get: (path, handler) => routes.get.push([path, handler]),
    post: (path, handler) => routes.post.push([path, handler]),
  };
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = code => { res.statusCode = code; return res; };
  res.json = payload => { res.body = payload; return res; };
  return res;
}

function findRoute(routes, method, path) {
  const hit = routes[method].find(([p]) => p === path);
  assert.ok(hit, `${method.toUpperCase()} ${path} must be mounted`);
  return hit[1];
}

test('status maps the refresher needs_login state for the banner', () => {
  const app = fakeApp();
  const status = {
    enabled: true,
    needsLogin: { since: 123, reason: 'api-error' },
    lastOutcome: { outcome: 'needs_login' },
    consecutiveFailures: 4,
    retryAfter: 999,
  };
  mountCodexOAuthRoutes(app, { getStatus: () => status, openLoginSession: async () => ({ ok: true, sessionId: 'x' }) });
  const handler = findRoute(app.routes, 'get', '/api/codex/oauth/status');
  const res = fakeRes();
  handler({}, res);
  assert.deepEqual(res.body, {
    ok: true,
    enabled: true,
    needsLogin: true,
    needsLoginSince: 123,
    lastOutcome: 'needs_login',
    consecutiveFailures: 4,
    retryAfter: 999,
    loginCommand: 'codex login',
  });
});

test('status stays quiet and credential-free when healthy', () => {
  const app = fakeApp();
  mountCodexOAuthRoutes(app, {
    getStatus: () => ({ enabled: true, needsLogin: null, lastOutcome: { outcome: 'fresh' }, consecutiveFailures: 0, retryAfter: 0 }),
    openLoginSession: async () => ({ ok: true, sessionId: 'x' }),
  });
  const handler = findRoute(app.routes, 'get', '/api/codex/oauth/status');
  const res = fakeRes();
  handler({}, res);
  assert.equal(res.body.needsLogin, false);
  assert.equal(res.body.loginCommand, null);
  const text = JSON.stringify(res.body);
  assert.equal(/token|refresh|secret/i.test(text), false, 'no credential material may leak into the status payload');
});

test('login opener reuses an existing login session without creating a new one', async () => {
  const app = fakeApp();
  let created = 0;
  mountCodexOAuthRoutes(app, {
    getStatus: () => ({}),
    persistedSessionExists: id => id === CODEX_LOGIN_SESSION_ID,
    directories: new Map([['d1', { id: 'd1', path: '/tmp/x' }]]),
    createSessionRecord: async () => { created += 1; return { ok: true, id: CODEX_LOGIN_SESSION_ID }; },
  });
  const handler = findRoute(app.routes, 'post', '/api/codex/oauth/login');
  const res = fakeRes();
  await handler({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sessionId, CODEX_LOGIN_SESSION_ID);
  assert.equal(res.body.reused, true);
  assert.equal(created, 0);
});

test('login opener creates the whitelisted codex-login terminal on the default login', async () => {
  let recorded = null;
  const opener = createLoginSessionOpener({
    directories: new Map([['d1', { id: 'd1', path: '/tmp/x' }]]),
    createSessionRecord: async args => { recorded = args; return { ok: true, id: CODEX_LOGIN_SESSION_ID }; },
  });
  const result = await opener();
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, CODEX_LOGIN_SESSION_ID);
  assert.equal(recorded.cli, 'codex');
  assert.equal(recorded.kind, 'terminal');
  assert.equal(recorded.id, CODEX_LOGIN_SESSION_ID);
  assert.equal(recorded.loginFlow, 'codex-login');
  assert.equal(recorded.provider, null, 'must target the shared default ChatGPT login, not a cc-switch home');
  assert.equal(recorded.persistence, 'required');
});

test('login opener reports failures instead of throwing', async () => {
  const app = fakeApp();
  mountCodexOAuthRoutes(app, {
    getStatus: () => ({}),
    openLoginSession: async () => ({ ok: false, error: 'no directory available' }),
  });
  const handler = findRoute(app.routes, 'post', '/api/codex/oauth/login');
  const res = fakeRes();
  await handler({}, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'no directory available');
});

test('login opener without any directory fails cleanly', async () => {
  const opener = createLoginSessionOpener({
    directories: new Map(),
    createSessionRecord: async () => { throw new Error('must not be called'); },
  });
  const result = await opener();
  assert.equal(result.ok, false);
});

test('mounting validates its dependencies', () => {
  assert.throws(() => mountCodexOAuthRoutes(null, {}), TypeError);
  assert.throws(() => mountCodexOAuthRoutes(fakeApp(), {}), TypeError);
});
