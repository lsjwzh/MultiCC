'use strict';

// 为 Command Code 和 OpenCode 的 opencode.ai 线路（Zen/Go）保存独立 API Key 账户。
// Command Code 也支持官方浏览器登录；该入口由 routes/commandcode-auth 管理。
// The user keeps several keys here and each session picks one per lane
// (`session.cliAccounts = {<cli>: <accountId>}`); a session without a pick
// keeps the CLI's own login exactly as before.
//
// The key reaches only the spawned child, never the CLI's global files:
//   commandcode  COMMAND_CODE_API_KEY outranks ~/.commandcode/auth.json
//                (getCommandAuthKey reads the env first).
//   opencode     OPENCODE_CONFIG_CONTENT is deep-merged over the user's
//                opencode.json, so overriding provider.<id>.options.apiKey
//                swaps the credential while models/baseURL stay the user's.
//                Swapping XDG_DATA_HOME instead would also swap opencode.db
//                and break resume across accounts.
// Both were verified against the real CLIs with a bogus key (upstream 401).
//
//   <official-accounts root>/cli-keys/<cli>/<accountId>.json
//     {label, apiKey, createdAt, updatedAt}   mode 0600, dir 0700

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { atomicWriteJson, ensurePrivateDir } = require('./native/binding').runtimeSecurity;
const { DEFAULT_ROOT, ACCOUNT_ID_PATTERN } = require('./native/binding').officialAccounts;
const { hasAccount: hasAgyAccountNative } = require('./native/binding').agyAccounts;
const { displayNameOf } = require('./native/binding').cliCapability;

const KEY_ACCOUNT_CLIS = Object.freeze(['commandcode', 'opencode']);
const SESSION_ACCOUNT_CLIS = Object.freeze(['commandcode', 'opencode', 'agy']);
// The key travels as its own env var and the config only names it, so the
// merged OPENCODE_CONFIG_CONTENT never carries the secret itself.
const OPENCODE_KEY_ENV = 'MULTICC_OPENCODE_ACCOUNT_KEY';
// One opencode.ai console key serves every opencode.ai line: the built-in Zen
// (`opencode`) and Go (`opencode-go`) providers, plus `opencodego`, the id the
// Go setup guide has users define by hand. Naming an id the user never
// configured is inert (verified: it adds no provider and no models).
const OPENCODE_ACCOUNT_PROVIDERS = Object.freeze(['opencode', 'opencode-go', 'opencodego']);
// Printable ASCII without spaces: covers every vendor key shape seen so far and
// keeps the value safe to place in an env var.
const API_KEY_PATTERN = /^[\x21-\x7e]{8,512}$/;

function invalid(message, code = 'CLI_KEY_ACCOUNT_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isKeyAccountCli(cli) {
  return KEY_ACCOUNT_CLIS.includes(String(cli || ''));
}

function isSessionAccountCli(cli) {
  return SESSION_ACCOUNT_CLIS.includes(String(cli || ''));
}

function sanitizeLabel(value) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
}

function normalizeApiKey(value) {
  const key = String(value == null ? '' : value).trim();
  if (!API_KEY_PATTERN.test(key)) throw invalid('API Key 格式无效（8–512 个可见字符，不能含空格）');
  return key;
}

// Enough to tell two keys apart in a list, never enough to use one.
function keyHint(key) {
  return typeof key === 'string' && key.length >= 12 ? `…${key.slice(-4)}` : '';
}

function createCliKeyAccountStore({ root = DEFAULT_ROOT } = {}) {
  const base = path.resolve(root, 'cli-keys');

  function laneDir(cli) {
    if (!isKeyAccountCli(cli)) throw invalid(`不支持的 CLI：${cli}`, 'CLI_KEY_ACCOUNT_CLI_UNSUPPORTED');
    return path.join(base, cli);
  }

  function accountFile(cli, id) {
    const text = String(id || '');
    if (!ACCOUNT_ID_PATTERN.test(text)) throw invalid('账户 id 无效', 'CLI_KEY_ACCOUNT_ID_INVALID');
    return path.join(laneDir(cli), `${text}.json`);
  }

  function read(cli, id) {
    try {
      const value = JSON.parse(fs.readFileSync(accountFile(cli, id), 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch (_) {
      return null;
    }
  }

  function describe(id, data) {
    return {
      id,
      label: typeof data.label === 'string' ? data.label : '',
      keyHint: keyHint(data.apiKey),
      createdAt: Number(data.createdAt) || null,
      updatedAt: Number(data.updatedAt) || null,
    };
  }

  function list(cli) {
    let entries = [];
    try { entries = fs.readdirSync(laneDir(cli), { withFileTypes: true }); } catch (error) {
      if (error && error.code === 'CLI_KEY_ACCOUNT_CLI_UNSUPPORTED') throw error;
      return [];
    }
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json') && ACCOUNT_ID_PATTERN.test(entry.name.slice(0, -5)))
      .map((entry) => {
        const id = entry.name.slice(0, -5);
        const data = read(cli, id);
        return data ? describe(id, data) : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  function get(cli, id) {
    if (!isKeyAccountCli(cli) || !ACCOUNT_ID_PATTERN.test(String(id || ''))) return null;
    const data = read(cli, id);
    return data ? describe(String(id), data) : null;
  }

  function create(cli, { label, apiKey } = {}) {
    const dir = laneDir(cli);
    const key = normalizeApiKey(apiKey);
    const id = crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    const data = { label: sanitizeLabel(label), apiKey: key, createdAt: now, updatedAt: now };
    ensurePrivateDir(dir);
    atomicWriteJson(accountFile(cli, id), data);
    return describe(id, data);
  }

  function update(cli, id, patch = {}) {
    const current = read(cli, id);
    if (!current) return null;
    const next = { ...current, updatedAt: Date.now() };
    if (patch.label !== undefined) next.label = sanitizeLabel(patch.label);
    if (patch.apiKey !== undefined && patch.apiKey !== '') next.apiKey = normalizeApiKey(patch.apiKey);
    atomicWriteJson(accountFile(cli, id), next);
    return describe(String(id), next);
  }

  function remove(cli, id) {
    const file = accountFile(cli, id);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  }

  function readKey(cli, id) {
    const data = read(cli, id);
    const key = data && typeof data.apiKey === 'string' ? data.apiKey.trim() : '';
    return key && API_KEY_PATTERN.test(key) ? key : null;
  }

  return Object.freeze({ root: base, list, get, has: (cli, id) => !!get(cli, id), create, update, remove, readKey });
}

let shared = null;
// The process-wide store: the spawn path, the session PATCH and the account
// routes must all see the same files.
function sharedCliKeyAccountStore() {
  if (!shared) shared = createCliKeyAccountStore();
  return shared;
}

function plainMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function selectedAccountId(session, cli) {
  const id = plainMap(session && session.cliAccounts)[cli];
  return typeof id === 'string' && id ? id : null;
}

function mergeOpenCodeConfig(raw) {
  let config = {};
  try {
    const parsed = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
  } catch (_) { /* MultiCC wrote it; an unparsable value cannot hold anything to keep */ }
  const provider = { ...plainMap(config.provider) };
  for (const id of OPENCODE_ACCOUNT_PROVIDERS) {
    const entry = plainMap(provider[id]);
    provider[id] = { ...entry, options: { ...plainMap(entry.options), apiKey: `{env:${OPENCODE_KEY_ENV}}` } };
  }
  return JSON.stringify({ ...config, provider });
}

// Layer the session's account for `cli` onto a child env. Returns the input
// object untouched when the session picked no account for this lane, else a new
// env. A pick whose account is gone or unreadable fails closed: falling back to
// the CLI's own login would quietly bill a different account.
function applyCliKeyAccountEnv(env, session, store, cli = session && session.cli) {
  if (!isKeyAccountCli(cli)) return env;
  const id = selectedAccountId(session, cli);
  if (!id) return env;
  let key = null;
  try { key = store.readKey(cli, id); } catch (_) { key = null; }
  if (!key) {
    throw invalid(`所选 ${displayNameOf(cli)} 账户已不存在或缺少 API Key，请在运行配置里重新选择账户`, 'CLI_KEY_ACCOUNT_MISSING');
  }
  const next = { ...env };
  if (cli === 'commandcode') {
    next.COMMAND_CODE_API_KEY = key;
  } else {
    next[OPENCODE_KEY_ENV] = key;
    next.OPENCODE_CONFIG_CONTENT = mergeOpenCodeConfig(next.OPENCODE_CONFIG_CONTENT);
  }
  return next;
}

// Validate a PATCH body `cliAccounts: {<cli>: <accountId>|null}` and merge it
// onto the session's current map; null/'' clears that lane, a bare null clears
// every lane. The map is keyed by lane, so a session switching CLIs keeps each
// lane's pick and the order of switch-cli vs PATCH does not matter.
function mergeCliAccountsPatch(current, patch, store, { hasAgyAccount = hasAgyAccountNative } = {}) {
  if (patch === null) return { ok: true, value: null };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'cliAccounts must be an object of {cli: accountId}' };
  }
  const next = { ...plainMap(current) };
  for (const [cli, value] of Object.entries(patch)) {
    if (!isSessionAccountCli(cli)) return { ok: false, error: `cliAccounts only supports ${SESSION_ACCOUNT_CLIS.join(', ')}` };
    if (value == null || value === '') { delete next[cli]; continue; }
    const exists = cli === 'agy'
      ? (typeof value === 'string' && !!hasAgyAccount(value))
      : (typeof value === 'string' && store.has(cli, value));
    if (!exists) return { ok: false, error: `${displayNameOf(cli)} 账户不存在` };
    next[cli] = value;
  }
  return { ok: true, value: Object.keys(next).length ? next : null };
}

// What a copied configuration (fork) may carry: only picks whose account still
// exists. A dropped pick means "the CLI's own login", which the caller states.
function retainExistingCliAccounts(map, store, { hasAgyAccount = hasAgyAccountNative } = {}) {
  const kept = {};
  for (const [cli, id] of Object.entries(plainMap(map))) {
    if (typeof id !== 'string') continue;
    if (cli === 'agy' ? hasAgyAccount(id) : (isKeyAccountCli(cli) && store.has(cli, id))) kept[cli] = id;
  }
  return Object.keys(kept).length ? kept : null;
}

// Deleting an account self-heals every session that picked it back to the
// CLI's own login; returns how many sessions changed.
function releaseCliAccountReferences(records, cli, id) {
  let changed = 0;
  for (const session of records.values()) {
    const map = plainMap(session && session.cliAccounts);
    if (map[cli] !== id) continue;
    const next = { ...map };
    delete next[cli];
    if (Object.keys(next).length) session.cliAccounts = next;
    else delete session.cliAccounts;
    changed += 1;
  }
  return changed;
}

module.exports = {
  KEY_ACCOUNT_CLIS,
  SESSION_ACCOUNT_CLIS,
  OPENCODE_KEY_ENV,
  OPENCODE_ACCOUNT_PROVIDERS,
  isKeyAccountCli,
  isSessionAccountCli,
  createCliKeyAccountStore,
  sharedCliKeyAccountStore,
  selectedAccountId,
  mergeOpenCodeConfig,
  applyCliKeyAccountEnv,
  mergeCliAccountsPatch,
  retainExistingCliAccounts,
  releaseCliAccountReferences,
};
