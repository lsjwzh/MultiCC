'use strict';

// The static Claude model list and the synchronous reader for the list the
// Rust front door extracted (GET /api/claude/models, src/routes/claude-models.js
// was retired into native/gateway).
//
// `listClaudeModelsSync()` runs on the spawn/listing hot path
// (src/cli/session-policy.js), so it must never scan the CLI bundle. The
// gateway writes its last successful extraction to `<data root>/claude-models-cache.json`
// (0600); this module only reads that file and falls back to the static list
// for anything unreadable. It deliberately ignores the cache's TTL and bundle
// key: a stale list is still a valid list of model ids, and the route refreshes
// the file on its own schedule.

const fs = require('fs');
const path = require('path');
const { createPaths } = require('./paths');

// Mirrors multicc_core::claude_models::FALLBACK / the retired route's
// CLAUDE_MODELS_FALLBACK. tests/test-claude-models-fallback.js and the gateway
// fixture native/gateway/tests/fixtures/claude-models.json keep them in sync.
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

const CACHE_FILE_NAME = 'claude-models-cache.json';

let rootCache = '';
let memo = null; // { file, mtimeMs, size, models }

function staticIds() {
  return CLAUDE_MODELS_FALLBACK.map(entry => entry.model);
}

function cacheFile() {
  const root = createPaths().root;
  if (root !== rootCache) {
    rootCache = root;
    memo = null;
  }
  return path.join(root, CACHE_FILE_NAME);
}

function readModels(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!doc || !Array.isArray(doc.models)) return [];
  return doc.models
    .filter(entry => entry && typeof entry.model === 'string' && entry.model)
    .map(entry => entry.model);
}

/**
 * The last extracted ids, or the static list. Never scans, never throws.
 * Memoized on (mtimeMs, size); a corrupt or empty cache also falls back.
 */
function listClaudeModelsSync() {
  try {
    const file = cacheFile();
    const stat = fs.statSync(file);
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (memo && memo.file === file && memo.key === key) {
      return memo.models.length ? memo.models : staticIds();
    }
    const models = readModels(file);
    memo = { file, key, models };
    return models.length ? models : staticIds();
  } catch (_) {
    return staticIds();
  }
}

// Tests isolate MULTICC_DATA_DIR per file; drop the memoized root with it.
function _resetCacheForTest() {
  rootCache = '';
  memo = null;
}

module.exports = {
  CLAUDE_MODELS_FALLBACK,
  CACHE_FILE_NAME,
  listClaudeModelsSync,
  _resetCacheForTest,
};
