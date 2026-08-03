'use strict';

// Surface for the codex ChatGPT OAuth health: a read-only status endpoint and
// a one-click path into an interactive `codex login`. The login itself is a
// browser OAuth flow that no non-interactive process can complete (every
// multicc codex turn is a fresh `codex exec`), so the POST endpoint never
// runs the login itself — it only opens (or reuses) a terminal session where
// a human can complete it. Once `codex login` rewrites ~/.codex/auth.json,
// the refresher's re-read self-heals the needs_login state.

const CODEX_LOGIN_SESSION_ID = 'codex-login';

function createLoginSessionOpener(deps) {
  const { directories, createSessionRecord } = deps;
  return async function openCodexLoginSession() {
    if (deps.persistedSessionExists && deps.persistedSessionExists(CODEX_LOGIN_SESSION_ID)) {
      return { ok: true, sessionId: CODEX_LOGIN_SESSION_ID, reused: true };
    }
    const dirList = typeof directories.values === 'function'
      ? [...directories.values()] : [];
    const dir = dirList.find(d => d && d.path) || dirList[0];
    if (!dir) return { ok: false, error: 'no directory available' };
    const result = await createSessionRecord({
      dir,
      cli: 'codex',
      kind: 'terminal',
      id: CODEX_LOGIN_SESSION_ID,
      label: 'Codex 登录',
      provider: null, // the shared default login (~/.codex/auth.json), never a cc-switch home
      loginFlow: 'codex-login',
      persistence: 'required',
      persistenceSource: 'runtime.codex-login',
    });
    if (!result || !result.ok) return { ok: false, error: (result && result.error) || 'session create failed' };
    return { ok: true, sessionId: result.id, reused: !!result.reused };
  };
}

function mountCodexOAuthRoutes(app, deps) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('[codex-oauth] Express-compatible app is required');
  }
  if (!deps || typeof deps.getStatus !== 'function') {
    throw new TypeError('[codex-oauth] getStatus is required');
  }
  const openLoginSession = typeof deps.openLoginSession === 'function'
    ? deps.openLoginSession
    : createLoginSessionOpener(deps);

  app.get('/api/codex/oauth/status', (req, res) => {
    const status = deps.getStatus() || {};
    const needsLogin = !!status.needsLogin;
    res.json({
      ok: true,
      enabled: !!status.enabled,
      needsLogin,
      needsLoginSince: status.needsLogin ? status.needsLogin.since : null,
      lastOutcome: status.lastOutcome ? status.lastOutcome.outcome || null : null,
      consecutiveFailures: status.consecutiveFailures || 0,
      retryAfter: status.retryAfter || null,
      loginCommand: needsLogin ? 'codex login' : null,
    });
  });

  app.post('/api/codex/oauth/login', async (req, res) => {
    try {
      const result = await openLoginSession();
      if (!result || !result.ok) {
        return res.status(500).json({ ok: false, error: (result && result.error) || 'login session unavailable' });
      }
      return res.json({
        ok: true,
        sessionId: result.sessionId,
        reused: !!result.reused,
        hint: '在打开的终端里完成浏览器登录，登录后 multicc 会自动恢复',
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
  });
}

module.exports = { mountCodexOAuthRoutes, createLoginSessionOpener, CODEX_LOGIN_SESSION_ID };
