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
const { execSync, spawn } = require('child_process');

const PROJECT_DIR = path.join(__dirname, '..');

let Database;
try { Database = require('better-sqlite3'); } catch (_) { Database = null; }

// On-demand install of better-sqlite3 — only when the user triggers the
// cc-switch import. Most users never touch this feature, so paying the
// native-compilation cost upfront wastes time and breaks on machines
// without build toolchains.
//
// Windows: better-sqlite3 needs node-gyp → Visual Studio Build Tools + Python.
// Pre-built binaries are available for common Node/arch combos and npm install
// will prefer them; native compilation is the fallback.
function ensureDatabase() {
  if (Database) return true;
  console.log('[multicc] better-sqlite3 not installed — installing on demand (cc-switch import)…');
  try {
    execSync('npm install better-sqlite3@^12.6.2 --no-save', {
      cwd: PROJECT_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000,
    });
    Database = require('better-sqlite3');
    console.log('[multicc] better-sqlite3 installed and loaded');
    return true;
  } catch (e) {
    console.error('[multicc] Failed to install better-sqlite3:', e.message);
    return false;
  }
}

function nativeBuildHint() {
  switch (process.platform) {
    case 'darwin':
      return '  xcode-select --install';
    case 'win32':
      return '  npm install --global windows-build-tools\n' +
        '  (Or install Visual Studio Build Tools with "Desktop development with C++" + Python 3)';
    default:
      return '  sudo apt-get install -y build-essential python3 make g++';
  }
}

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
const STORE_FILE = path.join(__dirname, '..', 'providers.json');
// Per-provider CODEX_HOME dirs materialized on demand so codex sessions can
// point at different auth/config without clobbering the global ~/.codex.
const CODEX_HOMES_DIR = path.join(os.homedir(), '.multicc', 'codex-homes');

const APP_TYPES = ['claude', 'codex'];

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
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(list, null, 2)); }
  catch (e) { console.error('[multicc] save providers.json failed:', e.message); }
}

function ccSwitchAvailable() { return fs.existsSync(resolveCcDb()); }

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
function buildSettingsConfig(appType, { baseUrl, authToken, model, models, providerId, useChatResponsesProxy, aliasMap }) {
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
  // settingsConfig.proxyTarget for src/codex-proxy.js to read.
  const proxySpec = useChatResponsesProxy ? codexProxyTarget(baseUrl) : null;
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

// Public-safe summary — never leaks a full token (only masked).
function summarize(p) {
  const cfg = parseConfig(p.settingsConfig);
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
    // values, so the spawn path substitutes a safe wire default (see buildChatSpawnArgs).
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
  }
  return {
    id: p.id,
    appType: p.appType,
    name: p.name,
    source: p.source || 'local', // 'local' | 'ccswitch'
    baseUrl,
    model,
    modelOptions,
    aliasOnly,
    aliasMap,
    useChatResponsesProxy: !!cfg.proxyTarget,
    tokenMask: maskToken(token),
    hasToken: !!token,
    isOfficial: !baseUrl, // no custom base url -> default login / subscription
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

function createProvider({ appType, name, baseUrl, authToken, model, models, useChatResponsesProxy, settingsConfig, aliasMap }) {
  if (!APP_TYPES.includes(appType)) throw new Error('appType must be claude or codex');
  if (!name || !String(name).trim()) throw new Error('name required');
  // Generate id first so buildSettingsConfig can embed it in the proxy base_url.
  const id = crypto.randomUUID();
  const cfg = (settingsConfig && typeof settingsConfig === 'object')
    ? settingsConfig
    : buildSettingsConfig(appType, { baseUrl, authToken, model, models, useChatResponsesProxy, providerId: id, aliasMap });
  const p = {
    id,
    appType,
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

function updateProvider(appType, id, { name, baseUrl, authToken, model, models, useChatResponsesProxy, settingsConfig, aliasMap }) {
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
    const nextProxy = useChatResponsesProxy !== undefined
      ? !!useChatResponsesProxy
      : !!cfg.proxyTarget;
    const rebuilt = buildSettingsConfig('codex', {
      baseUrl: baseUrl !== undefined ? baseUrl : currentBaseUrl,
      authToken: authToken || (cfg.auth && cfg.auth.OPENAI_API_KEY) || '',
      model: model !== undefined ? model : tomlValue(cfg.config, 'model'),
      models: models !== undefined
        ? models
        : ((cfg.modelCatalog && Array.isArray(cfg.modelCatalog.models)) ? cfg.modelCatalog.models.map(m => m && m.model).filter(Boolean) : undefined),
      useChatResponsesProxy: nextProxy,
      providerId: id,
    });
    // Drop a stale proxyTarget if the user switched to a non-domestic baseUrl.
    cfg = { ...cfg, ...rebuilt };
    if (!rebuilt.proxyTarget) delete cfg.proxyTarget;
  }
  if (name) p.name = String(name).trim();
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
function importFromCcSwitch() {
  const ccDb = resolveCcDb();
  if (!fs.existsSync(ccDb)) throw new Error('cc-switch database not found at ' + ccDb);
  if (!ensureDatabase()) {
    throw new Error(
      'Failed to install better-sqlite3 (native compilation).\n' +
      'Install build tools and retry:\n' + nativeBuildHint() + '\n' +
      'Or manually: cd ' + PROJECT_DIR + ' && npm install better-sqlite3'
    );
  }
  const db = new Database(ccDb, { readonly: true, fileMustExist: true, timeout: 4000 });
  let rows;
  try {
    rows = db.prepare('SELECT id, app_type, name, settings_config FROM providers ORDER BY app_type, sort_index, name').all();
  } finally { db.close(); }

  const list = loadStore();
  const byKey = new Map(list.map((p, i) => [`${p.appType}:${p.id}`, i]));
  let imported = 0, updated = 0;
  for (const r of rows) {
    if (!APP_TYPES.includes(r.app_type)) continue;
    const cfg = parseConfig(r.settings_config);
    // Keep cc-switch's REAL model ids in the stored env so the editor / model
    // picker shows e.g. glm-5.2 (not a claude-* wire name). The spawn path
    // (resolveSpawnEnv) applies the safe wire default to alias-only relays at
    // spawn time, so we deliberately do NOT overwrite the env at import.
    const entry = {
      id: r.id,
      appType: r.app_type,
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
  const appType = (session && session.cli === 'codex') ? 'codex' : 'claude';
  if (appType === 'claude') {
    for (const k of CLAUDE_ROUTING_KEYS) delete env[k];
  }
  const spawn = resolveSpawnEnv(session);
  Object.assign(env, extra, spawn.env);
  return {
    env,
    skipDefaultModel: spawn.skipDefaultModel,
    aliasOnly: spawn.aliasOnly,
    providerModel: spawn.providerModel,
    providerModels: spawn.providerModels,
    providerName: spawn.providerName,
    codexHome: spawn.codexHome,
    tools: spawn.tools,
  };
}

// Compute env overrides + flags to apply when spawning a child for `session`.
//   - env: object merged into the child's process env (only this child).
//   - skipDefaultModel: claude routes elsewhere → don't force the global --model.
function resolveSpawnEnv(session) {
  const providerId = session && session.provider;
  if (!providerId) return { env: {}, skipDefaultModel: false, aliasOnly: false, providerModel: null, providerModels: [], providerName: null };
  const appType = (session.cli === 'codex') ? 'codex' : 'claude';
  const p = getProvider(appType, providerId);
  if (!p) return { env: {}, skipDefaultModel: false, aliasOnly: false, providerModel: null, providerModels: [], providerName: null };
  const cfg = parseConfig(p.settingsConfig);

  if (appType === 'claude') {
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
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    if (cfg.auth) {
      fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(cfg.auth, null, 2));
    } else {
      const baseUrl = tomlValue(cfg.config, 'base_url');
      if (!baseUrl) {
        const globalAuth = path.join(os.homedir(), '.codex', 'auth.json');
        const authPath = path.join(home, 'auth.json');
        if (fs.existsSync(globalAuth)) fs.copyFileSync(globalAuth, authPath);
        else if (fs.existsSync(authPath)) fs.rmSync(authPath, { force: true });
      }
    }
    if (cfg.config) {
      // cc-switch 导入的 config 可能带 model_catalog_json 指向 cc-switch 自己目录里的
      // 文件（codex home 里没有），导致 codex 启动时 "config could not be loaded" → exit 1。
      // 同时折叠 [model_providers] 空表头 + [model_providers.custom] 子表的写法。
      let toml = cfg.config;
      toml = toml.replace(/^model_catalog_json\s*=.*$/gm, '').replace(/\n{3,}/g, '\n\n');
      toml = toml.replace(/\[model_providers\]\s*\n\[model_providers\.custom\]/, '[model_providers.custom]');
      fs.writeFileSync(path.join(home, 'config.toml'), toml);
    }
    return { env: { CODEX_HOME: home }, skipDefaultModel: false, aliasOnly: false, providerModel: null, providerModels: [], providerName: p.name, codexHome: home };
  } catch (_) {
    return { env: {}, skipDefaultModel: false, aliasOnly: false, providerModel: null, providerModels: [], providerName: p.name };
  }
}

// ── Provider token usage stats ────────────────────────────────────────────
// Reads token_usage.json (persistent per-session accumulator) for cumulative
// totals, and token_daily.json for today/week/month time-window breakdowns.
// Sessions without a provider are grouped into "_default_".
const SESSIONS_FILE = path.join(__dirname, '..', 'sessions.json');
const TOKEN_USAGE_FILE = path.join(__dirname, '..', 'token_usage.json');
const TOKEN_DAILY_FILE = path.join(__dirname, '..', 'token_daily.json');

// Returns the date-key string YYYY-MM-DD for a given Date.
function dateKey(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// Reads token_daily.json and computes today / week / month / all windows per provider.
function readDailyWindows() {
  let daily = {};
  try { daily = JSON.parse(fs.readFileSync(TOKEN_DAILY_FILE, 'utf8')); } catch (_) {}
  if (typeof daily !== 'object' || Array.isArray(daily)) daily = {};

  const now = new Date();
  const todayStr = dateKey(now);

  // Week start (Monday)
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const weekStartStr = dateKey(weekStart);

  // Month start
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthStartStr = dateKey(monthStart);

  const result = { today: {}, week: {}, month: {}, all: {} };

  const add = (target, provId, inp, out, tc) => {
    const e = target[provId] || { inputTokens: 0, outputTokens: 0, turnCount: 0 };
    e.inputTokens += inp;
    e.outputTokens += out;
    e.turnCount += tc;
    target[provId] = e;
  };

  for (const [dk, dayEntry] of Object.entries(daily)) {
    for (const [pid, p] of Object.entries(dayEntry)) {
      add(result.all, pid, p.inputTokens, p.outputTokens, p.turnCount);
      if (dk >= monthStartStr) {
        add(result.month, pid, p.inputTokens, p.outputTokens, p.turnCount);
        if (dk >= weekStartStr) {
          add(result.week, pid, p.inputTokens, p.outputTokens, p.turnCount);
          if (dk === todayStr) {
            add(result.today, pid, p.inputTokens, p.outputTokens, p.turnCount);
          }
        }
      }
    }
  }
  return result;
}

function getProviderUsageStats() {
  const providerMap = new Map();  // providerId → { inputTokens, outputTokens, turnCount, sessionCount }
  const total = { inputTokens: 0, outputTokens: 0, totalTokens: 0, turnCount: 0 };

  // Load persisted sessions to map session id → provider.
  let sessionProviderMap = new Map();
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      for (const s of (Array.isArray(sessions) ? sessions : [])) {
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

  // Primary source: persistent token_usage.json (never trimmed)
  let accum = {};
  try { accum = JSON.parse(fs.readFileSync(TOKEN_USAGE_FILE, 'utf8')); } catch (_) {}
  if (typeof accum !== 'object' || Array.isArray(accum)) accum = {};

  for (const [sessionId, entry] of Object.entries(accum)) {
    const providerId = sessionProviderMap.get(sessionId) || null;
    const key = (providerId === null || providerId === '') ? '_default_' : providerId;
    const inp = entry.inputTokens || 0;
    const out = entry.outputTokens || 0;
    const tc = entry.turnCount || 1;

    if (!providerMap.has(key)) {
      providerMap.set(key, { inputTokens: 0, outputTokens: 0, turnCount: 0, sessions: new Set() });
    }
    const agg = providerMap.get(key);
    agg.inputTokens += inp;
    agg.outputTokens += out;
    agg.turnCount += tc;
    agg.sessions.add(sessionId);

    total.inputTokens += inp;
    total.outputTokens += out;
    total.turnCount += tc;
  }

  total.totalTokens = total.inputTokens + total.outputTokens;

  // Time-window breakdown from daily aggregation
  const dailyWindows = readDailyWindows();

  const stats = [];
  for (const [id, agg] of providerMap) {
    const meta = id === '_default_' ? { name: '默认登录', appType: null } : (providerMeta.get(id) || { name: id, appType: null });
    const dw = (w) => dailyWindows[w][id] || null;
    stats.push({
      providerId: id,
      providerName: meta.name,
      appType: meta.appType,
      inputTokens: agg.inputTokens,
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
  return { stats, total };
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
// (src/claude-proxy.js) instead of the provider's real endpoint. Only applies to
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
// session route its subagents to cheaper providers. See src/claude-proxy.js.
function applyClaudeProxyEnv(env, { providerId, sessionId, subagent, port, enabled, officialOAuth }) {
  if (!enabled) return;
  if (!providerId || !sessionId || !port) return;
  const p = getProvider('claude', providerId);
  const cfg = p ? parseConfig(p.settingsConfig) : {};
  const hasBase = !!(cfg.env && cfg.env.ANTHROPIC_BASE_URL);
  // No custom baseUrl → normally bypass (nothing to forward to). Exception: the
  // canonical `claude-official` provider when the opt-in OAuth toggle is on —
  // route it too so the proxy can replay the Keychain OAuth token. Other
  // empty-baseUrl providers still bypass (they are not the subscription login).
  const isOfficial = providerId === 'claude-official';
  if (!hasBase && !(officialOAuth && isOfficial)) return;
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}/claude-proxy/${providerId}/${sessionId}`;
  env.ANTHROPIC_AUTH_TOKEN = `multicc-${sessionId}`;
  delete env.ANTHROPIC_API_KEY; // real creds stay in the store; proxy resolves them
  if (subagent && subagent.providerId && subagent.model) {
    env.CLAUDE_CODE_SUBAGENT_MODEL = `ccfw:${subagent.providerId}:${subagent.model}`;
  } else {
    delete env.CLAUDE_CODE_SUBAGENT_MODEL; // never let a stale inherited value leak
  }
}

module.exports = {
  ccSwitchAvailable,
  listProviders,
  getProvider,
  getProviderSummary,
  createProvider,
  updateProvider,
  deleteProvider,
  importFromCcSwitch,
  resolveSpawnEnv,
  buildChildEnv,
  applyClaudeProxyEnv,
  resolveSessionWireModel,
  getProviderUsageStats,
  readDailyWindows,
  CLAUDE_ROUTING_KEYS,
  ANTHROPIC_ROUTING_KEYS,
  CODEX_HOMES_DIR,
  WIRE_DEFAULT_MODEL,
  probeRelayModels,
};
