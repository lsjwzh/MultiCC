'use strict';
// `npm start`: a foreground run behind the Rust front door, like every other
// entry point (docs/gateway.md §8). Routes that moved into the front door
// (docs/gateway.md §9) do not exist in a bare `node server.js`.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { ensureSourceRust } = require('./ensure-source-rust');

const root = path.resolve(__dirname, '..');
let addon;
try {
  addon = ensureSourceRust({ repoRoot: root });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const windows = process.platform === 'win32';
let gateway = path.join(path.dirname(addon), windows ? 'multicc-gateway.exe' : 'multicc-gateway');
// Our stdin pipe is the gateway's lifeline: if this launcher disappears, the
// gateway drains Node and exits. On POSIX it gets its own process group so a
// terminal Ctrl-C reaches it once, through us, instead of the whole tree at once.
let child;
let stopping = false;
const daemonManaged = process.env.MULTICC_SOURCE_DAEMON === '1';
const pidFile = path.join(root, '.multicc.pid');
function start() {
  try {
    addon = ensureSourceRust({ repoRoot: root });
    gateway = path.join(path.dirname(addon), windows ? 'multicc-gateway.exe' : 'multicc-gateway');
  } catch (error) { console.error(error.message); process.exit(1); }
  const env = { ...process.env, MULTICC_RUST_ADDON: addon, MULTICC_SOURCE_FOREGROUND: '1' };
  delete env.MULTICC_SOURCE_DAEMON;
  const dataRoot = path.resolve(root, env.MULTICC_DATA_DIR || root);
  try { env.MULTICC_RESTART_GENERATION = fs.readFileSync(path.join(dataRoot, '.restart-generation'), 'utf8').trim(); env.MULTICC_RESTART_EXACT_PORT = '1'; }
  catch (_) { delete env.MULTICC_RESTART_GENERATION; delete env.MULTICC_RESTART_EXACT_PORT; }
  child = spawn(gateway, ['serve', '--cwd', root, '--node', process.execPath, '--stdin-lifeline', 'server.js'], {
    stdio: ['pipe', 'inherit', 'inherit'], env, detached: !windows,
  });
  if (daemonManaged) child.once('spawn', () => {
    try { fs.writeFileSync(pidFile, String(child.pid) + '\n'); }
    catch (error) { console.error(`cannot update ${pidFile}: ${error.message}`); }
  });
  child.on('error', (error) => { console.error(`cannot start ${gateway}: ${error.message}`); process.exit(1); });
  child.on('exit', (code, signal) => {
    if (!stopping && code === 0 && !signal && fs.existsSync(path.join(dataRoot, '.restart-generation'))) { setTimeout(start, 1000); return; }
    if (daemonManaged) {
      try { if (Number(fs.readFileSync(pidFile, 'utf8')) === child.pid) fs.unlinkSync(pidFile); } catch (_) {}
    }
    process.exit(code ?? (signal ? 128 + (require('os').constants.signals[signal] || 0) : 1));
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { stopping = true; if (child && !windows) child.kill(signal); });
}
start();
