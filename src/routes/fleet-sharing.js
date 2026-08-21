'use strict';

const path = require('node:path');
const { createFleetSharing, FleetSharingError } = require('../fleet-sharing');

const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_PASSWORD_FAILURES = 10;

function requestOrigin(req) {
  const forwarded = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  const protocol = forwarded === 'https' || forwarded === 'http' ? forwarded : req.protocol;
  return `${protocol}://${req.get('host')}`;
}

function createFleetSharingRoutes({ sharing, pageFile, logger, now = () => Date.now() } = {}) {
  if (!sharing) throw new TypeError('fleet sharing service is required');
  if (!pageFile) throw new TypeError('fleet share page is required');
  const failures = new Map();

  function sendError(res, error, operation) {
    if (error instanceof FleetSharingError) {
      return res.status(error.status).json({ code: error.code, error: error.message });
    }
    if (logger && typeof logger.error === 'function') {
      logger.error('fleet_sharing_failure', {
        operation,
        errorType: error && error.name ? String(error.name).slice(0, 80) : 'Error',
      });
    }
    return res.status(500).json({ code: 'INTERNAL_ERROR', error: 'Fleet 分享操作失败' });
  }

  const wrap = (operation, handler) => (req, res) => Promise.resolve().then(() => handler(req, res))
    .catch(error => sendError(res, error, operation));

  function failedAttemptKey(req) {
    return `${req.params.token}:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
  }

  function isRateLimited(key) {
    const entry = failures.get(key);
    if (!entry) return false;
    if (now() - entry.startedAt > FAILURE_WINDOW_MS) {
      failures.delete(key);
      return false;
    }
    return entry.count >= MAX_PASSWORD_FAILURES;
  }

  function recordPasswordFailure(key) {
    const entry = failures.get(key);
    if (!entry || now() - entry.startedAt > FAILURE_WINDOW_MS) {
      failures.set(key, { count: 1, startedAt: now() });
    } else {
      entry.count += 1;
    }
  }

  const handlers = {
    createShare: wrap('create', (req, res) => {
      const record = sharing.createShare(req.params.id, req.body || {});
      return res.json({
        ok: true,
        ...record,
        url: `${requestOrigin(req)}/fleet-share/${record.token}`,
      });
    }),

    listShares: wrap('list', (req, res) => res.json({
      shares: sharing.listShares(req.params.id).map(record => ({
        ...record,
        url: `${requestOrigin(req)}/fleet-share/${record.token}`,
      })),
    })),

    revokeShare: wrap('revoke', (req, res) => res.json({
      ok: sharing.revokeShare(req.params.id, req.params.token),
    })),

    servePage: (_req, res) => res.sendFile(pageFile),

    accessShare: wrap('access', (req, res) => {
      const key = failedAttemptKey(req);
      if (isRateLimited(key)) {
        return res.status(429).json({ code: 'SHARE_RATE_LIMITED', error: '尝试过于频繁，请稍后再试' });
      }
      try {
        const payload = sharing.accessSharedFleet(req.params.token, (req.body || {}).password);
        failures.delete(key);
        res.set('Cache-Control', 'no-store');
        return res.json(payload);
      } catch (error) {
        if (error instanceof FleetSharingError && error.code === 'WRONG_PASSWORD') {
          recordPasswordFailure(key);
        }
        throw error;
      }
    }),

    importExternal: wrap('import', async (req, res) => {
      const record = await sharing.importExternal(req.body || {});
      return res.json({ ok: true, fleet: record });
    }),

    listExternal: wrap('external-list', (_req, res) => res.json({
      fleets: sharing.listExternal(),
    })),

    removeExternal: wrap('external-remove', (req, res) => res.json({
      ok: sharing.removeExternal(req.params.id),
    })),
  };

  function mount(app) {
    app.post('/api/fleets/:id/share', handlers.createShare);
    app.get('/api/fleets/:id/shares', handlers.listShares);
    app.delete('/api/fleets/:id/share/:token', handlers.revokeShare);
    app.get('/fleet-share/:token', handlers.servePage);
    app.post('/api/fleet-shares/:token/import', handlers.accessShare);
    app.post('/api/external-fleets/import', handlers.importExternal);
    app.get('/api/external-fleets', handlers.listExternal);
    app.delete('/api/external-fleets/:id', handlers.removeExternal);
    return handlers;
  }

  return Object.freeze({ handlers, mount });
}

function mountFleetSharingRoutes(app, {
  paths,
  directories,
  sessions,
  pageFile = path.join(__dirname, '..', '..', 'public', 'fleet-share.html'),
  logger,
  ...serviceOptions
} = {}) {
  if (!paths || !paths.fleetSharesFile || !paths.externalFleetsFile) {
    throw new TypeError('fleet sharing paths are required');
  }
  const sharing = createFleetSharing({
    sharesFile: paths.fleetSharesFile,
    externalFleetsFile: paths.externalFleetsFile,
    getDirectory: id => directories.get(id),
    listSessions: id => [...sessions.values()].filter(session => session.dirId === id && session.type !== 'aux'),
    ...serviceOptions,
  });
  const routes = createFleetSharingRoutes({ sharing, pageFile, logger });
  routes.mount(app);
  return Object.freeze({ sharing, routes });
}

module.exports = {
  FAILURE_WINDOW_MS,
  MAX_PASSWORD_FAILURES,
  createFleetSharingRoutes,
  mountFleetSharingRoutes,
  requestOrigin,
};
