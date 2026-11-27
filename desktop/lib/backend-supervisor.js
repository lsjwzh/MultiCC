'use strict';

// Backend supervisor: owns the MultiCC backend process for the desktop shell
// and the standalone launcher. In production that process is the Rust front
// door (`command`/`args` from desktop-env gatewayLaunch), which owns the port
// and relaunches a crashed Node itself; this supervisor gates window-open on
// /readyz, restarts after abnormal exits with a crash-loop guard, and always
// tears the whole tree down on stop() — graceful HTTP drain first (so in-flight
// chat turns flush), then signals, then a hard tree kill. It holds the child's
// stdin open and never writes it: the front door stops when it closes, so the
// tree cannot outlive this process. No electron import: every OS-touching dep
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

// A child killed by a signal reports exitCode === null forever — Node records
// the death in signalCode instead. And because the tree is killed with
// process.kill(-pid) rather than child.kill(), child.killed stays false too.
// Testing only exitCode/killed therefore mistakes a corpse for a live child.
function isChildLive(child) {
  return !!child && child.exitCode === null && child.signalCode === null && !child.killed;
}

// Kill a whole process tree. POSIX: the child is spawned detached (own process
// group), so -pid signals every server-spawned CLI too. Windows: taskkill /T.
function killProcessTree(pid, { spawn, platform = process.platform, signal = 'SIGKILL' } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (platform === 'win32') {
    if (typeof spawn !== 'function') return false;
    try {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      // A taskkill that cannot be launched (not on PATH, no execute permission)
      // reports that asynchronously as an 'error' event, and an unhandled one is
      // an uncaught exception: `multicc stop` would die mid-shutdown instead of
      // finishing. The caller re-checks whether the process is still alive, so
      // swallowing it here loses nothing but the noise.
      if (child && typeof child.on === 'function') child.on('error', () => {});
      return true;
    } catch (_) { return false; }
  }
  let signalled = false;
  try { process.kill(-pid, signal); signalled = true; } catch (_) {}
  try { process.kill(pid, signal); signalled = true; } catch (_) {}
  return signalled;
}

const RECOVERY_PREFIX = '[multicc-workspace-startup] ';
const RECOVERY_PHASES = ['history', 'reconcile', 'worktrees'];

// stdout may split or coalesce writes. Discard oversized lines until the next
// newline so ordinary server output cannot grow the parser's carry buffer.
function workspaceProgressReader(onProgress) {
  let partial = '';
  let oversized = false;
  return chunk => {
    const lines = chunk.toString().split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!oversized) {
        if (partial.length + lines[i].length > 512) oversized = true;
        else partial += lines[i];
      }
      if (i === lines.length - 1) break;
      if (!oversized && partial.startsWith(RECOVERY_PREFIX)) {
        let value;
        try { value = JSON.parse(partial.slice(RECOVERY_PREFIX.length)); } catch (_) {}
        if (value && RECOVERY_PHASES.includes(value.phase)
          && Number.isSafeInteger(value.completed) && Number.isSafeInteger(value.total)
          && value.completed >= 0 && value.completed <= value.total) {
          onProgress({ phase: value.phase, completed: value.completed, total: value.total });
        }
      }
      partial = '';
      oversized = false;
    }
  };
}

function createBackendSupervisor(rawDeps) {
  const {
    spawn,
    command,             // the front door binary (desktop-env gatewayLaunch)
    args = [],
    buildEnv,            // ({ port, attempt }) => env object for the child
    readRestartPort = () => null,
    fetchImpl = fetch,
    logsDir,
    runtimeInfoFile,
    logger = console,
    onPhase = () => {},
    now = Date.now,
    ...overrides
  } = rawDeps;
  if (typeof spawn !== 'function') throw new TypeError('[supervisor] spawn is required');
  if (!command) throw new TypeError('[supervisor] command is required');
  if (!Array.isArray(args)) throw new TypeError('[supervisor] args must be an array');
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
  let workspaceProgress = null;

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
    if (isChildLive(child)) {
      return new Promise(resolve => {
        // Deliberately ref'd: an awaited grace period is work the process must
        // stay alive for. Unref'ing let the loop drain with this promise still
        // pending whenever the exit event never came (child already reaped, or
        // killed by a signal), so stop() returned by killing the host instead.
        const timer = setTimeout(() => {
          const i = exitWaiters.indexOf(done); if (i >= 0) exitWaiters.splice(i, 1);
          resolve();
        }, timeoutMs);
        function done() { clearTimeout(timer); resolve(); }
        exitWaiters.push(done);
      });
    }
    return Promise.resolve();
  }

  async function probeHealth(getWorkspaceProgressAt) {
    const controller = new AbortController();
    healthAbort = controller;
    try {
      await waitForReadiness({
        origin,
        fetchImpl,
        intervalMs: 400,
        timeoutMs: opts.healthTimeoutMs,
        signal: controller.signal,
        getWorkspaceProgressAt,
        onMigration: migration => onPhase('migrating', { port, origin, attempt: attempts, migration }),
      });
    } catch (error) {
      if (stopRequested || state === 'stopping') return;
      const aborted = controller.signal.aborted || error?.code === 'READY_ABORTED';
      if (aborted) return;
      // Still alive but never turned ready: our own child, so tear it down
      // before reporting — never leave a half-booted server holding the port.
      const stuckPid = child ? child.pid : null;
      if (stuckPid) killProcessTree(stuckPid, { spawn, signal: 'SIGKILL' });
      const recovery = workspaceProgress;
      const detail = recovery ? ` (workspace ${recovery.phase}: ${recovery.completed}/${recovery.total})` : '';
      fail('not-ready', `server did not become ready: ${error.message}${detail}`);
      return;
    }
    if (controller.signal.aborted || stopRequested || state !== 'starting') return;
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
      child = spawn(command, args, {
        env: { ...buildEnv({ port, attempt: attempts }), MULTICC_WORKSPACE_STARTUP_PROGRESS: '1' },
        // stdin is the front door's lifeline (--stdin-lifeline): held, never
        // written, closed by the OS whenever this process goes away.
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group on POSIX so stop() can reap server-spawned CLIs.
        detached: isPosix(),
        windowsHide: true,
      });
    } catch (error) {
      fail('spawn-error', error.message);
      return;
    }
    attempts += 1;
    // EPIPE once the child is gone must not become an uncaught exception.
    if (child.stdin) child.stdin.on('error', () => {});
    const currentChild = child;
    let progressAt = 0;
    const readProgress = workspaceProgressReader(recovery => {
      if (state !== 'starting' || currentChild !== child) return;
      if (workspaceProgress) {
        const previousPhase = RECOVERY_PHASES.indexOf(workspaceProgress.phase);
        const phase = RECOVERY_PHASES.indexOf(recovery.phase);
        if (phase < previousPhase || (phase === previousPhase
          && (recovery.total !== workspaceProgress.total || recovery.completed <= workspaceProgress.completed))) return;
      }
      workspaceProgress = recovery;
      progressAt = Date.now();
      onPhase('workspace-recovery', { port, origin, attempt: attempts, recovery });
    });
    child.stdout.on('data', chunk => { appendRing(chunk); if (state === 'starting') readProgress(chunk); });
    child.stderr.on('data', appendRing);
    child.on('error', error => {
      if (currentChild !== child || state === 'stopping' || stopRequested) return;
      fail('spawn-error', error.message);
      resolveExitWaiters();
    });
    child.on('exit', (code, signal) => {
      if (currentChild === child) handleExit(code, signal);
    });
    probeHealth(() => progressAt);
  }

  function handleExit(code, signal) {
    // Read before anything may overwrite it: an exit from a server that had
    // already served /readyz is a different event from one that never booted.
    const wasReady = state === 'ready';
    healthAbort?.abort();
    if (wasReady) workspaceProgress = null;
    resolveExitWaiters();
    closeLogStream();
    clearRuntimeInfo();
    if (stopRequested || state === 'stopping') {
      state = 'stopped';
      onPhase('stopped', { code, signal });
      return;
    }
    // A clean exit from a server that was ready is a *requested* restart, not a
    // crash: /api/restart in desktop mode is documented as "exit gracefully and
    // let the supervisor respawn us", and gracefulShutdown always exits 0. It
    // must not spend crash-loop budget — three restarts inside the window (exactly
    // what a user does when the app looks wedged) used to trip the guard and
    // leave the app permanently down. Exits before readiness still count, so a
    // server that cannot boot keeps its guard.
    const requestedRestart = code === 0 && wasReady && signal === null;
    if (!requestedRestart) {
      crashTimes.push(now());
      while (crashTimes.length && now() - crashTimes[0] > opts.crashLoopWindowMs) crashTimes.shift();
    }
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
    onPhase('respawning', { code, signal, nextAttempt: attempts + 1, requested: requestedRestart });
    const backoff = requestedRestart
      ? opts.restartBackoffMs
      : Math.min(opts.restartBackoffMs * 2 ** (crashTimes.length - 1), opts.maxRestartBackoffMs);
    // Deliberately NOT unref'd — same rule as waitForExit below, and it was
    // learned the hard way there. A pending respawn is work this process must
    // stay alive to finish. In the Electron shell the app holds the loop either
    // way, so unref'ing looked harmless; but MultiCC.app runs the standalone
    // launcher in the foreground, and its `await new Promise(() => {})` holds
    // nothing — the server child's own handle was the only ref'd thing left.
    // Unref'ing this timer therefore let the launcher exit inside the backoff
    // window (1s after the first exit), so the server simply never came back:
    // every /api/restart left the app dead with nothing but
    // "server exited (code=0); restarting" in standalone.log.
    respawnTimer = setTimeout(() => {
      respawnTimer = null;
      if (stopRequested || state === 'stopping') return;
      if (requestedRestart) {
        const requested = readRestartPort();
        if (Number.isInteger(requested) && requested >= 1 && requested <= 65535) {
          port = requested;
          origin = `http://${opts.host}:${port}`;
        }
      }
      spawnChild({ respawn: true });
    }, backoff);
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
    workspaceProgress = null;
    crashTimes.length = 0;
    spawnChild({ respawn: false });
  }

  async function stop() {
    stopRequested = true;
    if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
    if (healthAbort) { healthAbort.abort(); healthAbort = null; }
    const previousState = state;
    state = 'stopping';
    const liveChild = isChildLive(child) ? child : null;
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
      if (!isChildLive(child)) break;
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
