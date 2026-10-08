#!/usr/bin/env node
'use strict';

// Standalone launcher — the entry point of a self-contained MultiCC bundle,
// started by the Node runtime that ships inside the bundle
// (Resources/runtime/bin/node). It gives a bundle that nobody installs the
// same startup contract the Electron desktop shell has:
//
//   start (default)  reclaim leftovers → pick a free loopback port → supervise
//                    the server child → open the web UI once /readyz is 200
//   --stop           graceful drain (POST /api/desktop-shutdown), then a tree kill
//   --status         report what is running for this data directory
//
// Every OS-touching dependency is injected and all lifecycle logic lives in
// desktop/lib/* (pure Node, shared with the desktop shell). This file only
// wires that to a bundle layout and to a browser.
//
// Bundle layout (macOS shown; Resources/ sits at the same relative place on
// every platform, and on macOS it is Contents/Resources of MultiCC.app):
//
//   Resources/app-server/   staged MultiCC server incl. node_modules (read-only)
//   Resources/runtime/      Node 22 LTS runtime — official builds are macOS 11+
//   Resources/launcher/     this file + lib/ (copies of desktop/lib)
//
// Writable state never lives inside the bundle: it goes to the per-user data
// directory (see standaloneDataDir), so replacing or upgrading the bundle keeps
// sessions, providers and chat history.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

// Lifecycle logic is shared with the desktop shell and must never fork into a
// second copy: the bundle ships desktop/lib as <Resources>/launcher/lib, while
// running this file straight out of the repo (tests, dev) resolves the same
// files at desktop/lib.
const LIB_DIR = fs.existsSync(path.join(__dirname, 'lib'))
  ? path.join(__dirname, 'lib')
  : path.resolve(__dirname, '..', 'desktop', 'lib');
const { findFreePort } = require(path.join(LIB_DIR, 'port-chooser'));
const { createBackendSupervisor, killProcessTree } = require(path.join(LIB_DIR, 'backend-supervisor'));
const { reclaimOrphan, pidAlive, readRuntimeInfo } = require(path.join(LIB_DIR, 'orphan-reclaim'));
const {
  resolveDesktopEnv, buildChildEnv, readEnvValues, ensureWritableDirs, translocationGuidance,
} = require(path.join(LIB_DIR, 'desktop-env'));

const APP_DIRNAME = 'MultiCCStandalone';
// Bundles released before the portable→standalone unification wrote everything
// to MultiCCPortable. Their data is the user's sessions and providers, so an
// existing legacy directory keeps being used instead of being silently
// orphaned by the rename (see dataDir()).
const LEGACY_APP_DIRNAME = 'MultiCCPortable';
const DEFAULT_START_PORT = 3000;
const DETACH_FLAG = '--detached-child';
// Node prints "SQLite is an experimental feature" the first time node:sqlite
// loads. Every launch would otherwise log it.
const SQLITE_WARNING = 'ExperimentalWarning';
// How long a stray stop request stays actionable. Old requests are ignored, so
// a crashed launcher can never pass its request on to a fresh one.
const STOP_REQUEST_TTL_MS = 5 * 60 * 1000;

function defaultResourcesDir({ env = process.env, dirname = __dirname } = {}) {
  return path.resolve(
    env.MULTICC_STANDALONE_RESOURCES || env.MULTICC_PORTABLE_RESOURCES || path.join(dirname, '..'),
  );
}

function perUserAppDir({ platform, env, homedir, name }) {
  if (platform === 'darwin') return path.join(homedir, 'Library', 'Application Support', name);
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
    return path.join(appData, name);
  }
  const configHome = env.XDG_CONFIG_HOME || path.join(homedir, '.config');
  return path.join(configHome, name);
}

// Electron's userData conventions, so the bundle behaves like a normal app
// instead of scattering files next to the binary. MULTICC_STANDALONE_HOME
// overrides it (tests, USB-stick installs, side-by-side runs).
function standaloneDataDir({
  platform = process.platform, env = process.env, homedir = os.homedir(),
} = {}) {
  const explicit = env.MULTICC_STANDALONE_HOME || env.MULTICC_PORTABLE_HOME;
  if (explicit) return path.resolve(explicit);
  const current = perUserAppDir({ platform, env, homedir, name: APP_DIRNAME });
  const legacy = perUserAppDir({ platform, env, homedir, name: LEGACY_APP_DIRNAME });
  // A pre-rename install keeps its directory: moving it would be a data
  // migration for no gain, and picking the new one would hide every existing
  // session from the user.
  if (legacy !== current && fs.existsSync(legacy) && !fs.existsSync(current)) return legacy;
  return current;
}

function resolveStandalonePaths({
  resources = defaultResourcesDir(),
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
} = {}) {
  const userData = standaloneDataDir({ platform, env, homedir });
  return {
    resources,
    userData,
    runtimeDir: path.join(resources, 'runtime'),
    // The official Windows zip keeps node.exe at the runtime root; the unix
    // tarballs keep it in bin/. The bundle builder mirrors this exactly
    // (scripts/standalone-bundle.js runtimeNodePath) — keep the two in step.
    runtimeNode: platform === 'win32'
      ? path.join(resources, 'runtime', 'node.exe')
      : path.join(resources, 'runtime', 'bin', 'node'),
    launcherPath: path.join(resources, 'launcher', 'standalone-launcher.js'),
    desktopEnv: resolveDesktopEnv({ isPackaged: true, resourcesPath: resources, userData }),
  };
}

// The server child runs under the bundled runtime, and that same runtime must
// win on PATH: `claude`/`codex`/other Node-based CLIs spawned for a session
// would otherwise fall back to whatever (too old) Node the host has.
// buildChildEnv already puts it there for a packaged layout (runtimeNode comes
// from resolveDesktopEnv, so the desktop shell gets it too) — this only adds
// the standalone-specific bits on top.
function buildStandaloneChildEnv({ port, desktopEnv, baseEnv = {}, dotenv = {}, runtimeNode }) {
  const env = buildChildEnv({ port, desktopEnv, baseEnv, dotenv, runtimeNode });
  // Storage is node:sqlite, which Node still labels experimental and announces
  // on stderr at load. That line is noise in a shipped app's log, not a warning
  // the user can act on.
  env.NODE_OPTIONS = [env.NODE_OPTIONS, `--disable-warning=${SQLITE_WARNING}`]
    .filter(Boolean).join(' ');
  return env;
}

function parseArgs(argv) {
  const args = {
    mode: 'start', open: true, detach: false, detachedChild: false,
    port: null, data: null, resources: null, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--start') args.mode = 'start';
    else if (arg === '--stop') args.mode = 'stop';
    else if (arg === '--status') args.mode = 'status';
    else if (arg === '--detach') args.detach = true;
    // Internal, and only ever passed by detachSelf(): the child we spawned in
    // the background. It must be a recognized flag, otherwise the child dies on
    // "unknown argument" with stdio ignored — a silent no-op start.
    else if (arg === DETACH_FLAG) args.detachedChild = true;
    else if (arg === '--open') args.open = true;
    else if (arg === '--no-open') args.open = false;
    else if (arg === '--port') args.port = Number.parseInt(argv[++i], 10);
    else if (arg === '--data') args.data = argv[++i];
    else if (arg === '--resources') args.resources = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else { console.error(`unknown argument: ${arg}`); process.exit(2); }
  }
  if (args.port !== null && (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535)) {
    console.error(`invalid --port: ${args.port}`);
    process.exit(2);
  }
  return args;
}

function createLogger({ logFile } = {}) {
  const write = (level, message) => {
    const line = `${new Date().toISOString()} [standalone] ${message}`;
    if (level === 'error') console.error(line); else console.log(line);
    if (!logFile) return;
    // Logging must never break startup: the data dir may not exist yet.
    try { fs.appendFileSync(logFile, `${line}\n`); } catch (_) {}
  };
  return { log: message => write('info', message), error: message => write('error', message) };
}

function browserCommand(origin, platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [origin] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', origin] };
  return { command: 'xdg-open', args: [origin] };
}

// Best-effort by design: a headless/SSH session has no browser, and that must
// not fail an otherwise healthy server startup.
function openBrowser(origin, { spawnImpl = spawn, platform = process.platform, logger = console } = {}) {
  const { command, args } = browserCommand(origin, platform);
  try {
    const child = spawnImpl(command, args, { stdio: 'ignore', detached: true });
    if (child && typeof child.unref === 'function') child.unref();
    if (child && typeof child.on === 'function') {
      child.on('error', error => logger.error(`could not open a browser (${command}): ${error.message}`));
    }
    return true;
  } catch (error) {
    logger.error(`could not open a browser (${command}): ${error.message}`);
    return false;
  }
}

async function probeReady(origin, { fetchImpl = fetch, timeoutMs = 1_500 } = {}) {
  try {
    const res = await fetchImpl(`${origin.replace(/\/$/, '')}/readyz`, {
      cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
    });
    try { await res.arrayBuffer(); } catch (_) {}
    return res.status === 200;
  } catch (_) { return false; }
}

// Command line of a live process, or null when it cannot be read (the process
// is gone, or this platform cannot be asked cheaply). `ps -ww` defeats the
// width truncation that would otherwise cut the script path off long argv.
function defaultReadProcessCommandLine(pid) {
  if (process.platform === 'win32') return null;
  try {
    return execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
    });
  } catch (_) { return null; }
}

function createLauncher({
  paths = resolveStandalonePaths(),
  env = process.env,
  logger,
  spawnImpl = spawn,
  fetchImpl = fetch,
  platform = process.platform,
  openUrl,
  startPort = DEFAULT_START_PORT,
  findFreePortImpl = findFreePort,
  reclaimImpl = reclaimOrphan,
  createSupervisor = createBackendSupervisor,
  // Reading another process's command line is the only way to tell a real
  // launcher from a recycled pid (see otherLauncher). Injected so tests never
  // shell out.
  readProcessCommandLine = defaultReadProcessCommandLine,
} = {}) {
  const desktopEnv = paths.desktopEnv;
  const runtimeNode = paths.runtimeNode;
  const infoFile = desktopEnv.runtimeInfoFile;
  // The supervising launcher records its own pid so `--stop` (and the "停止
  // MultiCC" wrapper) can ask it to drain instead of yanking the server out
  // from under it: the supervisor treats a child that exits on its own as a
  // crash and would restart it.
  const pidFile = path.join(path.dirname(infoFile), 'standalone-launcher.pid');
  const stopRequestFile = path.join(path.dirname(infoFile), 'standalone-launcher.stop');
  if (!logger) logger = createLogger({ logFile: path.join(desktopEnv.logsDir, 'standalone.log') });
  if (!openUrl) openUrl = origin => openBrowser(origin, { spawnImpl, platform, logger });
  const killTree = (pid, options) => killProcessTree(pid, options);

  function clearPidFile() {
    try { fs.unlinkSync(pidFile); } catch (_) {}
  }
  function launcherPid() {
    try {
      const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch (_) { return null; }
  }

  // Who else owns this data directory? The pid file is per directory, so a live
  // pid in it is either this process or a duplicate — but liveness alone cannot
  // justify turning a start away: SIGKILL and power loss leave the file behind,
  // and pids get recycled, so an innocent process can be wearing the number. Ask
  // the process what it is. When it cannot be asked (Windows, or `ps` missing)
  // the answer is "not a launcher", never "probably a launcher": the refusal
  // tells the user to run `multicc stop`, and that signals whatever holds the
  // number — an innocent process, on a pid we could not even read. Unverified
  // therefore keeps the old behaviour (the stale file is replaced, the start
  // proceeds) rather than blocking on a guess.
  function otherLauncher(pid = launcherPid()) {
    if (!pid || pid === process.pid || !pidAlive(pid)) return null;
    const commandLine = readProcessCommandLine(pid);
    if (commandLine === null) return null;
    return /standalone-launcher\.js/.test(commandLine) ? { pid, verified: true } : null;
  }

  // Take the data directory. The pid file *is* the single-instance lock, and it
  // is created with O_EXCL rather than written over, so two launchers that
  // start at the same moment cannot both end up supervising a server here. A
  // file left by a launcher that was killed outright is taken over: its pid is
  // dead, or belongs to something that is not a launcher any more.
  function claimPidFile() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.writeFileSync(pidFile, `${process.pid}\n`, { flag: 'wx' });
        return { claimed: true };
      } catch (error) {
        if (error.code !== 'EEXIST') {
          logger.error(`could not write ${pidFile}: ${error.message}`);
          return { claimed: false, error };
        }
      }
      const owner = otherLauncher();
      if (owner) return { claimed: false, owner };
      try { fs.unlinkSync(pidFile); } catch (error) {
        if (error.code !== 'ENOENT') {
          logger.error(`could not replace the stale ${pidFile}: ${error.message}`);
          return { claimed: false, error };
        }
      }
    }
    return { claimed: false };
  }

  function refuseSecondLauncher(owner) {
    logger.error(`another launcher (pid ${owner.pid}) already owns ${desktopEnv.dataRoot}`);
    logger.error('refusing to start a second server on the same data directory: both would write');
    logger.error('the same session files and workspace leases, which wedges the tasks in it.');
    logger.error('run "multicc stop" first (it drains that launcher and its server), then start again.');
    return { started: false, refused: 'launcher-owned', pid: owner.pid, verified: owner.verified === true };
  }

  // Become the supervising launcher: hold this process open and route every way
  // it can be asked to stop into one graceful shutdown. `await new Promise(() =>
  // {})` in main() holds nothing at all — a pending promise is not a handle — so
  // without the interval below the process rests entirely on the server child,
  // and the moment that child exits during a restart backoff the launcher (which
  // IS MultiCC.app, run in the foreground) vanishes with it and the server never
  // comes back. One explicit interval makes "the launcher outlives the server it
  // supervises" true by construction instead of by luck.
  function holdProcess({ supervisor, clearPidFile: clear }) {
    const keepAlive = setInterval(() => {}, 60_000);
    // POSIX signals cannot reach a Windows process, so `--stop` also writes a
    // marker file this launcher polls (see stop()). Unref'd: the marker is not
    // work that has to keep anything alive, keepAlive already does that.
    const stopWatcher = setInterval(() => {
      if (!pendingStopRequest()) return;
      clearStopRequest();
      shutdown('stop request');
    }, 500);
    if (typeof stopWatcher.unref === 'function') stopWatcher.unref();
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const onSignal = signal => { shutdown(signal); };
    let stopping = false;
    const detach = () => {
      clearInterval(keepAlive);
      clearInterval(stopWatcher);
      for (const signal of signals) {
        try { process.removeListener(signal, onSignal); } catch (_) {}
      }
    };
    async function shutdown(signal) {
      if (stopping) return;
      stopping = true;
      logger.log(`received ${signal} — stopping the server`);
      try { await supervisor.stop(); } catch (error) { logger.error(`stop failed: ${error.message}`); }
      clearStopRequest();
      clear();
      detach();
      process.exit(0);
    }
    for (const signal of signals) {
      try { process.on(signal, onSignal); } catch (_) {}
    }
    return {
      shutdown,
      // Hand the process back: used when a start fails, so a caller inside a
      // longer-lived process (tests, the smoke harness) does not keep signal
      // handlers and a keep-alive timer from a launcher that never ran.
      release: detach,
    };
  }

  async function status() {
    const info = readRuntimeInfo(infoFile);
    if (!info || !info.pid || !pidAlive(info.pid)) return { running: false, starting: false, pid: null, origin: null };
    const ready = info.origin ? await probeReady(info.origin, { fetchImpl }) : false;
    return { running: ready, starting: !ready, pid: info.pid, origin: info.origin || null };
  }

  // Windows has no signals. `process.kill(pid, 'SIGTERM')` there terminates the
  // target through TerminateProcess, which would kill the supervising launcher
  // outright and leave the server it started orphaned — the supervisor only
  // drains on request, and the "stop" wrapper would silently leave a live
  // server. So on Windows (and for robustness everywhere) the request goes
  // through a marker file the supervisor polls.
  function writeStopRequest(pid) {
    try {
      fs.writeFileSync(stopRequestFile, `${JSON.stringify({ pid, at: Date.now() })}\n`);
      return true;
    } catch (error) {
      logger.error(`could not write ${stopRequestFile}: ${error.message}`);
      return false;
    }
  }

  function clearStopRequest() {
    try { fs.unlinkSync(stopRequestFile); } catch (_) {}
  }

  function pendingStopRequest(now = Date.now()) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(stopRequestFile, 'utf8')); } catch (_) { return null; }
    if (!raw || raw.pid !== process.pid) return null;
    if (!Number.isFinite(raw.at) || now - raw.at > STOP_REQUEST_TTL_MS || raw.at > now) return null;
    return raw;
  }

  async function stop() {
    const owner = launcherPid();
    let ownerSignalled = false;
    if (owner && owner !== process.pid && pidAlive(owner)) {
      logger.log(`asking the running launcher (pid ${owner}) to stop`);
      if (platform === 'win32') {
        // Ask through the marker; keep the signal as a last resort for a
        // launcher from an older bundle that does not poll for it.
        ownerSignalled = writeStopRequest(owner);
        if (!ownerSignalled) {
          try { process.kill(owner, 'SIGTERM'); ownerSignalled = true; } catch (_) {}
        }
      } else {
        try { process.kill(owner, 'SIGTERM'); ownerSignalled = true; } catch (_) {}
        writeStopRequest(owner);
      }
      // Give the owner time to drain the server over its normal path before we
      // escalate to a tree kill. Wait for the OWNER to go, not just for the
      // server pid to disappear: draining the server is only the first half of
      // its teardown (reclaim + exit follow), and escalating inside that window
      // tree-kills a launcher that was already stopping on its own — on Windows
      // that is a taskkill racing its own orderly exit.
      for (let i = 0; i < 80 && pidAlive(owner); i += 1) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (pidAlive(owner)) {
        // The supervisor is still alive, so it would restart whatever we kill
        // next. Take the whole tree down (taskkill /T on Windows).
        logger.log(`the launcher (pid ${owner}) did not stop — terminating its process tree`);
        killTree(owner, { spawn: spawnImpl, platform });
        for (let i = 0; i < 20 && pidAlive(owner); i += 1) {
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
      clearStopRequest();
      if (!pidAlive(owner)) clearPidFile();
    }
    const result = await reclaimImpl({ infoFile, fetchImpl, spawn: spawnImpl, logger });
    return { ...result, ownerSignalled };
  }

  function detachSelf(args) {
    const launcherPath = fs.existsSync(paths.launcherPath) ? paths.launcherPath : __filename;
    const argv = [
      launcherPath, '--start', DETACH_FLAG,
      ...(args.port ? ['--port', String(args.port)] : []),
      ...(args.data ? ['--data', args.data] : []),
      ...(args.resources ? ['--resources', args.resources] : []),
      args.open ? '--open' : '--no-open',
    ];
    const child = spawnImpl(process.execPath, argv, {
      detached: true, stdio: 'ignore', env: { ...env, MULTICC_STANDALONE_DETACHED: '1' },
    });
    if (child && typeof child.unref === 'function') child.unref();
    return child;
  }

  async function start(args) {
    ensureWritableDirs(desktopEnv);
    const current = await status();
    if (current.running) {
      logger.log(`already running at ${current.origin} (pid ${current.pid}) — nothing to start`);
      if (args.open) openUrl(current.origin);
      return { started: false, origin: current.origin, pid: current.pid };
    }
    // A launcher that is still booting is not "running" yet, and that window is
    // where a second instance used to walk in. /readyz is not answering and the
    // runtime-info file does not exist yet, so the check above reports "nothing
    // to start", reclaim finds no orphan to reclaim, and the newcomer picks the
    // next free port (3001) for a second server on the same data directory.
    // Both then write the same SQLite files and the same lease registry, and the
    // newcomer's recovery pass rewrites the first server's live lease to
    // `uncertain` — every task in that directory stops until the lease expires.
    // The owner's pid file is the one piece of evidence that exists for the
    // whole window, so a duplicate is turned away here, before it detaches.
    const owner = otherLauncher();
    if (owner) return refuseSecondLauncher(owner);
    if (args.detach && env.MULTICC_STANDALONE_DETACHED !== '1' && !args.detachedChild) {
      const child = detachSelf(args);
      logger.log(`starting in the background (pid ${child.pid}); logs: ${desktopEnv.logsDir}`);
      return { started: true, detached: true, pid: child.pid, origin: null };
    }
    // The check above cannot decide a race between two starts that arrive in the
    // same instant (neither pid file exists yet). Claiming the file atomically
    // can, and this is the last point before a server exists.
    const claim = claimPidFile();
    if (!claim.claimed) {
      if (claim.owner) return refuseSecondLauncher(claim.owner);
      throw new Error(`could not take ${pidFile} for this launcher`);
    }
    // A stale or unknown server on this data directory must not fight us for
    // the SQLite files or the port — the same rule the desktop shell applies.
    await reclaimImpl({ infoFile, fetchImpl, spawn: spawnImpl, logger });
    const port = args.port || await findFreePortImpl(startPort);
    const dotenv = readEnvValues(desktopEnv.envFile);
    // supervisor.start() only spawns; readiness arrives through onPhase. Gate
    // on that (or on a failure) instead of reading getState() right away —
    // otherwise "starting" looks like "never became ready".
    let settleReady;
    const readyPromise = new Promise((resolve, reject) => {
      settleReady = { resolve, reject };
    });
    readyPromise.catch(() => {});
    const supervisor = createSupervisor({
      spawn: spawnImpl,
      execPath: process.execPath,
      serverEntry: desktopEnv.serverEntry,
      buildEnv: ({ port: childPort }) => buildStandaloneChildEnv({
        port: childPort, desktopEnv, baseEnv: env, dotenv, runtimeNode,
      }),
      fetchImpl,
      logsDir: desktopEnv.logsDir,
      runtimeInfoFile: infoFile,
      logger,
      onPhase: (phase, info) => {
        if (phase === 'ready') {
          logger.log(`server ready at ${info.origin}`);
          settleReady.resolve({ origin: info.origin, pid: info.pid || null });
        }
        else if (phase === 'starting') logger.log(`starting server on port ${port}`);
        else if (phase === 'respawning') logger.log(`server exited (code=${info.code} signal=${info.signal}); restarting`);
        else if (phase === 'failed') {
          logger.error(`server failed: ${info.reason} — ${(info.failure && info.failure.message) || ''}`);
          settleReady.reject(new Error(`server failed: ${info.reason}`
            + (info.failure && info.failure.message ? ` — ${info.failure.message}` : '')));
        }
      },
    });
    // The supervisor exists from here, so the server can be spawned at any
    // moment — ready or not. Everything that has to hold for the whole life of
    // this launcher is therefore installed now rather than after readiness,
    // because the boot window is a real window: a stop arriving inside it used
    // to kill this process through default signal handling, leaving the server
    // it had already spawned behind. That orphan has no desktop-runtime.json to
    // be found by (it is written only on ready), so nothing could ever reclaim
    // it — and the next start walked to another port and produced two servers on
    // one data directory, the very state the ownership guard above exists to
    // prevent.
    const hold = holdProcess({ supervisor, clearPidFile });
    let ready;
    try {
      await supervisor.start({ port });
      ready = await readyPromise;
    } catch (error) {
      clearPidFile();
      hold.release();
      throw error;
    }
    logger.log(`MultiCC is running at ${ready.origin}`);
    logger.log(`data: ${desktopEnv.dataRoot}`);
    logger.log(`logs: ${desktopEnv.logsDir}`);
    if (args.open) openUrl(ready.origin);
    return {
      started: true,
      origin: ready.origin,
      pid: ready.pid || supervisor.getState().childPid,
      supervisor,
      hold,
      pidFile,
      clearPidFile,
      clearStopRequest,
    };
  }

  return { start, stop, status, detachSelf, paths, desktopEnv, logger, pidFile, launcherPid, otherLauncher };
}

function usage() {
  console.log('MultiCC standalone launcher\n'
    + 'usage: standalone-launcher.js [--start|--stop|--status] [--port <n>] [--no-open] [--detach] [--data <dir>] [--resources <dir>]');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { usage(); return 0; }
  const resources = args.resources ? path.resolve(args.resources) : defaultResourcesDir();
  const env = args.data ? { ...process.env, MULTICC_STANDALONE_HOME: args.data } : process.env;
  const paths = resolveStandalonePaths({ resources, env });
  const logger = createLogger({ logFile: path.join(paths.desktopEnv.logsDir, 'standalone.log') });
  // Running from Gatekeeper's throwaway copy is not fatal, but it is the reason
  // every permission the user grants evaporates — say so instead of letting them
  // discover it as an inexplicable git failure later.
  const gatekeeperWarning = translocationGuidance(__dirname);
  if (gatekeeperWarning) logger.error(gatekeeperWarning);
  if (!fs.existsSync(paths.desktopEnv.serverEntry)) {
    logger.error(`bundle is incomplete: missing ${paths.desktopEnv.serverEntry}`);
    return 1;
  }
  if (!fs.existsSync(paths.runtimeNode)) {
    logger.error(`bundled Node runtime is missing (${paths.runtimeNode})`);
  }
  // PORT in the bundle's config is the *starting* port, not a pin: the launcher
  // still walks forward when it is taken. Without this, "multicc config set PORT"
  // would look honoured while every start went to 3000 anyway.
  const configuredPort = Number.parseInt(readEnvValues(paths.desktopEnv.envFile).PORT, 10);
  const startPort = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
    ? configuredPort
    : DEFAULT_START_PORT;
  const launcher = createLauncher({ paths, env, logger, startPort });

  if (args.mode === 'status') {
    const state = await launcher.status();
    if (state.running) logger.log(`running at ${state.origin} (pid ${state.pid})`);
    else if (state.starting) logger.log(`starting (pid ${state.pid}, not ready yet)`);
    else {
      // "not running" is not the whole truth while a launcher holds the data
      // directory: it may be between spawn attempts, or waiting to restart a
      // server that just exited.
      const owner = launcher.otherLauncher();
      if (owner) logger.log(`server not running; launcher pid ${owner.pid} owns this data directory`);
      else logger.log('not running');
    }
    return 0;
  }
  if (args.mode === 'stop') {
    const result = await launcher.stop();
    if (result.ownerSignalled) logger.log('stopped (launcher signal)');
    else if (result.reclaimed) logger.log(`stopped (${result.method})`);
    else logger.log(`nothing to stop (${result.reason})`);
    return 0;
  }

  let result;
  try {
    result = await launcher.start(args);
  } catch (error) {
    logger.error(error.message);
    return 1;
  }
  // A refusal is a real failure, not a no-op like "already running": the caller
  // asked for a server here and did not get one. `multicc start` propagates this
  // code, so a duplicate launch is visible on the terminal instead of only in the
  // log.
  if (result.refused) return 1;
  if (result.detached || !result.started || !result.supervisor) return 0;

  // Foreground: the launcher owns the child, so closing the terminal window
  // (SIGHUP) stops the server instead of orphaning it, and `--stop` reaches it
  // through the signal/marker handling start() has already installed — installed
  // there, not here, because the boot window needs it too (see holdProcess).
  // This call is what keeps the process alive from now on: a pending promise
  // holds nothing at all.
  await new Promise(() => {});
  return 0;
}

if (require.main === module) {
  main().then(code => { if (code) process.exit(code); }).catch(error => {
    console.error(`[standalone] ${error && error.message}`);
    process.exit(1);
  });
}

module.exports = {
  APP_DIRNAME,
  DEFAULT_START_PORT,
  SQLITE_WARNING,
  STOP_REQUEST_TTL_MS,
  buildStandaloneChildEnv,
  browserCommand,
  createLauncher,
  createLogger,
  defaultResourcesDir,
  main,
  openBrowser,
  parseArgs,
  standaloneDataDir,
  probeReady,
  resolveStandalonePaths,
};
