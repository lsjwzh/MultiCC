'use strict';

// HTTP boundary for session and message-snapshot sharing.
//
// The underlying share store owns token generation, password hashing, expiry,
// and scoped access. This module deliberately owns only HTTP presentation and
// route composition. Admin routes are expected to be mounted behind the normal
// MultiCC authentication middleware; recipient routes keep using the share
// token/cookie as their sole authority.
//
// The recipient page IS the chat page. /share/<token> serves the same document
// the admin uses, and the page's own boot code reads this share's authority
// from /api/share/<token>/entry and narrows itself accordingly. Recipients
// therefore get one renderer to keep current instead of a second, thinner
// conversation UI that drifts from the real one.

const { sanitizePublicText } = require('../http/public-safety');

const SHARE_COOKIE_MAX_AGE_SECONDS = 7 * 86400;
const CREATE_ERRORS = new Set([
  'invalid share expiry',
  'invalid share base url',
  'operate share requires a password',
  'no messages to share',
  'share password is too long',
]);
// Longest origin we will store. A tunnel hostname plus a port is well under
// this; anything larger is not an address someone typed on purpose.
const MAX_PUBLIC_BASE_URL_LENGTH = 2048;

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
  if (typeof deps.paginateChatHistory !== 'function') {
    throw new TypeError('share route dependency missing: paginateChatHistory');
  }
  if (typeof deps.parseCookies !== 'function') {
    throw new TypeError('share route dependency missing: parseCookies');
  }
  // The share page is the chat page, so it is served through the same
  // versioned-HTML writer the rest of public/ uses (cache-busting ?v=<mtime>);
  // a recipient's embedded WebView must not keep a stale renderer.
  if (typeof deps.serveHtml !== 'function') {
    throw new TypeError('share route dependency missing: serveHtml');
  }
  if (typeof deps.chatPageFile !== 'string' || !deps.chatPageFile.trim()) {
    throw new TypeError('share route dependency missing: chatPageFile');
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

// The root the link is built on. Falling back to the request's own Host is
// wrong for anyone reaching MultiCC over a tunnel: the admin's browser is
// usually on 127.0.0.1, so the generated link is dead for the recipient. Create
// may therefore name the root explicitly; only a bare http(s) origin is taken,
// and anything else is rejected rather than silently ignored (a link that
// quietly points at localhost looks like it worked).
//
// Returns null when the field was absent, false when it was present but unusable.
function requestPublicBaseUrl(body) {
  const raw = body && body.publicBaseUrl;
  if (raw == null || raw === '') return null;
  const text = String(raw).trim();
  if (!text || text.length > MAX_PUBLIC_BASE_URL_LENGTH) return false;
  let parsed;
  try { parsed = new URL(text); } catch (_) { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  return parsed.origin;
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
    publicBaseUrl: record.publicBaseUrl || null,
    url: `${record.publicBaseUrl || requestBaseUrl(req)}/share/${record.token}`,
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
    const base = requestPublicBaseUrl(body);
    if (base === false) return fail(res, 400, 'publicBaseUrl must be an http(s) URL');
    try {
      const record = share.create(session.id, {
        access: body.access,
        password: body.password,
        expiresAt: body.expiresAt,
        label: body.label || session.label || session.id,
        ...(base ? { publicBaseUrl: base } : {}),
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
    const base = requestPublicBaseUrl(body);
    if (base === false) return fail(res, 400, 'publicBaseUrl must be an http(s) URL');
    try {
      const record = share.createMessageShare(session.id, picked, {
        password: body.password,
        expiresAt: body.expiresAt,
        label: body.label || session.label || session.id,
        ...(base ? { publicBaseUrl: base } : {}),
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
    return deps.serveHtml(deps.chatPageFile, res);
  }

  // One recipient's authority over one token: the password cookie is the only
  // credential, exactly as the WS router and the read endpoint treat it.
  //
  // Returns { record, authority } when the caller may read, otherwise sends the
  // refusal itself and returns null — every recipient route must refuse in the
  // same two ways (gone vs password-not-given) or the page cannot tell them
  // apart and will ask for a password on a link that no longer exists.
  function openShare(req, res) {
    const record = share.get(req.params.token);
    if (!record) {
      fail(res, 404, 'share not found or expired');
      return null;
    }
    const authority = share.access(req.params.token, {
      cookies: deps.parseCookies(req.headers.cookie),
    });
    if (!authority) {
      res.status(401).json({ needPassword: true });
      return null;
    }
    return { record, authority };
  }

  // What the page needs to boot: who this link is, and how much it may do.
  // Deliberately not the transcript — a session's history arrives over the WS
  // and older pages over /history, so a long session is never downloaded twice.
  // A message snapshot has no live session to fetch from, so that one carries
  // its messages inline.
  function readShareEntry(req, res) {
    try {
      const opened = openShare(req, res);
      if (!opened) return undefined;
      const { record, authority } = opened;
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
        // The name the admin gave this link first (it defaults to the session's
        // own at creation), so a share keeps identifying itself even after the
        // session is renamed — the recipient has no other way to tell which
        // conversation they were handed.
        label: record.label || session.label || record.sessionId,
        cli: session.cli || 'claude',
      });
    } catch (error) {
      return unexpected(res, 'shared entry read', error);
    }
  }

  // Older pages for a shared session, so scrolling up works for a recipient too.
  // Hidden (deleted) messages stay hidden: an admin's own history view may show
  // them behind a flag, but a share is a copy of what the recipient was shown.
  function readSharedHistory(req, res) {
    try {
      const opened = openShare(req, res);
      if (!opened) return undefined;
      const { record } = opened;
      // A snapshot was delivered whole at boot; there is genuinely nothing older.
      if (record.type === 'messages') return res.json({ messages: [], hasMore: false });
      const page = deps.paginateChatHistory(record.sessionId, {
        includeHidden: false,
        before: req.query.before && String(req.query.before),
        around: req.query.around && String(req.query.around),
        limit: req.query.limit && String(req.query.limit),
      });
      const response = { messages: page.messages, hasMore: page.hasMore };
      if (req.query.around) {
        response.found = page.found === true;
        response.hasNewer = page.hasNewer === true;
      }
      return res.json(response);
    } catch (error) {
      return unexpected(res, 'shared history read', error);
    }
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

  // The content read of a share: the whole transcript for a session, the picked
  // messages for a snapshot. Kept for clients that want the content in one
  // request (the App, scripts); the page itself boots from /entry + WS.
  function readSharedSession(req, res) {
    try {
      const opened = openShare(req, res);
      if (!opened) return undefined;
      const { record, authority } = opened;

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
    app.get('/api/share/:token/entry', readShareEntry);
    app.get('/api/share/:token/history', readSharedHistory);
    app.get('/api/share/:token/session', readSharedSession);
  }

  return Object.freeze({
    authenticateShare,
    createMessageShare,
    createSessionShare,
    listSessionShares,
    mountRoutes,
    readShareEntry,
    readSharedHistory,
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
  MAX_PUBLIC_BASE_URL_LENGTH,
  requestBaseUrl,
  requestPublicBaseUrl,
  withShareUrl,
};
