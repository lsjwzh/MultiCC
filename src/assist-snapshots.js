'use strict';

// Retention for human-assist screenshots. The agent saves what it shows the
// user under <assistDir>/<sessionId>/ (see src/chat/host-prompts.js); nothing
// else ever deletes them, so this sweep removes files older than the window
// one by one (a long-lived session dir keeps getting fresh files, so dir mtime
// is not a usable age) and then drops session dirs left empty.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const SWEEP_INTERVAL_MS = 6 * 3600 * 1000;

function createAssistSweep({ assistDir, fsImpl = fs, now = Date.now, log = console.log } = {}) {
  const root = path.resolve(String(assistDir || ''));
  if (!path.isAbsolute(String(assistDir || '')) || root === path.parse(root).root) {
    throw new TypeError('assist sweep requires a bounded absolute directory');
  }
  return function sweep(maxAgeMs = DEFAULT_MAX_AGE_MS) {
    let removed = 0;
    try {
      const rootStat = fsImpl.lstatSync(root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return 0;
      const cutoff = Number(now()) - maxAgeMs;
      for (const session of fsImpl.readdirSync(root)) {
        const dir = path.join(root, session);
        try {
          const stat = fsImpl.lstatSync(dir);
          if (stat.isSymbolicLink()) continue;
          if (!stat.isDirectory()) {
            if (stat.mtimeMs < cutoff) { fsImpl.rmSync(dir, { force: true }); removed += 1; }
            continue;
          }
          const names = fsImpl.readdirSync(dir);
          let left = names.length;
          for (const name of names) {
            const file = path.join(dir, name);
            try {
              const fileStat = fsImpl.lstatSync(file);
              if (fileStat.mtimeMs < cutoff) {
                fsImpl.rmSync(file, { recursive: true, force: true });
                removed += 1;
                left -= 1;
              }
            } catch (_) { /* vanished mid-sweep */ }
          }
          if (left === 0) fsImpl.rmdirSync(dir);
        } catch (_) { /* skip entries that disappear or refuse removal */ }
      }
    } catch (_) { /* no assist dir yet */ }
    if (removed) log(`[multicc/assist] cleaned up ${removed} expired assist screenshot(s)`);
    return removed;
  };
}

// Boot pass + periodic pass; the timer goes through the host's tracker so
// graceful shutdown clears it.
function startAssistSweep({ assistDir, trackTimer, log }) {
  const sweep = createAssistSweep({ assistDir, log });
  sweep();
  trackTimer(setInterval(() => sweep(), SWEEP_INTERVAL_MS));
  return sweep;
}

module.exports = { createAssistSweep, startAssistSweep, DEFAULT_MAX_AGE_MS };
