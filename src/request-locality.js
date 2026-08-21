'use strict';

const LOOPBACK_ADDRESSES = Object.freeze(new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
]));

const FORWARDING_HEADERS = Object.freeze(new Set([
  'forwarded',
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
]));

function requestHost(req) {
  const rawHost = String(req && req.headers && req.headers.host || '').trim().toLowerCase();
  if (rawHost.startsWith('[')) {
    const closing = rawHost.indexOf(']');
    return closing > 0 ? rawHost.slice(1, closing) : rawHost;
  }
  return rawHost.split(':')[0];
}

function isExternalProxyRequest(req) {
  const host = requestHost(req);
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  return hasForwardingMetadata(req)
    || !localHost
    || host.endsWith('.ts.net')
    || host.endsWith('.ngrok.io')
    || host.endsWith('.ngrok-free.app');
}

// Trusting any forwarded address when deciding whether a request may mutate
// localhost-only settings creates a privilege escalation behind a reverse
// proxy: the proxy itself is often connected over 127.0.0.1. Fail closed on
// the *presence* of forwarding metadata, even when the value is empty. Node
// normally lower-cases header names, but iterating keeps the helper safe for
// tests and non-Express adapters that preserve casing.
function hasForwardingMetadata(req) {
  const headers = req && req.headers;
  if (!headers || typeof headers !== 'object') return false;
  return Object.keys(headers).some((rawName) => {
    const name = String(rawName).toLowerCase();
    return FORWARDING_HEADERS.has(name) || name.startsWith('x-forwarded-');
  });
}

// A localhost-looking Host header is insufficient: the transport peer must
// also be loopback. Conversely, a reverse proxy connected through loopback is
// still external when it retains a public Host header.
function isLocalRequest(req) {
  // req.ip is derived from Express's trust-proxy setting and connection is a
  // legacy alias. The actual transport peer is the only authoritative source.
  const address = req && req.socket && req.socket.remoteAddress;
  return LOOPBACK_ADDRESSES.has(String(address || '')) && !isExternalProxyRequest(req);
}

// Automatic LAN mode binds the IPv4 wildcard so localhost and the physical
// LAN work at the same time. This transport-only check prevents that wildcard
// from becoming an accidental public listener on hosts with a public NIC.
// Tailscale peers live in 100.64/10; Funnel/reverse proxies connect through
// loopback and still pass the normal ACCESS_TOKEN authentication above them.
function isPrivateNetworkAddress(rawAddress) {
  let address = String(rawAddress || '').trim().toLowerCase().split('%')[0];
  if (address.startsWith('::ffff:')) address = address.slice('::ffff:'.length);
  if (address === '::1') return true;
  if (/^(?:fc|fd)[0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address)) return true;
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 127
    || a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254);
}

function isPrivateRequestPeer(req) {
  return isPrivateNetworkAddress(req && req.socket && req.socket.remoteAddress);
}

module.exports = {
  LOOPBACK_ADDRESSES,
  FORWARDING_HEADERS,
  requestHost,
  hasForwardingMetadata,
  isExternalProxyRequest,
  isLocalRequest,
  isPrivateNetworkAddress,
  isPrivateRequestPeer,
};
