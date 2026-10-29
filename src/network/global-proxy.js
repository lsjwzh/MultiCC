'use strict';

const http = require('node:http');
const https = require('node:https');
const { createOutbound } = require('./outbound');
const { parseMacSystemProxy, resolveProxyConfig, cidrToRange } = require('./proxy-policy');
function resolveProxyEnv(env, system) {
  const config = resolveProxyConfig(env, system);
  return config.httpProxy || config.httpsProxy ? {
    HTTP_PROXY: config.httpProxy, HTTPS_PROXY: config.httpsProxy,
    NO_PROXY: config.noProxy.join(','),
  } : null;
}

// Latest successful refresh, readable synchronously by spawn-time code paths
// (buildChildEnv is sync). mode 'system-proxy' means the macOS system proxy is
// what traffic currently follows; env carries the merged child proxy variables.
let latest = null;

// Requests await discovery themselves, even before startup initialization ends.
// This compatibility layer works without Node's newer setGlobalProxyFromEnv API.
function installGlobalProxy(options = {}) {
  const shared = Object.keys(options).length ? createOutbound(options) : require('./outbound');
  const policy = shared.policy;
  const log = options.log || (message => console.log(`[multicc] ${message}`));
  const previous = { fetch: globalThis.fetch, http: http.globalAgent, https: https.globalAgent };
  if (!options.apply) {
    globalThis.fetch = shared.outboundFetch;
    http.globalAgent = shared.outboundAgent;
    https.globalAgent = shared.outboundAgent;
  }
  let timer, lastKey;
  async function refresh() {
    policy.invalidate();
    const config = await policy.configuration();
    const env = config.httpProxy || config.httpsProxy ? {
      HTTP_PROXY: config.httpProxy, HTTPS_PROXY: config.httpsProxy, NO_PROXY: config.noProxy.join(','),
    } : null;
    latest = { env, mode: config.mode };
    const key = JSON.stringify(env);
    if (key !== lastKey) {
      lastKey = key;
      options.apply?.(env);
      log(env ? '出站请求已使用统一代理配置' : '出站请求未配置代理');
    }
    return env;
  }
  // Startup reporting never grants permission for requests to bypass policy.
  const report = error => { log(`代理配置读取失败，外部请求将拒绝发送：${error.message}`); return null; };
  const ready = refresh().catch(report);
  if (options.refresh !== false) {
    timer = setInterval(() => { refresh().catch(report); }, options.refreshMs || 60000);
    timer.unref?.();
  }
  return { ready, refresh, stop() {
    clearInterval(timer);
    if (!options.apply) {
      if (globalThis.fetch === shared.outboundFetch) globalThis.fetch = previous.fetch;
      if (http.globalAgent === shared.outboundAgent) http.globalAgent = previous.http;
      if (https.globalAgent === shared.outboundAgent) https.globalAgent = previous.https;
    }
  } };
}
function latestChildProxyEnv() {
  return latest ? latest.env : null;
}
function latestProxyMode() {
  return latest ? latest.mode : 'direct';
}
// Codex (Rust/reqwest) reads the macOS system proxy when no env proxy vars
// exist, and Clash-style proxies without a loopback exception then forward
// 127.0.0.1 hops to a remote node that can never reach the local port — the
// request dies inside the CLI with an empty-body 502 before reaching the host.
// Surface that as an actionable hint on the turn's failure notice.
function systemProxyHijackHint({ cli, httpStatus, detail } = {}) {
  if (cli !== 'codex' || latest?.mode !== 'system-proxy') return null;
  const text = `${detail == null ? '' : detail}`;
  if (httpStatus !== 502 && !/502|unknown error|empty (body|response)/i.test(text)) return null;
  return '疑似系统代理劫持：codex 会直接读取 macOS 系统代理，发往本地网关 127.0.0.1 的请求'
    + '被代理转发到远端节点后无法回连本机（表现为 502/空响应）。请在代理软件的系统代理'
    + '例外（bypass）列表加入 127.0.0.1 与 localhost，或在规则最前面加 '
    + 'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve 与 IP-CIDR6,::1/128,DIRECT,no-resolve；'
    + '关闭系统代理后重试也可立即恢复。';
}
module.exports = {
  installGlobalProxy, resolveProxyEnv, parseMacSystemProxy, cidrToRange,
  latestChildProxyEnv, latestProxyMode, systemProxyHijackHint,
  resetLatestForTests() { latest = null; },
};
