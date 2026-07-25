'use strict';

// ── Restart the whole multicc server (graceful) ──
// A detached child re-launches us after we exit. The route is auth-gated
// (deliberately NOT in the bypass allowlist at the top of server.js), so shared
// view/operate viewers cannot reach it. The child runs `/bin/bash ./multicc
// restart`, whose do_stop sends SIGINT → gracefulShutdown (drains in-flight
// turns + flushes partial chats) before do_start brings up a fresh instance.
// Calling bash explicitly keeps source/archive installs working when the
// manager script lacks +x.
//
// The `_restartScheduled` debounce is deliberately distinct from the host's
// `_shuttingDown`: gracefulShutdown short-circuits on `_shuttingDown`, so
// reusing it here would abort the very shutdown we want. Once a restart is
// scheduled we never reset it on success — the process is about to be replaced.
const { scheduleDetachedRestart } = require('../server-restart');

const RESTART_FLAG_TTL_MS = 30000;

// deps:
//   chatSessions      Map — live chat sessions (read-only here; counts streaming turns)
//   spawn             child_process.spawn (forwarded to scheduleDetachedRestart)
//   rootDir           host package root (server.js __dirname), NOT this module's dir
//   getShuttingDown   () => boolean — lazy read of the host's _shuttingDown let-binding
//   log               console-like sink (defaults to console)
function createServerRestartRoute(deps) {
  const {
    chatSessions,
    spawn,
    rootDir,
    getShuttingDown,
    log = console,
  } = deps;

  // Host process state local to the restart route.
  let _restartScheduled = false;
  let _restartScheduledAt = 0;

  function mountRoutes(app) {
    app.post('/api/restart', (req, res) => {
      // Safety net: detached `/bin/bash ./multicc restart` should replace us
      // within ~2s. If we're still alive after RESTART_FLAG_TTL_MS the
      // replacement failed (stale pidfile / multiple node server.js survivors —
      // do_stop missed the live PID), so reset the flag instead of 409-ing
      // "already in progress" forever.
      if (_restartScheduled && Date.now() - _restartScheduledAt > RESTART_FLAG_TTL_MS) {
        log.log('[multicc] /api/restart: previous restart did not replace this process after ' +
          Math.round((Date.now() - _restartScheduledAt) / 1000) + 's — resetting flag to allow retry');
        _restartScheduled = false;
      }
      if (getShuttingDown() || _restartScheduled) return res.status(409).json({ error: 'restart already in progress' });
      _restartScheduled = true;
      _restartScheduledAt = Date.now();
      // Count sessions with a genuinely in-flight streaming turn (not a stale
      // one) so the client can warn the user those turns will be interrupted —
      // their partial output is flushed to disk by gracefulShutdown before exit.
      let activeStreaming = 0;
      for (const cs of chatSessions.values()) {
        if (cs && cs.isStreaming && (Date.now() - (cs.lastStreamAt || 0)) < 600000) activeStreaming++;
      }
      // Start the detached sleeper before acknowledging the request. The manager
      // and bash preflight plus synchronous spawn must succeed; its two-second
      // delay still gives this response time to flush before it signals us.
      const scheduledAt = _restartScheduledAt;
      try {
        scheduleDetachedRestart({
          spawn,
          rootDir,
          env: process.env,
          log,
          onFailure: (error) => {
            // An old detached attempt must never clear a newer attempt's
            // debounce. If shutdown already began there is no live API process
            // to retry.
            if (!getShuttingDown() && _restartScheduledAt === scheduledAt) {
              _restartScheduled = false;
              _restartScheduledAt = 0;
              log.error('[multicc] /api/restart: scheduling state reset after child failure',
                error && error.code);
            }
          },
        });
      } catch (error) {
        if (_restartScheduledAt === scheduledAt) {
          _restartScheduled = false;
          _restartScheduledAt = 0;
        }
        log.error('[multicc] /api/restart: could not schedule restart', error && error.message);
        const code = error && /^RESTART_[A-Z_]+$/.test(error.code || '')
          ? error.code
          : 'RESTART_SCHEDULE_FAILED';
        return res.status(503).json({
          error: 'restart could not be scheduled',
          code,
          requestId: req.id,
        });
      }

      return res.status(202).json({ ok: true, status: 'scheduled', activeStreaming });
    });
  }

  return { mountRoutes };
}

module.exports = { createServerRestartRoute };
