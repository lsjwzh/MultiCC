'use strict';

const { createAuxRunLog } = require('../classify/aux-run-log');

function createAuxRunRoutes({ records, getLog } = {}) {
  if (!records || typeof records.get !== 'function') throw new TypeError('aux run records map required');
  if (typeof getLog !== 'function') throw new TypeError('aux run log getter required');

  function mountRoutes(app) {
    if (!app || typeof app.get !== 'function') throw new TypeError('Express app.get required');

    app.get('/api/sessions/:id/aux-runs', (req, res) => {
      const sessionId = String(req.params.id || '');
      if (!records.get(sessionId)) return res.status(404).json({ error: 'session not found' });
      const log = getLog();
      const messageId = String(req.query.messageId || '');
      const taskId = String(req.query.taskId || '');
      const limit = Math.max(0, Math.min(200, Number.parseInt(req.query.limit, 10) || 0));
      const runs = messageId ? log.byAnchor(sessionId, messageId)
        : taskId ? log.byTask(sessionId, taskId)
          : log.list(sessionId, { limit });
      return res.json({ runs: limit && runs.length > limit ? runs.slice(-limit) : runs });
    });

    app.get('/api/sessions/:id/aux-runs/:runId', (req, res) => {
      const sessionId = String(req.params.id || '');
      if (!records.get(sessionId)) return res.status(404).json({ error: 'session not found' });
      const run = getLog().get(sessionId, String(req.params.runId || ''));
      if (!run) return res.status(404).json({ error: 'aux run not found' });
      return res.json({ run });
    });
  }

  return Object.freeze({ mountRoutes });
}

module.exports = { createAuxRunLog, createAuxRunRoutes };
