'use strict';

// HTTP authentication surface: cookie/token login, the auth gate middleware,
// the /api shutdown gate, and the cookie/ws-ticket exchange endpoints.
//
// Extracted verbatim from server.js. Behaviour is preserved exactly; the only
// change is that mutable host state (ACCESS_TOKEN, the shutdown flag) is read
// through getters so a token set at runtime — or a shutdown transition — takes
// effect on the very next request without recapturing a stale snapshot.

// CPR mounts its Anthropic/OpenAI protocol relays at these paths. Only a
// durable, provider-scoped share credential may unlock them remotely.
const PROXY_RELAY_PREFIXES = ['/claude-proxy', '/codex-proxy'];

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`[auth] ${name} must be a function`);
  }
}

function createAuthRuntime(rawDeps) {
  const deps = rawDeps || {};
  const {
    express,
    authSecurity,
    isLocalRequest,
    parseCookies,
    normalizeRedirect,
    escapeHtmlAttribute,
    metrics,
    logger,
    createErrorDto,
    getAccessToken,
    getShuttingDown,
    authorizeProviderRelayRequest = () => null,
    isRequestPeerAllowed = () => true,
    authorizeScopedRequest = () => false,
    allowLegacyTokenQuery = false,
  } = deps;

  if (!express || typeof express.urlencoded !== 'function' || typeof express.json !== 'function') {
    throw new TypeError('[auth] express (with urlencoded/json) is required');
  }
  if (!authSecurity
    || typeof authSecurity.createCookie !== 'function'
    || typeof authSecurity.verifyCookie !== 'function'
    || typeof authSecurity.verifyAccessToken !== 'function'
    || typeof authSecurity.issueWsTicket !== 'function'
    || typeof authSecurity.issueDownloadTicket !== 'function'
    || typeof authSecurity.verifyDownloadTicket !== 'function') {
    throw new TypeError('[auth] authSecurity must expose cookie, access-token, WebSocket-ticket, and download-ticket methods');
  }
  for (const [fn, name] of [
    [isLocalRequest, 'isLocalRequest'], [parseCookies, 'parseCookies'],
    [normalizeRedirect, 'normalizeRedirect'], [escapeHtmlAttribute, 'escapeHtmlAttribute'],
    [createErrorDto, 'createErrorDto'], [getAccessToken, 'getAccessToken'],
    [getShuttingDown, 'getShuttingDown'],
    [authorizeProviderRelayRequest, 'authorizeProviderRelayRequest'],
    [isRequestPeerAllowed, 'isRequestPeerAllowed'], [authorizeScopedRequest, 'authorizeScopedRequest'],
  ]) assertFunction(fn, name);
  if (!metrics || typeof metrics.inc !== 'function') {
    throw new TypeError('[auth] metrics.inc is required');
  }
  if (!logger || typeof logger.warn !== 'function') {
    throw new TypeError('[auth] logger.warn is required');
  }

  function authCookieHeader(req, value = authSecurity.createCookie()) {
    const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    return `multicc_auth=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`;
  }

  function isAuthenticated(req) {
    const accessToken = getAccessToken();
    // 无 token 时只放行真实 loopback transport peer；isLocalRequest 以
    // req.socket.remoteAddress 为权威，并在任何 forwarded/proxy 元数据存在时
    // fail-closed。Host 仍须是 localhost/loopback，不能单独授予本机权限。
    // 外部(含 Tailscale/局域网)一律拒绝,直到本机首次访问设好 ACCESS_TOKEN。
    if (!accessToken) return isLocalRequest(req);
    // Localhost allowed — unless it's a reverse proxy forwarding external traffic
    if (isLocalRequest(req)) return true;
    // Cookie auth (HMAC-signed, survives server restart)
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.multicc_auth && authSecurity.verifyCookie(cookies.multicc_auth)) return true;
    if (authSecurity.verifyAccessToken(req.headers['x-access-token'])) return true;
    if (allowLegacyTokenQuery && authSecurity.verifyAccessToken(req.query.token)) {
      metrics.inc('multicc_auth_legacy_query_total');
      logger.warn('legacy_token_query', { requestId: req.id, path: req.path });
      return true;
    }
    return false;
  }

  // Every share carries a provider-scoped mcr1 credential backed by a durable
  // record. Unscoped legacy/global credentials always fail closed.
  function isProxyRelayCredential(req) {
    const p = req.path;
    if (!PROXY_RELAY_PREFIXES.some(pre => p === pre || p.startsWith(`${pre}/`))) return false;
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    const credential = String(req.headers['x-api-key'] || (bearer && bearer[1]) || '').trim();
    if (!credential) return false;
    let scoped = null;
    try {
      scoped = authorizeProviderRelayRequest({
        credential, method: req.method, pathname: req.path,
      });
    } catch (error) {
      logger.warn('provider_relay_share_auth_failed', {
        requestId: req.id,
        code: typeof error?.code === 'string' ? error.code : 'PERSISTENCE_FAILED',
      });
      return false;
    }
    if (scoped && scoped.ok === true) {
      req.providerRelayShareId = scoped.shareId || null;
      return true;
    }
    return false;
  }

  function mountRoutes(app) {
    // Once shutdown starts, fail every API mutation/request before authentication
    // or route code can enqueue new work. Health/readiness live outside /api and
    // remain available so process managers can observe the transition.
    app.use('/api', (req, res, next) => {
      if (!getShuttingDown()) return next();
      res.set('Retry-After', '1');
      return res.status(503).json(createErrorDto({
        code: 'SERVER_SHUTTING_DOWN',
        message: 'server is shutting down',
        requestId: req.id,
        correlationId: req.correlationId,
      }));
    });

    // An automatic 0.0.0.0 LAN bind must not silently become a direct public
    // listener on a cloud VM or publicly-addressed host. Explicit remote mode
    // can relax this dependency; loopback reverse proxies (including
    // Tailscale Funnel) remain allowed and continue through normal auth.
    app.use((req, res, next) => {
      if (isRequestPeerAllowed(req)) return next();
      metrics.inc('multicc_auth_public_peer_rejected_total');
      return res.status(403).json({ error: 'Forbidden: direct public access is disabled; use Tailscale or an explicit remote bind' });
    });

    // Login page & handler
    app.get('/login', (req, res) => {
      const error = req.query.error ? '<p style="color:#f85149;margin-bottom:16px;">密码错误</p>' : '';
      const redirect = normalizeRedirect(req.query.redirect);
      res.type('html').send(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>MultiCC — Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',system-ui,sans-serif;
    display:flex;align-items:center;justify-content:center;min-height:100vh;min-height:100dvh;
    padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
  .box{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;
    width:min(340px,100%);text-align:center}
  .box h1{font-size:20px;margin-bottom:8px;color:#f0f6fc}
  .box .logo{font-size:24px;font-weight:700;color:#f78166;margin-bottom:24px}
  .box .logo span{color:#79c0ff}
  input[type=password]{width:100%;padding:10px 14px;border-radius:6px;border:1px solid #30363d;
    background:#0d1117;color:#c9d1d9;font-size:16px;min-height:48px;margin-bottom:16px;outline:none}
  input[type=password]:focus{border-color:#58a6ff}
  button{width:100%;padding:10px;border-radius:6px;border:none;background:#238636;
    color:#fff;font-size:16px;font-weight:600;min-height:48px;cursor:pointer}
  button:hover{background:#2ea043}
  @media(max-width:380px){.box{padding:24px 20px}.box .logo{font-size:22px;margin-bottom:20px}}
</style></head><body>
<div class="box">
  <div class="logo">Multi<span>CC</span></div>
  ${error}
  <form method="POST" action="/login">
    <input type="hidden" name="redirect" value="${escapeHtmlAttribute(redirect)}">
    <input type="password" name="password" placeholder="输入访问密码" autofocus>
    <button type="submit">登录</button>
  </form>
</div></body></html>`);
    });

    app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
      const redirect = normalizeRedirect(req.body.redirect);
      if (authSecurity.verifyAccessToken(req.body.password)) {
        res.setHeader('Set-Cookie', authCookieHeader(req));
        res.redirect(redirect);
      } else {
        res.redirect(`/login?error=1&redirect=${encodeURIComponent(redirect)}`);
      }
    });

    app.get('/logout', (req, res) => {
      res.setHeader('Set-Cookie', 'multicc_auth=; Path=/; HttpOnly; Max-Age=0');
      res.redirect('/login');
    });

    // Auth middleware
    app.use((req, res, next) => {
      // Allow login page, static assets
      if (req.path === '/login' || req.path === '/logout') return next();
      if (req.path === '/healthz' || req.path === '/readyz') return next();
      if (!req.path.startsWith('/api/') && /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|json|apk)$/i.test(req.path)) return next();
      // Wait-callback endpoint is secured by its own per-wait token so external
      // (off-box) systems can deliver results without the ACCESS_TOKEN cookie.
      if (req.method === 'POST' && /^\/api\/wait\/[^/]+\/resolve$/.test(req.path)) return next();
      // Share recipient routes: the share page and its scoped API self-gate on the
      // share token (and per-share password), so they bypass ACCESS_TOKEN. NOTE:
      // admin share management lives under /api/sessions/* and stays gated.
      if (/^\/share\/[^/]+$/.test(req.path)) return next();
      if (/^\/api\/share\/[^/]+\/(auth|session)$/.test(req.path)) return next();
      // Fleet import capabilities mirror session shares: only the landing page
      // and the single password-gated capability import endpoint bypass ACCESS_TOKEN.
      // Fleet creation/list/revoke and imported-Fleet management stay gated.
      if (/^\/fleet-share\/fleet_share_[A-Za-z0-9_-]+$/.test(req.path)) return next();
      if (req.method === 'POST'
        && /^\/api\/fleet-shares\/fleet_share_[A-Za-z0-9_-]+\/import$/.test(req.path)) return next();
      if (req.method === 'POST'
        && /^\/api\/fleet-shares\/fleet_share_[A-Za-z0-9_-]+\/ws-ticket$/.test(req.path)) return next();
      // Temp artifacts (multicc-artifact skill): the random <id> in the path is an
      // unguessable capability token, so artifact links open without ACCESS_TOKEN —
      // same model as /share/:token above (keep regex in sync with src/artifacts.js).
      if (/^\/artifacts\/[A-Za-z0-9_-]+(?:\/|$)/.test(req.path)) return next();
      // External viewers cannot attach X-Access-Token. A separately-issued,
      // short-lived capability may open exactly one canonical download target;
      // it grants no access to any other API path.
      if (req.method === 'GET'
        && req.path === '/api/download'
        && authSecurity.verifyDownloadTicket(req.query.download_ticket, req.originalUrl)) return next();
      // Migration bridge for old bookmarked `?token=` document URLs. Only the
      // top-level HTML navigation is accepted; API and WebSocket query auth stay
      // disabled unless the explicit legacy flag above is set. auth-client.js
      // exchanges this for a cookie and immediately removes it from the address.
      if (req.method === 'GET' && !req.path.startsWith('/api/') && authSecurity.verifyAccessToken(req.query.token)) {
        metrics.inc('multicc_auth_bootstrap_query_total');
        logger.warn('bootstrap_token_query', { requestId: req.id, path: req.path });
        res.setHeader('Set-Cookie', authCookieHeader(req));
        return next();
      }
      if (isProxyRelayCredential(req)) {
        metrics.inc('multicc_auth_proxy_relay_total');
        if (req.providerRelayShareId) metrics.inc('multicc_auth_provider_relay_share_total');
        return next();
      }
      try {
        if (authorizeScopedRequest(req)) {
          metrics.inc('multicc_auth_fleet_scope_total');
          return next();
        }
      } catch (_) { /* a scoped authorizer always fails closed */ }
      if (isAuthenticated(req)) return next();
      // Redirect HTML requests to login, reject API calls with 403
      if (req.headers.accept?.includes('text/html') || (!req.path.startsWith('/api/') && req.method === 'GET')) {
        res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
      } else {
        res.status(403).json({ error: 'Forbidden: not authenticated' });
      }
    });

    app.post('/api/auth/exchange', (req, res) => {
      if (!getAccessToken() || !authSecurity.verifyAccessToken(req.headers['x-access-token'])) {
        return res.status(403).json({ error: 'Forbidden: invalid access token' });
      }
      res.setHeader('Set-Cookie', authCookieHeader(req));
      res.status(204).end();
    });

    app.post('/api/auth/ws-ticket', express.json({ limit: '4kb' }), (req, res) => {
      try {
        const issued = authSecurity.issueWsTicket(req.body && req.body.path || '/', {
          correlationId: req.correlationId || req.id,
          requestId: req.id,
        });
        res.set('Cache-Control', 'no-store');
        res.json(issued);
      } catch (_) {
        res.status(400).json({ error: 'invalid WebSocket path' });
      }
    });

    app.post('/api/auth/download-ticket', express.json({ limit: '4kb' }), (req, res) => {
      try {
        const filePath = req.body && req.body.path;
        if (typeof filePath !== 'string' || !filePath) throw new TypeError('invalid path');
        const query = new URLSearchParams({ path: filePath });
        if (req.body.inline === true) query.set('inline', '1');
        const issued = authSecurity.issueDownloadTicket(`/api/download?${query.toString()}`, {
          correlationId: req.correlationId || req.id,
          requestId: req.id,
        });
        res.set('Cache-Control', 'no-store');
        res.json(issued);
      } catch (_) {
        res.status(400).json({ error: 'invalid download target' });
      }
    });
  }

  return { mountRoutes, isAuthenticated, authCookieHeader };
}

module.exports = { createAuthRuntime };
