'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const addonPath = process.env.MULTICC_RUST_ADDON || path.join(process.env.MULTICC_RUST_PREBUILT_DIR || path.resolve(__dirname, '../native/prebuilt'), `${process.platform}-${process.arch}`, 'multicc_core.node');
const binary = path.join(path.dirname(addonPath), process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway');
const fixture = path.resolve(__dirname, 'helpers/gateway-auth-child.js');
const delay = ms => new Promise(r => setTimeout(r, ms));
const auth = { 'x-access-token': 'fixture-token' };
const remote = { host: 'fixture.example', 'x-request-id': 'service-test', 'x-correlation-id': 'correlation-test' };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port)));
function request(port, method, url, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { ...remote, ...headers, 'content-length': bytes.length }, timeout: 5000 }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout: ${method} ${url}`))); req.on('error', reject); req.end(bytes);
  });
}
async function start(t, native, extraEnv = {}, stored) {
  const portProbe = net.createServer(); await listen(portProbe); const port = portProbe.address().port; await new Promise(r => portProbe.close(r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-service-native-'));
  if (stored !== undefined) fs.writeFileSync(path.join(dir, 'service-routes.json'), stored);
  const env = { ...process.env, ...extraEnv, PORT: String(port), HOST: '127.0.0.1', MULTICC_DATA_DIR: dir, MULTICC_ENV_FILE: path.join(dir, '.env'), MULTICC_RUST_ADDON: addonPath, MULTICC_TEST_SERVICE_ROUTES: '1' };
  for (const key of Object.keys(env)) if (key.startsWith('MULTICC_GATEWAY_')) delete env[key];
  const child = spawn(native ? binary : process.execPath, native ? ['serve', '--cwd', dir, '--node', process.execPath, '--stdin-lifeline', '--', fixture] : [fixture], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  async function stop() { if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); const timer = setTimeout(() => child.kill('SIGKILL'), 3000); child.kill('SIGINT'); try { await done; } finally { clearTimeout(timer); } } }
  t.after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let n = 0; n < 150; n++) {
    if (child.exitCode !== null) return { port, dir, child, logs, stop, failed: true };
    try { if ((await request(port, 'GET', '/fixture/state')).status === 200) return { port, dir, child, stop }; } catch {}
    await delay(20);
  }
  throw new Error(`fixture failed to start: ${logs}`);
}
function normalize(result) {
  const headers = { ...result.headers };
  for (const key of ['date', 'connection', 'keep-alive', 'transfer-encoding']) delete headers[key];
  if (headers['set-cookie']?.[0].startsWith('multicc_auth=ey')) headers['set-cookie'] = headers['set-cookie'].map(c => c.replace(/^multicc_auth=[^;]+/, 'multicc_auth=<signed>'));
  let body = result.body;
  try {
    const value = JSON.parse(body);
    if (value.headers) { delete value.headers.connection; delete value.headers['transfer-encoding']; body = value; delete headers['content-length']; }
  } catch {}
  return { status: result.status, headers, body };
}
function wsEcho(port, name, headers, message = 'hello\0中文') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/services/${name}/socket`, { headers: { ...remote, ...headers } });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('WS timeout')); }, 5000);
    ws.on('error', reject); ws.on('open', () => ws.send(message));
    ws.on('message', data => { assert.equal(data.toString(), message); ws.close(); });
    ws.on('close', () => { clearTimeout(timer); resolve(); });
  });
}

test('gateway owns service configuration, HTTP and WS with legacy differential coverage', { timeout: 90000 }, async t => {
  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith('/base/redirect')) {
      const location = new URL(req.url, 'http://localhost').searchParams.get('to') || '/base/landing';
      res.writeHead(302, { location, 'set-cookie': ['app=1; Path=/; Domain=localhost; HttpOnly', 'MULTICC_auth=bad; Path=/'], 'x-multicc-secret': 'hidden', 'x-forwarded-whatever': 'hidden' }); res.end(); return;
    }
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ url: req.url, headers: req.headers, body })); });
  });
  const sockets = new Set(); upstream.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const upstreamWs = new WebSocketServer({ server: upstream });
  upstreamWs.on('connection', ws => ws.on('message', data => ws.send(data)));
  const target = await listen(upstream);
  t.after(() => { upstreamWs.clients.forEach(ws => ws.terminate()); upstreamWs.close(); for (const s of sockets) s.destroy(); upstream.close(); });
  const legacy = await start(t, false), native = await start(t, true);
  assert.ok(!legacy.failed && !native.failed, legacy.logs || native.logs);
  let compared = 0;
  const both = async (...args) => {
    compared++;
    const a = await request(legacy.port, ...args), b = await request(native.port, ...args);
    assert.deepEqual(normalize(b), normalize(a), JSON.stringify(args.slice(0, 2))); return b;
  };
  const put = (name, value) => both('PUT', '/api/service-routes/' + name, { ...auth, 'content-type': 'application/json' }, JSON.stringify(value));
  await t.test('configuration validation and exact HTTP middleware behavior', async () => {
    for (const value of [undefined, null, '', 42, {}, ['http://localhost:8080/base'], 'file:///etc/passwd', 'http://user:pass@example.com', 'http://example.com?q=1', 'http://example.com#x', 'http://EXAMPLE.com:80/a/../b/', 'http://127.1/', 'http://[::1]:1234/base', 'http://example.com?', 'http://example.com#', target]) await put('validation', { target: value });
    for (const access of [false, 0, [], {}, '', 'PRIVATE', null, 'private', 'public']) await put('validation', { target, access });
    for (const name of ['BAD', '-', 'a'.repeat(49), 'bad%20name', 'a%2Fb', '%E4%B8%AD', '%ZZ']) await put(name, { target });
    for (const [method, endpoint, headers, body] of [
      ['GET', '/API/service-routes/file.js'], ['GET', '/API/service-routes?token=fixture-token'], ['GET', '/api/service-routes'], ['GET', '/api/service-routes', auth], ['HEAD', '/API/SERVICE-ROUTES/', auth],
      ['OPTIONS', '/api/service-routes/%ZZ', auth], ['OPTIONS', '/api/service-routes//', auth], ['DELETE', '/api/service-routes//', auth], ['OPTIONS', '/api/service-routes', auth], ['OPTIONS', '/api/service-routes/app/', auth], ['POST', '/api/service-routes', auth],
      ['DELETE', '/api/service-routes/app/extra', auth], ['PUT', '/api/service-routes/app', { ...auth, 'content-type': 'application/json' }, '{bad'],
      ['DELETE', '/api/service-routes/app', { ...auth, origin: 'https://evil.example' }],
      ['DELETE', '/api/service-routes/app', { ...auth, origin: 'https://fixture.example' }],
    ]) await both(method, endpoint, headers, body);
    assert.equal((await put('app', { target: target + '/base' })).status, 200);
    assert.equal((await put('open', { target, access: 'public' })).status, 400);
    assert.equal((await put('open', { target, access: 'public', acknowledgePublicRisk: true })).status, 200);
  });
  await t.test('private static files, Origin, raw uploads, headers, redirects and cookies', async () => {
    const cookieResult = await request(native.port, 'POST', '/api/auth/exchange', auth);
    const cookie = cookieResult.headers['set-cookie'][0].split(';')[0];
    // Both instances use the same secret, so the signed cookie is portable.
    for (const suffix of ['page.js', 'api.json', 'asset.png', '', '?q=a']) await both('GET', '/services/app/' + suffix, { accept: 'application/json' });
    for (const [method, endpoint, headers, body] of [
      ['GET', '/services/app/a?x=1', { accept: 'text/html' }], ['GET', '/services/app/', { ...auth, origin: 'https://evil.example', accept: 'application/json' }],
      ['GET', '/services/open/', { origin: 'https://evil.example' }], ['GET', '/services/app?token=secret&a=1', auth], ['HEAD', '/services/app', auth],
      ['GET', '/services/missing/file.js'], ['GET', '/services'], ['POST', '/services/app/upload?q=one%20two', { ...auth, cookie: cookie + '; app=2', 'x-multicc-fleet-token': 'hidden', 'content-type': 'application/octet-stream' }, 'raw\0payload'],
      ['GET', '/services/app/a%2Fb/../c?token=private&token=again&x=a%20b&z=%ZZ', { ...auth, 'x-forwarded-for': '1.2.3.4', forwarded: 'spoof', connection: 'x-remove', 'x-remove': 'hidden' }],
      ['GET', '/services/app/redirect', { cookie }], ['GET', '/services/open/', { 'x-multicc-service-hop': '1' }],
    ]) await both(method, endpoint, headers, body);
    for (const to of ['/base/landing', 'next?p=x#h', '/base', '/base-other/path', 'https://other.example/base/x', 'http://[bad']) await both('GET', '/services/app/redirect?to=' + encodeURIComponent(to), auth);
    assert.equal((await both('GET', '/services/app/a', { cookie })).status, 200);
    const echoed = JSON.parse((await both('GET', '/services/app/a?token=redacted&x=1', auth)).body);
    assert.equal(echoed.url, '/base/a?x=1'); assert.equal(echoed.headers['x-access-token'], undefined);
    for (const instance of [legacy, native]) for (const name of ['app', 'open']) await wsEcho(instance.port, name, name === 'app' ? { cookie } : {});
    for (const instance of [legacy, native]) await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${instance.port}/services/app/socket`, { headers: remote });
      ws.on('unexpected-response', (_, res) => { assert.equal(res.statusCode, 401); res.resume(); ws.terminate(); resolve(); }); ws.on('error', e => { if (!e.message.includes('before the connection')) reject(e); });
    });
  });
  await t.test('disabled routes, persistence, failed save and concurrent updates', async () => {
    await put('app', { target, enabled: false }); assert.equal((await both('GET', '/services/app/')).status, 404);
    const deadServer = http.createServer(); const dead = await listen(deadServer); await new Promise(r => deadServer.close(r));
    await put('dead', { target: dead, access: 'public', acknowledgePublicRisk: true }); assert.equal((await both('GET', '/services/dead/')).status, 502);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(native.dir, 'service-routes.json'))), JSON.parse(fs.readFileSync(path.join(legacy.dir, 'service-routes.json'))));
    for (const instance of [legacy, native]) { const file = path.join(instance.dir, 'service-routes.json'); fs.renameSync(file, file + '.saved'); fs.mkdirSync(file); }
    assert.equal((await put('open', { target, enabled: false })).status, 500);
    assert.equal((await both('GET', '/services/open/')).status, 200);
    for (const instance of [legacy, native]) { const file = path.join(instance.dir, 'service-routes.json'); fs.rmdirSync(file); fs.renameSync(file + '.saved', file); }
    const outcomes = await Promise.all(Array.from({ length: 24 }, (_, i) => request(native.port, 'PUT', '/api/service-routes/concurrent-' + i, { ...auth, 'content-type': 'application/json' }, JSON.stringify({ target }))));
    assert.ok(outcomes.every(r => r.status === 200));
    const stored = JSON.parse(fs.readFileSync(path.join(native.dir, 'service-routes.json')));
    assert.equal(stored.filter(r => r.name.startsWith('concurrent-')).length, 24);
    const restarted = await start(t, true, {}, JSON.stringify(stored));
    assert.deepEqual(JSON.parse((await request(restarted.port, 'GET', '/api/service-routes', auth)).body).routes, stored);
    const state = JSON.parse((await request(native.port, 'GET', '/fixture/state')).body);
    assert.deepEqual(state.hits.filter(p => !p.startsWith('/fixture/')), [], 'owned HTTP and WS paths must never enter Node');
  });
  await t.test('machine grants do not replace management authentication; rotation and shutdown apply', async () => {
    const addon = require(addonPath);
    const paired = JSON.parse(await addon.machineOperation(native.dir, 'pair', JSON.stringify({ ownerId: 'machine_fixture', name: 'fixture' }))).data;
    assert.notEqual((await request(native.port, 'GET', '/api/service-routes', { 'x-multicc-machine-grant': paired.grant })).status, 200);
    const cookie = (await request(native.port, 'POST', '/api/auth/exchange', auth)).headers['set-cookie'][0].split(';')[0];
    assert.equal((await request(native.port, 'PUT', '/api/service-routes/app', { ...auth, 'content-type': 'application/json' }, JSON.stringify({ target }))).status, 200);
    await request(native.port, 'POST', '/fixture/rotate', { 'content-type': 'text/plain' }, 'rotated-token');
    assert.equal((await request(native.port, 'GET', '/services/app/', { cookie, accept: 'application/json' })).status, 401);
    assert.equal((await request(native.port, 'GET', '/services/app/?token=rotated-token', { accept: 'application/json' })).status, 401);
    assert.equal((await request(native.port, 'GET', '/services/app/', { 'x-access-token': 'rotated-token' })).status, 200);
    await request(native.port, 'POST', '/fixture/shutdown');
    const result = await request(native.port, 'GET', '/api/service-routes', { 'x-access-token': 'rotated-token' });
    assert.equal(result.status, 503); assert.equal(result.headers['retry-after'], '1');
  });
  console.log(`service routes: ${compared} native/legacy HTTP comparisons executed`);
});

test('corrupt service store fails startup in both implementations', { timeout: 30000 }, async t => {
  for (const stored of ['{broken', '{}', '[{"name":"bad","target":"file:///etc/passwd"}]']) for (const native of [false, true]) {
    const instance = await start(t, native, {}, stored); assert.equal(instance.failed, true); assert.notEqual(instance.child.exitCode, 0);
  }
});

test('native service streaming, cancellation, truncated responses and upgrade head ownership', { timeout: 30000 }, async t => {
  const closed = new Set(), sockets = new Set();
  const upstream = http.createServer((req, res) => {
    const key = req.url; res.on('close', () => closed.add(key));
    if (key === '/silent') return;
    if (key === '/truncated') { res.writeHead(200, { 'content-length': '1000' }); res.write('short'); setTimeout(() => res.destroy(), 10); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    if (key === '/cancel') { res.write('started'); return; }
    req.pipe(res);
  });
  upstream.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', ws => { ws.send('early'); ws.on('message', b => ws.send(b)); });
  const target = await listen(upstream);
  t.after(() => { wss.clients.forEach(s => s.terminate()); wss.close(); for (const s of sockets) s.destroy(); upstream.close(); });
  const { port } = await start(t, true, {}, JSON.stringify([{ name: 'stream', target, access: 'public' }]));
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/services/stream/echo', headers: remote, timeout: 5000 }, res => {
      let first = true, bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (first) { first = false; req.end(Buffer.alloc(1024 * 1024, 97)); } });
      res.on('end', () => { assert.equal(bytes, 1024 * 1024 + 5); resolve(); }); res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('stream was buffered'))); req.on('error', reject); req.write('first');
  });
  for (const endpoint of ['silent', 'cancel']) {
    const req = http.get({ host: '127.0.0.1', port, path: '/services/stream/' + endpoint, headers: remote }, res => res.once('data', () => req.destroy()));
    req.on('error', () => {});
    if (endpoint === 'silent') { await delay(50); req.destroy(); }
    for (let i = 0; i < 100 && !closed.has('/' + endpoint); i++) await delay(10);
    assert.ok(closed.has('/' + endpoint), `client cancel must close upstream ${endpoint}`);
  }
  await assert.rejects(request(port, 'GET', '/services/stream/truncated'), /aborted|reset/i);
  // Send a valid masked frame in the SAME TCP write as the upgrade headers.
  const client = net.connect(port, '127.0.0.1'); await once(client, 'connect');
  const head = 'GET /services/stream/socket HTTP/1.1\r\nHost: fixture.example\r\nConnection: keep-alive\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n';
  const frame = Buffer.from([0x81, 0x85, 1, 2, 3, 4, ...Buffer.from('hello').map((b, i) => b ^ [1, 2, 3, 4][i % 4])]);
  await new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0); client.setTimeout(5000, () => { client.destroy(); reject(new Error('upgrade head lost')); });
    client.on('error', reject); client.on('data', b => { bytes = Buffer.concat([bytes, b]); if (bytes.includes('early') && bytes.includes('hello')) { assert.match(bytes.toString(), /^HTTP\/1\.1 101/i); client.destroy(); resolve(); } });
    client.write(Buffer.concat([Buffer.from(head), frame]));
  });
  for (let i = 0; i < 100 && wss.clients.size; i++) await delay(10);
  assert.equal(wss.clients.size, 0, 'closing upgraded client releases upstream WS');
});

test('service HTTPS validates certificates and supports trusted TLS and WSS', { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-service-tls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:FALSE'], { stdio: 'ignore' });
  const upstream = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_req, res) => res.end('trusted TLS'));
  const wss = new WebSocketServer({ server: upstream }); wss.on('connection', ws => ws.on('message', b => ws.send(b)));
  const target = (await listen(upstream)).replace('http:', 'https:');
  t.after(() => { wss.clients.forEach(s => s.terminate()); wss.close(); upstream.closeAllConnections(); upstream.close(); });
  const stored = JSON.stringify([{ name: 'tls', target, access: 'public' }]);
  for (const native of [false, true]) {
    const untrusted = await start(t, native, {}, stored);
    assert.equal((await request(untrusted.port, 'GET', '/services/tls/')).status, 502);
    const trusted = await start(t, native, { NODE_EXTRA_CA_CERTS: cert }, stored);
    const result = await request(trusted.port, 'GET', '/services/tls/'); assert.equal(result.status, 200); assert.equal(result.body, 'trusted TLS');
    await wsEcho(trusted.port, 'tls');
  }
});
