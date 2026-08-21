'use strict';

// Host-side adapter for borrowing an OpenAI Official (ChatGPT OAuth) Codex
// provider through /codex-proxy. Ordinary Codex providers are handled by
// cli-provider-router; Official is different because it has neither an API key
// nor a model_provider.base_url. Its credential lives in ~/.codex/auth.json and
// calls the ChatGPT Codex backend instead of api.openai.com.
//
// The OAuth credential never crosses the relay boundary. A borrower presents
// MULTICC_PROXY_TOKEN to MultiCC's existing auth middleware; this adapter reads
// the host's current access token for each request and swaps credentials only
// on the host-to-ChatGPT hop.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_AUTH_FILE = path.join(os.homedir(), '.codex', 'auth.json');
const DEFAULT_UPSTREAM_URL = 'https://chatgpt.com/backend-api/codex/responses';
const OFFICIAL_AUTH_MODE = 'chatgpt';
const mountedApps = new WeakSet();

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    const seconds = Number(payload && payload.exp);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  } catch (_) {
    return null;
  }
}

function isOfficialCodexOAuthProvider(provider) {
  if (!provider || provider.appType !== 'codex') return false;
  const config = parseObject(provider.settingsConfig);
  const auth = parseObject(config.auth);
  if (auth.OPENAI_API_KEY || config.proxyTarget) return false;
  return String(auth.auth_mode || '').toLowerCase() === OFFICIAL_AUTH_MODE;
}

function readCodexOfficialCredential(options = {}) {
  const authFile = options.authFile || DEFAULT_AUTH_FILE;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let auth;
  try {
    auth = parseObject(readFileSync(authFile, 'utf8'));
  } catch (_) {
    return { ok: false, reason: 'credential_unreadable' };
  }
  const tokens = parseObject(auth.tokens);
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token.trim() : '';
  const accountId = typeof tokens.account_id === 'string' ? tokens.account_id.trim() : '';
  if (!accessToken) return { ok: false, reason: 'access_token_missing' };
  if (!accountId) return { ok: false, reason: 'account_id_missing' };
  const expiresAt = jwtExpiryMs(accessToken);
  if (expiresAt && expiresAt <= now()) return { ok: false, reason: 'access_token_expired', expiresAt };
  return { ok: true, accessToken, accountId, expiresAt };
}

function normalizeProxyPath(value) {
  return '/' + String(value || '/codex-proxy').replace(/^\/+|\/+$/g, '');
}

function responseJson(res, status, body) {
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    return res.status(status).json(body);
  }
  res.statusCode = status;
  if (typeof res.setHeader === 'function') res.setHeader('content-type', 'application/json; charset=utf-8');
  if (typeof res.end === 'function') res.end(JSON.stringify(body));
  return undefined;
}

function upstreamHeaders(credential) {
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    'ChatGPT-Account-Id': credential.accountId,
    originator: 'codex_cli_rs',
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': 'codex_cli_rs/multicc-relay',
  };
}

function setResponseHeaders(res, upstream, streaming) {
  if (typeof res.status === 'function') res.status(upstream.status);
  else res.statusCode = upstream.status;
  const contentType = upstream.headers && typeof upstream.headers.get === 'function'
    ? upstream.headers.get('content-type') : '';
  res.setHeader('Content-Type', contentType || (streaming ? 'text/event-stream' : 'application/json'));
  if (streaming) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
  }
  const requestId = upstream.headers && typeof upstream.headers.get === 'function'
    ? upstream.headers.get('x-request-id') : '';
  if (requestId) res.setHeader('X-Request-Id', requestId);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function createCodexOfficialRelayHandler(options = {}) {
  const getProvider = options.getProvider;
  const fetchImpl = options.fetch || globalThis.fetch;
  const readCredential = options.readCredential || (() => readCodexOfficialCredential(options));
  const upstreamUrl = options.upstreamUrl || DEFAULT_UPSTREAM_URL;
  if (typeof getProvider !== 'function') throw new TypeError('getProvider required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch required');

  return async function codexOfficialRelay(req, res, next) {
    const providerId = String(req.params && req.params.providerId || '');
    const provider = getProvider('codex', providerId);
    if (!isOfficialCodexOAuthProvider(provider)) return next();

    const credential = await readCredential();
    if (!credential || !credential.ok) {
      return responseJson(res, 503, {
        error: 'Codex Official OAuth credential is unavailable on the relay host',
        code: 'CODEX_OFFICIAL_OAUTH_UNAVAILABLE',
        reason: credential && credential.reason || 'credential_unavailable',
      });
    }

    const controller = new AbortController();
    let clientClosed = false;
    const close = () => {
      if (res.writableEnded) return;
      clientClosed = true;
      controller.abort();
    };
    if (typeof req.once === 'function') req.once('aborted', close);
    if (typeof res.once === 'function') res.once('close', close);

    const input = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body : {};
    const body = { ...input, store: false };
    const streaming = input.stream !== false;
    body.stream = streaming;

    let upstream;
    try {
      upstream = await fetchImpl(upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders(credential),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (_) {
      if (clientClosed) return undefined;
      return responseJson(res, 502, {
        error: 'Codex Official OAuth upstream is unreachable',
        code: 'CODEX_OFFICIAL_OAUTH_UPSTREAM_UNREACHABLE',
      });
    }

    if (!upstream.ok || !upstream.body) {
      try { if (upstream.body) await upstream.body.cancel(); } catch (_) {}
      return responseJson(res, upstream.status || 502, {
        error: 'Codex Official OAuth upstream rejected the request',
        code: 'CODEX_OFFICIAL_OAUTH_UPSTREAM_REJECTED',
        upstreamStatus: upstream.status || null,
      });
    }

    setResponseHeaders(res, upstream, streaming);
    const reader = upstream.body.getReader();
    try {
      while (!clientClosed) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch (_) {
      if (!clientClosed && streaming && !res.writableEnded) {
        try {
          res.write(`event: response.failed\ndata: ${JSON.stringify({
            type: 'response.failed',
            response: { status: 'failed', error: { message: 'Codex Official OAuth stream failed' } },
          })}\n\n`);
        } catch (_) {}
      }
    } finally {
      try { await reader.cancel(); } catch (_) {}
      if (!res.writableEnded) res.end();
    }
    return undefined;
  };
}

function mountCodexOfficialRelay(app, options = {}) {
  if (!app || typeof app.post !== 'function' || mountedApps.has(app)) return false;
  mountedApps.add(app);
  const proxyPath = normalizeProxyPath(options.codexProxyPath || options.mountPath);
  app.post(`${proxyPath}/:providerId/responses`, createCodexOfficialRelayHandler(options));
  return true;
}

module.exports = {
  DEFAULT_AUTH_FILE,
  DEFAULT_UPSTREAM_URL,
  createCodexOfficialRelayHandler,
  isOfficialCodexOAuthProvider,
  mountCodexOfficialRelay,
  readCodexOfficialCredential,
};
