'use strict';
// 路由由 Rust 前门独占（native/gateway/src/app/model_catalogs.rs）：路径、查询串、
// 状态码与响应形状都在那边；这里的 CLI 枚举、解析与进程内缓存只经宿主端口
// src/routes/model-catalogs-host.js 提供。

// GET /api/opencode/models — list models available to the local opencode CLI.
//
// The CLI ships `opencode models`, which enumerates every provider declared in
// ~/.config/opencode/opencode.json (or the repo-local opencode.jsonc) plus the
// built-in providers. Each stdout line is `<provider>/<model>`. We parse those
// into `{provider, model, label}` triples the chat picker can render directly.
//
// The CLI is authoritative (it knows built-in + user config + secret-store
// expansions); the opencode.json file-read is only a fallback when the binary
// is missing or refuses to list. The result is cached in-process so repeated
// picker opens do not spawn the CLI. The TTL matches the CLI's own cadence:
// opencode re-checks models.dev on a 60-minute timer, so an upstream model
// rename becomes visible here within the same hour instead of a day later.
//
// OpenAI-compatible providers configured in opencode.json (`options.baseURL`)
// are a special case: their model list lives at the gateway, not in models.dev,
// and users tend to hand-write a static whitelist under `provider.<id>.models`.
// Upstream renames (e.g. DeepSeek `deepseek-v4-flash` → `deepseek-v4.1-flash`)
// therefore froze the picker forever — the 刷新 button only re-read the same
// file. On every cache miss (and every ?refresh=1) we now also GET
// `{baseURL}/models` for each such provider (3s timeout, several in parallel),
// and replace that provider's static list with the live one. Any failure keeps
// the static list, so a gateway outage can never take the picker down
// (fail-open).

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OPENCODE_TTL_MS = 60 * 60 * 1000; // 1 hour — opencode's own refresh cadence
const OPENCODE_TIMEOUT_MS = 2000;
const OPENCODE_HTTP_TIMEOUT_MS = 3000;
const MAX_MODELS = 1000;
// Below this normalised similarity we do not guess a replacement. A typo or a
// genuinely unrelated model must not be "corrected" into a different line.
const MODEL_SIMILARITY_THRESHOLD = 0.6;

// opencode is rarely on the server's PATH (it lives in ~/.opencode/bin, only
// added by interactive zsh rc). Probe the explicit override first, then PATH
// ('opencode'), then the canonical ~/.opencode/bin location, then Windows-style
// env-embedded paths. Falls back to parsing opencode.json directly when none of
// the CLI candidates respond in time.
function candidatesForOpenCodeBin() {
  const list = [];
  const explicit = process.env.OPENCODE_BIN;
  if (explicit) list.push(explicit);
  list.push('opencode');
  const home = os.homedir();
  if (home) {
    list.push(path.join(home, '.opencode', 'bin', 'opencode'));
    list.push(path.join(home, '.local', 'bin', 'opencode'));
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) list.push(path.join(local, 'opencode', 'opencode.exe'));
  }
  return list;
}

let cache = null; // { at: number, models: Array }

function parseOpenCodeStdout(stdout) {
  const out = [];
  const seen = new Set();
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const slash = line.indexOf('/');
    if (slash <= 0 || slash >= line.length - 1) continue;
    const provider = line.slice(0, slash).trim();
    const model = line.slice(slash + 1).trim();
    const key = `${provider}/${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider, model, label: key });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

function openCodeConfigCandidates() {
  const home = os.homedir();
  return [
    path.join(home, '.config', 'opencode', 'opencode.json'),
    path.join(home, '.config', 'opencode', 'opencode.jsonc'),
  ];
}

// Parse one opencode.json/jsonc file and return its raw `provider` object. The
// raw object (not the flattened triples) is what the dynamic-list layer needs:
// `options.baseURL` / `options.apiKey` only exist here.
function readOpenCodeConfigFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) { return null; }
  // opencode.jsonc allows // and /* */ comments — strip them naively.
  const cleaned = String(raw || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  let cfg;
  try {
    cfg = JSON.parse(cleaned);
  } catch (_) { return null; }
  return cfg && typeof cfg.provider === 'object' && cfg.provider ? cfg.provider : null;
}

// Raw provider definitions: `{[providerId]: {name, npm, options:{baseURL,apiKey}, models}}`.
function readOpenCodeConfigProviders() {
  for (const file of openCodeConfigCandidates()) {
    const providers = readOpenCodeConfigFile(file);
    if (providers) return providers;
  }
  return null;
}

function staticModelsFromProviders(providers) {
  const out = [];
  const seen = new Set();
  for (const [id, entry] of Object.entries(providers || {})) {
    const models = entry && typeof entry.models === 'object' ? entry.models : null;
    if (!models) continue;
    for (const model of Object.keys(models)) {
      const key = `${id}/${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const labelField = models[model] && typeof models[model].name === 'string' ? models[model].name : key;
      out.push({ provider: id, model, label: `${key} (${labelField})` });
      if (out.length >= MAX_MODELS) return out;
    }
  }
  return out;
}

function readOpenCodeJsonFallback() {
  for (const file of openCodeConfigCandidates()) {
    const providers = readOpenCodeConfigFile(file);
    if (!providers) continue;
    const out = staticModelsFromProviders(providers);
    if (out.length) return out;
  }
  return [];
}

// `{env:VAR}` is opencode's own indirection for secrets; expand it so the
// gateway call can authenticate without storing keys in the config.
function resolveConfiguredApiKey(rawKey) {
  const text = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (!text) return '';
  const match = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(text);
  return match ? String(process.env[match[1]] || '') : text;
}

function modelsEndpointFor(baseURL) {
  const base = typeof baseURL === 'string' ? baseURL.trim().replace(/\/+$/, '') : '';
  if (!base) return null;
  return /\/models$/i.test(base) ? base : `${base}/models`;
}

function modelsFromGatewayPayload(providerId, payload) {
  const data = Array.isArray(payload) ? payload
    : payload && Array.isArray(payload.data) ? payload.data
      : payload && Array.isArray(payload.models) ? payload.models : [];
  const out = [];
  const seen = new Set();
  for (const entry of data) {
    const id = entry && typeof entry === 'object' ? String(entry.id || '').trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const key = `${providerId}/${id}`;
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : '';
    out.push({ provider: providerId, model: id, label: name ? `${key} (${name})` : key });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

async function fetchGatewayModels(providerId, endpoint, apiKey, fetchImpl) {
  const request = async (key) => {
    const headers = { accept: 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), OPENCODE_HTTP_TIMEOUT_MS) : null;
    try {
      const res = await fetchImpl(endpoint, { method: 'GET', headers, signal: controller?.signal });
      return { res, status: Number(res && res.status) || 0 };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let { res, status } = await request(apiKey);
  // A stale/expired key must not hide a gateway that serves the catalog
  // unauthenticated (the OpenCode Zen Go endpoint does exactly this).
  if (apiKey && (status === 401 || status === 403)) {
    ({ res } = await request(''));
  }
  if (!res || !res.ok) return null;
  const payload = await res.json();
  const models = modelsFromGatewayPayload(providerId, payload);
  return models.length ? models : null;
}

// Parallel, per-provider, fail-open: a provider that errors simply keeps its
// static config list.
function fetchDynamicProviderModels(providers, fetchImpl) {
  if (typeof fetchImpl !== 'function') return Promise.resolve(new Map());
  const entries = Object.entries(providers || {}).filter(([, entry]) =>
    entry && entry.options && typeof entry.options.baseURL === 'string' && entry.options.baseURL.trim());
  if (!entries.length) return Promise.resolve(new Map());
  return Promise.all(entries.map(async ([id, entry]) => {
    try {
      const endpoint = modelsEndpointFor(entry.options.baseURL);
      if (!endpoint) return null;
      const models = await fetchGatewayModels(id, endpoint, resolveConfiguredApiKey(entry.options.apiKey), fetchImpl);
      return models ? [id, models] : null;
    } catch (_) {
      return null;
    }
  })).then(pairs => new Map(pairs.filter(Boolean)));
}

// Configured models with each provider's live list substituted in when the
// gateway answered. Providers without a live list keep their static entries.
function configuredModelsWithDynamic(providers, dynamicById) {
  if (!providers) return [];
  const out = [];
  const seen = new Set();
  const push = (item) => {
    const key = `${item.provider}/${item.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  for (const [id, entry] of Object.entries(providers)) {
    const live = dynamicById.get(id);
    if (live && live.length) {
      for (const item of live) push(item);
      if (out.length >= MAX_MODELS) return out.slice(0, MAX_MODELS);
      continue;
    }
    const models = entry && typeof entry.models === 'object' ? entry.models : null;
    if (!models) continue;
    for (const model of Object.keys(models)) {
      const key = `${id}/${model}`;
      const labelField = models[model] && typeof models[model].name === 'string' ? models[model].name : key;
      push({ provider: id, model, label: `${key} (${labelField})` });
      if (out.length >= MAX_MODELS) return out.slice(0, MAX_MODELS);
    }
  }
  return out;
}

function tryCliCandidate(binFile, cb) {
  execFile(binFile, ['models'], { timeout: OPENCODE_TIMEOUT_MS, maxBuffer: 512 * 1024 }, (err, stdout) => {
    if (err) return cb(err, null);
    const models = parseOpenCodeStdout(stdout);
    cb(null, models);
  });
}

// Strategy: opencode.json is what the USER actually configured (their own
// providers/auth); the opencode CLI also lists hundreds of built-in openrouter
// etc. providers the user never selected. So the JSON file leads the list —
// but it must not HIDE OpenCode's own preset providers: `opencode/*` is the
// OpenCode Zen gateway (free models such as big-pickle work without any
// config), and providers the user signed into with `opencode auth login` live
// in auth.json, not opencode.json. Those two sources are merged in from the
// CLI listing after the configured ones. With no configured providers at all
// the full CLI listing is used, as before.
const PRESET_PROVIDERS = new Set(['opencode']);

function readOpenCodeAuthProviders() {
  const home = os.homedir();
  const dirs = [process.env.XDG_DATA_HOME && path.join(process.env.XDG_DATA_HOME, 'opencode'),
    home && path.join(home, '.local', 'share', 'opencode')].filter(Boolean);
  for (const dir of dirs) {
    try {
      const auth = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
      if (auth && typeof auth === 'object') return new Set(Object.keys(auth));
    } catch (_) {}
  }
  return new Set();
}

function mergeOpenCodeModels(configured, cliModels, authProviders = new Set()) {
  if (!configured.length) return cliModels;
  const seen = new Set(configured.map(m => `${m.provider}/${m.model}`));
  const configuredProviders = new Set(configured.map(m => m.provider));
  const extra = cliModels.filter(m => !seen.has(`${m.provider}/${m.model}`)
    && !configuredProviders.has(m.provider)
    && (PRESET_PROVIDERS.has(m.provider) || authProviders.has(m.provider)))
    .map(m => (m.provider === 'opencode' && m.label === `${m.provider}/${m.model}`
      ? { ...m, label: `${m.label} (OpenCode Zen)` } : m));
  return [...configured, ...extra].slice(0, MAX_MODELS);
}

function listCliModels(callback) {
  const candidates = candidatesForOpenCodeBin();
  let idx = -1;
  const next = () => {
    idx += 1;
    if (idx >= candidates.length) return callback(new Error('opencode models unavailable'), []);
    tryCliCandidate(candidates[idx], (err, cliModels) => {
      if (err || !cliModels || !cliModels.length) {
        if (err && err.killed && err.signal === 'SIGTERM') {
          idx = candidates.length; // timeout — stop trying slower candidates
        }
        return next();
      }
      callback(null, cliModels);
    });
  };
  next();
}

function listOpenCodeModels(callback, opts = {}) {
  if (!opts.refresh && cache && (Date.now() - cache.at) < OPENCODE_TTL_MS) {
    return setImmediate(() => callback(null, cache.models, 'cache'));
  }
  let providers = null;
  try {
    providers = readOpenCodeConfigProviders();
  } catch (_) { providers = null; }
  let configured = [];
  try {
    configured = providers ? configuredModelsWithDynamic(providers, new Map())
      : (readOpenCodeJsonFallback() || []);
  } catch (_) { configured = []; }
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const cliLister = typeof opts.cliLister === 'function' ? opts.cliLister : listCliModels;
  let cliSettled = false;
  let dynamicSettled = false;
  let finished = false;
  let cliErr = null;
  let cliModels = [];
  let finalConfigured = configured;
  const finish = () => {
    if (finished || !cliSettled || !dynamicSettled) return;
    finished = true;
    if (cliErr && !finalConfigured.length) return callback(cliErr, [], 'fallback');
    const models = cliErr ? finalConfigured
      : mergeOpenCodeModels(finalConfigured, cliModels, readOpenCodeAuthProviders());
    cache = { at: Date.now(), models };
    callback(null, models, finalConfigured.length ? 'config' : 'cli');
  };
  try {
    cliLister((err, models) => {
      cliErr = err || null;
      cliModels = models || [];
      cliSettled = true;
      finish();
    });
  } catch (error) {
    cliErr = error;
    cliSettled = true;
    finish();
  }
  fetchDynamicProviderModels(providers, fetchImpl).then(dynamicById => {
    finalConfigured = configuredModelsWithDynamic(providers, dynamicById);
  }).catch(() => {
    finalConfigured = configured;
  }).then(() => {
    dynamicSettled = true;
    finish();
  });
}

// ── Model validation at spawn time ─────────────────────────────────────────
// Once the picker has a live list, a model that vanished upstream should fail
// with a one-shot, actionable error instead of being sent to the gateway and
// rejected there. The cache is the only source (no network on the hot path);
// a cold cache returns null so native OpenCode lines still spawn before the
// first picker refresh.

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function modelSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.startsWith(b) || b.startsWith(a)) return 0.92;
  if (a.includes(b) || b.includes(a)) return 0.85;
  return 1 - (levenshteinDistance(a, b) / Math.max(a.length, b.length));
}

function bestModelSuggestion(provider, target, candidates) {
  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    if (candidate.model === target) continue;
    const score = modelSimilarity(target, candidate.model);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (!best || bestScore < MODEL_SIMILARITY_THRESHOLD) return null;
  return `${provider}/${best.model}`;
}

function validateOpenCodeModel(model) {
  const requested = String(model == null ? '' : model).trim();
  // Only qualified `<provider>/<model>` ids can be attributed to a configured
  // provider. Bare ids belong to managed MultiCC routes, which this list does
  // not describe — never block those (fail-open).
  const slash = requested.indexOf('/');
  if (slash <= 0 || slash >= requested.length - 1) return null;
  const provider = requested.slice(0, slash);
  const target = requested.slice(slash + 1);
  const models = peekOpenCodeModels();
  if (!models.length) return null;
  const sameProvider = models.filter(item => item.provider === provider);
  if (!sameProvider.length) {
    // Provider id aliases: a config rewrite can rename the provider without
    // touching the models (custom `opencodego` → built-in `opencode-go`).
    // Match on the normalized id (alphanumerics only) so stored sessions keep
    // getting a useful suggestion instead of a blind upstream error. Zero or
    // ambiguous matches stay fail-open — it may be a MultiCC-managed route.
    const wanted = provider.toLowerCase().replace(/[^a-z0-9]/g, '');
    const aliases = [...new Set(models.map(item => item.provider))]
      .filter(id => id.toLowerCase().replace(/[^a-z0-9]/g, '') === wanted);
    if (aliases.length !== 1) return null;
    const aliasProvider = aliases[0];
    const aliasModels = models.filter(item => item.provider === aliasProvider);
    if (aliasModels.some(item => item.model === target)) {
      return { valid: false, suggestion: `${aliasProvider}/${target}` };
    }
    return { valid: false, suggestion: bestModelSuggestion(aliasProvider, target, aliasModels) };
  }
  if (sameProvider.some(item => item.model === target)) return null;
  return { valid: false, suggestion: bestModelSuggestion(provider, target, sameProvider) };
}

// Synchronous read of whatever the 1-hour cache already holds. It never spawns
// the CLI and never blocks: a cold cache reports no models, which is exactly how
// a native OpenCode line survives a cold boot without the live list. The Auto
// Provider runtime uses it to give such a line its `<id>/<model>` choices.
function peekOpenCodeModels() {
  return cache && Array.isArray(cache.models) ? cache.models : [];
}

module.exports = {
  listOpenCodeModels,
  parseOpenCodeStdout,
  peekOpenCodeModels,
  readOpenCodeJsonFallback,
  readOpenCodeConfigProviders,
  validateOpenCodeModel,
  mergeOpenCodeModels,
  // exposed for tests
  _setCacheForTest(at, models) { cache = { at, models }; },
  _resetCacheForTest() { cache = null; },
};
