'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  requestHost,
  hasForwardingMetadata,
  isExternalProxyRequest,
  isLocalRequest,
  isPrivateNetworkAddress,
  isPrivateRequestPeer,
} = require('../src/request-locality');

function request(ip, host) {
  return {
    ip,
    headers: { host },
    socket: { remoteAddress: ip },
    connection: { remoteAddress: ip },
  };
}

test('host parsing preserves IPv4, names and bracketed IPv6', () => {
  assert.equal(requestHost(request('::1', 'localhost:3000')), 'localhost');
  assert.equal(requestHost(request('::1', '[::1]:3000')), '::1');
  assert.equal(requestHost(request('::1', 'dashboard.example.com:443')), 'dashboard.example.com');
});

test('local requests require both a loopback peer and a local Host header', () => {
  assert.equal(isLocalRequest(request('127.0.0.1', '127.0.0.1:3000')), true);
  assert.equal(isLocalRequest(request('::1', '[::1]:3000')), true);
  assert.equal(isLocalRequest(request('::ffff:127.0.0.1', 'localhost:3000')), true);
  assert.equal(isLocalRequest(request('192.168.1.20', 'localhost:3000')), false);
});

test('socket remoteAddress is authoritative and req.ip cannot grant locality', () => {
  const externalSocket = request('192.168.1.20', 'localhost:3000');
  externalSocket.ip = '127.0.0.1';
  externalSocket.connection.remoteAddress = '127.0.0.1';
  assert.equal(isLocalRequest(externalSocket), false);

  const loopbackSocket = request('127.0.0.1', 'localhost:3000');
  loopbackSocket.ip = '203.0.113.8';
  loopbackSocket.connection.remoteAddress = '203.0.113.8';
  assert.equal(isLocalRequest(loopbackSocket), true);
});

test('any forwarding metadata makes a loopback transport external', () => {
  for (const header of [
    'forwarded',
    'Forwarded',
    'x-forwarded-for',
    'x-forwarded-proto',
    'x-forwarded-host',
    'x-real-ip',
    'via',
    'cf-connecting-ip',
    'true-client-ip',
    'client-ip',
    'x-client-ip',
    'x-cluster-client-ip',
    'x-original-forwarded-for',
    'x-envoy-external-address',
    'fastly-client-ip',
    'fly-client-ip',
    'cdn-loop',
  ]) {
    const req = request('127.0.0.1', 'localhost:3000');
    req.headers[header] = '';
    assert.equal(hasForwardingMetadata(req), true, header);
    assert.equal(isExternalProxyRequest(req), true, header);
    assert.equal(isLocalRequest(req), false, header);
  }
});

test('loopback reverse proxies retaining public hosts remain external', () => {
  for (const host of [
    'dashboard.example.com',
    'machine.tail123.ts.net',
    'demo.ngrok.io',
    'demo.ngrok-free.app',
  ]) {
    const req = request('127.0.0.1', host);
    assert.equal(isExternalProxyRequest(req), true, host);
    assert.equal(isLocalRequest(req), false, host);
  }
});

test('missing or malformed request metadata fails closed', () => {
  assert.equal(isLocalRequest({ headers: { host: 'localhost' } }), false);
  assert.equal(isLocalRequest({ ip: '127.0.0.1', connection: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost' } }), false);
  assert.equal(isExternalProxyRequest({ headers: { host: '[::1' } }), true);
});

test('automatic LAN mode accepts private and Tailscale transport peers but rejects public addresses', () => {
  for (const address of [
    '127.0.0.1', '::1', '10.0.0.2', '172.16.0.1', '172.31.255.254',
    '192.168.22.220', '100.64.0.1', '100.127.255.254', '169.254.1.2',
    '::ffff:192.168.1.4', 'fd12:3456::1', 'fe80::1%en0',
  ]) assert.equal(isPrivateNetworkAddress(address), true, address);
  for (const address of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '203.0.113.8', '2001:4860:4860::8888', '']) {
    assert.equal(isPrivateNetworkAddress(address), false, address);
  }
  assert.equal(isPrivateRequestPeer(request('192.168.1.20', 'host.local')), true);
  assert.equal(isPrivateRequestPeer(request('203.0.113.8', 'host.example')), false);
});

test('locality checks stay limited to authentication and sensitive host controls', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const authRoutes = fs.readFileSync('src/routes/auth.js', 'utf8');
  const routerToolHost = fs.readFileSync('src/router-tool-host.js', 'utf8');
  const taskBoardRoutes = fs.readFileSync('src/routes/task-board.js', 'utf8');
  const hostReadHost = fs.readFileSync('src/routes/host-read-host.js', 'utf8');
  const hostWriteRoutes = fs.readFileSync('src/routes/host-write.js', 'utf8');
  const wsConnectionRouter = fs.readFileSync('src/ws/connection-router.js', 'utf8');
  const sourceFiles = ['server.js'];
  const pending = ['src'];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.endsWith('.js')) sourceFiles.push(candidate);
    }
  }
  const localityUsers = sourceFiles
    .filter(file => /\bisLocalRequest\b/.test(fs.readFileSync(file, 'utf8')))
    .sort();

  // Ordinary authenticated product features must never grow a second
  // localhost-only authorization layer. The helper is reserved for: local
  // auth bootstrap/bypass, external WebSocket ticket enforcement, access-token
  // editability, scoped internal MCP bridges, plugin installation on this
  // machine, and the explicitly enumerated sensitive host settings.
  assert.deepEqual(localityUsers, [
    'server.js',
    'src/host-power-services.js',
    'src/request-locality.js',
    'src/router-tool-host.js',
    // One host port per migrated route group: each internal listener accepts
    // loopback calls only, so a request forwarded from a real client is 404.
    'src/routes/agent-resources-host.js',
    'src/routes/auth.js',
    'src/routes/file-transfer-host.js',
    'src/routes/host-power.js',
    'src/routes/host-read-host.js',
    'src/routes/host-write.js',
    'src/routes/model-catalogs-host.js',
    'src/routes/plugins.js',
    // Passes the dependency through to the provider runtime, does not decide.
    'src/routes/providers.js',
    'src/routes/secrets-vault-host.js',
    'src/routes/subagent-defaults-host.js',
    'src/routes/token-usage-host.js',
    'src/routes/turn-ledger-host.js',
    'src/ws/connection-router.js',
  ]);
  assert.doesNotMatch(taskBoardRoutes, /\bisLocalRequest\b/);
  assert.match(authRoutes, /httpEntryAuthenticated\(req, entryPort\)/);
  const nativeEntry = fs.readFileSync('native/addon/src/http_entry.rs', 'utf8');
  assert.match(nativeEntry, /host\(port, c"isLocalRequest", &\[request\]\)/);
  assert.match(routerToolHost, /isLocalRequest\(req\)/);
  assert.match(wsConnectionRouter, /isLocalRequest\(req\)/);
  assert.match(server, /mountWsConnectionRouter\(wss,/);
  assert.match(hostReadHost, /isLocalRequest/);
  const nativeHostRead = fs.readFileSync('native/gateway/src/app/host_read.rs', 'utf8');
  assert.match(nativeHostRead, /http_gate::is_local_request\(peer, &ctx\.headers\)/,
    'canEdit must be decided by the Rust front door on the real client peer');
  assert.match(hostWriteRoutes, /requireLocal\(deps, req, res/);
  assert.ok(
    server.indexOf('authRuntime.mountRoutes(app)') < server.indexOf('taskBoardRuntime.mountRoutes(app)'),
    'the authenticated API gate must be mounted before task-board routes',
  );
  assert.doesNotMatch(server, /\bisExternalProxy\s*\(/, 'removed inline helper must have no stale callers');
  assert.doesNotMatch(authRoutes, /\bisExternalProxy\s*\(/, 'auth module must not reintroduce an inline helper');
});

const legacyLocality = require('./helpers/legacy-request-locality');
const nativeLocality = require('../src/request-locality');

test('native locality matches the former policy across peer, Host and forwarding header combinations', () => {
  const peers = [undefined, null, '', 0, false, '127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1',
    '192.168.1.1', '203.0.113.1', 'fe80::1%eth0', 'fd00::1', '100.64.1.1'];
  const hosts = [undefined, null, '', 0, [], ['localhost'], ' LOCALHOST:3000 ', '127.0.0.1', '[::1]:4',
    '::1', '[::1', 'example.ts.net', 'demo.ngrok.io', 'demo.ngrok-free.app', 'host.example', '\ud800:9', 'İ:9'];
  const forwarding = [null, 'Forwarded', 'X-Forwarded-X', 'via', 'authorization', 'x-real-ip', 'CF-Connecting-IP'];
  let cases = 0;
  for (const peer of peers) for (const host of hosts) for (const header of forwarding) {
    const req = request(peer, host);
    if (header) Object.defineProperty(req.headers, header, { enumerable: true, get() { throw new Error('header value must never be read'); } });
    for (const method of ['requestHost', 'hasForwardingMetadata', 'isExternalProxyRequest', 'isLocalRequest', 'isPrivateRequestPeer']) {
      assert.deepEqual(nativeLocality[method](req), legacyLocality[method](req), `${method}: ${peer} / ${JSON.stringify(host)} / ${header}`);
      cases++;
    }
  }
  assert.equal(cases, 8330);
});

test('native locality preserves live getter order, own-key enumeration and exception short circuits', () => {
  function trace(factory, name, variant) {
    const calls = [];
    const headers = new Proxy(Object.assign(Object.create({ Forwarded: '' }), { host: 'localhost', Via: '' }), {
      get(object, key) { calls.push(`header:${String(key)}`); return Reflect.get(object, key); },
      ownKeys(object) { calls.push('keys'); if (variant === 'throw-keys') throw new TypeError('keys blocked'); return Reflect.ownKeys(object); },
      getOwnPropertyDescriptor(object, key) { calls.push(`descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(object, key); },
    });
    const req = {
      get headers() { calls.push('headers'); if (variant === 'throw-headers') throw new TypeError('headers blocked'); return headers; },
      get socket() {
        calls.push('socket');
        return { get remoteAddress() { calls.push('peer'); return variant === 'public' ? '203.0.113.1' : '127.0.0.1'; } };
      },
    };
    let result, error;
    try { result = factory[name](req); } catch (e) { error = e.constructor.name; }
    return { calls, result, error };
  }
  for (const name of ['requestHost', 'hasForwardingMetadata', 'isExternalProxyRequest', 'isLocalRequest', 'isPrivateRequestPeer']) {
    for (const variant of ['normal', 'public', 'throw-keys', 'throw-headers']) {
      assert.deepEqual(trace(nativeLocality, name, variant), trace(legacyLocality, name, variant), `${name}: ${variant}`);
    }
  }
  for (const value of [undefined, null, false, 0, 1, 'text', Symbol('locality'), Object.create(null)]) {
    for (const method of ['requestHost', 'hasForwardingMetadata', 'isLocalRequest', 'isExternalProxyRequest', 'isPrivateRequestPeer']) {
      assert.deepEqual(nativeLocality[method](value), legacyLocality[method](value));
    }
  }
});

test('private address parsing keeps prior JS number and zone-id semantics', () => {
  const components = ['127', '10', '192', '172', '100', '169', '203', '', ' 10 ', '0x0a', '1e1', '-0', '256', 'NaN'];
  for (const first of components) for (const second of ['0', '16', '31', '32', '64', '127', '128', '168', '254', '', '0xa8']) {
    for (const address of [`${first}.${second}.0.1`, ` ::ffff:${first}.${second}.0.1%en0 `]) {
      assert.equal(isPrivateNetworkAddress(address), legacyLocality.isPrivateNetworkAddress(address), address);
    }
  }
  for (const value of [undefined, null, false, 0, ['127.0.0.1'], { toString: () => '10.0.0.1' }, Symbol('x'), 'FC00::1', 'FEBF::1', 'fe7f::1', '::ffff:7f00:1', '\ud800']) {
    assert.equal(isPrivateNetworkAddress(value), legacyLocality.isPrivateNetworkAddress(value));
  }
  assert.deepEqual([...nativeLocality.LOOPBACK_ADDRESSES], [...legacyLocality.LOOPBACK_ADDRESSES]);
  assert.deepEqual([...nativeLocality.FORWARDING_HEADERS], [...legacyLocality.FORWARDING_HEADERS]);
});
