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

// Build a cc-switch-shaped settingsConfig from simple fields.
function buildSettingsConfig(appType, { baseUrl, authToken, model }) {
  if (appType === 'claude') {
    const env = {};
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    if (authToken) env.ANTHROPIC_AUTH_TOKEN = authToken;
    if (model) env.ANTHROPIC_MODEL = model;
    return { env };
  }
  const provName = 'custom';
  const lines = [
    `model_provider = "${provName}"`,
    model ? `model = "${model}"` : '',
    '',
    `[model_providers.${provName}]`,
    `name = "${provName}"`,
    baseUrl ? `base_url = "${baseUrl}"` : '',
    'wire_api = "responses"',
  ].filter(Boolean);
  return { auth: { OPENAI_API_KEY: authToken || null }, config: lines.join('\n') + '\n' };
}

// Public-safe summary — never leaks a full token (only masked).
function summarize(p) {
  const cfg = parseConfig(p.settingsConfig);
  let baseUrl = '', model = '', token = '';
  if (p.appType === 'claude') {
    const env = cfg.env || {};
    baseUrl = env.ANTHROPIC_BASE_URL || '';
    model = env.ANTHROPIC_MODEL || '';
    token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
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
    source: p.source || 'local',     // 'local' | 'ccswitch'
    baseUrl,
    model,
    tokenMask: maskToken(token),
    hasToken: !!token,
    isOfficial: !baseUrl,            // no custom base url → default login / subscription
  };
}

function listProviders(appType) {
  const list = loadStore().filter(p => !appType || p.appType === appType);
  return list.map(summarize);
}

function getProvider(appType, id) {
  return loadStore().find(p => p.appType === appType && p.id === id) || null;
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
  const cfg = (settingsConfig && typeof settingsConfig === 'object')
    ? settingsConfig
    : buildSettingsConfig(appType, { baseUrl, authToken, model });
  const p = {
    id: crypto.randomUUID(),
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
    cfg = {
      ...cfg,
      ...buildSettingsConfig('codex', {
        baseUrl: baseUrl !== undefined ? baseUrl : tomlValue(cfg.config, 'base_url'),
        authToken: authToken || (cfg.auth && cfg.auth.OPENAI_API_KEY) || '',
        model: model !== undefined ? model : tomlValue(cfg.config, 'model'),
      }),
    };
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
      // Prefer the token via ANTHROPIC_API_KEY (x-api-key header — highest
      // priority in SIMPLE mode) and keep ANTHROPIC_AUTH_TOKEN as a fallback
      // (Authorization: Bearer header for proxies that expect it).
      if (env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
        env.ANTHROPIC_API_KEY = env.ANTHROPIC_AUTH_TOKEN;
      }
    }
    return { env, skipDefaultModel: !!env.ANTHROPIC_BASE_URL, providerName: p.name };
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
  CODEX_HOMES_DIR,
};
