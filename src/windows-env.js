'use strict';

// ── Windows environment that is not frozen at process start ──────────────────
// A Windows process gets a copy of its parent's environment block and never
// sees it change again. MultiCC derives every CLI command and every PATH probe
// from that block, so a server (or the desktop supervisor above it) that was
// started before Git or a CLI was installed keeps reporting "not installed"
// until someone restarts it — and a restart kills every session it hosts.
//
// Two repairs are applied, neither of which needs a restart:
//   1. The standard install locations are searched directly (synchronous, no
//      child process). An installer writes to one of these even when it fails
//      to propagate PATH to already-running processes.
//   2. The persisted PATH is re-read from the registry (asynchronous, throttled
//      and de-duplicated) so tools outside that list are picked up too.
// Both write the merged value back into process.env, so a bare `git` spawned
// later in the same process resolves to the new directory as well.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const DEFAULT_MAX_AGE_MS = 15000;
// A miss is remembered briefly: availability is checked per session/request and
// a directory scan per call would be wasted work. Installers land well inside
// this window, and an explicit re-check forces a fresh scan anyway.
const SCAN_MAX_AGE_MS = 2000;
const PROBE_TIMEOUT_MS = 5000;

const REGISTRY_KEYS = Object.freeze([
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
]);
const GIT_REGISTRY_KEYS = Object.freeze([
  'HKLM\\SOFTWARE\\GitForWindows',
  'HKCU\\SOFTWARE\\GitForWindows',
]);

let revision = 0;
let lastScanAt = 0;
let lastRefreshAt = 0;
let inFlight = null;
let discoveredCommands = {};

function envValue(env, name) {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}

function setEnvValue(env, name, value) {
  const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
  env[key || name] = value;
}

function normalizeEntry(entry) {
  const value = String(entry || '').trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

function entryKey(entry) {
  return normalizeEntry(entry).replace(/[\\/]+$/, '').toLowerCase();
}

function isDirectory(dir, fsImpl) {
  try {
    return fsImpl.statSync(dir).isDirectory();
  } catch (_) {
    return false;
  }
}

// Where the tools MultiCC launches actually land on Windows. The official Git
// installer, per-user Git installs, scoop/choco shims and the npm global prefix
// (where claude/gemini/grok/... live) each have exactly one default.
function knownDirs(env = process.env) {
  const dirs = [];
  const add = (...parts) => {
    if (parts.every(part => typeof part === 'string' && part)) dirs.push(path.win32.join(...parts));
  };
  const programFiles = envValue(env, 'ProgramFiles');
  const programFilesX86 = envValue(env, 'ProgramFiles(x86)');
  const localAppData = envValue(env, 'LOCALAPPDATA');
  const appData = envValue(env, 'APPDATA');
  const userProfile = envValue(env, 'USERPROFILE');
  const programData = envValue(env, 'ProgramData');

  add(programFiles, 'Git', 'cmd');
  add(programFilesX86, 'Git', 'cmd');
  add(localAppData, 'Programs', 'Git', 'cmd');
  add(userProfile, 'scoop', 'shims');
  add(programData, 'chocolatey', 'bin');
  add(appData, 'npm');
  add(localAppData, 'npm');
  add(programFiles, 'nodejs');
  add(userProfile, '.local', 'bin');
  add(userProfile, '.opencode', 'bin');
  add(userProfile, '.bun', 'bin');
  add(localAppData, 'Programs', 'claude');
  add(localAppData, 'Microsoft', 'WindowsApps');
  return dirs;
}

// Appends the known directories that exist and are not already present. Only
// the tail grows: whatever the user put first keeps its precedence, so this
// cannot silently shadow the git/claude they have been using.
function augmentPath(env = process.env, {
  fsImpl = fs,
  windows = process.platform === 'win32',
  now = Date.now,
  force = false,
} = {}) {
  if (!windows) return false;
  const time = now();
  if (!force && time - lastScanAt < SCAN_MAX_AGE_MS) return false;
  lastScanAt = time;

  const current = String(envValue(env, 'PATH') || '');
  const present = new Set(current.split(';').map(entryKey).filter(Boolean));
  const additions = [];
  for (const dir of knownDirs(env)) {
    const key = entryKey(dir);
    if (!key || present.has(key) || !isDirectory(dir, fsImpl)) continue;
    present.add(key);
    additions.push(dir);
  }
  if (!additions.length) return false;

  const separator = current && !current.endsWith(';') ? ';' : '';
  setEnvValue(env, 'PATH', `${current}${separator}${additions.join(';')}`);
  revision += 1;
  return true;
}

function parseRegistryValue(stdout, name) {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+REG_(?:EXPAND_)?SZ\s*(.*)$/i.exec(line);
    if (match && match[1].toLowerCase() === name.toLowerCase()) return match[2].trim();
  }
  return null;
}
const parseRegistryPath = stdout => parseRegistryValue(stdout, 'Path');

function expandEnv(value, env) {
  return String(value || '').replace(/%([^%]+)%/g, (whole, name) => {
    const resolved = envValue(env, name.trim());
    return resolved == null ? whole : String(resolved);
  });
}

function readKey(run, exe, key, name = 'Path') {
  return new Promise((resolve) => {
    try {
      run(exe, ['query', key, '/v', name], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        resolve(error ? null : parseRegistryValue(stdout, name));
      });
    } catch (_) {
      resolve(null);
    }
  });
}

// Filesystem discovery stays in Rust's worker pool. This module only adapts
// registry reads and the Node process environment used by child_process.
async function discoverTools(input) {
  const native = require('./native/runtime').getNative('windows_tools');
  if (!native?.windowsToolsDiscover) return null;
  return JSON.parse(await native.windowsToolsDiscover(JSON.stringify(input)));
}

function mergePath(current, registryValues, env) {
  const entries = [];
  const seen = new Set();
  const push = (value) => {
    for (const raw of String(value || '').split(';')) {
      const entry = normalizeEntry(raw);
      const key = entryKey(entry);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  };
  push(current);
  for (const value of registryValues) push(expandEnv(value, env));
  return entries.join(';');
}

// Re-reads the machine and user PATH and folds anything new into process.env.
// Concurrent callers share one probe; a failure leaves the current value alone
// (a machine with a broken registry read still works with the PATH it has).
function refresh({
  env = process.env,
  run = execFile,
  windows = process.platform === 'win32',
  force = false,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now,
  fsImpl = fs,
  discover = discoverTools,
} = {}) {
  if (!windows) return Promise.resolve({ changed: false, supported: false });
  if (inFlight) return inFlight;
  const time = now();
  if (!force && time - lastRefreshAt < maxAgeMs) {
    return Promise.resolve({ changed: false, cached: true, path: String(envValue(env, 'PATH') || '') });
  }

  inFlight = (async () => {
    const before = String(envValue(env, 'PATH') || '');
    augmentPath(env, { fsImpl, windows, now, force: true });
    const systemRoot = envValue(env, 'SystemRoot') || envValue(env, 'windir') || 'C:\\Windows';
    const exe = path.win32.join(systemRoot, 'System32', 'reg.exe');
    const [values, gitRoots] = await Promise.all([
      Promise.all(REGISTRY_KEYS.map(key => readKey(run, exe, key))),
      Promise.all(GIT_REGISTRY_KEYS.map(key => readKey(run, exe, key, 'InstallPath'))),
    ]);
    let tools = null;
    try {
      tools = await discover({ localAppData: envValue(env, 'LOCALAPPDATA'),
        gitInstallPaths: gitRoots.filter(Boolean).map(root => expandEnv(root, env)) });
    } catch (_) { /* retain the last discovery when the worker is unavailable */ }
    if (tools) discoveredCommands = { codex: tools.codex || null };
    lastRefreshAt = now();
    const current = String(envValue(env, 'PATH') || '');
    const merged = mergePath(current, [...values, ...(tools?.pathDirs || [])], env);
    if (merged && merged !== current) setEnvValue(env, 'PATH', merged);
    // A new CLI may appear inside an existing PATH directory, or replace a
    // versioned executable, without changing PATH at all. Invalidate command
    // maps after every real refresh, including a successful empty discovery.
    revision += 1;
    const updated = String(envValue(env, 'PATH') || '');
    return { changed: updated !== before, path: updated };
  })().finally(() => { inFlight = null; });

  return inFlight;
}

function scheduleRefresh(options) {
  return refresh(options).catch(() => ({ changed: false }));
}

// Called once at startup: make the tools that are already installed visible
// immediately, then widen PATH from the registry in the background.
function prepare(env = process.env, options = {}) {
  augmentPath(env, options);
  return scheduleRefresh({ env, ...options });
}

function version() {
  return revision;
}

function command(name, env = process.env) {
  return env === process.env ? discoveredCommands[name] || null : null;
}

function _resetForTests() {
  revision = 0;
  lastScanAt = 0;
  lastRefreshAt = 0;
  inFlight = null;
  discoveredCommands = {};
}

module.exports = {
  augmentPath,
  knownDirs,
  mergePath,
  parseRegistryPath,
  prepare,
  refresh,
  scheduleRefresh,
  version,
  command,
  _resetForTests,
};
