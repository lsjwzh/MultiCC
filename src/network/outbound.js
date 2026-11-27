'use strict';

// One policy for fetch, HTTP/WebSocket agents and child process environments.
const { Agent, ProxyAgent: FetchProxyAgent, Dispatcher, Request, fetch: undiciFetch } = require('undici');
const { ProxyAgent } = require('proxy-agent');
const { createProxyPolicy, isLoopback } = require('../native/binding').proxyPolicy;

async function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  let onAbort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', onAbort); }
}

class RoutingDispatcher extends Dispatcher {
  constructor(policy) {
    super();
    this.policy = policy;
    this.direct = new Agent();
    this.proxies = new Map();
    this.closed = false;
  }
  dispatch(options, handler) {
    Promise.resolve().then(async () => {
      const proxy = await this.policy.proxyForUrl(String(options.origin));
      if (this.closed) throw new Error('网络请求入口已关闭');
      let dispatcher = this.direct;
      if (proxy) {
        if (!this.proxies.has(proxy)) this.proxies.set(proxy, new FetchProxyAgent(proxy));
        dispatcher = this.proxies.get(proxy);
      }
      dispatcher.dispatch(options, handler);
    }).catch(error => handler.onError(error));
    return true;
  }
  async close() {
    this.closed = true;
    await Promise.all([this.direct, ...this.proxies.values()].map(d => d.close()));
  }
  async destroy(error) {
    this.closed = true;
    await Promise.all([this.direct, ...this.proxies.values()].map(d => d.destroy(error)));
  }
}

function createOutbound(options = {}) {
  const policy = options.policy || createProxyPolicy(options);
  const dispatcher = new RoutingDispatcher(policy);
  const agent = new ProxyAgent({ getProxyForUrl: url => policy.proxyForUrl(url) });
  const fetchImpl = options.fetch || undiciFetch;
  async function outboundFetch(url, init = {}) {
    let mode = 'proxy-discovery';
    try {
      // Node and npm undici have different Request classes. Convert a native
      // Request through its public properties, preserving body and cancellation.
      if (url && typeof url.url === 'string' && !(url instanceof Request)) {
        if (url.bodyUsed) throw new TypeError('请求正文已经被读取');
        url = new Request(url.url, url);
      }
      const signal = init.signal ?? url?.signal;
      signal?.throwIfAborted();
      const target = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
      if (isLoopback(target.hostname)) mode = 'direct';
      else mode = (await abortable(policy.configuration(), signal)).mode;
      // Re-evaluate redirects too. Never replay a model POST after an error.
      return await fetchImpl(url, { ...init, dispatcher });
    } catch (error) {
      if (error && typeof error === 'object') error.multiccProxyMode = mode;
      throw error;
    }
  }
  async function getChildProxyEnv(baseEnv = process.env) {
    const config = await policy.configuration(), env = { ...baseEnv };
    for (const [lower, value] of Object.entries({ http_proxy: config.httpProxy,
      https_proxy: config.httpsProxy, no_proxy: config.noProxy.join(',') })) {
      env[lower] = value; env[lower.toUpperCase()] = value;
    }
    delete env.all_proxy; delete env.ALL_PROXY;
    return env;
  }
  async function close() {
    agent.destroy(); agent.httpAgent.destroy(); agent.httpsAgent.destroy();
    await dispatcher.close();
  }
  outboundFetch.close = close;
  return { outboundFetch, outboundAgent: agent, outboundDispatcher: dispatcher,
    getChildProxyEnv, policy, close };
}
const shared = createOutbound();
module.exports = { ...shared, createOutbound, RoutingDispatcher };
// Capture the same SDK exports on first official use, after injected-fetch selection.
Object.defineProperty(module.exports, 'official', { configurable: true, get() {
  const { createOutbound, outboundFetch } = module.exports;
  const { parseMacSystemProxy } = require('../native/binding').proxyPolicy;
  function parseMacProxy(text) {
    const { httpProxy, httpsProxy } = parseMacSystemProxy(text);
    return { httpProxy, httpsProxy };
  }
  function createOfficialFetch(options) { return createOutbound(options).outboundFetch; }
  const value = { parseMacProxy, createOfficialFetch, officialFetch: outboundFetch };
  return Object.defineProperty(module.exports, 'official', { value, writable: true }).official;
}});
