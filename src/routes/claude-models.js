'use strict';

// GET /api/claude/models — list the Claude models the local claude CLI knows.
//
// There is no `claude --list-models`, and the Anthropic /v1/models endpoint is
// not reachable for OAuth subscription (Claude Official) logins without an API
// key. The one authoritative local source that tracks Anthropic's releases is
// the installed CLI itself: its bundle embeds every servable model id, and the
// user upgrades the CLI far more often than we ship a hardcoded picker row —
// exactly the drift that hid claude-opus-5 from the App picker for weeks after
// the Web list gained it. We therefore extract ids from the CLI bundle and
// cache the result in-process for a day (the browser/app mirror the same TTL).
//
// The bundle is ~300MB, so extraction streams fixed-size chunks with a small
// overlap (a model id is ≤ 40 chars) instead of reading the whole file. Only
// the newest FAMILY_WINDOW versions per family are offered — the picker is a
// curated list, not a museum; '__custom__' remains for anything older.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const CHUNK_SIZE = 4 * 1024 * 1024;
const CHUNK_OVERLAP = 64; // > max model id length, so ids spanning chunks survive
const MAX_SCAN_BYTES = 400 * 1024 * 1024;
const FAMILY_WINDOW = 2; // newest N versions per family, newest first
const FAMILY_ORDER = ['opus', 'sonnet', 'fable', 'haiku'];
// Groups: 1 family, 2 major, 3 minor (≤2 digits — anything longer must be the
// 8-char date stamp in group 4), 5 [1m]. `claude-opus-4-20250514` therefore
// parses as major 4 + date, not as minor 20250514. The lookbehind keeps
// `xclaude-opus-5-1`-style substrings out.
const MODEL_ID_RE = /(?<![\w-])claude-(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d{1,2}))?(?:-(\d{8}))?(\[1m\])?(?![\w-])/g;

// Offline fallback mirroring public/shared/models.js CLAUDE_MODEL_OPTIONS (the
// picker adds the '' default and '__custom__' rows itself). Never cached: an
// unreadable CLI should recover on the next picker open.
// Snapshot of what bundle 2.1.x serves (only ids the bundle itself carries a
// [1m] variant for get a 1M row — fable/haiku/sonnet-5 have none).
const CLAUDE_MODELS_FALLBACK = Object.freeze([
  { model: 'claude-opus-5[1m]', label: 'Opus 5 (1M context)' },
  { model: 'claude-opus-5', label: 'Opus 5' },
  { model: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M context)' },
  { model: 'claude-opus-4-8', label: 'Opus 4.8' },
  { model: 'claude-sonnet-5', label: 'Sonnet 5' },
  { model: 'claude-sonnet-4-6[1m]', label: 'Sonnet 4.6 (1M context)' },
  { model: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { model: 'claude-fable-5', label: 'Fable 5' },
  { model: 'claude-haiku-4-5', label: 'Haiku 4.5' },
]);

let cache = null; // { at: number, models: Array }

// Locate the live claude CLI bundle. `which claude` is typically a symlink
// (~/.local/bin/claude → ~/.local/share/claude/versions/<ver>); resolve it so
// a version bump is picked up automatically. Falls back to the newest entry
// under the versions dir. Returns '' when nothing readable exists.
function resolveClaudeBundle(home = os.homedir()) {
  const shim = path.join(home, '.local', 'bin', 'claude');
  try {
    const real = fs.realpathSync(shim);
    if (fs.statSync(real).isFile()) return real;
  } catch (_) { /* shim missing — try the versions dir */ }
  const versionsDir = path.join(home, '.local', 'share', 'claude', 'versions');
  try {
    const entries = fs.readdirSync(versionsDir)
      .map(name => ({ name, file: path.join(versionsDir, name) }))
      .filter(e => { try { return fs.statSync(e.file).isFile(); } catch (_) { return false; } })
      .sort((a, b) => fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs);
    return entries.length ? entries[0].file : '';
  } catch (_) { return ''; }
}

// Stream the bundle and collect canonical model ids plus the subset that has a
// literal `<id>[1m]` variant (the CLI only grants 1M context to specific ids —
// the 2.1.234 bundle carries [1m] for opus 4-6…5 and sonnet 4-5/4-6, but not
// for fable, haiku or sonnet 5). Test seam: accepts any readable file path, so
// a small fixture exercises the same code path as the 300MB real bundle (chunk
// overlap is covered by sizing the fixture across a tiny CHUNK_SIZE override —
// see _setChunkSizeForTest).
let chunkSizeForTest = 0;
function extractModels(bundleFile) {
  const ids = new Set();
  const oneMIds = new Set();
  const chunkSize = Math.max(1, chunkSizeForTest || CHUNK_SIZE);
  const fd = fs.openSync(bundleFile, 'r');
  try {
    const size = Math.min(fs.fstatSync(fd).size, MAX_SCAN_BYTES);
    const buf = Buffer.alloc(chunkSize + CHUNK_OVERLAP);
    // Sliding windows of [offset, offset + chunkSize + CHUNK_OVERLAP) that
    // advance by chunkSize, so consecutive windows share CHUNK_OVERLAP bytes —
    // more than the longest possible id — and an id straddling a window end is
    // seen whole in the next one.
    let offset = 0;
    while (offset < size) {
      const want = Math.min(chunkSize + CHUNK_OVERLAP, size - offset);
      const read = fs.readSync(fd, buf, 0, want, offset);
      if (read <= 0) break;
      const text = buf.toString('utf8', 0, read);
      MODEL_ID_RE.lastIndex = 0;
      let m;
      while ((m = MODEL_ID_RE.exec(text))) {
        const id = canonicalKey(m);
        ids.add(id);
        if (m[5]) oneMIds.add(id);
        if (ids.size >= 500) return { ids, oneMIds }; // sanity bound; real bundles yield ~25
      }
      offset += chunkSize;
    }
    return { ids, oneMIds };
  } finally {
    fs.closeSync(fd);
  }
}

// Canonical key for a MODEL_ID_RE match: drop the date stamp and normalize the
// dot minor separator, so claude-sonnet-4.6 / claude-sonnet-4-6 /
// claude-sonnet-4-6-20251114 collapse into one entry whose id is the plain
// dash form the CLI answers to.
function canonicalKey(match) {
  const core = match[3] ? `${match[2]}-${match[3]}` : match[2];
  return `claude-${match[1]}-${core}`;
}

// claude-haiku-4-5-20251001 carries a date stamp; the same model also answers
// to the undated id, so prefer the shorter one when both appear. Returns the
// canonical (undated) form of an id, or the id itself when already canonical.
function canonicalId(id) {
  return String(id).replace(/-\d{8}$/, '');
}

function versionKey(id) {
  const m = /^claude-[a-z]+-(\d+)(?:[.-](\d{1,2}))?/.exec(id);
  return m ? [Number(m[1]) || 0, Number(m[2]) || 0] : [0, 0];
}

function displayLabel(family, id) {
  const [major, minor] = versionKey(id);
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return minor ? `${name} ${major}.${minor}` : `${name} ${major}`;
}

// Curate extracted ids into picker entries: newest FAMILY_WINDOW versions per
// family, newest first, families in FAMILY_ORDER. A [1m] row is emitted only
// when the bundle actually carries that variant — never invented.
function curateModels(result) {
  const ids = result instanceof Set ? result : result.ids;
  const oneMIds = result instanceof Set ? new Set() : result.oneMIds;
  const byFamily = new Map(); // family -> Set(canonicalId)
  for (const id of ids) {
    const family = /^claude-([a-z]+)-/.exec(id)?.[1];
    if (!family || !FAMILY_ORDER.includes(family)) continue;
    if (!byFamily.has(family)) byFamily.set(family, new Set());
    byFamily.get(family).add(id);
  }
  const models = [];
  for (const family of FAMILY_ORDER) {
    const set = byFamily.get(family);
    if (!set) continue;
    const sorted = [...set]
      .sort((a, b) => {
        const va = versionKey(a); const vb = versionKey(b);
        return vb[0] - va[0] || vb[1] - va[1] || a.length - b.length;
      })
      .slice(0, FAMILY_WINDOW);
    for (const id of sorted) {
      const label = displayLabel(family, id);
      if (oneMIds.has(id)) models.push({ model: `${id}[1m]`, label: `${label} (1M context)` });
      models.push({ model: id, label });
    }
  }
  return models;
}

function listClaudeModels(options = {}, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (cache && (Date.now() - cache.at) < CLAUDE_TTL_MS) {
    return setImmediate(() => callback(null, cache.models, 'cache'));
  }
  setImmediate(() => {
    let models = [];
    try {
      const bundle = options.bundleFile || resolveClaudeBundle(options.home);
      if (bundle) models = curateModels(extractModels(bundle));
    } catch (_) { models = []; }
    if (models.length) {
      cache = { at: Date.now(), models };
      return callback(null, models, 'cli');
    }
    // Do not cache the fallback: an uninstalled/broken CLI should recover on
    // the next picker open rather than serving the static list for a day.
    callback(null, CLAUDE_MODELS_FALLBACK.map(m => ({ ...m })), 'fallback');
  });
}

function mountClaudeModelRoutes(app) {
  if (!app || typeof app.get !== 'function') return;
  app.get('/api/claude/models', (req, res) => {
    listClaudeModels((err, models, source) => {
      if (err) return res.status(503).json({ error: 'claude models unavailable', models: [] });
      res.json({ models, source, cached: source === 'cache' });
    });
  });
}

module.exports = {
  mountClaudeModelRoutes,
  listClaudeModels,
  resolveClaudeBundle,
  extractModels,
  curateModels,
  canonicalId,
  CLAUDE_MODELS_FALLBACK,
  CLAUDE_TTL_MS,
  // exposed for tests
  _setCacheForTest(at, models) { cache = { at, models }; },
  _resetCacheForTest() { cache = null; chunkSizeForTest = 0; },
  _setChunkSizeForTest(n) { chunkSizeForTest = n | 0; },
};
