'use strict';

// Official-account credential store — multicc's equivalent of CLIProxyAPI's
// auth-dir. Each "official account" is one isolated OAuth credential OWNED BY
// MULTICC, kept apart from the CLI's global login (~/.codex/auth.json and the
// macOS Keychain entry stay untouched):
//
//   <root>/codex/<accountId>/auth.json     Codex mini-home (written by
//                                          `codex login` with CODEX_HOME=dir)
//   <root>/codex/<accountId>/account.json  multicc meta {label, createdAt}
//   <root>/claude/<accountId>.json         Claude OAuth credential (multicc's
//                                          own PKCE flow, CPA-shaped fields)
//
// Consumers:
//   - codex-official-relay reads codex auth.json LIVE per request (credential
//     never crosses into the CLI child), keyed by provider's officialAccount id.
//   - the claude proxy's injected readOfficialCredential does the same for
//     claude account files.
//   - quota routes/pollers read the same files to query per-account usage.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { atomicWriteJson, ensurePrivateDir, secureFile } = require('./runtime-security');

const DEFAULT_ROOT = path.join(os.homedir(), '.multicc', 'official-accounts');
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{16}$/;

function newAccountId() {
  return crypto.randomBytes(8).toString('hex');
}

function assertAccountId(id) {
  const text = String(id || '');
  if (!ACCOUNT_ID_PATTERN.test(text)) {
    const error = new Error('invalid official account id');
    error.code = 'OFFICIAL_ACCOUNT_ID_INVALID';
    throw error;
  }
  return text;
}

// Defense in depth on top of the pattern: the resolved path must stay under
// the store root even if a caller grows sloppy later.
function resolveUnder(root, ...parts) {
  const target = path.resolve(root, ...parts);
  const rel = path.relative(path.resolve(root), target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const error = new Error('official account path escapes store root');
    error.code = 'OFFICIAL_ACCOUNT_PATH_ESCAPE';
    throw error;
  }
  return target;
}

function parseJson(text) {
  try {
    const value = JSON.parse(String(text || ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) {
    return {};
  }
}

function jwtPayload(token) {
  try {
    return parseJson(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch (_) {
    return {};
  }
}

function jwtExpiryMs(token) {
  const seconds = Number(jwtPayload(token).exp);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

function readJsonIfExists(file) {
  try {
    return parseJson(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function createOfficialAccountStore(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);

  function codexDir(id) {
    return resolveUnder(root, 'codex', assertAccountId(id));
  }

  function codexAuthFile(id) {
    return path.join(codexDir(id), 'auth.json');
  }

  function codexMetaFile(id) {
    return path.join(codexDir(id), 'account.json');
  }

  function claudeFile(id) {
    return resolveUnder(root, 'claude', `${assertAccountId(id)}.json`);
  }

  // ── Codex ────────────────────────────────────────────────────────────────

  function createCodexAccount({ label } = {}) {
    const id = newAccountId();
    const dir = codexDir(id);
    ensurePrivateDir(dir);
    const meta = { label: String(label || '').trim().slice(0, 64), createdAt: Date.now() };
    atomicWriteJson(codexMetaFile(id), meta);
    return { id, dir, authFile: codexAuthFile(id), label: meta.label };
  }

  function describeCodexAuth(authFile) {
    const auth = readJsonIfExists(authFile);
    if (!auth) return { loggedIn: false, reason: 'credential_unreadable' };
    const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : {};
    const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token.trim() : '';
    if (!accessToken) return { loggedIn: false, reason: 'access_token_missing' };
    const expiresAt = jwtExpiryMs(accessToken);
    const payload = jwtPayload(tokens.id_token || accessToken);
    const email = typeof payload.email === 'string' ? payload.email : '';
    return {
      loggedIn: true,
      email,
      accountExternalId: typeof tokens.account_id === 'string' ? tokens.account_id : '',
      expiresAt,
      expired: expiresAt != null ? expiresAt <= Date.now() : false,
    };
  }

  function listCodexAccounts() {
    const base = resolveUnder(root, 'codex');
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch (_) {
      return [];
    }
    return entries
      .filter(e => e.isDirectory() && ACCOUNT_ID_PATTERN.test(e.name))
      .map((e) => {
        const id = e.name;
        const meta = readJsonIfExists(codexMetaFile(id)) || {};
        return {
          id,
          label: typeof meta.label === 'string' ? meta.label : '',
          createdAt: Number(meta.createdAt) || null,
          ...describeCodexAuth(codexAuthFile(id)),
        };
      })
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  function deleteCodexAccount(id) {
    fs.rmSync(codexDir(id), { recursive: true, force: true });
  }

  // Same read the relay does, shared so quota/refresh agree on the verdicts.
  function readCodexCredential(id, { now = Date.now } = {}) {
    const auth = readJsonIfExists(codexAuthFile(id));
    if (!auth) return { ok: false, reason: 'credential_unreadable' };
    const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : {};
    const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token.trim() : '';
    const accountId = typeof tokens.account_id === 'string' ? tokens.account_id.trim() : '';
    if (!accessToken) return { ok: false, reason: 'access_token_missing' };
    if (!accountId) return { ok: false, reason: 'account_id_missing' };
    const expiresAt = jwtExpiryMs(accessToken);
    if (expiresAt && expiresAt <= now()) return { ok: false, reason: 'access_token_expired', expiresAt };
    return { ok: true, accessToken, accountId, expiresAt };
  }

  // ── Claude ───────────────────────────────────────────────────────────────
  // File shape mirrors CLIProxyAPI's ClaudeTokenStorage (type/access_token/
  // refresh_token/email/account_uuid/organization_*/expired) plus multicc's
  // own label/createdAt, so the two ecosystems stay debuggable side by side.

  function writeClaudeCredential(id, data) {
    const file = claudeFile(id);
    ensurePrivateDir(path.dirname(file));
    const existing = readJsonIfExists(file) || {};
    const merged = {
      ...existing,
      ...data,
      type: 'claude',
    };
    atomicWriteJson(file, merged);
    secureFile(file);
    return merged;
  }

  function createClaudeAccount({ label } = {}) {
    const id = newAccountId();
    writeClaudeCredential(id, { label: String(label || '').trim().slice(0, 64), createdAt: Date.now() });
    return { id, file: claudeFile(id) };
  }

  function readClaudeCredential(id) {
    return readJsonIfExists(claudeFile(id));
  }

  function describeClaudeCredential(data) {
    if (!data) return { loggedIn: false, reason: 'credential_unreadable' };
    const accessToken = typeof data.access_token === 'string' ? data.access_token.trim() : '';
    if (!accessToken) return { loggedIn: false, reason: 'access_token_missing' };
    const expired = data.expired ? Date.parse(data.expired) : null;
    return {
      loggedIn: true,
      email: typeof data.email === 'string' ? data.email : '',
      organizationName: typeof data.organization_name === 'string' ? data.organization_name : '',
      expiresAt: Number.isFinite(expired) ? expired : null,
      expired: Number.isFinite(expired) ? expired <= Date.now() : false,
      hasRefreshToken: typeof data.refresh_token === 'string' && data.refresh_token.trim() !== '',
    };
  }

  function listClaudeAccounts() {
    const base = resolveUnder(root, 'claude');
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch (_) {
      return [];
    }
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.json') && ACCOUNT_ID_PATTERN.test(e.name.slice(0, -5)))
      .map((e) => {
        const id = e.name.slice(0, -5);
        const data = readJsonIfExists(claudeFile(id)) || {};
        return {
          id,
          label: typeof data.label === 'string' ? data.label : '',
          createdAt: Number(data.createdAt) || null,
          ...describeClaudeCredential(data),
        };
      })
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  function deleteClaudeAccount(id) {
    fs.rmSync(claudeFile(id), { force: true });
  }

  return Object.freeze({
    root,
    assertAccountId,
    // codex
    createCodexAccount,
    listCodexAccounts,
    deleteCodexAccount,
    readCodexCredential,
    codexDir,
    codexAuthFile,
    // claude
    createClaudeAccount,
    writeClaudeCredential,
    readClaudeCredential,
    listClaudeAccounts,
    deleteClaudeAccount,
    claudeFile,
  });
}

// Marker shared by the relay/proxy layer: a provider record that borrows an
// official-account credential carries settingsConfig.officialAccount.id.
function officialAccountIdFromProvider(provider) {
  if (!provider || typeof provider !== 'object') return null;
  let cfg = provider.settingsConfig;
  if (typeof cfg === 'string') cfg = parseJson(cfg);
  if (!cfg || typeof cfg !== 'object') return null;
  const marker = cfg.officialAccount;
  if (!marker || typeof marker !== 'object') return null;
  const id = String(marker.id || '');
  return ACCOUNT_ID_PATTERN.test(id) ? id : null;
}

// Standalone path helper for callers that only need the location (e.g.
// providers.js embedding it into a quota poll target) — no store instance.
function codexAccountAuthFilePath(id, root = DEFAULT_ROOT) {
  return resolveUnder(root, 'codex', assertAccountId(id), 'auth.json');
}

function claudeAccountFilePath(id, root = DEFAULT_ROOT) {
  return resolveUnder(root, 'claude', `${assertAccountId(id)}.json`);
}

// Validate the extra env a login terminal may pin (e.g. CODEX_HOME pointing at
// an official-account dir so `codex login` writes THAT account's auth.json).
// Tight allowlist — this crosses into an interactive shell, nothing else may.
const LOGIN_ENV_ALLOWLIST = Object.freeze(['CODEX_HOME']);

function sanitizeLoginEnv(loginEnv, loginFlow) {
  if (loginEnv == null) return { ok: true, env: null };
  if (typeof loginEnv !== 'object' || Array.isArray(loginEnv)) return { ok: false, error: 'loginEnv must be an object' };
  if (!loginFlow) return { ok: false, error: 'loginEnv requires loginFlow' };
  const env = {};
  for (const key of LOGIN_ENV_ALLOWLIST) {
    const value = loginEnv[key];
    if (value == null) continue;
    const text = String(value);
    if (!path.isAbsolute(text) || text.length > 512 || /[\0\r\n]/.test(text)) {
      return { ok: false, error: `invalid loginEnv.${key}` };
    }
    env[key] = text;
  }
  return { ok: true, env: Object.keys(env).length ? env : null };
}

module.exports = {
  createOfficialAccountStore,
  officialAccountIdFromProvider,
  assertAccountId,
  sanitizeLoginEnv,
  codexAccountAuthFilePath,
  claudeAccountFilePath,
  DEFAULT_ROOT,
  ACCOUNT_ID_PATTERN,
};
