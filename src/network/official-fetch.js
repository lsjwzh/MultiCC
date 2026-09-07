'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { EnvHttpProxyAgent } = require('undici');
const runFile = promisify(execFile);

function parseMacProxy(text) {
  const value = key => new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, 'm').exec(text)?.[1];
  const proxy = prefix => {
    if (value(`${prefix}Enable`) !== '1') return '';
    const host = value(`${prefix}Proxy`), port = Number(value(`${prefix}Port`));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return '';
    return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  };
  return { httpProxy: proxy('HTTP'), httpsProxy: proxy('HTTPS') };
}

async function readMacProxy() {
  const { stdout } = await runFile('/usr/sbin/scutil', ['--proxy'], { timeout: 2000, maxBuffer: 32768 });
  return parseMacProxy(stdout);
}

// Scoped to official upstream requests: never change the process-wide fetch
// dispatcher (local CLI -> MultiCC traffic must stay local). Explicit environment
// settings take precedence over macOS's system HTTP proxy. Refresh system settings
// periodically so toggling a desktop proxy doesn't require restarting MultiCC.
function createOfficialFetch(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const fetchImpl = options.fetch || globalThis.fetch;
  const readSystemProxy = options.readSystemProxy || readMacProxy;
  const makeDispatcher = options.createDispatcher || (config => new EnvHttpProxyAgent(config));
  const now = options.now || Date.now;
  let system = {}, checkedAt = -Infinity, pending;
  let dispatcher, dispatcherKey;

  async function configuration() {
    const http = env.http_proxy ?? env.HTTP_PROXY;
    const https = env.https_proxy ?? env.HTTPS_PROXY;
    const all = env.all_proxy ?? env.ALL_PROXY;
    if (http !== undefined || https !== undefined || all !== undefined) {
      return { httpProxy: http ?? all ?? '', httpsProxy: https ?? http ?? all ?? '', mode: 'environment-proxy' };
    }
    if (platform !== 'darwin') return { mode: 'direct' };
    if (now() - checkedAt >= 30000) {
      if (!pending) pending = Promise.resolve().then(readSystemProxy).then(value => {
        system = value; checkedAt = now();
      }).finally(() => { pending = null; });
      await pending;
    }
    return { ...system, mode: system.httpProxy || system.httpsProxy ? 'system-proxy' : 'direct' };
  }

  async function officialFetch(url, init = {}) {
    let mode = 'proxy-discovery';
    try {
      const config = await configuration();
      mode = config.mode;
      const { httpProxy = '', httpsProxy = '' } = config;
      const noProxy = env.no_proxy ?? env.NO_PROXY ?? '';
      const key = JSON.stringify([httpProxy, httpsProxy, noProxy]);
      for (const proxy of [httpProxy, httpsProxy]) {
        if (proxy && !/^https?:\/\//i.test(proxy)) throw new Error('Official upstream requires an HTTP(S) proxy URL');
      }
      if (key !== dispatcherKey) {
        const previous = dispatcher;
        dispatcher = httpProxy || httpsProxy ? makeDispatcher({ httpProxy, httpsProxy, noProxy }) : undefined;
        dispatcherKey = key;
        if (previous) Promise.resolve(previous.close()).catch(() => {});
      }
      return await fetchImpl(url, { ...init, ...(dispatcher ? { dispatcher } : {}) });
    } catch (error) {
      error.multiccProxyMode = mode;
      throw error;
    }
  }
  officialFetch.close = () => dispatcher?.close();
  return officialFetch;
}

module.exports = { parseMacProxy, createOfficialFetch, officialFetch: createOfficialFetch() };
