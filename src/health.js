'use strict';

function createHealthHandlers({ isReady, uptime = () => process.uptime() } = {}) {
  if (typeof isReady !== 'function') throw new TypeError('createHealthHandlers requires isReady()');
  return {
    healthz(req, res) {
      res.set('Cache-Control', 'no-store');
      res.json({ status: 'ok', uptimeSeconds: Math.floor(uptime()), requestId: req.id });
    },
    readyz(req, res) {
      const ready = !!isReady();
      res.set('Cache-Control', 'no-store');
      res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', requestId: req.id });
    },
  };
}

module.exports = { createHealthHandlers };
