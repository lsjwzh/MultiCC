'use strict';

// Black-box contract test for the extracted HTTP auth surface
// (src/routes/auth.js). It mounts createAuthRuntime onto a real express app
// with fully-faked dependencies, listens on a random loopback port, and drives
// every auth branch over real HTTP. No part of server.js is loaded, so this
// pins the module's behaviour independently of host wiring.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createAuthRuntime } = require('../src/routes/auth');

// A controllable harness. `state` lets each test flip the mutable host inputs
// (access token, shutdown flag, whether the peer is loopback) between requests.
function buildHarness(overrides = {}) {
  const state = {
    accessToken: '',
    shuttingDown: false,
    local: true,
    peerAllowed: true,
    scopedRequest: false,
    relayAuthorizer: null,
    metrics: [],
    ...overrides,
  };
  const authSecurity = {
    createCookie: () => 'FRESHCOOKIE',
    verifyCookie: value => value === 'GOODCOOKIE',
    verifyAccessToken: value => value === 'sekret',
    issueWsTicket: (wsPath) => {
      if (wsPath === '/bad') throw new Error('invalid path');
      return { ticket: 'TICKET', path: wsPath };
    },
  };
  const app = express();
  // Stand in for requestIdMiddleware.
  app.use((req, _res, next) => { req.id = 'req-1'; req.correlationId = 'cid-1'; next(); });
  const runtime = createAuthRuntime({
    express,
    authSecurity,
    isLocalRequest: () => state.local,
    parseCookies: (header) => {
      const out = {};
      String(header || '').split(';').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx > 0) out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      });
      return out;
    },
    normalizeRedirect: (value) => {
      const v = String(value || '/');
      return v.startsWith('/') && !v.startsWith('//') ? v : '/';
    },
    escapeHtmlAttribute: (value) => String(value).replace(/"/g, '&quot;').replace(/</g, '&lt;'),
    metrics: { inc: (name) => state.metrics.push(name) },
    logger: { warn: () => {} },
    createErrorDto: (dto) => ({ error: dto }),
    getAccessToken: () => state.accessToken,
    getShuttingDown: () => state.shuttingDown,
    authorizeProviderRelayRequest: input => typeof state.relayAuthorizer === 'function'
      ? state.relayAuthorizer(input) : null,
    isRequestPeerAllowed: () => state.peerAllowed,
    authorizeScopedRequest: () => state.scopedRequest,
    allowLegacyTokenQuery: !!state.allowLegacyTokenQuery,
  });
  runtime.mountRoutes(app);
  if (state.mountProtectedRoutes) state.mountProtectedRoutes(app);
  // Terminal "protected resource": only reached when the gate calls next().
  app.use((req, res) => res.status(200).json({ ok: true, path: req.path }));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ state, base, close: () => new Promise(r => server.close(r)) });
    });
  });
}

// fetch that never follows redirects, so we can assert on 302 + Location.
function raw(base, path, init = {}) {
  return fetch(base + path, { redirect: 'manual', ...init });
}

test('no ACCESS_TOKEN: loopback peer is allowed, external peer is rejected', async () => {
  const h = await buildHarness({ accessToken: '', local: true });
  try {
    let res = await raw(h.base, '/api/thing', { headers: { accept: 'application/json' } });
    assert.equal(res.status, 200);

    h.state.local = false; // external transport peer, still no token configured
    res = await raw(h.base, '/api/thing', { headers: { accept: 'application/json' } });
    assert.equal(res.status, 403);
  } finally { await h.close(); }
});

test('automatic LAN policy rejects direct public peers before login, static and relay bypasses', async () => {
  const h = await buildHarness({ accessToken: 'sekret', local: false, peerAllowed: false });
  try {
    for (const [method, pathname, headers] of [
      ['GET', '/login', {}],
      ['GET', '/app.js', {}],
      ['GET', '/healthz', {}],
      ['POST', '/claude-proxy/p1/s1/v1/messages', { 'x-api-key': 'relay-pxy' }],
      ['GET', '/api/thing', { 'x-access-token': 'sekret' }],
    ]) {
      const res = await raw(h.base, pathname, { method, headers });
      assert.equal(res.status, 403, `${method} ${pathname}`);
    }
    assert.ok(h.state.metrics.includes('multicc_auth_public_peer_rejected_total'));
  } finally { await h.close(); }
});

test('with ACCESS_TOKEN: external request without credentials is 403; html gets redirect', async () => {
  const h = await buildHarness({ accessToken: 'sekret', local: false });
  try {
    let res = await raw(h.base, '/api/thing', { headers: { accept: 'application/json' } });
    assert.equal(res.status, 403);
    const body = (await res.json()).error;
    assert.equal(body.code, 'AUTH_REQUIRED');
    assert.equal(body.message, 'Forbidden: not authenticated');
    assert.equal(body.category, 'authentication_permission');
    assert.equal(body.action, 'login');

    res = await raw(h.base, '/air', { headers: { accept: 'text/html' } });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /^\/login\?redirect=/);
  } finally { await h.close(); }
});

test('cookie, x-access-token grant access; wrong ones do not', async () => {
  const h = await buildHarness({ accessToken: 'sekret', local: false });
  try {
    let res = await raw(h.base, '/api/thing', { headers: { accept: 'application/json', cookie: 'multicc_auth=GOODCOOKIE' } });
    assert.equal(res.status, 200);

    res = await raw(h.base, '/api/thing', { headers: { accept: 'application/json', cookie: 'multicc_auth=WRONG' } });
    assert.equal(res.status, 403);

    res = await raw(h.base, '/api/thing', { headers: { accept: 'application/json', 'x-access-token': 'sekret' } });
    assert.equal(res.status, 200);

    res = await raw(h.base, '/api/thing', { headers: { accept: 'application/json', 'x-access-token': 'nope' } });
    assert.equal(res.status, 403);
  } finally { await h.close(); }
});

test('unscoped legacy relay credentials never unlock CPR mounts', async () => {
  const previous = process.env.MULTICC_PROXY_TOKEN;
  process.env.MULTICC_PROXY_TOKEN = 'relay-pxy';
  const h = await buildHarness({ accessToken: 'sekret', local: false });
  try {
    // A leftover environment value is deliberately ignored.
    let res = await raw(h.base, '/claude-proxy/p1/s1/v1/messages', {
      method: 'POST', headers: { 'x-api-key': 'relay-pxy' },
    });
    assert.equal(res.status, 403);

    // Bearer authentication cannot revive the global credential either.
    res = await raw(h.base, '/codex-proxy/p1/responses', {
      method: 'POST', headers: { authorization: 'Bearer relay-pxy' },
    });
    assert.equal(res.status, 403);
    res = await raw(h.base, '/claude-proxy/p1/s1/v1/messages', { method: 'POST' });
    assert.equal(res.status, 403);

    res = await raw(h.base, '/api/thing', { headers: { accept: 'application/json', 'x-api-key': 'relay-pxy' } });
    assert.equal(res.status, 403);
    assert.equal(h.state.metrics.includes('multicc_auth_proxy_relay_total'), false);
  } finally {
    await h.close();
    if (previous === undefined) delete process.env.MULTICC_PROXY_TOKEN;
    else process.env.MULTICC_PROXY_TOKEN = previous;
  }
});

test('a provider-scoped relay credential is independently authorized and accounted', async () => {
  const authorizations = [];
  const h = await buildHarness({
    accessToken: 'sekret',
    local: false,
    relayAuthorizer(input) {
      authorizations.push(input);
      return input.credential === 'mcr1.abcdefghijklmnop.manual-secret'
        && input.pathname === '/claude-proxy/p1/remote/v1/messages'
        ? { ok: true, shareId: 'abcdefghijklmnop' }
        : { ok: false };
    },
  });
  try {
    let res = await raw(h.base, '/claude-proxy/p1/remote/v1/messages', {
      method: 'POST', headers: { 'x-api-key': 'mcr1.abcdefghijklmnop.manual-secret' },
    });
    assert.equal(res.status, 200);
    assert.equal(authorizations.length, 1);
    assert.ok(h.state.metrics.includes('multicc_auth_provider_relay_share_total'));

    res = await raw(h.base, '/claude-proxy/p2/remote/v1/messages', {
      method: 'POST', headers: { 'x-api-key': 'mcr1.abcdefghijklmnop.manual-secret' },
    });
    assert.equal(res.status, 403, 'the same link cannot open another provider');
    res = await raw(h.base, '/api/thing', {
      headers: { 'x-api-key': 'mcr1.abcdefghijklmnop.manual-secret' },
    });
    assert.equal(res.status, 403, 'the link cannot open the admin API');
  } finally { await h.close(); }
});

test('provider relay credentials also unlock scoped quota/model endpoints on both protocols', async () => {
  const allowed = new Set([
    '/claude-proxy/p1/remote/quota',
    '/codex-proxy/p1/quota',
    '/claude-proxy/p1/remote/models',
    '/codex-proxy/p1/models',
  ]);
  const h = await buildHarness({
    accessToken: 'sekret',
    local: false,
    relayAuthorizer(input) {
      return input.credential === 'mcr1.abcdefghijklmnop.manual-secret' && allowed.has(input.pathname)
        ? { ok: true, shareId: 'abcdefghijklmnop' }
        : { ok: false };
    },
  });
  try {
    // GET (manual/manual refresh) and POST (the poller adapter) both ride the
    // same relay-credential gate — no extra auth surface for quota pass-through.
    let res = await raw(h.base, '/claude-proxy/p1/remote/quota', {
      method: 'GET', headers: { 'x-api-key': 'mcr1.abcdefghijklmnop.manual-secret' },
    });
    assert.equal(res.status, 200);
    res = await raw(h.base, '/codex-proxy/p1/quota', {
      method: 'POST', headers: { authorization: 'Bearer mcr1.abcdefghijklmnop.manual-secret' },
    });
    assert.equal(res.status, 200);
    res = await raw(h.base, '/claude-proxy/p1/remote/models', {
      method: 'GET', headers: { authorization: 'Bearer mcr1.abcdefghijklmnop.manual-secret' },
    });
    assert.equal(res.status, 200);
    res = await raw(h.base, '/codex-proxy/p1/models', {
      method: 'GET', headers: { 'x-api-key': 'mcr1.abcdefghijklmnop.manual-secret' },
    });
    assert.equal(res.status, 200);
    assert.ok(h.state.metrics.includes('multicc_auth_provider_relay_share_total'));
    // The quota endpoint inherits provider scoping: a sibling provider is 403.
    res = await raw(h.base, '/codex-proxy/p2/quota', {
      method: 'POST', headers: { authorization: 'Bearer mcr1.abcdefghijklmnop.manual-secret' },
    });
    assert.equal(res.status, 403);
  } finally { await h.close(); }
});

test('legacy token query is gated by allowLegacyTokenQuery', async () => {
  let h = await buildHarness({ accessToken: 'sekret', local: false, allowLegacyTokenQuery: false });
  try {
    const res = await raw(h.base, '/api/thing?token=sekret', { headers: { accept: 'application/json' } });
    assert.equal(res.status, 403);
  } finally { await h.close(); }

  h = await buildHarness({ accessToken: 'sekret', local: false, allowLegacyTokenQuery: true });
  try {
    const res = await raw(h.base, '/api/thing?token=sekret', { headers: { accept: 'application/json' } });
    assert.equal(res.status, 200);
    assert.ok(h.state.metrics.includes('multicc_auth_legacy_query_total'));
  } finally { await h.close(); }
});

test('bootstrap ?token= on an HTML GET sets a cookie and passes through', async () => {
  const h = await buildHarness({ accessToken: 'sekret', local: false });
  try {
    const res = await raw(h.base, '/index.html?token=sekret', { headers: { accept: 'text/html' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie') || '', /multicc_auth=FRESHCOOKIE/);
    assert.ok(h.state.metrics.includes('multicc_auth_bootstrap_query_total'));
  } finally { await h.close(); }
});

test('bypass paths: static assets, wait-resolve, share, artifacts skip auth', async () => {
  const h = await buildHarness({ accessToken: 'sekret', local: false });
  try {
    for (const [method, p] of [
      ['GET', '/app.js'],
      ['POST', '/api/wait/abc123/resolve'],
      ['GET', '/share/deadbeef'],
      ['POST', '/api/share/deadbeef/auth'],
      ['GET', '/api/share/deadbeef/session'],
      // 分享页自己的启动请求：缺了它们，远程接收方输对密码后仍被主程序鉴权拦下。
      ['GET', '/api/share/deadbeef/entry'],
      ['GET', '/api/share/deadbeef/history'],
      ['GET', `/fleet-share/fleet_share_${'a'.repeat(32)}`],
      ['POST', `/api/fleet-shares/fleet_share_${'b'.repeat(32)}/import`],
      ['POST', `/api/fleet-shares/fleet_share_${'c'.repeat(32)}/ws-ticket`],
      ['GET', '/artifacts/xY_9-artifactid/index.html'],
      // iOS OTA: the itms-services fetcher cannot complete the cookie login
      // flow, so the manifest and the IPA download bypass by name/extension —
      // same model as /multicc.apk.
      ['GET', '/ios-ota/manifest.plist'],
      ['GET', '/multicc-ios.ipa'],
    ]) {
      const res = await raw(h.base, p, { method, headers: { accept: 'application/json' } });
      assert.equal(res.status, 200, `${method} ${p} should bypass auth`);
    }
    // The install page itself must NOT bypass: it renders server metadata and
    // stays behind the normal gate (non-api GET → login redirect).
    const gatedIosPage = await raw(h.base, '/ios-ota', { headers: { accept: 'text/html' } });
    assert.equal(gatedIosPage.status, 302);
    // Only the exact recipient endpoints bypass; neighbours stay gated.
    const gatedSibling = await raw(h.base, '/api/share/deadbeef/other', { headers: { accept: 'application/json' } });
    assert.equal(gatedSibling.status, 403);
    // A gated admin share route must NOT bypass.
    const gated = await raw(h.base, '/api/sessions/s1/share', { headers: { accept: 'application/json' } });
    assert.equal(gated.status, 403);
    const gatedFleetAdmin = await raw(h.base, '/api/fleets/f1/share', { method: 'POST', headers: { accept: 'application/json' } });
    assert.equal(gatedFleetAdmin.status, 403);
  } finally { await h.close(); }
});

test('Fleet-scoped credentials pass only when the injected scope authorizer accepts them', async () => {
  const h = await buildHarness({ accessToken: 'sekret', local: false, scopedRequest: false });
  try {
    let res = await raw(h.base, '/api/sessions/remote-session', {
      headers: { 'x-multicc-fleet-token': 'share', 'x-multicc-fleet-grant': 'grant' },
    });
    assert.equal(res.status, 403);
    h.state.scopedRequest = true;
    res = await raw(h.base, '/api/sessions/remote-session', {
      headers: { 'x-multicc-fleet-token': 'share', 'x-multicc-fleet-grant': 'grant' },
    });
    assert.equal(res.status, 200);
    assert.ok(h.state.metrics.includes('multicc_auth_fleet_scope_total'));
  } finally { await h.close(); }
});

test('shutdown gate: every /api request fails 503 with Retry-After', async () => {
  const h = await buildHarness({ accessToken: '', local: true, shuttingDown: true });
  try {
    const res = await raw(h.base, '/api/thing', { headers: { accept: 'application/json' } });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '1');
    const body = await res.json();
    assert.equal(body.error.code, 'SERVER_SHUTTING_DOWN');
    // Non-/api paths are unaffected by the /api-scoped gate.
    h.state.shuttingDown = true;
    const html = await raw(h.base, '/login');
    assert.equal(html.status, 200);
  } finally { await h.close(); }
});

test('login page renders; POST success sets cookie + redirects; failure loops back', async () => {
  const h = await buildHarness({ accessToken: 'sekret', local: false });
  try {
    let res = await raw(h.base, '/login?redirect=%2Fhome');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /name="password"/);
    assert.match(html, /Multi<span>CC<\/span>/);

    const ok = await raw(h.base, '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=sekret&redirect=/home',
    });
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('location'), '/home');
    assert.match(ok.headers.get('set-cookie') || '', /multicc_auth=FRESHCOOKIE/);

    const bad = await raw(h.base, '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=wrong&redirect=/home',
    });
    assert.equal(bad.status, 302);
    assert.match(bad.headers.get('location'), /^\/login\?error=1&redirect=/);
  } finally { await h.close(); }
});

test('logout clears the cookie and redirects to /login', async () => {
  const h = await buildHarness({ accessToken: 'sekret', local: false });
  try {
    const res = await raw(h.base, '/logout');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
    assert.match(res.headers.get('set-cookie') || '', /multicc_auth=;[^]*Max-Age=0/);
  } finally { await h.close(); }
});

test('exchange: 403 without a valid token, 204 + cookie with one', async () => {
  const h = await buildHarness({ accessToken: 'sekret', local: false });
  try {
    let res = await raw(h.base, '/api/auth/exchange', { method: 'POST' });
    assert.equal(res.status, 403);

    res = await raw(h.base, '/api/auth/exchange', { method: 'POST', headers: { 'x-access-token': 'sekret' } });
    assert.equal(res.status, 204);
    assert.match(res.headers.get('set-cookie') || '', /multicc_auth=FRESHCOOKIE/);
  } finally { await h.close(); }

  // With no ACCESS_TOKEN configured, exchange must still refuse (403).
  const h2 = await buildHarness({ accessToken: '', local: true });
  try {
    const res = await raw(h2.base, '/api/auth/exchange', { method: 'POST', headers: { 'x-access-token': 'sekret' } });
    assert.equal(res.status, 403);
  } finally { await h2.close(); }
});

test('ws-ticket: issues a no-store ticket, or 400 on invalid path', async () => {
  const h = await buildHarness({ accessToken: '', local: true });
  try {
    let res = await raw(h.base, '/api/auth/ws-ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/ws/workspace' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { ticket: 'TICKET', path: '/ws/workspace' });

    res = await raw(h.base, '/api/auth/ws-ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/bad' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()).error;
    assert.equal(body.code, 'WS_PATH_INVALID');
    assert.equal(body.message, 'invalid WebSocket path');
    assert.equal(body.category, 'route');
  } finally { await h.close(); }
});

test('createAuthRuntime rejects missing dependencies', () => {
  assert.throws(() => createAuthRuntime({}), /express/);
});

test('creation and message APIs retain the normal local, remote and Fleet authentication contract', async t => {
  const h = await buildHarness();
  t.after(h.close);
  const routes = ['/api/air/tasks', '/api/directories/d1/sessions', '/api/task-board/tasks',
    '/api/task-shells/shell/messages', '/api/task-shell-tasks/task/messages',
    '/api/sessions/s1/fork', '/api/settings/access-token'];
  for (const accessToken of ['', 'sekret']) {
    h.state.accessToken = accessToken;
    h.state.local = true;
    for (const route of routes) {
      assert.equal((await raw(h.base, route, { method: 'POST' })).status, 200,
        `normal local UI needs no extra login: ${route}`);
    }
    h.state.local = false;
    for (const route of routes) {
      const response = await raw(h.base, route, { method: 'POST', headers: {
        origin: h.base, 'x-multicc-router-capability': 'model-cap',
      } });
      assert.equal(response.status, 403, `model instructions do not change remote auth: ${route}`);
      assert.equal((await response.json()).error.code, 'AUTH_REQUIRED');
    }
  }
  for (const headers of [{ 'x-access-token': 'sekret' }, { cookie: 'multicc_auth=GOODCOOKIE' }]) {
    assert.equal((await raw(h.base, '/api/air/tasks', { method: 'POST', headers })).status, 200);
  }
  h.state.scopedRequest = true;
  assert.equal((await raw(h.base, '/api/air/tasks', { method: 'POST' })).status, 200);
});

test('UDID 只有带能力令牌的 POST 回传可绕过登录，页面和描述文件始终受保护', async () => {
  const h = await buildHarness({ accessToken: 'sekret', local: false });
  try {
    const callback = '/ios-ota/udid/callback/' + 'a'.repeat(64);
    assert.equal((await raw(h.base, callback, { method: 'POST', headers: { 'content-type': 'application/pkcs7-signature' } })).status, 200);
    for (const [method, pathname] of [
      ['GET', callback], ['POST', callback], ['POST', '/ios-ota/udid/callback/invalid'],
      ['GET', '/ios-ota/udid.mobileconfig'], ['GET', '/ios-ota'],
    ]) {
      const blocked = await raw(h.base, pathname, { method, headers: { accept: 'application/json' } });
      assert.equal(blocked.status, method === 'GET' ? 302 : 403);
      if (method === 'GET') assert.ok(blocked.headers.get('location').startsWith('/login?'));
    }
    assert.equal((await raw(h.base, '/ios-ota/udid.mobileconfig', { headers: { cookie: 'multicc_auth=GOODCOOKIE' } })).status, 200);
  } finally { await h.close(); }
});

test('UDID 真认证链路：设置无 cookie 回传后可读取结果，不会被重定向到登录页', async () => {
  const { createIosUdid } = require('../src/ios-udid');
  const runtime = createIosUdid({ decode: async body => body.toString() });
  const h = await buildHarness({ accessToken: 'sekret', local: false, mountProtectedRoutes: app => runtime.mountRoutes(app) });
  try {
    const profile = await raw(h.base, '/ios-ota/udid.mobileconfig', { headers: {
      cookie: 'multicc_auth=GOODCOOKIE', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'my-server.example:8443',
    } });
    assert.equal(profile.status, 200);
    const xml = await profile.text();
    const token = /callback\/([a-f0-9]{64})/.exec(xml)[1];
    const challenge = /<key>Challenge<\/key><string>([a-f0-9]{64})/.exec(xml)[1];
    const body = `<plist version="1.0"><dict><key>UDID</key><string>00008110-0012345678901234</string><key>CHALLENGE</key><string>${challenge}</string></dict></plist>`;
    const callback = await raw(h.base, '/ios-ota/udid/callback/' + token, { method: 'POST', headers: { 'content-type': 'application/pkcs7-signature' }, body });
    assert.equal(callback.status, 301);
    assert.equal(callback.headers.get('cache-control'), 'no-store');
    const location = new URL(callback.headers.get('location'));
    assert.equal(location.origin, 'https://my-server.example:8443');
    const result = await raw(h.base, location.pathname);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('location'), null);
    assert.ok((await result.text()).includes('00008110-0012345678901234'));
    assert.equal((await raw(h.base, '/ios-ota/udid/result/' + '0'.repeat(64))).status, 410);
    assert.equal((await raw(h.base, location.pathname, { method: 'POST' })).status, 403);
    assert.equal((await raw(h.base, '/ios-ota/udid/result/invalid')).status, 302);
    assert.equal((await raw(h.base, '/ios-ota')).status, 302, '安装页依旧受登录保护');
    assert.equal((await raw(h.base, '/ios-ota/udid.mobileconfig')).status, 302, '新请求依旧受登录保护');
  } finally { await h.close(); }
});

// Frozen Node owner versus the native owner, including host call order and
// side effects. HTTP framing is covered by the real-server tests above.
const { createAuthRuntime: legacyEntryRuntime } = require('./helpers/legacy-http-entry');
function entryTrace(factory, options = {}) {
  const trace = [];
  const failure = Object.assign(new Error('injected entry failure'), { code: 'ENTRY_TEST_FAILURE' });
  let calls = 0;
  const invoke = (name, value, fn) => {
    trace.push([name, value]);
    if (calls++ === options.failAt) throw failure;
    return fn?.();
  };
  const request = {
    method: options.method || 'GET', path: options.path || '/api/thing',
    originalUrl: options.originalUrl || `${options.path || '/api/thing'}?q=%E4%B8%AD`,
    headers: { accept: 'application/json', ...options.headers }, query: options.query || {},
    id: 'request-1', correlationId: 'correlation-1', secure: options.secure || false, body: options.body,
  };
  if (options.readonlyShare) Object.defineProperty(request, 'providerRelayShareId', { value: 'old', writable: false });
  const response = {
    type(value) { return invoke('type', value, () => response); },
    send(value) { return invoke('send', value, () => response); },
    end() { return invoke('end', null, () => response); },
    set(name, value) { return invoke('set', [name, value], () => response); },
    setHeader(name, value) { return invoke('setHeader', [name, value]); },
    status(value) { return invoke('status', value, () => {
      if (options.statusMutatesId) request.id = 'changed-after-status';
      return response;
    }); },
    json(value) { return invoke('json', value, () => 'responded'); },
    redirect(value) { return invoke('redirect', value, () => 'redirected'); },
  };
  const callbacks = [];
  const routes = {};
  const app = { use(...args) { callbacks.push(args.at(-1)); },
    get(path, ...args) { routes[`GET ${path}`] = args.at(-1); },
    post(path, ...args) { routes[`POST ${path}`] = args.at(-1); } };
  const deps = {
    express: { urlencoded: () => () => {}, json: () => () => {} },
    authSecurity: {
      createCookie: () => invoke('createCookie', null, () => 'fresh-cookie'),
      verifyCookie: value => invoke('verifyCookie', value, () => value === 'good-cookie'),
      verifyAccessToken: value => invoke('verifyToken', value, () => value === 'good-token'),
      issueWsTicket: (path, metadata) => invoke('ticket', [path, metadata], () => ({ ticket: 'fixed', path })),
    },
    isLocalRequest: () => invoke('local', null, () => options.local || false),
    parseCookies: value => invoke('cookies', value, () => ({ multicc_auth: value })),
    normalizeRedirect: value => invoke('normalize', value, () => value),
    escapeHtmlAttribute: value => invoke('escape', value, () => value),
    metrics: { inc: value => invoke('metric', value) },
    logger: { warn: (name, value) => invoke('warn', [name, value]) },
    createErrorDto: value => invoke('dto', value, () => ({ error: value })),
    getAccessToken: () => invoke('accessToken', null, () => options.token ?? 'configured'),
    getShuttingDown: () => invoke('shuttingDown', null, () => options.shutdown || false),
    isRequestPeerAllowed: () => invoke('peer', null, () => options.peer !== false),
    handleServiceRequest: () => invoke('service', null, () => options.service || false),
    authorizeProviderRelayRequest: value => invoke('relay', value, () => options.relay || null),
    authorizeScopedRequest: () => invoke('scope', null, () => {
      if (options.scopeMutatesPath) { request.path = '/after-scope'; request.method = 'GET'; }
      return options.scoped || false;
    }),
    allowLegacyTokenQuery: options.legacy || false,
  };
  const runtime = factory(deps);
  runtime.mountRoutes(app);
  let result, error;
  try {
    if (options.route) result = routes[options.route](request, response);
    else if (options.action === 'authenticated') result = runtime.isAuthenticated(request);
    else if (options.action === 'cookie') result = runtime.authCookieHeader(request, options.cookie);
    else result = callbacks[options.stage ?? 2](request, response, () => invoke('next', null, () => 'passed'));
  } catch (caught) { error = caught === failure ? 'injected' : caught?.name || String(caught); }
  return { trace, result, error, shareId: request.providerRelayShareId };
}
function compareEntry(options) {
  assert.deepEqual(entryTrace(createAuthRuntime, options), entryTrace(legacyEntryRuntime, options),
    JSON.stringify(options));
}

test('Rust entry matches Node across public paths, credentials, methods and all gate stages', t => {
  const nonce = 'a'.repeat(64);
  const paths = ['/api/thing', '/', '/login', '/logout', '/healthz', '/readyz',
    '/static/app.JS', '/static/app.jſ', '/api/app.js', '/API/app.js', '/x.js\n',
    '/share/secret', '/share/secret/extra', '/api/share/secret/history', '/api/share/secret/delete',
    '/fleet-share/fleet_share_abc', '/api/fleet-shares/fleet_share_abc/import',
    '/api/fleet-shares/fleet_share_abc/ws-ticket', '/artifacts/abc/a.html', '/artifacts/abc%2Fbad',
    '/api/wait/wait-1/resolve', '/api/wait/wait-1/resolve/extra', '/ios-ota/manifest.plist',
    `/ios-ota/udid/callback/${nonce}`, `/ios-ota/udid/callback/${nonce.toUpperCase()}`,
    `/ios-ota/udid/result/${nonce}`, '/claude-proxy/p/s/v1/messages', '/codex-proxy', '/codex-proxy-fake'];
  let count = 0;
  const cases = [{}, { local: true }, { token: '', local: false }, { token: '', local: true },
    { headers: { cookie: 'good-cookie' } }, { headers: { 'x-access-token': 'good-token' } },
    { headers: { 'x-multicc-machine-grant': 'bad', 'x-access-token': 'good-token' } },
    { query: { token: 'good-token' } }, { legacy: true, query: { token: 'good-token' } },
    { legacy: true, query: { token: ['good-token'] } }, { scoped: true }, { service: true },
    { headers: { accept: 'text/html' } }, { headers: { 'content-type': 'APPLICATION/PKCS7-SIGNATURE; version=1' } },
    { headers: { authorization: 'Bearer relay-token' }, relay: { ok: true, shareId: 'share-1' } },
    { headers: { authorization: 'Bearer\uFEFFrelay-token' }, relay: { ok: true } },
    { headers: { authorization: 'Bearer relay-token\n' }, relay: { ok: true } },
    { headers: { 'x-api-key': 'key', authorization: 'Bearer ignored' }, relay: { ok: 1 } }];
  for (const path of paths) for (const method of ['GET', 'POST', 'HEAD', 'OPTIONS']) for (const facts of cases) {
    compareEntry({ ...facts, path, method }); count += 1;
  }
  for (const stage of [0, 1]) for (const peer of [true, false]) for (const shutdown of [true, false]) {
    compareEntry({ stage, peer, shutdown, statusMutatesId: true }); count += 1;
  }
  t.diagnostic(`compared ${count} request-entry combinations`);
});

test('Rust entry preserves exception boundaries, side effects, reentry inputs and strict writes', () => {
  const scenarios = [{}, { scoped: true }, { scopeMutatesPath: true, method: 'POST' },
    { stage: 0, shutdown: true }, { stage: 1, peer: false }, { statusMutatesId: true },
    { path: '/page', query: { token: 'good-token' } },
    { legacy: true, query: { token: 'good-token' } },
    { action: 'authenticated', headers: { cookie: 'good-cookie' } },
    { action: 'authenticated', token: '', local: 'truthy-host-value' },
    { action: 'cookie', headers: { 'x-forwarded-proto': '\uFEFFhttps ,http' } },
    { action: 'cookie', cookie: 'custom', secure: true },
    { path: '/claude-proxy/p/s', headers: { 'x-api-key': 'share' }, relay: { ok: true, shareId: 'share-id' } },
    { path: '/claude-proxy/p/s', headers: { 'x-api-key': 'share' }, relay: { ok: true, shareId: 'share-id' }, readonlyShare: true }];
  for (const scenario of scenarios) {
    compareEntry(scenario);
    const count = entryTrace(legacyEntryRuntime, scenario).trace.length;
    for (let failAt = 0; failAt <= count + 2; failAt++) compareEntry({ ...scenario, failAt });
  }
  compareEntry({}); // caught exceptions must not poison the next native call
});

test('Rust entry preserves distinct implicit and explicit header coercion', () => {
  const values = [undefined, null, false, 0, 1, Symbol('header'), ['application/pkcs7-signature'],
    { toString() { return 'application/pkcs7-signature'; } },
    { toString() { throw new RangeError('coercion failed'); } }];
  for (const value of values) {
    compareEntry({ method: 'POST', path: `/ios-ota/udid/callback/${'a'.repeat(64)}`,
      headers: { 'content-type': value } });
    compareEntry({ action: 'cookie', cookie: value });
    compareEntry({ action: 'cookie', headers: { 'x-forwarded-proto': value } });
    compareEntry({ path: '/claude-proxy', headers: { authorization: value, 'x-api-key': value } });
  }
});

test('Rust auth endpoints preserve response bytes, callback order and every exception boundary', t => {
  const scenarios = [
    { route: 'GET /login' }, { route: 'GET /login', query: { error: 1, redirect: '/中文?x=1&y=2' } },
    { route: 'GET /logout' },
    { route: 'POST /login', body: { password: 'good-token', redirect: '/manage' }, secure: true },
    { route: 'POST /login', body: { password: 'bad', redirect: '/manage?x=中' } },
    { route: 'POST /login', body: null },
    { route: 'POST /api/auth/exchange', headers: { 'x-access-token': 'good-token' } },
    { route: 'POST /api/auth/exchange', token: '' },
    { route: 'POST /api/auth/exchange', headers: { 'x-access-token': 'bad' }, statusMutatesId: true },
    ...[undefined, null, {}, { path: '/chat' }, { path: false }, { path: ['chat'] }]
      .map(body => ({ route: 'POST /api/auth/ws-ticket', body })),
  ];
  let count = 0;
  for (const scenario of scenarios) {
    compareEntry(scenario); count++;
    const steps = entryTrace(legacyEntryRuntime, scenario).trace.length;
    for (let failAt = 0; failAt <= steps + 1; failAt++) {
      compareEntry({ ...scenario, failAt }); count++;
    }
  }
  t.diagnostic(`compared ${count} auth endpoint and injected-failure cases`);
});
