'use strict';

const path = require('node:path');
const { createFleetSharing, FleetSharingError } = require('../fleet-sharing');
const { createErrorDto, requestContext } = require('../api-contract');

const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_PASSWORD_FAILURES = 10;

function requestOrigin(req) {
  const forwarded = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  const protocol = forwarded === 'https' || forwarded === 'http' ? forwarded : req.protocol;
  return `${protocol}://${req.get('host')}`;
}

function createFleetSharingRoutes({ sharing, pageFile, logger, issueWsTicket, now = () => Date.now() } = {}) {
  if (!sharing) throw new TypeError('fleet sharing service is required');
  if (!pageFile) throw new TypeError('fleet share page is required');
  const failures = new Map();

  function sendError(req, res, error, operation) {
    if (error instanceof FleetSharingError) {
      const code = String(error.code || 'FLEET_REQUEST_FAILED');
      const status = Number(error.status) || 400;
      const authFailure = status === 401 || status === 403;
      const remoteFailure = error.category === 'remote' || /REMOTE|EXTERNAL/.test(code);
      const category = error.category || (authFailure ? 'authentication_permission'
        : remoteFailure ? 'remote' : status === 409 ? 'conflict' : 'route');
      const retryable = error.retryable == null
        ? remoteFailure && [408, 425, 429, 500, 502, 503, 504].includes(status)
        : error.retryable;
      const detail = error.upstreamRequestId
        ? `${error.detail || error.message} · upstream requestId ${error.upstreamRequestId}`
        : error.detail || error.message;
      if (error.upstreamRequestId) {
        res.set('X-Multicc-Upstream-Request-Id', error.upstreamRequestId);
      }
      return res.status(status).json(createErrorDto({
        code,
        message: error.message,
        category,
        detail,
        retryable,
        action: error.action || (authFailure ? 'login' : retryable ? 'retry' : 'revise'),
        scope: error.scope || 'request',
        cause: error.causeCode || null,
        upstreamRequestId: error.upstreamRequestId || null,
        httpStatus: status,
        ...requestContext(req, res),
      }));
    }
    if (logger && typeof logger.error === 'function') {
      logger.error('fleet_sharing_failure', {
        operation,
        errorType: error && error.name ? String(error.name).slice(0, 80) : 'Error',
      });
    }
    return res.status(500).json(createErrorDto({
      code: 'INTERNAL_ERROR',
      message: 'Fleet 分享操作失败',
      category: 'internal',
      detail: 'Fleet 分享操作失败',
      retryable: false,
      action: 'copy_details',
      scope: 'request',
      httpStatus: 500,
      ...requestContext(req, res),
    }));
  }

  const wrap = (operation, handler) => (req, res) => Promise.resolve().then(() => handler(req, res))
    .catch(error => sendError(req, res, error, operation));

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
        return res.status(429).json(createErrorDto({
          code: 'SHARE_RATE_LIMITED',
          message: '尝试过于频繁，请稍后再试',
          category: 'rate_limit',
          detail: '尝试过于频繁，请稍后再试',
          retryable: true,
          action: 'retry_later',
          scope: 'request',
          httpStatus: 429,
          ...requestContext(req, res),
        }));
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

    readSharedFleet: wrap('shared-state', (req, res) => {
      const payload = sharing.readSharedFleet(req.params.token, req.headers['x-multicc-fleet-grant']);
      res.set('Cache-Control', 'no-store');
      return res.json(payload);
    }),

    issueSharedWsTicket: wrap('shared-ws-ticket', (req, res) => {
      if (typeof issueWsTicket !== 'function') {
        return res.status(501).json(createErrorDto({
          code: 'WS_TICKET_UNAVAILABLE',
          message: 'WebSocket 凭证服务不可用',
          category: 'runtime',
          detail: 'WebSocket 凭证服务不可用',
          retryable: false,
          action: 'restart',
          scope: 'host',
          httpStatus: 501,
          ...requestContext(req, res),
        }));
      }
      const body = req.body || {};
      const authorized = sharing.authorizeWebSocket({
        token: req.params.token,
        grant: req.headers['x-multicc-fleet-grant'],
        pathname: body.pathname,
        sessionId: body.sessionId,
        directoryId: body.directoryId,
      });
      if (!authorized) return res.status(403).json(createErrorDto({
        code: 'FLEET_SCOPE_FORBIDDEN',
        message: 'Fleet 授权无效',
        category: 'authentication_permission',
        detail: 'Fleet 授权无效',
        retryable: false,
        action: 'login',
        scope: 'session',
        httpStatus: 403,
        ...requestContext(req, res),
      }));
      const metadata = body.sessionId
        ? { fleetSessionId: body.sessionId }
        : { fleetDirectoryId: body.directoryId };
      const issued = issueWsTicket(body.pathname, metadata);
      const origin = requestOrigin(req);
      return res.json({ ...issued, wsOrigin: origin.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') });
    }),

    importExternal: wrap('import', async (req, res) => {
      const record = await sharing.importExternal(req.body || {}, {
        requestId: req.id,
        correlationId: req.correlationId || req.id,
      });
      return res.json({ ok: true, fleet: record });
    }),

    listExternal: wrap('external-list', (_req, res) => res.json({
      fleets: sharing.listExternal(),
    })),

    removeExternal: wrap('external-remove', (req, res) => res.json({
      ok: sharing.removeExternal(req.params.id),
    })),

    refreshExternal: wrap('external-refresh', async (req, res) => res.json({
      ok: true,
      fleet: await sharing.refreshExternal(req.params.id, {
        requestId: req.id,
        correlationId: req.correlationId || req.id,
      }),
    })),

    proxyExternal: wrap('external-proxy', async (req, res) => {
      const queryAt = String(req.originalUrl || '').indexOf('?');
      const query = queryAt >= 0 ? String(req.originalUrl).slice(queryAt) : '';
      const pathname = `/${String(req.params[0] || '').replace(/^\/+/, '')}${query}`;
      const method = String(req.method || 'GET').toUpperCase();
      if (method === 'GET' && (pathname === '/api/sessions' || pathname.startsWith('/api/sessions?'))) {
        const authority = sharing.externalAuthority(req.params.id);
        return res.json(authority.sessions.map(session => ({ ...session, dirId: authority.sourceFleetId })));
      }
      if (method === 'GET' && (pathname === '/api/directories' || pathname.startsWith('/api/directories?'))) {
        const authority = sharing.externalAuthority(req.params.id);
        return res.json([{
          id: authority.sourceFleetId,
          name: authority.name,
          path: authority.sourceOrigin,
          external: true,
        }]);
      }
      const contentType = String(req.get('content-type') || '');
      const body = ['GET', 'HEAD'].includes(method)
        ? undefined
        : contentType.includes('application/json') ? JSON.stringify(req.body || {}) : (req.body || req);
      const remote = await sharing.proxyExternal(req.params.id, {
        method,
        pathname,
        headers: {
          accept: req.get('accept'),
          'content-type': contentType,
          'x-correlation-id': req.correlationId || req.id,
        },
        body,
      });
      if (remote.contentType) res.set('Content-Type', remote.contentType);
      if (remote.cacheControl) res.set('Cache-Control', remote.cacheControl);
      if (remote.upstreamRequestId) res.set('X-Multicc-Upstream-Request-Id', remote.upstreamRequestId);
      return res.status(remote.status).send(remote.body);
    }),

    issueExternalWsTicket: wrap('external-ws-ticket', async (req, res) => {
      const issued = await sharing.issueExternalWsTicket(req.params.id, req.body || {}, {
        requestId: req.id,
        correlationId: req.correlationId || req.id,
      });
      res.set('Cache-Control', 'no-store');
      return res.json(issued);
    }),
  };

  function mount(app) {
    app.post('/api/fleets/:id/share', handlers.createShare);
    app.get('/api/fleets/:id/shares', handlers.listShares);
    app.delete('/api/fleets/:id/share/:token', handlers.revokeShare);
    app.get('/fleet-share/:token', handlers.servePage);
    app.post('/api/fleet-shares/:token/import', handlers.accessShare);
    app.get('/api/fleet-shares/:token/state', handlers.readSharedFleet);
    app.post('/api/fleet-shares/:token/ws-ticket', handlers.issueSharedWsTicket);
    app.post('/api/external-fleets/import', handlers.importExternal);
    app.get('/api/external-fleets', handlers.listExternal);
    app.delete('/api/external-fleets/:id', handlers.removeExternal);
    app.post('/api/external-fleets/:id/refresh', handlers.refreshExternal);
    app.post('/api/external-fleets/:id/ws-ticket', handlers.issueExternalWsTicket);
    app.all('/api/external-fleets/:id/remote/*', handlers.proxyExternal);
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
  issueWsTicket,
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
  const routes = createFleetSharingRoutes({ sharing, pageFile, logger, issueWsTicket });
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
