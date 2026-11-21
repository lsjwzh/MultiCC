'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const express = require('express');
const { WebSocket, WebSocketServer } = require('ws');
const { createAuthSecurity } = require('../src/auth-security');
const { createAuthRuntime } = require('../src/routes/auth');
const { createMachineRuntime } = require('../src/machines');
const { mountWsConnectionRouter } = require('../src/ws/connection-router');
let addon = null;
try { addon = require('../src/native/runtime').getNative(); } catch (_) { /* availability is asserted below */ }
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

// Machine WebSockets are terminated by the Rust front door. Keep the real
// pairing and grant store above, and redeem the bridge ticket through the same
// native auth control used by that front door instead of the retired Node path.
async function machineGateway(t) {
  const addonPath = process.env.MULTICC_RUST_ADDON || path.join(
    process.env.MULTICC_RUST_PREBUILT_DIR || path.resolve(__dirname, '../native/prebuilt'),
    `${process.platform}-${process.arch}`, 'multicc_core.node');
  const binary = path.join(path.dirname(addonPath), process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway');
  assert.ok(fs.existsSync(binary), 'machine WebSocket test requires the Rust gateway');
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-machines-gateway-'));
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1',
    MULTICC_ENV_FILE: path.join(root, '.env'), MULTICC_DATA_DIR: root,
    MULTICC_GATEWAY_BACKOFF_SCALE: '0.01', MULTICC_RUST_ADDON: addonPath };
  for (const key of Object.keys(env)) {
    if (key.startsWith('MULTICC_GATEWAY_') && key !== 'MULTICC_GATEWAY_BACKOFF_SCALE') delete env[key];
  }
  const child = spawn(binary, ['serve', '--cwd', root, '--node', process.execPath, '--stdin-lifeline', '--',
    path.join(__dirname, 'helpers/gateway-auth-child.js')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGINT'); await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(origin + '/fixture/state')).ok) return { origin }; } catch (_) { /* starting */ }
    if (child.exitCode !== null) throw new Error(`machine gateway exited: ${diagnostics}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`machine gateway did not start: ${diagnostics}`);
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
  const upstream = await a.runtime.operate('websocket', { id, path: '/ws/meta?probe=1' });
  assert.equal(upstream.status, 200);
  const gateway = await machineGateway(t);
  const admission = await fetch(gateway.origin + '/fixture/issue-machine', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ machineId: id, ...upstream.data }) });
  assert.equal(admission.status, 200);
  const ticket = await admission.json();
  const ws = new WebSocket(`${gateway.origin.replace('http:', 'ws:')}${issued.body.proxyPath}?ticket=${ticket.ticket}`);
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
