'use strict';

// GET /api/commandcode/models — the models the local Command Code CLI offers.
//
// `commandcode --list-models` prints the vendor catalog grouped by section
// ("Open Source", "Anthropic", "OpenAI", "xAI", "DeepSeek Flash (byok)", ...),
// one `<id>   <description>` row per model. The grouping is the vendor's own,
// so it is carried through as `group` for the picker to reproduce. The listing
// is a network call (~6s) and the catalog moves weekly, hence the 1-hour cache.
// Sections that are not usable as an interactive `--model` ("Decision models
// (headless only)") are dropped, as is any banner/footer text around them.

const { execFile } = require('child_process');
const { resolveCliCommands } = require('../cli-adapters/commands');

const TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = Number(process.env.COMMANDCODE_MODELS_TIMEOUT_MS || 20000);
const MAX_MODELS = 400;
// An id never ends in ":" (that would be the "Docs:" footer row).
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,118}[A-Za-z0-9._\/-]$/;
const ROW_RE = /^(\S+)\s{2,}(\S.*)$/;
const EXCLUDED_GROUP_RE = /headless only/i;

// Offline snapshot (commandcode 1.84.0); never cached so a recovering CLI wins.
const COMMANDCODE_MODEL_FALLBACK = Object.freeze([
  { model: 'deepseek/deepseek-v4-flash', group: 'Open Source' },
  { model: 'deepseek/deepseek-v4-pro', group: 'Open Source' },
  { model: 'deepseek/deepseek-v4.1-flash', group: 'Open Source' },
  { model: 'moonshotai/kimi-k3', group: 'Open Source' },
  { model: 'zai-org/glm-5.3', group: 'Open Source' },
  { model: 'claude-sonnet-5-5', group: 'Anthropic' },
  { model: 'claude-opus-5-5', group: 'Anthropic' },
  { model: 'deepseek/deepseek-flash', group: 'DeepSeek Flash (byok)' },
]);

let cache = null; // { at, models }

function parseCommandcodeList(stdout) {
  const lines = String(stdout || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map(l => l.trimEnd());
  const out = [];
  const seen = new Set();
  for (let i = 0; i < lines.length - 2; i++) {
    const title = lines[i].trim();
    // A section is: title, blank line, then at least one model row. The banner
    // ("Available models · 94 models") is followed by another title, not a row.
    if (!title || ROW_RE.test(title) || lines[i + 1].trim() !== '' || !ROW_RE.test(lines[i + 2])) continue;
    let j = i + 2;
    for (; j < lines.length && lines[j].trim() !== ''; j++) {
      const row = ROW_RE.exec(lines[j].trim());
      if (!row) continue; // stray prose inside a section: skip, keep the rest
      const model = row[1];
      if (EXCLUDED_GROUP_RE.test(title) || !MODEL_ID_RE.test(model) || seen.has(model)) continue;
      seen.add(model);
      out.push({ model, label: model, group: title, description: row[2].trim() });
      if (out.length >= MAX_MODELS) return out;
    }
    i = j;
  }
  return out;
}

function resolveBin() {
  try {
    const cmd = resolveCliCommands().commandcode;
    return typeof cmd === 'string' && cmd ? cmd : 'commandcode';
  } catch (_) { return 'commandcode'; }
}

function listCommandcodeModels(callback, opts = {}) {
  if (!opts.refresh && cache && (Date.now() - cache.at) < TTL_MS) {
    return setImmediate(() => callback(null, cache.models, 'cache'));
  }
  execFile(resolveBin(), ['--list-models'], { timeout: TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
    const models = err ? [] : parseCommandcodeList(stdout);
    if (models.length) {
      cache = { at: Date.now(), models };
      return callback(null, models, 'cli');
    }
    callback(null, COMMANDCODE_MODEL_FALLBACK.map(m => ({ ...m, label: m.model })), 'fallback');
  });
}

// Synchronous view for the Auto Provider runtime's lane catalog: the warm cache
// when it exists, otherwise the bundled snapshot. Never starts the ~6s network
// listing from a turn, and never returns an empty line list.
function peekCommandcodeModels() {
  if (cache && (Date.now() - cache.at) < TTL_MS) return cache.models;
  return COMMANDCODE_MODEL_FALLBACK.map(m => ({ ...m, label: m.model }));
}

function mountCommandcodeModelRoutes(app) {
  if (!app || typeof app.get !== 'function') return;
  app.get('/api/commandcode/models', (req, res) => {
    // ?refresh=1 skips the 1-hour cache (the picker 刷新模型 button).
    const refresh = /^(?:1|true)$/i.test(String((req && req.query && req.query.refresh) || ''));
    listCommandcodeModels((err, models, source) => {
      if (err) return res.status(503).json({ error: 'commandcode models unavailable', models: [] });
      res.json({ models, source, cached: source === 'cache' });
    }, { refresh });
  });
}

module.exports = {
  mountCommandcodeModelRoutes,
  listCommandcodeModels,
  peekCommandcodeModels,
  parseCommandcodeList,
  COMMANDCODE_MODEL_FALLBACK,
  _setCacheForTest(at, models) { cache = { at, models }; },
  _resetCacheForTest() { cache = null; },
};
