'use strict';

// FROZEN ORACLE — the serving half of `src/artifacts.js` before the dual-root
// `express.static` mount retired into the Rust front door
// (native/gateway/src/app/artifacts.rs, rules in multicc_core::static_web).
// It is loaded only by docs/rust-migration/differential/artifacts-root.js;
// nothing re-reads `git show` at run time, so the oracle cannot drift with
// later edits.
//
// The retired `mount(app)` closed over the module-level ARTIFACTS_DIR and
// LEGACY_ARTIFACTS_DIR; the oracle takes the two roots as arguments instead so
// the differential can point both sides at one seeded tree. Everything inside
// the handlers is byte-for-byte the retired code.

const path = require('node:path');

/**
 * The retired `app.use('/artifacts', headers, ...servedRoots().map(root =>
 * express.static(root, options)))`, in mount order.
 *
 * @param {import('express').Express} app
 * @param {string[]} roots primary root first, legacy root second
 */
function mountArtifacts(app, roots) {
  // ?download=1 (or ?dl=1) turns an inline view into a forced download.
  const headers = (req, res, next) => {
    if (req.query.download === '1' || req.query.dl === '1') {
      const base = (path.basename(req.path) || 'download').replace(/["\r\n]/g, '');
      res.setHeader('Content-Disposition', `attachment; filename="${base}"`);
    }
    next();
  };
  const options = {
    index: 'index.html',
    dotfiles: 'ignore',
    // fallthrough defaults to true: a missing artifact drops through to
    // Express's default 404 (quiet), matching how the rest of the app handles
    // unknown paths.
    setHeaders: (res) => {
      // Temp content gets regenerated; never let a browser cache a stale copy.
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  };
  const servedRoots = [...new Set(roots)];
  app.use('/artifacts', headers, ...servedRoots.map(root => require('express').static(root, options)));
}

module.exports = { mountArtifacts };
