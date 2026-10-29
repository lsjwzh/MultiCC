'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const DIRECT_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

function ipv4(value) {
  const parts = String(value).split('.');
  return parts.length === 4 && parts.every(p => /^\d+$/.test(p) && Number(p) <= 255)
    ? parts.reduce((n, p) => n * 256 + Number(p), 0) : null;
}
function cidrToRange(entry) {
  const [host, bits] = String(entry).split('/');
  const ip = ipv4(host);
  if (ip === null || !/^\d+$/.test(bits || '') || Number(bits) > 32) return null;
  const size = 2 ** (32 - Number(bits)), start = ip - ip % size;
  const fmt = n => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.');
  return `${fmt(start)}-${fmt(start + size - 1)}`;
}
function parseMacSystemProxy(text) {
  const value = key => new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, 'm').exec(text)?.[1];
  const proxy = prefix => {
    if (value(`${prefix}Enable`) !== '1') return '';
    const host = value(`${prefix}Proxy`), port = Number(value(`${prefix}Port`));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return '';
    return `${prefix === 'SOCKS' ? 'socks5' : 'http'}://${host.includes(':') ? `[${host}]` : host}:${port}`;
  };
  const exceptions = [];
  const list = /ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/.exec(text);
  if (list) for (const line of list[1].split('\n')) {
    const item = /^\s*\d+\s*:\s*(.+?)\s*$/.exec(line)?.[1];
    if (item) exceptions.push(item);
  }
  if (value('ExcludeSimpleHostnames') === '1') exceptions.push('<local>');
  return { httpProxy: proxy('HTTP'), httpsProxy: proxy('HTTPS'), socksProxy: proxy('SOCKS'), exceptions,
    pacEnabled: value('ProxyAutoConfigEnable') === '1' || value('ProxyAutoDiscoveryEnable') === '1' };
}
async function readMacSystemProxy() {
  const { stdout } = await runFile('/usr/sbin/scutil', ['--proxy'], { timeout: 2000, maxBuffer: 32768 });
  return parseMacSystemProxy(stdout);
}
function hasProxyEnv(env) {
  return ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']
    .some(key => env[key] !== undefined);
}
// Child processes inherit the host env; when it carries proxy vars (e.g. the
// host was launched from a shell with Clash env exported), loopback hops such
// as the local CPR at 127.0.0.1 must stay direct even for tools that never
// consult the macOS system-proxy exception list.
function mergeLoopbackNoProxy(env) {
  const entries = [env && env.no_proxy, env && env.NO_PROXY]
    .flatMap(value => String(value || '').split(/[\s,]+/)).filter(Boolean);
  const merged = [...new Set([...entries, ...DIRECT_HOSTS])].join(',');
  return { ...(env || {}), no_proxy: merged, NO_PROXY: merged };
}
function ensureLoopbackNoProxyEnv(env) {
  if (!env || typeof env !== 'object' || !hasProxyEnv(env)) return env;
  return mergeLoopbackNoProxy(env);
}
function resolveProxyConfig(env, system) {
  const explicit = hasProxyEnv(env);
  const http = env.http_proxy ?? env.HTTP_PROXY, https = env.https_proxy ?? env.HTTPS_PROXY;
  const all = env.all_proxy ?? env.ALL_PROXY;
  const httpProxy = explicit ? (http ?? all ?? '') : (system?.httpProxy || '');
  const httpsProxy = explicit ? (https ?? http ?? all ?? '') : (system?.httpsProxy || '');
  if (!explicit && (!httpProxy || !httpsProxy) && (system?.socksProxy || system?.pacEnabled)) {
    throw new Error('系统代理仅配置了 SOCKS/PAC；请配置 HTTP(S) 代理，已阻止静默直连');
  }
  for (const proxy of [httpProxy, httpsProxy]) {
    if (!proxy) continue;
    let parsed;
    try { parsed = new URL(proxy); } catch (_) { /* do not expose proxy credentials */ }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('代理地址必须是 HTTP(S) proxy URL；已阻止静默直连');
    }
  }
  const exceptions = explicit ? [] : system?.exceptions || [];
  const noProxy = [...new Set([...DIRECT_HOSTS,
    ...String(env.no_proxy ?? env.NO_PROXY ?? '').split(/[\s,]+/).filter(Boolean), ...exceptions])];
  return { httpProxy, httpsProxy, noProxy,
    mode: httpProxy || httpsProxy ? (explicit ? 'environment-proxy' : 'system-proxy') : 'direct' };
}
function isLoopback(host) {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '');
  return name === 'localhost' || name.endsWith('.localhost') || name === '::1'
    || /^127\./.test(name) || /^::ffff:127\./.test(name) || /^::ffff:7f[0-9a-f]{2}:/.test(name);
}
function bypassProxy(url, entries) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isLoopback(host)) return true;
  const port = url.port || (['https:', 'wss:'].includes(url.protocol) ? '443' : '80');
  return entries.some(raw => {
    let item = raw.toLowerCase();
    if (item === '*') return true;
    if (item === '<local>') return !host.includes('.') && !host.includes(':');
    const withPort = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(item);
    if (withPort) { if (port !== withPort[2]) return false; item = withPort[1]; }
    item = item.replace(/^\[|\]$/g, '');
    const range = cidrToRange(item) || item;
    if (range.includes('-')) {
      const [start, end] = range.split('-').map(ipv4), ip = ipv4(host);
      if (start != null && end != null && ip !== null) return ip >= start && ip <= end;
    }
    if (item.startsWith('*.')) return host.endsWith(item.slice(1));
    if (item.startsWith('.')) return host === item.slice(1) || host.endsWith(item);
    return host === item;
  });
}
function createProxyPolicy(options = {}) {
  const env = options.env || process.env, platform = options.platform || process.platform;
  const readSystem = options.readSystemProxy || readMacSystemProxy, now = options.now || Date.now;
  let system, checkedAt = -Infinity, pending;
  async function configuration() {
    if (platform === 'darwin' && !hasProxyEnv(env) && now() - checkedAt >= (options.refreshMs ?? 30000)) {
      if (!pending) pending = Promise.resolve().then(readSystem).then(value => {
        system = value; checkedAt = now();
      }).catch(error => {
        if (!system) throw error;
        checkedAt = now(); // preserve last known policy, never a direct fallback
      }).finally(() => { pending = null; });
      await pending;
    }
    return resolveProxyConfig(env, system);
  }
  async function proxyForUrl(input) {
    const url = new URL(input);
    if (isLoopback(url.hostname)) return ''; // local IPC survives discovery failure
    const config = await configuration();
    return bypassProxy(url, config.noProxy) ? ''
      : ['https:', 'wss:'].includes(url.protocol) ? config.httpsProxy : config.httpProxy;
  }
  return { configuration, proxyForUrl, invalidate() { checkedAt = -Infinity; } };
}
module.exports = { createProxyPolicy, parseMacSystemProxy, readMacSystemProxy,
  resolveProxyConfig, cidrToRange, bypassProxy, isLoopback, hasProxyEnv,
  mergeLoopbackNoProxy, ensureLoopbackNoProxyEnv };
