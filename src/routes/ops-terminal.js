'use strict';

const { spawn } = require('node:child_process');

// Ops terminal — the repair surface for hosts whose environment is too broken
// to create the first directory in: git missing on a bare cloud VM, commit
// identity unset on a fresh service account. Both are one-command fixes, but a
// host with no directories has no session terminal yet, so without this panel
// the only way out is SSH. Auth posture: these routes sit behind the global
// auth gate, and an authenticated user already holds equivalent execution
// through the session terminal and the updater — this only covers the
// no-directory case, it does not widen who can run what.

const MAX_COMMAND_LENGTH = 2000;
const COMMAND_TIMEOUT_MS = 60 * 1000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const ACCUMULATE_CAP_BYTES = 1024 * 1024;

// Ordered by preference within each family; the first one present on PATH wins.
const GIT_INSTALL_COMMANDS = Object.freeze({
  dnf: 'dnf install -y git',
  yum: 'yum install -y git',
  apt: 'apt-get update && apt-get install -y git',
  apk: 'apk add git',
  pacman: 'pacman -S --noconfirm git',
  zypper: 'zypper --non-interactive install git',
  brew: 'brew install git',
  winget: 'winget install --id Git.Git -e',
  choco: 'choco install -y git',
  scoop: 'scoop install git',
});
const LINUX_PM_ORDER = Object.freeze(['dnf', 'yum', 'apt-get', 'apk', 'pacman', 'zypper', 'brew']);

// Repair output tends to put the reason at the end (apt/dnf resolution errors),
// so an oversized stream keeps its tail and loses its head.
function keepTail(text) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= MAX_OUTPUT_BYTES) return value;
  const skipped = value.length - MAX_OUTPUT_BYTES;
  return `…[${skipped} bytes truncated]…\n` + value.slice(-MAX_OUTPUT_BYTES);
}

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || undefined;
}

// One shell command at a time, hard timeout, capped accumulation. `detached`
// on POSIX makes the shell a process-group leader so a timeout can bring down
// the whole command tree, not just the shell that spawned it.
function defaultShellRun(command, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn('cmd.exe', ['/c', command], { cwd: homeDir(), windowsHide: true })
      : spawn('/bin/sh', ['-c', command], { cwd: homeDir(), detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    child.stdout.on('data', (chunk) => { if (stdout.length < ACCUMULATE_CAP_BYTES) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < ACCUMULATE_CAP_BYTES) stderr += chunk; });
    const killTree = (signal) => {
      try {
        if (isWin) child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (_) {
        try { child.kill(signal); } catch (_ignored) { /* already gone */ }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 250).unref();
    }, timeoutMs);
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    };
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

async function probePackageManager(run, platform) {
  if (platform === 'win32') {
    for (const name of ['winget', 'choco', 'scoop']) {
      const found = await run(`where ${name}`);
      if (found.code === 0) return name;
    }
    return null;
  }
  if (platform === 'darwin') {
    const brew = await run('command -v brew');
    return brew.code === 0 ? 'brew' : null;
  }
  const probe = `for c in ${LINUX_PM_ORDER.join(' ')}; do command -v "$c" >/dev/null 2>&1 && { echo "$c"; break; }; done`;
  const found = await run(probe);
  const first = found.code === 0 ? String(found.stdout || '').trim().split('\n')[0].trim() : '';
  if (first === 'apt-get') return 'apt';
  return Object.prototype.hasOwnProperty.call(GIT_INSTALL_COMMANDS, first) ? first : null;
}

async function probeEnv(run, platform) {
  const isWin = platform === 'win32';
  const which = await run(isWin ? 'where git' : 'command -v git');
  const gitPath = which.code === 0 ? String(which.stdout || '').trim().split('\n')[0].trim() : '';
  let git = { available: false, version: null };
  if (gitPath) {
    let runnable = true;
    if (platform === 'darwin' && gitPath === '/usr/bin/git') {
      // The macOS shim: running it without Command Line Tools raises the
      // system install dialog. `xcode-select -p` is the dialog-free probe
      // (same rule as src/routes/developer-tools.js).
      const clt = await run('xcode-select -p');
      runnable = clt.code === 0;
    }
    if (runnable) {
      const version = await run('git --version');
      const match = /git version (\S+)/.exec(version.stdout || '');
      if (version.code === 0 && match) git = { available: true, version: match[1] };
    }
  }
  let identity = { name: null, email: null };
  if (git.available) {
    const name = await run('git config --get user.name');
    const email = await run('git config --get user.email');
    identity = {
      name: name.code === 0 ? String(name.stdout || '').trim() || null : null,
      email: email.code === 0 ? String(email.stdout || '').trim() || null : null,
    };
  }
  return { git, identity, packageManager: await probePackageManager(run, platform) };
}

function createOpsTerminalRoutes({ platform = process.platform, log, run = defaultShellRun } = {}) {
  const logger = log || console;
  let busy = false;

  async function envHandler(req, res, next) {
    try {
      const { git, identity, packageManager } = await probeEnv(run, platform);
      res.json({
        ok: true,
        platform,
        git,
        identity,
        packageManager,
        suggestions: {
          gitInstall: packageManager ? GIT_INSTALL_COMMANDS[packageManager] : null,
          identityName: 'git config --global user.name "multicc"',
          identityEmail: 'git config --global user.email "multicc@local"',
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async function runHandler(req, res, next) {
    try {
      const command = req.body && req.body.command;
      if (typeof command !== 'string' || !command.trim()) {
        return res.status(400).json({ ok: false, code: 'INVALID_COMMAND', message: 'command must be a non-empty string' });
      }
      if (command.length > MAX_COMMAND_LENGTH) {
        return res.status(400).json({ ok: false, code: 'INVALID_COMMAND', message: `command must be at most ${MAX_COMMAND_LENGTH} characters` });
      }
      if (busy) {
        return res.status(409).json({ ok: false, code: 'OPS_BUSY', message: 'a command is still running' });
      }
      busy = true;
      const startedAt = Date.now();
      let result;
      try {
        result = await run(command);
      } finally {
        busy = false;
      }
      // Audit metadata only, never the command text: a repair command may
      // itself carry credentials the user pasted.
      try {
        logger.warn('ops_terminal_run', {
          exitCode: result.code == null ? null : result.code,
          durationMs: Date.now() - startedAt,
          timedOut: !!result.timedOut,
          stdoutBytes: (result.stdout || '').length,
          stderrBytes: (result.stderr || '').length,
        });
      } catch (_) { /* auditing must not fail the command */ }
      return res.json({
        ok: true,
        exitCode: result.code == null ? null : result.code,
        stdout: keepTail(result.stdout),
        stderr: keepTail(result.stderr),
        durationMs: Date.now() - startedAt,
        timedOut: !!result.timedOut,
      });
    } catch (error) {
      next(error);
    }
  }

  function mountRoutes(app) {
    if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
      throw new TypeError('Express app.get and app.post are required');
    }
    app.get('/api/system/ops-env', envHandler);
    app.post('/api/system/ops-run', runHandler);
  }

  return { envHandler, runHandler, mountRoutes };
}

module.exports = {
  createOpsTerminalRoutes,
  keepTail,
  GIT_INSTALL_COMMANDS,
  MAX_COMMAND_LENGTH,
};
