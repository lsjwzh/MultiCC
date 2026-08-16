'use strict';

// Outside-in Funnel health from the local host. Tailscale's system resolver can
// map a *.ts.net name to its 100.x tailnet address, which proves only the private
// path. Resolve through public DoH, then connect to the returned literal edge IP
// while preserving the Funnel hostname for Host/SNI and certificate validation.

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');

const MAX_STATUS_BYTES = 256 * 1024;
const MAX_DOH_BYTES = 64 * 1024;
const MAX_HEALTH_BYTES = 4 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_MIN_TTL_SEC = 30;
const CACHE_MAX_TTL_SEC = 300;
const MAX_EDGE_ADDRESSES = 8;
const TRANSPORT_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
  'EHOSTUNREACH', 'EHOSTDOWN', 'ENETUNREACH', 'ENETDOWN', 'ENETRESET', 'EPIPE',
]);

const DOH_PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'cloudflare', address: '1.1.1.1', servername: 'cloudflare-dns.com',
    path: (hostname, type) => `/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
  }),
  Object.freeze({
    id: 'google', address: '8.8.8.8', servername: 'dns.google',
    path: (hostname, type) => `/resolve?name=${encodeURIComponent(hostname)}&type=${type}`,
  }),
]);

const blockedAddresses = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedAddresses.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['3fff::', 20], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blockedAddresses.addSubnet(network, prefix, 'ipv6');

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !blockedAddresses.check(address, 'ipv4');
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  // Public IPv6 global unicast is 2000::/3. The block list then removes its
  // IANA special-purpose subranges (transition, benchmarking, documentation,
  // ORCHID/Teredo), which must never be mistaken for a public Funnel edge.
  if (!/^[23]/.test(normalized)) return false;
  return !blockedAddresses.check(address, 'ipv6');
}

function normalizeHostname(value) {
  return String(value || '').trim().replace(/\.$/, '').toLowerCase();
}

function validFunnelHostname(value) {
  const hostname = normalizeHostname(value);
  return hostname.length <= 253
    && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.ts\.net$/.test(hostname)
    && !hostname.includes('..');
}

function isLoopbackProxy(value, expectedPort) {
  try {
    const url = new URL(value);
    const hostname = normalizeHostname(url.hostname.replace(/^\[|\]$/g, ''));
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return url.protocol === 'http:'
      && !url.username && !url.password
      && (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1')
      && port === expectedPort;
  } catch (_) {
    return false;
  }
}

function parseJsonBounded(raw, maxBytes) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > maxBytes) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (_) {
    return null;
  }
}

function parseTailscaleStatusJson(raw) {
  const value = parseJsonBounded(raw, MAX_STATUS_BYTES);
  if (!value) return { ok: false, reason: 'tailscale_status_malformed' };
  if (value.BackendState !== 'Running' || !value.Self || value.Self.Online !== true) {
    return { ok: false, reason: 'tailscale_offline' };
  }
  return { ok: true };
}

function parseFunnelStatusJson(raw, expectedOriginPort) {
  const value = parseJsonBounded(raw, MAX_STATUS_BYTES);
  if (!value) return { ok: false, reason: 'funnel_status_malformed' };
  const web = value.Web && typeof value.Web === 'object' ? value.Web : {};
  const allow = value.AllowFunnel && typeof value.AllowFunnel === 'object' ? value.AllowFunnel : {};
  const tcp = value.TCP && typeof value.TCP === 'object' ? value.TCP : {};
  const authorities = Object.keys(web).sort();

  for (const authority of authorities) {
    let target;
    try { target = new URL(`https://${authority}`); } catch (_) { continue; }
    const hostname = normalizeHostname(target.hostname);
    const publicPort = Number(target.port || 443);
    if (!validFunnelHostname(hostname) || publicPort !== 443) continue;
    if (allow[authority] !== true || !tcp[String(publicPort)] || tcp[String(publicPort)].HTTPS !== true) continue;
    const handlers = web[authority] && web[authority].Handlers;
    const root = handlers && handlers['/'];
    if (!root || !isLoopbackProxy(root.Proxy, expectedOriginPort)) continue;
    return {
      ok: true,
      target: Object.freeze({
        hostname,
        publicPort,
        originPort: expectedOriginPort,
        publicUrl: `https://${hostname}/`,
      }),
    };
  }
  return { ok: false, reason: 'funnel_mapping_missing' };
}

function collectResponse(res, maxBytes, callback) {
  let settled = false;
  let size = 0;
  const chunks = [];
  const finish = value => {
    if (settled) return;
    settled = true;
    callback(value);
  };
  res.on('data', chunk => {
    size += chunk.length;
    if (size > maxBytes) {
      res.destroy();
      finish({ ok: false, reason: 'response_too_large' });
      return;
    }
    chunks.push(chunk);
  });
  res.on('end', () => finish({ ok: true, body: Buffer.concat(chunks).toString('utf8') }));
  res.on('error', () => finish({ ok: false, reason: 'response_error' }));
}

function requestDoh({ provider, hostname, type, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = https.get({
      hostname: provider.address,
      port: 443,
      servername: provider.servername,
      path: provider.path(hostname, type),
      method: 'GET',
      headers: { Host: provider.servername, Accept: 'application/dns-json' },
      rejectUnauthorized: true,
      agent: false,
      timeout: timeoutMs,
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        finish({ ok: false, reason: 'doh_http_error' });
        return;
      }
      collectResponse(res, MAX_DOH_BYTES, result => {
        if (!result.ok) return finish({ ok: false, reason: 'doh_malformed' });
        const json = parseJsonBounded(result.body, MAX_DOH_BYTES);
        if (!json || json.Status !== 0 || !Array.isArray(json.Answer)) {
          return finish({ ok: false, reason: 'doh_malformed' });
        }
        finish({ ok: true, answers: json.Answer });
      });
    });
    req.on('timeout', () => {
      finish({ ok: false, reason: 'doh_unreachable' });
      req.destroy();
    });
    req.on('error', () => finish({ ok: false, reason: 'doh_unreachable' }));
  });
}

async function resolvePublicFunnelAddresses(hostname, {
  providers = DOH_PROVIDERS,
  dohRequest = requestDoh,
} = {}) {
  const queries = [];
  for (const provider of providers) {
    queries.push(dohRequest({ provider, hostname, type: 'A' }));
    queries.push(dohRequest({ provider, hostname, type: 'AAAA' }));
  }
  const results = await Promise.all(queries);
  const successful = results.filter(result => result && result.ok);
  if (successful.length === 0) return { verdict: 'indeterminate', reason: 'doh_unreachable' };

  const addresses = new Set();
  let sawAddressRecord = false;
  let sawNonPublic = false;
  let ttlSec = CACHE_MAX_TTL_SEC;
  for (const result of successful) {
    for (const answer of result.answers || []) {
      if (answer.type !== 1 && answer.type !== 28) continue;
      sawAddressRecord = true;
      const address = String(answer.data || '').trim();
      if (!isPublicAddress(address)) {
        sawNonPublic = true;
        continue;
      }
      addresses.add(address);
      if (Number.isFinite(answer.TTL) && answer.TTL > 0) ttlSec = Math.min(ttlSec, answer.TTL);
    }
  }
  if (sawNonPublic) return { verdict: 'indeterminate', reason: 'non_public_resolution' };
  if (addresses.size === 0) {
    return { verdict: 'indeterminate', reason: sawAddressRecord ? 'no_public_address' : 'dns_no_record' };
  }
  // Do not truncate and then infer health from a subset: that can miss the one
  // healthy edge and create a false repair decision. An unexpectedly large
  // RRset is uncertainty, so fail closed without opening any edge sockets.
  if (addresses.size > MAX_EDGE_ADDRESSES) {
    return { verdict: 'indeterminate', reason: 'too_many_public_addresses' };
  }
  ttlSec = Math.max(CACHE_MIN_TTL_SEC, Math.min(CACHE_MAX_TTL_SEC, ttlSec));
  return { verdict: 'ok', addresses: [...addresses], ttlSec };
}

function validateHealthResponse(statusCode, headers, body, expectedRequestId = '') {
  if (statusCode !== 200) return false;
  const cacheDirectives = String(headers && headers['cache-control'] || '')
    .toLowerCase().split(',').map(value => value.trim().split('=', 1)[0]);
  if (!cacheDirectives.includes('no-store')) return false;
  const json = parseJsonBounded(body, MAX_HEALTH_BYTES);
  return !!json
    && json.status === 'ok'
    && Number.isInteger(json.uptimeSeconds) && json.uptimeSeconds >= 0
    && typeof json.requestId === 'string' && json.requestId.length > 0 && json.requestId.length <= 256
    && (!expectedRequestId || json.requestId === expectedRequestId);
}

function requestHealth({
  protocol,
  address,
  hostname,
  port,
  path,
  requestId = '',
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  return new Promise(resolve => {
    let settled = false;
    let secure = protocol !== 'https:';
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const mod = protocol === 'https:' ? https : http;
    const options = {
      hostname: address,
      port,
      path,
      method: 'GET',
      headers: {
        Host: hostname,
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
        ...(requestId ? { 'X-Request-ID': requestId } : {}),
      },
      agent: false,
      timeout: timeoutMs,
    };
    if (protocol === 'https:') {
      options.servername = hostname;
      options.rejectUnauthorized = true;
    }
    const req = mod.get(options, res => {
      collectResponse(res, MAX_HEALTH_BYTES, result => {
        if (!result.ok) return finish({ verdict: 'indeterminate', reason: 'health_response_invalid', httpCode: res.statusCode || 0 });
        const healthy = validateHealthResponse(res.statusCode || 0, res.headers, result.body, requestId);
        finish({
          verdict: healthy ? 'healthy' : 'indeterminate',
          reason: healthy ? '' : 'health_response_invalid',
          httpCode: res.statusCode || 0,
        });
      });
    });
    req.on('socket', socket => {
      if (protocol === 'https:') socket.once('secureConnect', () => { secure = true; });
    });
    req.on('timeout', () => {
      finish({
        verdict: 'unhealthy',
        reason: secure ? 'edge_http_unreachable' : 'edge_tls_unreachable',
        httpCode: 0,
      });
      req.destroy();
    });
    req.on('error', error => {
      const code = String(error && error.code || '');
      const certificateFailure = /CERT|TLS_CERT|HOSTNAME|SELF_SIGNED|UNABLE_TO_VERIFY|INVALID_CA|CRL_/i.test(code);
      const transportFailure = TRANSPORT_ERROR_CODES.has(code);
      finish({
        verdict: transportFailure ? 'unhealthy' : 'indeterminate',
        reason: certificateFailure
          ? 'certificate_invalid'
          : (transportFailure
              ? (secure ? 'edge_http_unreachable' : 'edge_tls_unreachable')
              : 'edge_error_unclassified'),
        httpCode: 0,
      });
    });
  });
}

function defaultOriginRequest({ port, path, requestId }) {
  return requestHealth({
    protocol: 'http:', address: '127.0.0.1', hostname: `127.0.0.1:${port}`,
    port, path, requestId,
  });
}

function defaultEdgeRequest({ address, target, path, requestId }) {
  return requestHealth({
    protocol: 'https:', address, hostname: target.hostname,
    port: target.publicPort, path, requestId,
  });
}

function safeBase(overrides = {}) {
  return {
    mode: 'tailscale_funnel_public',
    verdict: 'indeterminate',
    healthy: false,
    repairEligible: false,
    error: '',
    httpCode: 0,
    originHttpCode: 0,
    publicUrl: '',
    resolvedAddressCount: 0,
    edgeSuccessCount: 0,
    ...overrides,
  };
}

function createTailscaleFunnelProbe({
  run,
  tailscaleBin,
  dohRequest = requestDoh,
  originRequest = defaultOriginRequest,
  edgeRequest = defaultEdgeRequest,
  now = Date.now,
  nonce = () => crypto.randomBytes(8).toString('hex'),
} = {}) {
  if (typeof run !== 'function') throw new TypeError('createTailscaleFunnelProbe requires run()');
  let cache = null;

  async function readParsedStatus(args, fallbackArgs, parser) {
    let result = await run(tailscaleBin, args);
    let parsed = result.ok ? parser(result.stdout) : null;
    // A command failure or malformed JSON can be a CLI-version difference.
    // A valid semantic negative (offline/mapping missing) is authoritative and
    // must not be hidden by a second command's stale view.
    if ((!result.ok || !parsed || /_malformed$/.test(parsed.reason || '')) && fallbackArgs) {
      result = await run(tailscaleBin, fallbackArgs);
      parsed = result.ok ? parser(result.stdout) : null;
    }
    return { commandOk: !!result.ok, parsed };
  }

  async function probe({ originPort }) {
    const control = await readParsedStatus(
      ['status', '--json', '--peers=false'], ['status', '--json'], parseTailscaleStatusJson,
    );
    if (!control.commandOk || !control.parsed) return safeBase({ error: 'tailscale_status_unavailable' });
    const parsedControl = control.parsed;
    if (!parsedControl.ok) return safeBase({ error: parsedControl.reason });

    const requestId = nonce();
    const path = `/healthz?probe=${requestId}`;
    const origin = await originRequest({ port: originPort, path, requestId });
    if (!origin || origin.verdict !== 'healthy') {
      return safeBase({
        verdict: 'unhealthy', error: 'local_origin_down',
        originHttpCode: origin && origin.httpCode || 0,
      });
    }

    const funnel = await readParsedStatus(
      ['funnel', 'status', '--json'],
      ['serve', 'status', '--json'],
      raw => parseFunnelStatusJson(raw, originPort),
    );
    if (!funnel.commandOk || !funnel.parsed) {
      return safeBase({ error: 'funnel_status_unavailable', originHttpCode: origin.httpCode });
    }
    const parsedFunnel = funnel.parsed;
    if (!parsedFunnel.ok) {
      return safeBase({
        verdict: 'indeterminate',
        repairEligible: false,
        error: parsedFunnel.reason,
        originHttpCode: origin.httpCode,
      });
    }
    const target = parsedFunnel.target;

    let resolution;
    if (cache && cache.hostname === target.hostname && cache.expiresAt > now()) {
      resolution = { verdict: 'ok', addresses: cache.addresses, ttlSec: cache.ttlSec };
    } else {
      resolution = await resolvePublicFunnelAddresses(target.hostname, { dohRequest });
      if (resolution.verdict === 'ok') {
        cache = {
          hostname: target.hostname,
          addresses: resolution.addresses,
          ttlSec: resolution.ttlSec,
          expiresAt: now() + resolution.ttlSec * 1000,
        };
      }
    }
    if (resolution.verdict !== 'ok') {
      return safeBase({
        error: resolution.reason,
        originHttpCode: origin.httpCode,
        publicUrl: target.publicUrl,
      });
    }

    const edgeResults = await Promise.all(resolution.addresses.map(address => (
      edgeRequest({ address, target, path, requestId })
    )));
    const successes = edgeResults.filter(result => result && result.verdict === 'healthy');
    if (successes.length === edgeResults.length) {
      return safeBase({
        verdict: 'healthy', healthy: true, error: '',
        httpCode: successes[0].httpCode || 200,
        originHttpCode: origin.httpCode,
        publicUrl: target.publicUrl,
        resolvedAddressCount: resolution.addresses.length,
        edgeSuccessCount: successes.length,
      });
    }
    if (successes.length > 0) {
      return safeBase({
        verdict: 'degraded', healthy: false, error: 'partial_edge_failure',
        httpCode: successes[0].httpCode || 200,
        originHttpCode: origin.httpCode,
        publicUrl: target.publicUrl,
        resolvedAddressCount: resolution.addresses.length,
        edgeSuccessCount: successes.length,
      });
    }
    cache = null; // force fresh public DNS before the next failure decision
    const transportReasons = new Set(['edge_tls_unreachable', 'edge_http_unreachable']);
    const confirmedTransportDown = edgeResults.length > 0 && edgeResults.every(result => (
      result && result.verdict === 'unhealthy' && transportReasons.has(result.reason)
    ));
    return safeBase({
      verdict: confirmedTransportDown ? 'unhealthy' : 'indeterminate',
      repairEligible: confirmedTransportDown,
      error: confirmedTransportDown ? 'public_data_plane_down' : 'edge_identity_unverified',
      httpCode: Math.max(0, ...edgeResults.map(result => result && result.httpCode || 0)),
      originHttpCode: origin.httpCode,
      publicUrl: target.publicUrl,
      resolvedAddressCount: resolution.addresses.length,
      edgeSuccessCount: 0,
    });
  }

  return { probe, clearCache: () => { cache = null; } };
}

module.exports = {
  createTailscaleFunnelProbe,
  isPublicAddress,
  parseFunnelStatusJson,
  parseTailscaleStatusJson,
  requestHealth,
  resolvePublicFunnelAddresses,
  validateHealthResponse,
};
