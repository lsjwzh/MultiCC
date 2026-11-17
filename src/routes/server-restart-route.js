'use strict';

// ── Restart the whole multicc server (graceful) ──
// A detached child re-launches us after we exit. The route is auth-gated
// (deliberately NOT in the bypass allowlist at the top of server.js), so shared
// view/operate viewers cannot reach it. The generated script runs ./multicc restart
// (bash fallback without +x), whose do_stop sends SIGINT → gracefulShutdown (drains in-flight
// turns + flushes partial chats) before do_start brings up a fresh instance.
// Calling bash explicitly keeps source/archive installs working when the
// manager script lacks +x.
//
// The `_restartScheduled` debounce is deliberately distinct from the host's
// `_shuttingDown`: gracefulShutdown short-circuits on `_shuttingDown`, so
// reusing it here would abort the very shutdown we want. Once a restart is
// scheduled we never reset it on success — the process is about to be replaced.
const { scheduleRustRestart } = require('../server-restart');

const RESTART_FLAG_TTL_MS = 90000;

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
    dataDir = rootDir,
    getPort = () => Number(process.env.PORT),
    getHost = () => '127.0.0.1',
    scheduleRestart = scheduleRustRestart,
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
      // Leave enough time for the script's 2s delay and 65s graceful drain.
      // If this process is still alive after that window, permit a retry;
      // the manager also serializes restart attempts across duplicate servers.
      if (_restartScheduled && Date.now() - _restartScheduledAt > RESTART_FLAG_TTL_MS) {
        log.log('[multicc] /api/restart: previous restart did not replace this process after ' +
          Math.round((Date.now() - _restartScheduledAt) / 1000) + 's — resetting flag to allow retry');
        _restartScheduled = false;
      }
      if (getShuttingDown() || _restartScheduled) return res.status(409).json({ error: 'restart already in progress' });
      const requested = req.body && req.body.port;
      if (requested !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > 65535)) {
        return res.status(400).json({ error: 'invalid restart port', code: 'RESTART_PORT_INVALID' });
      }
      if (req.body && req.body.expectedPid !== undefined && req.body.expectedPid !== process.ppid) {
        return res.status(409).json({ error: 'gateway identity changed', code: 'RESTART_IDENTITY_CHANGED' });
      }
      // Count sessions with a genuinely in-flight streaming turn (not a stale
      // one) so the client can warn the user those turns will be interrupted —
      // their partial output is flushed to disk by gracefulShutdown before exit.
      let activeStreaming = 0;
      for (const cs of chatSessions.values()) {
        if (cs && cs.isStreaming && (Date.now() - (cs.lastStreamAt || 0)) < 600000) activeStreaming++;
      }
      if (typeof desktopExit !== 'function') return res.status(503).json({ error: 'restart shutdown is not wired', code: 'RESTART_UNWIRED' });
      _restartScheduled = true;
      _restartScheduledAt = Date.now();
      const scheduledAt = _restartScheduledAt;
      try {
        const pending = scheduleRestart({ spawn, rootDir, dataDir, port: getPort(), targetPort: requested ?? getPort(), host: getHost(), env: process.env });
        pending.then(({ mode, generation, supervisorPid }) => {
          res.status(202).json({ ok: true, status: 'scheduled', activeStreaming, mode, restartId: generation, supervisorPid });
          setTimeout(() => { try { desktopExit('restart'); } catch (error) {
            log.error('[multicc] /api/restart: shutdown failed', error && error.message);
          } }, 250);
        }).catch(error => {
          if (_restartScheduledAt === scheduledAt) { _restartScheduled = false; _restartScheduledAt = 0; }
          log.error('[multicc] /api/restart: could not schedule restart', error && error.message);
          res.status(503).json({ error: 'restart could not be scheduled', code: 'RESTART_SCHEDULE_FAILED', requestId: req.id });
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

      return undefined;
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
