#!/usr/bin/env node
'use strict';

// Portable launcher — the entry point of a self-contained MultiCC bundle,
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
// directory (see portableDataDir), so replacing or upgrading the bundle keeps
// sessions, providers and chat history.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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
  resolveDesktopEnv, buildChildEnv, readEnvValues, ensureWritableDirs,
} = require(path.join(LIB_DIR, 'desktop-env'));

const APP_DIRNAME = 'MultiCCPortable';
const DEFAULT_START_PORT = 3000;
const DETACH_FLAG = '--detached-child';
// Node prints "SQLite is an experimental feature" the first time node:sqlite
// loads. Every launch would otherwise log it.
const SQLITE_WARNING = 'ExperimentalWarning';
// How long a stray stop request stays actionable. Old requests are ignored, so
// a crashed launcher can never pass its request on to a fresh one.
const STOP_REQUEST_TTL_MS = 5 * 60 * 1000;

function defaultResourcesDir({ env = process.env, dirname = __dirname } = {}) {
  return path.resolve(env.MULTICC_PORTABLE_RESOURCES || path.join(dirname, '..'));
}

// Electron's userData conventions, so the bundle behaves like a normal app
// instead of scattering files next to the binary. MULTICC_PORTABLE_HOME
// overrides it (tests, USB-stick installs, side-by-side runs).
function portableDataDir({
  platform = process.platform, env = process.env, homedir = os.homedir(),
} = {}) {
  if (env.MULTICC_PORTABLE_HOME) return path.resolve(env.MULTICC_PORTABLE_HOME);
  if (platform === 'darwin') return path.join(homedir, 'Library', 'Application Support', APP_DIRNAME);
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
    return path.join(appData, APP_DIRNAME);
  }
  const configHome = env.XDG_CONFIG_HOME || path.join(homedir, '.config');
  return path.join(configHome, APP_DIRNAME);
}

function resolvePortablePaths({
  resources = defaultResourcesDir(),
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
} = {}) {
  const userData = portableDataDir({ platform, env, homedir });
  return {
    resources,
    userData,
    runtimeDir: path.join(resources, 'runtime'),
    // The official Windows zip keeps node.exe at the runtime root; the unix
    // tarballs keep it in bin/. The bundle builder mirrors this exactly
    // (scripts/portable-bundle.js runtimeNodePath) — keep the two in step.
    runtimeNode: platform === 'win32'
      ? path.join(resources, 'runtime', 'node.exe')
      : path.join(resources, 'runtime', 'bin', 'node'),
    launcherPath: path.join(resources, 'launcher', 'portable-launcher.js'),
    desktopEnv: resolveDesktopEnv({ isPackaged: true, resourcesPath: resources, userData }),
  };
}

// The server child runs under the bundled runtime, and that same runtime must
// win on PATH: `claude`/`codex`/other Node-based CLIs spawned for a session
// would otherwise fall back to whatever (too old) Node the host has.
function buildPortableChildEnv({ port, desktopEnv, baseEnv = {}, dotenv = {}, runtimeNode }) {
  const env = buildChildEnv({ port, desktopEnv, baseEnv, dotenv });
  if (runtimeNode) {
    const binDir = path.dirname(runtimeNode);
    env.PATH = env.PATH ? `${binDir}${path.delimiter}${env.PATH}` : binDir;
  }
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
    const line = `${new Date().toISOString()} [portable] ${message}`;
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

function createLauncher({
  paths = resolvePortablePaths(),
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
} = {}) {
  const desktopEnv = paths.desktopEnv;
  const runtimeNode = paths.runtimeNode;
  const infoFile = desktopEnv.runtimeInfoFile;
  // The supervising launcher records its own pid so `--stop` (and the "停止
  // MultiCC" wrapper) can ask it to drain instead of yanking the server out
  // from under it: the supervisor treats a child that exits on its own as a
  // crash and would restart it.
  const pidFile = path.join(path.dirname(infoFile), 'portable-launcher.pid');
  const stopRequestFile = path.join(path.dirname(infoFile), 'portable-launcher.stop');
  if (!logger) logger = createLogger({ logFile: path.join(desktopEnv.logsDir, 'portable.log') });
  if (!openUrl) openUrl = origin => openBrowser(origin, { spawnImpl, platform, logger });
  const killTree = (pid, options) => killProcessTree(pid, options);

  function writePidFile() {
    try { fs.writeFileSync(pidFile, `${process.pid}\n`); } catch (error) {
      logger.error(`could not write ${pidFile}: ${error.message}`);
    }
  }
  function clearPidFile() {
    try { fs.unlinkSync(pidFile); } catch (_) {}
  }
  function launcherPid() {
    try {
      const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch (_) { return null; }
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
      // escalate to a tree kill.
      for (let i = 0; i < 80; i += 1) {
        const info = readRuntimeInfo(infoFile);
        if (!info || !info.pid || !pidAlive(info.pid)) break;
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
      detached: true, stdio: 'ignore', env: { ...env, MULTICC_PORTABLE_DETACHED: '1' },
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
    if (args.detach && env.MULTICC_PORTABLE_DETACHED !== '1' && !args.detachedChild) {
      const child = detachSelf(args);
      logger.log(`starting in the background (pid ${child.pid}); logs: ${desktopEnv.logsDir}`);
      return { started: true, detached: true, pid: child.pid, origin: null };
    }
    writePidFile();
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
      buildEnv: ({ port: childPort }) => buildPortableChildEnv({
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
    let ready;
    try {
      await supervisor.start({ port });
      ready = await readyPromise;
    } catch (error) {
      clearPidFile();
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
      pidFile,
      clearPidFile,
      clearStopRequest,
      // Polled rather than signalled: see the Windows note in stop(). Returns a
      // timer so the caller can keep it from holding the event loop open.
      watchStopRequest: onRequest => {
        let fired = false;
        return setInterval(() => {
          if (fired || !pendingStopRequest()) return;
          fired = true;
          clearStopRequest();
          onRequest();
        }, 500);
      },
    };
  }

  return { start, stop, status, detachSelf, paths, desktopEnv, logger, pidFile, launcherPid };
}

function usage() {
  console.log('MultiCC portable launcher\n'
    + 'usage: portable-launcher.js [--start|--stop|--status] [--port <n>] [--no-open] [--detach] [--data <dir>] [--resources <dir>]');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { usage(); return 0; }
  const resources = args.resources ? path.resolve(args.resources) : defaultResourcesDir();
  const env = args.data ? { ...process.env, MULTICC_PORTABLE_HOME: args.data } : process.env;
  const paths = resolvePortablePaths({ resources, env });
  const logger = createLogger({ logFile: path.join(paths.desktopEnv.logsDir, 'portable.log') });
  if (!fs.existsSync(paths.desktopEnv.serverEntry)) {
    logger.error(`bundle is incomplete: missing ${paths.desktopEnv.serverEntry}`);
    return 1;
  }
  if (!fs.existsSync(paths.runtimeNode)) {
    logger.error(`bundled Node runtime is missing (${paths.runtimeNode})`);
  }
  const launcher = createLauncher({ paths, env, logger });

  if (args.mode === 'status') {
    const state = await launcher.status();
    if (state.running) logger.log(`running at ${state.origin} (pid ${state.pid})`);
    else if (state.starting) logger.log(`starting (pid ${state.pid}, not ready yet)`);
    else logger.log('not running');
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
  if (result.detached || !result.started || !result.supervisor) return 0;

  // Foreground: the launcher owns the child, so closing the terminal window
  // (SIGHUP) stops the server instead of orphaning it. SIGINT/SIGTERM are the
  // POSIX path; on Windows only SIGHUP and SIGINT are ever delivered (Ctrl+C,
  // console close), and `--stop` arrives as the marker file below.
  const supervisor = result.supervisor;
  const clearPidFile = result.clearPidFile || (() => {});
  let stopping = false;
  const shutdown = async signal => {
    if (stopping) return;
    stopping = true;
    logger.log(`received ${signal} — stopping the server`);
    try { await supervisor.stop(); } catch (error) { logger.error(`stop failed: ${error.message}`); }
    result.clearStopRequest?.();
    clearPidFile();
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try { process.on(signal, () => { shutdown(signal); }); } catch (_) {}
  }
  const stopWatcher = result.watchStopRequest
    ? result.watchStopRequest(() => shutdown('stop request'))
    : null;
  if (stopWatcher && typeof stopWatcher.unref === 'function') stopWatcher.unref();
  await new Promise(() => {});
  return 0;
}

if (require.main === module) {
  main().then(code => { if (code) process.exit(code); }).catch(error => {
    console.error(`[portable] ${error && error.message}`);
    process.exit(1);
  });
}

module.exports = {
  APP_DIRNAME,
  DEFAULT_START_PORT,
  SQLITE_WARNING,
  STOP_REQUEST_TTL_MS,
  buildPortableChildEnv,
  browserCommand,
  createLauncher,
  createLogger,
  defaultResourcesDir,
  main,
  openBrowser,
  parseArgs,
  portableDataDir,
  probeReady,
  resolvePortablePaths,
};
