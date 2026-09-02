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
  let issuedDownloadTarget = null;
  const authSecurity = {
    createCookie: () => 'FRESHCOOKIE',
    verifyCookie: value => value === 'GOODCOOKIE',
    verifyAccessToken: value => value === 'sekret',
    issueWsTicket: (wsPath) => {
      if (wsPath === '/bad') throw new Error('invalid path');
      return { ticket: 'TICKET', path: wsPath };
    },
    issueDownloadTicket: (target) => {
      issuedDownloadTarget = target;
      return { ticket: 'DOWNLOAD_TICKET', expiresAt: 12345, target };
    },
    verifyDownloadTicket: (ticket, target) => {
      if (ticket !== 'DOWNLOAD_TICKET' || !issuedDownloadTarget) return false;
      const parsed = new URL(target, 'http://multicc.local');
      parsed.searchParams.delete('download_ticket');
      return `${parsed.pathname}?${parsed.searchParams.toString()}` === issuedDownloadTarget;
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
    assert.equal((await res.json()).error, 'Forbidden: not authenticated');

    res = await raw(h.base, '/dashboard', { headers: { accept: 'text/html' } });
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
      ['GET', `/fleet-share/fleet_share_${'a'.repeat(32)}`],
      ['POST', `/api/fleet-shares/fleet_share_${'b'.repeat(32)}/import`],
      ['POST', `/api/fleet-shares/fleet_share_${'c'.repeat(32)}/ws-ticket`],
      ['GET', '/artifacts/xY_9-artifactid/index.html'],
    ]) {
      const res = await raw(h.base, p, { method, headers: { accept: 'application/json' } });
      assert.equal(res.status, 200, `${method} ${p} should bypass auth`);
    }
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
    assert.equal((await res.json()).error, 'invalid WebSocket path');
  } finally { await h.close(); }
});

test('download-ticket: header-auth exchange opens only the bound download target', async () => {
  const h = await buildHarness({ accessToken: 'sekret', local: false });
  try {
    const issued = await raw(h.base, '/api/auth/download-ticket', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-access-token': 'sekret',
      },
      body: JSON.stringify({ path: '/tmp/report one.pdf', inline: true }),
    });
    assert.equal(issued.status, 200);
    assert.equal(issued.headers.get('cache-control'), 'no-store');
    const body = await issued.json();
    assert.equal(body.ticket, 'DOWNLOAD_TICKET');
    assert.equal(body.target, '/api/download?path=%2Ftmp%2Freport+one.pdf&inline=1');
    assert.equal(body.target.includes('sekret'), false);

    let opened = await raw(h.base, `${body.target}&download_ticket=${body.ticket}`, {
      headers: { accept: 'application/octet-stream' },
    });
    assert.equal(opened.status, 200);

    opened = await raw(h.base, `/api/download?path=${encodeURIComponent('/tmp/other.pdf')}&inline=1&download_ticket=${body.ticket}`, {
      headers: { accept: 'application/octet-stream' },
    });
    assert.equal(opened.status, 403);

    opened = await raw(h.base, `/api/download?path=${encodeURIComponent('/tmp/report one.pdf')}&inline=1&token=sekret`, {
      headers: { accept: 'application/octet-stream' },
    });
    assert.equal(opened.status, 403);
  } finally { await h.close(); }
});

test('download-ticket rejects missing paths and unauthenticated exchange', async () => {
  const h = await buildHarness({ accessToken: 'sekret', local: false });
  try {
    let res = await raw(h.base, '/api/auth/download-ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-access-token': 'sekret' },
      body: '{}',
    });
    assert.equal(res.status, 400);

    res = await raw(h.base, '/api/auth/download-ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/report.pdf' }),
    });
    assert.equal(res.status, 403);
  } finally { await h.close(); }
});

test('createAuthRuntime rejects missing dependencies', () => {
  assert.throws(() => createAuthRuntime({}), /express/);
});
