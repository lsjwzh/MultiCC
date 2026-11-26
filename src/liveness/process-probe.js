'use strict';

const { getNative } = require('../native/binding');
const DEFAULT_ROLLOUT_WINDOW_MS = 15_000;
const DEFAULT_OUTBOUND_TTL_MS = 4_000;

function createProcessProbe(deps = {}) {
  const {
    execFile,           // (cmd, args, opts, cb) — node child_process.execFile
    statMtimeMs,        // (path) => number|null  — fs.statSync(path).mtimeMs wrapper
    now = Date.now,
    rolloutWindowMs = DEFAULT_ROLLOUT_WINDOW_MS,
    outboundTtlMs = DEFAULT_OUTBOUND_TTL_MS,
  } = deps;

  if (typeof execFile !== 'function') throw new TypeError('[process-probe] execFile is required');
  if (typeof statMtimeMs !== 'function') throw new TypeError('[process-probe] statMtimeMs is required');

  const native = getNative();
  const { outboundHttps, rolloutGrew } = native.processProbeSignals({
    now: () => now(), statMtimeMs, mtimes: new Map(), outbound: new Map(),
    inactive: () => Promise.resolve(false),
    fresh: (at, prev) => at - prev <= outboundTtlMs,
    expired: (at, prev) => at - prev > outboundTtlMs,
    recent: mtime => now() - mtime <= rolloutWindowMs,
    advanced: (mtime, prev) => mtime > prev,
    runLsof: pid => new Promise(resolve => {
      execFile('lsof', ['-nP', '-p', String(pid)], { timeout: 4000 }, (err, stdout) => {
        resolve((!err || !!stdout) && native.probeEstablished(String(stdout || '')));
      });
    }),
  });
  async function probe(pid, rolloutPath) {
    const [hasOutboundConnection, rolloutGrowing] = await Promise.all([
      outboundHttps(pid).catch(() => false),
      Promise.resolve().then(() => rolloutGrew(rolloutPath)).catch(() => false),
    ]);
    return { hasOutboundConnection, rolloutGrowing, pid: pid || null };
  }

  return { probe, outboundHttps, rolloutGrew };
}

module.exports = { createProcessProbe, DEFAULT_ROLLOUT_WINDOW_MS, DEFAULT_OUTBOUND_TTL_MS };
