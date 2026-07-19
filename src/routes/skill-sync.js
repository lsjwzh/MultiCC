'use strict';

const { sanitizePublicText } = require('../http/public-safety');

function assertRouteDependencies(app, runtime) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('skill sync routes require Express get/post');
  }
  for (const name of ['getStatus', 'runNow']) {
    if (!runtime || typeof runtime[name] !== 'function') {
      throw new TypeError(`skill sync runtime missing: ${name}`);
    }
  }
}

function createStatusHandler(runtime) {
  return function skillSyncStatusHandler(req, res) {
    res.json(runtime.getStatus());
  };
}

function createRunHandler(runtime) {
  return function skillSyncRunHandler(req, res) {
    try {
      const result = runtime.runNow();
      res.json({ ok: true, result });
    } catch (error) {
      if (error && error.code === 'SKILL_SYNC_RUNNING') {
        return res.status(409).json({ ok: false, error: 'sync already running' });
      }
      return res.status(500).json({
        ok: false,
        error: sanitizePublicText(error && error.message, 'skill sync failed'),
      });
    }
  };
}

function mountSkillSyncRoutes(app, runtime) {
  assertRouteDependencies(app, runtime);
  app.get('/api/skill-sync/status', createStatusHandler(runtime));
  app.post('/api/skill-sync/run', createRunHandler(runtime));
}

module.exports = {
  createStatusHandler,
  createRunHandler,
  mountSkillSyncRoutes,
};
