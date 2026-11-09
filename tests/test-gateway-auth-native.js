'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const zlib = require('node:zlib');
const WebSocket = require('ws');
const addonPath = process.env.MULTICC_RUST_ADDON || path.join(process.env.MULTICC_RUST_PREBUILT_DIR || path.resolve(__dirname, '../native/prebuilt'), `${process.platform}-${process.arch}`, 'multicc_core.node');
const binary = path.join(path.dirname(addonPath), process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway');
const fixture = path.resolve(__dirname, 'helpers/gateway-auth-child.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const remote = { host: 'fixture.example', 'x-request-id': 'auth-test', 'x-correlation-id': 'correlation-test' };
function request(port, method, url, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url,
      headers: { ...remote, ...headers, 'content-length': bytes.length }, timeout: 8000 }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('timeout', () => req.destroy(new Error(`fixture request timeout: ${port} ${method} ${url}`)));
    req.on('error', reject); req.end(bytes);
  });
}
async function start(t, native) {
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-auth-gateway-'));
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', MULTICC_ENV_FILE: path.join(dir, '.env'),
    MULTICC_DATA_DIR: dir, MULTICC_GATEWAY_BACKOFF_SCALE: '0.01', MULTICC_RUST_ADDON: addonPath };
  for (const key of Object.keys(env)) if (key.startsWith('MULTICC_GATEWAY_') && key !== 'MULTICC_GATEWAY_BACKOFF_SCALE') delete env[key];
  const child = spawn(native ? binary : process.execPath, native ? ['serve', '--cwd', dir, '--node', process.execPath, '--stdin-lifeline', '--', fixture] : [fixture],
    { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', c => { logs += c; }); child.stderr.on('data', c => { logs += c; });
  t.after(async () => {
    if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill('SIGINT'); await exit; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await request(port, 'GET', '/fixture/state')).status === 200) return { port, dir, child }; } catch {}
    if (child.exitCode !== null) throw new Error(`fixture exited: ${logs}`);
    await delay(20);
  }
  throw new Error(`fixture did not start: ${logs}`);
}
function normalize(response) {
  const headers = { ...response.headers };
  for (const key of ['date', 'connection', 'keep-alive']) delete headers[key];
  if (headers['set-cookie']?.[0].startsWith('multicc_auth=ey')) headers['set-cookie'] = headers['set-cookie'].map(c => c.replace(/^multicc_auth=[^;]+/, 'multicc_auth=<signed>'));
  let body = response.body;
  if (response.status === 200 && body.startsWith('{"ticket":')) {
    const value = JSON.parse(body); assert.equal(value.ticket.length, 32); assert.ok(value.expiresAt > Date.now());
    value.ticket = '<ticket>'; value.expiresAt = '<expiry>'; body = JSON.stringify(value);
    delete headers.etag; delete headers['content-length'];
  }
  return { status: response.status, headers, body };
}

test('native front door auth matches Express HTTP responses and owns the endpoints', { timeout: 60000 }, async t => {
  const legacy = await start(t, false), native = await start(t, true);
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  const authenticated = { 'x-access-token': 'fixture-token' };
  const cases = [
    ['GET', '/login'],
    ...['error[=x', 'error[__proto__]=x', 'error[constructor]=x', 'error&error=', 'redirect[=x&redirect=/chat'].map(q => ['GET', '/login?' + q]),
    ['OPTIONS', '/login', { 'content-type': 'application/json' }, '{bad'], ['HEAD', '/LOGIN/'], ['GET', '/login?error=1&redirect=%2Ffoo%3Fa%3D1%26b%3D2'],
    ['GET', '/login?redirect[]=x&error[]='], ['GET', '/logout'], ['OPTIONS', '/login'], ['OPTIONS', '/LOGIN'],
    ['POST', '/login', form, 'password=wrong&redirect=//evil.example'],
    ['POST', '/login', form, 'password=fixture-token&redirect=/chat?a=1'],
    ['POST', '/LOGIN/', { ...form, 'x-forwarded-proto': 'https, http' }, 'password=fixture-token'],
    ['POST', '/login', form, 'password=fixture-token&password=wrong'],
    ['POST', '/login', form, 'password[]=fixture-token'],
    ['POST', '/login', form, 'password=%ZZ&redirect=%C3%28'],
    ['POST', '/login', { ...form, 'content-encoding': 'gzip' }, zlib.gzipSync('password=fixture-token')],
    ['POST', '/login', { ...form, 'content-encoding': 'deflate' }, zlib.deflateSync('password=fixture-token')],
    ['POST', '/login', { 'content-type': 'application/x-www-form-urlencoded; charset=latin1' }, 'password=fixture-token'],
    ['POST', '/login', form, 'x='.repeat(60000)],
    ['POST', '/login', form, 'x=1&'.repeat(1000)],
    ['POST', '/api/auth/exchange'], ['POST', '/api/auth/exchange', authenticated],
    ['POST', '/api/auth/exchange', { host: 'localhost' }], ['OPTIONS', '/api/auth/exchange', authenticated],
    ['POST', '/api/auth/ws-ticket', authenticated],
    ...['/ws/test', '//evil.example/ws', '', false, 0, [], {}, '/ws/中文'].map(p => ['POST', '/api/auth/ws-ticket', { ...authenticated, 'content-type': 'application/json' }, JSON.stringify({ path: p })]),
    ...['{bad', '{"path":1e400}', '{"path":-1e400}', '{"path":-0}', '{"path":"/a","path":"/b"}'].map(body => ['POST', '/api/auth/ws-ticket', { ...authenticated, 'content-type': 'application/json' }, body]),
    ['POST', '/api/auth/ws-ticket', { ...authenticated, 'content-type': 'application/json' }, JSON.stringify({ path: '/ws/' + 'x'.repeat(4096) })],
  ];
  for (const args of cases) {
    const a = await request(legacy.port, ...args), b = await request(native.port, ...args);
    assert.deepEqual(normalize(b), normalize(a), JSON.stringify(args.slice(0, 2)));
  }
  const state = JSON.parse((await request(native.port, 'GET', '/fixture/state')).body);
  assert.deepEqual(state.hits.filter(p => !p.startsWith('/fixture/')), []);
  assert.equal(state.capabilityLeaked, false);
  console.log(`auth HTTP differential: ${cases.length} cases; native endpoints never reached Express`);
});

test('one Rust ticket table handles gateway issuance, host metadata, WS replay and live state', { timeout: 60000 }, async t => {
  const { port, dir } = await start(t, true);
  const authorized = { 'x-access-token': 'fixture-token', 'content-type': 'application/json' };
  const issue = async () => JSON.parse((await request(port, 'POST', '/api/auth/ws-ticket', authorized, '{"path":"/ws/test"}')).body);
  const consume = async (ticket, pathname) => JSON.parse((await request(port, 'POST', '/fixture/consume', { 'content-type': 'application/json' }, JSON.stringify({ ticket, path: pathname }))).body);
  const addon = require(addonPath);
  const paired = JSON.parse(await addon.machineOperation(dir, 'pair', JSON.stringify({ ownerId: 'machine_fixture', name: 'fixture' }))).data;
  const machine = await request(port, 'POST', '/api/auth/ws-ticket', { 'x-multicc-machine-grant': paired.grant, 'content-type': 'application/json' }, '{"path":"/ws/test"}');
  assert.equal(machine.status, 200);
  assert.equal((await consume(JSON.parse(machine.body).ticket, '/ws/test')).machineGrantId, paired.grantId);
  assert.equal((await request(port, 'POST', '/api/auth/ws-ticket', { ...authorized, 'x-multicc-machine-grant': 'mcg_invalid' })).status, 403);
  await addon.machineOperation(dir, 'revoke', JSON.stringify({ id: paired.grantId }));
  assert.equal((await request(port, 'POST', '/api/auth/ws-ticket', { 'x-multicc-machine-grant': paired.grant })).status, 403);
  let ticket = await issue();
  assert.equal(await consume(ticket.ticket, '/wrong'), null);
  assert.equal(await consume(ticket.ticket, '/ws/test'), null);
  ticket = await issue();
  const results = await Promise.all(Array.from({ length: 12 }, () => consume(ticket.ticket, '/ws/test')));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.find(Boolean).correlationId, 'correlation-test');
  const host = JSON.parse((await request(port, 'POST', '/fixture/issue')).body);
  assert.equal((await consume(host.ticket, '/ws/test')).source, 'host');
  ticket = await issue();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/test?ws_ticket=${ticket.ticket}`);
  const closed = once(ws, 'close'); const message = once(ws, 'message');
  assert.equal(JSON.parse((await message)[0]).requestId, 'auth-test'); await closed;
  assert.equal(await consume(ticket.ticket, '/ws/test'), null);
  const exchange = await request(port, 'POST', '/api/auth/exchange', authorized);
  const cookie = exchange.headers['set-cookie'][0].split(';')[0];
  assert.equal((await request(port, 'POST', '/api/auth/ws-ticket', { cookie })).status, 200);
  fs.writeFileSync(path.join(dir, '.env'), 'ACCESS_TOKEN=unapplied-token\n');
  assert.equal((await request(port, 'POST', '/api/auth/exchange', authorized)).status, 204);
  await request(port, 'POST', '/fixture/rotate', { 'content-type': 'text/plain' }, 'rotated-token');
  assert.equal((await request(port, 'POST', '/api/auth/exchange', authorized)).status, 403);
  assert.equal((await request(port, 'POST', '/api/auth/ws-ticket', { cookie })).status, 403);
  assert.equal((await request(port, 'POST', '/api/auth/exchange', { 'x-access-token': 'rotated-token' })).status, 204);
  await request(port, 'POST', '/fixture/shutdown');
  for (const endpoint of ['/api/auth/exchange', '/api/auth/ws-ticket', '/api/run-config/presets']) {
    const response = await request(port, endpoint.endsWith('presets') ? 'GET' : 'POST', endpoint, { 'x-access-token': 'rotated-token' });
    // Native presets GET and auth POST all observe the same shutdown owner.
    assert.equal(response.status, 503); assert.equal(response.headers['retry-after'], '1'); assert.equal(JSON.parse(response.body).code, 'SERVER_SHUTTING_DOWN');
  }
});


test('child restart invalidates its tickets and control state without accepting stale authority', { timeout: 30000 }, async t => {
  const { port } = await start(t, true);
  const before = JSON.parse((await request(port, 'GET', '/fixture/state')).body);
  const headers = { 'x-access-token': 'fixture-token' };
  const ticket = JSON.parse((await request(port, 'POST', '/api/auth/ws-ticket', headers)).body);
  await request(port, 'POST', '/fixture/crash');
  let next;
  for (let i = 0; i < 100; i++) {
    await delay(30);
    try { next = JSON.parse((await request(port, 'GET', '/fixture/state')).body); } catch { continue; }
    if (next.pid !== before.pid) break;
  }
  assert.notEqual(next?.pid, before.pid);
  assert.equal(next.capabilityLeaked, false);
  const consumed = await request(port, 'POST', '/fixture/consume', { 'content-type': 'application/json' }, JSON.stringify({ ticket: ticket.ticket, path: '/' }));
  assert.equal(JSON.parse(consumed.body), null);
  assert.equal((await request(port, 'POST', '/api/auth/exchange', headers)).status, 204);
});
