'use strict';

// Per-session provider integration backed by cc-switch's SQLite store.
//
// cc-switch (~/.cc-switch/cc-switch.db) keeps a `providers` table keyed by
// (id, app_type). For app_type='claude' the `settings_config` JSON mirrors
// ~/.claude/settings.json — the interesting part is its `env` block holding
// ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL. For app_type=
// 'codex' it holds `auth` (→ auth.json) and `config` (→ config.toml).
//
// multicc spawns one `claude`/`codex` child per turn, so we can make each
// session route to a different provider simply by injecting that provider's
// env into the specific child — siblings stay independent. The cc-switch DB is
// the single source of truth; multicc never duplicates the secrets.

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

let Database;
try { Database = require('better-sqlite3'); } catch (_) { Database = null; }

const CC_DB = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
// Per-provider CODEX_HOME dirs materialized on demand so codex sessions can
// point at different auth/config without clobbering the global ~/.codex.
const CODEX_HOMES_DIR = path.join(os.homedir(), '.multicc', 'codex-homes');

const APP_TYPES = ['claude', 'codex'];

function available() {
  return !!Database && fs.existsSync(CC_DB);
}

function openDb(readonly = true) {
  if (!Database) throw new Error('better-sqlite3 not installed');
  if (!fs.existsSync(CC_DB)) throw new Error('cc-switch database not found at ' + CC_DB);
  // busy timeout lets us coexist with the cc-switch desktop app holding the db.
  return new Database(CC_DB, { readonly, fileMustExist: true, timeout: 4000 });
}

function parseConfig(s) {
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

// Public-safe summary — never leaks a full token (only masked) to the frontend.
function summarize(row) {
  const cfg = parseConfig(row.settings_config);
  let baseUrl = '', model = '', token = '';
  if (row.app_type === 'claude') {
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
    id: row.id,
    appType: row.app_type,
    name: row.name,
    category: row.category || null,
    isCurrent: !!row.is_current,
    baseUrl,
    model,
    tokenMask: maskToken(token),
    hasToken: !!token,
    // "official" = no custom base url → uses the OAuth subscription / default login.
    isOfficial: !baseUrl,
  };
}

function listProviders(appType) {
  if (!available()) return [];
  const db = openDb(true);
  try {
    const rows = appType
      ? db.prepare('SELECT * FROM providers WHERE app_type=? ORDER BY sort_index, name').all(appType)
      : db.prepare('SELECT * FROM providers ORDER BY app_type, sort_index, name').all();
    return rows.map(summarize);
  } finally { db.close(); }
}

function getProviderRow(appType, id) {
  if (!available() || !id) return null;
  const db = openDb(true);
  try {
    return db.prepare('SELECT * FROM providers WHERE app_type=? AND id=?').get(appType, id) || null;
  } finally { db.close(); }
}

function getProviderSummary(appType, id) {
  const row = getProviderRow(appType, id);
  return row ? summarize(row) : null;
}

function nextSortIndex(db, appType) {
  const r = db.prepare('SELECT MAX(sort_index) AS m FROM providers WHERE app_type=?').get(appType);
  return (r && Number.isFinite(r.m) ? r.m : 0) + 1;
}

// Build a cc-switch settings_config object from simple fields when the caller
// didn't pass a full one. claude → {env:{ANTHROPIC_*}}, codex → {auth, config}.
function buildSettingsConfig(appType, { baseUrl, authToken, model }) {
  if (appType === 'claude') {
    const env = {};
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    if (authToken) env.ANTHROPIC_AUTH_TOKEN = authToken;
    if (model) env.ANTHROPIC_MODEL = model;
    return { env };
  }
  const slug = String(model ? 'custom' : 'custom'); // provider id in toml
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

function createProvider({ appType, name, baseUrl, authToken, model, settingsConfig }) {
  if (!available()) throw new Error('cc-switch database not available');
  if (!APP_TYPES.includes(appType)) throw new Error('appType must be claude or codex');
  if (!name || !String(name).trim()) throw new Error('name required');
  const cfg = (settingsConfig && typeof settingsConfig === 'object')
    ? settingsConfig
    : buildSettingsConfig(appType, { baseUrl, authToken, model });
  const id = crypto.randomUUID();
  const db = openDb(false);
  try {
    db.prepare(
      `INSERT INTO providers
         (id, app_type, name, settings_config, category, created_at, sort_index,
          meta, is_current, in_failover_queue, cost_multiplier)
       VALUES (?,?,?,?,?,?,?, '{}', 0, 0, '1.0')`
    ).run(id, appType, String(name).trim(), JSON.stringify(cfg), 'custom',
      Date.now(), nextSortIndex(db, appType));
    return { id, appType, name: String(name).trim() };
  } finally { db.close(); }
}

function updateProvider(appType, id, { name, baseUrl, authToken, model, settingsConfig }) {
  const row = getProviderRow(appType, id);
  if (!row) throw new Error('provider not found');
  let cfg = parseConfig(row.settings_config);
  if (settingsConfig && typeof settingsConfig === 'object') {
    cfg = settingsConfig;
  } else if (appType === 'claude') {
    cfg.env = cfg.env || {};
    if (baseUrl !== undefined) { if (baseUrl) cfg.env.ANTHROPIC_BASE_URL = baseUrl; else delete cfg.env.ANTHROPIC_BASE_URL; }
    if (authToken !== undefined && authToken) cfg.env.ANTHROPIC_AUTH_TOKEN = authToken;
    if (model !== undefined) { if (model) cfg.env.ANTHROPIC_MODEL = model; else delete cfg.env.ANTHROPIC_MODEL; }
  } else {
    // codex: rebuild config toml when base/model change, keep existing auth unless a new token is given.
    const merged = buildSettingsConfig('codex', {
      baseUrl: baseUrl !== undefined ? baseUrl : tomlValue(cfg.config, 'base_url'),
      authToken: authToken || (cfg.auth && cfg.auth.OPENAI_API_KEY) || '',
      model: model !== undefined ? model : tomlValue(cfg.config, 'model'),
    });
    cfg = { ...cfg, ...merged };
  }
  const db = openDb(false);
  try {
    db.prepare('UPDATE providers SET name=COALESCE(?,name), settings_config=? WHERE app_type=? AND id=?')
      .run(name ? String(name).trim() : null, JSON.stringify(cfg), appType, id);
    return { id, appType };
  } finally { db.close(); }
}

function deleteProvider(appType, id) {
  if (!available()) throw new Error('cc-switch database not available');
  const db = openDb(false);
  try {
    const info = db.prepare('DELETE FROM providers WHERE app_type=? AND id=?').run(appType, id);
    return info.changes > 0;
  } finally { db.close(); }
}

// Compute the env overrides + flags to apply when spawning a child for `session`.
// Returns { env, skipDefaultModel, providerName }.
//   - env: object merged into the child's process env (only this child).
//   - skipDefaultModel: claude routes elsewhere → don't force the global --model
//     default (let the provider's ANTHROPIC_MODEL decide).
function resolveSpawnEnv(session) {
  const providerId = session && session.provider;
  if (!providerId || !available()) return { env: {}, skipDefaultModel: false, providerName: null };
  const appType = (session.cli === 'codex') ? 'codex' : 'claude';
  const row = getProviderRow(appType, providerId);
  if (!row) return { env: {}, skipDefaultModel: false, providerName: null };
  const cfg = parseConfig(row.settings_config);

  if (appType === 'claude') {
    const env = {};
    const src = cfg.env || {};
    for (const k of Object.keys(src)) {
      if (/^ANTHROPIC_/.test(k) && typeof src[k] === 'string') env[k] = src[k];
    }
    return { env, skipDefaultModel: !!env.ANTHROPIC_BASE_URL, providerName: row.name };
  }

  // codex: materialize a dedicated CODEX_HOME so this session's auth/config is isolated.
  try {
    const home = path.join(CODEX_HOMES_DIR, providerId);
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    if (cfg.auth) fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(cfg.auth, null, 2));
    if (cfg.config) fs.writeFileSync(path.join(home, 'config.toml'), cfg.config);
    return { env: { CODEX_HOME: home }, skipDefaultModel: false, providerName: row.name, codexHome: home };
  } catch (_) {
    return { env: {}, skipDefaultModel: false, providerName: row.name };
  }
}

module.exports = {
  available,
  listProviders,
  getProviderRow,
  getProviderSummary,
  createProvider,
  updateProvider,
  deleteProvider,
  resolveSpawnEnv,
  CODEX_HOMES_DIR,
};
