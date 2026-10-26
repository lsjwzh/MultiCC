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
//
// A command runs as a background job the panel polls, not inside one HTTP
// request: installing git on a 1 GB VPS routinely takes minutes (dnf metadata
// alone can pass a minute), a short deadline would kill the package manager
// mid-transaction, and a request held open that long does not survive every
// tunnel. Polling also lets a reopened panel re-attach to a job still running.

const MAX_COMMAND_LENGTH = 2000;
const PROBE_TIMEOUT_MS = 15 * 1000;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const STOP_GRACE_MS = 2000;
// Repair output tends to put the reason at the end (apt/dnf resolution
// errors), so an oversized job keeps its tail and drops its head.
const MAX_OUTPUT_CHARS = 256 * 1024;

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
// These write system state, so a non-root service account needs sudo.
const ROOT_PACKAGE_MANAGERS = new Set(['dnf', 'yum', 'apt', 'apk', 'pacman', 'zypper']);
// Ordered by preference within each family; the first one present on PATH wins.
const LINUX_PM_ORDER = Object.freeze(['dnf', 'yum', 'apt-get', 'apk', 'pacman', 'zypper', 'brew']);
const DEFAULT_IDENTITY = Object.freeze({ name: 'multicc', email: 'multicc@local' });
// Mirrors validate() in native/core/src/publication_identity.rs: a value the
// commit gate rejects must not show as configured here.
const BAD_IDENTITY_CHARS = /[\u0000-\u001f\u007f-\u009f<>]/;

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || undefined;
}

// One shell command with a hard deadline. stdin is closed so a command that
// asks a question (apt without -y, sudo wanting a password) fails at once
// instead of waiting out the deadline. `detached` on POSIX makes the shell a
// process-group leader so stop() brings down the whole command tree.
function startShell(command, { timeoutMs = JOB_TIMEOUT_MS, onOutput = () => {} } = {}) {
  const isWin = process.platform === 'win32';
  let child;
  try {
    child = isWin
      ? spawn('cmd.exe', ['/c', command], { cwd: homeDir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('/bin/sh', ['-c', command], { cwd: homeDir(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return { done: Promise.resolve({ code: null, timedOut: false, error: error.message }), stop() {} };
  }
  let settled = false;
  let timedOut = false;
  let killTimer = null;
  const killTree = (signal) => {
    try {
      if (isWin) child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (_) {
      try { child.kill(signal); } catch (_ignored) { /* already gone */ }
    }
  };
  const stop = () => {
    if (settled || killTimer) return;
    killTree('SIGTERM');
    killTimer = setTimeout(() => { if (!settled) killTree('SIGKILL'); }, STOP_GRACE_MS);
    killTimer.unref?.();
  };
  const deadline = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  deadline.unref?.();
  const done = new Promise((resolve) => {
    let spawnError = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      // Cleared so a late SIGKILL can never land on a recycled process group.
      clearTimeout(killTimer);
      resolve({ code, timedOut, error: spawnError });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => onOutput(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => onOutput(chunk, 'stderr'));
    child.on('error', (error) => { spawnError = error.message; finish(null); });
    child.on('close', (code) => finish(code));
  });
  return { done, stop };
}

async function execShell(command) {
  let stdout = '';
  const result = await startShell(command, {
    timeoutMs: PROBE_TIMEOUT_MS,
    onOutput: (chunk, stream) => { if (stream === 'stdout' && stdout.length < 64 * 1024) stdout += chunk; },
  }).done;
  return { code: result.code, stdout };
}

const firstLine = (result) => (result.code === 0 ? String(result.stdout || '').trim().split('\n')[0].trim() : '');
const identityPartValid = (value, isEmail) => !!value && !BAD_IDENTITY_CHARS.test(value) && (!isEmail || value.includes('@'));

async function probePackageManager(exec, platform) {
  if (platform === 'win32') {
    for (const name of ['winget', 'choco', 'scoop']) {
      if ((await exec(`where ${name}`)).code === 0) return name;
    }
    return null;
  }
  if (platform === 'darwin') return (await exec('command -v brew')).code === 0 ? 'brew' : null;
  const found = firstLine(await exec(`for c in ${LINUX_PM_ORDER.join(' ')}; do command -v "$c" >/dev/null 2>&1 && { echo "$c"; break; }; done`));
  if (found === 'apt-get') return 'apt';
  return Object.prototype.hasOwnProperty.call(GIT_INSTALL_COMMANDS, found) ? found : null;
}

// Who the commands run as decides whether a package install can work at all:
// the documented VPS layout runs MultiCC as an unprivileged `multicc` user.
async function probeAccount(exec, platform) {
  if (platform === 'win32') return null;
  const user = firstLine(await exec('id -un')) || null;
  const uidText = firstLine(await exec('id -u'));
  const uid = /^\d+$/.test(uidText) ? Number(uidText) : null;
  const sudo = platform === 'linux' && uid !== 0 && (await exec('sudo -n true')).code === 0;
  return { user, uid, sudo };
}

async function probeGit(exec, platform) {
  const gitPath = firstLine(await exec(platform === 'win32' ? 'where git' : 'command -v git'));
  if (!gitPath) return { available: false, version: null };
  if (platform === 'darwin' && gitPath === '/usr/bin/git') {
    // The macOS shim: running it without Command Line Tools raises the system
    // install dialog. `xcode-select -p` is the dialog-free probe (same rule as
    // src/routes/developer-tools.js).
    if ((await exec('xcode-select -p')).code !== 0) return { available: false, version: null };
  }
  const match = /git version (\S+)/.exec((await exec('git --version')).stdout || '');
  return match ? { available: true, version: match[1] } : { available: false, version: null };
}

function installAdvice(packageManager, account) {
  if (!packageManager) return { command: null, runnable: false };
  const command = GIT_INSTALL_COMMANDS[packageManager];
  if (!ROOT_PACKAGE_MANAGERS.has(packageManager) || !account || account.uid === 0) return { command, runnable: true };
  if (account.sudo) {
    return { command: command.split(' && ').map(part => `sudo -n ${part}`).join(' && '), runnable: true };
  }
  // Shown to copy into an SSH session, not offered as a one-click run that
  // can only fail with "must be root".
  return { command, runnable: false };
}

async function probeEnv(exec, platform) {
  const git = await probeGit(exec, platform);
  let identity = { name: null, email: null, valid: false };
  if (git.available) {
    const name = firstLine(await exec('git config --get user.name')) || null;
    const email = firstLine(await exec('git config --get user.email')) || null;
    identity = { name, email, valid: identityPartValid(name, false) && identityPartValid(email, true) };
  }
  const account = await probeAccount(exec, platform);
  const packageManager = await probePackageManager(exec, platform);
  const install = installAdvice(packageManager, account);
  const identityCommands = [];
  if (!identityPartValid(identity.name, false)) identityCommands.push(`git config --global user.name "${DEFAULT_IDENTITY.name}"`);
  if (!identityPartValid(identity.email, true)) identityCommands.push(`git config --global user.email "${DEFAULT_IDENTITY.email}"`);
  return {
    git,
    identity,
    account,
    packageManager,
    suggestions: {
      gitInstall: install.command,
      gitInstallRunnable: install.runnable,
      identity: identityCommands.length ? identityCommands.join(' && ') : null,
    },
  };
}

function createOpsTerminalRoutes({
  platform = process.platform,
  log = console,
  exec = execShell,
  start = startShell,
  now = Date.now,
} = {}) {
  let job = null;
  let sequence = 0;

  // `from` is the absolute output offset the client already holds; the reply
  // carries only what came after it, plus how much was dropped from the head
  // in between so the panel can say so instead of silently splicing.
  function snapshot(current, from) {
    if (!current) return null;
    const offset = Number.isFinite(Number(from)) && Number(from) > 0 ? Math.floor(Number(from)) : 0;
    return {
      id: current.id,
      command: current.command,
      running: current.running,
      exitCode: current.exitCode,
      timedOut: current.timedOut,
      stopped: current.stopped,
      error: current.error,
      durationMs: (current.endedAt || now()) - current.startedAt,
      total: current.dropped + current.output.length,
      skipped: Math.max(0, current.dropped - offset),
      chunk: current.output.slice(Math.max(0, offset - current.dropped)),
    };
  }

  function append(current, text) {
    current.output += text;
    if (current.output.length > MAX_OUTPUT_CHARS) {
      const cut = current.output.length - MAX_OUTPUT_CHARS;
      current.output = current.output.slice(cut);
      current.dropped += cut;
    }
  }

  async function envHandler(req, res, next) {
    try {
      res.json({ ok: true, platform, ...(await probeEnv(exec, platform)) });
    } catch (error) {
      next(error);
    }
  }

  function startHandler(req, res) {
    const command = req.body && req.body.command;
    if (typeof command !== 'string' || !command.trim() || command.length > MAX_COMMAND_LENGTH) {
      return res.status(400).json({
        ok: false, code: 'INVALID_COMMAND',
        message: `command must be a non-empty string of at most ${MAX_COMMAND_LENGTH} characters`,
      });
    }
    if (job && job.running) {
      return res.status(409).json({ ok: false, code: 'OPS_BUSY', message: 'a command is still running', job: snapshot(job, 0) });
    }
    const current = {
      id: ++sequence, command, running: true, exitCode: null, timedOut: false, stopped: false,
      error: null, startedAt: now(), endedAt: null, output: '', dropped: 0, stop: () => {},
    };
    job = current;
    // Audit metadata only, never the command text: a repair command may carry
    // a credential the user pasted.
    try { log.warn('ops_terminal_start', { jobId: current.id, commandChars: command.length }); } catch (_) {}
    const handle = start(command, { timeoutMs: JOB_TIMEOUT_MS, onOutput: (chunk) => append(current, String(chunk)) });
    current.stop = handle.stop;
    Promise.resolve(handle.done).then((result) => result || {}, (error) => ({ code: null, error: error.message }))
      .then((result) => {
        current.running = false;
        current.endedAt = now();
        current.exitCode = result.code == null ? null : result.code;
        current.timedOut = !!result.timedOut;
        if (result.error) {
          current.error = String(result.error);
          append(current, `\n${current.error}\n`);
        }
        try {
          log.warn('ops_terminal_run', {
            jobId: current.id, exitCode: current.exitCode, durationMs: current.endedAt - current.startedAt,
            timedOut: current.timedOut, stopped: current.stopped, outputChars: current.dropped + current.output.length,
          });
        } catch (_) { /* auditing must not fail the job */ }
      });
    return res.json({ ok: true, job: snapshot(current, 0) });
  }

  function statusHandler(req, res) {
    res.json({ ok: true, job: snapshot(job, req.query && req.query.from) });
  }

  function stopHandler(req, res) {
    if (job && job.running) {
      job.stopped = true;
      job.stop();
    }
    res.json({ ok: true, job: snapshot(job, req.body && req.body.from) });
  }

  function mountRoutes(app) {
    if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
      throw new TypeError('Express app.get and app.post are required');
    }
    app.get('/api/system/ops-env', envHandler);
    app.get('/api/system/ops-run', statusHandler);
    app.post('/api/system/ops-run', startHandler);
    app.post('/api/system/ops-run/stop', stopHandler);
  }

  return { envHandler, startHandler, statusHandler, stopHandler, mountRoutes };
}

module.exports = {
  createOpsTerminalRoutes,
  startShell,
  GIT_INSTALL_COMMANDS,
  MAX_COMMAND_LENGTH,
  MAX_OUTPUT_CHARS,
};
