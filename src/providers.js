'use strict';

// Per-session provider config — owned by multicc, importable from cc-switch.
//
// multicc keeps its OWN provider store (providers.json). cc-switch
// (~/.cc-switch/cc-switch.db) is an import SOURCE: the user can pull its provider
// list into multicc's store, then add / edit / delete freely here. multicc never
// writes to cc-switch — not even at import. Alias-only relays (base URL but no
// canonical ANTHROPIC_MODEL) get their alias target promoted to ANTHROPIC_MODEL
// at spawn time (see resolveSpawnEnv), so the source stays untouched and the
// provider works.
//
// A provider's `settingsConfig` mirrors cc-switch's shape so the spawn-env logic
// is uniform: claude → { env: { ANTHROPIC_* } }, codex → { auth, config(toml) }.
// multicc spawns one child per turn, so a session routes to a different provider
// simply by injecting that provider's env into its own child — siblings stay
// independent.

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const cliProviderRouter = require('cli-provider-router');
const { createSqliteRuntime } = require('./sqlite-runtime');
const { createPaths } = require('./paths');
const { atomicWriteJson, atomicWriteText, ensurePrivateDir, secureFile } = require('./runtime-security');

const sqliteRuntime = createSqliteRuntime();

// cc-switch stores its data at ~/.cc-switch/ on all platforms (Rust dirs::home_dir).
// On Windows the default is C:\Users\<name>\.cc-switch\. However, Git Bash / Cygwin
// users may have a HOME env var pointing elsewhere, and cc-switch has a legacy
// fallback for that. For multicc we also check that secondary location.
const CC_DB_DEFAULT = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
function resolveCcDb() {
  if (fs.existsSync(CC_DB_DEFAULT)) return CC_DB_DEFAULT;
  // Windows Git Bash legacy fallback — cc-switch does the same (see its config.rs)
  if (process.platform === 'win32' && process.env.HOME) {
    const legacy = path.join(process.env.HOME, '.cc-switch', 'cc-switch.db');
    if (fs.existsSync(legacy)) return legacy;
  }
  return CC_DB_DEFAULT; // return default path even if absent (caller checks)
}
// multicc's own store, in the project root (one level up from src/).
const RUNTIME_PATHS = createPaths({ dataDir: process.env.MULTICC_DATA_DIR });
const STORE_FILE = RUNTIME_PATHS.providersFile;
// Per-provider CODEX_HOME dirs materialized on demand so codex sessions can
// point at different auth/config without clobbering the global ~/.codex.
const CODEX_HOMES_DIR = path.join(os.homedir(), '.multicc', 'codex-homes');

const APP_TYPES = ['claude', 'codex'];
const API_FORMATS = Object.freeze({
  ANTHROPIC: 'anthropic',
  OPENAI_RESPONSES: 'openai_responses',
  OPENAI_CHAT: 'openai_chat',
});

function normalizeApiFormat(value, appType, cfg = {}) {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (raw === 'anthropic' || raw === 'messages' || raw === 'anthropic_messages') return API_FORMATS.ANTHROPIC;
  if (raw === 'openai_chat' || raw === 'chat' || raw === 'chat_completions') return API_FORMATS.OPENAI_CHAT;
  if (raw === 'openai_responses' || raw === 'responses' || raw === 'response') return API_FORMATS.OPENAI_RESPONSES;
  if (cfg.proxyTarget && cfg.proxyTarget.mode === 'chat-to-responses') return API_FORMATS.OPENAI_CHAT;
  if (appType === 'claude') return API_FORMATS.ANTHROPIC;
  return API_FORMATS.OPENAI_RESPONSES;
}

function compatibleClisForFormat(apiFormat) {
  if (apiFormat === API_FORMATS.ANTHROPIC) return ['claude', 'opencode'];
  return ['codex', 'opencode'];
}

function providerSupportsCli(provider, cli) {
  if (!provider || !cli) return false;
  const format = normalizeApiFormat(provider.apiFormat || provider.protocol, provider.appType, parseConfig(provider.settingsConfig));
  return compatibleClisForFormat(format).includes(String(cli));
}

// Map a session's cli to its MultiCC-managed provider pool (appType).
// Qoder CN and ZCode own authentication/provider configuration in their vendor
// clients, so they deliberately return null: MultiCC persists only their model
// selection and must not inject Claude/Codex routing into those processes.
// OpenCode resolves globally by provider id and then maps the stored protocol
// to its matching AI SDK package; appTypeForCli remains a legacy default only.
function appTypeForCli(cli) {
  if (cli === 'codex') return 'codex';
  if (cli === 'claude' || cli === 'opencode') return 'claude';
  return null;
}

function appTypesForCli(cli) {
  if (cli === 'opencode') return ['claude', 'codex'];
  const type = appTypeForCli(cli);
  return type ? [type] : [];
}

// Safe wire model used when a provider is "alias-only" — it declares only
// ANTHROPIC_DEFAULT_*_MODEL alias targets (no canonical ANTHROPIC_MODEL). Such
// relays serve their OWN real model ids through the tier vars (e.g. iFlytek's
// "astron-code-latest", Sub2API's "deepseek-v4-pro") and REJECT claude-* wire
// names — iFlytek returns 10404 PathDomainError:Model Not Found for
// claude-sonnet-4-5. So the correct fix is to PROMOTE the relay's own alias
// target to ANTHROPIC_MODEL (so the main --model arg lands on a model the relay
// accepts) and LEAVE the tier vars untouched. Only an alias-only relay with NO
// tier target at all (a pure claude-* passthrough, e.g. CrazyRouter) falls back
// to this claude-* wire name. Override via env if a relay prefers otherwise.
const WIRE_DEFAULT_MODEL = process.env.CLAUDE_WIRE_DEFAULT_MODEL || 'claude-sonnet-4-5';

// ── multicc store (providers.json) ───────────────────────────────────────────

function loadStore() {
  try {
    const d = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (Array.isArray(d)) return d;
    if (d && Array.isArray(d.providers)) return d.providers;
  } catch (_) {}
  return [];
}

function saveStore(list) {
  try { atomicWriteJson(STORE_FILE, list); }
  catch (e) { console.error('[multicc] save providers.json failed:', e.message); }
}

function getCcSwitchStatus() {
  return sqliteRuntime.getStatus(resolveCcDb());
}

function ccSwitchAvailable() { return getCcSwitchStatus().available; }

function parseConfig(s) {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (_) { return {}; }
}

function maskToken(tok) {
  if (!tok || typeof tok !== 'string') return '';
  if (tok.length <= 10) return '***';
  return tok.slice(0, 6) + '…' + tok.slice(-4);
}

function tomlValue(toml, key) {
  const m = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*"([^"]+)"`).exec(toml || '');
  return m ? m[1] : '';
}

function uniqueModels(values) {
  const seen = new Set();
  const out = [];
  for (const raw of values || []) {
    const v = String(raw || '').trim();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

function parseModelList(models, primary) {
  const extras = Array.isArray(models)
    ? models
    : String(models || '').split(/[\n,]/);
  return uniqueModels([primary, ...extras]);
}

// Domestic providers that only expose /chat/completions (no /responses).
// When a codex provider's baseUrl hits one of these, we rewrite config.toml's
// base_url to the local codex-proxy endpoint and stash the real chat/completions
// URL + apiKey in settingsConfig.proxyTarget for the proxy to read at request
// time. See docs/codex-proxy-contract.md (模块 C).
const DOMESTIC_PROXY_MAP = [
  { host: 'api.deepseek.com', target: 'https://api.deepseek.com/chat/completions' },
  { host: 'open.bigmodel.cn', target: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' },
  { host: 'dashscope.aliyuncs.com', target: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' },
  { hostRe: /^api\.minimax/i, target: 'https://api.minimaxi.com/v1/chat/completions' },
];

// Providers that expose /responses but need a local compatibility hop for Codex
// streaming. XFYun MaaS Coding returns a Responses-shaped stream, but long Codex
// turns can close before Codex observes response.completed; the proxy keeps the
// wire stable and injects only the missing terminal event.
const RESPONSES_COMPAT_PROXY_MAP = [
  { host: 'maas-coding-api.cn-huabei-1.xf-yun.com', target: 'https://maas-coding-api.cn-huabei-1.xf-yun.com/v1/responses' },
];

// If baseUrl points at a domestic chat-only service, return the real
// /chat/completions URL the proxy should fetch. Otherwise null (直连).
function detectDomesticTarget(baseUrl) {
  if (!baseUrl) return null;
  let host;
  try { host = new URL(baseUrl).host; } catch (_) { return null; }
  for (const m of DOMESTIC_PROXY_MAP) {
    if (m.host && host === m.host) return m.target;
    if (m.hostRe && m.hostRe.test(host)) return m.target;
  }
  return null;
}

function detectResponsesCompatTarget(baseUrl) {
  if (!baseUrl) return null;
  let host;
  try { host = new URL(baseUrl).host; } catch (_) { return null; }
  for (const m of RESPONSES_COMPAT_PROXY_MAP) {
    if (m.host && host === m.host) return m.target;
    if (m.hostRe && m.hostRe.test(host)) return m.target;
  }
  return null;
}

function codexProxyTarget(baseUrl) {
  const responseCompat = detectResponsesCompatTarget(baseUrl);
  if (responseCompat) return { baseUrl: responseCompat, mode: 'responses-compat' };
  const chatTarget = chatCompletionsTarget(baseUrl);
  return chatTarget ? { baseUrl: chatTarget, mode: 'chat-to-responses' } : null;
}

function chatCompletionsTarget(baseUrl) {
  if (!baseUrl) return null;
  const known = detectDomesticTarget(baseUrl);
  if (known) return known;
  try {
    const u = new URL(baseUrl);
    let path = u.pathname.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(path)) return u.toString();
    if (!path || path === '/') path = '/v1';
    u.pathname = path + '/chat/completions';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch (_) {
    return null;
  }
}

// Tier → env key for the per-tier model-mapping UI (settings screen). Lets a
// user point Claude Code's internal opus/sonnet/haiku/fable resolution at
// specific wire models for a relay, instead of only the single ANTHROPIC_MODEL.
const ALIAS_TIER_KEYS = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
};

// Source-of-truth regex for "is this an alias tier?" — derived from
// ALIAS_TIER_KEYS plus the synthetic 'default' tier, so the vocabulary lives in
// one place. Used by resolveSessionWireModel below.
const ALIAS_TIER_REGEX = new RegExp('^(?:' + [...Object.keys(ALIAS_TIER_KEYS), 'default'].join('|') + ')$', 'i');

// Resolve the wire model id to send to the CLI for a given session + provider.
// An explicit per-session model is honored ONLY when it's an alias tier
// (opus/sonnet/haiku/fable/default) or a model the provider actually serves —
// otherwise a stale value (e.g. "astron-code-latest" left on a session after
// its provider's model changed) is dropped, because relays reject unknown ids
// (400 / 1211 / 10404). Falls back to the provider's canonical model, or to
// `defaultModel` for the default login. Single source of truth for this
// decision; called by BOTH chat-spawn paths in server.js so they cannot drift.
function resolveSessionWireModel(sessionModel, { providerModel = null, providerModels = [], skipDefaultModel = false, defaultModel = null } = {}) {
  const served = providerModels || [];
  const hasProvider = providerModel !== undefined && providerModel !== null;
  if (!hasProvider) {
    return sessionModel || (skipDefaultModel ? null : (defaultModel || null));
  }
  return (sessionModel && (ALIAS_TIER_REGEX.test(sessionModel) || served.includes(sessionModel))) ? sessionModel : providerModel;
}

// Strip a "[1m]"-style context suffix for model comparison —
// "ark-code-latest[1M]" and "ark-code-latest" are the same wire model.
function stripModelSuffix(m) {
  return String(m || '').replace(/\[[^\]]*\]$/, '').trim();
}

// ── Codex Official (ChatGPT OAuth login) model catalog ───────────────────────
// The Official codex provider has no config.toml `model` and cc-switch supplies
// no model list, so its picker would otherwise be empty. The authoritative set
// is the codex CLI's own cached catalog (~/.codex/models_cache.json, refreshed
// by the CLI itself), whose entries carry visibility + priority. We surface the
// visibility:"list" slugs in priority order. [CODEX_OFFICIAL_MODELS_FALLBACK] is
// the curated baseline used when that cache is absent (mirrors codex client
// 0.144.x, July 2026) so the picker is never empty on a fresh install.
const CODEX_OFFICIAL_MODELS_FALLBACK = Object.freeze([
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.3-codex-spark',
]);
let _codexModelsCache = { path: null, mtime: 0, models: null };
function readCodexOfficialModels(cachePath) {
  const file = cachePath || path.join(os.homedir(), '.codex', 'models_cache.json');
  try {
    const st = fs.statSync(file);
    if (_codexModelsCache.path === file && _codexModelsCache.mtime === st.mtimeMs && _codexModelsCache.models) {
      return _codexModelsCache.models;
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = parsed && Array.isArray(parsed.models) ? parsed.models : [];
    const visible = entries
      .filter(m => m && m.visibility === 'list' && typeof m.slug === 'string')
      .sort((a, b) => (a.priority == null ? 99 : a.priority) - (b.priority == null ? 99 : b.priority))
      .map(m => m.slug);
    const models = visible.length ? visible : [...CODEX_OFFICIAL_MODELS_FALLBACK];
    _codexModelsCache = { path: file, mtime: st.mtimeMs, models };
    return models;
  } catch (_) {
    return [...CODEX_OFFICIAL_MODELS_FALLBACK];
  }
}

// PATCH-time guard: can this per-session model value work on that provider?
// Mirrors resolveSessionWireModel's spawn-time rule (tier alias or a served
// model), and additionally covers official/default-login providers — the spawn
// path passes the session model through VERBATIM there, so a relay id left
// over from a previous provider (e.g. "astron-code-latest") would 404 against
// api.anthropic.com. Used by the session PATCH to auto-replace stale models
// when switching provider (the AI-config dialog always submits provider+model
// together, which skips the model-snapshot branch).
//
// `summaryOverride` (test-only) lets a caller pass a pre-resolved provider
// summary so the decision can be exercised without the file-backed store.
function modelValidForProvider(appType, providerId, model, summaryOverride) {
  if (!model) return true; // 默认 → provider/global default, always resolvable
  const bare = stripModelSuffix(model);
  const isTier = ALIAS_TIER_REGEX.test(model);
  const p = summaryOverride !== undefined
    ? summaryOverride
    : (providerId ? getProviderSummary(appType, providerId) : null);
  if (appType === 'claude' && (!p || p.isOfficial)) {
    // Default login or an official/OAuth provider entry: only real Anthropic
    // models exist there.
    return isTier || /^claude-/i.test(bare);
  }
  if (!p) return true; // unknown codex/default target — don't second-guess
  if (p.isOfficial) {
    // Codex Official (ChatGPT OAuth) login: the plan can access OpenAI models
    // beyond the curated picker list (e.g. hidden tiers like gpt-5.4), so never
    // reject on the basis of the visible modelOptions set. This preserves the
    // pre-catalog accept-all behaviour for the official login.
    return true;
  }
  if (!p) return true; // unknown codex/default target — don't second-guess
  if (isTier) {
    // 'default' follows ANTHROPIC_MODEL; other tiers only work when the
    // provider maps them (ANTHROPIC_DEFAULT_*_MODEL) — unmapped, the CLI
    // resolves the tier to a claude-* wire name most relays reject.
    if (/^default$/i.test(model)) return true;
    const e = p.aliasMap && p.aliasMap[model.toLowerCase()];
    return !!(e && e.model);
  }
  const served = (p.modelOptions || []).map(stripModelSuffix);
  return served.length === 0 || served.includes(bare);
}

// Apply a { opus: {model, name}, sonnet: {...}, ... } map onto a claude env
// object (in place), writing/clearing ANTHROPIC_DEFAULT_*_MODEL[_NAME]. Blank
// model for a tier clears that tier's mapping.
function applyAliasMapToEnv(env, aliasMap) {
  if (!aliasMap || typeof aliasMap !== 'object') return;
  for (const [tier, key] of Object.entries(ALIAS_TIER_KEYS)) {
    const entry = aliasMap[tier];
    const model = (entry && typeof entry === 'object' ? entry.model : entry) || '';
    const name = (entry && typeof entry === 'object' ? entry.name : '') || '';
    if (String(model).trim()) {
      env[key] = String(model).trim();
      if (String(name).trim()) env[key + '_NAME'] = String(name).trim();
      else delete env[key + '_NAME'];
    } else {
      delete env[key];
      delete env[key + '_NAME'];
    }
  }
}

// Build a cc-switch-shaped settingsConfig from simple fields.
function buildSettingsConfig(appType, { baseUrl, authToken, model, models, providerId, apiFormat, useChatResponsesProxy, aliasMap }) {
  const modelOptions = parseModelList(models, model);
  if (appType === 'claude') {
    const env = {};
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    if (authToken) env.ANTHROPIC_AUTH_TOKEN = authToken;
    if (model) env.ANTHROPIC_MODEL = model;
    applyAliasMapToEnv(env, aliasMap);
    return { env, modelCatalog: { models: modelOptions.map(m => ({ model: m })) } };
  }
  const provName = 'custom';
  // codex CLI (>= 0.130) only supports wire_api = "responses"; the "chat"
  // protocol was removed (see openai/codex#7782). That means codex can only
  // talk to providers that expose an OpenAI /responses endpoint. Most domestic
  // providers (DeepSeek, GLM, Qwen, MiniMax) only serve /chat/completions, so
  // codex CANNOT connect to them directly — verified empirically: chat → "no
  // longer supported", responses → 404 on /responses. The only known way to
  // bridge codex to those is a local responses↔chat proxy (what cc-switch
  // does). We therefore always emit wire_api="responses" and surface the
  // limitation in the UI rather than generating a config that fails to start.
  //
  // For domestic services, config.toml's base_url is rewritten to the local
  // proxy; the real /chat/completions URL + apiKey are stored in
  // settingsConfig.proxyTarget for cli-provider-router's Codex proxy to read.
  const format = normalizeApiFormat(
    apiFormat || (useChatResponsesProxy ? API_FORMATS.OPENAI_CHAT : API_FORMATS.OPENAI_RESPONSES),
    appType,
  );
  const proxySpec = format === API_FORMATS.OPENAI_CHAT
    ? { baseUrl: chatCompletionsTarget(baseUrl), mode: 'chat-to-responses' }
    : (detectResponsesCompatTarget(baseUrl)
      ? { baseUrl: detectResponsesCompatTarget(baseUrl), mode: 'responses-compat' }
      : null);
  const port = process.env.PORT || 3000;
  const proxyBaseUrl = (proxySpec && providerId)
    ? `http://127.0.0.1:${port}/codex-proxy/${providerId}`
    : baseUrl;
  const lines = [
    `model_provider = "${provName}"`,
    model ? `model = "${model}"` : '',
    '',
    `[model_providers.${provName}]`,
    `name = "${provName}"`,
    proxyBaseUrl ? `base_url = "${proxyBaseUrl}"` : '',
    'wire_api = "responses"',
  ].filter(Boolean);
  const cfg = {
    auth: { OPENAI_API_KEY: authToken || null },
    config: lines.join('\n') + '\n',
    modelCatalog: { models: modelOptions.map(m => ({ model: m })) },
  };
  if (proxySpec) {
    cfg.proxyTarget = {
      baseUrl: proxySpec.baseUrl,
      apiKey: authToken || '',
      originalBaseUrl: baseUrl || '',
      mode: proxySpec.mode,
    };
  }
  return cfg;
}

function replaceTomlString(config, key, value) {
  const line = `${key} = "${String(value || '').replace(/["\\]/g, '')}"`;
  const pattern = new RegExp(`(^|\\n)\\s*${key}\\s*=\\s*"[^"]*"`);
  if (pattern.test(config || '')) return String(config).replace(pattern, `$1${line}`);
  return `${line}\n${config || ''}`;
}

function effectiveCodexSettings(provider) {
  const cfg = parseConfig(provider && provider.settingsConfig);
  const copy = JSON.parse(JSON.stringify(cfg || {}));
  const format = normalizeApiFormat(provider && provider.apiFormat, 'codex', copy);
  const originalBaseUrl = (copy.proxyTarget && copy.proxyTarget.originalBaseUrl) || tomlValue(copy.config, 'base_url');
  let proxySpec = null;
  if (format === API_FORMATS.OPENAI_CHAT && originalBaseUrl) {
    proxySpec = { baseUrl: chatCompletionsTarget(originalBaseUrl), mode: 'chat-to-responses' };
  } else {
    const compat = detectResponsesCompatTarget(originalBaseUrl);
    if (compat) proxySpec = { baseUrl: compat, mode: 'responses-compat' };
  }
  if (proxySpec && provider && provider.id) {
    const localBase = `http://127.0.0.1:${process.env.PORT || 3000}/codex-proxy/${provider.id}`;
    copy.config = replaceTomlString(copy.config, 'base_url', localBase);
    copy.config = replaceTomlString(copy.config, 'wire_api', 'responses');
    copy.proxyTarget = {
      baseUrl: proxySpec.baseUrl,
      apiKey: (copy.auth && copy.auth.OPENAI_API_KEY) || '',
      originalBaseUrl,
      mode: proxySpec.mode,
    };
  } else if (copy.proxyTarget) {
    if (originalBaseUrl) copy.config = replaceTomlString(copy.config, 'base_url', originalBaseUrl);
    delete copy.proxyTarget;
  }
  return copy;
}

// Public-safe summary — never leaks a full token (only masked).
// opts.codexCachePath (test-only) overrides the codex models cache location.
function summarize(p, opts = {}) {
  const cfg = p.appType === 'codex' ? effectiveCodexSettings(p) : parseConfig(p.settingsConfig);
  const apiFormat = normalizeApiFormat(p.apiFormat, p.appType, cfg);
  let baseUrl = '', model = '', token = '', modelOptions = [], aliasOnly = false, aliasMap = {};
  if (p.appType === 'claude') {
    const env = cfg.env || {};
    baseUrl = env.ANTHROPIC_BASE_URL || '';
    model = env.ANTHROPIC_MODEL || '';
    token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
    // Collect all models this provider can serve: primary + DEFAULT_* overrides + catalog.
    const aliasKeys = ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL'];
    const catalog = (cfg.modelCatalog && Array.isArray(cfg.modelCatalog.models))
      ? cfg.modelCatalog.models.map(m => m && m.model).filter(Boolean)
      : [];
    modelOptions = uniqueModels([env.ANTHROPIC_MODEL, ...aliasKeys.map(k => env[k]), ...catalog]);
    // Alias-only relay: has a base URL but no canonical ANTHROPIC_MODEL — it only
    // declares per-tier alias targets (e.g. iFlytek maps opus/sonnet/haiku/fable →
    // astron-code-latest). Such relays reject those targets as literal --model
    // values, so the invocation path substitutes a safe wire default.
    aliasOnly = !!baseUrl && !model;
    // Surface the alias↔model correspondence for the model picker, carrying cc-switch's
    // friendly *_MODEL_NAME label (e.g. opus → astron-code-latest (GLM5.2)).
    for (const k of aliasKeys) {
      const m = env[k];
      if (!m) continue;
      const tier = k.replace('ANTHROPIC_DEFAULT_', '').replace('_MODEL', '').toLowerCase();
      aliasMap[tier] = { model: m, name: env[k + '_NAME'] || '' };
    }
  } else {
    baseUrl = (cfg.proxyTarget && cfg.proxyTarget.originalBaseUrl) || tomlValue(cfg.config, 'base_url');
    model = tomlValue(cfg.config, 'model');
    token = (cfg.auth && cfg.auth.OPENAI_API_KEY) ||
            (cfg.auth && cfg.auth.tokens && cfg.auth.tokens.access_token) || '';
    // Collect models this codex provider can serve: the primary `model` from
    // config.toml plus any extras declared in `modelCatalog.models`. This lets
    // the session model auto-fill correctly when switching onto a codex
    // provider (e.g. 讯飞GLM5.2 which declares model="astron-code-latest").
    const seen = new Set();
    const ordered = [];
    const extras = (cfg.modelCatalog && Array.isArray(cfg.modelCatalog.models))
      ? cfg.modelCatalog.models.map(m => m && m.model).filter(Boolean)
      : [];
    for (const v of [model, ...extras]) {
      if (v && !seen.has(v)) { seen.add(v); ordered.push(v); }
    }
    modelOptions = ordered;
    if (!ordered.length && !baseUrl) {
      // Official codex (ChatGPT OAuth) login: no config.toml `model` and cc-switch
      // supplies no list, so the picker would be empty. Fall back to the codex
      // CLI's own cached model catalog. Never overrides a provider's own declared
      // models (ordered is non-empty in that case).
      modelOptions = readCodexOfficialModels(opts.codexCachePath);
    }
  }
  return {
    id: p.id,
    appType: p.appType,
    apiFormat,
    protocol: apiFormat,
    wireApi: apiFormat === API_FORMATS.ANTHROPIC
      ? 'messages'
      : (apiFormat === API_FORMATS.OPENAI_CHAT ? 'chat_completions' : 'responses'),
    compatibleClis: compatibleClisForFormat(apiFormat),
    requiresConversionFor: apiFormat === API_FORMATS.OPENAI_CHAT ? ['codex'] : [],
    name: p.name,
    source: p.source || 'local', // 'local' | 'ccswitch'
    baseUrl,
    model,
    modelOptions,
    aliasOnly,
    aliasMap,
    useChatResponsesProxy: apiFormat === API_FORMATS.OPENAI_CHAT,
    tokenMask: maskToken(token),
    hasToken: !!token,
    isOfficial: !baseUrl, // no custom base url -> default login / subscription
  };
}

// Resolve an Aux provider into a callable HTTP endpoint. Aux is protocol-based,
// not CLI-based: Anthropic providers use /messages; OpenAI providers declare
// either /responses or /chat/completions. OAuth-only OpenAI providers are not
// callable because there is no API key to authenticate a plain HTTP request.
function resolveAuxHttpTarget(protocol, providerId, { port, claudeOfficialViaProxy = false } = {}) {
  const normalized = protocol === 'openai' ? 'openai' : 'anthropic';
  const appType = normalized === 'openai' ? 'codex' : 'claude';
  const provider = getProvider(appType, providerId);
  if (!provider) return { available: false, protocol: normalized, reason: 'provider not found' };
  const cfg = parseConfig(provider.settingsConfig);
  const summary = summarize(provider);

  if (normalized === 'anthropic') {
    const env = cfg.env || {};
    const hasBase = !!env.ANTHROPIC_BASE_URL;
    const hasKey = !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
    const officialOAuth = providerId === 'claude-official' && claudeOfficialViaProxy;
    if (!(hasBase && hasKey) && !officialOAuth) {
      return { available: false, protocol: normalized, reason: 'provider has no HTTP credentials' };
    }
    if (!port) return { available: false, protocol: normalized, reason: 'proxy port unavailable' };
    return {
      available: true,
      protocol: normalized,
      wireApi: 'messages',
      url: `http://127.0.0.1:${port}/claude-proxy/${providerId}/aux/v1/messages?beta=true`,
      apiKey: 'multicc-aux',
      model: summary.model || '',
      modelOptions: summary.modelOptions && summary.modelOptions.length
        ? summary.modelOptions
        : ['haiku', 'sonnet', 'opus', 'fable'],
      providerName: summary.name,
      localProxy: true,
    };
  }

  const auth = cfg.auth || {};
  const apiKey = auth.OPENAI_API_KEY || '';
  const model = tomlValue(cfg.config, 'model') || '';
  const modelOptions = (cfg.modelCatalog && Array.isArray(cfg.modelCatalog.models))
    ? cfg.modelCatalog.models.map(item => item && item.model).filter(Boolean)
    : (model ? [model] : []);
  if (cfg.proxyTarget && cfg.proxyTarget.baseUrl) {
    const key = cfg.proxyTarget.apiKey || apiKey;
    if (!key) return { available: false, protocol: normalized, reason: 'proxy target has no API key' };
    return {
      available: true, protocol: normalized, wireApi: 'chat_completions',
      url: cfg.proxyTarget.baseUrl, apiKey: key, model, modelOptions,
      providerName: summary.name,
    };
  }
  if (!apiKey) return { available: false, protocol: normalized, reason: 'OAuth provider has no API key' };
  const base = tomlValue(cfg.config, 'base_url') || '';
  if (!base) return { available: false, protocol: normalized, reason: 'provider has no base_url' };
  if (/127\.0\.0\.1|localhost/.test(base)) {
    return { available: false, protocol: normalized, reason: 'local proxy has no direct target' };
  }
  const wireApi = tomlValue(cfg.config, 'wire_api') === 'chat_completions'
    ? 'chat_completions'
    : 'responses';
  const suffix = wireApi === 'responses' ? '/responses' : '/chat/completions';
  let url = base.replace(/\/+$/, '');
  if (!url.endsWith(suffix)) url += suffix;
  return {
    available: true, protocol: normalized, wireApi, url, apiKey, model,
    modelOptions, providerName: summary.name,
  };
}

function listProviders(appType) {
  const list = loadStore().filter(p => !appType || p.appType === appType);
  return list.map(summarize);
}

function getProvider(appType, id) {
  // id is globally unique, so when appType is omitted match by id alone.
  // (Passing appType === undefined previously matched nothing, since every
  // stored provider has a concrete appType.)
  return loadStore().find(p => p.id === id && (!appType || p.appType === appType)) || null;
}

function getProviderSummary(appType, id) {
  const p = getProvider(appType, id);
  return p ? summarize(p) : null;
}

// Compatibility wrapper used by the provider speed test.
function resolveCodexDirectHttp(providerId) {
  const target = resolveAuxHttpTarget('openai', providerId);
  return target.available
    ? { ...target, canDirect: true }
    : { ...target, canDirect: false };
}

function createProvider({ appType, name, baseUrl, authToken, model, models, apiFormat, useChatResponsesProxy, settingsConfig, aliasMap }) {
  if (!APP_TYPES.includes(appType)) throw new Error('appType must be claude or codex');
  if (!name || !String(name).trim()) throw new Error('name required');
  // Generate id first so buildSettingsConfig can embed it in the proxy base_url.
  const id = crypto.randomUUID();
  const cfg = (settingsConfig && typeof settingsConfig === 'object')
    ? settingsConfig
    : buildSettingsConfig(appType, { baseUrl, authToken, model, models, apiFormat, useChatResponsesProxy, providerId: id, aliasMap });
  const format = normalizeApiFormat(apiFormat || (useChatResponsesProxy ? API_FORMATS.OPENAI_CHAT : ''), appType, cfg);
  const p = {
    id,
    appType,
    apiFormat: format,
    name: String(name).trim(),
    source: 'local',
    settingsConfig: cfg,
    createdAt: Date.now(),
  };
  const list = loadStore();
  list.push(p);
  saveStore(list);
  return { id: p.id, appType, name: p.name };
}

function updateProvider(appType, id, { name, baseUrl, authToken, model, models, apiFormat, useChatResponsesProxy, settingsConfig, aliasMap }) {
  const list = loadStore();
  const p = list.find(x => x.appType === appType && x.id === id);
  if (!p) throw new Error('provider not found');
  let cfg = parseConfig(p.settingsConfig);
  if (settingsConfig && typeof settingsConfig === 'object') {
    cfg = settingsConfig;
  } else if (appType === 'claude') {
    cfg.env = cfg.env || {};
    if (baseUrl !== undefined) { if (baseUrl) cfg.env.ANTHROPIC_BASE_URL = baseUrl; else delete cfg.env.ANTHROPIC_BASE_URL; }
    if (authToken !== undefined && authToken) cfg.env.ANTHROPIC_AUTH_TOKEN = authToken;
    if (model !== undefined) { if (model) cfg.env.ANTHROPIC_MODEL = model; else delete cfg.env.ANTHROPIC_MODEL; }
    if (models !== undefined || model !== undefined) {
      cfg.modelCatalog = { models: parseModelList(models, model !== undefined ? model : cfg.env.ANTHROPIC_MODEL).map(m => ({ model: m })) };
    }
    if (aliasMap !== undefined) applyAliasMapToEnv(cfg.env, aliasMap);
  } else {
    const currentBaseUrl = (cfg.proxyTarget && cfg.proxyTarget.originalBaseUrl) || tomlValue(cfg.config, 'base_url');
    const requestedFormat = apiFormat || (useChatResponsesProxy === true
      ? API_FORMATS.OPENAI_CHAT
      : (useChatResponsesProxy === false ? API_FORMATS.OPENAI_RESPONSES : p.apiFormat));
    const nextProxy = normalizeApiFormat(requestedFormat, appType, cfg) === API_FORMATS.OPENAI_CHAT;
    const rebuilt = buildSettingsConfig('codex', {
      baseUrl: baseUrl !== undefined ? baseUrl : currentBaseUrl,
      authToken: authToken || (cfg.auth && cfg.auth.OPENAI_API_KEY) || '',
      model: model !== undefined ? model : tomlValue(cfg.config, 'model'),
      models: models !== undefined
        ? models
        : ((cfg.modelCatalog && Array.isArray(cfg.modelCatalog.models)) ? cfg.modelCatalog.models.map(m => m && m.model).filter(Boolean) : undefined),
      useChatResponsesProxy: nextProxy,
      apiFormat: requestedFormat,
      providerId: id,
    });
    // Drop a stale proxyTarget if the user switched to a non-domestic baseUrl.
    cfg = { ...cfg, ...rebuilt };
    if (!rebuilt.proxyTarget) delete cfg.proxyTarget;
  }
  if (name) p.name = String(name).trim();
  p.apiFormat = normalizeApiFormat(
    apiFormat || (useChatResponsesProxy === true
      ? API_FORMATS.OPENAI_CHAT
      : (useChatResponsesProxy === false ? API_FORMATS.OPENAI_RESPONSES : p.apiFormat)),
    appType,
    cfg,
  );
  p.settingsConfig = cfg;
  saveStore(list);
  return { id, appType };
}

function deleteProvider(appType, id) {
  const list = loadStore();
  const next = list.filter(p => !(p.appType === appType && p.id === id));
  if (next.length === list.length) return false;
  saveStore(next);
  return true;
}

// Pull cc-switch's providers into multicc's store. Idempotent: keyed by the
// cc-switch id (kept as the provider id with source='ccswitch'), so re-import
// refreshes existing entries instead of duplicating. Local providers untouched.
function readCcSwitchRows() {
  const ccDb = resolveCcDb();
  const db = sqliteRuntime.openReadonly(ccDb);
  let rows;
  try {
    const columns = db.prepare('PRAGMA table_info(providers)').all().map(column => column.name);
    const metaSelect = columns.includes('meta') ? 'meta' : 'NULL AS meta';
    rows = db.prepare(`SELECT id, app_type, name, settings_config, ${metaSelect} FROM providers ORDER BY app_type, sort_index, name`).all();
  } finally { db.close(); }
  return rows;
}

function migrateLegacyProviderProtocols() {
  const list = loadStore();
  let ccFormats = null;
  try {
    ccFormats = new Map(readCcSwitchRows().map(row => {
      const meta = parseConfig(row.meta) || {};
      return [`${row.app_type}:${row.id}`, meta.apiFormat || null];
    }));
  } catch (_) {}

  let updated = 0, skipped = 0;
  const next = list.map(provider => {
    if (!provider || !APP_TYPES.includes(provider.appType)
      || Object.values(API_FORMATS).includes(provider.apiFormat)) return provider;
    const cfg = parseConfig(provider.settingsConfig);
    const sourceFormat = ccFormats && ccFormats.get(`${provider.appType}:${provider.id}`);
    const hasLocalSignal = provider.appType === 'claude' || (cfg.proxyTarget && cfg.proxyTarget.mode);
    if (provider.source === 'ccswitch' && provider.appType === 'codex' && !sourceFormat && !hasLocalSignal) {
      skipped++;
      return provider;
    }
    const migrated = {
      ...provider,
      apiFormat: normalizeApiFormat(sourceFormat, provider.appType, cfg),
    };
    if (provider.appType === 'codex') migrated.settingsConfig = effectiveCodexSettings(migrated);
    updated++;
    return migrated;
  });
  if (updated) saveStore(next);
  return { updated, skipped, total: list.length };
}

function importFromCcSwitch() {
  const rows = readCcSwitchRows();

  const list = loadStore();
  const byKey = new Map(list.map((p, i) => [`${p.appType}:${p.id}`, i]));
  let imported = 0, updated = 0;
  for (const r of rows) {
    if (!APP_TYPES.includes(r.app_type)) continue;
    const cfg = parseConfig(r.settings_config);
    const meta = parseConfig(r.meta) || {};
    const apiFormat = normalizeApiFormat(meta.apiFormat, r.app_type, cfg);
    // Keep cc-switch's REAL model ids in the stored env so the editor / model
    // picker shows e.g. glm-5.2 (not a claude-* wire name). The spawn path
    // (resolveSpawnEnv) applies the safe wire default to alias-only relays at
    // spawn time, so we deliberately do NOT overwrite the env at import.
    const entry = {
      id: r.id,
      appType: r.app_type,
      apiFormat,
      name: r.name,
      source: 'ccswitch',
      settingsConfig: cfg,
      importedAt: Date.now(),
    };
    const key = `${r.app_type}:${r.id}`;
    if (byKey.has(key)) {
      // Preserve local-only env fields that cc-switch doesn't manage
      // (ANTHROPIC_API_KEY, MULTICC_TOOLS, etc.), then merge cc-switch data.
      const prev = list[byKey.get(key)];
      const prevEnv = (prev.settingsConfig && prev.settingsConfig.env) || {};
      const prevLocalKeys = {};
      for (const k of ['ANTHROPIC_API_KEY', 'MULTICC_TOOLS']) {
        if (prevEnv[k] !== undefined) prevLocalKeys[k] = prevEnv[k];
      }
      list[byKey.get(key)] = { ...prev, ...entry };
      if (Object.keys(prevLocalKeys).length) {
        const merged = list[byKey.get(key)];
        merged.settingsConfig.env = { ...merged.settingsConfig.env, ...prevLocalKeys };
      }
      updated++;
    }
    else { list.push(entry); imported++; }
  }
  for (const provider of list) {
    if (provider.appType === 'codex') provider.settingsConfig = effectiveCodexSettings(provider);
  }
  saveStore(list);
  return { imported, updated, total: rows.length };
}

// Env vars that select the model and route the endpoint for a claude session.
// multicc must own these COMPLETELY: a value leaked into the multicc server's
// OWN environment (e.g. pm2 / launchd started from a shell where cc-switch had
// exported ANTHROPIC_DEFAULT_OPUS_MODEL=… + ANTHROPIC_BASE_URL=… for DeepSeek)
// would otherwise be inherited by every spawned `claude` child and silently
// override the per-session provider choice — so switching a session back to
// "default login" or "Claude Official" would have no effect.  We strip all of
// these from the inherited env first, then re-apply only what the chosen
// provider supplies.
// ANTHROPIC_* env keys that route claude to a specific provider/model. If one
// of these leaks into this server's own env (e.g. from the shell that ran
// `pm2 start` after a cc-switch), every spawned child inherits it and routes
// / bills against the wrong provider, so they are stripped both at server
// startup AND here in buildChildEnv. Single source of truth — server.js imports
// this list instead of re-inline-ing it.
const ANTHROPIC_ROUTING_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
];
// Full set stripped from a child env before re-applying the per-session
// provider. Includes CLAUDE_CODE_SIMPLE: multicc never SETS it (leaving it
// unset preserves the full tool set — Agent, TaskCreate, Workflow, ultracode),
// but the pm2/launchd parent often carries CLAUDE_CODE_SIMPLE=1 left over from
// an earlier setup, and without stripping it the child enters SDK/simple mode
// and its tool set collapses + per-session routing is overridden (domestic
// providers return "model not found" / 1211). Strip-without-set => clean child.
const CLAUDE_ROUTING_KEYS = [...ANTHROPIC_ROUTING_KEYS, 'CLAUDE_CODE_SIMPLE'];

// Build the full child environment for spawning a session's CLI.
//   base   — the inherited env to start from (normally process.env)
//   extra  — extra vars to layer on (MULTICC_*, TERM, etc.)
// For claude sessions, every routing key is stripped from `base` BEFORE the
// provider env is applied, so the chosen provider is authoritative:
//   - default login (provider=null) → none set → real OAuth login from ~/.claude
//   - a custom provider             → exactly its own ANTHROPIC_* values
// codex sessions don't use ANTHROPIC_* (they route via CODEX_HOME), so their
// inherited env is left untouched aside from the provider's CODEX_HOME.
function buildChildEnv(base, session, extra = {}) {
  const env = { ...base };
  const appType = appTypeForCli(session && session.cli);
  // Only the claude CLI itself needs inherited ANTHROPIC_* routing keys stripped
  // (so the chosen provider is authoritative). opencode/zcode carry their own
  // native config (opencode.json / auth.json) and codex routes via CODEX_HOME —
  // for all of them the inherited env is left untouched, matching codex's behavior.
  if (session && session.cli === 'claude') {
    for (const k of CLAUDE_ROUTING_KEYS) delete env[k];
  }
  if (session && session.cli === 'opencode') delete env.OPENCODE_CONFIG_CONTENT;
  const spawn = resolveSpawnEnv(session);
  Object.assign(env, extra, spawn.env);
  return {
    env,
    skipDefaultModel: spawn.skipDefaultModel,
    aliasOnly: spawn.aliasOnly,
    providerModel: spawn.providerModel,
    providerModels: spawn.providerModels,
    qualifiedModel: spawn.qualifiedModel || null,
    providerName: spawn.providerName,
    codexHome: spawn.codexHome,
    tools: spawn.tools,
  };
}

function materializeCodexAuth(home, cfg) {
  const result = cliProviderRouter.materializeCodexAuth(home, cfg);
  secureFile(path.join(home, 'auth.json'));
  return result;
}

function opencodeProviderId(provider) {
  return `multicc-${String(provider && provider.id || 'provider')}`
    .toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 96);
}

function anthropicSdkBaseUrl(value) {
  const raw = String(value || '').replace(/\/+$/, '');
  if (!raw || /\/v1$/i.test(raw)) return raw;
  return `${raw}/v1`;
}

function buildOpenCodeRoute(provider, session) {
  const cfg = parseConfig(provider.settingsConfig);
  const summary = summarize(provider);
  const format = summary.apiFormat;
  const models = uniqueModels([session && session.model, summary.model, ...(summary.modelOptions || [])]);
  const selected = (session && session.model) || summary.model || models[0] || '';
  const custom = !!summary.baseUrl;
  if (!custom) {
    const nativeId = format === API_FORMATS.ANTHROPIC ? 'anthropic' : 'openai';
    return {
      env: {},
      qualifiedModel: selected ? `${nativeId}/${selected}` : null,
      providerModel: summary.model || null,
      providerModels: models,
      providerName: provider.name,
    };
  }

  const id = opencodeProviderId(provider);
  const options = {};
  let npm;
  if (format === API_FORMATS.ANTHROPIC) {
    npm = '@ai-sdk/anthropic';
    const src = cfg.env || {};
    options.baseURL = anthropicSdkBaseUrl(src.ANTHROPIC_BASE_URL || summary.baseUrl);
    if (src.ANTHROPIC_AUTH_TOKEN) options.authToken = src.ANTHROPIC_AUTH_TOKEN;
    else if (src.ANTHROPIC_API_KEY) options.apiKey = src.ANTHROPIC_API_KEY;
  } else {
    npm = format === API_FORMATS.OPENAI_CHAT ? '@ai-sdk/openai-compatible' : '@ai-sdk/openai';
    options.baseURL = summary.baseUrl;
    const key = cfg.auth && cfg.auth.OPENAI_API_KEY;
    if (key) options.apiKey = key;
    if (format === API_FORMATS.OPENAI_CHAT) options.includeUsage = true;
  }
  const providerConfig = {
    npm,
    name: provider.name,
    options,
    models: Object.fromEntries(models.map(model => [model, { name: model }])),
  };
  return {
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        enabled_providers: [id],
        provider: { [id]: providerConfig },
      }),
    },
    qualifiedModel: selected ? `${id}/${selected}` : null,
    providerModel: summary.model || null,
    providerModels: models,
    providerName: provider.name,
  };
}

// Compute env overrides + flags to apply when spawning a child for `session`.
//   - env: object merged into the child's process env (only this child).
//   - skipDefaultModel: claude routes elsewhere → don't force the global --model.
function resolveSpawnEnv(session) {
  const providerId = session && session.provider;
  if (!providerId) return { env: {}, skipDefaultModel: false, aliasOnly: false, providerModel: null, providerModels: [], providerName: null };
  const appType = appTypeForCli(session.cli);
  if (!appType) return { env: {}, skipDefaultModel: false, aliasOnly: false, providerModel: null, providerModels: [], providerName: null };
  const p = getProvider(session.cli === 'opencode' ? undefined : appType, providerId);
  if (!p) return { env: {}, skipDefaultModel: false, aliasOnly: false, providerModel: null, providerModels: [], providerName: null };
  if (!providerSupportsCli(p, session.cli)) return { env: {}, skipDefaultModel: false, aliasOnly: false, providerModel: null, providerModels: [], providerName: null };
  if (session.cli === 'opencode') {
    return { ...buildOpenCodeRoute(p, session), skipDefaultModel: false, aliasOnly: false };
  }
  const cfg = p.appType === 'codex' ? effectiveCodexSettings(p) : parseConfig(p.settingsConfig);

  if (session.cli === 'claude') {
    const env = {};
    const src = cfg.env || {};
    for (const k of Object.keys(src)) {
      if (/^ANTHROPIC_/.test(k) && typeof src[k] === 'string') env[k] = src[k];
    }
    // Claude CLI v2.1.199+ auth precedence: when ANTHROPIC_AUTH_TOKEN is set,
    // it takes precedence over OAuth/keychain WITHOUT needing CLAUDE_CODE_SIMPLE=1.
    // (CLI prints "connectors are disabled" warning but routes to the API key.)
    // Omitting CLAUDE_CODE_SIMPLE=1 preserves the full tool set (Agent, TaskCreate,
    // Workflow, etc.) which is required for dynamic workflow / ultracode support.
    // Only set ANTHROPIC_API_KEY if the provider explicitly provided one.
    // Auto-copying AUTH_TOKEN to API_KEY forces the x-api-key header on
    // providers that don't accept it (e.g. Zhipu GLM 401s because it only
    // reads Authorization: Bearer). Leave AUTH_TOKEN as-is for Bearer auth.

    // Alias-only relay remap: a provider with a base URL but no canonical
    // ANTHROPIC_MODEL only declares alias targets (its real model id, e.g.
    // iFlytek's "astron-code-latest"). The relay ACCEPTS that id and REJECTS
    // claude-* wire names (iFlytek → 10404). Promote the first alias target
    // to ANTHROPIC_MODEL so the main --model and every tier-based sub-call
    // (background/haiku tasks, ultracode subagents) all send a model the relay
    // accepts. The tier vars are left as-is (already the real model id).
    if (env.ANTHROPIC_BASE_URL && !env.ANTHROPIC_MODEL) {
      // Promote the relay's own real model id from a tier var (e.g.
      // "astron-code-latest"). Never inject claude-* wire names — relays like
      // iFlytek reject those with 10404 PathDomainError.
      const realModel = env.ANTHROPIC_DEFAULT_SONNET_MODEL
        || env.ANTHROPIC_DEFAULT_OPUS_MODEL
        || env.ANTHROPIC_DEFAULT_HAIKU_MODEL
        || env.ANTHROPIC_DEFAULT_FABLE_MODEL;
      if (realModel) env.ANTHROPIC_MODEL = realModel;
    }
    // Canonical wire model + the set of models this provider actually serves
    // (post-remap), so the spawn path can reject stale per-session model values
    // that are no longer valid (e.g. "astron-code-latest" after import-correction).
    const providerModel = env.ANTHROPIC_MODEL || null;
    const providerModels = uniqueModels([
      env.ANTHROPIC_MODEL,
      env.ANTHROPIC_DEFAULT_OPUS_MODEL, env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL, env.ANTHROPIC_DEFAULT_FABLE_MODEL,
    ]).filter(Boolean);
    // Debug: log the model-routing env actually injected into the claude child
    // (token redacted), so relay errors like iFlytek 10404 can be traced to the
    // exact model id sent. Grep `[multicc/provider] claude env`.
    try {
      const envSummary = Object.keys(env)
        .filter(k => /^ANTHROPIC_(BASE_URL|MODEL|DEFAULT_.*_MODEL|SMALL_FAST_MODEL)$/.test(k))
        .sort()
        .reduce((o, k) => { o[k] = env[k]; return o; }, {});
      console.log(`[multicc/provider] claude env [${providerId}] provider=${p.name} aliasOnly=${!!env.ANTHROPIC_BASE_URL && !src.ANTHROPIC_MODEL} modelEnv=${JSON.stringify(envSummary)}`);
    } catch (_) {}
    return { env, skipDefaultModel: !!env.ANTHROPIC_BASE_URL, aliasOnly: !!env.ANTHROPIC_BASE_URL && !src.ANTHROPIC_MODEL, providerModel, providerModels, providerName: p.name, tools: src.MULTICC_TOOLS };
  }

  try {
    const home = path.join(CODEX_HOMES_DIR, providerId);
    ensurePrivateDir(home);
    ensurePrivateDir(path.join(home, 'sessions'));
    materializeCodexAuth(home, cfg);
    if (cfg.config) {
      // cc-switch 导入的 config 可能带 model_catalog_json 指向 cc-switch 自己目录里的
      // 文件（codex home 里没有），导致 codex 启动时 "config could not be loaded" → exit 1。
      // 同时折叠 [model_providers] 空表头 + [model_providers.custom] 子表的写法。
      let toml = cfg.config;
      toml = toml.replace(/^model_catalog_json\s*=.*$/gm, '').replace(/\n{3,}/g, '\n\n');
      toml = toml.replace(/\[model_providers\]\s*\n\[model_providers\.custom\]/, '[model_providers.custom]');
      const configFile = path.join(home, 'config.toml');
      atomicWriteText(configFile, toml);
    }
    // Per-provider codex reads skills from $CODEX_HOME/skills, but
    // syncSharedSkills only populates the global ~/.codex/skills, so mirror it
    // via a symlink. Codex auto-seeds skills/.system here on first run
    // (identical to the global copy), so replacing a bare dir or stale link is safe.
    const skillsDir = path.join(home, 'skills');
    const globalSkills = path.join(os.homedir(), '.codex', 'skills');
    try {
      if (fs.existsSync(globalSkills)) {
        let needLink = true;
        try {
          const st = fs.lstatSync(skillsDir);
          if (st.isSymbolicLink()) {
            try { if (fs.realpathSync(skillsDir) === fs.realpathSync(globalSkills)) needLink = false; } catch (_) {}
            if (needLink) fs.unlinkSync(skillsDir);
          } else if (st.isDirectory()) {
            // Only replace if it holds nothing user-added (.system is codex's own).
            if (fs.readdirSync(skillsDir).every(n => n === '.system')) fs.rmSync(skillsDir, { recursive: true, force: true });
            else needLink = false;
          } else {
            needLink = false;  // regular file etc., leave untouched
          }
        } catch (_) { /* skillsDir absent -> create link below */ }
        if (needLink) fs.symlinkSync(globalSkills, skillsDir);
      }
    } catch (_) { /* best-effort: skills stay invisible but spawn still works */ }
    return { env: { CODEX_HOME: home }, skipDefaultModel: false, aliasOnly: false, providerModel: null, providerModels: [], providerName: p.name, codexHome: home };
  } catch (_) {
    return { env: {}, skipDefaultModel: false, aliasOnly: false, providerModel: null, providerModels: [], providerName: p.name };
  }
}

// ── Provider token usage stats ────────────────────────────────────────────
// Reads token_usage.json (persistent per-session accumulator) for cumulative
// totals, and token_daily.json for today/week/month time-window breakdowns.
// Sessions without a provider are grouped into "_default_".
const SESSIONS_FILE = RUNTIME_PATHS.sessionsFile;
const TOKEN_USAGE_FILE = RUNTIME_PATHS.tokenUsageFile;
const TOKEN_DAILY_FILE = RUNTIME_PATHS.tokenDailyFile;

// sessions.json was historically a bare array. StateStore persists the same
// records in a versioned { __multiccSchema, data } envelope. Keep both
// shapes readable while the rest of the runtime migrates incrementally.
function sessionRecords(document) {
  if (Array.isArray(document)) return document;
  if (document && Array.isArray(document.data)) return document.data;
  return [];
}

// Returns the date-key string YYYY-MM-DD for a given Date.
function dateKey(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function validDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

function safeUsageCount(value) {
  let numeric = value;
  if (typeof numeric === 'string' && /^\d+$/.test(numeric.trim())) {
    numeric = Number(numeric.trim());
  }
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
}

function normalizedUsageBucket(value) {
  const bucket = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const inputTokens = safeUsageCount(bucket.consumedInputTokens == null
    ? bucket.inputTokens
    : bucket.consumedInputTokens);
  const freshInputTokens = safeUsageCount(bucket.freshInputTokens);
  const cacheReadTokens = safeUsageCount(bucket.cacheReadTokens);
  const cacheWriteTokens = safeUsageCount(bucket.cacheWriteTokens);
  const breakdownKnown = typeof bucket.breakdownKnown === 'boolean'
    ? bucket.breakdownKnown
    : ['freshInputTokens', 'cacheReadTokens', 'cacheWriteTokens']
      .some(key => Object.prototype.hasOwnProperty.call(bucket, key));
  return {
    inputTokens,
    consumedInputTokens: inputTokens,
    freshInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    unattributedInputTokens: Math.max(
      0,
      inputTokens - freshInputTokens - cacheReadTokens - cacheWriteTokens,
    ),
    breakdownKnown,
    outputTokens: safeUsageCount(bucket.outputTokens),
    turnCount: safeUsageCount(bucket.turnCount),
  };
}

function readUsageObject(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) {
    return {};
  }
}

function usageWindowBounds(now = new Date()) {
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return {
    today: dateKey(now),
    week: dateKey(weekStart),
    month: dateKey(new Date(now.getFullYear(), now.getMonth(), 1)),
  };
}

function validUsageProviderId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 180
    && value !== '__proto__' && value !== 'prototype' && value !== 'constructor';
}

function addUsageWindow(target, providerId, source) {
  if (!validUsageProviderId(providerId)) return;
  const bucket = normalizedUsageBucket(source);
  const current = Object.prototype.hasOwnProperty.call(target, providerId)
    ? target[providerId]
    : normalizedUsageBucket({});
  current.inputTokens += bucket.inputTokens;
  current.consumedInputTokens = current.inputTokens;
  current.freshInputTokens += bucket.freshInputTokens;
  current.cacheReadTokens += bucket.cacheReadTokens;
  current.cacheWriteTokens += bucket.cacheWriteTokens;
  current.breakdownKnown = current.breakdownKnown || bucket.breakdownKnown;
  current.unattributedInputTokens = Math.max(
    0,
    current.inputTokens - current.freshInputTokens - current.cacheReadTokens - current.cacheWriteTokens,
  );
  current.outputTokens += bucket.outputTokens;
  current.turnCount += bucket.turnCount;
  target[providerId] = current;
}

function addDatedUsage(result, bounds, dayKey, providerId, source) {
  addUsageWindow(result.all, providerId, source);
  if (dayKey < bounds.month) return;
  addUsageWindow(result.month, providerId, source);
  if (dayKey < bounds.week) return;
  addUsageWindow(result.week, providerId, source);
  if (dayKey === bounds.today) addUsageWindow(result.today, providerId, source);
}

// Reads the compatibility daily ledger. A CLI result is associated with the
// session's main Provider at commit time; exact cross-Provider request
// attribution remains owned by the separate role-token ledger.
function readDailyWindows() {
  const daily = readUsageObject(TOKEN_DAILY_FILE);
  const bounds = usageWindowBounds();
  const result = { today: {}, week: {}, month: {}, all: {} };
  for (const [dayKey, dayEntry] of Object.entries(daily)) {
    if (!validDateKey(dayKey) || !dayEntry || typeof dayEntry !== 'object' || Array.isArray(dayEntry)) continue;
    for (const [providerId, bucket] of Object.entries(dayEntry)) {
      addDatedUsage(result, bounds, dayKey, providerId, bucket);
    }
  }
  return result;
}

function getProviderUsageStats() {
  const total = {
    inputTokens: 0,
    consumedInputTokens: 0,
    freshInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    unattributedInputTokens: 0,
    breakdownKnown: false,
    outputTokens: 0,
    totalTokens: 0,
    turnCount: 0,
  };

  // Load persisted sessions to map session id → provider.
  let sessionProviderMap = new Map();
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const sessions = sessionRecords(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')));
      for (const s of sessions) {
        const pid = s.provider || '';
        sessionProviderMap.set(s.id, pid || null);
      }
    }
  } catch (_) {}

  // Load provider metadata for names & appType.
  const providers = loadStore();
  const providerMeta = new Map();
  for (const p of providers) {
    providerMeta.set(p.id, { name: p.name, appType: p.appType });
  }

  // The session ledger remains the authoritative global total, including
  // deleted sessions. It is deliberately NOT projected onto each session's
  // current Provider: doing so moves the whole past when a session switches.
  let accum = {};
  try { accum = JSON.parse(fs.readFileSync(TOKEN_USAGE_FILE, 'utf8')); } catch (_) {}
  if (typeof accum !== 'object' || Array.isArray(accum)) accum = {};

  for (const [sessionId, entry] of Object.entries(accum)) {
    const bucket = normalizedUsageBucket(entry);
    total.inputTokens += bucket.inputTokens;
    total.consumedInputTokens = total.inputTokens;
    total.freshInputTokens += bucket.freshInputTokens;
    total.cacheReadTokens += bucket.cacheReadTokens;
    total.cacheWriteTokens += bucket.cacheWriteTokens;
    total.breakdownKnown = total.breakdownKnown || bucket.breakdownKnown;
    total.outputTokens += bucket.outputTokens;
    total.turnCount += bucket.turnCount || 1;
  }

  total.totalTokens = total.inputTokens + total.outputTokens;
  total.unattributedInputTokens = Math.max(
    0,
    total.inputTokens - total.freshInputTokens - total.cacheReadTokens - total.cacheWriteTokens,
  );

  // Provider attribution comes only from the daily ledger, which records the
  // Provider at event time. Missing historical attribution stays explicit
  // instead of being guessed from the session's current Provider.
  const dailyWindows = readDailyWindows();
  const providerMap = new Map(Object.entries(dailyWindows.all).map(([id, bucket]) => [
    id,
    { ...bucket, sessions: new Set() },
  ]));
  for (const [sessionId, providerId] of sessionProviderMap) {
    const key = providerId || '_default_';
    const bucket = providerMap.get(key);
    if (bucket) bucket.sessions.add(sessionId);
  }

  const stats = [];
  for (const [id, agg] of providerMap) {
    const meta = id === '_default_' ? { name: '默认登录', appType: null } : (providerMeta.get(id) || { name: id, appType: null });
    const dw = (w) => dailyWindows[w][id] || null;
    stats.push({
      providerId: id,
      providerName: meta.name,
      appType: meta.appType,
      inputTokens: agg.inputTokens,
      consumedInputTokens: agg.consumedInputTokens,
      freshInputTokens: agg.freshInputTokens,
      cacheReadTokens: agg.cacheReadTokens,
      cacheWriteTokens: agg.cacheWriteTokens,
      unattributedInputTokens: agg.unattributedInputTokens,
      breakdownKnown: agg.breakdownKnown,
      outputTokens: agg.outputTokens,
      totalTokens: agg.inputTokens + agg.outputTokens,
      turnCount: agg.turnCount,
      sessionCount: agg.sessions.size,
      today: dw('today'),
      week: dw('week'),
      month: dw('month'),
    });
  }

  stats.sort((a, b) => b.totalTokens - a.totalTokens);
  const attributed = stats.reduce((sum, entry) => ({
    inputTokens: sum.inputTokens + entry.inputTokens,
    outputTokens: sum.outputTokens + entry.outputTokens,
    turnCount: sum.turnCount + entry.turnCount,
  }), { inputTokens: 0, outputTokens: 0, turnCount: 0 });
  return {
    stats,
    total,
    unattributed: {
      inputTokens: Math.max(0, total.inputTokens - attributed.inputTokens),
      outputTokens: Math.max(0, total.outputTokens - attributed.outputTokens),
      turnCount: Math.max(0, total.turnCount - attributed.turnCount),
    },
  };
}

// ── Relay probe + cc-switch source correction ────────────────────────────────

// Candidate wire names probed to discover what an alias-only relay accepts.
// All Anthropic-compatible relays accept claude-* names; this confirms which.
const PROBE_CANDIDATES = ['claude-sonnet-4-5', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-sonnet-4.5', 'claude-sonnet-5'];

// Env vars that select a model — stripped from the probe child so the candidate
// `--model` is authoritative (otherwise an alias target would shadow it).
const PROBE_STRIP_KEYS = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL'];

// Probe one candidate by spawning the real claude CLI with the provider's env and
// `--model <candidate>`. Raw /v1/messages probing is unreliable because picky
// relays (e.g. iFlytek) reject anything but the CLI's full request shape; the CLI
// is the ground truth for what multicc itself will send. Resolves {model, ok, sample}.
function _probeCandidate(cliCmd, baseEnv, model) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...baseEnv };
    for (const k of PROBE_STRIP_KEYS) delete env[k];
    const child = spawn(cliCmd, ['-p', '--model', model, '--max-turns', '1', '--dangerously-skip-permissions', 'hi'], { env, windowsHide: true });
    let out = '';
    const sink = (c) => { if (out.length < 2048) out += c.toString(); };
    child.stdout.on('data', sink);
    child.stderr.on('data', sink);
    const to = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 25000);
    child.on('error', () => { clearTimeout(to); resolve({ model, ok: false, reason: 'spawn failed (is the claude CLI installed?)' }); });
    child.on('close', () => {
      clearTimeout(to);
      const rejected = /1211|模型不存在|model.*(not found|不存在)|model_not_found/i.test(out);
      resolve({ model, ok: !rejected, sample: out.slice(0, 95) });
    });
  });
}

// Probe which candidate model names a relay accepts. Spawns the claude CLI per
// candidate (sequential; ~N×turn). Returns { tested:[{model,ok,...}], accepted:[model,...] }.
async function probeRelayModels(baseEnv, candidates, cliCmd) {
  const cands = (candidates && candidates.length) ? candidates : PROBE_CANDIDATES;
  if (!baseEnv || !baseEnv.ANTHROPIC_BASE_URL) return { tested: [], accepted: [], error: 'no base url' };
  const cmd = cliCmd || 'claude';
  const tested = [];
  for (const m of cands) tested.push(await _probeCandidate(cmd, baseEnv, m));
  return { tested, accepted: tested.filter(o => o.ok).map(o => o.model) };
}

// Rewrite a child process env so claude routes through the local claude-proxy
// (cli-provider-router) instead of the provider's real endpoint. Only applies to
// provider-backed sessions — default-login sessions have no provider creds for
// the proxy to forward, so they bypass and use OAuth/login directly.
//
// The real provider token is intentionally kept OUT of the child env: the proxy
// resolves it live from the store at request time, so a leaked child env reveals
// only the virtual `multicc-<sessionId>` token (useless outside the proxy).
//
// `subagent = {providerId, model}` routes Task-tool subagent requests to a
// DIFFERENT provider by setting CLAUDE_CODE_SUBAGENT_MODEL to the combined
// `ccfw:<providerId>:<model>` string the proxy parses. Omit it (or leave empty)
// and subagents share the main provider.
//
// A session can have a non-empty `providerId` that still has no baseUrl (e.g.
// a "Claude Official"/OAuth-passthrough provider entry someone selected
// explicitly) — routing that through the proxy just 502s ("no baseUrl") since
// there is nothing to forward to. Bypass in that case exactly like the
// no-provider case (found 2026-07-05: a live session had this set and every
// turn was 502ing silently through the proxy).
// `officialOAuth` (opt-in, default off): when true, a provider that has no
// ANTHROPIC_BASE_URL — i.e. a "Claude Official"/OAuth-subscription entry — is
// ALSO routed through the proxy instead of bypassed. The proxy then replays the
// Keychain OAuth token to api.anthropic.com, which is what lets an official
// session route its subagents to cheaper providers. See cli-provider-router.
function applyClaudeProxyEnv(env, options) {
  return cliProviderRouter.applyClaudeProxyEnv(env, { ...options, getProvider });
}

function codexProviderProxyable(providerOrId) {
  return cliProviderRouter.codexProviderProxyable(providerOrId, { getProvider });
}

const materializeCodexRoutingHome = cliProviderRouter.materializeCodexRoutingHome;

function applyCodexProxyConfig(env, options) {
  return cliProviderRouter.applyCodexProxyConfig(env, { ...options, getProvider });
}

module.exports = {
  ccSwitchAvailable,
  getCcSwitchStatus,
  appTypeForCli,
  appTypesForCli,
  providerSupportsCli,
  normalizeApiFormat,
  compatibleClisForFormat,
  API_FORMATS,
  APP_TYPES,
  listProviders,
  getProvider,
  getProviderSummary,
  resolveAuxHttpTarget,
  resolveCodexDirectHttp,
  createProvider,
  updateProvider,
  deleteProvider,
  importFromCcSwitch,
  migrateLegacyProviderProtocols,
  resolveSpawnEnv,
  buildChildEnv,
  materializeCodexAuth,
  applyClaudeProxyEnv,
  applyCodexProxyConfig,
  materializeCodexRoutingHome,
  codexProviderProxyable,
  resolveSessionWireModel,
  modelValidForProvider,
  readCodexOfficialModels,
  CODEX_OFFICIAL_MODELS_FALLBACK,
  summarize,
  getProviderUsageStats,
  readDailyWindows,
  CLAUDE_ROUTING_KEYS,
  ANTHROPIC_ROUTING_KEYS,
  CODEX_HOMES_DIR,
  WIRE_DEFAULT_MODEL,
  probeRelayModels,
};
