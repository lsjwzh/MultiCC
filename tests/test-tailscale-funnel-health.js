'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');

const {
  createTailscaleFunnelProbe,
  isPublicAddress,
  parseFunnelStatusJson,
  parseTailscaleStatusJson,
  requestHealth,
  resolvePublicFunnelAddresses,
  validateHealthResponse,
} = require('../src/tailscale-funnel-health');

const HOSTNAME = 'node-a.example-tail.ts.net';
const PUBLIC_IPS = ['185.40.234.37', '185.40.234.172'];

function controlStatus(overrides = {}) {
  return JSON.stringify({
    BackendState: 'Running',
    Self: { Online: true, Active: false },
    Health: [],
    ...overrides,
  });
}

function funnelStatus({ hostname = HOSTNAME, proxy = 'http://127.0.0.1:3000', allow = true } = {}) {
  const authority = `${hostname}:443`;
  return JSON.stringify({
    TCP: { '443': { HTTPS: true } },
    Web: { [authority]: { Handlers: { '/': { Proxy: proxy } } } },
    AllowFunnel: { [authority]: allow },
  });
}

function runStatus({ control = controlStatus(), funnel = funnelStatus() } = {}) {
  return async (_bin, args) => {
    if (args[0] === 'status') return { ok: true, stdout: control, stderr: '' };
    if (args[0] === 'funnel' || args[0] === 'serve') return { ok: true, stdout: funnel, stderr: '' };
    return { ok: false, stdout: '', stderr: 'unexpected command' };
  };
}

function publicDoh({ addresses = PUBLIC_IPS, fail = false, privateAddress = '' } = {}) {
  return async ({ type }) => {
    if (fail) return { ok: false, reason: 'timeout' };
    if (type === 'AAAA') return { ok: true, answers: [] };
    const values = privateAddress ? [privateAddress] : addresses;
    return {
      ok: true,
      answers: values.map(data => ({ type: 1, data, TTL: 60 })),
    };
  };
}

function healthyRequest(code = 200) {
  return async () => ({ verdict: 'healthy', reason: '', httpCode: code });
}

test('public address filter rejects tailnet, synthetic, private, and documentation ranges', () => {
  for (const address of [
    '0.1.2.3', '10.0.0.1', '100.118.172.84', '127.0.0.1', '169.254.1.1',
    '172.16.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', 'fd7a:115c:a1e0::1',
    '192.88.99.1', 'fe80::1', 'ff02::1', '2001::1', '2001:2::1', '2001:10::1',
    '2001:20::1', '2001:db8::1', '2002:0a00::1', '3fff::1', '::ffff:185.40.234.37',
  ]) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('185.40.234.37'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('status parsers project only online control plane and canonical Funnel mapping', () => {
  assert.deepEqual(parseTailscaleStatusJson(controlStatus()), { ok: true });
  assert.equal(parseTailscaleStatusJson(controlStatus({ BackendState: 'NeedsLogin' })).ok, false);
  assert.equal(parseTailscaleStatusJson(JSON.stringify({ BackendState: 'Running', Self: null })).ok, false);

  const parsed = parseFunnelStatusJson(funnelStatus(), 3000);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.target, {
    hostname: HOSTNAME,
    publicPort: 443,
    originPort: 3000,
    publicUrl: `https://${HOSTNAME}/`,
  });
  assert.equal(parseFunnelStatusJson(funnelStatus({ allow: false }), 3000).reason, 'funnel_mapping_missing');
  assert.equal(parseFunnelStatusJson(funnelStatus({ proxy: 'http://127.0.0.1:4000' }), 3000).ok, false);
  assert.equal(parseFunnelStatusJson(funnelStatus({ proxy: 'http://192.168.1.2:3000' }), 3000).ok, false);
  assert.equal(parseFunnelStatusJson(funnelStatus({ proxy: 'http://[::1]:3000' }), 3000).ok, true);
});

test('public resolver accepts public answers and fails closed on resolver/private ambiguity', async () => {
  const ok = await resolvePublicFunnelAddresses(HOSTNAME, { dohRequest: publicDoh() });
  assert.equal(ok.verdict, 'ok');
  assert.deepEqual(ok.addresses, PUBLIC_IPS);
  assert.equal(ok.ttlSec, 60);

  const unavailable = await resolvePublicFunnelAddresses(HOSTNAME, { dohRequest: publicDoh({ fail: true }) });
  assert.deepEqual(unavailable, { verdict: 'indeterminate', reason: 'doh_unreachable' });
  const privateOnly = await resolvePublicFunnelAddresses(HOSTNAME, {
    dohRequest: publicDoh({ privateAddress: '100.118.172.84' }),
  });
  assert.deepEqual(privateOnly, { verdict: 'indeterminate', reason: 'non_public_resolution' });

  const oversized = await resolvePublicFunnelAddresses(HOSTNAME, {
    dohRequest: publicDoh({
      addresses: Array.from({ length: 9 }, (_, index) => `185.40.234.${index + 1}`),
    }),
  });
  assert.deepEqual(oversized, { verdict: 'indeterminate', reason: 'too_many_public_addresses' });
});

test('health contract requires exact no-store MultiCC response', () => {
  const body = JSON.stringify({ status: 'ok', uptimeSeconds: 12, requestId: 'r1' });
  assert.equal(validateHealthResponse(200, { 'cache-control': 'no-store' }, body), true);
  assert.equal(validateHealthResponse(302, { 'cache-control': 'no-store' }, body), false);
  assert.equal(validateHealthResponse(200, {}, body), false);
  assert.equal(validateHealthResponse(200, { 'cache-control': 'no-storehouse' }, body), false);
  assert.equal(validateHealthResponse(200, { 'cache-control': 'no-cache, no-store' }, body, 'r1'), true);
  assert.equal(validateHealthResponse(200, { 'cache-control': 'no-store' }, body, 'other'), false);
  assert.equal(validateHealthResponse(200, { 'cache-control': 'no-store' }, '{"status":"ok"}'), false);
});

test('pinned HTTPS request connects to public IP but preserves Host/SNI and strict TLS', async () => {
  const originalGet = https.get;
  let captured;
  https.get = (options, callback) => {
    captured = options;
    const request = new EventEmitter();
    request.destroy = () => request.emit('error', Object.assign(new Error('destroyed'), { code: 'ECONNRESET' }));
    process.nextTick(() => {
      const socket = new EventEmitter();
      request.emit('socket', socket);
      socket.emit('secureConnect');
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'cache-control': 'no-store' };
      callback(response);
      response.emit('data', Buffer.from(JSON.stringify({ status: 'ok', uptimeSeconds: 1, requestId: 'edge-r1' })));
      response.emit('end');
    });
    return request;
  };
  try {
    const result = await requestHealth({
      protocol: 'https:', address: PUBLIC_IPS[0], hostname: HOSTNAME,
      port: 443, path: '/healthz?probe=edge-r1', requestId: 'edge-r1',
    });
    assert.equal(result.verdict, 'healthy');
    assert.equal(captured.hostname, PUBLIC_IPS[0]);
    assert.equal(captured.servername, HOSTNAME);
    assert.equal(captured.headers.Host, HOSTNAME);
    assert.equal(captured.headers['X-Request-ID'], 'edge-r1');
    assert.equal(captured.rejectUnauthorized, true);
    assert.equal(captured.agent, false);
  } finally {
    https.get = originalGet;
  }
});

test('probe derives canonical CLI target instead of stale configured URL', async () => {
  const edgeCalls = [];
  const probe = createTailscaleFunnelProbe({
    run: runStatus(), tailscaleBin: '/safe/tailscale',
    dohRequest: publicDoh(),
    originRequest: healthyRequest(),
    edgeRequest: async input => { edgeCalls.push(input); return { verdict: 'healthy', httpCode: 200 }; },
    nonce: () => 'fixed',
  });
  const result = await probe.probe({ originPort: 3000 });
  assert.equal(result.verdict, 'healthy');
  assert.equal(result.publicUrl, `https://${HOSTNAME}/`);
  assert.equal(result.resolvedAddressCount, 2);
  assert.equal(result.edgeSuccessCount, 2);
  assert.deepEqual(edgeCalls.map(call => call.address), PUBLIC_IPS);
  assert.ok(edgeCalls.every(call => call.target.hostname === HOSTNAME));
  assert.ok(edgeCalls.every(call => call.path === '/healthz?probe=fixed'));
});

test('resolver uncertainty and certificate ambiguity never become repair eligible', async () => {
  let edgeCalls = 0;
  const resolverUnknown = createTailscaleFunnelProbe({
    run: runStatus(), tailscaleBin: '/safe/tailscale',
    dohRequest: publicDoh({ fail: true }), originRequest: healthyRequest(),
    edgeRequest: async () => { edgeCalls++; return { verdict: 'healthy', httpCode: 200 }; },
  });
  const unknown = await resolverUnknown.probe({ originPort: 3000 });
  assert.equal(unknown.verdict, 'indeterminate');
  assert.equal(unknown.repairEligible, false);
  assert.equal(edgeCalls, 0);

  const certUnknown = createTailscaleFunnelProbe({
    run: runStatus(), tailscaleBin: '/safe/tailscale',
    dohRequest: publicDoh(), originRequest: healthyRequest(),
    edgeRequest: async () => ({ verdict: 'indeterminate', reason: 'certificate_invalid', httpCode: 0 }),
  });
  const cert = await certUnknown.probe({ originPort: 3000 });
  assert.equal(cert.verdict, 'indeterminate');
  assert.equal(cert.error, 'edge_identity_unverified');
  assert.equal(cert.repairEligible, false);
});

test('all confirmed public edges down is repair eligible; partial success is degraded only', async () => {
  const downProbe = createTailscaleFunnelProbe({
    run: runStatus(), tailscaleBin: '/safe/tailscale',
    dohRequest: publicDoh(), originRequest: healthyRequest(),
    edgeRequest: async () => ({ verdict: 'unhealthy', reason: 'edge_tls_unreachable', httpCode: 0 }),
  });
  const down = await downProbe.probe({ originPort: 3000 });
  assert.equal(down.verdict, 'unhealthy');
  assert.equal(down.error, 'public_data_plane_down');
  assert.equal(down.repairEligible, true);

  let calls = 0;
  const partialProbe = createTailscaleFunnelProbe({
    run: runStatus(), tailscaleBin: '/safe/tailscale',
    dohRequest: publicDoh(), originRequest: healthyRequest(),
    edgeRequest: async () => (++calls === 1
      ? { verdict: 'healthy', httpCode: 200 }
      : { verdict: 'unhealthy', reason: 'edge_tls_unreachable', httpCode: 0 }),
  });
  const partial = await partialProbe.probe({ originPort: 3000 });
  assert.equal(partial.verdict, 'degraded');
  assert.equal(partial.error, 'partial_edge_failure');
  assert.equal(partial.repairEligible, false);
});

test('mapping absence and valid-TLS application mismatch never become repair eligible', async () => {
  const missing = createTailscaleFunnelProbe({
    run: runStatus({ funnel: funnelStatus({ allow: false }) }), tailscaleBin: '/safe/tailscale',
    dohRequest: publicDoh(), originRequest: healthyRequest(), edgeRequest: healthyRequest(),
  });
  const missingResult = await missing.probe({ originPort: 3000 });
  assert.equal(missingResult.verdict, 'indeterminate');
  assert.equal(missingResult.error, 'funnel_mapping_missing');
  assert.equal(missingResult.repairEligible, false);

  const mismatch = createTailscaleFunnelProbe({
    run: runStatus(), tailscaleBin: '/safe/tailscale', dohRequest: publicDoh(),
    originRequest: healthyRequest(),
    edgeRequest: async () => ({ verdict: 'indeterminate', reason: 'health_response_invalid', httpCode: 302 }),
  });
  const mismatchResult = await mismatch.probe({ originPort: 3000 });
  assert.equal(mismatchResult.verdict, 'indeterminate');
  assert.equal(mismatchResult.error, 'edge_identity_unverified');
  assert.equal(mismatchResult.repairEligible, false);
});

test('CLI compatibility fallbacks run only for failure or malformed JSON', async () => {
  const commands = [];
  const fallbackProbe = createTailscaleFunnelProbe({
    tailscaleBin: '/safe/tailscale',
    run: async (_bin, args) => {
      commands.push(args);
      if (args.join(' ') === 'status --json --peers=false') return { ok: false, stdout: '', stderr: '' };
      if (args.join(' ') === 'status --json') return { ok: true, stdout: controlStatus(), stderr: '' };
      if (args[0] === 'funnel') return { ok: true, stdout: '{bad-json', stderr: '' };
      if (args[0] === 'serve') return { ok: true, stdout: funnelStatus(), stderr: '' };
      return { ok: false, stdout: '', stderr: '' };
    },
    dohRequest: publicDoh(), originRequest: healthyRequest(), edgeRequest: healthyRequest(),
  });
  assert.equal((await fallbackProbe.probe({ originPort: 3000 })).verdict, 'healthy');
  assert.deepEqual(commands, [
    ['status', '--json', '--peers=false'], ['status', '--json'],
    ['funnel', 'status', '--json'], ['serve', 'status', '--json'],
  ]);
});

test('only allowlisted transport errors are down; certificate, protocol, and unknown errors are indeterminate', async () => {
  const originalGet = https.get;
  const runError = code => {
    https.get = () => {
      const request = new EventEmitter();
      request.destroy = () => {};
      process.nextTick(() => request.emit('error', Object.assign(new Error(code), { code })));
      return request;
    };
    return requestHealth({
      protocol: 'https:', address: PUBLIC_IPS[0], hostname: HOSTNAME,
      port: 443, path: '/healthz?probe=r1', requestId: 'r1',
    });
  };
  try {
    const certificate = await runError('CERT_HAS_EXPIRED');
    assert.deepEqual(certificate, { verdict: 'indeterminate', reason: 'certificate_invalid', httpCode: 0 });
    const invalidCa = await runError('INVALID_CA');
    assert.deepEqual(invalidCa, { verdict: 'indeterminate', reason: 'certificate_invalid', httpCode: 0 });
    const wrongProtocol = await runError('ERR_SSL_WRONG_VERSION_NUMBER');
    assert.deepEqual(wrongProtocol, { verdict: 'indeterminate', reason: 'edge_error_unclassified', httpCode: 0 });
    const invalidArgument = await runError('ERR_INVALID_ARG_VALUE');
    assert.deepEqual(invalidArgument, { verdict: 'indeterminate', reason: 'edge_error_unclassified', httpCode: 0 });
    const reset = await runError('ECONNRESET');
    assert.deepEqual(reset, { verdict: 'unhealthy', reason: 'edge_tls_unreachable', httpCode: 0 });
  } finally {
    https.get = originalGet;
  }
});

test('local origin or control-plane failure never triggers public repair eligibility', async () => {
  const originDown = createTailscaleFunnelProbe({
    run: runStatus(), tailscaleBin: '/safe/tailscale', dohRequest: publicDoh(),
    originRequest: async () => ({ verdict: 'unhealthy', httpCode: 0 }),
  });
  const local = await originDown.probe({ originPort: 3000 });
  assert.equal(local.error, 'local_origin_down');
  assert.equal(local.repairEligible, false);

  const offline = createTailscaleFunnelProbe({
    run: runStatus({ control: controlStatus({ BackendState: 'Stopped' }) }),
    tailscaleBin: '/safe/tailscale', dohRequest: publicDoh(), originRequest: healthyRequest(),
  });
  const control = await offline.probe({ originPort: 3000 });
  assert.equal(control.verdict, 'indeterminate');
  assert.equal(control.error, 'tailscale_offline');
  assert.equal(control.repairEligible, false);
});
