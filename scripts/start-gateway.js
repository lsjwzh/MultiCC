'use strict';
// `npm start`: a foreground run behind the Rust front door, like every other
// entry point (docs/gateway.md §8). Routes that moved into the front door
// (docs/gateway.md §9) do not exist in a bare `node server.js`.
const path = require('path');
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
const gateway = path.join(path.dirname(addon), windows ? 'multicc-gateway.exe' : 'multicc-gateway');
// Our stdin pipe is the gateway's lifeline: if this launcher disappears, the
// gateway drains Node and exits. On POSIX it gets its own process group so a
// terminal Ctrl-C reaches it once, through us, instead of the whole tree at once.
const child = spawn(gateway, ['serve', '--cwd', root, '--node', process.execPath, '--stdin-lifeline', 'server.js'], {
  stdio: ['pipe', 'inherit', 'inherit'],
  env: { ...process.env, MULTICC_RUST_ADDON: addon },
  detached: !windows,
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { if (!windows) child.kill(signal); });
}
child.on('error', (error) => {
  console.error(`cannot start ${gateway}: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 128 + (require('os').constants.signals[signal] || 0) : 1));
});
