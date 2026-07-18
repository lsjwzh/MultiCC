// Temp artifacts domain — serves the throwaway files/web pages produced by the
// bundled `multicc-artifact` skill. The skill (running inside a claude session)
// writes each artifact into MULTICC_DATA_DIR/artifacts/<id>/<file> and hands the user
// a relative link like /artifacts/<id>/<file>.
//
// Relative URL on purpose: it resolves against whatever origin the user is on
// (localhost, Tailscale, ngrok…), so a page published on the host opens fine on
// a phone via the tunnel. The unguessable <id> is the capability — these routes
// bypass ACCESS_TOKEN auth the same way /share/:token does (see server.js auth
// middleware whitelist), so no login is needed to open a link someone was given.
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { createPaths } = require('./paths');

const ARTIFACTS_DIR = createPaths({ dataDir: process.env.MULTICC_DATA_DIR }).artifactsDir;
// Older globally-installed copies of the artifact skill may still write here.
// Serve it read-only during the migration window; all new writes and cleanup go
// through ARTIFACTS_DIR. Exporting the resolved path lets child agents and the
// bundled skill agree even when MULTICC_DATA_DIR uses its default.
const LEGACY_ARTIFACTS_DIR = path.join(os.homedir(), '.multicc', 'artifacts');
// This environment variable is an output of the resolved data-root policy, not
// an independent input. Always replace a stale inherited value so child agents
// cannot escape an explicitly isolated MULTICC_DATA_DIR and write artifacts
// back into another service instance or the source checkout.
process.env.MULTICC_ARTIFACTS_DIR = ARTIFACTS_DIR;

// Matches the auth-whitelist regex in server.js. Keep them in sync.
const ARTIFACT_PATH_RE = /^\/artifacts\/[A-Za-z0-9_-]+(?:\/|$)/;

function ensureDir() {
  try { fs.mkdirSync(ARTIFACTS_DIR, { recursive: true, mode: 0o700 }); } catch (_) {}
}

function servedRoots() {
  return [...new Set([ARTIFACTS_DIR, LEGACY_ARTIFACTS_DIR])];
}

function mount(app) {
  ensureDir();
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
    // fallthrough defaults to true: a missing artifact drops through to Express's
    // default 404 (quiet), matching how the rest of the app handles unknown paths.
    setHeaders: (res) => {
      // Temp content gets regenerated; never let a browser cache a stale copy.
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  };
  app.use('/artifacts', headers, ...servedRoots().map(root => express.static(root, options)));
}

// Delete artifact dirs older than maxAgeMs (by mtime). Cheap; safe to call often.
function cleanup(maxAgeMs = 7 * 24 * 3600 * 1000) {
  let removed = 0;
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(ARTIFACTS_DIR)) {
      const p = path.join(ARTIFACTS_DIR, name);
      try {
        if (now - fs.statSync(p).mtimeMs > maxAgeMs) {
          fs.rmSync(p, { recursive: true, force: true });
          removed++;
        }
      } catch (_) {}
    }
  } catch (_) {}
  if (removed) console.log(`[multicc/artifacts] cleaned up ${removed} expired artifact(s)`);
  return removed;
}

module.exports = {
  ARTIFACTS_DIR,
  ARTIFACT_PATH_RE,
  LEGACY_ARTIFACTS_DIR,
  cleanup,
  ensureDir,
  mount,
  servedRoots,
};
