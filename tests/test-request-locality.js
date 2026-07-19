'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  requestHost,
  hasForwardingMetadata,
  isExternalProxyRequest,
  isLocalRequest,
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

test('HTTP and WebSocket production gates share the same locality boundary', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  // The HTTP auth gate moved into src/routes/auth.js, which receives the one
  // shared isLocalRequest helper as a dependency; the settings gate and the
  // WebSocket gate remain in server.js. Counting across both files keeps the
  // invariant honest — all production gates route through the same helper, and
  // none has drifted to bespoke inline locality logic.
  const authRoutes = fs.readFileSync('src/routes/auth.js', 'utf8');
  const calls = (server.match(/isLocalRequest\(req\)/g) || [])
    .concat(authRoutes.match(/isLocalRequest\(req\)/g) || []);
  assert.ok(calls.length >= 3, 'HTTP auth, settings and WebSocket gates must share one helper');
  assert.doesNotMatch(server, /\bisExternalProxy\s*\(/, 'removed inline helper must have no stale callers');
  assert.doesNotMatch(authRoutes, /\bisExternalProxy\s*\(/, 'auth module must not reintroduce an inline helper');
});
