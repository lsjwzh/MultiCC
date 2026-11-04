'use strict';

// Retention for per-session CLI home sandboxes (CODEX_HOME / ZCODE_HOME):
// <~/.multicc>/<name>/<home> such as codex-session-homes/<task>-<fingerprint>.
// Spawn paths create one directory per logical session and, before this
// module existed, nothing ever removed them — a Nov 2026 sweep measured
// 1,100+ stale homes ≈ 3.7 GB of real disk. A home whose newest top-level
// entry is older than the TTL cannot belong to a live turn (live sessions
// write rollouts and credential refreshes far more often than daily), so the
// janitor drops it wholesale. Sandboxed homes re-create and re-link their
// credentials from the global ~/.codex on next spawn, so removal only costs
// the dead session its cached state.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_TTL_DAYS = 14;
const SWEEP_INTERVAL_MS = 6 * 3600 * 1000;
// Whitelisted sibling directories under the multicc runtime root. The janitor
// never touches anything else, so a mis-rooted configuration cannot turn the
// sweep into a recursive delete of an arbitrary directory.
const HOME_DIR_NAMES = Object.freeze(['codex-session-homes', 'codex-homes', 'codex-attempt-homes', 'zcode-homes']);

// Directory mtime only moves when top-level entries are added or removed; a
// home that merely rewrites existing files would look stale by dir mtime
// alone. The newest top-level entry mtime is the activity signal.
function newestEntryMs(fsImpl, dir) {
  let newest = 0;
  try {
    newest = fsImpl.lstatSync(dir).mtimeMs;
    for (const name of fsImpl.readdirSync(dir)) {
      try {
        const mtime = fsImpl.lstatSync(path.join(dir, name)).mtimeMs;
        if (mtime > newest) newest = mtime;
      } catch (_) { /* vanished mid-sweep */ }
    }
  } catch (_) { /* unreadable home */ }
  return newest;
}

function createRuntimeHomesJanitor({ homesRoot, fsImpl = fs, now = Date.now, ttlDays = DEFAULT_TTL_DAYS, log = console.log } = {}) {
  const rawRoot = String(homesRoot || path.join(os.homedir(), '.multicc'));
  if (!path.isAbsolute(rawRoot)) {
    throw new TypeError('runtime homes janitor requires a bounded absolute root');
  }
  const root = path.resolve(rawRoot);
  if (root === path.parse(root).root) {
    throw new TypeError('runtime homes janitor requires a bounded absolute root');
  }
  const ttlDaysNumber = Number(ttlDays);
  const ttlMs = (Number.isFinite(ttlDaysNumber) && ttlDaysNumber > 0)
    ? ttlDaysNumber * 24 * 3600 * 1000
    : 0;
  return function sweep() {
    if (ttlMs <= 0) return 0; // disabled via ttlDays <= 0
    const cutoff = Number(now()) - ttlMs;
    let removed = 0;
    for (const name of HOME_DIR_NAMES) {
      const dir = path.join(root, name);
      try {
        const stat = fsImpl.lstatSync(dir);
        if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      } catch (_) { continue; /* no such sandbox collection yet */ }
      for (const entry of fsImpl.readdirSync(dir)) {
        const home = path.join(dir, entry);
        try {
          const stat = fsImpl.lstatSync(home);
          if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
          if (newestEntryMs(fsImpl, home) >= cutoff) continue;
          fsImpl.rmSync(home, { recursive: true, force: true });
          removed += 1;
        } catch (_) { /* skip homes that disappear or refuse removal */ }
      }
    }
    if (removed) log(`[multicc/runtime-homes] cleaned up ${removed} stale CLI session home(s) under ${root}`);
    return removed;
  };
}

// Boot pass + periodic pass; the timer goes through the host's tracker so
// graceful shutdown clears it (same lifecycle contract as assist-snapshots).
function startRuntimeHomesJanitor({ homesRoot, ttlDays, trackTimer, log }) {
  const sweep = createRuntimeHomesJanitor({ homesRoot, ttlDays, log });
  sweep();
  trackTimer(setInterval(() => sweep(), SWEEP_INTERVAL_MS));
  return sweep;
}

module.exports = { createRuntimeHomesJanitor, startRuntimeHomesJanitor, DEFAULT_TTL_DAYS, HOME_DIR_NAMES };
