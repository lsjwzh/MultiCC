'use strict';

// Backend supervisor: owns the MultiCC server child process for the desktop
// shell. Runs it as plain Node via ELECTRON_RUN_AS_NODE (execPath is the
// Electron binary), gates window-open on /readyz, restarts after abnormal
// exits with a crash-loop guard, and always tears the whole tree down on
// stop() — graceful HTTP drain first (so in-flight chat turns flush), then
// signals, then a hard tree kill. No electron import: every OS-touching dep
// is injected, which is what tests/fixtures drive.

const fs = require('fs');
const path = require('path');
const { waitForReadiness } = require('./health-probe');

const RING_MAX_BYTES = 32 * 1024;
const DEFAULTS = {
  healthTimeoutMs: 120_000,
  crashLoopThreshold: 3,
  crashLoopWindowMs: 60_000,
  restartBackoffMs: 1_000,
  maxRestartBackoffMs: 10_000,
  drainGraceMs: 20_000,
  signalGraceMs: 10_000,
  shutdownPostTimeoutMs: 6_000,
  host: '127.0.0.1',
};

function isPosix() { return process.platform !== 'win32'; }

function unrefTimer(timer) { if (timer && typeof timer.unref === 'function') timer.unref(); return timer; }

// Kill a whole process tree. POSIX: the child is spawned detached (own process
// group), so -pid signals every server-spawned CLI too. Windows: taskkill /T.
function killProcessTree(pid, { spawn, platform = process.platform, signal = 'SIGKILL' } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (platform === 'win32') {
    if (typeof spawn !== 'function') return false;
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return true;
    } catch (_) { return false; }
  }
  let signalled = false;
  try { process.kill(-pid, signal); signalled = true; } catch (_) {}
  try { process.kill(pid, signal); signalled = true; } catch (_) {}
  return signalled;
}

function createBackendSupervisor(rawDeps) {
  const {
    spawn,
    execPath,
    serverEntry,
    buildEnv,            // ({ port, attempt }) => env object for the child
    fetchImpl = fetch,
    logsDir,
    runtimeInfoFile,
    logger = console,
    onPhase = () => {},
    now = Date.now,
    ...overrides
  } = rawDeps;
  if (typeof spawn !== 'function') throw new TypeError('[supervisor] spawn is required');
  if (!execPath) throw new TypeError('[supervisor] execPath is required');
  if (!serverEntry) throw new TypeError('[supervisor] serverEntry is required');
  if (typeof buildEnv !== 'function') throw new TypeError('[supervisor] buildEnv is required');
  if (!logsDir) throw new TypeError('[supervisor] logsDir is required');
  const opts = { ...DEFAULTS, ...overrides };

  let state = 'idle'; // idle | starting | ready | respawning | stopping | stopped | failed
  let child = null;
  let port = null;
  let origin = null;
  let attempts = 0;
  let stopRequested = false;
  let healthAbort = null;
  let respawnTimer = null;
  let exitWaiters = [];
  const crashTimes = [];
  const ring = [];
  let ringBytes = 0;
  let failure = null;
  let logStream = null;

  fs.mkdirSync(logsDir, { recursive: true });

  function appendRing(chunk) {
    const text = String(chunk);
    for (const line of text.split('\n')) {
      if (line === '') continue;
      ring.push(line);
      ringBytes += line.length + 1;
      while (ringBytes > RING_MAX_BYTES && ring.length > 1) {
        ringBytes -= ring[0].length + 1;
        ring.shift();
      }
    }
    if (logStream) { try { logStream.write(text); } catch (_) {} }
  }

  function getLogTail(maxChars = 4000) {
    const text = ring.join('\n');
    return text.length > maxChars ? '…' + text.slice(-maxChars) : text;
  }

  function fail(reason, message) {
    failure = { reason, message: message || reason, tail: getLogTail(), at: new Date(now()).toISOString() };
    state = 'failed';
    logger.error(`[supervisor] failed: ${reason}: ${message || ''}`);
    closeLogStream();
    onPhase('failed', { reason, failure });
  }

  function closeLogStream() {
    if (logStream) { try { logStream.end(); } catch (_) {} logStream = null; }
  }

  function writeRuntimeInfo() {
    if (!runtimeInfoFile) return;
    try {
      fs.writeFileSync(runtimeInfoFile, JSON.stringify({
        pid: child ? child.pid : null,
        port,
        origin,
        startedAt: new Date(now()).toISOString(),
      }, null, 2));
    } catch (error) { logger.warn(`[supervisor] could not write runtime info: ${error.message}`); }
  }

  function clearRuntimeInfo() {
    if (!runtimeInfoFile) return;
    try { fs.unlinkSync(runtimeInfoFile); } catch (_) {}
  }

  function resolveExitWaiters() {
    const waiters = exitWaiters; exitWaiters = [];
    for (const w of waiters) w();
  }

  function waitForExit(timeoutMs) {
    if (child && child.exitCode === null && !child.killed) {
      return new Promise(resolve => {
        const timer = unrefTimer(setTimeout(() => {
          const i = exitWaiters.indexOf(done); if (i >= 0) exitWaiters.splice(i, 1);
          resolve();
        }, timeoutMs));
        function done() { clearTimeout(timer); resolve(); }
        exitWaiters.push(done);
      });
    }
    return Promise.resolve();
  }

  async function probeHealth() {
    healthAbort = new AbortController();
    try {
      await waitForReadiness({
        origin,
        fetchImpl,
        intervalMs: 400,
        timeoutMs: opts.healthTimeoutMs,
        signal: healthAbort.signal,
      });
    } catch (error) {
      if (stopRequested || state === 'stopping') return;
      const aborted = error && (error.code === 'READY_ABORTED' || healthAbort.signal.aborted);
      if (aborted) return;
      // Still alive but never turned ready: our own child, so tear it down
      // before reporting — never leave a half-booted server holding the port.
      const stuckPid = child ? child.pid : null;
      if (stuckPid) killProcessTree(stuckPid, { spawn, signal: 'SIGKILL' });
      fail('not-ready', `server did not become ready: ${error.message}`);
      return;
    }
    if (stopRequested || state === 'stopping') return;
    state = 'ready';
    writeRuntimeInfo();
    onPhase('ready', { port, origin, attempt: attempts });
  }

  function spawnChild({ respawn }) {
    state = 'starting';
    onPhase('starting', { attempt: attempts, respawn });
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    closeLogStream();
    try {
      logStream = fs.createWriteStream(path.join(logsDir, `server-${stamp}.log`), { flags: 'a' });
      unrefTimer(logStream);
    } catch (_) { logStream = null; }
    appendRing(`[supervisor] starting server (attempt ${attempts + 1}${respawn ? ', respawn' : ''}) on port ${port}\n`);

    try {
      child = spawn(execPath, [serverEntry], {
        env: buildEnv({ port, attempt: attempts }),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group on POSIX so stop() can reap server-spawned CLIs.
        detached: isPosix(),
        windowsHide: true,
      });
    } catch (error) {
      fail('spawn-error', error.message);
      return;
    }
    attempts += 1;
    child.stdout.on('data', appendRing);
    child.stderr.on('data', appendRing);
    child.on('error', error => {
      if (state === 'stopping' || stopRequested) return;
      fail('spawn-error', error.message);
      resolveExitWaiters();
    });
    child.on('exit', (code, signal) => handleExit(code, signal));
    probeHealth();
  }

  function handleExit(code, signal) {
    resolveExitWaiters();
    closeLogStream();
    clearRuntimeInfo();
    if (stopRequested || state === 'stopping') {
      state = 'stopped';
      onPhase('stopped', { code, signal });
      return;
    }
    // Abnormal exit (never became ready, or died after being ready).
    crashTimes.push(now());
    while (crashTimes.length && now() - crashTimes[0] > opts.crashLoopWindowMs) crashTimes.shift();
    const tail = getLogTail(1200);
    const portBusy = /EADDRINUSE/.test(tail);
    if (portBusy) {
      fail('port-in-use', `port ${port} is already in use (EADDRINUSE)`);
      return;
    }
    if (crashTimes.length >= opts.crashLoopThreshold) {
      fail('crash-loop', `server exited ${crashTimes.length} times within ${Math.round(opts.crashLoopWindowMs / 1000)}s (last: code=${code} signal=${signal})`);
      return;
    }
    state = 'respawning';
    onPhase('respawning', { code, signal, nextAttempt: attempts + 1 });
    const backoff = Math.min(opts.restartBackoffMs * 2 ** (crashTimes.length - 1), opts.maxRestartBackoffMs);
    respawnTimer = unrefTimer(setTimeout(() => {
      respawnTimer = null;
      if (stopRequested || state === 'stopping') return;
      spawnChild({ respawn: true });
    }, backoff));
  }

  async function start({ port: chosenPort }) {
    if (!Number.isInteger(chosenPort) || chosenPort <= 0) throw new TypeError('[supervisor] start requires an integer port');
    if (state !== 'idle' && state !== 'failed' && state !== 'stopped') {
      throw new Error(`[supervisor] cannot start from state ${state}`);
    }
    port = chosenPort;
    origin = `http://${opts.host}:${port}`;
    stopRequested = false;
    failure = null;
    attempts = 0;
    crashTimes.length = 0;
    spawnChild({ respawn: false });
  }

  async function stop() {
    stopRequested = true;
    if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
    if (healthAbort) { healthAbort.abort(); healthAbort = null; }
    const previousState = state;
    state = 'stopping';
    const liveChild = child && child.exitCode === null && !child.killed ? child : null;
    if (!liveChild) {
      state = 'stopped';
      clearRuntimeInfo();
      onPhase('stopped', { code: child ? child.exitCode : null });
      return;
    }
    // 1) Ask the server to drain gracefully over HTTP. In desktop mode it
    //    flushes in-flight chat turns and exits — including on Windows, where
    //    a SIGINT cannot reach a child process at all.
    try {
      const controller = new AbortController();
      const timer = unrefTimer(setTimeout(() => controller.abort(), opts.shutdownPostTimeoutMs));
      await fetchImpl(`${origin}/api/desktop-shutdown`, {
        method: 'POST',
        signal: controller.signal,
      }).then(async res => { try { await res.arrayBuffer(); } catch (_) {} });
      clearTimeout(timer);
    } catch (_) { /* fall through to signals */ }
    await waitForExit(opts.drainGraceMs);
    // 2) SIGINT → SIGTERM → SIGKILL the tree.
    const pid = liveChild.pid;
    for (const [signal, grace] of [['SIGINT', opts.signalGraceMs], ['SIGTERM', Math.ceil(opts.signalGraceMs / 2)], ['SIGKILL', 3_000]]) {
      if (!child || child.exitCode !== null) break;
      if (isPosix()) {
        try { process.kill(-pid, signal); } catch (_) {}
        try { process.kill(pid, signal); } catch (_) {}
      } else {
        killProcessTree(pid, { spawn, platform: 'win32' });
      }
      await waitForExit(grace);
    }
    closeLogStream();
    clearRuntimeInfo();
    state = 'stopped';
    onPhase('stopped', { code: child ? child.exitCode : null, previousState });
  }

  function getState() {
    return {
      state,
      port,
      origin,
      attempts,
      childPid: child ? child.pid : null,
      failure,
      logTail: getLogTail(),
    };
  }

  return { start, stop, getState, getLogTail, waitForExit };
}

module.exports = { createBackendSupervisor, killProcessTree, DEFAULTS };
