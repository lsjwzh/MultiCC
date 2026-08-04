'use strict';

// The Claude OAuth surface mirrors the codex one (status read + one-click
// interactive login terminal) and adds the piece codex does not have: the
// temporary login TUI is destroyed by the server once the credential store
// proves a re-login landed. These tests pin the status mapping rules (a
// never-logged-in machine must stay banner-free), the opener's session-record
// arguments, and every branch of the closer's "did the credential actually
// change" judgement.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  mountClaudeOAuthRoutes,
  createLoginSessionOpener,
  createLoginSessionCloser,
  CLAUDE_AUTH_SESSION_ID,
} = require('../src/routes/claude-oauth');

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

test('status shows the banner only on needs-login or failed outcomes', async () => {
  const seen = [
    ['needs-login', true],
    ['failed', true],
    ['fresh', false],
    ['refreshed', false],
    ['deferred', false],
    ['no-credentials', false],
    ['cooldown', false],
    [null, false],
  ];
  for (const [outcome, expected] of seen) {
    const app = fakeApp();
    mountClaudeOAuthRoutes(app, {
      getStatus: () => ({
        enabled: true,
        lastOutcome: outcome ? { outcome } : null,
        consecutiveFailures: 0,
      }),
      openLoginSession: async () => ({ ok: true, sessionId: 'x' }),
    });
    const handler = findRoute(app.routes, 'get', '/api/claude/oauth/status');
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.body.needsLogin, expected, `outcome ${outcome}`);
    assert.equal(res.body.loginCommand, expected ? 'claude auth login' : null);
  }
});

test('status reports an open login session and never leaks credential material', async () => {
  const app = fakeApp();
  mountClaudeOAuthRoutes(app, {
    getStatus: () => ({ enabled: true, lastOutcome: { outcome: 'needs-login' }, consecutiveFailures: 2 }),
    openLoginSession: async () => ({ ok: true, sessionId: 'x' }),
    persistedSessionExists: id => id === CLAUDE_AUTH_SESSION_ID,
  });
  const handler = findRoute(app.routes, 'get', '/api/claude/oauth/status');
  const res = fakeRes();
  await handler({}, res);
  assert.equal(res.body.loginSessionId, CLAUDE_AUTH_SESSION_ID);
  const text = JSON.stringify(res.body);
  assert.equal(/token|refresh|secret/i.test(text), false, 'no credential material in the payload');
});

test('status poll triggers the closer sweep', async () => {
  const app = fakeApp();
  const calls = [];
  mountClaudeOAuthRoutes(app, {
    getStatus: () => ({ enabled: true, lastOutcome: { outcome: 'fresh' } }),
    openLoginSession: async () => ({ ok: true, sessionId: 'x' }),
    closer: { async maybeClose(reason) { calls.push(reason); return { closed: false }; } },
  });
  const handler = findRoute(app.routes, 'get', '/api/claude/oauth/status');
  await handler({}, fakeRes());
  assert.deepEqual(calls, ['status-poll']);
});

test('login opener creates the whitelisted claude-auth-login terminal', async () => {
  const created = [];
  const opener = createLoginSessionOpener({
    directories: new Map([['dir-1', { id: 'dir-1', path: '/tmp/one' }]]),
    persistedSessionExists: () => false,
    createSessionRecord: async args => { created.push(args); return { ok: true, id: args.id }; },
  });
  const result = await opener();
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, CLAUDE_AUTH_SESSION_ID);
  assert.equal(created.length, 1);
  assert.deepEqual({ ...created[0], dir: undefined }, {
    dir: undefined,
    cli: 'claude',
    kind: 'terminal',
    id: CLAUDE_AUTH_SESSION_ID,
    label: 'Claude 登录',
    provider: null,
    loginFlow: 'claude-auth-login',
    persistence: 'required',
    persistenceSource: 'runtime.claude-auth-login',
  });
});

test('login opener reuses an existing session and never creates a second one', async () => {
  let creates = 0;
  const opener = createLoginSessionOpener({
    directories: new Map(),
    persistedSessionExists: () => true,
    createSessionRecord: async () => { creates += 1; return { ok: true, id: 'x' }; },
  });
  const result = await opener();
  assert.deepEqual(result, { ok: true, sessionId: CLAUDE_AUTH_SESSION_ID, reused: true });
  assert.equal(creates, 0);
});

test('login endpoint notes the credential the session opened with', async () => {
  const app = fakeApp();
  const noted = [];
  mountClaudeOAuthRoutes(app, {
    getStatus: () => ({}),
    openLoginSession: async () => ({ ok: true, sessionId: CLAUDE_AUTH_SESSION_ID, reused: false }),
    readCredentialExpiry: async () => 111,
    closer: { noteOpened: expiry => noted.push(expiry), async maybeClose() { return { closed: false }; } },
  });
  const handler = findRoute(app.routes, 'post', '/api/claude/oauth/login');
  const res = fakeRes();
  await handler({}, res);
  assert.equal(res.body.ok, true);
  assert.deepEqual(noted, [111]);
});

function closerFixture({ credentials, openedExpiry, sessionExists = true, destroyOk = true }) {
  const destroyed = [];
  const deleted = [];
  const events = [];
  const persistedSessions = new Map();
  if (sessionExists) {
    persistedSessions.set(CLAUDE_AUTH_SESSION_ID, {
      id: CLAUDE_AUTH_SESSION_ID, dirId: 'dir-1', label: 'Claude 登录',
    });
  }
  const closer = createLoginSessionCloser({
    refresher: { readCredentials: async () => credentials },
    persistedSessions,
    directories: new Map([['dir-1', { id: 'dir-1', path: '/tmp/one' }]]),
    destroySessionCascade: async () => {
      destroyed.push(CLAUDE_AUTH_SESSION_ID);
      return destroyOk ? { ok: true } : { ok: false, error: 'busy' };
    },
    sessionPersistence: { mutate: (source, fn) => fn(persistedSessions) },
    appendEvent: (dirId, type, label) => events.push({ dirId, type, label }),
    now: () => 1000,
  });
  if (openedExpiry !== undefined) closer.noteOpened(openedExpiry);
  return { closer, destroyed, deleted, events, persistedSessions };
}

test('closer destroys the login terminal once a different valid credential lands', async () => {
  const fixture = closerFixture({
    credentials: { ok: true, expiresAt: 9999 },
    openedExpiry: 500, // the dead credential the session opened with
  });
  const result = await fixture.closer.maybeClose('periodic');
  assert.deepEqual(result, { closed: true, reason: 'periodic' });
  assert.deepEqual(fixture.destroyed, [CLAUDE_AUTH_SESSION_ID]);
  assert.equal(fixture.persistedSessions.has(CLAUDE_AUTH_SESSION_ID), false, 'record removed');
  assert.deepEqual(fixture.events, [{ dirId: 'dir-1', type: 'session_deleted', label: 'Claude 登录' }]);
});

test('closer leaves the terminal alone while the credential is unchanged', async () => {
  const fixture = closerFixture({
    credentials: { ok: true, expiresAt: 9999 },
    openedExpiry: 9999,
  });
  const result = await fixture.closer.maybeClose('periodic');
  assert.equal(result.closed, false);
  assert.equal(result.reason, 'unchanged-credential');
  assert.equal(fixture.destroyed.length, 0);
  assert.equal(fixture.persistedSessions.has(CLAUDE_AUTH_SESSION_ID), true);
});

test('closer leaves the terminal alone while the credential is still expired', async () => {
  const fixture = closerFixture({
    credentials: { ok: true, expiresAt: 500 }, // dead at now=1000
    openedExpiry: 500,
  });
  const result = await fixture.closer.maybeClose('periodic');
  assert.equal(result.closed, false);
  assert.equal(result.reason, 'still-expired');
  assert.equal(fixture.destroyed.length, 0);
});

test('closer without a noted expiry (post-restart) closes on any valid credential', async () => {
  const fixture = closerFixture({ credentials: { ok: true, expiresAt: 9999 } });
  const result = await fixture.closer.maybeClose('boot');
  assert.equal(result.closed, true, 'a leftover login TUI plus a valid credential means the login already happened');
});

test('closer is a no-op without a login session, and survives a failed destroy', async () => {
  const noSession = closerFixture({ credentials: { ok: true, expiresAt: 9999 }, sessionExists: false });
  assert.equal((await noSession.closer.maybeClose('x')).reason, 'no-session');

  const failing = closerFixture({
    credentials: { ok: true, expiresAt: 9999 },
    destroyOk: false,
  });
  const result = await failing.closer.maybeClose('periodic');
  assert.equal(result.closed, false);
  assert.equal(result.reason, 'busy');
  assert.equal(failing.persistedSessions.has(CLAUDE_AUTH_SESSION_ID), true, 'record kept when destroy fails');
});
