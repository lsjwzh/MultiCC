'use strict';

// Real context/output limits for models used through MultiCC-generated OpenCode
// custom providers. OpenCode only runs its own auto-compaction when a model
// entry carries `limit: {context, output}`; without it a custom-provider model
// silently accumulates tokens until the upstream context window fails.
//
// Authoritative source: OpenCode's models.dev catalog cache
// (~/.cache/opencode/models.json), which the CLI itself refreshes. Shape:
//   { "<providerId>": { "models": { "<modelId>": { "limit": { "context": N,
//      "output": N }, ... } } } }
// The file is ~4MB and changes rarely, so it is read once per mtime.
//
// Unknown models degrade to a deliberately understated fallback rather than a
// fabricated capability: a too-small context limit makes OpenCode compact
// EARLIER (safe), never later. Callers that must not act on a guess (the
// auto-rotation threshold) check `source` and stay passive on 'fallback'.

const DEFAULT_CACHE_PATH = () => {
  const home = process.env.HOME || require('node:os').homedir();
  return require('node:path').join(home, '.cache', 'opencode', 'models.json');
};
const FALLBACK_LIMIT = Object.freeze({ context: 128000, output: 8192 });

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function readCatalogOnce({ fsImpl, pathResolver }) {
  const file = (pathResolver || DEFAULT_CACHE_PATH)();
  let stat;
  try { stat = fsImpl.statSync(file); } catch (_) { return { catalog: null, mtime: -1 }; }
  const mtime = stat.mtimeMs;
  if (this._mtime === mtime && this._catalog !== undefined) {
    return { catalog: this._catalog, mtime };
  }
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    this._catalog = parsed && typeof parsed === 'object' ? parsed : null;
    this._mtime = mtime;
  } catch (_) {
    // Unreadable/corrupt cache: keep whatever was loaded before, if anything.
    this._catalog = this._catalog !== undefined ? this._catalog : null;
    this._mtime = mtime;
  }
  return { catalog: this._catalog, mtime };
}

// Exact model-id match across every provider in the catalog. Different
// providers expose the same model id with occasionally different limits, so a
// multi-match takes the SMALLEST context — conservative, never overstates.
function resolveOpenCodeModelLimit(catalog, modelId) {
  const id = String(modelId || '').trim();
  if (!id || !catalog || typeof catalog !== 'object') {
    return { context: FALLBACK_LIMIT.context, output: FALLBACK_LIMIT.output, source: 'fallback', matched: 0 };
  }
  let context = null;
  let output = null;
  let matched = 0;
  for (const provider of Object.values(catalog)) {
    const models = provider && provider.models;
    if (!models || typeof models !== 'object') continue;
    const entry = models[id];
    if (!entry || typeof entry !== 'object') continue;
    const limit = entry.limit || {};
    if (!isPositiveInt(limit.context) && !isPositiveInt(limit.output)) continue;
    matched += 1;
    if (isPositiveInt(limit.context)) {
      context = context === null ? limit.context : Math.min(context, limit.context);
    }
    if (isPositiveInt(limit.output)) {
      output = output === null ? limit.output : Math.min(output, limit.output);
    }
  }
  if (context === null && output === null) {
    return { context: FALLBACK_LIMIT.context, output: FALLBACK_LIMIT.output, source: 'fallback', matched: 0 };
  }
  return {
    context: context === null ? FALLBACK_LIMIT.context : context,
    output: output === null ? FALLBACK_LIMIT.output : output,
    source: 'models.dev',
    matched,
  };
}

function createOpencodeModelLimitResolver(deps = {}) {
  const fsImpl = deps.fsImpl || require('node:fs');
  const pathResolver = deps.cachePath
    ? () => deps.cachePath
    : DEFAULT_CACHE_PATH;
  const cache = {
    _catalog: undefined,
    _mtime: -1,
  };
  const boundRead = readCatalogOnce.bind(cache);
  return Object.freeze({
    resolve(modelId) {
      const { catalog } = boundRead({ fsImpl, pathResolver });
      return resolveOpenCodeModelLimit(catalog, modelId);
    },
    // The frozen {context, output} pair OpenCode model entries expect.
    resolveLimit(modelId) {
      const resolved = this.resolve(modelId);
      return Object.freeze({ context: resolved.context, output: resolved.output });
    },
    resetCache() { cache._catalog = undefined; cache._mtime = -1; },
  });
}

module.exports = {
  FALLBACK_LIMIT,
  createOpencodeModelLimitResolver,
  resolveOpenCodeModelLimit,
};
