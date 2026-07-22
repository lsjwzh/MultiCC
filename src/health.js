'use strict';

function createHealthHandlers({ isReady, readinessDetails, uptime = () => process.uptime() } = {}) {
  if (typeof isReady !== 'function') throw new TypeError('createHealthHandlers requires isReady()');
  return {
    healthz(req, res) {
      res.set('Cache-Control', 'no-store');
      res.json({ status: 'ok', uptimeSeconds: Math.floor(uptime()), requestId: req.id });
    },
    readyz(req, res) {
      const ready = !!isReady();
      let checks;
      if (typeof readinessDetails === 'function') {
        try { checks = readinessDetails(); } catch (_) { checks = undefined; }
      }
      res.set('Cache-Control', 'no-store');
      const body = { status: ready ? 'ready' : 'not_ready', requestId: req.id };
      if (checks && typeof checks === 'object') body.checks = checks;
      res.status(ready ? 200 : 503).json(body);
    },
  };
}

module.exports = { createHealthHandlers };
