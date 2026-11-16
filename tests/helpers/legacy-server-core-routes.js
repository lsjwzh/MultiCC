'use strict';

// Frozen copy of the four server-core handlers that moved to the Rust front
// door (src/health.js's createHealthHandlers plus the inline `/metrics` and
// `GET /api/repo-operations/:operationId` routes from server.js). It exists only
// as the differential oracle for
// `docs/rust-migration/differential/server-core.js`; production code must not
// require it. Update it only to mirror a documented change in Node, never to
// make the differential pass.
//
// deps:
//   uptime()           -> seconds (the retired handler floors it)
//   isReady()          -> boolean
//   readinessDetails() -> object|null (may throw; the retired handler swallowed)
//   renderMetrics()    -> the merged `name value` text (`metrics.render(extra)`)
//   status(id)         -> operation object or falsy
function createLegacyServerCoreRoutes(deps = {}) {
  if (typeof deps.uptime !== 'function') throw new TypeError('legacy server-core: uptime() is required');
  if (typeof deps.isReady !== 'function') throw new TypeError('legacy server-core: isReady() is required');
  if (typeof deps.readinessDetails !== 'function') throw new TypeError('legacy server-core: readinessDetails() is required');
  if (typeof deps.renderMetrics !== 'function') throw new TypeError('legacy server-core: renderMetrics() is required');
  if (typeof deps.status !== 'function') throw new TypeError('legacy server-core: status(id) is required');

  return function mount(app) {
    app.get('/healthz', (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({ status: 'ok', uptimeSeconds: Math.floor(deps.uptime()), requestId: req.id });
    });

    app.get('/readyz', (req, res) => {
      const ready = !!deps.isReady();
      let checks;
      try {
        checks = deps.readinessDetails();
      } catch (_) {
        checks = undefined;
      }
      res.set('Cache-Control', 'no-store');
      const body = { status: ready ? 'ready' : 'not_ready', requestId: req.id };
      if (checks && typeof checks === 'object') body.checks = checks;
      res.status(ready ? 200 : 503).json(body);
    });

    app.get('/metrics', (req, res) => {
      res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8').send(deps.renderMetrics());
    });

    app.get('/api/repo-operations/:operationId', (req, res) => {
      const operation = deps.status(req.params.operationId);
      if (!operation) return res.status(404).json({ error: 'operation not found' });
      res.json(operation);
    });
  };
}

module.exports = { createLegacyServerCoreRoutes };
