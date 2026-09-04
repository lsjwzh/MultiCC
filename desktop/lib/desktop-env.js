'use strict';

// Resolve where the desktop shell finds the server, where it keeps user data,
// and what environment the backend child runs with. No electron import —
// main.js passes primitives (isPackaged/resourcesPath/userData) in, so this
// module stays testable under plain Node.
//
// Layout (packaged):
//   <resourcesPath>/app-server/   staged copy of the MultiCC server (read-only)
//   <userData>/data/              MULTICC_DATA_DIR — all server state
//   <userData>/data/memories      MULTICC_MEMORY_ROOT
//   <userData>/multicc.env        MULTICC_ENV_FILE — writable .env copy
//   <userData>/logs/              supervisor + server run logs
// Dev mode keeps every one of those under .desktop-dev-data/ in the checkout
// (or $MULTICC_DESKTOP_DATA) so a developer's CLI-server state is untouched.

const fs = require('fs');
const path = require('path');

const DEV_DATA_DIRNAME = '.desktop-dev-data';
// The desktop shell is local-only by construction: the window talks to a
// loopback server. Pinning HOST (loopback) keeps the packaged app from ever
// widening the network surface, whatever a copied-in .env says.
const DESKTOP_LOOPBACK_HOST = '127.0.0.1';

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
// runtime for the child (bundled Node satisfies the server's engines floor).
function buildChildEnv({ port, desktopEnv, baseEnv = {}, dotenv = {} }) {
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
  env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

function ensureWritableDirs(desktopEnv) {
  for (const dir of [desktopEnv.dataRoot, desktopEnv.memoryRoot, desktopEnv.logsDir,
    path.dirname(desktopEnv.envFile), path.dirname(desktopEnv.runtimeInfoFile)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  DEV_DATA_DIRNAME,
  DESKTOP_LOOPBACK_HOST,
  resolveDesktopEnv,
  parseEnvFile,
  readEnvValues,
  buildChildEnv,
  ensureWritableDirs,
};
