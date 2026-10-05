'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { WebSocket, WebSocketServer } = require('ws');
const { createServiceRoutes } = require('../src/service-routes');
const { createAuthRuntime } = require('../src/routes/auth');
const { wireUpgrade } = require('../src/routes/voice-gateway-proxy');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port)));

test('service routing: real auth boundary, streaming HTTP, persistence and WebSocket', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-service-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/base/redirect') { res.writeHead(302, { location: '/base/landing', 'set-cookie': ['app=1; Path=/; Domain=localhost', 'multicc_auth=bad; Path=/'] }); res.end(); return; }
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ url: req.url, headers: req.headers, body })); });
  });
  const upstreamWs = new WebSocketServer({ server: upstream });
  upstreamWs.on('connection', ws => ws.on('message', data => ws.send(data)));
  const target = await listen(upstream);
  t.after(() => { upstreamWs.clients.forEach(ws => ws.terminate()); upstreamWs.close(); upstream.closeAllConnections(); upstream.close(); });
  const app = express();
  let peer = true;
  const file = path.join(dir, 'routes.json');
  const routes = createServiceRoutes({ file, authenticate: req => auth.isAuthenticated(req), peerAllowed: () => peer });
  const auth = createAuthRuntime({ express,
    authSecurity: { createCookie: () => 'good', verifyCookie: v => v === 'good', verifyAccessToken: v => v === 'secret', issueWsTicket: () => ({}), issueDownloadTicket: () => ({}), verifyDownloadTicket: () => false },
    isLocalRequest: () => false, parseCookies: raw => Object.fromEntries(String(raw || '').split(';').map(x => x.trim().split('='))),
    normalizeRedirect: x => x || '/', escapeHtmlAttribute: x => x, metrics: { inc() {} }, logger: { warn() {} },
    createErrorDto: x => x, getAccessToken: () => 'secret', getShuttingDown: () => false,
    isRequestPeerAllowed: () => peer, handleServiceRequest: routes.handleHttp,
  });
  auth.mountRoutes(app); app.use(express.json()); routes.mountManagement(app);
  const server = http.createServer(app); wireUpgrade(server, null, null, routes);
  const base = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = (url, options = {}) => fetch(base + url, { redirect: 'manual', ...options });
  const put = (name, data) => request('/api/service-routes/' + name, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-access-token': 'secret' }, body: JSON.stringify(data) });
  await t.test('default private; public requires explicit acknowledgement; reject invalid targets', async () => {
    assert.equal((await put('app', { target: target + '/base' })).status, 200);
    assert.equal((await put('open', { target, access: 'public' })).status, 400);
    assert.equal((await put('bad', { target: 'file:///etc/passwd' })).status, 400);
    assert.equal((await put('bad', { target: 'https://user:pass@example.com' })).status, 400);
    assert.equal((await put('open', { target, access: 'public', acknowledgePublicRisk: true })).status, 200);
  });
  await t.test('private static extensions cannot bypass auth; login return URL; public works', async () => {
    for (const suffix of ['page.js', 'api.json', 'asset.png']) assert.equal((await request('/services/app/' + suffix, { headers: { accept: 'application/json' } })).status, 401);
    assert.equal((await request('/services/app/', { headers: { 'x-access-token': 'secret', origin: 'https://evil.example', accept: 'application/json' } })).status, 401);
    const login = await request('/services/app/', { headers: { accept: 'text/html' } });
    assert.equal(login.status, 302); assert.equal(login.headers.get('location'), '/login?redirect=%2Fservices%2Fapp%2F');
    assert.equal((await request('/services/open/')).status, 200);
    assert.equal((await request('/services/missing/file.js')).status, 404);
    assert.notEqual((await request('/api/service-routes')).status, 200);
  });
  await t.test('raw uploads, paths, queries and credential removal; scoped response cookies and redirects', async () => {
    const response = await request('/services/app/upload?q=one%20two', { method: 'POST', headers: { 'x-access-token': 'secret', cookie: 'multicc_auth=good; app=2', 'x-multicc-fleet-token': 'hidden', 'content-type': 'application/octet-stream' }, body: 'raw\u0000payload' });
    assert.equal(response.status, 200);
    const data = await response.json(); assert.equal(data.url, '/base/upload?q=one%20two'); assert.equal(data.body, 'raw\u0000payload');
    assert.equal(data.headers.cookie, 'app=2'); assert.equal(data.headers['x-access-token'], undefined); assert.equal(data.headers['x-multicc-fleet-token'], undefined);
    const redirect = await request('/services/app/redirect', { headers: { cookie: 'multicc_auth=good' } });
    assert.equal(redirect.headers.get('location'), '/services/app/landing');
    assert.deepEqual(redirect.headers.getSetCookie(), ['app=1; Path=/services/app/']);
    assert.equal(redirect.headers.get('cache-control'), 'no-store');
  });
  await t.test('public route cannot bypass network policy, loop guard, cross-origin management writes', async () => {
    peer = false; assert.equal((await request('/services/open/')).status, 403); peer = true;
    assert.equal((await request('/services/open/', { headers: { 'x-multicc-service-hop': '1' } })).status, 508);
    assert.equal((await request('/api/service-routes/app', { method: 'DELETE', headers: { 'x-access-token': 'secret', origin: 'https://evil.example' } })).status, 403);
  });
  await t.test('WebSocket auth and bidirectional forwarding', async () => {
    const wsUrl = base.replace('http:', 'ws:');
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl + '/services/app/socket'); ws.on('error', reject);
      ws.on('unexpected-response', (_, res) => { assert.equal(res.statusCode, 401); res.resume(); ws.terminate(); resolve(); }); ws.on('error', () => {});
    }).catch(err => { if (!/before the connection was established/.test(err.message)) throw err; });
    for (const name of ['app', 'open']) await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl + '/services/' + name + '/socket', { headers: name === 'app' ? { cookie: 'multicc_auth=good' } : {} });
      ws.on('error', reject); ws.on('open', () => ws.send('hello')); ws.on('message', data => { assert.equal(data.toString(), 'hello'); ws.close(); }); ws.on('close', resolve);
    });
  });
  await t.test('disabled routes, save/reload and unavailable upstream', async () => {
    await put('app', { target, enabled: false }); assert.equal((await request('/services/app/')).status, 404);
    const restored = createServiceRoutes({ file, authenticate: () => true }); assert.ok(restored);
    assert.equal(JSON.parse(fs.readFileSync(file))[1].enabled, false);
    const temporary = http.createServer(); const dead = await listen(temporary); await new Promise(resolve => temporary.close(resolve));
    await put('dead', { target: dead, access: 'public', acknowledgePublicRisk: true }); assert.equal((await request('/services/dead/')).status, 502);
    fs.writeFileSync(file, '{broken'); assert.throws(() => createServiceRoutes({ file, authenticate: () => true }));
  });
});
