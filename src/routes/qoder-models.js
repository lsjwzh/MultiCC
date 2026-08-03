'use strict';

// GET /api/qoder/models — list the models the local Qoder CN CLI may use.
//
// `qoderclicn --list-models` prints the catalog entitled to the logged-in
// account, one display name per line under a `MODEL` header. That list is the
// only authoritative source: internal model ids are opaque and do NOT track
// renames (the GA "GLM-5.2" still answers to `gm51model`), so a hardcoded table
// silently rots — exactly the failure that left every qoder session erroring
// with `Model "qmodel_preview" is not available` after 3.8 Preview went GA.
//
// `--model` accepts the display name for default/new models, so the CLI output
// can be handed to the picker verbatim. The call costs ~1.3s, so the result is
// cached in-process for a day; the browser mirrors the same TTL.

const { execFile } = require('child_process');
const { resolveCliCommands } = require('../cli-adapters/commands');

const QODER_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
// Deliberately looser than opencode's 2s: --list-models is a network call to
// the Qoder catalog, not a local config read.
const QODER_TIMEOUT_MS = Number(process.env.QODER_MODELS_TIMEOUT_MS || 15000);
const MAX_MODELS = 200;
const HEADER_LINE = 'model';

// Qoder CN's built-in routing tiers. They are not in --list-models (it lists
// concrete models) but remain valid --model values, and they are what the
// picker offered before this route existed. Kept as the offline fallback so a
// logged-out / offline CLI still yields a usable list.
const QODER_TIER_FALLBACK = Object.freeze([
  'Auto', 'ultimate', 'performance', 'efficient', 'lite',
]);

let cache = null; // { at: number, models: Array }

function parseQoderStdout(stdout) {
  const out = [];
  const seen = new Set();
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    // The CLI is not a TTY here, but strip SGR sequences defensively so a
    // future coloured build does not poison every option value.
    const line = raw.replace(/\[[0-9;]*m/g, '').trim();
    if (!line) continue;
    if (line.toLowerCase() === HEADER_LINE) continue;
    // Guard against a future tabular format leaking extra columns.
    const model = line.split(/\s{2,}|\t/)[0].trim();
    if (!model || model.length > 120) continue;
    if (seen.has(model)) continue;
    seen.add(model);
    out.push({ model, label: model });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

function resolveQoderBin() {
  try {
    const cmd = resolveCliCommands().qoder;
    return typeof cmd === 'string' && cmd ? cmd : 'qoderclicn';
  } catch (_) { return 'qoderclicn'; }
}

function listQoderModels(callback) {
  if (cache && (Date.now() - cache.at) < QODER_TTL_MS) {
    return setImmediate(() => callback(null, cache.models, 'cache'));
  }
  const bin = resolveQoderBin();
  execFile(bin, ['--list-models'], { timeout: QODER_TIMEOUT_MS, maxBuffer: 256 * 1024 }, (err, stdout) => {
    const models = err ? [] : parseQoderStdout(stdout);
    if (models.length) {
      cache = { at: Date.now(), models };
      return callback(null, models, 'cli');
    }
    // Do not cache the fallback: a logged-out CLI should recover on the next
    // picker open rather than serving tiers for a whole day.
    callback(null, QODER_TIER_FALLBACK.map(model => ({ model, label: model })), 'fallback');
  });
}

function mountQoderModelRoutes(app) {
  if (!app || typeof app.get !== 'function') return;
  app.get('/api/qoder/models', (req, res) => {
    listQoderModels((err, models, source) => {
      if (err) return res.status(503).json({ error: 'qoder models unavailable', models: [] });
      res.json({ models, source, cached: source === 'cache' });
    });
  });
}

module.exports = {
  mountQoderModelRoutes,
  listQoderModels,
  parseQoderStdout,
  QODER_TIER_FALLBACK,
  // exposed for tests
  _setCacheForTest(at, models) { cache = { at, models }; },
  _resetCacheForTest() { cache = null; },
};
