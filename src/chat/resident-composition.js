'use strict';

// Composition for the resident pool: the host's own liveness sources, wired to
// the capacity policy in resident-pool.js. Extracted from server.js so the host
// stays under its line budget; the policy and its reasons live in that module.

const { createResidentPool } = require('./resident-pool');

function createResidentPoolComposition(deps) {
  const { chatStream, backgroundTaskRuntime, getWorkspaceAdmission, sessionWorkHost, logger } = deps;
  return createResidentPool({
    residents: () => chatStream.residents(),
    // A request, never a kill: the lane decides whether it can be placed now or
    // only at the next turn boundary (stream-router → backend recycle).
    reclaim: (id, reason) => chatStream.recycle(id, reason),
    // What still delivers through this child. Two blockers hibernation refuses on
    // are deliberately absent here: a pending wait and a repo lease. Neither one
    // needs a warm child — the next delivery re-ensures one and resumes the native
    // conversation — so blocking on them would keep the pool full without
    // protecting anything that a respawn could lose.
    blocked: id => {
      if ((backgroundTaskRuntime.hasProcessBackgroundTasks || backgroundTaskRuntime.hasLiveBackgroundTasks)(id)) return 'background_task';
      try { if (getWorkspaceAdmission()?.hasActiveLease?.(id)) return 'workspace_lease'; }
      catch (_) { return 'workspace_lease_unknown'; }
      if (sessionWorkHost?.isRunActive?.(id)) return 'running_task';
      return null;
    },
    limit: process.env.MULTICC_RESIDENT_LIMIT,
    sweepMs: process.env.MULTICC_RESIDENT_SWEEP_MS,
    onEvent: event => logger.info('resident_pool', event),
    logger,
  });
}

module.exports = { createResidentPoolComposition };
