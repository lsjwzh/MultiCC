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
//   isDesktopMode     () => boolean — true when running under the desktop shell
//                     (MULTICC_DESKTOP=1). The supervisor owns the process
//                     lifecycle there, so the detached bash re-launcher stays
//                     out of it: we exit gracefully and it respawns us.
//   desktopExit       (reason) => void — desktop-only graceful exit (wired to
//                     host gracefulShutdown lazily); used for supervisor
//                     respawn and for the desktop-shutdown drain on app quit
function createServerRestartRoute(deps) {
  const {
    chatSessions,
    spawn,
    rootDir,
    getShuttingDown,
    log = console,
    isDesktopMode = () => /^(1|true|yes|on)$/i.test(String(process.env.MULTICC_DESKTOP || '').trim()),
    desktopExit,
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
      // Count sessions with a genuinely in-flight streaming turn (not a stale
      // one) so the client can warn the user those turns will be interrupted —
      // their partial output is flushed to disk by gracefulShutdown before exit.
      let activeStreaming = 0;
      for (const cs of chatSessions.values()) {
        if (cs && cs.isStreaming && (Date.now() - (cs.lastStreamAt || 0)) < 600000) activeStreaming++;
      }
      // Desktop shell: the supervisor (not a detached bash manager) owns this
      // process. Schedule nothing; exit gracefully right after replying and let
      // it spawn a fresh instance against the same data dir and port.
      if (isDesktopMode()) {
        if (typeof desktopExit !== 'function') {
          return res.status(503).json({ error: 'desktop restart is not wired', code: 'DESKTOP_RESTART_UNWIRED' });
        }
        _restartScheduled = true;
        _restartScheduledAt = Date.now();
        log.log('[multicc] /api/restart: desktop mode — exiting for supervisor respawn');
        setImmediate(() => { try { desktopExit('desktop-restart'); } catch (error) {
          log.error('[multicc] /api/restart: desktop exit failed', error && error.message);
        } });
        return res.status(202).json({ ok: true, status: 'scheduled', activeStreaming, mode: 'desktop-supervised' });
      }
      _restartScheduled = true;
      _restartScheduledAt = Date.now();
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

    // Desktop-only clean-stop endpoint. The supervisor calls it on app quit so
    // the server drains in-flight turns (gracefulShutdown) even on Windows,
    // where a SIGINT cannot be delivered to a child. It is a 404 — not an
    // auth-weakened stub — for every non-desktop install, and stays out of the
    // auth bypass allowlist like /api/restart above.
    app.post('/api/desktop-shutdown', (req, res) => {
      if (!isDesktopMode() || typeof desktopExit !== 'function') {
        return res.status(404).json({ error: 'not found', requestId: req.id });
      }
      if (getShuttingDown()) return res.status(409).json({ error: 'shutdown already in progress' });
      log.log('[multicc] /api/desktop-shutdown: desktop mode — graceful shutdown requested');
      setImmediate(() => { try { desktopExit('desktop-shutdown'); } catch (error) {
        log.error('[multicc] /api/desktop-shutdown: shutdown failed', error && error.message);
      } });
      return res.status(202).json({ ok: true, status: 'shutting-down' });
    });
  }

  return { mountRoutes };
}

module.exports = { createServerRestartRoute };
