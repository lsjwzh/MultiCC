'use strict';

// Claude official OAuth (PKCE) protocol client — a Node port of CLIProxyAPI's
// internal/auth/claude (Anthropic's public Claude Code client_id). Plain Node
// fetch passes Cloudflare on these control-plane endpoints (spiked 2026-09),
// so no uTLS is needed; the axios-shaped headers mirror the native client.
//
//   authorize:  https://claude.ai/oauth/authorize  (browser)
//   exchange:   POST https://platform.claude.com/v1/oauth/token
//   refresh:    POST https://platform.claude.com/v1/oauth/token
//   profile:    GET  https://api.anthropic.com/api/oauth/profile
//   usage:      GET  https://api.anthropic.com/api/oauth/usage
//   callback:   http://localhost:54545/callback?code=...&state=...
//
// This module is transport + parsing only. Persistence lives in
// official-accounts.js; singleflight/backoff policy in
// claude-account-credentials.js.

const crypto = require('node:crypto');
const http = require('node:http');

const AUTH_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT_URI = 'http://localhost:54545/callback';
const SCOPE = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const CALLBACK_PORT = 54545;

const REFRESH_MIN_BACKOFF_MS = 5 * 1000;
const REFRESH_MAX_BACKOFF_MS = 5 * 60 * 1000;
const TOKEN_TIMEOUT_MS = 30000;

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function generatePkce() {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function generateState() {
  return base64url(crypto.randomBytes(24));
}

function buildAuthorizeUrl({ state, codeChallenge }) {
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

// The axios-shaped header set the native client emits (CPA's
// applyClaudeOAuthAxiosHeaders). Cloudflare keys on this shape.
function axiosHeaders(extra = {}) {
  return {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': 'axios/1.15.2',
    ...extra,
  };
}

class ClaudeOAuthError extends Error {
  constructor(message, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'ClaudeOAuthError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
  get retryable() {
    return this.status == null || this.status >= 500;
  }
}

function clampBackoff(ms) {
  return Math.min(REFRESH_MAX_BACKOFF_MS, Math.max(REFRESH_MIN_BACKOFF_MS, ms));
}

// Retry-After may be seconds, an HTTP date, or Retry-After-Ms (CPA).
function parseRetryAfterMs(headers) {
  if (!headers) return REFRESH_MIN_BACKOFF_MS;
  const get = typeof headers.get === 'function' ? k => headers.get(k) : k => headers[k];
  const raw = String(get('retry-after') || '').trim();
  if (raw) {
    if (/^\d+(\.\d+)?$/.test(raw)) return clampBackoff(Number(raw) * 1000);
    const when = Date.parse(raw);
    if (Number.isFinite(when)) return clampBackoff(when - Date.now());
  }
  const rawMs = String(get('retry-after-ms') || '').trim();
  if (rawMs && /^\d+(\.\d+)?$/.test(rawMs)) return clampBackoff(Number(rawMs));
  return REFRESH_MIN_BACKOFF_MS;
}

async function postToken(fetchImpl, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TOKEN_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: axiosHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (res.status === 429) {
    throw new ClaudeOAuthError(`token endpoint rate-limited: ${text.slice(0, 200)}`, {
      status: 429,
      retryAfterMs: parseRetryAfterMs(res.headers),
    });
  }
  if (res.status !== 200) {
    throw new ClaudeOAuthError(`token endpoint HTTP ${res.status}: ${text.slice(0, 200)}`, { status: res.status });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new ClaudeOAuthError('token endpoint returned non-JSON', { status: res.status });
  }
  return json;
}

// Normalize the token endpoint's response into the CPA-shaped field set the
// account store persists (snake_case mirrors ClaudeTokenStorage).
function normalizeTokenResponse(json, { refreshTokenFallback = '', now = () => Date.now() } = {}) {
  const accessToken = String(json.access_token || '');
  if (!accessToken) throw new ClaudeOAuthError('token response missing access_token');
  const expiresIn = Number(json.expires_in);
  return {
    access_token: accessToken,
    refresh_token: String(json.refresh_token || refreshTokenFallback || ''),
    email: String((json.account && json.account.email_address) || ''),
    account_uuid: String((json.account && json.account.uuid) || ''),
    organization_uuid: String((json.organization && json.organization.uuid) || ''),
    organization_name: String((json.organization && json.organization.name) || ''),
    expired: new Date(now() + (Number.isFinite(expiresIn) ? expiresIn : 0) * 1000).toISOString(),
    last_refresh: new Date(now()).toISOString(),
  };
}

// The callback code may carry the state as a `#state` fragment; a fragment
// state takes precedence over the query one (CPA parseCodeAndState).
function parseCodeAndState(code, state) {
  const splits = String(code || '').split('#');
  return { code: splits[0], state: splits.length > 1 && splits[1] ? splits[1] : state };
}

async function exchangeCode(fetchImpl, { code, state, codeVerifier, now }) {
  const parsed = parseCodeAndState(code, state);
  // Field order mirrors the native client's wire order (CPA).
  const json = await postToken(fetchImpl, {
    grant_type: 'authorization_code',
    code: parsed.code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
    state: parsed.state,
  });
  return normalizeTokenResponse(json, { now });
}

async function refreshTokens(fetchImpl, { refreshToken, now }) {
  const json = await postToken(fetchImpl, {
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPE,
  });
  // A refresh response may omit refresh_token — the old one stays valid (CPA).
  return normalizeTokenResponse(json, { refreshTokenFallback: refreshToken, now });
}

async function fetchProfile(fetchImpl, accessToken) {
  const res = await timedFetch(fetchImpl, PROFILE_URL, {
    headers: axiosHeaders({
      Authorization: `Bearer ${accessToken}`,
      'Cache-Control': 'no-cache',
    }),
  });
  if (!res.ok) throw new ClaudeOAuthError(`profile HTTP ${res.status}`, { status: res.status });
  const json = await res.json();
  return {
    email: String((json.account && json.account.email) || ''),
    account_uuid: String((json.account && json.account.uuid) || ''),
    organization_uuid: String((json.organization && json.organization.uuid) || ''),
    organization_name: String((json.organization && json.organization.name) || ''),
  };
}

// Control-plane GETs got no abort at all, so a stalled api.anthropic.com
// connection hung the quota route (and the refresh supervisor's profile read)
// until the socket's own keep-alive gave up — minutes. Same 30s budget as the
// token endpoint.
async function timedFetch(fetchImpl, url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TOKEN_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Per-account subscription usage (5h / weekly windows) — the endpoint the CLI's
// /usage reads. Returns the raw parsed body; shaping is the caller's job.
async function fetchUsage(fetchImpl, accessToken) {
  const res = await timedFetch(fetchImpl, USAGE_URL, {
    headers: axiosHeaders({
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Cache-Control': 'no-cache',
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ClaudeOAuthError(`usage HTTP ${res.status}: ${text.slice(0, 200)}`, {
      status: res.status,
      retryAfterMs: res.status === 429 ? parseRetryAfterMs(res.headers) : null,
    });
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new ClaudeOAuthError('usage endpoint returned non-JSON', { status: res.status });
  }
}

const LOGIN_PAGE_OK = '<!doctype html><meta charset="utf-8"><title>multicc</title><body style="font-family:system-ui;padding:2em">✅ 登录完成，可以关闭本页，回到 multicc 查看账号。<br>Login complete — you can close this tab.</body>';
const LOGIN_PAGE_ERR = '<!doctype html><meta charset="utf-8"><title>multicc</title><body style="font-family:system-ui;padding:2em">❌ 登录失败，请回 multicc 重试。<br>Login failed — please retry from multicc.</body>';

// One-shot loopback listener for the OAuth redirect. Single-use: closes after
// the first /callback hit (or timeout). The port is a fixed part of the
// registered redirect_uri, so only one login can be in flight at a time —
// callers enforce that.
function waitForCallback({ timeoutMs = 5 * 60 * 1000, port = CALLBACK_PORT } = {}) {
  let server;
  let timer;
  const promise = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      let url;
      try {
        url = new URL(req.url || '/', 'http://127.0.0.1');
      } catch (_) {
        res.writeHead(400); res.end(); return;
      }
      if (url.pathname !== '/callback') {
        res.writeHead(404); res.end(); return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code') || '';
      const state = url.searchParams.get('state') || '';
      if (error || !code) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(LOGIN_PAGE_ERR);
        finish(() => reject(new ClaudeOAuthError(`authorization failed: ${error || 'missing code'}`)));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(LOGIN_PAGE_OK);
      finish(() => resolve({ code, state }));
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1');
    timer = setTimeout(() => {
      finish(() => reject(new ClaudeOAuthError('login timed out waiting for the browser callback')));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });

  function finish(settle) {
    clearTimeout(timer);
    try {
      if (server) server.close(() => settle());
      else settle();
    } catch (_) {
      settle();
    }
  }

  return {
    promise,
    cancel: () => finish(() => {}),
    address: () => (server && server.address()) || null,
  };
}

module.exports = {
  AUTH_URL,
  TOKEN_URL,
  PROFILE_URL,
  USAGE_URL,
  CLIENT_ID,
  REDIRECT_URI,
  SCOPE,
  CALLBACK_PORT,
  REFRESH_MIN_BACKOFF_MS,
  REFRESH_MAX_BACKOFF_MS,
  ClaudeOAuthError,
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  parseRetryAfterMs,
  parseCodeAndState,
  exchangeCode,
  refreshTokens,
  fetchProfile,
  fetchUsage,
  waitForCallback,
};
