'use strict';

// Process-level liveness probe for sessions that bypass cli-provider-router
// (default-login / claude-official direct), where the proxy never sees their
// traffic. Two corroborating signals:
//
//   • an ESTABLISHED outbound HTTPS connection owned by the session's CLI pid —
//     it is mid-request, waiting on the model;
//   • a codex rollout *.jsonl whose mtime advanced since the last probe — the
//     CLI is appending events (tool calls, deltas) right now.
//
// Both are best-effort: any failure resolves to "no signal", never throws, so a
// probe error can only downgrade a verdict, never crash the endpoint.

const DEFAULT_ROLLOUT_WINDOW_MS = 15_000;

function createProcessProbe(deps = {}) {
  const {
    execFile,           // (cmd, args, opts, cb) — node child_process.execFile
    statMtimeMs,        // (path) => number|null  — fs.statSync(path).mtimeMs wrapper
    now = Date.now,
    rolloutWindowMs = DEFAULT_ROLLOUT_WINDOW_MS,
  } = deps;

  if (typeof execFile !== 'function') throw new TypeError('[process-probe] execFile is required');
  if (typeof statMtimeMs !== 'function') throw new TypeError('[process-probe] statMtimeMs is required');

  // Remember each rollout file's last-seen mtime so "growing" means "advanced
  // since we last looked", not merely "recently modified".
  const lastRolloutMtime = new Map();

  function outboundHttps(pid) {
    return new Promise(resolve => {
      if (!Number.isInteger(pid) || pid <= 0) return resolve(false);
      // lsof: list this pid's network files; we look for an ESTABLISHED TCP
      // connection to a remote :443 (or :80). -nP avoids DNS/port name lookups.
      execFile('lsof', ['-nP', '-p', String(pid)], { timeout: 4000 }, (err, stdout) => {
        if (err && !stdout) return resolve(false);
        const text = String(stdout || '');
        const hit = text.split('\n').some(line =>
          /ESTABLISHED/.test(line) && /->.*:(443|80)\b/.test(line));
        resolve(hit);
      });
    });
  }

  function rolloutGrew(rolloutPath) {
    if (!rolloutPath) return false;
    let mtime = null;
    try { mtime = statMtimeMs(rolloutPath); } catch (_) { mtime = null; }
    if (mtime == null) return false;
    const prev = lastRolloutMtime.get(rolloutPath);
    lastRolloutMtime.set(rolloutPath, mtime);
    if (prev == null) {
      // First observation: treat as growing only if it was touched very recently.
      return (now() - mtime) <= rolloutWindowMs;
    }
    return mtime > prev;
  }

  // probeSession(sessionId, signals) — signals carries the pid; the caller also
  // passes a rolloutPath resolver via the bound closure below.
  async function probe(pid, rolloutPath) {
    const [hasOutboundConnection, rolloutGrowing] = await Promise.all([
      outboundHttps(pid).catch(() => false),
      Promise.resolve().then(() => rolloutGrew(rolloutPath)).catch(() => false),
    ]);
    return { hasOutboundConnection, rolloutGrowing, pid: pid || null };
  }

  return { probe, outboundHttps, rolloutGrew };
}

module.exports = { createProcessProbe, DEFAULT_ROLLOUT_WINDOW_MS };
