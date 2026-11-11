'use strict';

// Frozen verbatim copy of the retired GET /api/token-usage/by-role handler
// (src/routes/token-usage.js, `mountRoutes`, deleted 2026-11-11). It exists
// only so docs/rust-migration/differential/token-usage-by-role.js can compare
// the Rust front door against the exact Node code it replaced. Do not import
// this from product code.

const EMPTY_ROLE_SNAPSHOT = Object.freeze({
  main: null,
  sub: null,
  subByProvider: Object.freeze([]),
});

const PUBLIC_USAGE_ERROR = 'Token usage is temporarily unavailable';

function mount(app, deps) {
  if (!app || typeof app.get !== 'function') {
    throw new TypeError('Express app.get is required');
  }
  if (!deps || !deps.roleTokenTracker) {
    throw new TypeError('roleTokenTracker is required');
  }
  const logFailure = typeof deps.logFailure === 'function' ? deps.logFailure : () => {};
  app.get('/api/token-usage/by-role', (req, res) => {
    try {
      if (req.query && req.query.session) {
        res.json(deps.roleTokenTracker.snapshot(req.query.session) || {
          main: EMPTY_ROLE_SNAPSHOT.main,
          sub: EMPTY_ROLE_SNAPSHOT.sub,
          subByProvider: [],
        });
        return;
      }
      res.json(deps.roleTokenTracker.readLedger());
    } catch (error) {
      logFailure('token_usage_role_read_failed', error);
      res.status(500).json({ error: PUBLIC_USAGE_ERROR });
    }
  });
}

module.exports = { mount, EMPTY_ROLE_SNAPSHOT, PUBLIC_USAGE_ERROR };
