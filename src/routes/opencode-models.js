'use strict';

// GET /api/opencode/models — list models available to the local opencode CLI.
//
// The CLI ships `opencode models`, which enumerates every provider declared in
// ~/.config/opencode/opencode.json (or the repo-local opencode.jsonc) plus the
// built-in providers. Each stdout line is `<provider>/<model>`. We parse those
// into `{provider, model, label}` triples the chat picker can render directly.
//
// The CLI is authoritative (it knows built-in + user config + secret-store
// expansions); the opencode.json file-read is only a fallback when the binary
// is missing or refuses to list. The result is cached in-process for 1 day so
// repeated picker opens do not spawn the CLI.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OPENCODE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const OPENCODE_TIMEOUT_MS = 2000;
const MAX_MODELS = 1000;

// opencode is rarely on the server's PATH (it lives in ~/.opencode/bin, only
// added by interactive zsh rc). Probe the explicit override first, then PATH
// ('opencode'), then the canonical ~/.opencode/bin location, then Windows-style
// env-embedded paths. Falls back to parsing opencode.json directly when none of
// the CLI candidates respond in time.
function candidatesForOpenCodeBin() {
  const list = [];
  const explicit = process.env.OPENCODE_BIN;
  if (explicit) list.push(explicit);
  list.push('opencode');
  const home = os.homedir();
  if (home) {
    list.push(path.join(home, '.opencode', 'bin', 'opencode'));
    list.push(path.join(home, '.local', 'bin', 'opencode'));
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) list.push(path.join(local, 'opencode', 'opencode.exe'));
  }
  return list;
}

let cache = null; // { at: number, models: Array }

function parseOpenCodeStdout(stdout) {
  const out = [];
  const seen = new Set();
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const slash = line.indexOf('/');
    if (slash <= 0 || slash >= line.length - 1) continue;
    const provider = line.slice(0, slash).trim();
    const model = line.slice(slash + 1).trim();
    const key = `${provider}/${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider, model, label: key });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

function readOpenCodeJsonFallback() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.config', 'opencode', 'opencode.json'),
    path.join(home, '.config', 'opencode', 'opencode.jsonc'),
  ];
  for (const file of candidates) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (_) { continue; }
    // opencode.jsonc allows // and /* */ comments — strip them naively.
    const cleaned = String(raw || '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    let cfg;
    try {
      cfg = JSON.parse(cleaned);
    } catch (_) { continue; }
    const providers = cfg && typeof cfg.provider === 'object' ? cfg.provider : null;
    if (!providers) continue;
    const out = [];
    const seen = new Set();
    for (const [id, entry] of Object.entries(providers)) {
      const models = entry && typeof entry.models === 'object' ? entry.models : null;
      if (!models) continue;
      for (const model of Object.keys(models)) {
        const key = `${id}/${model}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const labelField = models[model] && typeof models[model].name === 'string' ? models[model].name : key;
        out.push({ provider: id, model, label: `${key} (${labelField})` });
        if (out.length >= MAX_MODELS) return out;
      }
    }
    if (out.length) return out;
  }
  return [];
}

function tryCliCandidate(binFile, cb) {
  execFile(binFile, ['models'], { timeout: OPENCODE_TIMEOUT_MS, maxBuffer: 512 * 1024 }, (err, stdout) => {
    if (err) return cb(err, null);
    const models = parseOpenCodeStdout(stdout);
    cb(null, models);
  });
}

// Strategy: opencode.json is what the USER actually configured (their own
// providers/auth); the opencode CLI also lists hundreds of built-in openrouter
// etc. providers the user never selected. So the JSON file leads the list —
// but it must not HIDE OpenCode's own preset providers: `opencode/*` is the
// OpenCode Zen gateway (free models such as big-pickle work without any
// config), and providers the user signed into with `opencode auth login` live
// in auth.json, not opencode.json. Those two sources are merged in from the
// CLI listing after the configured ones. With no configured providers at all
// the full CLI listing is used, as before.
const PRESET_PROVIDERS = new Set(['opencode']);

function readOpenCodeAuthProviders() {
  const home = os.homedir();
  const dirs = [process.env.XDG_DATA_HOME && path.join(process.env.XDG_DATA_HOME, 'opencode'),
    home && path.join(home, '.local', 'share', 'opencode')].filter(Boolean);
  for (const dir of dirs) {
    try {
      const auth = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
      if (auth && typeof auth === 'object') return new Set(Object.keys(auth));
    } catch (_) {}
  }
  return new Set();
}

function mergeOpenCodeModels(configured, cliModels, authProviders = new Set()) {
  if (!configured.length) return cliModels;
  const seen = new Set(configured.map(m => `${m.provider}/${m.model}`));
  const configuredProviders = new Set(configured.map(m => m.provider));
  const extra = cliModels.filter(m => !seen.has(`${m.provider}/${m.model}`)
    && !configuredProviders.has(m.provider)
    && (PRESET_PROVIDERS.has(m.provider) || authProviders.has(m.provider)));
  return [...configured, ...extra].slice(0, MAX_MODELS);
}

function listCliModels(callback) {
  const candidates = candidatesForOpenCodeBin();
  let idx = -1;
  const next = () => {
    idx += 1;
    if (idx >= candidates.length) return callback(new Error('opencode models unavailable'), []);
    tryCliCandidate(candidates[idx], (err, cliModels) => {
      if (err || !cliModels || !cliModels.length) {
        if (err && err.killed && err.signal === 'SIGTERM') {
          idx = candidates.length; // timeout — stop trying slower candidates
        }
        return next();
      }
      callback(null, cliModels);
    });
  };
  next();
}

function listOpenCodeModels(callback) {
  if (cache && (Date.now() - cache.at) < OPENCODE_TTL_MS) {
    return setImmediate(() => callback(null, cache.models, 'cache'));
  }
  let configured = [];
  try {
    configured = readOpenCodeJsonFallback() || [];
  } catch (_) { configured = []; }
  listCliModels((err, cliModels) => {
    if (err && !configured.length) return callback(err, [], 'fallback');
    const models = err ? configured : mergeOpenCodeModels(configured, cliModels, readOpenCodeAuthProviders());
    cache = { at: Date.now(), models };
    callback(null, models, configured.length ? 'config' : 'cli');
  });
}

function mountOpenCodeModelRoutes(app) {
  if (!app || typeof app.get !== 'function') return;
  app.get('/api/opencode/models', (req, res) => {
    listOpenCodeModels((err, models, source) => {
      if (err) return res.status(503).json({ error: 'opencode models unavailable', models: [] });
      res.json({ models, source, cached: source === 'cache' });
    });
  });
}

module.exports = {
  mountOpenCodeModelRoutes,
  listOpenCodeModels,
  parseOpenCodeStdout,
  readOpenCodeJsonFallback,
  mergeOpenCodeModels,
  // exposed for tests
  _setCacheForTest(at, models) { cache = { at, models }; },
  _resetCacheForTest() { cache = null; },
};