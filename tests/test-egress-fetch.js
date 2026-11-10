'use strict';

// 官方账号登录换码的出口：绑定存在时必须从插件身份出去，解不出出口就失败，
// 绝不回落到宿主直连（否则账号会在默认 IP 上完成注册）。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createEgressFetch, createAccountEgressFetch } = require('../src/network/egress-fetch');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

test('createEgressFetch sends the request through the given proxy', async (t) => {
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push({ url: req.url, method: req.method });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const proxyUrl = await listen(proxy);
  t.after(() => new Promise((resolve) => proxy.close(resolve)));

  const fetchImpl = createEgressFetch(proxyUrl);
  const res = await fetchImpl('http://auth.example.test/v1/oauth/token', { method: 'POST', body: '{}' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(seen, [{ url: 'http://auth.example.test/v1/oauth/token', method: 'POST' }],
    'an http proxy sees the absolute request target, proving the dial left through it');
});

test('a bound account gets an egress fetch, an unbound one keeps the host fetch', async () => {
  const used = [];
  const providers = {
    getProvider: (type, id) => (id === 'claude-official-aaaaaaaaaaaaaaaa'
      ? { id, appType: type, egressBinding: { pluginId: 'chrome-proxy-launcher', profileId: 'us-home' } }
      : null),
  };
  const fetchFor = createAccountEgressFetch({
    providers,
    appType: 'claude',
    providerIdForAccount: (type, accountId) => `${type}-official-${accountId}`,
    resolveProxyUrl: async () => { used.push('resolved'); return 'http://127.0.0.1:7890'; },
  });
  assert.equal(typeof await fetchFor('aaaaaaaaaaaaaaaa'), 'function');
  assert.equal(typeof await fetchFor('aaaaaaaaaaaaaaaa'), 'function');
  assert.equal(used.length, 2, 'one resolution per call, and only for bound accounts');
  assert.equal(await fetchFor('bbbbbbbbbbbbbbbb'), null, 'no binding → caller keeps the host policy');
});

test('an unresolvable egress fails the login instead of dialing direct', async () => {
  const fetchFor = createAccountEgressFetch({
    providers: { getProvider: () => ({ egressBinding: { pluginId: 'chrome-proxy-launcher', profileId: 'gone' } }) },
    appType: 'codex',
    providerIdForAccount: () => 'codex-official-aaaaaaaaaaaaaaaa',
    resolveProxyUrl: async () => { throw new Error('专用出口不可用：插件没装'); },
  });
  await assert.rejects(fetchFor('aaaaaaaaaaaaaaaa'), /专用出口不可用/);
});
