'use strict';

// Per-account egress for the login handshake.
//
// An official account's dedicated egress used to start applying only after the
// account existed and had been bound in the editor — the PKCE token exchange
// ran on the host's default network, so one of the two calls that establish the
// account (authorize happens in the user's browser, exchange happens here)
// could leave from a different, possibly polluted IP. This module builds a
// fetch for that exchange that dials through the account's bound egress profile
// (same plugin identity the request path uses), and fails closed when the
// profile cannot be resolved instead of silently falling back to the host.

const http = require('node:http');
const https = require('node:https');
const { ProxyAgent } = require('proxy-agent');

// Minimal fetch-compatible response: the OAuth modules only read status,
// headers, text() and json().
function responseOf(url, res, body) {
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    statusText: res.statusMessage || '',
    headers: res.headers,
    url: String(url),
    async text() { return body; },
    async json() { return JSON.parse(body); },
  };
}

// `fetchImpl` is only the shape of a fetch implementation; `fallback` (when
// given) is used for URLs this shim does not speak (file:, data: …). Anything
// else must go through the proxy: no direct dial is allowed here.
function createEgressFetch(proxyUrl, fallback) {
  const agent = new ProxyAgent({ getProxyForUrl: () => proxyUrl });
  return function egressFetch(input, init = {}) {
    const raw = typeof input === 'string' ? input : (input && input.url);
    let url;
    try { url = new URL(String(raw)); } catch (_) { url = null; }
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      if (fallback) return fallback(input, init);
      return Promise.reject(new Error(`专用出口只支持 HTTP(S) 请求：${raw}`));
    }
    return new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(url, {
        method: init.method || 'GET',
        headers: init.headers || {},
        agent,
        signal: init.signal,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(responseOf(url, res, Buffer.concat(chunks).toString('utf8'))));
        res.on('error', reject);
      });
      req.on('error', reject);
      if (init.body != null) req.write(init.body);
      req.end();
    });
  };
}

// Resolve the account's bound egress right before the login exchange. Returns
// null when the account has no binding (caller keeps the host's fetch), and
// throws when a binding exists but its profile cannot be resolved — the same
// fail-closed contract as the request path (src/claude-auth/egress-agent.js).
function createAccountEgressFetch({
  providers, appType, providerIdForAccount, resolveProxyUrl, logger,
} = {}) {
  const resolve = resolveProxyUrl || (() => {
    const { createClaudeEgressAgentResolver } = require('../claude-auth/egress-agent');
    return createClaudeEgressAgentResolver({ logger }).resolveProxyUrl;
  })();
  return async function egressFetchForAccount(accountId) {
    const providerId = providerIdForAccount ? providerIdForAccount(appType, accountId) : '';
    if (!providerId) return null;
    const provider = providers.getProvider(appType, providerId);
    const binding = provider && provider.egressBinding;
    if (!binding) return null;
    const proxyUrl = await resolve({ provider, providerId });
    return createEgressFetch(proxyUrl);
  };
}

// The add-account body carries the binding picked before the login link is
// generated. Validate it up front so a malformed body never creates an account
// that cannot be bound afterwards. `null`/absent = no binding.
function parseEgressBinding(body) {
  const value = body && body.egressBinding;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('egressBinding must be an object with pluginId and profileId');
  }
  const pluginId = String(value.pluginId || '').trim();
  const profileId = String(value.profileId || '').trim();
  if (!pluginId || !profileId) throw new Error('egressBinding needs pluginId and profileId');
  return { pluginId, profileId };
}

module.exports = { createEgressFetch, createAccountEgressFetch, parseEgressBinding };
