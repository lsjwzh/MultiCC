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

module.exports = {
  LOOPBACK_ADDRESSES,
  FORWARDING_HEADERS,
  requestHost,
  hasForwardingMetadata,
  isExternalProxyRequest,
  isLocalRequest,
};
