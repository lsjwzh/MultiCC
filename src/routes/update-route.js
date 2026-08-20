'use strict';

// ── One-click update from the web UI ──
// POST /api/update        starts `./multicc update [--force]` in a detached child
// GET  /api/update/status reads the run's state back off disk
//
// The route is auth-gated (deliberately NOT in the bypass allowlist at the top
// of server.js), so shared view/operate viewers cannot trigger an update.
//
// Concurrency is guarded twice on purpose. The on-disk log is the durable
// answer, but it does not exist yet in the second between spawning and the
// child's first write — `_updateScheduled` covers exactly that window, and
// expires so a child that died before writing anything cannot 409 forever.
const { startDetachedUpdate, readUpdateStatus } = require('../update-runner');

const UPDATE_FLAG_TTL_MS = 20000;

// deps:
//   chatSessions      Map — live chat sessions (read-only; counts streaming turns)
//   spawn             child_process.spawn (forwarded to startDetachedUpdate)
//   rootDir           host package root (server.js __dirname), NOT this module's dir
//   getShuttingDown   () => boolean — lazy read of the host's _shuttingDown let-binding
//   getApkBuildStatus () => object — blocks checkout mutation while Flutter reads sources
//   log               console-like sink (defaults to console)
function createUpdateRoute(deps) {
  const {
    chatSessions,
    spawn,
    rootDir,
    getShuttingDown = () => false,
    getApkBuildStatus = () => ({ state: 'idle' }),
    log = console,
    now = Date.now,
  } = deps || {};
  if (typeof spawn !== 'function') throw new TypeError('update route requires spawn');
  if (!rootDir) throw new TypeError('update route requires rootDir');

  let _updateScheduled = false;
  let _updateScheduledAt = 0;

  function expireScheduledFlag() {
    if (_updateScheduled && now() - _updateScheduledAt > UPDATE_FLAG_TTL_MS) {
      _updateScheduled = false;
      _updateScheduledAt = 0;
    }
  }

  function statusNow() {
    try {
      return readUpdateStatus({ rootDir, now });
    } catch (error) {
      log.error('[multicc] /api/update/status: could not read update state', error && error.message);
      return { state: 'unknown', running: false, exitCode: null, tail: '' };
    }
  }

  function admissionStatus() {
    expireScheduledFlag();
    const current = statusNow();
    if (_updateScheduled && !current.running) {
      return {
        ...current,
        state: 'scheduled',
        running: true,
        scheduled: true,
        startedAt: new Date(_updateScheduledAt).toISOString(),
      };
    }
    return { ...current, scheduled: false };
  }

  function mountRoutes(app) {
    app.get('/api/update/status', (req, res) => {
      res.json(admissionStatus());
    });

    app.post('/api/update', (req, res) => {
      expireScheduledFlag();
      if (getShuttingDown()) return res.status(409).json({ error: 'server is shutting down' });
      const current = statusNow();
      if (_updateScheduled || current.running) {
        return res.status(409).json({ error: 'update already in progress', status: current });
      }
      let apkBuild;
      try { apkBuild = getApkBuildStatus(); } catch (_) {
        return res.status(503).json({ error: 'apk build status unavailable', code: 'APK_BUILD_STATUS_UNAVAILABLE' });
      }
      if (apkBuild && apkBuild.state === 'running') {
        return res.status(409).json({ error: 'apk build in progress', code: 'APK_BUILD_IN_PROGRESS', status: apkBuild });
      }
      if (apkBuild && apkBuild.state === 'unknown') {
        return res.status(503).json({ error: 'apk build status unavailable', code: 'APK_BUILD_STATUS_UNAVAILABLE' });
      }

      const force = Boolean(req.body && (req.body.force === true || req.body.force === 'true' || req.body.force === 1));
      _updateScheduled = true;
      _updateScheduledAt = now();
      const scheduledAt = _updateScheduledAt;

      // The client is told how many turns the restart at the end of the update
      // will interrupt, using the same definition as /api/restart: streaming,
      // and not stale for more than ten minutes.
      let activeStreaming = 0;
      const sessions = chatSessions && typeof chatSessions.values === 'function' ? chatSessions.values() : [];
      for (const cs of sessions) {
        if (cs && cs.isStreaming && (now() - (cs.lastStreamAt || 0)) < 600000) activeStreaming++;
      }

      try {
        startDetachedUpdate({
          spawn,
          rootDir,
          force,
          env: process.env,
          log,
          onFailure: (error) => {
            // An older attempt's child must never clear a newer attempt's flag.
            if (_updateScheduledAt === scheduledAt) {
              _updateScheduled = false;
              _updateScheduledAt = 0;
              log.error('[multicc] /api/update: scheduling state reset after child failure', error && error.code);
            }
          },
        });
      } catch (error) {
        if (_updateScheduledAt === scheduledAt) {
          _updateScheduled = false;
          _updateScheduledAt = 0;
        }
        log.error('[multicc] /api/update: could not start update', error && error.message);
        const code = error && /^UPDATE_[A-Z_]+$/.test(error.code || '') ? error.code : 'UPDATE_START_FAILED';
        return res.status(503).json({
          error: 'update could not be started',
          code,
          requestId: req.id,
        });
      }

      return res.status(202).json({ ok: true, status: 'started', force, activeStreaming });
    });
  }

  return {
    mountRoutes,
    status() {
      return admissionStatus();
    },
  };
}

module.exports = { createUpdateRoute, UPDATE_FLAG_TTL_MS };
