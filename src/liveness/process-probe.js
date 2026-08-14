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

// How long one pid's lsof verdict may be reused. Every visible session polls
// this endpoint on its own timer, so without a memo a fleet of N sessions forks
// N lsof processes per poll round — and lsof walks the whole fd table, which is
// expensive enough on macOS to show up as sustained server CPU. A window this
// short cannot change a verdict: `working` needs the connection to survive only
// until the next poll, and the stall threshold it feeds is measured in minutes.
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

  // Remember each rollout file's last-seen mtime so "growing" means "advanced
  // since we last looked", not merely "recently modified".
  const lastRolloutMtime = new Map();

  // pid -> { at, promise }. Holds the in-flight promise rather than its value so
  // concurrent probes of the same pid (several sessions can share a CLI, and
  // poll rounds overlap) collapse onto one lsof instead of racing N of them.
  const outboundInFlight = new Map();

  function runLsof(pid) {
    return new Promise(resolve => {
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

  function outboundHttps(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
    const t = now();
    const cached = outboundInFlight.get(pid);
    if (cached && (t - cached.at) <= outboundTtlMs) return cached.promise;
    // Drop entries for pids we have stopped probing so a long-lived server does
    // not accumulate one per CLI process it has ever seen.
    for (const [key, entry] of outboundInFlight) {
      if ((t - entry.at) > outboundTtlMs) outboundInFlight.delete(key);
    }
    const promise = runLsof(pid);
    outboundInFlight.set(pid, { at: t, promise });
    return promise;
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

module.exports = { createProcessProbe, DEFAULT_ROLLOUT_WINDOW_MS, DEFAULT_OUTBOUND_TTL_MS };
