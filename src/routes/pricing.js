'use strict';

// /api/pricing/* — the model price table (src/pricing/price-table.js) over HTTP.
//
//   GET  /api/pricing/status
//   GET  /api/pricing/lookup?models=a,b,c     (bulk, ≤ 50 ids, each ≤ 100 chars)
//   POST /api/pricing/refresh                 (awaits one refresh, then reports)
//   GET  /api/pricing/search?q=&limit=        (limit ≤ 50)
//
// These are the read side of the Auto Provider router: the chat/manage UI wants
// to show why one lane is cheaper than another, and a session's own model list
// arrives as a batch of ids, so lookup is a bulk endpoint rather than a per-id
// call. Nothing here caches: the table is the cache (see the module header), and
// it answers synchronously from a local copy.
//
// Errors carry ok:false and a stable error code, matching the other /api
// surfaces; a validation refusal is a 400, a broken request a 500 via the
// shared asyncHandler.

const MAX_LOOKUP_MODELS = 50;
const MAX_MODEL_LENGTH = 100;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 20;

// `models` is a comma-separated list, so any comma inside an id would split it.
// Model ids never contain commas (the catalog has none), so the split is safe;
// what it does need is trimming and empty-segment filtering, because a UI that
// joins checked rows easily produces 'a,,b,'.
function parseModelList(raw) {
  if (typeof raw !== 'string') return [];
  const seen = new Set();
  const models = [];
  for (const part of raw.split(',')) {
    const model = part.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models;
}

// Only the refreshing route needs this (the others are synchronous), and
// server.js passes the shared asyncHandler from src/http-errors. This fallback
// exists so the module is mountable on a host that has neither express nor that
// helper — it returns the promise so a direct caller can await the outcome.
function fallbackAsyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(error => {
    if (typeof next === 'function') return next(error);
    return res.status(500).json({ ok: false, error: 'pricing request failed' });
  });
}

function mountPricingRoutes(app, deps = {}) {
  if (!app || typeof app.get !== 'function') return null;
  const priceTable = deps.priceTable;
  if (!priceTable || typeof priceTable.lookupMany !== 'function') {
    throw new TypeError('mountPricingRoutes requires a priceTable');
  }
  const wrap = typeof deps.asyncHandler === 'function' ? deps.asyncHandler : fallbackAsyncHandler;

  app.get('/api/pricing/status', (req, res) => {
    res.json({ ok: true, status: priceTable.status() });
  });

  app.get('/api/pricing/lookup', (req, res) => {
    const models = parseModelList(req.query && req.query.models);
    if (!models.length) {
      return res.status(400).json({ ok: false, error: 'models_required', max: MAX_LOOKUP_MODELS });
    }
    if (models.length > MAX_LOOKUP_MODELS) {
      return res.status(400).json({ ok: false, error: 'too_many_models', max: MAX_LOOKUP_MODELS });
    }
    const tooLong = models.find(model => model.length > MAX_MODEL_LENGTH);
    if (tooLong) {
      return res.status(400).json({ ok: false, error: 'model_too_long', max: MAX_MODEL_LENGTH });
    }
    return res.json({ ok: true, prices: priceTable.lookupMany(models), status: priceTable.status() });
  });

  // A manual refresh is the one caller that must not be answered by a 304, so
  // it may force a full download (?force=1). Default (conditional) is the cheap
  // path a UI button presses.
  app.post('/api/pricing/refresh', wrap(async (req, res) => {
    const force = String((req.query && req.query.force) || (req.body && req.body.force) || '') === '1'
      || (req.body && req.body.force === true);
    const status = await priceTable.refresh({ force });
    res.json({ ok: true, status });
  }));

  app.get('/api/pricing/search', (req, res) => {
    const query = String((req.query && req.query.q) || '').trim();
    const requested = Number.parseInt(String((req.query && req.query.limit) || ''), 10);
    // The limit is a cap, not a validation: a UI that asks for 100 rows gets the
    // best 50 instead of an empty result it cannot explain.
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, MAX_SEARCH_LIMIT)
      : DEFAULT_SEARCH_LIMIT;
    const results = query ? priceTable.search(query, { limit }) : [];
    res.json({ ok: true, query, count: results.length, results, status: priceTable.status() });
  });

  return priceTable;
}

module.exports = {
  mountPricingRoutes,
  MAX_LOOKUP_MODELS,
  MAX_MODEL_LENGTH,
  MAX_SEARCH_LIMIT,
};
