'use strict';

// Resolve where the desktop shell finds the server, where it keeps user data,
// and what environment the backend child runs with. No electron import —
// main.js passes primitives (isPackaged/resourcesPath/userData) in, so this
// module stays testable under plain Node.
//
// Layout (packaged):
//   <resourcesPath>/app-server/   staged copy of the MultiCC server (read-only)
//   <resourcesPath>/runtime/      the pinned Node runtime the server runs on
//   <resourcesPath>/launcher/     standalone launcher + CLI (same as a package)
//   <userData>/data/              MULTICC_DATA_DIR — all server state
//   <userData>/data/memories      MULTICC_MEMORY_ROOT
//   <userData>/multicc.env        MULTICC_ENV_FILE — writable .env copy
//   <userData>/logs/              supervisor + server run logs
// Dev mode keeps every one of those under .desktop-dev-data/ in the checkout
// (or $MULTICC_DESKTOP_DATA) so a developer's CLI-server state is untouched.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEV_DATA_DIRNAME = '.desktop-dev-data';
// The desktop shell is local-only by construction: the window talks to a
// loopback server. Pinning HOST (loopback) keeps the packaged app from ever
// widening the network surface, whatever a copied-in .env says.
const DESKTOP_LOOPBACK_HOST = '127.0.0.1';

// Where a staged standalone tree keeps its runtime — the same layout
// scripts/standalone-bundle.js writes and the launcher resolves, including
// Windows' missing bin/ level.
function runtimeNodeIn(resourcesPath, platform = process.platform) {
  return platform === 'win32'
    ? path.join(resourcesPath, 'runtime', 'node.exe')
    : path.join(resourcesPath, 'runtime', 'bin', 'node');
}

function resolveDesktopEnv({
  isPackaged,
  resourcesPath,
  userData,
  repoRoot = path.resolve(__dirname, '..', '..'),
} = {}) {
  if (typeof isPackaged !== 'boolean') throw new TypeError('[desktop-env] isPackaged (boolean) is required');
  if (!userData) throw new TypeError('[desktop-env] userData path is required');

  if (isPackaged) {
    if (!resourcesPath) throw new TypeError('[desktop-env] resourcesPath is required when packaged');
    const serverDir = path.join(resourcesPath, 'app-server');
    const dataRoot = path.join(userData, 'data');
    return {
      mode: 'packaged',
      serverDir,
      serverEntry: path.join(serverDir, 'server.js'),
      // The shell is a shell around the standalone tree: the server runs on the
      // runtime staged next to it (pinned Node, the one the release smoke-tested
      // through install.sh), never on Electron's own Node.
      runtimeNode: runtimeNodeIn(resourcesPath),
      electronRuntime: false,
      launcherDir: path.join(resourcesPath, 'launcher'),
      dataRoot,
      memoryRoot: path.join(dataRoot, 'memories'),
      envFile: path.join(userData, 'multicc.env'),
      logsDir: path.join(userData, 'logs'),
      runtimeInfoFile: path.join(userData, 'desktop-runtime.json'),
    };
  }

  const dataRoot = process.env.MULTICC_DESKTOP_DATA
    ? path.resolve(process.env.MULTICC_DESKTOP_DATA)
    : path.join(repoRoot, DEV_DATA_DIRNAME);
  return {
    mode: 'development',
    serverDir: repoRoot,
    serverEntry: path.join(repoRoot, 'server.js'),
    // No staged runtime in a checkout, so dev runs the Electron binary as plain
    // Node (buildChildEnv sets ELECTRON_RUN_AS_NODE for exactly this case).
    runtimeNode: process.execPath,
    electronRuntime: true,
    launcherDir: null,
    dataRoot,
    memoryRoot: path.join(dataRoot, 'memories'),
    envFile: path.join(dataRoot, 'multicc.env'),
    logsDir: path.join(dataRoot, 'logs'),
    runtimeInfoFile: path.join(dataRoot, 'desktop-runtime.json'),
  };
}

// Same tolerant KEY=VALUE parsing as src/host-env.js readEnvFile: one assignment
// per line, comments and blanks ignored, no interpolation. Self-contained here
// so desktop/lib never requires into the server package (which moves to
// extraResources when packaged).
function parseEnvFile(content) {
  const vars = {};
  String(content || '').split('\n').forEach(line => {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m) vars[m[1]] = m[2];
  });
  return vars;
}

function readEnvValues(envFile) {
  try { return parseEnvFile(fs.readFileSync(envFile, 'utf8')); }
  catch (_) { return {}; }
}

// Build the backend child's environment.
//   baseEnv  — supervisor environment (usually process.env, minus Electron noise)
//   dotenv   — values from the user's desktop .env; they only fill gaps:
//              an already-set environment variable always wins, matching how
//              the CLI server treats explicit env vs .env.
// The desktop knobs are applied last and unconditionally: a stale .env must
// never redirect state out of the per-user data dir or un-pin the loopback
// bind. ELECTRON_RUN_AS_NODE=1 turns the Electron binary into a plain Node
// runtime, and is set only when the child really is that binary (dev mode):
// packaged builds run the staged Node runtime, where the variable is at best
// meaningless and at worst confusing in a stack trace.
function buildChildEnv({ port, desktopEnv, baseEnv = {}, dotenv = {}, runtimeNode }) {
  if (!Number.isInteger(port) || port <= 0) throw new TypeError('[desktop-env] port is required');
  if (!desktopEnv || !desktopEnv.dataRoot) throw new TypeError('[desktop-env] desktopEnv is required');
  const env = { ...baseEnv };
  for (const [key, value] of Object.entries(dotenv)) {
    if (env[key] === undefined || env[key] === '') env[key] = value;
  }
  env.PORT = String(port);
  env.HOST = DESKTOP_LOOPBACK_HOST;
  env.MULTICC_DATA_DIR = desktopEnv.dataRoot;
  env.MULTICC_MEMORY_ROOT = desktopEnv.memoryRoot;
  env.MULTICC_ENV_FILE = desktopEnv.envFile;
  env.MULTICC_DESKTOP = '1';
  if (desktopEnv.electronRuntime) env.ELECTRON_RUN_AS_NODE = '1';
  else delete env.ELECTRON_RUN_AS_NODE;
  // Put the runtime the child will actually run on first on PATH:
  // `claude`/`codex`/every other Node-based CLI the server spawns for a session
  // would otherwise fall back to whatever (too old) Node the host happens to
  // have. The standalone launcher passes its own resolved path here, and the
  // desktop shell's layout supplies it through desktopEnv — one rule, both
  // callers.
  const serverRuntime = runtimeNode || (desktopEnv.electronRuntime ? null : desktopEnv.runtimeNode);
  if (serverRuntime) prependPathEntry(env, path.dirname(serverRuntime));
  return env;
}

// Put a directory first on the child's PATH. Windows spells the variable
// `Path`, and a child that ends up with both spellings gets whichever the OS
// picks, so find the existing key instead of adding a second one.
function prependPathEntry(env, dir) {
  const key = Object.keys(env).find(name => name.toLowerCase() === 'path') || 'PATH';
  const parts = String(env[key] || '').split(path.delimiter).filter(Boolean);
  if (parts[0] !== dir) parts.unshift(dir);
  env[key] = parts.join(path.delimiter);
  return env;
}

// ── macOS Gatekeeper/TCC safeguards ────────────────────────────────────────
// A bundle that still carries the "downloaded from the internet" flag and is
// run where it landed is executed by Gatekeeper from a random read-only
// AppTranslocation path. Nothing about that works quietly: permissions the user
// grants are recorded against a path that changes on the next launch, so they
// can never stick, and file access fails in ways that read like bugs. Both
// entry points share this module, which is why the detection lives here.
const APP_TRANSLOCATION_RE = /\/AppTranslocation\//;

function isAppTranslocated(target) {
  return APP_TRANSLOCATION_RE.test(String(target || ''));
}

// Returns the message to print, or null when the process runs from a normal
// location. `target` is any path inside the running bundle (__dirname works).
function translocationGuidance(target) {
  if (!isAppTranslocated(target)) return null;
  const bundle = /^(.*\.app)\/Contents\//.exec(String(target));
  const dir = bundle ? bundle[1].replace(/\/[^/]*\.app$/, '') : String(target);
  return [
    '[multicc] 警告：程序正从 macOS 的随机只读副本里运行（AppTranslocation）。',
    '  原因：这个目录还带着「从网络下载」的隔离标记，Gatekeeper 就从临时路径运行它。',
    '  后果：磁盘权限授权会记在那个每次启动都会变的临时路径上，等于授权不上（git 也会报 Operation not permitted）。',
    '  处理：把整个目录移出「下载」目录，并去掉隔离标记——',
    `    xattr -dr com.apple.quarantine "${dir}"`,
    '  然后重新启动 MultiCC。',
  ].join('\n');
}

// Strip the quarantine flag from a freshly unpacked bundle. Safe to call on any
// platform (no-op off darwin) and never fatal: an unreadable xattr is not a
// reason to refuse an installation.
function dequarantine(dir, { platform = process.platform, logger = null } = {}) {
  if (platform !== 'darwin') return false;
  try {
    execFileSync('xattr', ['-dr', 'com.apple.quarantine', dir], { stdio: 'ignore' });
    return true;
  } catch (error) {
    if (logger && logger.log) logger.log(`[multicc] could not clear the download flag (${error.message})`);
    return false;
  }
}

function ensureWritableDirs(desktopEnv) {
  for (const dir of [desktopEnv.dataRoot, desktopEnv.memoryRoot, desktopEnv.logsDir,
    path.dirname(desktopEnv.envFile), path.dirname(desktopEnv.runtimeInfoFile)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  APP_TRANSLOCATION_RE,
  DEV_DATA_DIRNAME,
  DESKTOP_LOOPBACK_HOST,
  resolveDesktopEnv,
  parseEnvFile,
  readEnvValues,
  buildChildEnv,
  ensureWritableDirs,
  prependPathEntry,
  runtimeNodeIn,
  isAppTranslocated,
  translocationGuidance,
  dequarantine,
};
