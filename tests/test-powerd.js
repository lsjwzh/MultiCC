'use strict';

// com.multicc.powerd: the reconcile job itself (run for real against a fake
// pmset), the installer's generated layout (dry run, no root), and the Node
// side that writes the intent. Nothing here needs root or touches /Library.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createPowerd } = require('../src/powerd');

const DAEMON = path.join(__dirname, '..', 'scripts', 'multicc-powerd.sh');
const INSTALLER = path.join(__dirname, '..', 'scripts', 'install-powerd.sh');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-powerd-'));
  const value = path.join(dir, 'pmset-value');
  const log = path.join(dir, 'pmset-log');
  const pmset = path.join(dir, 'pmset');
  fs.writeFileSync(value, '0');
  // Mimics the two pmset forms the job uses: `-g` (report) and `-a disablesleep N`.
  fs.writeFileSync(pmset, `#!/bin/sh
if [ "$1" = "-g" ]; then printf 'System-wide power settings:\\n SleepDisabled\\t\\t%s\\n' "$(cat '${value}')"; exit 0; fi
echo "$*" >> '${log}'
[ "$1 $2" = "-a disablesleep" ] && printf '%s' "$3" > '${value}'
`, { mode: 0o755 });
  const run = () => {
    execFileSync('/bin/sh', [DAEMON], { env: { PATH: process.env.PATH, MULTICC_POWERD_DIR: dir, MULTICC_POWERD_PMSET: pmset } });
    return JSON.parse(fs.readFileSync(path.join(dir, 'powerd-status.json'), 'utf8'));
  };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  return {
    dir, run, calls,
    setIntent: (word) => fs.writeFileSync(path.join(dir, 'power-intent'), word),
    externalReset: (v) => fs.writeFileSync(value, v),
    value: () => fs.readFileSync(value, 'utf8'),
  };
}

test('daemon: no intent file means unmanaged — pmset is never written', { skip: isRoot }, () => {
  const s = sandbox();
  const status = s.run();
  assert.equal(status.intent, 'none');
  assert.equal(status.action, 'none');
  assert.deepEqual(s.calls(), []);
});

test('daemon: "on" is held and an external reset is restored and counted', { skip: isRoot }, () => {
  const s = sandbox();
  s.setIntent('on\n');
  let status = s.run();
  assert.equal(status.action, 'set-1');
  assert.equal(status.observed, '1');
  assert.equal(status.restores, 0, 'first application is not a restore');

  status = s.run();
  assert.equal(status.action, 'none', 'already at intent: idempotent');

  s.externalReset('0'); // what UU Remote's helper does
  status = s.run();
  assert.equal(status.action, 'set-1');
  assert.equal(status.restores, 1);
  assert.match(status.lastRestoreAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(s.value(), '1');
});

test('daemon: "off" applies once and then leaves other apps alone', { skip: isRoot }, () => {
  const s = sandbox();
  s.externalReset('1');
  s.setIntent('off');
  assert.equal(s.run().action, 'set-0');
  s.externalReset('1'); // another app keeps the machine awake on purpose
  assert.equal(s.run().action, 'none');
  assert.equal(s.value(), '1');
});

test('daemon: anything but on/off, or a symlinked intent, is ignored', { skip: isRoot }, () => {
  const s = sandbox();
  s.setIntent('on; rm -rf /');
  assert.equal(s.run().action, 'none');
  fs.rmSync(path.join(s.dir, 'power-intent'));
  const target = path.join(s.dir, 'elsewhere');
  fs.writeFileSync(target, 'on');
  fs.symlinkSync(target, path.join(s.dir, 'power-intent'));
  const status = s.run();
  assert.equal(status.intent, 'none');
  assert.deepEqual(s.calls(), []);
});

test('installer: dry run produces a valid, correctly-moded layout and uninstalls cleanly', { skip: process.platform !== 'darwin' }, () => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-powerd-install-'));
  const env = { PATH: process.env.PATH, MULTICC_POWERD_DRYRUN: '1', MULTICC_POWERD_PREFIX: prefix };
  execFileSync('/bin/sh', [INSTALLER, 'install', 'green'], { env });

  const job = path.join(prefix, 'Library/PrivilegedHelperTools/com.multicc.powerd');
  const plist = path.join(prefix, 'Library/LaunchDaemons/com.multicc.powerd.plist');
  const intent = path.join(prefix, 'Library/Application Support/multicc/power-intent');
  assert.equal(fs.readFileSync(job, 'utf8'), fs.readFileSync(DAEMON, 'utf8'));
  assert.equal(fs.statSync(job).mode & 0o777, 0o755);
  assert.equal(fs.statSync(plist).mode & 0o777, 0o644);
  assert.equal(fs.readFileSync(intent, 'utf8'), '', 'a fresh install starts unmanaged');

  const parsed = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }));
  assert.equal(parsed.Label, 'com.multicc.powerd');
  assert.deepEqual(parsed.ProgramArguments, ['/bin/sh', '/Library/PrivilegedHelperTools/com.multicc.powerd']);
  assert.deepEqual(parsed.WatchPaths, ['/Library/Application Support/multicc/power-intent']);
  assert.equal(parsed.UserName, undefined, 'no UserName: launchd runs it as root');
  assert.equal(parsed.KeepAlive, undefined, 'not resident: runs on change/interval and exits');
  assert.equal(parsed.MachServices, undefined, 'no listener of any kind');

  fs.writeFileSync(intent, 'on\n');
  execFileSync('/bin/sh', [INSTALLER, 'install', 'green'], { env });
  assert.equal(fs.readFileSync(intent, 'utf8'), 'on\n', 'reinstall keeps the user intent');

  assert.throws(() => execFileSync('/bin/sh', [INSTALLER, 'install', 'bad user'], { env, stdio: 'pipe' }));

  execFileSync('/bin/sh', [INSTALLER, 'uninstall'], { env });
  assert.ok(!fs.existsSync(job) && !fs.existsSync(plist) && !fs.existsSync(intent));
});

test('client: installed only when the plist exists and the intent is writable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-powerd-client-'));
  const plistPath = path.join(dir, 'job.plist');
  const powerd = createPowerd({ platform: 'darwin', dataDir: dir, plistPath });
  assert.equal(powerd.setIntent(true), false, 'not installed: caller falls back');
  fs.writeFileSync(plistPath, '');
  fs.writeFileSync(powerd.intentPath, '');
  assert.equal(powerd.setIntent(true), true);
  assert.equal(powerd.readIntent(), 'on');
  powerd.setIntent(false);
  assert.equal(powerd.status().intent, 'off');
  assert.equal(createPowerd({ platform: 'linux', dataDir: dir, plistPath }).installed(), false);
});

test('setLidSleepPrevention prefers the daemon: no sudo, no password prompt', async () => {
  const macosPower = require('../plugins/utils/macos-power');
  let value = '0';
  const seen = [];
  const execFile = (file, args, options, cb) => {
    seen.push(file);
    cb(null, file === '/usr/bin/pmset' ? `SleepDisabled ${value}\n` : '', '');
  };
  const powerd = { setIntent: (on) => { setTimeout(() => { value = on ? '1' : '0'; }, 30); return true; } };
  const status = await macosPower.setLidSleepPrevention(true, {
    platform: 'darwin', execFile, powerd, powerdPollMs: 10,
    privileged: { run: async () => assert.fail('sudo helper must not be used') },
  });
  assert.deepEqual(status, { available: true, enabled: true });
  assert.ok(seen.every(f => f === '/usr/bin/pmset'), 'only pmset reads, no osascript');

  // Daemon installed but not taking effect in time: the one-shot path still applies it.
  value = '0';
  const fallback = await macosPower.setLidSleepPrevention(true, {
    platform: 'darwin', powerdWaitMs: 30, powerdPollMs: 10,
    powerd: { setIntent: () => true },
    privileged: { run: async () => { value = '1'; return { ok: true }; } },
    execFile,
  });
  assert.equal(fallback.enabled, true);
});
