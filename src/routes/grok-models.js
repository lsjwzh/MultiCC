'use strict';

// GET /api/grok/models — the models the local Grok Build CLI offers.
//
// `grok models` prints:
//   Default model: grok-4.6
//   Available models:
//     * grok-4.6 (default)
//     - grok-4.5
// When the CLI is not signed in it still prints a (shorter) list preceded by
// "You are not authenticated." — that list is served but NOT cached, so the
// account's real catalog replaces it as soon as the user logs in.

const { execFile } = require('child_process');
const { resolveCliCommands } = require('../cli-adapters/commands');

const TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = Number(process.env.GROK_MODELS_TIMEOUT_MS || 10000);
const MAX_MODELS = 100;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ROW_RE = /^\s*[*-]\s+(\S+)/;

// Last-known catalog (grok 0.1.x), served only when the CLI cannot be read.
const GROK_MODEL_FALLBACK = Object.freeze(['grok-4.6', 'grok-4.5']);

let cache = null;

function parseGrokModels(stdout) {
  const clean = String(stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
  const authenticated = !/not authenticated/i.test(clean);
  const models = [];
  const seen = new Set();
  let inList = false;
  for (const line of clean.split(/\r?\n/)) {
    if (/^\s*available models\s*:/i.test(line)) { inList = true; continue; }
    if (!inList) continue;
    const row = ROW_RE.exec(line);
    if (!row || !MODEL_ID_RE.test(row[1]) || seen.has(row[1])) continue;
    seen.add(row[1]);
    models.push({ model: row[1], label: row[1], isDefault: /\(default\)/i.test(line) });
    if (models.length >= MAX_MODELS) break;
  }
  return { models, authenticated };
}

function resolveBin() {
  try {
    const cmd = resolveCliCommands().grok;
    return typeof cmd === 'string' && cmd ? cmd : 'grok';
  } catch (_) { return 'grok'; }
}

function listGrokModels(callback, opts = {}) {
  if (!opts.refresh && cache && (Date.now() - cache.at) < TTL_MS) {
    return setImmediate(() => callback(null, cache.models, 'cache'));
  }
  execFile(resolveBin(), ['models'], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    const parsed = err ? { models: [], authenticated: false } : parseGrokModels(stdout);
    if (parsed.models.length) {
      if (!parsed.authenticated) return callback(null, parsed.models, 'cli-unauthenticated');
      cache = { at: Date.now(), models: parsed.models };
      return callback(null, parsed.models, 'cli');
    }
    callback(null, GROK_MODEL_FALLBACK.map(model => ({ model, label: model })), 'fallback');
  });
}

function mountGrokModelRoutes(app) {
  if (!app || typeof app.get !== 'function') return;
  app.get('/api/grok/models', (req, res) => {
    // ?refresh=1 skips the 1-hour cache (the picker 刷新模型 button).
    const refresh = /^(?:1|true)$/i.test(String((req && req.query && req.query.refresh) || ''));
    listGrokModels((err, models, source) => {
      if (err) return res.status(503).json({ error: 'grok models unavailable', models: [] });
      res.json({ models, source, cached: source === 'cache' });
    }, { refresh });
  });
}

function peekGrokModels() {
  if (cache && (Date.now() - cache.at) < TTL_MS) return cache.models;
  return GROK_MODEL_FALLBACK.map(model => ({ model, label: model }));
}

module.exports = {
  mountGrokModelRoutes,
  peekGrokModels,
  listGrokModels,
  parseGrokModels,
  GROK_MODEL_FALLBACK,
  _setCacheForTest(at, models) { cache = { at, models }; },
  _resetCacheForTest() { cache = null; },
};
