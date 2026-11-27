// Temp artifacts domain — data-root policy, retention roots and expiry cleanup
// for the throwaway files/web pages produced by the bundled `multicc-artifact`
// skill. The skill (running inside a claude session) writes each artifact into
// MULTICC_DATA_DIR/artifacts/<id>/<file> and hands the user a relative link
// like /artifacts/<id>/<file>; the HTTP serving of those links moved to the
// Rust front door's dual-root static mount (docs/gateway.md §62), which serves
// ARTIFACTS_DIR first and LEGACY_ARTIFACTS_DIR as the read-only fallback.
//
// Relative URL on purpose: it resolves against whatever origin the user is on
// (localhost, Tailscale, ngrok…), so a page published on the host opens fine on
// a phone via the tunnel. The unguessable <id> is the capability — these routes
// bypass ACCESS_TOKEN auth the same way /share/:token does (the whitelist now
// lives in native/core/src/http_entry.rs::public_path), so no login is needed
// to open a link someone was given.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPaths } = require('./native/binding').appPaths;
const { isArtifactId } = require('./native/binding').artifactReference;

const DEFAULT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const ARTIFACTS_DIR = createPaths({ dataDir: process.env.MULTICC_DATA_DIR }).artifactsDir;
// Older globally-installed copies of the artifact skill may still write here.
// The front door serves it read-only during the migration window; all new
// writes and cleanup go through ARTIFACTS_DIR. Exporting the resolved path
// lets child agents and the bundled skill agree even when MULTICC_DATA_DIR
// uses its default.
const LEGACY_ARTIFACTS_DIR = path.join(os.homedir(), '.multicc', 'artifacts');
// This environment variable is an output of the resolved data-root policy, not
// an independent input. Always replace a stale inherited value so child agents
// cannot escape an explicitly isolated MULTICC_DATA_DIR and write artifacts
// back into another service instance or the source checkout.
process.env.MULTICC_ARTIFACTS_DIR = ARTIFACTS_DIR;

// Mount order of the retired serving chain, kept for the retention readers
// (docs-registry permanent-id collection, task-shell existence checks): the
// primary root shadows the legacy one on name clashes.
function servedRoots() {
  return [...new Set([ARTIFACTS_DIR, LEGACY_ARTIFACTS_DIR])];
}

function normalizePinnedIds(values) {
  const result = new Set();
  if (!values || typeof values === 'string' || typeof values[Symbol.iterator] !== 'function') return result;
  try {
    for (const value of values) if (isArtifactId(value)) result.add(value);
  } catch (_) { /* invalid iterables pin nothing */ }
  return result;
}

// Dependency injection keeps cleanup testable without ever pointing the
// production singleton at a caller-controlled directory.
function createCleanup({ artifactsDir, fsImpl = fs, now = Date.now, log = console.log } = {}) {
  const root = path.resolve(String(artifactsDir || ''));
  if (!path.isAbsolute(String(artifactsDir || '')) || root === path.parse(root).root) {
    throw new TypeError('artifact cleanup requires a bounded absolute directory');
  }
  if (typeof now !== 'function' || typeof log !== 'function') {
    throw new TypeError('artifact cleanup clock and logger must be functions');
  }
  return function cleanup(maxAgeMs = DEFAULT_MAX_AGE_MS, pinnedArtifactIds = []) {
    const age = maxAgeMs == null ? DEFAULT_MAX_AGE_MS : Number(maxAgeMs);
    if (!Number.isFinite(age) || age < 0) throw new TypeError('artifact max age must be non-negative');
    const pinned = normalizePinnedIds(pinnedArtifactIds);
    let removed = 0;
    try {
      const rootStat = fsImpl.lstatSync(root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return 0;
      const currentTime = Number(now());
      for (const name of fsImpl.readdirSync(root)) {
        if (pinned.has(name)) continue;
        const candidate = path.join(root, name);
        if (path.dirname(candidate) !== root) continue;
        try {
          if (currentTime - fsImpl.lstatSync(candidate).mtimeMs > age) {
            const currentRoot = fsImpl.lstatSync(root);
            if (currentRoot.isSymbolicLink() || !currentRoot.isDirectory()) return removed;
            fsImpl.rmSync(candidate, { recursive: true, force: true });
            removed += 1;
          }
        } catch (_) {}
      }
    } catch (_) {}
    if (removed) log(`[multicc/artifacts] cleaned up ${removed} expired artifact(s)`);
    return removed;
  };
}

// Delete unpinned artifact dirs older than maxAgeMs (by mtime).
const cleanup = createCleanup({ artifactsDir: ARTIFACTS_DIR });

module.exports = {
  ARTIFACTS_DIR,
  LEGACY_ARTIFACTS_DIR,
  cleanup,
  createCleanup,
  servedRoots,
};
