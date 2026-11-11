'use strict';
// 路由由 Rust 前门独占（native/gateway/src/app/model_catalogs.rs）：路径参数、
// 状态码、Cache-Control 与响应形状都在那边；这里的 provider store 投影与 3s 上游
// 抓取（含进程内 1h 缓存 / 60s 失败冷却）只经宿主端口 src/routes/model-catalogs-host.js 提供。

// GET /api/providers/:id/models — live model catalog for ONE stored provider.
//
// Relay (借道) providers are user-configured third-party gateways. Their model
// list moves upstream (a vendor renames/retires an id), but the picker used to
// show only the static `modelOptions` snapshot written when the provider was
// created. The opencode lanes already learned this lesson (see
// routes/opencode-models.js): GET `{baseURL}/models` on every cache miss, keep
// the static list when the gateway cannot answer.
//
// Security contract:
//   * The provider id is the ONLY input. base URL and credential come from the
//     server-side provider store — a query-string baseURL is ignored (SSRF).
//   * The response never carries a token, not even masked.
//   * Unreachable / unauthorised gateways are a normal 200 + fallback, never a
//     5xx: the picker must keep working while a relay is down.
//
// The same fetch is reused by /api/codex/models so a codex relay's 刷新模型 no
// longer fails with "账号线路不存在" (that endpoint only serves OAuth accounts).

const MAX_MODELS = 1000;
const MAX_MODEL_LENGTH = 200;
const PROVIDER_MODELS_TTL_MS = 60 * 60 * 1000; // 1 hour
const PROVIDER_MODELS_FAILURE_TTL_MS = 60 * 1000;
const PROVIDER_MODELS_HTTP_TIMEOUT_MS = 3000;
// Model ids are opaque wire strings; only reject control characters and
// absurd lengths. Gateways legitimately use '/', ':', '.', '-', '_', '[' etc.
const MODEL_ID_RE = /^[^\u0000-\u001f\u007f]+$/;

function isRefresh(value) {
  return /^(?:1|true)$/i.test(String(value || ''));
}

function modelsEndpointFor(baseURL) {
  const base = typeof baseURL === 'string' ? baseURL.trim().replace(/\/+$/, '') : '';
  if (!base) return null;
  return /\/models$/i.test(base) ? base : `${base}/models`;
}

function isAnthropicFormat(summary) {
  const format = String((summary && summary.apiFormat) || (summary && summary.protocol) || '').toLowerCase();
  return format === 'anthropic' || format === 'anthropic_messages' || format === 'messages';
}

function authHeaders(summary, apiKey) {
  const headers = { accept: 'application/json' };
  if (isAnthropicFormat(summary)) {
    // api.anthropic.com authenticates with x-api-key; many Anthropic-compatible
    // relays accept a Bearer token instead. Send both when a key exists — an
    // upstream ignores the header it does not know.
    if (apiKey) {
      headers['x-api-key'] = apiKey;
      headers.authorization = `Bearer ${apiKey}`;
    }
    headers['anthropic-version'] = '2023-06-01';
    return headers;
  }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function normalizeModelId(value) {
  const model = String(value == null ? '' : value).trim();
  if (!model || model.length > MAX_MODEL_LENGTH || !MODEL_ID_RE.test(model)) return '';
  return model;
}

function pushModel(out, seen, model, label) {
  const id = normalizeModelId(model);
  if (!id || seen.has(id)) return;
  seen.add(id);
  const text = String(label == null ? '' : label).trim();
  out.push(Object.freeze({ model: id, label: (text && text !== id) ? text : id }));
}

// Accept every shape we have actually met:
//   [{id|model, name|display_name|label}, ...]                  (a bare array)
//   { data: [ ... ] }                                            (OpenAI/Anthropic)
//   { models: [ ... ] }                                          (common gateways)
function modelsFromPayload(payload) {
  const rows = Array.isArray(payload) ? payload
    : payload && Array.isArray(payload.data) ? payload.data
      : payload && Array.isArray(payload.models) ? payload.models : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (typeof row === 'string') {
      pushModel(out, seen, row, row);
    } else if (row && typeof row === 'object') {
      const model = row.model || row.id || row.slug;
      pushModel(out, seen, model, row.display_name || row.displayName || row.name || row.label);
    }
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

function staticModels(summary) {
  const out = [];
  const seen = new Set();
  const values = [summary && summary.model, ...(summary && Array.isArray(summary.modelOptions)
    ? summary.modelOptions : [])];
  for (const value of values) {
    pushModel(out, seen, value, value);
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

function fallbackBody(summary) {
  return Object.freeze({ models: Object.freeze(staticModels(summary)), source: 'fallback' });
}

async function requestModels(fetchImpl, endpoint, headers, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetchImpl(endpoint, { method: 'GET', headers, signal: controller?.signal });
    return { res, status: Number(res && res.status) || 0 };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchProviderModels(fetchImpl, summary, apiKey, timeoutMs) {
  const endpoint = modelsEndpointFor(summary && summary.baseUrl);
  if (!endpoint || typeof fetchImpl !== 'function') return [];
  let { res } = await requestModels(fetchImpl, endpoint, authHeaders(summary, apiKey), timeoutMs);
  // A stale/expired key must not hide a gateway that serves its catalog
  // unauthenticated (the OpenCode Zen Go endpoint does exactly this).
  if (apiKey && (Number(res && res.status) === 401 || Number(res && res.status) === 403)) {
    ({ res } = await requestModels(fetchImpl, endpoint, authHeaders(summary, ''), timeoutMs));
  }
  if (!res || !res.ok) return [];
  let payload;
  try { payload = await res.json(); } catch (_) { return []; }
  return modelsFromPayload(payload);
}

function createProviderModelsRuntime(options = {}) {
  const providers = options.providers || require('../providers/core');
  const fetchImpl = 'fetch' in options ? options.fetch : globalThis.fetch;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const ttlMs = Number(options.ttlMs) || PROVIDER_MODELS_TTL_MS;
  const failureTtlMs = Number(options.failureTtlMs) || PROVIDER_MODELS_FAILURE_TTL_MS;
  const timeoutMs = Number(options.timeoutMs) || PROVIDER_MODELS_HTTP_TIMEOUT_MS;
  const cache = new Map(); // providerId -> { at, baseUrl, models }
  const failedAt = new Map(); // providerId -> timestamp of the last failed pull

  function readProvider(providerId) {
    try { return providers.getProvider(undefined, providerId); } catch (_) { return null; }
  }

  function tokenFor(provider) {
    try {
      return providers.getRelayImportToken(provider.appType, provider.id) || '';
    } catch (_) { return ''; }
  }

  async function listProviderModels(rawId, opts = {}) {
    const providerId = String(rawId == null ? '' : rawId).trim();
    if (!providerId) return { status: 404, body: { error: 'provider not found' } };
    const provider = readProvider(providerId);
    if (!provider) return { status: 404, body: { error: 'provider not found' } };
    let summary;
    try { summary = providers.summarize(provider); } catch (_) { summary = null; }
    if (!summary) return { status: 200, body: fallbackBody(null) };

    // Official logins and virtual placeholders have no upstream of their own.
    const pullable = !!summary.baseUrl && summary.isOfficial !== true && !provider.virtual;
    if (!pullable) return { status: 200, body: fallbackBody(summary) };

    const refresh = opts.refresh === true;
    const cached = cache.get(providerId);
    if (!refresh && cached && cached.baseUrl === summary.baseUrl
        && (now() - cached.at) < ttlMs && cached.models.length) {
      return { status: 200, body: { models: cached.models, source: 'live', cached: true } };
    }
    const failed = failedAt.get(providerId) || 0;
    if (!refresh && failed && (now() - failed) < failureTtlMs) {
      return { status: 200, body: fallbackBody(summary) };
    }

    let models = [];
    try {
      models = await fetchProviderModels(fetchImpl, summary, tokenFor(provider), timeoutMs);
    } catch (_) { models = []; }
    if (models.length) {
      // Cache the upstream identity too: editing the base URL invalidates the
      // old gateway's list immediately instead of after an hour.
      cache.set(providerId, { at: now(), baseUrl: summary.baseUrl, models });
      failedAt.delete(providerId);
      return { status: 200, body: { models, source: 'live', cached: false } };
    }
    failedAt.set(providerId, now());
    return { status: 200, body: fallbackBody(summary) };
  }

  return Object.freeze({
    listProviderModels,
    _resetForTest() { cache.clear(); failedAt.clear(); },
  });
}

let sharedRuntime = null;
function getSharedProviderModelsRuntime() {
  if (!sharedRuntime) sharedRuntime = createProviderModelsRuntime();
  return sharedRuntime;
}

module.exports = {
  createProviderModelsRuntime,
  getSharedProviderModelsRuntime,
  modelsEndpointFor,
  modelsFromPayload,
  staticModels,
  PROVIDER_MODELS_TTL_MS,
};
