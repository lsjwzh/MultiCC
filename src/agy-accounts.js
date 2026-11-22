'use strict';
// Node mirror of native/core/src/agy_accounts.rs — same layout, same rules,
// same file modes. agy keeps its whole login in `$HOME/.gemini` and honours
// `HOME`, so an account is a separate HOME:
//
//   <home>/.multicc/official-accounts/agy/
//       active.json          {"id":"<16 hex>"}
//       <id>.json            {"id","label","createdAt","source"}
//       <id>.home/.gemini/   the account's own agy state
//
// The Rust front door owns `/api/agy/accounts*`; this module exists because the
// ACP bridge spawns `agy` from Node and must inject that active home. Every
// rule here is the one the Rust side already implements — keep them in step.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{16}$/;
const ACTIVE_FILE = 'active.json';
const HOME_SUFFIX = '.home';
const META_SUFFIX = '.json';
const MAX_LABEL = 64;
const DEFAULT_LABEL = '反重力账号';

/// Copied into a new account home. agy rebuilds caches (`brain`, `log`,
/// `cache`, `conversations`, `*.db`, `tmp`) on its own, and those are the files
/// that make a copy expensive and stale.
const IMPORT_FILES = [
  'oauth_creds.json',
  'google_accounts.json',
  'settings.json',
  'trustedFolders.json',
  'projects.json',
  'state.json',
  'installation_id',
  'GEMINI.md',
];

const IMPORT_SUBDIRS = [
  { dir: 'config', files: ['config.json', 'mcp_config.json'] },
  {
    dir: 'antigravity-cli',
    files: ['settings.json', 'installation_id', 'jetski_state.pbtxt'],
  },
];

let counter = 0;

function validAccount(id) {
  return typeof id === 'string' && ACCOUNT_ID_PATTERN.test(id);
}

function accountRoot(home = os.homedir()) {
  return path.join(home, '.multicc', 'official-accounts', 'agy');
}

/// `<root>/<id>.home`, or null when the id is not 16 lowercase hex — checked
/// before any join so a hostile id cannot walk out of the root.
function accountHome(home, id) {
  const base = home || os.homedir();
  return validAccount(id) ? path.join(accountRoot(base), `${id}${HOME_SUFFIX}`) : null;
}

function metaFile(home, id) {
  const base = home || os.homedir();
  return validAccount(id) ? path.join(accountRoot(base), `${id}${META_SUFFIX}`) : null;
}

function activeFile(home) {
  return path.join(accountRoot(home || os.homedir()), ACTIVE_FILE);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function ensureDir(dir) {
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existed) {
    try { fs.chmodSync(dir, 0o700); } catch (_) { /* best effort */ }
  }
}

function writeBytes(file, bytes) {
  ensureDir(path.dirname(file));
  const temp = `${file}.tmp.${process.pid}.${counter++}`;
  fs.writeFileSync(temp, bytes, { mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort */ }
}

function writeJson(file, value) {
  writeBytes(file, JSON.stringify(value));
}

function removeIfPresent(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch (error) {
    throw error;
  }
}

/// The id in `active.json`, or null when agy runs on the machine's own login.
function activeId(home = os.homedir()) {
  const value = readJson(activeFile(home));
  const id = value && typeof value.id === 'string' ? value.id.trim() : '';
  return validAccount(id) ? id : null;
}

/// Pin an account as active. `null`/'' removes the pin, which sends agy back to
/// the machine's own `$HOME`.
function setActive(home, id) {
  const base = home || os.homedir();
  const wanted = typeof id === 'string' ? id.trim() : '';
  if (!wanted) {
    removeIfPresent(activeFile(base));
    return;
  }
  if (!validAccount(wanted)) throw new Error('invalid account id');
  const meta = metaFile(base, wanted);
  if (!meta || !isFile(meta)) throw new Error('unknown account');
  writeJson(activeFile(base), { id: wanted });
}

/// The HOME a spawned `agy` should use; null means "the real HOME", i.e. the
/// CLI's own login, so callers only touch the environment for a non-null value.
function activeHome(home = os.homedir()) {
  const id = activeId(home);
  if (!id) return null;
  const dir = accountHome(home, id);
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch (_) {
    return null;
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

/// `{loggedIn,email,expiresAt}` for one `.gemini` directory. Reads
/// `oauth_creds.json` and `google_accounts.json` but never echoes a token: only
/// whether an access token is present, the active Google address and the expiry.
function statusOf(gemini) {
  const creds = readJson(path.join(gemini, 'oauth_creds.json'));
  const loggedIn = Boolean(creds && typeof creds.access_token === 'string' && creds.access_token);
  const expiresAt = creds && typeof creds.expiry_date === 'number' ? creds.expiry_date : null;
  const accounts = readJson(path.join(gemini, 'google_accounts.json'));
  const email = accounts && typeof accounts.active === 'string' && accounts.active
    ? accounts.active
    : null;
  return { loggedIn, email, expiresAt };
}

/// Login state of one stored account.
function loginStatus(home, id) {
  const dir = accountHome(home || os.homedir(), id);
  if (!dir) return { loggedIn: false, email: null, expiresAt: null };
  return statusOf(path.join(dir, '.gemini'));
}

/// The machine's own `~/.gemini` login — what agy uses with no account pinned.
function localStatus(home = os.homedir()) {
  return statusOf(path.join(home, '.gemini'));
}

/// Every account, oldest first, with its login state and whether it is active.
function listAccounts(home = os.homedir()) {
  let entries;
  try {
    entries = fs.readdirSync(accountRoot(home), { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const active = activeId(home);
  const accounts = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name.endsWith(META_SUFFIX)) continue;
    const id = name.slice(0, -META_SUFFIX.length);
    if (!validAccount(id)) continue;
    const meta = readJson(path.join(accountRoot(home), name)) || {};
    const status = loginStatus(home, id);
    accounts.push({
      id,
      label: typeof meta.label === 'string' && meta.label ? meta.label : id,
      email: status.email,
      loggedIn: status.loggedIn,
      expiresAt: status.expiresAt,
      createdAt: meta.createdAt ?? null,
      source: meta.source ?? null,
      active: active === id,
    });
  }
  accounts.sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
  return accounts;
}

function cleanLabel(label) {
  const trimmed = String(label == null ? '' : label).trim();
  if (!trimmed) return DEFAULT_LABEL;
  return [...trimmed].slice(0, MAX_LABEL).join('');
}

function randomId() {
  return crypto.randomBytes(8).toString('hex');
}

/// A fresh account home with no credentials yet — the user signs in through
/// the ordinary agy OAuth flow, which writes into `<id>.home/.gemini`.
function createAccount(home = os.homedir(), label = '', source = 'created') {
  const id = randomId();
  const dir = accountHome(home, id);
  const meta = metaFile(home, id);
  ensureDir(dir);
  const record = {
    id,
    label: cleanLabel(label),
    createdAt: Date.now(),
    source,
  };
  writeJson(meta, record);
  return record;
}

function copyFile(from, to) {
  let bytes;
  try {
    bytes = fs.readFileSync(from);
  } catch (error) {
    // An optional file that is absent here is simply not part of the account.
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  writeBytes(to, bytes);
}

/// Copy this machine's signed-in `~/.gemini` into a new account home, so a
/// working login can be kept and switched back to later.
function importAccount(home = os.homedir(), label = '') {
  const source = path.join(home, '.gemini');
  if (!isFile(path.join(source, 'oauth_creds.json'))) {
    throw new Error('本机尚未登录 agy，请先完成登录再导入');
  }
  const record = createAccount(home, label, 'import');
  const id = record.id;
  const target = path.join(accountHome(home, id), '.gemini');
  try {
    for (const name of IMPORT_FILES) {
      copyFile(path.join(source, name), path.join(target, name));
    }
    for (const { dir, files } of IMPORT_SUBDIRS) {
      for (const name of files) {
        copyFile(path.join(source, dir, name), path.join(target, dir, name));
      }
    }
    // The label defaults to the imported account's own Google address so the
    // list is readable without opening anything.
    const status = loginStatus(home, id);
    const explicit = String(label == null ? '' : label).trim();
    if (!explicit && status.email) {
      const updated = { ...record, label: cleanLabel(status.email) };
      writeJson(metaFile(home, id), updated);
      return updated;
    }
    return record;
  } catch (error) {
    // A half-copied home would look like a usable account, so roll it back.
    try { fs.rmSync(accountHome(home, id), { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(metaFile(home, id), { force: true }); } catch (_) {}
    throw error;
  }
}

function deleteAccount(home = os.homedir(), id) {
  if (!validAccount(id)) throw new Error('invalid account id');
  const dir = accountHome(home, id);
  const meta = metaFile(home, id);
  const hasDir = Boolean(dir) && fs.existsSync(dir);
  const hasMeta = Boolean(meta) && isFile(meta);
  if (!hasDir && !hasMeta) throw new Error('unknown account');
  if (hasDir) fs.rmSync(dir, { recursive: true, force: true });
  removeIfPresent(meta);
  if (activeId(home) === id) removeIfPresent(activeFile(home));
}

/// Environment patch for a spawned `agy`, or null when the machine's own login
/// is in play.
function accountEnv(home = os.homedir()) {
  const dir = activeHome(home);
  return dir ? { HOME: dir } : null;
}

module.exports = {
  ACCOUNT_ID_PATTERN,
  DEFAULT_LABEL,
  validAccount,
  accountRoot,
  accountHome,
  metaFile,
  activeId,
  setActive,
  activeHome,
  loginStatus,
  localStatus,
  listAccounts,
  createAccount,
  importAccount,
  deleteAccount,
  accountEnv,
};
