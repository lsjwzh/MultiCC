'use strict';

// Per-session provider config — owned by multicc, importable from cc-switch.
//
// multicc keeps its OWN provider store (providers.json) and never writes into
// cc-switch's database. cc-switch (~/.cc-switch/cc-switch.db) is only an import
// SOURCE: the user can pull its provider list into multicc's store, then add /
// edit / delete freely here without touching cc-switch.
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
const { execSync } = require('child_process');

const PROJECT_DIR = path.join(__dirname, '..');

let Database;
try { Database = require('better-sqlite3'); } catch (_) { Database = null; }

// On-demand install of better-sqlite3 — only when the user triggers the
// cc-switch import. Most users never touch this feature, so paying the
// native-compilation cost upfront wastes time and breaks on machines
// without build toolchains.
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

const CC_DB = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
// multicc's own store, in the project root (one level up from src/).
const STORE_FILE = path.join(__dirname, '..', 'providers.json');
// Per-provider CODEX_HOME dirs materialized on demand so codex sessions can
// point at different auth/config without clobbering the global ~/.codex.
const CODEX_HOMES_DIR = path.join(os.homedir(), '.multicc', 'codex-homes');

const APP_TYPES = ['claude', 'codex'];

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

// The store is always usable (it's a local file). Distinct from cc-switch.
function available() { return true; }
function ccSwitchAvailable() { return fs.existsSync(CC_DB); }

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

// Build a cc-switch-shaped settingsConfig from simple fields.
function buildSettingsConfig(appType, { baseUrl, authToken, model, providerId }) {
  if (appType === 'claude') {
    const env = {};
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    if (authToken) env.ANTHROPIC_AUTH_TOKEN = authToken;
    if (model) env.ANTHROPIC_MODEL = model;
    return { env };
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
  const realTarget = detectDomesticTarget(baseUrl);
  const port = process.env.PORT || 3000;
  const proxyBaseUrl = (realTarget && providerId)
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
  const cfg = { auth: { OPENAI_API_KEY: authToken || null }, config: lines.join('\n') + '\n' };
  if (realTarget) {
    cfg.proxyTarget = { baseUrl: realTarget, apiKey: authToken || '' };
  }
  return cfg;
}

// Public-safe summary — never leaks a full token (only masked).
function summarize(p) {
  const cfg = parseConfig(p.settingsConfig);
  let baseUrl = '', model = '', token = '', modelOptions = [];
  if (p.appType === 'claude') {
    const env = cfg.env || {};
    baseUrl = env.ANTHROPIC_BASE_URL || '';
    model = env.ANTHROPIC_MODEL || '';
    token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
    // Collect all models this provider can serve: primary + DEFAULT_* overrides.
    const aliasKeys = ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'];
    const seen = new Set();
    const ordered = [];
    for (const v of [env.ANTHROPIC_MODEL, ...aliasKeys.map(k => env[k])]) {
      if (v && !seen.has(v)) { seen.add(v); ordered.push(v); }
    }
    modelOptions = ordered;
  } else {
    baseUrl = tomlValue(cfg.config, 'base_url');
    model = tomlValue(cfg.config, 'model');
    token = (cfg.auth && cfg.auth.OPENAI_API_KEY) ||
            (cfg.auth && cfg.auth.tokens && cfg.auth.tokens.access_token) || '';
  }
  return {
    id: p.id,
    appType: p.appType,
    name: p.name,
    source: p.source || 'local', // 'local' | 'ccswitch'
    baseUrl,
    model,
    modelOptions,
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

// Back-compat alias (server.js used getProviderRow previously).
const getProviderRow = getProvider;

function createProvider({ appType, name, baseUrl, authToken, model, settingsConfig }) {
  if (!APP_TYPES.includes(appType)) throw new Error('appType must be claude or codex');
  if (!name || !String(name).trim()) throw new Error('name required');
  // Generate id first so buildSettingsConfig can embed it in the proxy base_url.
  const id = crypto.randomUUID();
  const cfg = (settingsConfig && typeof settingsConfig === 'object')
    ? settingsConfig
    : buildSettingsConfig(appType, { baseUrl, authToken, model, providerId: id });
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

function updateProvider(appType, id, { name, baseUrl, authToken, model, settingsConfig }) {
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
  } else {
    const rebuilt = buildSettingsConfig('codex', {
      baseUrl: baseUrl !== undefined ? baseUrl : tomlValue(cfg.config, 'base_url'),
      authToken: authToken || (cfg.auth && cfg.auth.OPENAI_API_KEY) || '',
      model: model !== undefined ? model : tomlValue(cfg.config, 'model'),
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
  if (!fs.existsSync(CC_DB)) throw new Error('cc-switch database not found at ' + CC_DB);
  if (!ensureDatabase()) {
    const hint = process.platform === 'darwin'
      ? '  xcode-select --install'
      : '  sudo apt-get install -y build-essential python3 make g++';
    throw new Error(
      'Failed to install better-sqlite3 (native compilation).\n' +
      'Install build tools and retry:\n' + hint + '\n' +
      'Or manually: cd ' + PROJECT_DIR + ' && npm install better-sqlite3'
    );
  }
  const db = new Database(CC_DB, { readonly: true, fileMustExist: true, timeout: 4000 });
  let rows;
  try {
    rows = db.prepare('SELECT id, app_type, name, settings_config FROM providers ORDER BY app_type, sort_index, name').all();
  } finally { db.close(); }

  const list = loadStore();
  const byKey = new Map(list.map((p, i) => [`${p.appType}:${p.id}`, i]));
  let imported = 0, updated = 0;
  for (const r of rows) {
    if (!APP_TYPES.includes(r.app_type)) continue;
    const entry = {
      id: r.id,
      appType: r.app_type,
      name: r.name,
      source: 'ccswitch',
      settingsConfig: parseConfig(r.settings_config),
      importedAt: Date.now(),
    };
    const key = `${r.app_type}:${r.id}`;
    if (byKey.has(key)) { list[byKey.get(key)] = { ...list[byKey.get(key)], ...entry }; updated++; }
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
const CLAUDE_ROUTING_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SIMPLE',
];

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
    providerName: spawn.providerName,
    codexHome: spawn.codexHome,
  };
}

// Compute env overrides + flags to apply when spawning a child for `session`.
//   - env: object merged into the child's process env (only this child).
//   - skipDefaultModel: claude routes elsewhere → don't force the global --model.
function resolveSpawnEnv(session) {
  const providerId = session && session.provider;
  if (!providerId) return { env: {}, skipDefaultModel: false, providerName: null };
  const appType = (session.cli === 'codex') ? 'codex' : 'claude';
  const p = getProvider(appType, providerId);
  if (!p) return { env: {}, skipDefaultModel: false, providerName: null };
  const cfg = parseConfig(p.settingsConfig);

  if (appType === 'claude') {
    const env = {};
    const src = cfg.env || {};
    for (const k of Object.keys(src)) {
      if (/^ANTHROPIC_/.test(k) && typeof src[k] === 'string') env[k] = src[k];
    }
    // Custom provider → must bypass the user's OAuth/keychain login so the
    // request actually routes to the provider's endpoint with its own token.
    // Claude CLI auth precedence (v2.1.x): OAuth/keychain > ANTHROPIC_API_KEY >
    // ANTHROPIC_AUTH_TOKEN.  Without CLAUDE_CODE_SIMPLE=1, OAuth wins and the
    // provider's ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL are silently ignored.
if (env.ANTHROPIC_BASE_URL) {
  env.CLAUDE_CODE_SIMPLE = '1';
  // Only set ANTHROPIC_API_KEY if the provider explicitly provided one.
  // Auto-copying AUTH_TOKEN to API_KEY forces the x-api-key header on
  // providers that don't accept it (e.g. Zhipu GLM 401s because it only
  // reads Authorization: Bearer). Leave AUTH_TOKEN as-is for Bearer auth.
}    return { env, skipDefaultModel: !!env.ANTHROPIC_BASE_URL, providerName: p.name };
  }

  try {
    const home = path.join(CODEX_HOMES_DIR, providerId);
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    if (cfg.auth) fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(cfg.auth, null, 2));
    if (cfg.config) fs.writeFileSync(path.join(home, 'config.toml'), cfg.config);
    return { env: { CODEX_HOME: home }, skipDefaultModel: false, providerName: p.name, codexHome: home };
  } catch (_) {
    return { env: {}, skipDefaultModel: false, providerName: p.name };
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

module.exports = {
  available,
  ccSwitchAvailable,
  listProviders,
  getProvider,
  getProviderRow,
  getProviderSummary,
  createProvider,
  updateProvider,
  deleteProvider,
  importFromCcSwitch,
  resolveSpawnEnv,
  buildChildEnv,
  getProviderUsageStats,
  readDailyWindows,
  CLAUDE_ROUTING_KEYS,
  CODEX_HOMES_DIR,
};
