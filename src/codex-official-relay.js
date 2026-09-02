'use strict';

// Host-side adapter for borrowing an OpenAI Official (ChatGPT OAuth) Codex
// provider through /codex-proxy. Ordinary Codex providers are handled by
// cli-provider-router; Official is different because it has neither an API key
// nor a model_provider.base_url. Its credential lives in ~/.codex/auth.json
// (the shared login) or — for a provider marked settingsConfig.officialAccount —
// in that account's own auth.json under the multicc official-accounts store.
// Both call the ChatGPT Codex backend instead of api.openai.com.
//
// The OAuth credential never crosses the relay boundary. A borrower presents
// a provider-scoped relay-share credential; this adapter reads the host's
// current access token for each request and swaps credentials only on the
// host-to-ChatGPT hop.

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const { officialAccountIdFromProvider } = require('./official-accounts');

const DEFAULT_AUTH_FILE = path.join(os.homedir(), '.codex', 'auth.json');
const DEFAULT_UPSTREAM_URL = 'https://chatgpt.com/backend-api/codex/responses';
const OFFICIAL_AUTH_MODE = 'chatgpt';
const BUILTIN_AGENT_ROLES = new Set(['default', 'worker', 'explorer']);
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
  if (auth.OPENAI_API_KEY || config.proxyTarget
      || /(?:^|\n)\s*base_url\s*=/i.test(String(config.config || ''))) return false;
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

function normalizeCodexRole(value) {
  const raw = String(value || 'main').trim().toLowerCase();
  if (raw === 'main') {
    return { valid: true, roleKind: 'main', agentRole: null, routeName: 'main' };
  }
  if (raw === 'sub') {
    return { valid: true, roleKind: 'sub', agentRole: 'default', routeName: 'default' };
  }
  if (/^[a-z][a-z0-9_-]{0,63}$/.test(raw) && raw !== 'aux') {
    return {
      valid: true,
      roleKind: 'sub',
      agentRole: BUILTIN_AGENT_ROLES.has(raw) ? raw : 'custom',
      routeName: raw,
    };
  }
  return { valid: false, roleKind: 'sub', agentRole: 'custom', routeName: '' };
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

function normalizeResponsesUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const totalInput = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const cached = Number(
    (usage.input_tokens_details && usage.input_tokens_details.cached_tokens)
    || (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens)
    || usage.cached_input_tokens
    || 0,
  );
  const normalized = {
    inputTokens: Math.max(0, totalInput - cached),
    outputTokens: Number(usage.output_tokens || usage.completion_tokens || 0),
    cacheWrite: 0,
    cacheRead: Math.max(0, cached),
  };
  return normalized.inputTokens + normalized.outputTokens + normalized.cacheRead > 0
    ? normalized : null;
}

function reportActivity(context, phase, extra = {}) {
  if (!context || typeof context.onActivity !== 'function' || !context.sessionId) return;
  if (phase === 'first_byte') {
    if (context.firstByteReported) return;
    context.firstByteReported = true;
  }
  if (phase === 'end') {
    if (context.endReported) return;
    context.endReported = true;
  }
  try {
    context.onActivity({
      sessionId: context.sessionId,
      role: context.roleKind,
      roleKind: context.roleKind,
      agentRole: context.agentRole,
      routeName: context.routeName,
      providerId: context.providerId,
      providerName: context.providerName,
      phase,
      at: Date.now(),
      ...extra,
    });
  } catch (_) {}
}

function reportTerminal(context, usage, outcome = {}) {
  if (!context || context.terminalReported) return;
  context.terminalReported = true;
  const status = outcome.status === 'error' ? 'error' : 'success';
  reportActivity(context, 'end', { status });
  if (!context.sessionId) return;
  const event = {
    sessionId: context.sessionId,
    role: context.roleKind,
    roleKind: context.roleKind,
    agentRole: context.agentRole,
    routeName: context.routeName,
    providerId: context.providerId,
    providerName: context.providerName,
    model: context.model,
    isStream: context.streaming,
    usage,
    eventId: crypto.randomUUID(),
    protocol: 'openai-responses',
    latencyMs: Date.now() - context.startedAt,
    status,
    statusCode: outcome.statusCode == null ? context.statusCode : outcome.statusCode,
    coverage: usage ? 'observed' : 'unobservable',
    source: 'exact',
    errorCode: outcome.errorCode,
  };
  try {
    if (usage && typeof context.onUsage === 'function') context.onUsage(event);
    if (typeof context.onUsageEvent === 'function') context.onUsageEvent(event);
  } catch (_) {}
}

function emitDelta(context, delta) {
  if (!context || !context.sessionId || typeof context.onDelta !== 'function') return;
  try {
    context.onDelta(delta, {
      providerId: context.providerId,
      sessionId: context.sessionId,
      role: context.roleKind,
      roleKind: context.roleKind,
      agentRole: context.agentRole,
      routeName: context.routeName,
      model: context.model,
    });
  } catch (_) {}
}

function responseObserver(contentType) {
  return {
    buffer: '',
    isSse: /text\/event-stream/i.test(String(contentType || '')),
    toolNames: {},
    usage: null,
  };
}

function observeResponseObject(observer, value, context) {
  if (!value || typeof value !== 'object') return;
  const usage = normalizeResponsesUsage((value.response && value.response.usage) || value.usage);
  if (usage) observer.usage = usage;
  const type = String(value.type || '');
  if (type === 'response.output_item.added' && value.item && value.item.id) {
    if (value.item.type === 'function_call' || value.item.type === 'custom_tool_call'
        || value.item.type === 'apply_patch_call' || value.item.type === 'code_interpreter_call') {
      observer.toolNames[value.item.id] = value.item.name || value.item.type || '';
    }
  } else if (type === 'response.output_text.delta' && typeof value.delta === 'string') {
    emitDelta(context, { type: 'text', text: value.delta });
  } else if (type === 'response.reasoning_summary_text.delta' && typeof value.delta === 'string') {
    emitDelta(context, { type: 'reasoning', text: value.delta });
  } else if ((type === 'response.function_call_arguments.delta'
      || type === 'response.custom_tool_call_input.delta'
      || type === 'response.apply_patch_call_operation_diff.delta'
      || type === 'response.code_interpreter_call_code.delta')
      && typeof value.delta === 'string' && value.item_id) {
    emitDelta(context, {
      type: 'tool',
      tool: {
        name: observer.toolNames[value.item_id]
          || (type === 'response.custom_tool_call_input.delta' ? 'custom_tool_call' : ''),
        arguments: value.delta,
      },
      toolId: value.item_id,
    });
  } else if (type === 'response.output_text.annotation.added' && value.annotation) {
    emitDelta(context, {
      type: 'source', source: value.annotation,
      itemId: value.item_id || '', outputIndex: value.output_index,
    });
  }
}

function observeResponseChunk(observer, chunk, context) {
  observer.buffer += typeof chunk === 'string'
    ? chunk : (chunk ? Buffer.from(chunk).toString('utf8') : '');
  if (!observer.isSse) return;
  let newline;
  while ((newline = observer.buffer.indexOf('\n')) >= 0) {
    const line = observer.buffer.slice(0, newline).replace(/\r$/, '');
    observer.buffer = observer.buffer.slice(newline + 1);
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { observeResponseObject(observer, JSON.parse(payload), context); } catch (_) {}
  }
}

function finishResponseObservation(observer, context) {
  const tail = observer.buffer.trim();
  if (!tail) return observer.usage;
  try {
    const payload = observer.isSse && tail.startsWith('data:') ? tail.slice(5).trim() : tail;
    if (payload && payload !== '[DONE]') observeResponseObject(observer, JSON.parse(payload), context);
  } catch (_) {}
  return observer.usage;
}

function createCodexOfficialRelayHandler(options = {}) {
  const getProvider = options.getProvider;
  const fetchImpl = options.fetch || globalThis.fetch;
  // Credential resolution is per-PROVIDER: a provider record marked with
  // settingsConfig.officialAccount.id borrows that account's auth.json (the
  // multicc-owned credential store) instead of the shared ~/.codex/auth.json.
  // A marked provider whose account file cannot be resolved must NOT fall back
  // to the shared login — that would silently spend another account's quota.
  const readCredential = typeof options.readCredential === 'function'
    ? options.readCredential
    : (context) => {
        const accountId = officialAccountIdFromProvider(context && context.provider);
        if (accountId) {
          const authFile = typeof options.resolveAccountAuthFile === 'function'
            ? options.resolveAccountAuthFile(accountId) : null;
          if (!authFile) return { ok: false, reason: 'account_credential_unresolved' };
          return readCodexOfficialCredential({ ...options, authFile });
        }
        return readCodexOfficialCredential(options);
      };
  const upstreamUrl = options.upstreamUrl || DEFAULT_UPSTREAM_URL;
  if (typeof getProvider !== 'function') throw new TypeError('getProvider required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch required');

  return async function codexOfficialRelay(req, res, next) {
    const providerId = String(req.params && req.params.providerId || '');
    const provider = getProvider('codex', providerId);
    if (!isOfficialCodexOAuthProvider(provider)) return next();
    const role = normalizeCodexRole(req.params && req.params.role);
    if (!role.valid) return responseJson(res, 400, { error: 'invalid Codex agent route' });

    const input = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body : {};
    const streaming = input.stream !== false;
    const context = {
      providerId,
      providerName: provider.name || providerId,
      sessionId: String(req.params && req.params.sessionId || ''),
      roleKind: role.roleKind,
      agentRole: role.agentRole,
      routeName: role.routeName,
      model: String(input.model || ''),
      streaming,
      statusCode: null,
      startedAt: Date.now(),
      onActivity: options.onActivity,
      onUsage: options.onUsage,
      onUsageEvent: options.onUsageEvent,
      onDelta: options.onDelta,
      firstByteReported: false,
      endReported: false,
      terminalReported: false,
    };
    reportActivity(context, 'request');

    const credential = await readCredential({ provider, providerId });
    if (!credential || !credential.ok) {
      reportTerminal(context, null, { status: 'error', errorCode: 'OAUTH_CREDENTIAL_UNAVAILABLE' });
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
      reportTerminal(context, null, { status: 'error', errorCode: 'CLIENT_ABORTED' });
    };
    if (typeof req.once === 'function') req.once('aborted', close);
    if (typeof res.once === 'function') res.once('close', close);

    const body = { ...input, store: false };
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
      reportTerminal(context, null, { status: 'error', errorCode: 'UPSTREAM_CONNECT_FAILED' });
      return responseJson(res, 502, {
        error: 'Codex Official OAuth upstream is unreachable',
        code: 'CODEX_OFFICIAL_OAUTH_UPSTREAM_UNREACHABLE',
      });
    }

    if (!upstream.ok || !upstream.body) {
      try { if (upstream.body) await upstream.body.cancel(); } catch (_) {}
      context.statusCode = upstream.status || 502;
      reportTerminal(context, null, {
        status: 'error', statusCode: context.statusCode, errorCode: 'UPSTREAM_HTTP_ERROR',
      });
      return responseJson(res, upstream.status || 502, {
        error: 'Codex Official OAuth upstream rejected the request',
        code: 'CODEX_OFFICIAL_OAUTH_UPSTREAM_REJECTED',
        upstreamStatus: upstream.status || null,
      });
    }

    context.statusCode = upstream.status;
    setResponseHeaders(res, upstream, streaming);
    const contentType = upstream.headers && typeof upstream.headers.get === 'function'
      ? upstream.headers.get('content-type') : '';
    const observer = responseObserver(contentType);
    const reader = upstream.body.getReader();
    try {
      while (!clientClosed) {
        const { done, value } = await reader.read();
        if (done) break;
        reportActivity(context, 'first_byte', { latencyMs: Date.now() - context.startedAt });
        observeResponseChunk(observer, value, context);
        res.write(value);
      }
      if (!clientClosed) reportTerminal(context, finishResponseObservation(observer, context), { status: 'success' });
    } catch (_) {
      if (!clientClosed && streaming && !res.writableEnded) {
        try {
          res.write(`event: response.failed\ndata: ${JSON.stringify({
            type: 'response.failed',
            response: { status: 'failed', error: { message: 'Codex Official OAuth stream failed' } },
          })}\n\n`);
        } catch (_) {}
      }
      if (!clientClosed) reportTerminal(context, null, { status: 'error', errorCode: 'UPSTREAM_STREAM_FAILED' });
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
  const handler = createCodexOfficialRelayHandler(options);
  app.post(
    `${proxyPath}/:providerId/:sessionId/:role/responses`,
    handler,
  );
  // Compatibility/borrowing surface: external callers authenticated by the
  // host's relay token may still use the historical session-less endpoint. It
  // intentionally produces no attempt activity/usage attribution.
  app.post(`${proxyPath}/:providerId/responses`, handler);
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
