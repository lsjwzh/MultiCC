'use strict';

// State layout for the MultiCC browser executor (`mbrowser`).
//
//   <state>/browser/run/<name>.sock|.json|.log|.lock   per-profile runtime
//   <state>/browser/profiles/<name>.json               per-profile config
//   <profile-root>/<name>/                             Chrome user-data-dir
//
// `<state>` is MULTICC_DATA_DIR (what MultiCC itself uses) or ~/.multicc. The
// profile root stays under the macOS Application Support path used by the
// existing local_browser_use.py so a profile seeded there keeps working, and
// MBROWSER_PROFILES_DIR relocates it (tests, alternate disks).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// macOS sun_path is 104 bytes including the NUL; stay clear of the edge.
const SOCKET_PATH_MAX = 100;
const MOCK_KEYCHAIN_MARKER = '.multicc-mock-keychain';
const SEEDED_MARKER = '.multicc-seeded';
// The socket lives in run/ but Chrome's own user-data-dir can be deep, so a
// long state dir needs the short-tmpdir fallback below.
const TMP_SOCKET_DIR = 'mbrowser';

class MbError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'MbError';
    this.code = code;
    if (details) this.details = details;
  }
}

function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

function requireName(name) {
  if (!isValidName(name)) {
    throw new MbError('usage', `invalid profile name ${JSON.stringify(name)}: ` +
      '1-64 characters, must start with a letter or digit, then letters/digits/_/-');
  }
  return name;
}

function homeDir() {
  return process.env.HOME || os.homedir();
}

function stateDir() {
  const root = process.env.MULTICC_DATA_DIR || path.join(homeDir(), '.multicc');
  return path.join(root, 'browser');
}

function runDir() {
  return path.join(stateDir(), 'run');
}

function profileConfigDir() {
  return path.join(stateDir(), 'profiles');
}

function defaultProfileRoot() {
  if (process.env.MBROWSER_PROFILES_DIR) return path.resolve(process.env.MBROWSER_PROFILES_DIR);
  if (process.platform === 'darwin') {
    return path.join(homeDir(), 'Library', 'Application Support', 'MultiCC', 'browser-use');
  }
  return path.join(stateDir(), 'profiles');
}

function profileDir(name) {
  return path.join(defaultProfileRoot(), requireName(name));
}

function statePath(name) {
  return path.join(runDir(), `${requireName(name)}.json`);
}

function logPath(name) {
  return path.join(runDir(), `${requireName(name)}.log`);
}

function lockPath(name) {
  return path.join(runDir(), `${requireName(name)}.lock`);
}

function configPath(name) {
  return path.join(profileConfigDir(), `${requireName(name)}.json`);
}

function shortSocketDir() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(os.tmpdir(), `${TMP_SOCKET_DIR}-${uid}`);
}

// Unix socket paths are capped at ~104 bytes on macOS and a state dir nested
// under a deep checkout blows past that, so hash our way into tmpdir instead.
function socketPath(name) {
  const full = path.join(runDir(), `${requireName(name)}.sock`);
  if (Buffer.byteLength(full) <= SOCKET_PATH_MAX) return full;
  const digest = crypto.createHash('sha1').update(full).digest('hex').slice(0, 16);
  return path.join(shortSocketDir(), `${digest}.sock`);
}

function defaultProfile() {
  return process.env.MBROWSER_PROFILE || 'default';
}

function ensureDir(dir, mode) {
  fs.mkdirSync(dir, { recursive: true, ...(mode ? { mode } : {}) });
  return dir;
}

function ensureStateDirs() {
  ensureDir(stateDir(), 0o700);
  ensureDir(runDir(), 0o700);
  ensureDir(profileConfigDir(), 0o700);
  return { state: stateDir(), run: runDir(), profiles: profileConfigDir() };
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

// Written from both the CLI and the daemon, so never leave a half file behind.
function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return value;
}

function removeFile(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (_) {
    return false;
  }
}

function rmTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  NAME_RE,
  SOCKET_PATH_MAX,
  MOCK_KEYCHAIN_MARKER,
  SEEDED_MARKER,
  MbError,
  isValidName,
  requireName,
  homeDir,
  stateDir,
  runDir,
  profileConfigDir,
  defaultProfileRoot,
  profileDir,
  statePath,
  logPath,
  lockPath,
  configPath,
  socketPath,
  shortSocketDir,
  defaultProfile,
  ensureDir,
  ensureStateDirs,
  readJson,
  writeJson,
  removeFile,
  rmTree,
};
