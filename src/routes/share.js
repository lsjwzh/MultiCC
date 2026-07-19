'use strict';

// HTTP boundary for session and message-snapshot sharing.
//
// The underlying share store owns token generation, password hashing, expiry,
// and scoped access. This module deliberately owns only HTTP presentation and
// route composition. Admin routes are expected to be mounted behind the normal
// MultiCC authentication middleware; recipient routes keep using the share
// token/cookie as their sole authority.

const { sanitizePublicText } = require('../http/public-safety');

const SHARE_COOKIE_MAX_AGE_SECONDS = 7 * 86400;
const CREATE_ERRORS = new Set([
  'invalid share expiry',
  'operate share requires a password',
  'no messages to share',
  'share password is too long',
]);

function assertShareRouteDeps(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('share route dependencies are required');
  }
  const shareMethods = [
    'access',
    'authCookieValue',
    'cookieName',
    'create',
    'createMessageShare',
    'get',
    'listForSession',
    'remove',
    'verifyPassword',
  ];
  for (const name of shareMethods) {
    if (!deps.share || typeof deps.share[name] !== 'function') {
      throw new TypeError(`share route dependency missing: share.${name}`);
    }
  }
  if (!deps.persistedSessions || typeof deps.persistedSessions.get !== 'function') {
    throw new TypeError('share route dependency missing: persistedSessions');
  }
  if (typeof deps.loadChatHistory !== 'function') {
    throw new TypeError('share route dependency missing: loadChatHistory');
  }
  if (typeof deps.parseCookies !== 'function') {
    throw new TypeError('share route dependency missing: parseCookies');
  }
  if (typeof deps.sharePageFile !== 'string' || !deps.sharePageFile.trim()) {
    throw new TypeError('share route dependency missing: sharePageFile');
  }
  return deps;
}

function assertAppMethod(app, method) {
  if (!app || typeof app[method] !== 'function') {
    throw new TypeError(`Express app.${method} is required`);
  }
}

function publicCreateError(error, fallback) {
  const message = error && typeof error.message === 'string' ? error.message.trim() : '';
  if (CREATE_ERRORS.has(message)) return message;
  return sanitizePublicText('', fallback);
}

function isCreateInputError(error) {
  const message = error && typeof error.message === 'string' ? error.message.trim() : '';
  return CREATE_ERRORS.has(message);
}

function requestBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function withShareUrl(req, record) {
  return {
    token: record.token,
    sessionId: record.sessionId,
    access: record.access,
    type: record.type || 'session',
    messageCount: record.messageCount,
    hasPassword: !!record.hasPassword,
    expiresAt: record.expiresAt || null,
    createdAt: record.createdAt,
    label: record.label || null,
    url: `${requestBaseUrl(req)}/share/${record.token}`,
  };
}

function createShareRoutes(rawDeps) {
  const deps = assertShareRouteDeps(rawDeps);
  const share = deps.share;
  const cookieMaxAge = Number.isInteger(deps.cookieMaxAgeSeconds) && deps.cookieMaxAgeSeconds > 0
    ? deps.cookieMaxAgeSeconds
    : SHARE_COOKIE_MAX_AGE_SECONDS;

  function fail(res, status, error) {
    return res.status(status).json({ error });
  }

  function unexpected(res, operation, error) {
    if (deps.logger && typeof deps.logger.error === 'function') {
      // Do not echo the exception message: storage/native errors can contain
      // paths or credentials. The route and error class are enough to correlate.
      deps.logger.error('share_route_failure', {
        operation,
        errorType: error && error.name ? String(error.name).slice(0, 80) : 'Error',
      });
    }
    return fail(res, 500, `${operation} failed`);
  }

  function createSessionShare(req, res) {
    const session = deps.persistedSessions.get(req.params.id);
    if (!session) return fail(res, 404, 'session not found');
    if (session.type === 'aux') return fail(res, 400, 'cannot share system session');
    const body = req.body || {};
    try {
      const record = share.create(session.id, {
        access: body.access,
        password: body.password,
        expiresAt: body.expiresAt,
        label: body.label || session.label || session.id,
      });
      return res.json({ ok: true, ...withShareUrl(req, record) });
    } catch (error) {
      if (isCreateInputError(error)) {
        return fail(res, 400, publicCreateError(error, 'share creation failed'));
      }
      return unexpected(res, 'share creation', error);
    }
  }

  function listSessionShares(req, res) {
    try {
      const records = share.listForSession(req.params.id);
      return res.json({ shares: records.map((record) => withShareUrl(req, record)) });
    } catch (error) {
      return unexpected(res, 'share listing', error);
    }
  }

  function revokeSessionShare(req, res) {
    try {
      const record = share.get(req.params.token);
      if (record && record.sessionId !== req.params.id) {
        return fail(res, 400, 'token does not belong to this session');
      }
      return res.json({ ok: share.remove(req.params.token) });
    } catch (error) {
      return unexpected(res, 'share revoke', error);
    }
  }

  function createMessageShare(req, res) {
    const session = deps.persistedSessions.get(req.params.id);
    if (!session) return fail(res, 404, 'session not found');
    const body = req.body || {};
    let history;
    try {
      history = deps.loadChatHistory(req.params.id);
    } catch (error) {
      return unexpected(res, 'share history read', error);
    }
    const indices = Array.isArray(body.indices) ? body.indices : [];
    const picked = indices.map((index) => history[index]).filter(Boolean);
    if (!picked.length) return fail(res, 400, 'no valid messages selected');
    try {
      const record = share.createMessageShare(session.id, picked, {
        password: body.password,
        expiresAt: body.expiresAt,
        label: body.label || session.label || session.id,
      });
      return res.json({ ok: true, ...withShareUrl(req, record) });
    } catch (error) {
      if (isCreateInputError(error)) {
        return fail(res, 400, publicCreateError(error, 'message share creation failed'));
      }
      return unexpected(res, 'message share creation', error);
    }
  }

  function serveSharePage(req, res) {
    return res.sendFile(deps.sharePageFile);
  }

  function authenticateShare(req, res) {
    const token = req.params.token;
    try {
      const record = share.get(token);
      if (!record) return fail(res, 404, 'share not found or expired');
      if (!share.verifyPassword(token, (req.body || {}).password)) {
        return fail(res, 403, '密码错误');
      }
      res.setHeader(
        'Set-Cookie',
        `${share.cookieName(token)}=${share.authCookieValue(record)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cookieMaxAge}`,
      );
      return res.json({ ok: true, access: record.access });
    } catch (error) {
      return unexpected(res, 'share authentication', error);
    }
  }

  function readSharedSession(req, res) {
    const token = req.params.token;
    try {
      const record = share.get(token);
      if (!record) return fail(res, 404, 'share not found or expired');
      const authority = share.access(token, {
        cookies: deps.parseCookies(req.headers.cookie),
      });
      if (!authority) return res.status(401).json({ needPassword: true });

      if (record.type === 'messages') {
        return res.json({
          access: 'view',
          type: 'messages',
          label: record.label || '消息分享',
          messages: record.messages || [],
        });
      }

      const session = deps.persistedSessions.get(record.sessionId);
      if (!session) return fail(res, 404, 'session no longer exists');
      return res.json({
        access: authority.access,
        type: 'session',
        sessionId: record.sessionId,
        label: session.label || record.sessionId,
        cli: session.cli || 'claude',
        messages: deps.loadChatHistory(record.sessionId),
      });
    } catch (error) {
      return unexpected(res, 'shared session read', error);
    }
  }

  function mountRoutes(app) {
    for (const method of ['get', 'post', 'delete']) assertAppMethod(app, method);
    app.post('/api/sessions/:id/share', createSessionShare);
    app.get('/api/sessions/:id/shares', listSessionShares);
    app.delete('/api/sessions/:id/share/:token', revokeSessionShare);
    app.post('/api/sessions/:id/share-messages', createMessageShare);
    app.get('/share/:token', serveSharePage);
    app.post('/api/share/:token/auth', authenticateShare);
    app.get('/api/share/:token/session', readSharedSession);
  }

  return Object.freeze({
    authenticateShare,
    createMessageShare,
    createSessionShare,
    listSessionShares,
    mountRoutes,
    readSharedSession,
    revokeSessionShare,
    serveSharePage,
  });
}

function mountShareRoutes(app, deps) {
  const routes = createShareRoutes(deps);
  routes.mountRoutes(app);
  return routes;
}

module.exports = {
  SHARE_COOKIE_MAX_AGE_SECONDS,
  assertShareRouteDeps,
  createShareRoutes,
  mountShareRoutes,
  isCreateInputError,
  publicCreateError,
  requestBaseUrl,
  withShareUrl,
};
