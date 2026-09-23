'use strict';
// The privileged helper grants passwordless root for a fixed list of commands,
// so what is worth locking is not that it works but that it cannot be widened:
// the whitelist stays minimal and literal, the generated sudoers file is what
// sudo will actually honour, and a missing helper degrades to the password
// prompt instead of failing.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createPrivilegedHelper, sudoersContent, assertNoWildcards, actionArgv, ACTIONS,
} = require('../src/privileged-helper');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'install-privileged-helper.sh');
const fail = () => ({ error: Object.assign(new Error('x'), { code: 1 }) });

function fakeRun(script, calls = []) {
  const run = (file, args, options, cb) => {
    calls.push([file, ...args]);
    const reply = script(file, args) || {};
    cb(reply.error || null, reply.stdout || '', reply.stderr || '');
  };
  run.calls = calls;
  return run;
}

// A host where the drop-in is installed: `sudo -n -l <cmd>` succeeds for every
// whitelisted command and the command itself then runs.
const withHelper = () => () => ({ stdout: '' });
const withoutHelper = () => () => fail();

test('the whitelist contains only what genuinely needs root', () => {
  // xcode-select --install works as an ordinary user (it only asks the system
  // installer to show its dialog), so it must not appear here. Every entry is
  // a standing grant of root; an unnecessary one is pure attack surface.
  assert.deepEqual(Object.keys(ACTIONS).sort(), ['lid-sleep-off', 'lid-sleep-on']);
  for (const argv of Object.values(ACTIONS)) assert.equal(argv[0], '/usr/bin/pmset');
});

test('every action is a complete, literal, absolute command line', () => {
  for (const action of Object.keys(ACTIONS)) {
    const argv = actionArgv(action);
    assert.ok(argv[0].startsWith('/'), `${action} must use an absolute path`);
    assert.doesNotThrow(() => assertNoWildcards(argv), action);
  }
  // The guard is what keeps a future edit from silently widening a rule: in
  // sudoers these characters are glob metacharacters, not literals.
  assert.throws(() => assertNoWildcards(['/usr/bin/pmset', '-a', '*']), /wildcard/);
  assert.throws(() => assertNoWildcards(['pmset', '-a']), /absolute path/);
});

test('a username that could escape its sudoers line is refused', () => {
  // The username is the only caller-supplied value that reaches the file.
  for (const bad of ['green ALL=(root) NOPASSWD: ALL #', 'a b', 'x\ny ALL=(root) NOPASSWD: ALL', '']) {
    assert.throws(() => sudoersContent(bad), /unusual username/, JSON.stringify(bad));
  }
  assert.ok(sudoersContent('green').includes('green ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1'));
});

test('the installer script and the module generate the same rules', () => {
  // These are written in two languages and drift silently: if they disagree,
  // the probe reports "installed" for a rule sudo was never given.
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-helper-')), 'sudoers');
  const { status } = require('node:child_process').spawnSync('/bin/sh', [SCRIPT, 'install', 'green'], {
    env: { ...process.env, MULTICC_HELPER_DRYRUN: '1', MULTICC_HELPER_TARGET: target },
    encoding: 'utf8',
  });
  assert.equal(status, 0);
  const rules = (text) => text.split('\n').filter(line => line && !line.startsWith('#')).sort();
  assert.deepEqual(rules(fs.readFileSync(target, 'utf8')), rules(sudoersContent('green')));
  // sudo ignores a drop-in that is group- or world-writable.
  assert.equal(fs.statSync(target).mode & 0o777, 0o440);
});

test('the generated file is valid sudoers, as judged by visudo itself', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-visudo-')), 'sudoers');
  fs.writeFileSync(file, sudoersContent('green'), { mode: 0o440 });
  const { status } = require('node:child_process').spawnSync('visudo', ['-c', '-f', file], { encoding: 'utf8' });
  // A malformed drop-in disables sudo for the whole machine, so this is checked
  // before install — by the same tool that will read it.
  assert.equal(status, 0, 'visudo rejected the generated file');
});

test('status is decided by asking sudo, not by looking for the file', () => {
  const run = fakeRun(withHelper());
  return createPrivilegedHelper({ platform: 'darwin', run, user: 'green' }).status().then((status) => {
    assert.equal(status.installed, true);
    assert.deepEqual(status.actions, { 'lid-sleep-on': true, 'lid-sleep-off': true });
    // `sudo -n -l <cmd>` asks whether it *could* run; it never runs anything.
    assert.ok(run.calls.every(c => c[0] === '/usr/bin/sudo' && c[1] === '-n' && c[2] === '-l'));
  });
});

test('a partially granted drop-in counts as not installed', async () => {
  // The state after an upgrade adds an action: reporting "installed" here would
  // leave the user with a switch that silently keeps asking for a password.
  const run = fakeRun((file, args) => (args.includes('disablesleep') && args.includes('1') ? { stdout: '' } : fail()));
  const status = await createPrivilegedHelper({ platform: 'darwin', run, user: 'green' }).status();
  assert.equal(status.installed, false);
  assert.deepEqual(status.actions, { 'lid-sleep-on': true, 'lid-sleep-off': false });
});

test('without the helper, run() declines rather than failing', async () => {
  // null is the signal callers use to fall back to the password prompt; an
  // exception here would turn the normal, un-installed state into an error.
  const helper = createPrivilegedHelper({ platform: 'darwin', run: fakeRun(withoutHelper()), user: 'green' });
  assert.equal(await helper.run('lid-sleep-on'), null);
});

test('an unknown action is rejected before anything is spawned', async () => {
  const run = fakeRun(withHelper());
  const helper = createPrivilegedHelper({ platform: 'darwin', run, user: 'green' });
  await assert.rejects(helper.run('rm-rf'), /unknown action/);
  assert.deepEqual(run.calls, [], 'nothing is spawned for an action that is not whitelisted');
});

test('off macOS the helper is inert', async () => {
  const run = fakeRun(withHelper());
  const helper = createPrivilegedHelper({ platform: 'linux', run, user: 'green' });
  assert.deepEqual(await helper.status(), { platform: 'linux', applicable: false, installed: false, actions: {} });
  assert.equal(await helper.run('lid-sleep-on'), null);
  assert.deepEqual(run.calls, [], 'sudo is never invoked off macOS');
});

test('lid sleep prefers the helper and falls back to the prompt', async () => {
  const macosPower = require('../plugins/utils/macos-power');
  const seen = [];
  const execFileFake = (file, args, options, cb) => {
    seen.push([file, ...args]);
    if (file === '/usr/bin/pmset' && args[0] === '-g') return cb(null, 'SleepDisabled 1\n', '');
    cb(null, '', '');
  };
  // Helper present: pmset runs through sudo and osascript is never involved.
  await macosPower.setLidSleepPrevention(true, {
    platform: 'darwin', execFile: execFileFake,
    privileged: createPrivilegedHelper({ platform: 'darwin', run: fakeRun(withHelper()), user: 'green' }),
  });
  assert.ok(!seen.some(c => c[0] === '/usr/bin/osascript'), 'no password prompt when the helper is installed');

  seen.length = 0;
  // Helper absent: the existing prompt path is used, unchanged.
  await macosPower.setLidSleepPrevention(true, {
    platform: 'darwin', execFile: execFileFake,
    privileged: createPrivilegedHelper({ platform: 'darwin', run: fakeRun(withoutHelper()), user: 'green' }),
  });
  assert.ok(seen.some(c => c[0] === '/usr/bin/osascript' && /with administrator privileges/.test(c[2])),
    'falls back to prompting for a password');
});

test('execFile is the real default so nothing depends on a test double', () => {
  assert.equal(typeof execFile, 'function');
  assert.doesNotThrow(() => createPrivilegedHelper());
});
