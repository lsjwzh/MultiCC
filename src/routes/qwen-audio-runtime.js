'use strict';

const { requestContext, withApiMeta } = require('../api-contract');

function createQwenAudioRuntimeRoutes({ installer, supervisor, log = console } = {}) {
  if (!installer || typeof installer.status !== 'function' || typeof installer.startInstall !== 'function') {
    throw new TypeError('qwen audio runtime routes require installer');
  }
  if (!supervisor || typeof supervisor.status !== 'function') {
    throw new TypeError('qwen audio runtime routes require supervisor');
  }

  function payload(req, res, body, versioned) {
    return versioned ? withApiMeta(body, requestContext(req, res)) : body;
  }

  function mountRoutes(app) {
    if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
      throw new TypeError('qwen audio runtime routes require an Express-compatible app');
    }

    function getRuntime(req, res, versioned = false) {
      res.set?.('Cache-Control', 'no-store');
      return res.json(payload(req, res, { ok: true, runtime: installer.status() }, versioned));
    }

    function install(req, res, versioned = false) {
      const before = installer.status();
      const runtime = installer.startInstall();
      installer.waitForInstall()
        .then(() => supervisor.reconcileAll())
        .catch(error => {
          try { log.error?.('[multicc/qwen-audio] asynchronous install failed', { error: error?.message }); } catch (_) {}
        });
      res.set?.('Cache-Control', 'no-store');
      res.status(before.installed ? 200 : 202);
      return res.json(payload(req, res, { ok: true, runtime }, versioned));
    }

    // Once the global gateway exists there is only one child, so the legacy
    // per-Fleet runtime endpoints must report *that* child rather than an
    // always-stopped Fleet slot — otherwise an old client shows "未运行" while
    // realtime voice is in fact running.
    function projectsGlobal() {
      return supervisor.hasGlobalGateway?.() === true;
    }

    function getFleetRuntime(req, res, versioned = false) {
      res.set?.('Cache-Control', 'no-store');
      const runtime = projectsGlobal()
        ? { ...supervisor.statusGlobal(), projectedFrom: 'global', requestedDirectoryId: req.params.id }
        : supervisor.status(req.params.id);
      return res.json(payload(req, res, { ok: true, runtime }, versioned));
    }

    async function restartFleet(req, res, next, versioned = false) {
      try {
        const runtime = projectsGlobal()
          ? { ...(await supervisor.restartGlobal()), projectedFrom: 'global', requestedDirectoryId: req.params.id }
          : await supervisor.restart(req.params.id);
        res.set?.('Cache-Control', 'no-store');
        return res.json(payload(req, res, { ok: true, runtime }, versioned));
      } catch (error) {
        if (typeof next === 'function') return next(error);
        return res.status(500).json({ ok: false, error: 'qwen_audio_restart_failed' });
      }
    }

    app.get('/api/voice-runtime', (req, res) => getRuntime(req, res));
    app.get('/api/v1/voice-runtime', (req, res) => getRuntime(req, res, true));
    app.post('/api/voice-runtime/install', (req, res) => install(req, res));
    app.post('/api/v1/voice-runtime/install', (req, res) => install(req, res, true));
    app.get('/api/directories/:id/voice-gateway/runtime', (req, res) => getFleetRuntime(req, res));
    app.get('/api/v1/directories/:id/voice-gateway/runtime', (req, res) => getFleetRuntime(req, res, true));
    app.post('/api/directories/:id/voice-gateway/restart', (req, res, next) => restartFleet(req, res, next));
    app.post('/api/v1/directories/:id/voice-gateway/restart', (req, res, next) => restartFleet(req, res, next, true));
  }

  return Object.freeze({ mountRoutes });
}

module.exports = { createQwenAudioRuntimeRoutes };
