'use strict';

const { getNative } = require('../native/binding');

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
function cidrToRange(entry) { return getNative().outboundCidr(String(entry)) ?? null; }
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
function hasProxyEnv(env) { return getNative().outboundProxyEnv(env); }
function mergeLoopbackNoProxy(env) { return getNative().outboundMergeEnv(env); }
function ensureLoopbackNoProxyEnv(env) {
  if (!env || typeof env !== 'object' || !hasProxyEnv(env)) return env;
  return mergeLoopbackNoProxy(env);
}
function resolveProxyConfig(env, system) {
  return getNative().outboundResolve(env, system, hasProxyEnv(env), value => {
    try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
  });
}
function isLoopback(host) { return getNative().outboundLoopback(host.toLowerCase()); }
function bypassProxy(url, entries) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isLoopback(host)) return true;
  const port = url.port || (['https:', 'wss:'].includes(url.protocol) ? '443' : '80');
  return entries.some(raw => getNative().outboundBypassEntry(host, port, raw.toLowerCase()));
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
