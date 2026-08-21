'use strict';

const net = require('net');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function envEnabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host || '').trim().toLowerCase());
}

function resolveNetworkPolicy(env = process.env) {
  const configuredHost = [env.HOST, env.MULTICC_HOST]
    .map(value => String(value || '').trim())
    .find(Boolean) || '';
  const port = Number.parseInt(env.PORT || '3000', 10);
  const development = env.NODE_ENV === 'development' || envEnabled(env.MULTICC_DEV);
  const accessToken = String(env.ACCESS_TOKEN || '');
  const remoteSetting = String(env.MULTICC_ALLOW_REMOTE || '').trim();
  // The installer always creates an ACCESS_TOKEN. When the operator has not
  // chosen a bind policy, that token is the safe signal to make a normal
  // installation reachable from the IPv4 LAN without another setup step.
  // Empty-token/manual checkouts stay loopback-only, and either HOST or
  // MULTICC_ALLOW_REMOTE remains an explicit override (including opt-out).
  const autoLan = !configuredHost && !remoteSetting && accessToken.trim().length >= 6;
  const allowRemote = remoteSetting ? envEnabled(remoteSetting) : autoLan;
  const host = configuredHost || (allowRemote ? '0.0.0.0' : '127.0.0.1');
  if (!host || net.isIP(host) === 0 && host !== 'localhost') throw new Error(`Invalid bind host: ${host || '<empty>'}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);
  if (!isLoopbackHost(host)) {
    if (!allowRemote) throw new Error(`Refusing non-loopback bind ${host}: set MULTICC_ALLOW_REMOTE=1 explicitly`);
    // Empty-token explicit binds stay fail-closed at request time: only a real
    // loopback peer can bootstrap the password. Automatic LAN mode additionally
    // limits direct peers to private networks before normal authentication.
  }
  return { host, port, development, allowRemote, accessToken, lanOnly: autoLan };
}

async function findAvailablePort(startPort, host, { maxTries = 100 } = {}) {
  for (let offset = 0; offset < maxTries; offset++) {
    const port = startPort + offset;
    if (port > 65535) break;
    const available = await new Promise(resolve => {
      const probe = net.createServer();
      probe.unref();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, host);
    });
    if (available) return port;
  }
  throw new Error(`No available port from ${startPort} on ${host}`);
}

async function selectListenPort(policy, finder = findAvailablePort) {
  if (!policy || !policy.development) return policy.port;
  return finder(policy.port, policy.host);
}

module.exports = { envEnabled, isLoopbackHost, resolveNetworkPolicy, findAvailablePort, selectListenPort };
