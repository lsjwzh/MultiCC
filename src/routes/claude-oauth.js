'use strict';

// Surface for the official Claude OAuth health: a read-only status endpoint
// and a one-click path into an interactive `claude auth login` terminal.
//
// The background refresher (src/claude-oauth-refresh.js) is always tried
// first — it runs the CLI itself so the CLI rewrites its own Keychain entry.
// This surface exists for the states that runtime cannot fix: the refresh
// token itself is dead (`needs-login`) or the CLI ran and still could not
// refresh (`failed`). Both mean a human has to complete the login flow, and
// the login flow is a TUI no headless process can drive — so the POST
// endpoint never runs the login itself, it only opens (or reuses) a
// whitelisted terminal session where a human can.
//
// Once the human finishes, the Keychain holds a *different* valid credential
// than the one the session was opened with. The closer watches for exactly
// that transition and destroys the temporary terminal — the auth TUI exists
// for exactly as long as it is needed and not a turn longer.

const CLAUDE_AUTH_SESSION_ID = 'claude-auth-login';

function createLoginSessionOpener(deps) {
  const { directories, createSessionRecord } = deps;
  return async function openClaudeLoginSession() {
    if (deps.persistedSessionExists && deps.persistedSessionExists(CLAUDE_AUTH_SESSION_ID)) {
      return { ok: true, sessionId: CLAUDE_AUTH_SESSION_ID, reused: true };
    }
    const dirList = typeof directories.values === 'function'
      ? [...directories.values()] : [];
    const dir = dirList.find(d => d && d.path) || dirList[0];
    if (!dir) return { ok: false, error: 'no directory available' };
    const result = await createSessionRecord({
      dir,
      cli: 'claude',
      kind: 'terminal',
      id: CLAUDE_AUTH_SESSION_ID,
      label: 'Claude 登录',
      provider: null, // the official login (Keychain / ~/.claude), never a cc-switch provider
      loginFlow: 'claude-auth-login',
      persistence: 'required',
      persistenceSource: 'runtime.claude-auth-login',
    });
    if (!result || !result.ok) return { ok: false, error: (result && result.error) || 'session create failed' };
    return { ok: true, sessionId: result.id, reused: !!result.reused };
  };
}

// Closes the temporary login terminal once a re-login has actually landed.
// "Landed" is a fact about the credential store, not about the terminal: the
// stored credential is valid now AND differs from the one captured when the
// session was opened. Anything less — same expiry, still expired, entry
// unreadable — leaves the session alone.
function createLoginSessionCloser(deps) {
  const {
    refresher, persistedSessions, directories,
    destroySessionCascade, sessionPersistence, appendEvent,
  } = deps;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  let openedExpiry = null;

  function noteOpened(expiresAt) {
    openedExpiry = Number.isFinite(expiresAt) ? expiresAt : null;
  }

  async function maybeClose(reason) {
    try {
      const persisted = persistedSessions.get(CLAUDE_AUTH_SESSION_ID);
      if (!persisted) return { closed: false, reason: 'no-session' };
      const credentials = await refresher.readCredentials();
      if (!credentials.ok) return { closed: false, reason: 'unreadable' };
      if (!(credentials.expiresAt > now())) return { closed: false, reason: 'still-expired' };
      // openedExpiry is null after a server restart; a valid credential plus a
      // leftover login session then means the login already succeeded (or was
      // never needed), so closing is still the right call.
      if (openedExpiry !== null && credentials.expiresAt === openedExpiry) {
        return { closed: false, reason: 'unchanged-credential' };
      }
      const dir = directories.get(persisted.dirId);
      if (!dir) return { closed: false, reason: 'dir-missing' };
      const result = await destroySessionCascade(persisted, dir, { force: true, removeRecord: false });
      if (!result || !result.ok) return { closed: false, reason: (result && result.error) || 'destroy-failed' };
      sessionPersistence.mutate('runtime.claude-auth-login-close', records => records.delete(CLAUDE_AUTH_SESSION_ID));
      if (typeof appendEvent === 'function') {
        appendEvent(persisted.dirId, 'session_deleted', persisted.label || persisted.id, null);
      }
      openedExpiry = null;
      return { closed: true, reason };
    } catch (error) {
      return { closed: false, reason: 'error', error: error.message };
    }
  }

  return { noteOpened, maybeClose };
}

function mountClaudeOAuthRoutes(app, deps) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('[claude-oauth] Express-compatible app is required');
  }
  if (!deps || typeof deps.getStatus !== 'function') {
    throw new TypeError('[claude-oauth] getStatus is required');
  }
  const openLoginSession = typeof deps.openLoginSession === 'function'
    ? deps.openLoginSession
    : createLoginSessionOpener(deps);
  const readCredentialExpiry = typeof deps.readCredentialExpiry === 'function'
    ? deps.readCredentialExpiry : async () => null;

  app.get('/api/claude/oauth/status', async (req, res) => {
    // A UI poll doubles as the recovery sweep: if a re-login landed between
    // server-side checks, the banner disappears and the TUI closes now rather
    // than at the next timer tick.
    if (deps.closer) await deps.closer.maybeClose('status-poll');
    const status = deps.getStatus() || {};
    const outcome = status.lastOutcome && status.lastOutcome.outcome;
    // `needs-login`: the refresh token is dead — no CLI invocation can help.
    // `failed`: the CLI ran against a dead access token and still could not
    // refresh. Both are facts from a real attempt, which is what keeps a
    // never-logged-in machine (outcome no-credentials) banner-free.
    const needsLogin = outcome === 'needs-login' || outcome === 'failed';
    res.json({
      ok: true,
      enabled: !!status.enabled,
      needsLogin,
      lastOutcome: outcome || null,
      consecutiveFailures: status.consecutiveFailures || 0,
      loginSessionId: typeof deps.persistedSessionExists === 'function'
        && deps.persistedSessionExists(CLAUDE_AUTH_SESSION_ID) ? CLAUDE_AUTH_SESSION_ID : null,
      loginCommand: needsLogin ? 'claude auth login' : null,
    });
  });

  app.post('/api/claude/oauth/login', async (req, res) => {
    try {
      const result = await openLoginSession();
      if (!result || !result.ok) {
        return res.status(500).json({ ok: false, error: (result && result.error) || 'login session unavailable' });
      }
      // Capture the credential the session opens with, so the closer can tell
      // "the user completed a login" apart from "nothing happened yet".
      if (deps.closer) deps.closer.noteOpened(await readCredentialExpiry());
      return res.json({
        ok: true,
        sessionId: result.sessionId,
        reused: !!result.reused,
        hint: '在打开的终端里完成 Claude 登录，登录成功后该终端会自动关闭',
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
  });
}

// One-call composition for the server bootstrap: the closer plus the route
// surface, so server.js needs a single line and the timer a single hook —
// server.js sits exactly at the 3000-line governance budget and cannot grow.
function createClaudeOAuthSurface(deps) {
  const closer = createLoginSessionCloser(deps);
  return Object.freeze({
    closer,
    afterRefresh: reason => closer.maybeClose(reason || 'periodic'),
    mountRoutes(app) {
      mountClaudeOAuthRoutes(app, {
        getStatus: () => deps.refresher.status(),
        directories: deps.directories,
        createSessionRecord: deps.createSessionRecord,
        persistedSessionExists: id => deps.persistedSessions.has(id),
        closer,
        readCredentialExpiry: async () => {
          const credentials = await deps.refresher.readCredentials();
          return credentials.ok ? credentials.expiresAt : null;
        },
      });
    },
  });
}

module.exports = {
  mountClaudeOAuthRoutes,
  createLoginSessionOpener,
  createLoginSessionCloser,
  createClaudeOAuthSurface,
  CLAUDE_AUTH_SESSION_ID,
};
