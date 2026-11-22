'use strict';

// Signing in to agy is the vendor's own interactive TUI — there is no `agy
// login` subcommand — and the PTY lives in Node. So this one route stays in
// Node while the rest of `/api/agy/accounts*` (list/create/import/activate/
// delete) is served by the Rust front door. Both sides touch the same on-disk
// layout: src/agy-accounts.js and native/core/src/agy_accounts.rs.
//
// The login terminal gets `HOME=<id>.home`, so the OAuth flow writes THAT
// account's `~/.gemini` and never the machine's own login. The env pin is
// allowlisted by sanitizeLoginEnv (src/official-accounts.js) and applied when
// the tmux session is created (server.js → tmuxCreateSession `-e`).

const fs = require('node:fs');
const os = require('node:os');

const { accountHome, metaFile } = require('../agy-accounts');

const AGY_LOGIN_FLOW = 'agy-login';
const AGY_LOGIN_SESSION_ID = 'agy-login';
const LOGIN_LABEL = '反重力登录';

function mountAgyAccountRoutes(app, rawDeps) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[agy-accounts] Express-compatible app is required');
  }
  const deps = rawDeps || {};
  const { directories, createSessionRecord } = deps;
  if (typeof createSessionRecord !== 'function') {
    throw new TypeError('[agy-accounts] createSessionRecord is required');
  }
  const asyncHandler = typeof deps.asyncHandler === 'function' ? deps.asyncHandler : fn => fn;
  const disposeLoginTerminal = typeof deps.disposeLoginTerminal === 'function'
    ? deps.disposeLoginTerminal : async () => 0;
  const homeDir = typeof deps.homeDir === 'function'
    ? deps.homeDir : () => process.env.HOME || os.homedir();

  // One login terminal at a time: it is a human-driven OAuth flow, and a second
  // click must show a fresh prompt rather than replay a finished one.
  app.post('/api/agy/accounts/:id/login-terminal', asyncHandler(async (req, res) => {
    const id = String((req.params && req.params.id) || '');
    const home = homeDir();
    const meta = home ? metaFile(home, id) : null;
    if (!meta) return res.status(400).json({ error: 'invalid account id' });
    if (!fs.existsSync(meta)) return res.status(404).json({ error: 'unknown account' });
    const accountDir = accountHome(home, id);
    if (!accountDir) return res.status(400).json({ error: 'invalid account id' });
    fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 });

    const dirList = typeof directories.values === 'function' ? [...directories.values()] : [];
    const dir = dirList.find(item => item && item.path) || dirList[0];
    if (!dir) return res.status(500).json({ error: 'no directory available' });

    await disposeLoginTerminal(AGY_LOGIN_FLOW);
    const result = await createSessionRecord({
      dir,
      cli: 'agy',
      kind: 'terminal',
      id: AGY_LOGIN_SESSION_ID,
      label: LOGIN_LABEL,
      loginFlow: AGY_LOGIN_FLOW,
      loginEnv: { HOME: accountDir },
      persistence: 'required',
      persistenceSource: 'http.agy-login-terminal',
    });
    if (!result || !result.ok) {
      return res.status(400).json({ error: (result && result.error) || 'session create failed' });
    }
    const sessionId = result.id || (result.session && result.session.id);
    return res.json({ ...result.session, id: sessionId, url: `/?id=${encodeURIComponent(sessionId)}` });
  }));
}

module.exports = { mountAgyAccountRoutes, AGY_LOGIN_FLOW, AGY_LOGIN_SESSION_ID };
