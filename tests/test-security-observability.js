'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  createAuthSecurity,
  normalizeDownloadTarget,
  normalizeRedirect,
  timingSafeEqualText,
} = require('../src/auth-security');
const { resolveNetworkPolicy, selectListenPort } = require('../src/network-policy');
const { createLogger, createMetrics, redact } = require('../src/observability');
const { atomicWriteJson, secureRuntimeData } = require('../src/runtime-security');
const { createPaths } = require('../src/paths');
const { installWsBackpressure } = require('../src/ws-backpressure');
const { requestIdMiddleware } = require('../src/http-errors');
const { createHealthHandlers } = require('../src/health');

test('authenticated installs auto-bind to IPv4 LAN while explicit policy stays fail-closed', () => {
  assert.deepStrictEqual(resolveNetworkPolicy({}), {
    host: '127.0.0.1', port: 3000, development: false, allowRemote: false, accessToken: '', lanOnly: false,
  });
  assert.deepStrictEqual(resolveNetworkPolicy({ ACCESS_TOKEN: 'short' }), {
    host: '127.0.0.1', port: 3000, development: false, allowRemote: false, accessToken: 'short', lanOnly: false,
  });
  assert.deepStrictEqual(resolveNetworkPolicy({ ACCESS_TOKEN: 'installed-secret' }), {
    host: '0.0.0.0', port: 3000, development: false, allowRemote: true, accessToken: 'installed-secret', lanOnly: true,
  });
  assert.deepStrictEqual(resolveNetworkPolicy({ ACCESS_TOKEN: 'installed-secret', MULTICC_ALLOW_REMOTE: '0' }), {
    host: '127.0.0.1', port: 3000, development: false, allowRemote: false, accessToken: 'installed-secret', lanOnly: false,
  });
  assert.deepStrictEqual(resolveNetworkPolicy({ ACCESS_TOKEN: 'installed-secret', HOST: '127.0.0.1' }), {
    host: '127.0.0.1', port: 3000, development: false, allowRemote: false, accessToken: 'installed-secret', lanOnly: false,
  });
  assert.throws(() => resolveNetworkPolicy({ HOST: '0.0.0.0' }), /MULTICC_ALLOW_REMOTE/);
  assert.deepStrictEqual(resolveNetworkPolicy({ HOST: '0.0.0.0', MULTICC_ALLOW_REMOTE: '1' }), {
    host: '0.0.0.0', port: 3000, development: false, allowRemote: true, accessToken: '', lanOnly: false,
  });
  assert.deepStrictEqual(resolveNetworkPolicy({
    HOST: '0.0.0.0', PORT: '4312', MULTICC_ALLOW_REMOTE: 'true', ACCESS_TOKEN: 'secret',
  }), {
    host: '0.0.0.0', port: 4312, development: false, allowRemote: true, accessToken: 'secret', lanOnly: false,
  });
  assert.equal(resolveNetworkPolicy({ HOST: '::1', NODE_ENV: 'development' }).development, true);
});

test('production keeps the requested port while development may select a fallback', async () => {
  let calls = 0;
  const finder = async (port, host) => { calls++; assert.equal(host, '127.0.0.1'); return port + 1; };
  assert.equal(await selectListenPort({ port: 3000, host: '127.0.0.1', development: false }, finder), 3000);
  assert.equal(calls, 0);
  assert.equal(await selectListenPort({ port: 3000, host: '127.0.0.1', development: true }, finder), 3001);
  assert.equal(calls, 1);
});

test('auth cookie is timing-safe, versioned, and expires server-side', () => {
  let clock = 1_700_000_000_000;
  let nonce = 0;
  const auth = createAuthSecurity({
    getSecret: () => 'correct horse battery staple',
    now: () => clock,
    randomBytes: size => Buffer.alloc(size, ++nonce),
    cookieTtlMs: 10_000,
  });
  const cookie = auth.createCookie();
  assert.equal(auth.verifyCookie(cookie), true);
  assert.equal(auth.verifyCookie(cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A')), false);
  clock += 10_001;
  assert.equal(auth.verifyCookie(cookie), false);
  assert.equal(timingSafeEqualText('same', 'same'), true);
  assert.equal(timingSafeEqualText('short', 'longer'), false);
});

test('redirect accepts only same-site relative paths', () => {
  assert.equal(normalizeRedirect('/manage?focus=aux#x'), '/manage?focus=aux#x');
  for (const unsafe of ['https://evil.test/', '//evil.test/', '/\\evil.test/', 'javascript:alert(1)', '\n/evil']) {
    assert.equal(normalizeRedirect(unsafe), '/');
  }
});

test('WebSocket tickets are short-lived, path-bound, and single-use', () => {
  let clock = 10_000;
  let nonce = 0;
  const auth = createAuthSecurity({
    getSecret: () => 'secret',
    now: () => clock,
    randomBytes: size => Buffer.alloc(size, ++nonce),
    ticketTtlMs: 1_000,
  });
  const first = auth.issueWsTicket('/ws/chat', { correlationId: 'corr-1' });
  assert.deepStrictEqual(auth.consumeWsTicket(first.ticket, '/ws/chat'), {
    correlationId: 'corr-1', path: '/ws/chat', expiresAt: 11_000,
  });
  assert.equal(auth.consumeWsTicket(first.ticket, '/ws/chat'), null);
  const wrongScope = auth.issueWsTicket('/ws/chat');
  assert.equal(auth.consumeWsTicket(wrongScope.ticket, '/ws/voice'), null);
  assert.equal(auth.consumeWsTicket(wrongScope.ticket, '/ws/chat'), null);
  const expired = auth.issueWsTicket('/ws/chat');
  clock += 1_001;
  assert.equal(auth.consumeWsTicket(expired.ticket, '/ws/chat'), null);
});

test('download tickets are short-lived and bound to one canonical file target', () => {
  let clock = 20_000;
  let nonce = 0;
  const auth = createAuthSecurity({
    getSecret: () => 'secret',
    now: () => clock,
    randomBytes: size => Buffer.alloc(size, ++nonce),
    ticketTtlMs: 1_000,
  });
  const target = '/api/download?path=%2Ftmp%2Freport+one.pdf&inline=1';
  const issued = auth.issueDownloadTicket(target, { requestId: 'req-1' });
  assert.equal(issued.target, target);
  assert.equal(auth.verifyDownloadTicket(
    issued.ticket,
    `${target}&download_ticket=${encodeURIComponent(issued.ticket)}`,
  ), true);
  assert.equal(auth.verifyDownloadTicket(
    issued.ticket,
    '/api/download?inline=1&path=%2Ftmp%2Freport+one.pdf&download_ticket=ignored',
  ), true);
  assert.equal(auth.verifyDownloadTicket(
    issued.ticket,
    '/api/download?path=%2Ftmp%2Fother.pdf&inline=1&download_ticket=ignored',
  ), false);
  assert.equal(auth.verifyDownloadTicket(issued.ticket, `${target}&token=secret`), false);
  clock += 1_001;
  assert.equal(auth.verifyDownloadTicket(issued.ticket, target), false);

  assert.equal(normalizeDownloadTarget('https://evil.test/api/download?path=/tmp/x'), null);
  assert.equal(normalizeDownloadTarget('/api/download?path=/tmp/x&extra=1'), null);
  assert.throws(() => auth.issueDownloadTicket('/api/download?path='), /invalid download/);
});

test('runtime JSON writes are atomic and private', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-security-'));
  const paths = createPaths({ dataDir: root });
  secureRuntimeData(paths);
  atomicWriteJson(paths.providersFile, { providers: [{ token: 'secret' }] });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(paths.providersFile, 'utf8')), { providers: [{ token: 'secret' }] });
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.chatHistoryDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.providersFile).mode & 0o777, 0o600);
  fs.rmSync(root, { recursive: true, force: true });
});

test('structured logger and metrics redact secrets', () => {
  const lines = [];
  const sink = { log: line => lines.push(line), warn: line => lines.push(line), error: line => lines.push(line) };
  const logger = createLogger({ sink, now: () => new Date('2025-01-01T00:00:00Z') });
  logger.info('provider_call', { accessToken: 'top-secret', detail: 'Authorization: Bearer abc123 token=xyz' });
  const record = JSON.parse(lines[0]);
  assert.equal(record.accessToken, '[REDACTED]');
  assert.doesNotMatch(record.detail, /abc123|xyz/);
  assert.equal(redact('https://x.test/?token=secret'), 'https://x.test/?token=[REDACTED]');
  const metrics = createMetrics();
  metrics.inc('multicc_persistence_failures_total');
  metrics.set('multicc_ws_clients', 3);
  assert.match(metrics.render(), /multicc_persistence_failures_total 1/);
  assert.match(metrics.render(), /multicc_ws_clients 3/);
});

test('request middleware propagates request and correlation IDs', () => {
  const events = [];
  const req = {
    headers: { 'x-request-id': 'request-123', 'x-correlation-id': 'correlation-456' },
    method: 'GET', path: '/healthz',
    app: { locals: { observability: { logger: { info: (event, fields) => events.push({ event, fields }) } } } },
  };
  const res = new EventEmitter();
  res.locals = {};
  res.statusCode = 200;
  const headers = {};
  res.setHeader = (name, value) => { headers[name] = value; };
  let next = false;
  requestIdMiddleware(req, res, () => { next = true; });
  res.emit('finish');
  assert.equal(next, true);
  assert.equal(req.id, 'request-123');
  assert.equal(req.correlationId, 'correlation-456');
  assert.equal(headers['X-Correlation-Id'], 'correlation-456');
  assert.equal(events[0].event, 'http_request');
  assert.equal(events[0].fields.correlationId, 'correlation-456');
});

test('health stays live while readiness follows startup state', () => {
  let ready = false;
  const handlers = createHealthHandlers({ isReady: () => ready, uptime: () => 12.9 });
  function response() {
    return {
      code: 200, body: null, headers: {},
      set(name, value) { this.headers[name] = value; return this; },
      status(code) { this.code = code; return this; },
      json(body) { this.body = body; return this; },
    };
  }
  const health = response();
  handlers.healthz({ id: 'r1' }, health);
  assert.equal(health.code, 200);
  assert.deepStrictEqual(health.body, { status: 'ok', uptimeSeconds: 12, requestId: 'r1' });
  const before = response();
  handlers.readyz({ id: 'r2' }, before);
  assert.equal(before.code, 503);
  ready = true;
  const after = response();
  handlers.readyz({ id: 'r3' }, after);
  assert.equal(after.code, 200);
});

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.bufferedAmount = 0;
    this.sent = [];
    this.closed = null;
  }
  send(data, _options, callback) {
    this.sent.push(String(data));
    if (callback) callback();
  }
  close(code, reason) {
    this.closed = { code, reason };
    this.emit('close');
  }
  terminate() { this.closed = { terminated: true }; }
}

test('WebSocket backpressure coalesces snapshots and disconnects on bounded overflow', () => {
  const metrics = new Map();
  const onMetric = (name, value = 1, op) => metrics.set(name, op === 'set' ? value : (metrics.get(name) || 0) + value);
  const slow = new FakeWs();
  slow.bufferedAmount = 100;
  const transport = installWsBackpressure(slow, {
    limits: { highWaterBytes: 10, maxQueueBytes: 1000, maxQueueMessages: 3, retryMs: 1000 },
    onMetric,
  });
  slow.send(JSON.stringify({ type: 'snapshot', dirId: 'd', value: 1 }));
  slow.send(JSON.stringify({ type: 'snapshot', dirId: 'd', value: 2 }));
  assert.equal(transport.stats().queueMessages, 1);
  assert.equal(metrics.get('multicc_ws_messages_coalesced_total'), 1);
  slow.bufferedAmount = 0;
  transport.flush();
  assert.match(slow.sent[0], /"value":2/);

  const overflow = new FakeWs();
  overflow.bufferedAmount = 100;
  installWsBackpressure(overflow, {
    limits: { highWaterBytes: 10, maxQueueBytes: 1000, maxQueueMessages: 1, retryMs: 1000 },
    onMetric,
  });
  overflow.send('first');
  overflow.send('second');
  assert.equal(overflow.closed.code, 1013);
  assert.ok(metrics.get('multicc_ws_queue_overflows_total') >= 1);
  assert.ok(metrics.get('multicc_ws_backpressure_disconnects_total') >= 1);
});
