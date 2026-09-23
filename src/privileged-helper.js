'use strict';

// ── Optional privileged helper (the "install once, stop asking for a password"
// path, modelled on how PhDDNS and similar apps behave) ─────────────────────
//
// Exactly one thing MultiCC does genuinely requires root: toggling
// `pmset disablesleep`, which backs the "keep running with the lid closed"
// switch. (Other operations that look privileged are not: `xcode-select
// --install` merely asks the system installer to show its own dialog and works
// fine as an ordinary user, so it is deliberately NOT whitelisted here.)
// Without the helper the toggle still works — it goes through `osascript ...
// with administrator privileges`, which prompts every single time. Removing
// that repeated prompt is the helper's entire purpose.
//
// Why a sudoers drop-in rather than an XPC LaunchDaemon: a resident root daemon
// can only be safe if it can verify *who is calling it*, and on macOS that means
// both sides carrying a matching Developer ID signature. This project is not
// signed yet, so an unverified root daemon would be a standing local privilege
// escalation path — strictly worse than the prompt it replaces. A sudoers entry
// has no listener, no resident process, matches the command line literally, and
// is removed by deleting one file.
//
// The rule that keeps this safe is not the mechanism, it is the whitelist:
// every entry is a COMPLETE command line with no caller-supplied part. The
// moment an entry accepts a path, a filename or a wildcard, this stops being a
// whitelist and becomes an unauthenticated root shell. `assertNoWildcards`
// enforces that mechanically rather than by convention.
const { execFile } = require('node:child_process');
const os = require('node:os');

const SUDOERS_PATH = '/etc/sudoers.d/multicc';
const PROBE_TIMEOUT_MS = 5000;
const ACTION_TIMEOUT_MS = 20000;

// Every action is a fixed argv. Callers name an action; they never supply
// arguments. Adding an entry here is a security decision, not a feature.
const ACTIONS = Object.freeze({
  'lid-sleep-on': ['/usr/bin/pmset', '-a', 'disablesleep', '1'],
  'lid-sleep-off': ['/usr/bin/pmset', '-a', 'disablesleep', '0'],
});

// sudo treats `*`, `?` and friends as glob metacharacters in a command spec, so
// a single stray one would widen an entry to arbitrary arguments. Absolute
// paths are required for the same reason: a relative name would resolve through
// the caller's PATH.
function assertNoWildcards(argv) {
  for (const part of argv) {
    if (/[*?[\]!~]/.test(part)) {
      throw new Error(`privileged helper: wildcard in command spec: ${part}`);
    }
  }
  if (!argv[0].startsWith('/')) {
    throw new Error(`privileged helper: command must be an absolute path: ${argv[0]}`);
  }
}

function actionArgv(action) {
  const argv = ACTIONS[action];
  if (!argv) throw new Error(`privileged helper: unknown action: ${action}`);
  assertNoWildcards(argv);
  return argv;
}

// The file sudo will read. One line per action, each naming the full command,
// so sudo's own parser — not ours — is what decides whether a request matches.
function sudoersContent(user = os.userInfo().username) {
  if (!/^[a-zA-Z0-9._-]+$/.test(user)) {
    throw new Error(`privileged helper: refusing to write a sudoers entry for an unusual username: ${user}`);
  }
  const specs = Object.keys(ACTIONS).sort().map((action) => {
    const argv = actionArgv(action);
    return `${user} ALL=(root) NOPASSWD: ${argv.join(' ')}`;
  });
  return [
    '# Installed by MultiCC. Safe to delete: MultiCC falls back to prompting for',
    '# a password each time. Each line is a COMPLETE command with no arguments',
    '# supplied by the caller; never add a path, filename or wildcard here.',
    ...specs,
    '',
  ].join('\n');
}

function createPrivilegedHelper({
  platform = process.platform,
  run = execFile,
  user = os.userInfo().username,
  sudoersPath = SUDOERS_PATH,
} = {}) {
  const exec = (file, args, timeout) => new Promise((resolve) => {
    run(file, args, { timeout, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({
        failed: Boolean(error),
        stdout: `${stdout || ''}`.trim(),
        text: `${stdout || ''}${stderr || ''}`.trim(),
      });
    });
  });

  // `sudo -n -l <cmd>` asks "could I run exactly this, without a password?" and
  // answers without running anything. That is the only honest probe: the file
  // existing proves nothing, since sudo ignores a drop-in with the wrong mode
  // or owner.
  async function canRun(action) {
    if (platform !== 'darwin') return false;
    const probe = await exec('/usr/bin/sudo', ['-n', '-l', ...actionArgv(action)], PROBE_TIMEOUT_MS);
    return !probe.failed;
  }

  async function status() {
    if (platform !== 'darwin') {
      return { platform, applicable: false, installed: false, actions: {} };
    }
    const actions = {};
    for (const action of Object.keys(ACTIONS)) actions[action] = await canRun(action);
    const values = Object.values(actions);
    return {
      platform,
      applicable: true,
      // Partial means the drop-in predates an action being added, which is a
      // real state a user can be in after upgrading. Report it as not installed
      // so the UI offers a reinstall rather than silently prompting forever.
      installed: values.length > 0 && values.every(Boolean),
      actions,
    };
  }

  // Returns null when the helper cannot serve this action, so the caller can
  // fall back to prompting instead of reporting a failure the user cannot act
  // on. A missing helper is the normal state, not an error.
  async function run_(action) {
    if (!await canRun(action)) return null;
    const result = await exec('/usr/bin/sudo', ['-n', ...actionArgv(action)], ACTION_TIMEOUT_MS);
    return { ok: !result.failed, text: result.text };
  }

  return { status, canRun, run: run_, sudoersContent: () => sudoersContent(user), sudoersPath };
}

module.exports = {
  createPrivilegedHelper,
  sudoersContent,
  assertNoWildcards,
  actionArgv,
  ACTIONS,
  SUDOERS_PATH,
};
