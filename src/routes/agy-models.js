'use strict';
// Node-side view of the Antigravity (agy) model catalog.
//
// The public `/api/agy/models` route is owned by the Rust front door
// (native/gateway/src/app/agy_catalog.rs) and answers with the ACP session's
// logical models (base id + a separate thought level). This module exists for
// the one Node consumer that cannot wait on that route: the Auto Provider pool
// builds `<cli>-native:<cli>` candidates synchronously (`nativeVendorModels`),
// and an empty list there leaves the agy line without any model to pin.
//
// `agy models` prints the account's concrete entitlements — one row per model
// AND thought level ("gemini-4-neon-high"). Those ids are what ACP's model
// config option accepts (it normalizes the suffix into the thought level), so
// pinning one is always valid for the signed-in account.
//
// Output shape:
//   Fetching available models...
//   gemini-4-neon-high	Gemini 4 Neon (High)
//   ...

const { execFile } = require('child_process');
const { resolveCliCommands } = require('../cli-adapters/commands');

const TTL_MS = Number(process.env.AGY_MODELS_TTL_MS || 60 * 60 * 1000);
const RETRY_MS = 30 * 1000;
const TIMEOUT_MS = Number(process.env.AGY_MODELS_TIMEOUT_MS || 15000);
const MAX_MODELS = 100;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

// { at, models } when the CLI last answered; `failedAt` backs off a broken or
// signed-out CLI so a sync peek never spawns it on every call.
let cache = null;
let failedAt = 0;
let warming = false;

function parseAgyModels(stdout) {
  const models = [];
  const seen = new Set();
  for (const raw of String(stdout || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    // Split before trimming: a trailing tab is an empty label, not a reason to
    // drop the row (trim would eat the separator along with the whitespace).
    const tab = raw.indexOf('\t');
    if (tab <= 0) continue;
    const id = raw.slice(0, tab).trim();
    const label = raw.slice(tab + 1).trim();
    if (!MODEL_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ model: id, label: label || id });
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

function resolveBin() {
  try {
    const cmd = resolveCliCommands().agy;
    return typeof cmd === 'string' && cmd ? cmd : 'agy';
  } catch (_) { return 'agy'; }
}

function listAgyModels(callback, opts = {}) {
  if (!opts.refresh && cache && (Date.now() - cache.at) < TTL_MS) {
    return setImmediate(() => callback(null, cache.models, 'cache'));
  }
  execFile(resolveBin(), ['models'], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    const models = err ? [] : parseAgyModels(stdout);
    if (models.length) {
      cache = { at: Date.now(), models };
      failedAt = 0;
      return callback(null, models, 'cli');
    }
    failedAt = Date.now();
    callback(null, [], 'unavailable');
  });
}

// Synchronous best effort for the Auto Provider pool. A cold cache kicks off a
// single background warm (never blocks the caller, never retries within
// RETRY_MS) and answers [] until it lands.
function peekAgyModels() {
  if (cache && (Date.now() - cache.at) < TTL_MS) return cache.models.slice();
  if (!warming && Date.now() - failedAt >= RETRY_MS) {
    warming = true;
    listAgyModels(() => { warming = false; });
  }
  return [];
}

module.exports = {
  parseAgyModels,
  listAgyModels,
  peekAgyModels,
  _resetCacheForTest() { cache = null; failedAt = 0; warming = false; },
};
