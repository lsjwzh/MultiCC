'use strict';

// ZCode native authentication module.
//
// Architecture:
//   • Desktop app stores API keys in plaintext in ~/.zcode/v2/config.json under
//     provider["builtin:zai"].options.apiKey (or builtin:bigmodel).
//   • CLI engine (zcode.cjs) reads ~/.zcode/cli/config.json (hardcoded:
//     Tnr="~/.zcode/cli", Cnr="config.json") -- a completely separate file.
//   • Official Coding Plan login owns ~/.zcode/v2/credentials.json and resolves
//     an effective API key into the CLI config. MultiCC invokes that official
//     flow but never decrypts, copies, or refreshes ZCode OAuth credentials.
//   • A session with a selected MultiCC Provider uses an isolated ZCode config
//     built by src/providers.js and does not depend on this global/native state.
//
// Desktop API-key sync remains an explicit user action. It is deliberately not
// attempted during turn admission because that would overwrite the user's
// native Coding Plan/default route behind their back.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { atomicWriteJson } = require('../runtime-security');

const HOME = os.homedir();
const DESKTOP_CONFIG_PATH = path.join(HOME, '.zcode', 'v2', 'config.json');
const CREDENTIALS_PATH = path.join(HOME, '.zcode', 'v2', 'credentials.json');
const CLI_CONFIG_PATH = path.join(HOME, '.zcode', 'cli', 'config.json');
const CLI_CONFIG_DIR = path.dirname(CLI_CONFIG_PATH);

// Desktop provider key -> CLI provider key mapping.
// Desktop uses "builtin:zai" / "builtin:bigmodel"; CLI uses "zai" / "bigmodel".
const PROVIDER_KEY_MAP = {
  'builtin:zai': 'zai',
  'builtin:bigmodel': 'bigmodel',
};

// CLI provider -> baseURL (from engine aOe mapping).
const PROVIDER_BASE_URLS = {
  zai: 'https://api.z.ai/api/anthropic',
  bigmodel: 'https://open.bigmodel.cn/api/anthropic',
};

// Model catalog for each provider (GLM-5.2 is the current default).
const PROVIDER_MODELS = {
  zai: { 'glm-5.2': { id: 'glm-5.2' }, 'glm-5-turbo': { id: 'glm-5-turbo' } },
  bigmodel: { 'glm-5.2': { id: 'glm-5.2' }, 'glm-5-turbo': { id: 'glm-5-turbo' } },
};

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * L1: Read desktop config (~/.zcode/v2/config.json) and extract API keys.
 * Returns { zai?: { apiKey, baseURL }, bigmodel?: { apiKey, baseURL } }
 * Only includes providers with non-empty apiKey.
 */
function detectDesktopApiKeys() {
  const config = readJsonSafe(DESKTOP_CONFIG_PATH);
  if (!config || typeof config !== 'object' || !config.provider) return {};

  const result = {};
  for (const [desktopKey, cliKey] of Object.entries(PROVIDER_KEY_MAP)) {
    const provider = config.provider[desktopKey];
    if (!provider || !provider.options) continue;
    const apiKey = (provider.options.apiKey || '').trim();
    if (!apiKey) continue;
    const baseURL = (provider.options.baseURL || PROVIDER_BASE_URLS[cliKey] || '').trim();
    result[cliKey] = { apiKey, baseURL };
  }
  return result;
}

/**
 * Read CLI config (~/.zcode/cli/config.json). Returns null if missing/invalid.
 */
function readCliConfig() {
  return readJsonSafe(CLI_CONFIG_PATH);
}

/**
 * Build a complete CLI config for a given provider + apiKey.
 * Preserves existing model selection if compatible, otherwise defaults to
 * '<provider>/glm-5.2'.
 */
function buildCliConfig(providerId, apiKey, opts = {}) {
  const existing = readCliConfig() || {};
  const baseURL = opts.baseURL || PROVIDER_BASE_URLS[providerId] || '';
  const models = PROVIDER_MODELS[providerId] || { 'glm-5.2': { id: 'glm-5.2' } };

  // Preserve model if it already starts with the provider prefix; otherwise
  // set to <provider>/glm-5.2.
  let model = existing.model;
  if (!model || !model.startsWith(providerId + '/')) {
    model = providerId + '/glm-5.2';
  }

  return {
    model,
    provider: {
      [providerId]: {
        kind: 'anthropic',
        options: { baseURL, apiKey },
        models,
      },
    },
  };
}

/**
 * Atomically write CLI config. Creates directory if needed.
 */
function writeCliConfig(config) {
  if (!fs.existsSync(CLI_CONFIG_DIR)) {
    fs.mkdirSync(CLI_CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  atomicWriteJson(CLI_CONFIG_PATH, config);
}

/**
 * L1: Sync desktop API key(s) to CLI config.
 * Picks the first available provider from desktop config.
 * Returns { synced, provider, hadKey } or { synced: false, reason }.
 */
function syncDesktopKeyToCli() {
  const detected = detectDesktopApiKeys();
  const providerIds = Object.keys(detected);

  if (providerIds.length === 0) {
    return { synced: false, reason: 'no_desktop_key' };
  }

  // Prefer zai (api.z.ai) over bigmodel (open.bigmodel.cn) since the desktop
  // typically uses Z.AI as the primary provider.
  const providerId = providerIds.includes('zai') ? 'zai' : providerIds[0];
  const { apiKey, baseURL } = detected[providerId];

  const config = buildCliConfig(providerId, apiKey, { baseURL });
  writeCliConfig(config);

  return { synced: true, provider: providerId, hadKey: true };
}

/**
 * Check if the native CLI config has a valid API key for its selected provider.
 * Custom providers and all three ZCode kinds are accepted; Coding Plan is a
 * credential source, not a fourth wire protocol, and its official flow also
 * writes an effective key into this config.
 */
function getZcodeAuthStatus() {
  const config = readCliConfig();

  if (!config || !config.provider) {
    return { configured: false, provider: null, hasKey: false, source: 'none' };
  }

  const selectedProvider = typeof config.model === 'string' && config.model.includes('/')
    ? config.model.slice(0, config.model.indexOf('/'))
    : '';
  const providerIds = [
    selectedProvider,
    ...Object.keys(config.provider),
  ].filter((value, index, values) => value && values.indexOf(value) === index);
  for (const providerId of providerIds) {
    const provider = config.provider[providerId];
    if (provider && provider.options) {
      const apiKey = (provider.options.apiKey || '').trim();
      if (apiKey) {
        return {
          configured: true,
          provider: providerId,
          hasKey: true,
          source: 'cli_config',
          kind: provider.kind || null,
          baseURL: provider.options.baseURL || PROVIDER_BASE_URLS[providerId] || '',
          model: config.model || null,
        };
      }
    }
  }

  // No key in CLI config -- check if desktop has one we could sync.
  const desktopKeys = detectDesktopApiKeys();
  const desktopProviderIds = Object.keys(desktopKeys);
  if (desktopProviderIds.length > 0) {
    return {
      configured: false,
      provider: null,
      hasKey: false,
      source: 'desktop_available',
      desktopProvider: desktopProviderIds.includes('zai') ? 'zai' : desktopProviderIds[0],
    };
  }

  return { configured: false, provider: null, hasKey: false, source: 'none' };
}

/**
 * L2: Manually set API key for a provider.
 * providerId: 'zai' or 'bigmodel'
 */
function setZcodeApiKey(providerId, apiKey, opts = {}) {
  if (!PROVIDER_BASE_URLS[providerId]) {
    throw new Error('providerId must be "zai" or "bigmodel"');
  }
  const key = (apiKey || '').trim();
  if (!key) throw new Error('apiKey is required');

  const config = buildCliConfig(providerId, key, {
    baseURL: opts.baseURL || PROVIDER_BASE_URLS[providerId],
  });
  writeCliConfig(config);
  return { ok: true, provider: providerId };
}

/**
 * L3: Check if 'zcode login' is available (engine exists).
 */
function isZcodeLoginAvailable() {
  const engine = process.env.ZCODE_ENGINE
    || '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
  try {
    fs.accessSync(engine, fs.constants.R_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * L3: Spawn 'zcode login' in the background.
 * Returns a child process handle. The caller monitors stdout/stderr.
 * Note: login opens a browser for OAuth -- only works on a local machine.
 */
function spawnZcodeLogin() {
  const engine = process.env.ZCODE_ENGINE
    || '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
  const env = { ...process.env };
  // Official login owns the native ~/.zcode tree, never a per-session
  // MultiCC provider override inherited from an unusual launcher environment.
  delete env.ZCODE_DATA_BASE_DIR;
  delete env.ZCODE_SETTINGS;
  const child = spawn(process.execPath, [engine, 'login'], {
    // The web API needs only the exit status. Raw login output may contain an
    // OAuth URL or local paths and must not be retained or returned.
    stdio: 'ignore',
    env,
    detached: false,
  });
  return child;
}

/**
 * Pre-check auth before admitting a turn for a ZCode session.
 * Provider-backed sessions own an isolated, per-session config and bypass the
 * native gate. Provider-less sessions intentionally follow ZCode's native
 * config / Coding Plan state.
 */
function ensureZcodeAuth(session) {
  if (session && session.provider) {
    return { ok: true, provider: session.provider, source: 'multicc_provider' };
  }

  const status = getZcodeAuthStatus();
  if (status.configured) return { ok: true, provider: status.provider, source: status.source };

  return {
    ok: false,
    code: 'configuration_required',
    message: 'ZCode 原生连接尚未配置。请选择一个 MultiCC Provider，或在 Provider 设置中完成 ZCode Coding Plan 登录 / API Key 配置。',
    desktopLoginAvailable: isZcodeLoginAvailable(),
  };
}

module.exports = {
  detectDesktopApiKeys,
  readCliConfig,
  writeCliConfig,
  syncDesktopKeyToCli,
  getZcodeAuthStatus,
  setZcodeApiKey,
  isZcodeLoginAvailable,
  spawnZcodeLogin,
  ensureZcodeAuth,
  DESKTOP_CONFIG_PATH,
  CREDENTIALS_PATH,
  CLI_CONFIG_PATH,
  PROVIDER_BASE_URLS,
};
