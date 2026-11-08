'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const legacy = require('./helpers/legacy-auth-security');
const native = require('../src/auth-security');

function harness(api, extra = {}) {
  const state = { time: 1_700_000_000_123, key: 'fixture-认证-key', random: 0, calls: [] };
  const auth = api.createAuthSecurity({
    getSecret() { state.calls.push('secret'); return state.key; },
    now() { state.calls.push('now'); return state.time; },
    randomBytes(size) { state.calls.push(`random:${size}`); return Buffer.alloc(size, ++state.random % 256); },
    ...extra,
  });
  return { state, auth };
}
function signed(body, key = 'fixture-认证-key') {
  return `${body}.${crypto.createHmac('sha256', key).update(body).digest('base64url')}`;
}

test('Rust authentication: cookie bytes, TTL boundaries and live key rotation match Node', () => {
  let checked = 0;
  for (const ttl of [0, -1, 999, 1000, 10_001, 2592000000]) {
    for (const time of [-1001, -1, 0, 999, 1_700_000_000_123]) {
      const a = harness(legacy, { cookieTtlMs: ttl });
      const b = harness(native, { cookieTtlMs: ttl });
      a.state.time = b.state.time = time;
      const cookie = a.auth.createCookie();
      assert.equal(b.auth.createCookie(), cookie);
      for (const delta of [-61_000, -60_000, 0, ttl - 1, ttl, ttl + 1000]) {
        a.state.time = b.state.time = time + delta;
        assert.equal(b.auth.verifyCookie(cookie), a.auth.verifyCookie(cookie));
        checked++;
      }
      for (const key of ['changed-key', '', null, 'fixture-认证-key']) {
        a.state.key = b.state.key = key;
        assert.equal(b.auth.verifyCookie(cookie), a.auth.verifyCookie(cookie));
      }
      assert.deepEqual(b.state.calls, a.state.calls);
    }
  }
  assert.equal(checked, 180);
});

test('Rust authentication: signed malformed claims and permissive base64 match Node', () => {
  const a = harness(legacy), b = harness(native);
  const claims = { v: 1, iat: 1_700_000_000, exp: 1_700_000_030, n: 'n' };
  const bodies = [null, false, [], 1, '', {}, claims,
    ...['v', 'iat', 'exp'].flatMap(key => [null, '1', true, [], {}, 1.5, -1, 1e100].map(value => ({ ...claims, [key]: value })))
  ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url'));
  bodies.push(Buffer.from('{"v":1,"v":2,"iat":1700000000,"exp":1700000030}').toString('base64url'),
    Buffer.from('{"v":1,"iat":1700000000,"exp":1e999}').toString('base64url'), Buffer.from('bad json').toString('base64url'),
    Buffer.from('{"v":1,"iat":1700000000,"exp":1700000030,"unused":1e999}').toString('base64url'));
  bodies.push(...[0x141, 0x13d, 0x100, 0x17a, 0xd841, 0xd83d, 0x1f600].map(code => String.fromCodePoint(code) + bodies[6]));
  for (const body of [...bodies, bodies[6] + '===', bodies[6].replace(/.{5}/g, '$&!\n')]) {
    const cookie = signed(body);
    assert.equal(b.auth.verifyCookie(cookie), a.auth.verifyCookie(cookie), body);
  }
  for (const cookie of [undefined, null, 1, [], {}, '', '.', 'a.b.c', 'a.', '.b', 'bad.signature', Symbol('cookie')]) {
    assert.equal(b.auth.verifyCookie(cookie), a.auth.verifyCookie(cookie));
  }
  assert.deepEqual(b.state.calls, a.state.calls);
});

test('Rust authentication: URL policy corpus and UTF-16 escaping match Node', () => {
  const paths = [undefined, null, false, 1, [], {}, Symbol('path'), '', '/', '/a?', '/a#', '/a?#',
    '/a/../b?x=1#y', '/%2e%2e/private', '/a//b', '/中文?x=甲#乙', '/\ud800', '/a\t?\tx',
    '/a\\b', '/\\evil.test', '//evil.test/a', '//multicc.local/a', 'http://multicc.local:80/a',
    'http://user:pass@multicc.local/a', 'http://MULTICC.local/a', 'https://multicc.local/a',
    'ws://multicc.local/a', 'javascript:alert(1)', 'a/b', '?x', '#y', '\n/a', '/a\0b',
    '/a%00b', '/a\r\nb', 'http://multicc.local./a', 'http://multicc.local:81/a'];
  for (const prefix of ['', '/', '//', '\t/', 'http://multicc.local/']) {
    for (const tail of ['x', '..', '%2e', '%2e%2e', 'a\\b', '?', '#', '?q=\'', '?#', 'a b', '\udfff']) paths.push(prefix + tail);
  }
  const fallback = { untouched: true };
  for (const value of paths) {
    assert.equal(native.normalizeWsPath(value), legacy.normalizeWsPath(value), String(value));
    assert.equal(native.normalizeRedirect(value, fallback), legacy.normalizeRedirect(value, fallback), String(value));
  }
  for (const value of [...paths, '&<>"\'\ud800', 12n, { toString: () => '&test' }]) {
    assert.equal(native.escapeHtmlAttribute(value), legacy.escapeHtmlAttribute(value));
  }
  for (const a of ['ascii', '认证', '\ud800', '\ufffd', '', null, 1, Symbol('s')]) {
    for (const b of ['ascii', '认证', '\ud800', '\ufffd', '', null, 1]) {
      assert.equal(native.timingSafeEqualText(a, b), legacy.timingSafeEqualText(a, b));
    }
  }
});

test('Rust authentication: ticket capacity, expiry, invalid scopes and reuse match Node', () => {
  for (const max of [1, 2, 5]) {
    const a = harness(legacy, { maxTickets: max, ticketTtlMs: 1000 });
    const b = harness(native, { maxTickets: max, ticketTtlMs: 1000 });
    const issued = [];
    for (let i = 0; i < 12; i++) {
      a.state.time += 200; b.state.time += 200;
      const path = i % 2 ? '/chat?foo=1' : '/voice';
      const left = a.auth.issueWsTicket(path, { number: i, path: 'overridden', expiresAt: 0 });
      assert.deepEqual(b.auth.issueWsTicket(path, { number: i, path: 'overridden', expiresAt: 0 }), left);
      issued.push(left);
      assert.equal(b.auth.ticketCount(), a.auth.ticketCount());
    }
    for (const ticket of issued) {
      for (const path of ['//evil.test', '/wrong', ticket.path]) {
        assert.deepEqual(b.auth.consumeWsTicket(ticket.ticket, path), a.auth.consumeWsTicket(ticket.ticket, path));
      }
    }
    a.auth.pruneTickets(); b.auth.pruneTickets();
    assert.equal(b.auth.ticketCount(), a.auth.ticketCount());
    assert.deepEqual(b.state.calls, a.state.calls);
  }
});

test('Rust authentication: duplicate random values replace without changing Map order', () => {
  function run(api) {
    let nonce = 0;
    const auth = api.createAuthSecurity({ getSecret: () => 's', now: () => 0, maxTickets: 3,
      randomBytes: size => Buffer.alloc(size, nonce) });
    const first = auth.issueWsTicket('/one');
    nonce = 1; auth.issueWsTicket('/two');
    nonce = 0; auth.issueWsTicket('/replacement');
    nonce = 2; auth.issueWsTicket('/three');
    nonce = 3; auth.issueWsTicket('/four');
    return [auth.ticketCount(), auth.consumeWsTicket(first.ticket, '/replacement')];
  }
  assert.deepEqual(run(native), run(legacy));
});

test('Rust authentication: metadata retains symbols, identity, getters and snapshot semantics', () => {
  for (const api of [legacy, native]) {
    const { auth } = harness(api);
    const nested = {}, symbol = Symbol('meta');
    const source = { nested, [symbol]: 3, get value() { return 4; } };
    Object.defineProperty(source, '__proto__', { enumerable: true, value: { fake: true } });
    const ticket = auth.issueWsTicket('/chat', source);
    source.nested = {}; source[symbol] = 10;
    const result = auth.consumeWsTicket(ticket.ticket, '/chat');
    assert.equal(result.nested, nested); assert.equal(result[symbol], 3);
    assert.equal(result.value, 4); assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.deepEqual(result.__proto__, { fake: true });
  }
});

test('Rust authentication: reentrant metadata/clock callbacks preserve mutation ordering', () => {
  function run(api) {
    let nonce = 0, auth, reenter = false, ticket;
    auth = api.createAuthSecurity({ getSecret: () => 's', maxTickets: 3,
      randomBytes: size => Buffer.alloc(size, ++nonce), now() {
        if (reenter) { reenter = false; assert.equal(auth.consumeWsTicket(ticket, '/chat'), null); }
        return 100;
      } });
    const issued = auth.issueWsTicket('/chat', { get nested() {
      return auth.issueWsTicket('/other').ticket;
    } });
    ticket = issued.ticket; reenter = true;
    return [auth.consumeWsTicket(ticket, '/chat'), auth.ticketCount()];
  }
  assert.deepEqual(run(native), run(legacy));
});

test('Rust authentication: callback errors propagate without retaining consumed tickets', () => {
  for (const api of [legacy, native]) {
    let fail = false;
    const error = new Error('clock failed');
    const { auth } = harness(api, { now() { if (fail) throw error; return 1; } });
    const issued = auth.issueWsTicket('/chat'); fail = true;
    assert.throws(() => auth.consumeWsTicket(issued.ticket, '/chat'), e => e === error);
    assert.equal(auth.ticketCount(), 0); fail = false;
    assert.throws(() => auth.issueWsTicket('/chat', { get x() { throw error; } }), e => e === error);
    assert.equal(auth.ticketCount(), 0);
    assert.throws(() => auth.issueWsTicket('https://evil.test/'), TypeError);
  }
});

test('Rust authentication: invalid capacity fails promptly instead of the old infinite prune loop', () => {
  for (const maxTickets of [0, -1, NaN, Infinity, 1.5, '3']) {
    assert.throws(() => native.createAuthSecurity({ getSecret: () => 's', maxTickets }), TypeError);
  }
  for (const cookieTtlMs of [NaN, Infinity, '30']) {
    assert.throws(() => native.createAuthSecurity({ getSecret: () => 's', cookieTtlMs }), TypeError);
  }
});

test('Rust authentication: flat issued claims work; excessive signed JSON nesting fails closed', () => {
  const raw = '{"v":1,"iat":1700000000,"exp":1700000030,"extra":' + '['.repeat(2001) + '0' + ']'.repeat(2001) + '}';
  const cookie = signed(Buffer.from(raw).toString('base64url'));
  assert.equal(harness(legacy).auth.verifyCookie(cookie), true);
  assert.equal(harness(native).auth.verifyCookie(cookie), false);
});

test('Rust authentication: VM collects runtime cycles through callbacks and ticket metadata', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const { createAuthSecurity } = require('./src/auth-security');
    const assert = require('node:assert/strict');
    (async () => {
      let weak;
      (() => {
        const owner = {};
        owner.auth = createAuthSecurity({ getSecret: () => owner.secret });
        owner.auth.issueWsTicket('/chat', { owner });
        weak = new WeakRef(owner);
      })();
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setImmediate(r)); global.gc();
      }
      assert.equal(weak.deref(), undefined);
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
});

test('Rust authentication: real HTTP login, cookie exchange and ticket endpoints match Node', async t => {
  const express = require('express');
  async function server(api, factory) {
    const { auth, state } = harness(api);
    state.key = 'fixture-http-key';
    const app = express();
    app.use((req, _res, next) => { req.id = 'rid'; req.correlationId = 'cid'; next(); });
    factory({ express, authSecurity: auth,
      isLocalRequest: () => false, isRequestPeerAllowed: () => true,
      parseCookies: header => Object.fromEntries(String(header || '').split(';').filter(Boolean)
        .map(pair => { const i = pair.indexOf('='); return [pair.slice(0, i).trim(), pair.slice(i + 1).trim()]; })),
      normalizeRedirect: api.normalizeRedirect, escapeHtmlAttribute: api.escapeHtmlAttribute,
      metrics: { inc() {} }, logger: { warn() {} }, createErrorDto: value => value,
      getAccessToken: () => 'fixture-http-key', getShuttingDown: () => false,
    }).mountRoutes(app);
    app.get('/api/private', (_req, res) => res.json({ allowed: true }));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ type: error.type || 'error' }));
    const http = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => new Promise(resolve => http.close(resolve)));
    return { base: `http://127.0.0.1:${http.address().port}`, auth };
  }
  const a = await server(legacy, require('./helpers/legacy-http-entry').createAuthRuntime);
  const b = await server(native, require('../src/routes/auth').createAuthRuntime);
  const cookie = a.auth.createCookie(); assert.equal(b.auth.createCookie(), cookie);
  const cases = [
    ['GET', '/login'], ['HEAD', '/LOGIN/'], ['OPTIONS', '/login'],
    ['GET', '/login?error=1&redirect=%2F%22%3E%3Cx%3E'], ['GET', '/logout'],
    ['POST', '/login', 'password=bad&redirect=%2Fmanage', 'application/x-www-form-urlencoded'],
    ['POST', '/login', 'password=fixture-http-key&redirect=%2Fmanage', 'application/x-www-form-urlencoded'],
    ['POST', '/login', 'password=fixture-http-key&redirect=%2F%2Fevil.test', 'application/x-www-form-urlencoded'],
    ['POST', '/api/auth/exchange'], ['GET', '/api/private'],
    ['POST', '/api/auth/ws-ticket', '{"path":"/chat?x=1"}', 'application/json'],
    ['POST', '/api/auth/ws-ticket', '{"path":"https://evil.test"}', 'application/json'],
    ['POST', '/api/auth/ws-ticket', 'null', 'application/json'],
    ['POST', '/api/auth/ws-ticket', '{broken', 'application/json'],
    ['POST', '/api/auth/ws-ticket', JSON.stringify({ path: '/' + 'x'.repeat(4096) }), 'application/json'],
  ];
  let checked = 0;
  for (const [method, path, body, type] of cases) {
    for (const authenticated of [false, true]) {
      const headers = { accept: 'application/json', 'x-forwarded-proto': 'https' };
      if (type) headers['content-type'] = type;
      if (authenticated) { headers.cookie = `multicc_auth=${cookie}`; headers['x-access-token'] = 'fixture-http-key'; }
      const responses = [];
      for (const target of [a, b]) {
        const response = await fetch(target.base + path, { method, body, headers, redirect: 'manual' });
        responses.push({ status: response.status, body: await response.text(),
          headers: Object.fromEntries(['content-type', 'content-length', 'location', 'set-cookie', 'etag', 'cache-control', 'allow']
            .map(name => [name, response.headers.get(name)])) });
      }
      assert.deepEqual(responses[1], responses[0], `${method} ${path} ${authenticated}`);
      checked++;
    }
  }
  t.diagnostic(`compared ${checked} complete HTTP responses`);
});
