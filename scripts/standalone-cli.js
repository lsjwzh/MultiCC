#!/usr/bin/env node
'use strict';

// The `multicc` command of a standalone bundle — the only entry point a user
// of an installed MultiCC needs to know.
//
//   multicc start | stop | restart | status | log | url | open
//   multicc update [--check]        swap in a newer standalone release
//   multicc config get|set|path|list
//   multicc service install|uninstall|status
//   multicc version | help
//
// It is a thin, opinionated front end: every lifecycle decision still belongs
// to standalone-launcher.js (which owns the supervisor shared with the desktop
// shell). This file adds the things a *user* needs around it — a stable command
// name, a config file they can edit, a printed URL, and an upgrade path that is
// "download the newer package" instead of "git pull".
//
// Layout (macOS shown; Linux/Windows drop the .app wrapper):
//
//   <root>/multicc                    this command's shell wrapper
//   <root>/MultiCC.app/Contents/Resources/
//       app-server/                   the server (read-only)
//       runtime/                      the pinned Node runtime
//       launcher/                     standalone-launcher.js, this file, lib/
//       bundle-manifest.json          version / platform / arch of this bundle
//
// Writable state never lives here — it goes to the per-user data directory
// (see userDataDir), which is also why updating is a plain package swap.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const LIB_DIR = fs.existsSync(path.join(__dirname, 'lib'))
  ? path.join(__dirname, 'lib')
  : path.resolve(__dirname, '..', 'desktop', 'lib');
const {
  createLogger, openBrowser, probeReady, readStartupState, standaloneDataDir,
} = require(path.join(__dirname, 'standalone-launcher'));
const { pidAlive, readRuntimeInfo } = require(path.join(LIB_DIR, 'orphan-reclaim'));
const { translocationGuidance } = require(path.join(LIB_DIR, 'desktop-env'));

// 独立包的 launcher 与完整 app-server 同级；开发时直接使用仓库模块。
const appSource = fs.existsSync(path.join(__dirname, '..', 'app-server', 'src', 'network', 'outbound.js'))
  ? path.join(__dirname, '..', 'app-server', 'src')
  : path.join(__dirname, '..', 'src');
const networkModule = path.join(appSource, 'network', 'outbound');
// 本地 config/status/stop 不依赖网络模块，残缺安装也能进行本地修复。
const outboundFetch = (...args) => require(networkModule).outboundFetch(...args);
const getChildProxyEnv = (...args) => require(networkModule).getChildProxyEnv(...args);

const REPO = 'lsjwzh/MultiCC';
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const TAIL_LINES = 40;

// ── Layout ──────────────────────────────────────────────────────────────────

// Find the bundle we are part of. Walking up beats guessing: the same file is
// reached as <root>/MultiCC.app/Contents/Resources/launcher/standalone-cli.js
// (macOS), <root>/Resources/launcher/... (Linux/Windows) and
// <repo>/scripts/... when run straight from a checkout.
function resolveLayout({ env = process.env, dirname = __dirname, platform = process.platform } = {}) {
  const resources = path.resolve(env.MULTICC_STANDALONE_RESOURCES || path.join(dirname, '..'));
  const appServerDir = path.join(resources, 'app-server');
  const manifestFile = path.join(resources, 'bundle-manifest.json');
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (_) {}
  if (!manifest) {
    try {
      manifest = { version: JSON.parse(fs.readFileSync(path.join(appServerDir, 'package.json'), 'utf8')).version };
    } catch (_) { manifest = { version: '0.0.0' }; }
  }
  const effectivePlatform = manifest.platform || platform;
  const bundleRoot = env.MULTICC_STANDALONE_ROOT
    ? path.resolve(env.MULTICC_STANDALONE_ROOT)
    : resources.endsWith(path.join('MultiCC.app', 'Contents', 'Resources'))
      ? path.resolve(resources, '..', '..', '..')
      : path.resolve(resources, '..');
  return {
    resources,
    bundleRoot,
    appServerDir,
    manifestFile,
    manifest,
    platform: effectivePlatform,
    arch: manifest.arch || process.arch,
    runtimeNode: effectivePlatform === 'win32'
      ? path.join(resources, 'runtime', 'node.exe')
      : path.join(resources, 'runtime', 'bin', 'node'),
    launcherPath: path.join(resources, 'launcher', 'standalone-launcher.js'),
  };
}

function requireBundle(layout) {
  const missing = [];
  if (!fs.existsSync(path.join(layout.appServerDir, 'server.js'))) missing.push('app-server/server.js');
  if (!fs.existsSync(layout.launcherPath)) missing.push('launcher/standalone-launcher.js');
  if (!fs.existsSync(layout.runtimeNode)) missing.push(`runtime/${path.basename(layout.runtimeNode)}`);
  if (missing.length) {
    process.stderr.write(`[multicc] this bundle is incomplete — missing ${missing.join(', ')}\n`);
    process.stderr.write(`[multicc] looked in ${layout.resources}\n`);
    process.stderr.write('[multicc] reinstall with install.sh/install.ps1, or re-extract the release archive.\n');
    process.exit(1);
  }
  // Every command says it once: run from Gatekeeper's throwaway copy, and the
  // next confusing failure is guaranteed to be this, not whatever the user is
  // about to debug.
  const gatekeeperWarning = translocationGuidance(layout.resources);
  if (gatekeeperWarning) process.stderr.write(gatekeeperWarning + '\n');
}

// ── Config (the bundle's .env) ──────────────────────────────────────────────
// The launcher and the server both read this file (MULTICC_ENV_FILE); the CLI
// only edits it. Keeping it in the user data dir is what makes a package swap
// non-destructive.

function envFilePath(layout, env) {
  return path.join(standaloneDataDir({ env }), 'multicc.env');
}

function readConfigEntries(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  return text.split('\n').map(line => {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    return match ? { key: match[1], value: match[2], line } : { raw: line };
  });
}

function configSet(file, key, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entries = readConfigEntries(file);
  let replaced = false;
  const lines = entries.map(entry => {
    if (entry.key === key) { replaced = true; return `${key}=${value}`; }
    return entry.raw !== undefined ? entry.raw : `${entry.key}=${entry.value}`;
  });
  if (!replaced) lines.push(`${key}=${value}`);
  const text = `${lines.filter(line => line !== '').join('\n')}\n`;
  fs.writeFileSync(file, text, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

function configGet(file, key) {
  const entry = readConfigEntries(file).find(item => item.key === key);
  return entry ? entry.value : '';
}

// ── Launcher delegation ─────────────────────────────────────────────────────

function runLauncher(layout, args, { stdio = 'inherit' } = {}) {
  // The CLI is never the launcher's background child, so a marker inherited
  // from a server started by an older launcher (it leaked into every session
  // terminal and update run) must not reach the launcher it starts.
  const env = { ...process.env };
  delete env.MULTICC_STANDALONE_DETACHED;
  const res = spawnSync(layout.runtimeNode, [layout.launcherPath, ...args], {
    stdio, encoding: 'utf8', env,
  });
  if (res.error) {
    process.stderr.write(`[multicc] could not run the bundle launcher: ${res.error.message}\n`);
    process.exit(1);
  }
  return res;
}

let LOGGER = null;
function logger(layout, env) {
  if (!LOGGER) {
    LOGGER = createLogger({ logFile: path.join(standaloneDataDir({ env }), 'logs', 'multicc.log') });
  }
  return LOGGER;
}

async function currentState(layout, env) {
  const infoFile = path.join(standaloneDataDir({ env }), 'desktop-runtime.json');
  const info = readRuntimeInfo(infoFile);
  if (!info || !info.pid || !pidAlive(info.pid)) return { running: false, pid: null, origin: null };
  const ready = info.origin ? await probeReady(info.origin) : false;
  return { running: ready, starting: !ready, pid: info.pid, origin: info.origin || null };
}

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdStart(layout, env, args) {
  const state = await currentState(layout, env);
  if (state.running && args.port) {
    // Reusing the running instance must not swallow an explicit --port: the
    // caller would walk away believing MultiCC listens where it does not.
    let runningPort = null;
    try { runningPort = Number.parseInt(new URL(state.origin).port, 10); } catch (_) {}
    if (runningPort !== args.port) {
      process.stderr.write(`MultiCC 已在 ${state.origin} 运行，--port ${args.port} 未生效。\n`);
      process.stderr.write(`请先执行 multicc stop，或改用 multicc restart --port ${args.port}。\n`);
      return 1;
    }
  }
  if (state.running) {
    process.stdout.write(`MultiCC is already running at ${state.origin} (pid ${state.pid})\n`);
    // `start` is the one user-facing verb used by the installer and all wrapper
    // scripts. Reusing a service-started instance must still honour its promise
    // to open the UI; otherwise a successful one-click install appears to do
    // nothing after launchd/systemd wins the startup race.
    if (!args.noOpen) openBrowser(state.origin, { platform: layout.platform });
    return 0;
  }
  const launcherArgs = ['--start'];
  // Background by default: a command that returns is what people expect from a
  // service CLI, and `multicc log` already covers watching it.
  if (!args.foreground) launcherArgs.push('--detach');
  if (args.port) launcherArgs.push('--port', String(args.port));
  if (args.noOpen || args.foreground) launcherArgs.push('--no-open');
  if (args.data) launcherArgs.push('--data', args.data);
  const res = runLauncher(layout, launcherArgs);
  if (res.status !== 0) return res.status || 1;
  if (args.foreground) return 0;
  // The detached child prints its own progress into the log, not here — so wait
  // for it to answer /readyz before claiming success.
  const started = await waitUntilReady(layout, env, args.port);
  if (started.origin) {
    process.stdout.write(`MultiCC is running at ${started.origin}\n`);
    process.stdout.write(`  data:  ${standaloneDataDir({ env })}\n`);
    process.stdout.write(`  logs:  ${path.join(standaloneDataDir({ env }), 'logs')}\n`);
    process.stdout.write(`  stop:  multicc stop\n`);
  } else {
    process.stdout.write('MultiCC was started but did not become ready in time.\n');
    process.stdout.write(`Check the logs: multicc log\n`);
    return 1;
  }
  return 0;
}

// A first boot after upgrading converts the task database before it serves
// (35-70s on a large real database, longer on slow disks). While the launcher
// reports that upgrade, waiting does not use up attempts — only this cap.
const MIGRATION_WAIT_MS = 30 * 60_000;

async function waitUntilReady(layout, env, port, {
  attempts = 120, intervalMs = 500, migrationWaitMs = MIGRATION_WAIT_MS, write = text => process.stdout.write(text),
} = {}) {
  const startedAt = Date.now();
  let lastLine = '';
  for (let i = 0; i < attempts; i += 1) {
    const state = await currentState(layout, env);
    if (state.running) return state;
    const migration = readStartupState(standaloneDataDir({ env }))?.migration;
    if (migration && Date.now() - startedAt < migrationWaitMs) {
      i -= 1;
      const line = migration.state === 'failed'
        ? `waiting: ${migration.error?.message || 'upgrade failed'}`
        : `${migration.step} ${migration.percent}%`;
      if (line !== lastLine) write(`Upgrading task data (one time only): ${line}\n`);
      lastLine = line;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return { running: false, origin: null };
}

async function cmdStop(layout, env) {
  const res = runLauncher(layout, ['--stop']);
  if (res.status !== 0) return res.status || 1;
  return 0;
}

async function cmdRestart(layout, env, args) {
  const state = await currentState(layout, env);
  if (!state.running) return state.starting ? 1 : cmdStart(layout, env, args);
  const { requestRustRestart } = require(path.join(layout.appServerDir, 'src', 'server-restart'));
  const binary = path.join(layout.appServerDir, 'native', 'prebuilt', `${layout.platform}-${layout.arch}`,
    layout.platform === 'win32' ? 'restart-supervisor.exe' : 'restart-supervisor');
  const result = await requestRustRestart({ binary, origin: state.origin, expectedPids: [state.pid], port: args.port });
  if (result !== 0 || !args.foreground) return result;
  return holdRestartedForeground(layout, env, binary);
}

// A detached Rust lifeline requests the existing launcher's stop if this CLI
// disappears, including a hard kill; no second server supervisor is started.
async function holdRestartedForeground(layout, env, binary) {
  const data = standaloneDataDir({ env });
  const child = spawn(binary, ['--hold'], { detached: true, windowsHide: true,
    stdio: ['pipe', 'ignore', 'inherit'], env: { ...process.env, MULTICC_RESTART_HOLD: JSON.stringify({ node: layout.runtimeNode, launcher: layout.launcherPath, data }) } });
  child.stdin.on('error', () => {});
  let timer, finished = false, misses = 0;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const stop = () => { if (!finished) child.stdin.end(); };
  for (const signal of signals) { try { process.on(signal, stop); } catch (_) {} }
  return new Promise(resolve => {
    function done(code) {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      for (const signal of signals) { try { process.removeListener(signal, stop); } catch (_) {} }
      resolve(code);
    }
    child.once('error', error => { process.stderr.write(`foreground guard failed: ${error.message}\n`); done(1); });
    child.once('spawn', () => process.stdout.write('MultiCC is running in the foreground; interrupt to stop it.\n'));
    child.once('exit', code => done(code === 0 ? 0 : 1));
    timer = setInterval(() => {
      let pid = 0;
      try { pid = Number(fs.readFileSync(path.join(data, 'standalone-launcher.pid'), 'utf8').trim()); } catch (_) {}
      if (pid > 1 && pidAlive(pid)) { misses = 0; return; }
      if (++misses >= 3) { child.stdin.end('D'); }
    }, 1000);
  });
}

async function cmdStatus(layout, env, args) {
  const state = await currentState(layout, env);
  const configFile = envFilePath(layout, env);
  const migration = state.running ? null : readStartupState(standaloneDataDir({ env }))?.migration || null;
  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      running: state.running,
      starting: Boolean(state.starting),
      migrating: Boolean(migration),
      ...(migration ? { migration } : {}),
      pid: state.pid,
      url: state.origin,
      version: layout.manifest.version,
      platform: layout.platform,
      arch: layout.arch,
      dataDir: standaloneDataDir({ env }),
      configFile,
      bundleRoot: layout.bundleRoot,
    }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`MultiCC ${layout.manifest.version} (${layout.platform}-${layout.arch})\n`);
  if (state.running) {
    process.stdout.write(`  status: running at ${state.origin} (pid ${state.pid})\n`);
  } else if (migration) {
    process.stdout.write(`  status: upgrading task data (one time only), ${migration.state === 'failed' ? migration.error?.message : `${migration.percent}%`}\n`);
  } else if (state.starting) {
    process.stdout.write(`  status: starting (pid ${state.pid}, not ready yet)\n`);
  } else {
    process.stdout.write('  status: not running\n');
  }
  process.stdout.write(`  bundle: ${layout.bundleRoot}\n`);
  process.stdout.write(`  data:   ${standaloneDataDir({ env })}\n`);
  process.stdout.write(`  config: ${configFile}\n`);
  return 0;
}

function logFiles(env) {
  const dir = path.join(standaloneDataDir({ env }), 'logs');
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => name.endsWith('.log')).sort(); } catch (_) { return []; }
  return names.map(name => path.join(dir, name));
}

function cmdLog(env, args) {
  const files = logFiles(env);
  if (!files.length) {
    process.stdout.write('No log files yet — start MultiCC first (multicc start).\n');
    return 0;
  }
  const lines = args.lines || TAIL_LINES;
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    const tail = text.split('\n').filter(Boolean).slice(-lines);
    if (!tail.length) continue;
    process.stdout.write(`==> ${file} <==\n`);
    process.stdout.write(`${tail.join('\n')}\n`);
  }
  if (!args.follow) return 0;
  process.stdout.write('(following — press Ctrl+C to stop)\n');
  const offsets = new Map(files.map(file => [file, safeSize(file)]));
  const timer = setInterval(() => {
    for (const file of logFiles(env)) {
      const size = safeSize(file);
      const previous = offsets.get(file);
      if (previous === undefined) {
        offsets.set(file, size);
        process.stdout.write(`==> ${file} <==\n`);
        continue;
      }
      if (size <= previous) { offsets.set(file, size); continue; }
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        const buffer = Buffer.alloc(size - previous);
        fs.readSync(fd, buffer, 0, buffer.length, previous);
        offsets.set(file, size);
        process.stdout.write(buffer.toString('utf8'));
      } catch (_) {
        // A rotated/removed log is not an error worth stopping the tail for.
      } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
      }
    }
  }, 500);
  process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
  return null; // keep the process alive
}

function safeSize(file) {
  try { return fs.statSync(file).size; } catch (_) { return 0; }
}

async function cmdUrl(layout, env) {
  const state = await currentState(layout, env);
  if (!state.origin) {
    process.stderr.write('MultiCC is not running.\n');
    return 1;
  }
  process.stdout.write(`${state.origin}\n`);
  return 0;
}

async function cmdOpen(layout, env) {
  const state = await currentState(layout, env);
  if (!state.origin) {
    process.stderr.write('MultiCC is not running — start it with: multicc start\n');
    return 1;
  }
  openBrowser(state.origin, { platform: layout.platform });
  return 0;
}

function cmdConfig(layout, env, args) {
  const file = envFilePath(layout, env);
  const [action, key, value] = args.rest;
  if (!action || action === 'path') {
    process.stdout.write(`${file}\n`);
    return 0;
  }
  if (action === 'list') {
    const entries = readConfigEntries(file).filter(entry => entry.key);
    if (!entries.length) process.stdout.write(`(empty — ${file})\n`);
    for (const entry of entries) {
      // ACCESS_TOKEN gates every /api route; print it only when explicitly asked
      // for a single key, never in a listing that ends up in a screenshot.
      const secret = /TOKEN|SECRET|PASSWORD|KEY/i.test(entry.key);
      process.stdout.write(`${entry.key}=${secret ? '********' : entry.value}\n`);
    }
    return 0;
  }
  if (action === 'get') {
    if (!key) { process.stderr.write('usage: multicc config get <KEY>\n'); return 2; }
    const found = configGet(file, key);
    if (!found) return 1;
    process.stdout.write(`${found}\n`);
    return 0;
  }
  if (action === 'set') {
    if (!key || value === undefined) { process.stderr.write('usage: multicc config set <KEY> <VALUE>\n'); return 2; }
    if (key === 'PORT' && (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535)) {
      process.stderr.write(`invalid PORT: ${value} (expected 1-65535)\n`);
      return 2;
    }
    configSet(file, key, value);
    // Setting PORT here is a deliberate choice, not a suggestion: mark it so
    // the launcher uses it verbatim and fails when it is taken instead of
    // walking to the next port. `config unset PORT` clears both.
    if (key === 'PORT') configSet(file, 'PORT_PINNED', '1');
    process.stdout.write(`${key} updated in ${file}\n`);
    return 0;
  }
  if (action === 'unset') {
    if (!key) { process.stderr.write('usage: multicc config unset <KEY>\n'); return 2; }
    const drop = key === 'PORT' ? new Set(['PORT', 'PORT_PINNED']) : new Set([key]);
    const entries = readConfigEntries(file).filter(entry => !drop.has(entry.key));
    fs.writeFileSync(file, `${entries.map(entry => (entry.raw !== undefined ? entry.raw : `${entry.key}=${entry.value}`)).filter(Boolean).join('\n')}\n`, { mode: 0o600 });
    process.stdout.write(`${key} removed from ${file}\n`);
    return 0;
  }
  process.stderr.write(`unknown config action: ${action} (get|set|unset|list|path)\n`);
  return 2;
}

// ── Update ──────────────────────────────────────────────────────────────────
// 版本来自 release，替换安装目录的步骤始终由 main 上的安装器负责。
const UNIX_INSTALLER_URL = `https://raw.githubusercontent.com/${REPO}/main/install.sh`;

async function runUnixInstaller({ bundleRoot, targetVersion, port, env, from, noStart, logPath, fetchImpl = outboundFetch }) {
  const res = await fetchImpl(UNIX_INSTALLER_URL, {
    headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`下载安装脚本失败：HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const length = res.headers.get('content-length');
  // fetch 可能透明解压响应；Content-Length 此时描述的是压缩字节。
  const encoding = res.headers.get('content-encoding');
  if (!body.length || ((!encoding || encoding === 'identity') && length !== null && Number(length) !== body.length)) {
    throw new Error('下载的安装脚本不完整');
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-update-'));
  let logFd;
  try {
    const script = path.join(workDir, 'install.sh');
    fs.writeFileSync(script, body, { mode: 0o600 });
    const args = [script, '--target', 'standalone', '--dir', bundleRoot, '--version', targetVersion, '--no-open'];
    if (port) args.push('--port', String(port));
    if (from) args.push('--from', from);
    if (noStart) args.push('--no-start');
    if (logPath) logFd = fs.openSync(logPath, 'a', 0o600);
    const result = spawnSync('bash', args, {
      cwd: workDir, env, stdio: logPath ? ['ignore', logFd, logFd] : 'inherit',
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    if (logFd !== undefined) fs.closeSync(logFd);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function runInstallerScript(layout, env, { bundleRoot, targetVersion, port, from, noStart, logPath }) {
  const childEnv = await getChildProxyEnv(env);
  if (layout.platform === 'win32') {
    const { startWindowsStandaloneUpdate } = require(path.join(appSource, 'windows-standalone-update'));
    const updateLog = logPath || path.join(standaloneDataDir({ env }), 'logs', 'update.log');
    await startWindowsStandaloneUpdate({
      bundleRoot, targetVersion, port, from, noStart, waitForPid: process.pid, logPath: updateLog, env: childEnv,
    });
    process.stdout.write(`升级已交给 PowerShell，进度和结果请查看 ${updateLog}\n`);
    return 0;
  }
  return runUnixInstaller({ bundleRoot, targetVersion, port, from, noStart, logPath, env: childEnv });
}

async function latestRelease({ fetchImpl = outboundFetch, logger: log } = {}) {
  try {
    const res = await fetchImpl(API_LATEST, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return { tag: String(body.tag_name || '').replace(/^v/, ''), notes: body.html_url || RELEASES_URL };
  } catch (error) {
    // A rate-limited or offline API is not a failed update: say what happened
    // and how to do it by hand rather than pretending the check succeeded.
    log.error(`could not reach GitHub Releases (${error.message})`);
    return null;
  }
}

// Compare release versions without pulling a semver dependency into the tiny
// standalone launcher. Build metadata is ignored; prerelease identifiers follow
// SemVer precedence (2.0.4-beta.2 < 2.0.4). null means either side is malformed,
// which makes update fail closed instead of guessing and replacing a newer tree.
function compareVersions(left, right) {
  const parse = value => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value || '').trim());
    if (!match) return null;
    return {
      core: match.slice(1, 4).map(Number),
      pre: match[4] ? match[4].split('.') : [],
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let i = 0; i < a.core.length; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  }
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < length; i += 1) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    if (a.pre[i] === b.pre[i]) continue;
    const aNumeric = /^\d+$/.test(a.pre[i]);
    const bNumeric = /^\d+$/.test(b.pre[i]);
    if (aNumeric && bNumeric) return Number(a.pre[i]) > Number(b.pre[i]) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a.pre[i] > b.pre[i] ? 1 : -1;
  }
  return 0;
}

// Where the read-only payload of a bundle root lives.
function bundleResources(root, platform) {
  return platform === 'win32' || platform === 'linux'
    ? path.join(root, 'Resources')
    : path.join(root, 'MultiCC.app', 'Contents', 'Resources');
}

// ── Hand-installed plugins across an upgrade ────────────────────────────────

// A plugin someone installed by hand sits next to the built-in ones in the
// package's app-server/plugins/ (a private plugin's README tells people to copy
// it there). Every upgrade replaces the whole package, so before the old tree is
// deleted, each plugin the old package did not ship itself is copied into the
// new one. Copied, not moved: until the upgrade is committed the old tree must
// stay whole, because a failed start puts it back.
//
// "Did not ship" is the old bundle-manifest.json's builtinPlugins. Packages from
// before that list shipped one plugin (chrome-proxy-launcher), so for them an id
// the new package also ships is taken to be that same built-in. A plugin whose id
// a newer package now ships as a built-in gives way to it; the user's copy is kept
// under <data>/plugins-backup/ instead of being dropped.
function previousPluginsDir(root, platform) {
  const bundled = path.join(bundleResources(root, platform), 'app-server', 'plugins');
  if (fs.existsSync(bundled)) return bundled;
  // A source checkout: what install.sh keeps when it upgrades a pre-standalone install.
  const checkout = path.join(root, 'plugins');
  return fs.existsSync(path.join(root, 'server.js')) && fs.existsSync(checkout) ? checkout : null;
}

function shippedPlugins(root, platform) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(bundleResources(root, platform), 'bundle-manifest.json'), 'utf8')).builtinPlugins;
    return Array.isArray(list) ? new Set(list) : null;
  } catch (_) {
    return null;
  }
}

function pathTaken(file) {
  try { fs.lstatSync(file); return true; } catch (_) { return false; }
}

// Not fs.cpSync: on an unreadable directory it aborts the whole process from
// native code instead of throwing, and the installer needs its per-plugin failure report. Links are copied as they are (relative ones still resolve: the new
// tree has the old one's shape); permissions come along, so bin/ stays executable.
function copyPluginTree(source, dest) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), dest);
  } else if (stat.isDirectory()) {
    fs.mkdirSync(dest);
    for (const name of fs.readdirSync(source)) copyPluginTree(path.join(source, name), path.join(dest, name));
    fs.chmodSync(dest, stat.mode & 0o7777);
  } else if (stat.isFile()) {
    fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dest, stat.mode & 0o7777);
  }
}

// Returns what it did; a plugin it could not copy is in `failed` (the others
// are still copied) and the caller keeps the old tree on disk.
function carryUserPlugins({ oldRoot, newRoot, platform, env = process.env, now = Date.now(), logger: log = console }) {
  const result = { kept: [], backedUp: [], failed: [] };
  const from = previousPluginsDir(oldRoot, platform);
  if (!from) return result;
  const to = path.join(bundleResources(newRoot, platform), 'app-server', 'plugins');
  const shipped = shippedPlugins(oldRoot, platform);
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    // Only plugins: bridges/, cron/ and the like are part of the package itself.
    if (!(entry.isDirectory() || entry.isSymbolicLink()) || !fs.existsSync(path.join(source, 'plugin.json'))) continue;
    if (shipped && shipped.has(entry.name)) continue;
    let dest = path.join(to, entry.name);
    const builtInNow = pathTaken(dest);
    if (builtInNow && !shipped) continue;
    if (builtInNow) dest = path.join(standaloneDataDir({ env }), 'plugins-backup', `${entry.name}-${stamp}`);
    // Into a dot-name first, so a copy cut short never looks like a plugin.
    const partial = path.join(path.dirname(dest), `.${path.basename(dest)}.copying-${process.pid}`);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.rmSync(partial, { recursive: true, force: true });
      copyPluginTree(source, partial);
      fs.renameSync(partial, dest);
    } catch (error) {
      try { fs.rmSync(partial, { recursive: true, force: true }); } catch (_) {}
      result.failed.push({ id: entry.name, error: error.message });
      log.error(`could not copy plugin ${entry.name}: ${error.message}`);
      continue;
    }
    if (builtInNow) {
      result.backedUp.push({ id: entry.name, path: dest });
      log.log(`plugin ${entry.name} is built in now; your copy is kept at ${dest}`);
    } else {
      result.kept.push(entry.name);
      log.log(`kept plugin ${entry.name} from the previous installation`);
    }
  }
  return result;
}

// Internal: run by install.sh / install.ps1 from the NEW package, pointing at
// the directory the previous installation was moved aside to.
function cmdCarryPlugins(layout, env, args) {
  if (!args.from) {
    process.stderr.write('__carry-plugins needs --from <previous installation>\n');
    return 2;
  }
  try {
    const { failed } = carryUserPlugins({
      oldRoot: path.resolve(args.from), newRoot: layout.bundleRoot, platform: layout.platform, env,
      logger: { log: line => process.stdout.write(`  ${line}\n`), error: line => process.stderr.write(`  ${line}\n`) },
    });
    return failed.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(`could not copy plugins from ${args.from}: ${error.message}\n`);
    return 1;
  }
}

// 老版本升级时会启动新包中的 __swap。兼容这个入口，让统一安装器复核旧版
// 已下载的归档和校验文件；它的旧调用方通常在交接前已经停止了服务。
async function cmdLegacySwap(layout, env, args) {
  if (!args.root || !args.staged || !/^\d+\.\d+\.\d+$/.test(args.version)) {
    throw new Error('旧版升级交接缺少目标目录、暂存目录或发布版本');
  }
  const log = logger(layout, env);
  const logPath = env.MULTICC_UPDATE_LOG || path.join(standaloneDataDir({ env }), 'logs', 'update.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  let code = 1;
  try {
    const pid = Number(args.waitPid);
    for (let i = 0; i < 240 && pid > 0 && pidAlive(pid); i += 1) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (pid > 0 && pidAlive(pid)) throw new Error('旧升级进程未退出');
    const ext = layout.platform === 'win32' ? 'zip' : 'tar.gz';
    const name = `multicc-standalone-${args.version}-${layout.platform}-${layout.arch}.${ext}`;
    const archive = path.join(path.dirname(path.resolve(args.staged)), name);
    code = await runInstallerScript(layout, env, {
      bundleRoot: path.resolve(args.root), targetVersion: `v${args.version}`, noStart: !args.restart, logPath,
      from: fs.existsSync(archive) && fs.existsSync(`${archive}.sha256`) ? archive : undefined,
    });
  } catch (error) {
    log.error(error.message);
    fs.appendFileSync(logPath, `${error.message}\n`);
  }
  // Windows 后台 PowerShell 会在真正结束时写入退出码。
  if (layout.platform !== 'win32' || code !== 0) {
    if (code !== 0) {
      const launcher = path.join(args.root, layout.platform === 'win32' ? 'multicc.cmd' : 'multicc');
      const message = `升级未完成；请检查上述日志和安装目录，使用 "${launcher}" start 启动该安装。`;
      log.error(message);
      fs.appendFileSync(logPath, `${message}\n`);
    }
    fs.appendFileSync(logPath, `__MULTICC_UPDATE_EXIT__ ${code}\n`);
  }
  return code;
}

async function cmdUpdate(layout, env, args) {
  const log = logger(layout, env);
  const current = layout.manifest.version;
  if (layout.platform === 'darwin' && process.platform !== 'darwin') {
    process.stderr.write('[multicc] this bundle belongs to another platform; update it there.\n');
    return 1;
  }
  const release = await latestRelease({ logger: log });
  if (!release) {
    process.stderr.write(`Could not check for updates. Download manually: ${RELEASES_URL}\n`);
    return 1;
  }
  const comparison = compareVersions(release.tag, current);
  if (args.check) {
    process.stdout.write(`installed: ${current}\nlatest:    ${release.tag}\n`);
    if (comparison === null) {
      process.stderr.write('Could not compare these versions safely; no update will be attempted.\n');
      return 1;
    }
    if (comparison < 0) process.stdout.write('status:    installed version is newer (no downgrade)\n');
    else if (comparison === 0) process.stdout.write('status:    up to date\n');
    else process.stdout.write('status:    update available\n');
    return 0;
  }
  if (comparison === null) {
    process.stderr.write(`Could not compare installed version ${current} with release ${release.tag}; refusing to replace it.\n`);
    return 1;
  }
  if (comparison === 0) {
    process.stdout.write(`MultiCC ${current} is already the latest release.\n`);
    return 0;
  }
  if (comparison < 0) {
    process.stdout.write(`MultiCC ${current} is newer than the latest published release (${release.tag}); no downgrade was performed.\n`);
    return 0;
  }
  process.stdout.write(`正在更新 MultiCC ${current} → ${release.tag}…\n`);
  try {
    return await runInstallerScript(layout, env, {
      bundleRoot: layout.bundleRoot, targetVersion: `v${release.tag}`, port: args.port,
    });
  } catch (error) {
    log.error(`升级失败：${error.message}`);
    return 1;
  }
}

// ── Service (auto-start on login) ───────────────────────────────────────────
// Optional, and deliberately the only platform-specific part of the CLI: the
// bundle itself is uniform, but "start this on login" has no portable answer.

function serviceUnitPath(platform, home = os.homedir(), env = process.env) {
  if (platform === 'darwin') return path.join(home, 'Library', 'LaunchAgents', 'com.multicc.server.plist');
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'MultiCC.vbs');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', 'multicc.service');
}

function windowsStartupScript(runtimeNode, launcherPath) {
  // A Startup-folder .vbs keeps the login launch invisible. The real process
  // remains the same shared standalone launcher used on macOS/Linux; this is
  // only the OS-specific way to ask Windows to run it at sign-in.
  const command = `"${runtimeNode}" "${launcherPath}" --start --no-open`;
  const quoted = command.replace(/"/g, '""');
  return [
    'Set shell = CreateObject("WScript.Shell")',
    'shell.Environment("Process")("MULTICC_SERVICE") = "1"',
    `shell.Run "${quoted}", 0, False`,
    '',
  ].join('\r\n');
}

function writeUtf16LeBom(file, text) {
  const bom = Buffer.from([0xff, 0xfe]);
  fs.writeFileSync(file, Buffer.concat([bom, Buffer.from(text, 'utf16le')]));
}

function cmdService(layout, env, args) {
  const [action] = args.rest;
  const platform = layout.platform || process.platform;
  const home = os.homedir();
  const unit = serviceUnitPath(platform, home, env);
  if (!action || action === 'status') {
    if (!fs.existsSync(unit)) { process.stdout.write('Auto-start is not installed.\n'); return 1; }
    if (platform === 'darwin') {
      const res = spawnSync('launchctl', ['list'], { encoding: 'utf8' });
      const loaded = res.status === 0 && /com\.multicc\.server/.test(res.stdout || '');
      process.stdout.write(`Auto-start installed at ${unit} (${loaded ? 'loaded' : 'not loaded'})\n`);
      return loaded ? 0 : 1;
    }
    if (platform === 'win32') {
      process.stdout.write(`Auto-start installed at ${unit} (starts at user login)\n`);
      return 0;
    }
    const res = spawnSync('systemctl', ['--user', 'is-enabled', 'multicc'], { encoding: 'utf8' });
    process.stdout.write(`Auto-start installed at ${unit} (${String(res.stdout || '').trim() || 'unknown'})\n`);
    return res.status === 0 ? 0 : 1;
  }
  if (action === 'uninstall') {
    if (platform === 'darwin') {
      spawnSync('launchctl', ['unload', unit], { stdio: 'ignore' });
    } else if (platform === 'linux') {
      spawnSync('systemctl', ['--user', 'disable', '--now', 'multicc'], { stdio: 'ignore' });
    }
    try { fs.unlinkSync(unit); } catch (_) {}
    process.stdout.write('Auto-start removed.\n');
    return 0;
  }
  if (action !== 'install') {
    process.stderr.write(`unknown service action: ${action} (install|uninstall|status)\n`);
    return 2;
  }
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  // launchd/systemd keep the launcher alive, so it runs in the foreground and
  // never opens a browser on boot (--no-open); `multicc open` is the way in.
  const argv = [layout.runtimeNode, layout.launcherPath, '--start', '--no-open'];
  if (platform === 'win32') {
    writeUtf16LeBom(unit, windowsStartupScript(layout.runtimeNode, layout.launcherPath));
    process.stdout.write('Auto-start installed: MultiCC starts silently at user login.\n');
    return 0;
  }
  if (platform === 'darwin') {
    fs.writeFileSync(unit, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.multicc.server</string>
  <key>ProgramArguments</key>
  <array>${argv.map(a => `<string>${a}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(standaloneDataDir({ env }), 'logs', 'service.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(standaloneDataDir({ env }), 'logs', 'service-error.log')}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${path.dirname(layout.runtimeNode)}:/usr/local/bin:/usr/bin:/bin</string><key>MULTICC_SERVICE</key><string>1</string></dict>
</dict>
</plist>
`);
    spawnSync('launchctl', ['unload', unit], { stdio: 'ignore' });
    const load = spawnSync('launchctl', ['load', unit], { encoding: 'utf8' });
    if (load.status !== 0) {
      process.stderr.write(`launchctl load failed: ${load.stderr || ''}\n`);
      return 1;
    }
    process.stdout.write('Auto-start installed: MultiCC starts on login and restarts on crash.\n');
    return 0;
  }
  if (platform === 'linux') {
    fs.mkdirSync(path.join(standaloneDataDir({ env }), 'logs'), { recursive: true });
    fs.writeFileSync(unit, `[Unit]
Description=MultiCC standalone server
After=network.target

[Service]
ExecStart=${argv.join(' ')}
Environment=MULTICC_SERVICE=1
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`);
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    const enable = spawnSync('systemctl', ['--user', 'enable', '--now', 'multicc'], { encoding: 'utf8' });
    if (enable.status !== 0) {
      process.stderr.write(`systemctl enable failed: ${enable.stderr || ''}\n`);
      return 1;
    }
    process.stdout.write('Auto-start installed: MultiCC starts on login and restarts on crash.\n');
    return 0;
  }
  process.stderr.write(`Auto-start is not supported on ${platform}; start MultiCC with "multicc start".\n`);
  return 1;
}

// ── Argument parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    command: null, rest: [], port: null, data: null, noOpen: false, foreground: false,
    check: false, restart: false, json: false, follow: false, lines: null,
    waitPid: null, root: null, staged: null, version: null, from: null, help: false,
  };
  const takesValue = new Set(['--port', '--data', '--lines', '--wait-pid', '--root', '--staged', '--version', '--from']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (takesValue.has(arg)) {
      const value = argv[++i];
      if (arg === '--port') {
        const port = Number.parseInt(value, 10);
        if (!/^\d+$/.test(String(value)) || port < 1 || port > 65535) {
          process.stderr.write(`invalid --port: ${value} (expected 1-65535)\n`);
          process.exit(2);
        }
        args.port = port;
      }
      else if (arg === '--data') args.data = value;
      else if (arg === '--lines') args.lines = Number.parseInt(value, 10);
      else if (arg === '--wait-pid') args.waitPid = value;
      else if (arg === '--root') args.root = value;
      else if (arg === '--staged') args.staged = value;
      else if (arg === '--version') args.version = value;
      else if (arg === '--from') args.from = value;
    } else if (arg === '--no-open') args.noOpen = true;
    else if (arg === '-f' || arg === '--foreground') args.foreground = true;
    else if (arg === '--check') args.check = true;
    else if (arg === '--restart') args.restart = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--follow') args.follow = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('-')) { process.stderr.write(`unknown option: ${arg}\n`); process.exit(2); }
    else if (!args.command) args.command = arg;
    else args.rest.push(arg);
  }
  return args;
}

const HELP = `MultiCC ${'%VERSION%'} — standalone

usage: multicc <command> [options]

  start        Start MultiCC in the background (use -f to stay in the foreground)
  stop         Stop it gracefully (in-flight replies are flushed first)
  restart      stop, then start
  status       Show version, state, URL and where data lives (--json for machines)
  log          Show the last log lines (--follow to keep watching)
  url          Print the local URL
  open         Open the interface in your browser
  update       Install the latest standalone release (--check to only compare)
  config       get <KEY> | set <KEY> <VALUE> | unset <KEY> | list | path
  service      install | uninstall | status   (auto-start on login)
  version      Print the installed version
  help         Show this message

Options: --port <n>  --data <dir>  --no-open

Data (sessions, providers, chat history) lives outside this bundle, so updating
never touches it. Run "multicc status" to see exactly where.`;

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const layout = resolveLayout();
  const env = args.data ? { ...process.env, MULTICC_STANDALONE_HOME: args.data } : process.env;
  if (args.help || !args.command || args.command === 'help') {
    process.stdout.write(`${HELP.replace('%VERSION%', layout.manifest.version)}\n`);
    return args.command || args.help ? 0 : 1;
  }
  if (args.command === 'version' || args.command === '--version') {
    process.stdout.write(`${layout.manifest.version}\n`);
    return 0;
  }
  // Everything below actually runs the server, so the bundle has to be whole.
  if (args.command !== '__swap') requireBundle(layout);
  switch (args.command) {
    case '__swap': return cmdLegacySwap(layout, env, args);
    case '__carry-plugins': return cmdCarryPlugins(layout, env, args);
    case 'start': return cmdStart(layout, env, args);
    case 'stop': return cmdStop(layout, env);
    case 'restart': return cmdRestart(layout, env, args);
    case 'status': return cmdStatus(layout, env, args);
    case 'log': case 'logs': return cmdLog(env, args);
    case 'url': return cmdUrl(layout, env);
    case 'open': return cmdOpen(layout, env);
    case 'update': case 'upgrade': return cmdUpdate(layout, env, args);
    case 'config': return cmdConfig(layout, env, args);
    case 'service': return cmdService(layout, env, args);
    default:
      process.stderr.write(`unknown command: ${args.command}\n\n${HELP.replace('%VERSION%', layout.manifest.version)}\n`);
      return 2;
  }
}

if (require.main === module) {
  main().then(code => { if (code) process.exit(code); }).catch(error => {
    process.stderr.write(`[multicc] ${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
}

module.exports = {
  HELP,
  bundleResources,
  carryUserPlugins,
  compareVersions,
  configGet,
  configSet,
  envFilePath,
  latestRelease,
  main,
  parseArgs,
  resolveLayout,
  runUnixInstaller,
  serviceUnitPath,
  windowsStartupScript,
};
