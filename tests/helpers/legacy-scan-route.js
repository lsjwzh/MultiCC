'use strict';

function assertScanRouteDeps(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('scan route dependencies are required');
  if (!deps.scanHistory || !Array.isArray(deps.scanHistory.passes)) {
    throw new TypeError('scan route dependency missing: scanHistory.passes');
  }
  if (!Number.isInteger(deps.maxPasses) || deps.maxPasses <= 0) {
    throw new TypeError('scan route dependency invalid: maxPasses');
  }
  return deps;
}

function createScanHistoryHandler(rawDeps) {
  const deps = assertScanRouteDeps(rawDeps);
  return function scanHistoryHandler(req, res) {
    // Preserve the legacy query semantics exactly: invalid/zero values use 20,
    // positive values are capped by the in-memory ring size.
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, deps.maxPasses);
    res.json({
      seq: deps.scanHistory.seq,
      kept: deps.scanHistory.passes.length,
      passes: deps.scanHistory.passes.slice(0, limit),
    });
  };
}

function mountScanRoutes(app, deps) {
  if (!app || typeof app.get !== 'function') throw new TypeError('Express app.get is required');
  app.get('/api/scan/history', createScanHistoryHandler(deps));
}

module.exports = { assertScanRouteDeps, createScanHistoryHandler, mountScanRoutes };
