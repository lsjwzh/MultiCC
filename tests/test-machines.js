'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const { WebSocket, WebSocketServer } = require('ws');
const { createAuthSecurity } = require('../src/auth-security');
const { createAuthRuntime } = require('../src/routes/auth');
const { createMachineRuntime } = require('../src/machines');
const { mountWsConnectionRouter } = require('../src/ws/connection-router');
const addon = require('../src/native/runtime').getNative('machines', process.env.MULTICC_REQUIRE_RUST_TESTS === '1' ? 'rust' : 'auto');
const hasNative = typeof addon?.machineEventStream === 'function';
if (!hasNative && process.env.MULTICC_REQUIRE_RUST_TESTS === '1') throw new Error('machine_native_unavailable');

async function instance(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-machines-'));
  const app = express(), server = http.createServer(app), wss = new WebSocketServer({ server });
  const authSecurity = createAuthSecurity({ getSecret: () => 'fixture-access-password' });
  const runtime = createMachineRuntime({ root, authSecurity, getWss: () => wss });
  const metrics = { inc() {}, set() {} }, logger = { info() {}, warn() {} };
  createAuthRuntime({ express, authSecurity, isLocalRequest: () => true, parseCookies: () => ({}),
    normalizeRedirect: x => x || '/', escapeHtmlAttribute: String, metrics, logger, createErrorDto: x => x,
    getAccessToken: () => 'fixture-access-password', getShuttingDown: () => false,
    authorizeScopedRequest: runtime.authorize,
  }).mountRoutes(app);
  runtime.mount(app, express);
  let value = name;
  app.get('/api/value', (_req, res) => res.json({ value }));
  app.put('/api/value', express.json(), (req, res) => { value = req.body.value; res.json({ value }); });
  app.post('/api/upload', express.raw({ type: () => true }), (req, res) => res.type(req.headers['content-type']).send(req.body));
  let streamFinished = false;
  app.get('/api/events', (_req, res) => {
    res.type('text/event-stream'); res.write('data: first\n\n');
    setTimeout(() => { streamFinished = true; res.end('data: last\n\n'); }, 300);
  });
  mountWsConnectionRouter(wss, { metrics, logger, authSecurity, machines: runtime, share: { access: () => null },
    parseCookies: () => ({}), isLocalRequest: () => true, getShuttingDown: () => false,
    getAccessToken: () => 'fixture-access-password', persistedSessions: new Map(),
    workspaceRuntime: { attachMeta: ws => ws.on('message', data => ws.send(data)) },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => server.close(resolve)); wss.close(); fs.rmSync(root, { recursive: true }); });
  async function request(endpoint, method = 'GET', body, headers = {}) {
    const response = await fetch(origin + endpoint, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  return { origin, request, runtime, root, server, streamFinished: () => streamFinished };
}

test('two computers isolate writes, proxy raw uploads, bridge sockets and revoke access', { timeout: 30000, skip: !hasNative }, async t => {
  const a = await instance(t, 'entry'), b = await instance(t, 'target');
  const rejected = await a.request('/api/machines', 'POST', { name: '电脑乙', origin: b.origin, password: 'wrong' });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.body.code, 'machine_password_invalid');
  const added = await a.request('/api/machines', 'POST', { name: '电脑乙', origin: b.origin, password: 'fixture-access-password' });
  assert.equal(added.status, 200);
  const id = added.body.id, proxy = `/api/machines/${id}/proxy`;
  const crossSite = await a.request('/api/machines', 'GET', undefined, { 'sec-fetch-site': 'cross-site' });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.body.code, 'machine_cross_site_denied');
  assert.equal((await a.request(proxy + '/api/value', 'GET', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await a.request('/api/machines', 'GET', undefined, { 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await a.request(proxy + '/api/value')).body.value, 'target');
  await a.request(proxy + '/api/value', 'PUT', { value: 'changed remotely' });
  assert.equal((await b.request('/api/value')).body.value, 'changed remotely');
  assert.equal((await a.request('/api/value')).body.value, 'entry');
  const listed = await a.request('/api/machines');
  assert.doesNotMatch(JSON.stringify(listed.body), /mcg_|fixture-access-password/);
  const upload = Buffer.from([0, 1, 2, 255, 128]);
  const uploaded = await fetch(a.origin + proxy + '/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: upload });
  assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), upload);
  const stream = await fetch(a.origin + proxy + '/api/events', { headers: { Accept: 'text/event-stream' } });
  const reader = stream.body.getReader();
  assert.match(Buffer.from((await reader.read()).value).toString(), /first/);
  assert.equal(b.streamFinished(), false, 'SSE must arrive before the upstream response ends');
  while (!(await reader.read()).done) { /* consume the bounded fixture stream */ }
  assert.equal((await a.request(proxy + '/api/machines', 'GET')).status, 403);
  assert.equal((await b.request('/api/value', 'GET', undefined, { 'x-multicc-machine-grant': 'mcg_invalid' })).status, 403, 'invalid grants cannot inherit loopback authority');
  const issued = await a.request(`/api/machines/${id}/ws-ticket`, 'POST', { path: '/ws/meta?probe=1' });
  assert.equal(issued.status, 200);
  assert.equal(issued.body.path, '/ws/meta');
  const ws = new WebSocket(`${a.origin.replace('http:', 'ws:')}${issued.body.proxyPath}?ticket=${issued.body.ticket}`);
  const opened = once(ws, 'open'); ws.on('error', () => {}); await opened;
  const echoed = once(ws, 'message'); ws.send('电脑实时连接'); assert.equal((await echoed)[0].toString(), '电脑实时连接');
  const closed = once(ws, 'close');
  const grants = (await b.request('/api/machines/grants')).body.grants;
  await b.request(`/api/machines/grants/${grants[0].id}`, 'DELETE');
  assert.equal((await closed)[0], 4003);
  assert.equal((await a.request(proxy + '/api/value')).status, 403);
  const reconnect = await a.request('/api/machines', 'POST', { name: '电脑乙', origin: b.origin, password: 'fixture-access-password' });
  assert.equal(reconnect.body.id, id);
  assert.equal((await a.request('/api/machines')).body.machines.length, 1);
  assert.equal((await a.request(`/api/machines/${id}`, 'DELETE')).body.remoteRevoked, true);
  assert.equal((await b.request('/api/machines/grants')).body.grants.length, 0);
  assert.equal((await a.request(proxy + '/api/value')).status, 404);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(a.root, 'machines.json')).mode & 0o777, 0o600);
});

test('offline computers never fall back locally and reconnect verifies identity', { timeout: 20000, skip: !hasNative }, async t => {
  const a = await instance(t, 'entry'), b = await instance(t, 'target');
  const added = await a.request('/api/machines', 'POST', { name: '电脑乙', origin: b.origin, password: 'fixture-access-password' });
  const wrong = await a.request('/api/machines', 'POST', { name: '电脑乙', origin: b.origin, password: 'fixture-access-password', expectedId: 'machine_another' });
  assert.equal(wrong.status, 409);
  assert.equal((await b.request('/api/machines/grants')).body.grants.length, 1);
  await new Promise(resolve => b.server.close(resolve));
  assert.equal((await a.request(`/api/machines/${added.body.id}/proxy/api/value`, 'PUT', { value: 'must not write locally' })).status, 502);
  assert.equal((await a.request('/api/value')).body.value, 'entry');
  assert.equal((await a.request(`/api/machines/${added.body.id}`, 'DELETE')).body.remoteRevoked, false);
});

test('unsupported native component fails closed with an actionable error', async () => {
  const original = process.env.MULTICC_RUST_ADDON;
  process.env.MULTICC_RUST_ADDON = '/missing/multicc-machines.node';
  try {
    const runtime = createMachineRuntime({ root: '/tmp', authSecurity: {} });
    assert.equal((await runtime.operate('list')).status, 503);
    assert.equal(runtime.authorize({ headers: { 'x-multicc-machine-grant': 'mcg_invalid' }, method: 'GET', originalUrl: '/api/value' }), false);
  } finally { if (original) process.env.MULTICC_RUST_ADDON = original; else delete process.env.MULTICC_RUST_ADDON; }
});
