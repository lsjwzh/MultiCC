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
  const host = String(env.HOST || env.MULTICC_HOST || '127.0.0.1').trim();
  const port = Number.parseInt(env.PORT || '3000', 10);
  const development = env.NODE_ENV === 'development' || envEnabled(env.MULTICC_DEV);
  const allowRemote = envEnabled(env.MULTICC_ALLOW_REMOTE);
  const accessToken = String(env.ACCESS_TOKEN || '');
  if (!host || net.isIP(host) === 0 && host !== 'localhost') throw new Error(`Invalid bind host: ${host || '<empty>'}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);
  if (!isLoopbackHost(host)) {
    if (!allowRemote) throw new Error(`Refusing non-loopback bind ${host}: set MULTICC_ALLOW_REMOTE=1 explicitly`);
    // ACCESS_TOKEN 不再在启动时强制:无 token 时运行期 isAuthenticated 只放行真实本机 IP
    // (127.0.0.1,见 server.js),首次本机访问引导设置密码,设密码后外部凭密码访问。
    // 安全由 IP-based 判断保证 — 非 loopback 来源一律拒绝,伪造 Host header 也绕不过。
  }
  return { host, port, development, allowRemote, accessToken };
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
