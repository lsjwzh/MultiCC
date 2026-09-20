#!/usr/bin/env node
'use strict';

// Boot a *built* portable bundle the way a user does, prove the server answers,
// then stop it and prove nothing was left behind.
//
// Why this is a script and not an inline CI snippet: the launcher's Windows path
// is materially different (no signals — `--stop` goes through a marker file the
// supervisor polls, and the escalation is `taskkill /T`), and that path cannot be
// exercised from macOS. CI runs this on the Windows runner that just built the
// win32 bundle, and window users' bug reports can be reproduced with the same
// one command.
//
//   node scripts/portable-smoke.js --bundle dist-portable/multicc-portable-1.2.3-win32-x64
//
// It uses only the bundle's own runtime and the launcher's public flags: nothing
// here can pass while the shipped entry points are broken.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 120_000;

function parseArgs(argv) {
  const args = { bundle: null, timeoutMs: DEFAULT_TIMEOUT_MS, keepData: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--bundle') args.bundle = argv[++i];
    else if (arg === '--timeout-ms') args.timeoutMs = Number.parseInt(argv[++i], 10);
    else if (arg === '--keep-data') args.keepData = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else { console.error(`unknown argument: ${arg}`); process.exit(2); }
  }
  if (!args.bundle) { console.error('--bundle <dir> is required'); process.exit(2); }
  return args;
}

// macOS keeps Resources inside the .app; every other platform has Resources/ at
// the bundle root. Both are what the wrapper scripts next to them point at.
function resolveBundleLayout(bundleDir) {
  const appResources = path.join(bundleDir, 'MultiCC.app', 'Contents', 'Resources');
  const resources = fs.existsSync(appResources) ? appResources : path.join(bundleDir, 'Resources');
  const win = process.platform === 'win32';
  // Windows zips keep node.exe at the runtime root; unix tarballs use bin/.
  const nodeBin = win
    ? path.join(resources, 'runtime', 'node.exe')
    : path.join(resources, 'runtime', 'bin', 'node');
  const launcher = path.join(resources, 'launcher', 'portable-launcher.js');
  return { resources, nodeBin, launcher, server: path.join(resources, 'app-server', 'server.js') };
}

// A port of our own. The default 3000 may be served by another MultiCC on this
// machine (a dev box, a second bundle) — and then "the server answered after
// we stopped it" is a statement about that other server, not about this bundle.
function pickPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === 'EPERM'; }
}

function runLauncher({ nodeBin, launcher, args, env, timeoutMs }) {
  return spawnSync(nodeBin, [launcher, ...args], { encoding: 'utf8', env, timeout: timeoutMs });
}

async function waitForReady({ infoFile, deadlineMs, fetchImpl = fetch }) {
  let last = null;
  while (Date.now() < deadlineMs) {
    let info = null;
    try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch (_) {}
    if (info && info.origin) {
      try {
        const res = await fetchImpl(`${info.origin}/readyz`, { cache: 'no-store', signal: AbortSignal.timeout(2_000) });
        await res.arrayBuffer();
        if (res.status === 200) return info;
        last = `readyz ${res.status}`;
      } catch (error) { last = error.message; }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`the bundle never became ready${last ? ` (last: ${last})` : ''}`);
}

async function smokeBundle({ bundleDir, timeoutMs = DEFAULT_TIMEOUT_MS, keepData = false, logger = console } = {}) {
  const layout = resolveBundleLayout(bundleDir);
  for (const [what, file] of [['runtime', layout.nodeBin], ['launcher', layout.launcher], ['server', layout.server]]) {
    if (!fs.existsSync(file)) throw new Error(`bundle is incomplete: no ${what} at ${file}`);
  }

  // Data goes to a throwaway home: the smoke must not read or write the real
  // user's sessions, and removing it proves the bundle keeps state outside
  // its own (read-only) tree.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-portable-smoke-'));
  const env = { ...process.env, MULTICC_PORTABLE_HOME: home };
  const infoFile = path.join(home, 'desktop-runtime.json');
  const result = { home, origin: null, steps: [] };
  const record = step => { result.steps.push(step); logger.log(`[portable-smoke] ${step}`); };

  try {
    const port = await pickPort();
    record(`start on port ${port}`);
    const started = runLauncher({
      ...layout, args: ['--start', '--detach', '--no-open', '--port', String(port)], env, timeoutMs,
    });
    if (started.status !== 0) {
      throw new Error(`--start failed (${started.status}): ${(started.stderr || started.stdout || '').trim()}`);
    }

    const info = await waitForReady({ infoFile, deadlineMs: Date.now() + timeoutMs });
    result.origin = info.origin;
    record(`ready at ${info.origin} (pid ${info.pid})`);

    const chat = await fetch(`${info.origin}/chat.html`, { cache: 'no-store' });
    await chat.arrayBuffer();
    if (chat.status !== 200) throw new Error(`the web UI did not load: HTTP ${chat.status}`);
    record('web UI served');

    const status = runLauncher({ ...layout, args: ['--status'], env, timeoutMs });
    if (status.status !== 0 || !/running at/.test(status.stdout || '')) {
      throw new Error(`--status did not report a running server: ${(status.stdout || '').trim()}`);
    }
    record('status reports running');

    const stopped = runLauncher({ ...layout, args: ['--stop'], env, timeoutMs });
    if (stopped.status !== 0) {
      throw new Error(`--stop failed (${stopped.status}): ${(stopped.stderr || stopped.stdout || '').trim()}`);
    }
    const after = runLauncher({ ...layout, args: ['--status'], env, timeoutMs });
    if (/running at/.test(after.stdout || '')) {
      throw new Error(`the server is still running after --stop: ${(after.stdout || '').trim()}`);
    }
    // Both halves matter: the supervisor must agree it stopped, and the process
    // it was supervising must be gone (a status file that forgets a live server
    // is exactly the "stop did nothing" bug this smoke exists for).
    if (pidAlive(info.pid)) {
      throw new Error(`the server process ${info.pid} is still alive after --stop`);
    }
    try {
      await fetch(`http://127.0.0.1:${port}/readyz`, { cache: 'no-store', signal: AbortSignal.timeout(2_000) });
      throw new Error(`port ${port} still answers /readyz after --stop`);
    } catch (error) {
      if (/still answers/.test(error.message)) throw error;
    }
    record('stopped cleanly');
    result.ok = true;
    return result;
  } finally {
    if (!keepData) fs.rmSync(home, { recursive: true, force: true });
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('usage: portable-smoke.js --bundle <bundle-dir> [--timeout-ms <n>] [--keep-data]');
    return 0;
  }
  return smokeBundle({
    bundleDir: path.resolve(args.bundle),
    timeoutMs: args.timeoutMs,
    keepData: args.keepData,
  }).then(result => {
    console.log(`[portable-smoke] PASS — ${result.steps.join(' → ')}`);
    return 0;
  }).catch(error => {
    console.error(`[portable-smoke] FAIL — ${error.message}`);
    return 1;
  });
}

if (require.main === module) {
  main().then(code => { if (code) process.exit(code); });
}

module.exports = { main, parseArgs, resolveBundleLayout, smokeBundle, waitForReady };
