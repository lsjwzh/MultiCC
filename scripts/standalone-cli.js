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
const crypto = require('crypto');

const LIB_DIR = fs.existsSync(path.join(__dirname, 'lib'))
  ? path.join(__dirname, 'lib')
  : path.resolve(__dirname, '..', 'desktop', 'lib');
const {
  createLogger, openBrowser, probeReady, standaloneDataDir,
} = require(path.join(__dirname, 'standalone-launcher'));
const { pidAlive, readRuntimeInfo } = require(path.join(LIB_DIR, 'orphan-reclaim'));

const REPO = 'lsjwzh/MultiCC';
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const ARCHIVE_EXT = { win32: 'zip' };
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
    process.stderr.write('[multicc] reinstall with install.sh, or re-extract the release archive.\n');
    process.exit(1);
  }
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
  const res = spawnSync(layout.runtimeNode, [layout.launcherPath, ...args], {
    stdio, encoding: 'utf8',
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
  if (state.running) {
    process.stdout.write(`MultiCC is already running at ${state.origin} (pid ${state.pid})\n`);
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

async function waitUntilReady(layout, env, port, { attempts = 120 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const state = await currentState(layout, env);
    if (state.running) return state;
    if (state.origin && !state.running) {
      // Wait for readiness on the origin the launcher recorded, even when the
      // requested port was taken and it moved on to another one.
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return { running: false, origin: null };
}

async function cmdStop(layout, env) {
  const res = runLauncher(layout, ['--stop']);
  if (res.status !== 0) return res.status || 1;
  return 0;
}

async function cmdRestart(layout, env, args) {
  await cmdStop(layout, env);
  return cmdStart(layout, env, args);
}

async function cmdStatus(layout, env, args) {
  const state = await currentState(layout, env);
  const configFile = envFilePath(layout, env);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      running: state.running,
      starting: Boolean(state.starting),
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
    configSet(file, key, value);
    process.stdout.write(`${key} updated in ${file}\n`);
    return 0;
  }
  if (action === 'unset') {
    if (!key) { process.stderr.write('usage: multicc config unset <KEY>\n'); return 2; }
    const entries = readConfigEntries(file).filter(entry => entry.key !== key);
    fs.writeFileSync(file, `${entries.map(entry => (entry.raw !== undefined ? entry.raw : `${entry.key}=${entry.value}`)).filter(Boolean).join('\n')}\n`, { mode: 0o600 });
    process.stdout.write(`${key} removed from ${file}\n`);
    return 0;
  }
  process.stderr.write(`unknown config action: ${action} (get|set|unset|list|path)\n`);
  return 2;
}

// ── Update ──────────────────────────────────────────────────────────────────
// The standalone release *is* the upgrade: there is no dependency tree to
// reconcile, so "update" means download the newer package, verify it, swap the
// bundle directory, keep the data directory. User state lives outside the
// bundle, which is what makes this a rename instead of a migration.

function archiveName(version, platform, arch) {
  return `multicc-standalone-${version}-${platform}-${arch}.${ARCHIVE_EXT[platform] || 'tar.gz'}`;
}

function assetUrl(version, asset) {
  return `${RELEASES_URL}/download/v${version}/${asset}`;
}

async function latestRelease({ fetchImpl = fetch, logger: log } = {}) {
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

async function downloadTo(url, dest, { fetchImpl = fetch, logger: log } = {}) {
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error(`empty download from ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buffer);
  log.log(`downloaded ${path.basename(dest)} (${(buffer.length / 1048576).toFixed(1)} MB)`);
  return dest;
}

function verifyChecksum(file, checksumText) {
  const expected = String(checksumText).trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('published checksum is not a SHA-256 digest');
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (actual !== expected) throw new Error(`checksum mismatch: expected ${expected}, got ${actual}`);
  return actual;
}

// Where the read-only payload of a bundle root lives.
function bundleResources(root, platform) {
  return platform === 'win32' || platform === 'linux'
    ? path.join(root, 'Resources')
    : path.join(root, 'MultiCC.app', 'Contents', 'Resources');
}

function runtimeNodeIn(resources, platform) {
  return platform === 'win32'
    ? path.join(resources, 'runtime', 'node.exe')
    : path.join(resources, 'runtime', 'bin', 'node');
}

// Both archives carry the bundle's own top-level directory (the tar with
// --strip-components, the zip as its first path segment), so win32 has to shed
// that segment by hand or the swap would nest a bundle inside a bundle.
function extractArchive({ archive, dest, platform, logger: log }) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  if (platform === 'win32') {
    const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dest}' -Force`], { stdio: 'inherit' });
    if (res.status !== 0) throw new Error('Expand-Archive failed');
    const entries = fs.readdirSync(dest).map(name => path.join(dest, name));
    if (entries.length === 1 && fs.statSync(entries[0]).isDirectory()) {
      const inner = entries[0];
      for (const name of fs.readdirSync(inner)) fs.renameSync(path.join(inner, name), path.join(dest, name));
      fs.rmSync(inner, { recursive: true, force: true });
    }
  } else {
    const res = spawnSync('tar', ['-xzf', archive, '-C', dest, '--strip-components=1'], { stdio: 'inherit' });
    if (res.status !== 0) throw new Error(`tar failed (status ${res.status})`);
  }
  log.log(`extracted into ${dest}`);
  return dest;
}

// The swap can never happen in-process: the running CLI, and on POSIX the
// runtime binary it is executing from, both live inside the directory being
// replaced. So we hand the last step to a short-lived helper started from the
// NEW bundle's runtime, which waits for us to exit and only then renames
// directories. Uniform on every platform, and it works on Windows where an
// in-use directory cannot be renamed at all.
function spawnSwapHelper({ layout, env, stagedRoot, newVersion, restart, logger: log }) {
  const helperResources = bundleResources(stagedRoot, layout.platform);
  const runtime = runtimeNodeIn(helperResources, layout.platform);
  const script = path.join(helperResources, 'launcher', 'standalone-cli.js');
  if (!fs.existsSync(runtime) || !fs.existsSync(script)) {
    throw new Error(`staged bundle is incomplete (${helperResources})`);
  }
  const child = spawn(runtime, [
    script, '__swap',
    '--wait-pid', String(process.pid),
    '--root', layout.bundleRoot,
    '--staged', stagedRoot,
    '--version', newVersion,
    ...(restart ? ['--restart'] : []),
  ], { detached: true, stdio: 'ignore', env });
  if (child && typeof child.unref === 'function') child.unref();
  log.log(`swap helper started (pid ${child.pid})`);
  return child;
}

// Internal: run by spawnSwapHelper(), never by a user.
async function cmdSwap(layout, env, args) {
  const root = path.resolve(args.root);
  const staged = path.resolve(args.staged);
  const waitPid = Number.parseInt(args.waitPid, 10);
  for (let i = 0; i < 240 && waitPid && pidAlive(waitPid); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const retired = `${root}.old-${Date.now()}`;
  const log = logger(layout, env);
  try {
    if (fs.existsSync(root)) fs.renameSync(root, retired);
    fs.renameSync(staged, root);
    log.log(`updated to ${args.version} (previous bundle kept at ${retired})`);
    fs.rmSync(retired, { recursive: true, force: true });
  } catch (error) {
    log.error(`swap failed: ${error.message}`);
    // Never leave the user without an install: put the old tree back.
    if (!fs.existsSync(root) && fs.existsSync(retired)) {
      try { fs.renameSync(retired, root); log.log('restored the previous bundle'); } catch (_) {}
    }
    return 1;
  }
  if (args.restart) {
    const installedResources = bundleResources(root, layout.platform);
    const target = path.join(installedResources, 'launcher', 'standalone-cli.js');
    const runtime = runtimeNodeIn(installedResources, layout.platform);
    if (fs.existsSync(target) && fs.existsSync(runtime)) {
      const child = spawn(runtime, [target, 'start', '--no-open'], { detached: true, stdio: 'ignore' });
      if (child && typeof child.unref === 'function') child.unref();
    }
  }
  return 0;
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
  if (args.check) {
    process.stdout.write(`installed: ${current}\nlatest:    ${release.tag}\n`);
    return 0;
  }
  if (release.tag === current) {
    process.stdout.write(`MultiCC ${current} is already the latest release.\n`);
    return 0;
  }
  const asset = archiveName(release.tag, layout.platform, layout.arch);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-update-'));
  const archive = path.join(workDir, asset);
  process.stdout.write(`Updating ${current} → ${release.tag}...\n`);
  try {
    await downloadTo(assetUrl(release.tag, asset), archive, { logger: log });
    const checksumFile = `${archive}.sha256`;
    await downloadTo(assetUrl(release.tag, `${asset}.sha256`), checksumFile, { logger: log });
    verifyChecksum(archive, fs.readFileSync(checksumFile, 'utf8'));
    process.stdout.write('  checksum verified\n');
    const staged = extractArchive({ archive, dest: path.join(workDir, 'staged'), platform: layout.platform, logger: log });
    const state = await currentState(layout, env);
    const restart = Boolean(state.running) || args.restart;
    if (state.running) {
      process.stdout.write('  stopping MultiCC...\n');
      await cmdStop(layout, env);
    }
    spawnSwapHelper({ layout, env, stagedRoot: staged, newVersion: release.tag, restart, logger: log });
    process.stdout.write(`  swapped in ${release.tag}${restart ? ' — restarting' : ''}\n`);
    process.stdout.write('Update will finish in a moment (the helper waits for this process to exit).\n');
    return 0;
  } catch (error) {
    log.error(`update failed: ${error.message}`);
    process.stderr.write(`Update failed: ${error.message}\n`);
    process.stderr.write(`Nothing was changed. Download manually: ${RELEASES_URL}\n`);
    return 1;
  }
}

// ── Service (auto-start on login) ───────────────────────────────────────────
// Optional, and deliberately the only platform-specific part of the CLI: the
// bundle itself is uniform, but "start this on login" has no portable answer.

function serviceUnitPath(platform, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library', 'LaunchAgents', 'com.multicc.server.plist');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', 'multicc.service');
}

function cmdService(layout, env, args) {
  const [action] = args.rest;
  const platform = process.platform;
  const home = os.homedir();
  const unit = serviceUnitPath(platform, home);
  if (!action || action === 'status') {
    if (!fs.existsSync(unit)) { process.stdout.write('Auto-start is not installed.\n'); return 1; }
    if (platform === 'darwin') {
      const res = spawnSync('launchctl', ['list'], { encoding: 'utf8' });
      const loaded = res.status === 0 && /com\.multicc\.server/.test(res.stdout || '');
      process.stdout.write(`Auto-start installed at ${unit} (${loaded ? 'loaded' : 'not loaded'})\n`);
      return loaded ? 0 : 1;
    }
    const res = spawnSync('systemctl', ['--user', 'is-enabled', 'multicc'], { encoding: 'utf8' });
    process.stdout.write(`Auto-start installed at ${unit} (${String(res.stdout || '').trim() || 'unknown'})\n`);
    return res.status === 0 ? 0 : 1;
  }
  if (action === 'uninstall') {
    if (platform === 'darwin') {
      spawnSync('launchctl', ['unload', unit], { stdio: 'ignore' });
    } else {
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
  <dict><key>PATH</key><string>${path.dirname(layout.runtimeNode)}:/usr/local/bin:/usr/bin:/bin</string></dict>
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
    waitPid: null, root: null, staged: null, version: null, help: false,
  };
  const takesValue = new Set(['--port', '--data', '--lines', '--wait-pid', '--root', '--staged', '--version']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (takesValue.has(arg)) {
      const value = argv[++i];
      if (arg === '--port') args.port = Number.parseInt(value, 10);
      else if (arg === '--data') args.data = value;
      else if (arg === '--lines') args.lines = Number.parseInt(value, 10);
      else if (arg === '--wait-pid') args.waitPid = value;
      else if (arg === '--root') args.root = value;
      else if (arg === '--staged') args.staged = value;
      else if (arg === '--version') args.version = value;
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
    case '__swap': return cmdSwap(layout, env, args);
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
  archiveName,
  assetUrl,
  bundleResources,
  configGet,
  configSet,
  envFilePath,
  extractArchive,
  latestRelease,
  main,
  parseArgs,
  resolveLayout,
  runtimeNodeIn,
  serviceUnitPath,
  verifyChecksum,
};
