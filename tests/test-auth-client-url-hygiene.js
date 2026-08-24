'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { multiccTokenFreeRelativeUrl } = require('../public/auth-client');

const ROOT = path.join(__dirname, '..');
const AUTH_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'auth-client.js'), 'utf8');

function createHarness(href, { exchangeOk = true } = {}) {
  const requests = [];
  const replacements = [];
  const logs = [];
  const location = {};

  function setLocation(next) {
    const url = new URL(next, location.href || href);
    location.href = url.href;
    location.origin = url.origin;
    location.pathname = url.pathname;
    location.search = url.search;
    location.hash = url.hash;
  }
  setLocation(href);

  const history = {
    state: { keep: true },
    replaceState(state, _title, next) {
      replacements.push({ state, next });
      setLocation(next);
    },
  };

  async function nativeFetch(input, init = {}) {
    const url = input instanceof Request ? input.url : String(input);
    const sourceHeaders = input instanceof Request ? input.headers : init.headers;
    const headers = Object.fromEntries(new Headers(sourceHeaders || {}).entries());
    requests.push({ url, method: init.method || 'GET', headers, body: init.body || '' });
    if (url === '/api/auth/exchange') return { ok: exchangeOk, status: exchangeOk ? 204 : 401 };
    if (url === '/api/auth/ws-ticket') {
      return { ok: true, status: 200, json: async () => ({ ticket: 'once-ticket' }) };
    }
    if (/^\/api\/external-fleets\/[^/]+\/ws-ticket$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ ticket: 'remote-ticket', wsOrigin: 'wss://source.lan:3443' }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }

  const window = { fetch: nativeFetch, location, history };
  const context = {
    window,
    location,
    history,
    URL,
    URLSearchParams,
    Headers,
    Request,
    console: { warn: (...args) => logs.push(args.map(String).join(' ')) },
  };
  vm.runInNewContext(AUTH_SOURCE, context, { filename: 'auth-client.js' });
  return { window, location, requests, replacements, logs };
}

function assertNoTokenInRequestSurfaces(requests, secret) {
  const encoded = encodeURIComponent(secret);
  for (const request of requests) {
    assert.equal(request.url.includes(secret), false, `token leaked in URL: ${request.url}`);
    assert.equal(request.url.includes(encoded), false, `encoded token leaked in URL: ${request.url}`);
    assert.equal(String(request.body).includes(secret), false, 'token leaked in request body');
  }
}

test('token-free URL helper preserves other query parameters and hash', () => {
  assert.equal(
    multiccTokenFreeRelativeUrl(
      'https://multicc.test/wechat.html?focus=bridge&token=s%40cr%2Fet&mode=full#login',
    ),
    '/wechat.html?focus=bridge&mode=full#login',
  );
  assert.equal(
    multiccTokenFreeRelativeUrl('https://multicc.test/memo.html?dirId=d1#note'),
    '/memo.html?dirId=d1#note',
  );
  assert.equal(
    multiccTokenFreeRelativeUrl('https://multicc.test/memo.html?token=a&token=b&dirId=d1'),
    '/memo.html?dirId=d1',
  );
});

test('legacy encoded token is synchronously scrubbed and exchanged only by same-origin header', async () => {
  const secret = 's@cr/et';
  const h = createHarness(
    'https://multicc.test/wechat.html?focus=bridge&token=s%40cr%2Fet&mode=full#login',
  );

  assert.deepEqual(h.replacements.map(item => item.next), [
    '/wechat.html?focus=bridge&mode=full#login',
  ]);
  assert.equal(h.location.search, '?focus=bridge&mode=full');
  assert.equal(h.location.hash, '#login');

  await h.window.fetch('https://outside.test/collect?mode=probe');
  await h.window.multiccAuthReady;
  await h.window.fetch('/api/wechat/status?mode=full');
  const wsUrl = await h.window.multiccWsUrl(
    'wss://multicc.test/ws/chat?session=s1&token=must-not-survive#stream',
  );

  const exchange = h.requests.find(request => request.url === '/api/auth/exchange');
  const outside = h.requests.find(request => request.url.startsWith('https://outside.test/'));
  const status = h.requests.find(request => request.url === '/api/wechat/status?mode=full');
  const ticket = h.requests.find(request => request.url === '/api/auth/ws-ticket');
  assert.equal(exchange.headers['x-access-token'], secret);
  assert.equal(outside.headers['x-access-token'], undefined);
  assert.equal(status.headers['x-access-token'], undefined, 'cookie exchange should retire the header token');
  assert.deepEqual(JSON.parse(ticket.body), { path: '/ws/chat' });
  assert.equal(wsUrl, 'wss://multicc.test/ws/chat?session=s1&ticket=once-ticket#stream');
  assertNoTokenInRequestSurfaces(h.requests, secret);
  assert.equal(h.logs.join('\n').includes(secret), false);
});

test('failed exchange still leaves retries, logs and address free of token URLs', async () => {
  const secret = 'retry-secret';
  const h = createHarness(
    `https://multicc.test/memo.html?token=${encodeURIComponent(secret)}&dirId=d1#note`,
    { exchangeOk: false },
  );

  assert.equal(h.replacements[0].next, '/memo.html?dirId=d1#note');
  await h.window.multiccAuthReady;
  await h.window.fetch('/api/directories/d1/memo?retry=1');

  const retry = h.requests.find(request => request.url === '/api/directories/d1/memo?retry=1');
  assert.equal(retry.headers['x-access-token'], secret, 'failed bootstrap keeps only the same-origin header fallback');
  assertNoTokenInRequestSurfaces(h.requests, secret);
  assert.equal(h.logs.join('\n').includes(secret), false);
  assert.equal(JSON.stringify(h.replacements).includes(secret), false);
});

test('loopback without authentication keeps the URL and requests untouched', async () => {
  const h = createHarness('http://127.0.0.1:3000/memo.html?dirId=d1#note');
  assert.equal(h.replacements.length, 0);
  await h.window.multiccAuthReady;
  await h.window.fetch('/api/directories/d1/memo');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].headers['x-access-token'], undefined);
  assert.equal(h.location.href, 'http://127.0.0.1:3000/memo.html?dirId=d1#note');
});

test('external Fleet pages proxy REST through the target and bind WebSocket tickets to the source', async () => {
  const h = createHarness('https://target.test/chat.html?session=remote-chat&external=external-1');
  await h.window.multiccAuthReady;
  await h.window.fetch('/api/sessions/remote-chat/history?limit=10');
  const wsUrl = await h.window.multiccWsUrl('wss://target.test/ws/chat?session=remote-chat');

  assert.equal(h.requests[0].url,
    'https://target.test/api/external-fleets/external-1/remote/api/sessions/remote-chat/history?limit=10');
  const ticket = h.requests.find(request => request.url === '/api/external-fleets/external-1/ws-ticket');
  assert.deepEqual(JSON.parse(ticket.body), {
    pathname: '/ws/chat', sessionId: 'remote-chat', directoryId: '',
  });
  assert.equal(wsUrl, 'wss://source.lan:3443/ws/chat?session=remote-chat&ticket=remote-ticket');
});

test('Memo and WeChat load auth first and never construct long-token request URLs', () => {
  const memo = fs.readFileSync(path.join(ROOT, 'public', 'memo.html'), 'utf8');
  const wechat = fs.readFileSync(path.join(ROOT, 'public', 'wechat.html'), 'utf8');
  const wechatJs = fs.readFileSync(path.join(ROOT, 'public', 'wechat.js'), 'utf8');

  for (const [name, source] of [['memo.html', memo], ['wechat.html', wechat]]) {
    const authIndex = source.indexOf('<script src="auth-client.js"></script>');
    assert.ok(authIndex > 0, `${name} must load auth-client`);
    assert.ok(authIndex < source.indexOf('</head>'), `${name} must bootstrap auth in <head>`);
  }
  assert.ok(wechat.indexOf('auth-client.js') < wechat.indexOf('wechat.js'));
  assert.doesNotMatch(memo, /tokenQS|urlToken|[?&]token=/);
  assert.doesNotMatch(wechatJs, /tokenQS|_urlToken|location\.search|[?&]token=/);
  assert.match(wechatJs, /new EventSource\('\/api\/wechat\/events'\)/);
  assert.match(AUTH_SOURCE, /url\.searchParams\.delete\('token'\)/);
  assert.match(AUTH_SOURCE, /url\.searchParams\.set\('ticket', data\.ticket\)/);
});
