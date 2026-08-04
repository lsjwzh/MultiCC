'use strict';

// Kimi Code native authentication module (mirrors the zcode-auth tiers).
//
// `kimi login` runs an OAuth device-code flow: the CLI prints
//   "Opening browser for Kimi device login: <verification_uri_complete>"
// to stderr, opens the URL, then polls the token endpoint until the user
// approves. Credentials land under <KIMI_CODE_HOME>/credentials/*.json
// (KIMI_CODE_HOME defaults to ~/.kimi-code). The documented runtime fallback
// for provider credentials is the KIMI_API_KEY env var.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

function kimiHomeDir(env = process.env) {
  return env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

function isKimiLoginAvailable() {
  try {
    const { findExecutableOnPath } = require('./commands');
    const cmd = process.env.KIMI_CMD || findExecutableOnPath('kimi');
    if (cmd && cmd !== 'kimi') return true;
    // Bare-name fallback: trust PATH resolution at spawn time.
    return !!cmd;
  } catch (_) {
    return false;
  }
}

function getKimiAuthStatus(env = process.env) {
  if (String(env.KIMI_API_KEY || '').trim()) {
    return { configured: true, hasKey: true, source: 'env_key' };
  }
  const credsDir = path.join(kimiHomeDir(env), 'credentials');
  try {
    const entries = fs.readdirSync(credsDir).filter(name => name.endsWith('.json'));
    for (const entry of entries) {
      try {
        const text = fs.readFileSync(path.join(credsDir, entry), 'utf8');
        if (text.trim()) return { configured: true, hasKey: true, source: 'credentials' };
      } catch (_) { /* unreadable entry — keep looking */ }
    }
  } catch (_) { /* no credentials dir yet */ }
  return { configured: false, hasKey: false, source: 'none' };
}

// Extracts the device-code verification URL from `kimi login` stderr.
function parseKimiLoginVerificationUrl(text) {
  const match = /Kimi device login:\s*(\S+)/.exec(String(text || ''));
  if (match && /^https:\/\//.test(match[1])) return match[1];
  return null;
}

function resolveKimiCmd() {
  if (process.env.KIMI_CMD) return process.env.KIMI_CMD;
  const { findExecutableOnPath } = require('./commands');
  return findExecutableOnPath('kimi') || 'kimi';
}

// Spawns `kimi login` with piped stdio so the route can capture the
// verification URL and open it in the managed visible browser.
function spawnKimiLogin() {
  const env = { ...process.env };
  // Official login owns the native ~/.kimi-code tree, never a per-session
  // MultiCC provider home inherited from an unusual launcher environment.
  delete env.KIMI_CODE_HOME;
  return spawn(resolveKimiCmd(), ['login'], { env });
}

// L2: Manually set an API key for native Kimi Code usage (provider-less sessions).
// Writes a credential file under KIMI_CODE_HOME/credentials/ so getKimiAuthStatus
// picks it up. The key is also set in process.env so child processes inherit it.
function setKimiApiKey(apiKey, opts = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('apiKey is required');
  const baseURL = String(opts.baseURL || '').trim() || undefined;

  const home = kimiHomeDir();
  const credsDir = path.join(home, 'credentials');
  fs.mkdirSync(credsDir, { recursive: true });

  const entry = { apiKey: key };
  if (baseURL) entry.baseURL = baseURL;

  const filePath = path.join(credsDir, 'manual.json');
  fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf8');

  return { ok: true, source: 'credentials' };
}

// Pre-turn gate (same shape as ensureZcodeAuth). Provider-backed sessions own
// injected credentials and bypass the native gate.
function ensureKimiAuth(session, env = process.env) {
  if (session && session.provider) {
    return { ok: true, provider: session.provider, source: 'multicc_provider' };
  }
  const status = getKimiAuthStatus(env);
  if (status.configured) return { ok: true, provider: null, source: status.source };
  return {
    ok: false,
    code: 'configuration_required',
    message: 'Kimi Code 尚未登录。请打开「Kimi 登录」完成浏览器授权，或为会话选择一个带 API Key 的 MultiCC Provider。',
    loginAvailable: isKimiLoginAvailable(),
  };
}

module.exports = {
  kimiHomeDir,
  isKimiLoginAvailable,
  getKimiAuthStatus,
  parseKimiLoginVerificationUrl,
  spawnKimiLogin,
  setKimiApiKey,
  ensureKimiAuth,
};
