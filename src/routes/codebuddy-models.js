'use strict';

// GET /api/codebuddy/models — list the models the local WorkBuddy CLI may use.
//
// WorkBuddy has no `--list-models`, but it auto-updates constantly and its
// `--help` prints the currently supported ids inline on the `--model` flag
// ("Currently supported: (hy4-preview-f, glm-5.3, …)"). That help text is the
// only local source that tracks the vendor's rapid releases — the hardcoded
// picker table rotted within weeks (it still offered gpt-5.6-sol long after
// the CLI dropped it). `--help` is local and sub-second, so a 1-hour cache is
// plenty; an account-entitlement list exists only in the server-side 400
// error for a bogus --model, which cannot be queried on demand.
//
// The `default-model`/`fast-model`/… tier aliases remain valid --model values
// (verified against 2.156.0) but are NOT in the help list; the picker pins
// them itself, so this route serves concrete ids only.

const { execFile } = require('child_process');
const { resolveCliCommands } = require('../cli-adapters/commands');

const CODEBUDDY_TTL_MS = 60 * 60 * 1000; // 1 hour — local call, fast-moving CLI
const CODEBUDDY_TIMEOUT_MS = Number(process.env.CODEBUDDY_MODELS_TIMEOUT_MS || 10000);
const MAX_MODELS = 200;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SUPPORTED_RE = /currently supported:\s*\(([^)]*)\)/i;

// Last-known catalog (codebuddy 2.156.0 --help), served only when the local
// CLI cannot be read. Never cached: a recovering CLI must win on the next call.
const CODEBUDDY_MODEL_FALLBACK = Object.freeze([
  'hy4-preview-f', 'hy3', 'hy3-x', 'deepseek-v4.1-flash',
  'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo',
  'minimax-m3', 'minimax-m2.7',
  'kimi-k3-1', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6',
  'deepseek-v4-pro',
]);

let cache = null; // { at: number, models: Array }

function parseCodebuddyHelp(stdout) {
  const clean = String(stdout || '').replace(/\[[0-9;]*m/g, '');
  const match = SUPPORTED_RE.exec(clean);
  if (!match) return [];
  const out = [];
  const seen = new Set();
  for (const raw of match[1].split(',')) {
    const model = raw.trim();
    if (!MODEL_ID_RE.test(model) || seen.has(model)) continue;
    seen.add(model);
    out.push({ model, label: model });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

function resolveCodebuddyBin() {
  try {
    const cmd = resolveCliCommands().codebuddy;
    return typeof cmd === 'string' && cmd ? cmd : 'codebuddy';
  } catch (_) { return 'codebuddy'; }
}

function listCodebuddyModels(callback) {
  if (cache && (Date.now() - cache.at) < CODEBUDDY_TTL_MS) {
    return setImmediate(() => callback(null, cache.models, 'cache'));
  }
  execFile(resolveCodebuddyBin(), ['--help'], { timeout: CODEBUDDY_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    const models = err ? [] : parseCodebuddyHelp(stdout);
    if (models.length) {
      cache = { at: Date.now(), models };
      return callback(null, models, 'cli');
    }
    callback(null, CODEBUDDY_MODEL_FALLBACK.map(model => ({ model, label: model })), 'fallback');
  });
}

function mountCodebuddyModelRoutes(app) {
  if (!app || typeof app.get !== 'function') return;
  app.get('/api/codebuddy/models', (req, res) => {
    listCodebuddyModels((err, models, source) => {
      if (err) return res.status(503).json({ error: 'codebuddy models unavailable', models: [] });
      res.json({ models, source, cached: source === 'cache' });
    });
  });
}

module.exports = {
  mountCodebuddyModelRoutes,
  listCodebuddyModels,
  parseCodebuddyHelp,
  CODEBUDDY_MODEL_FALLBACK,
  // exposed for tests
  _setCacheForTest(at, models) { cache = { at, models }; },
  _resetCacheForTest() { cache = null; },
};
