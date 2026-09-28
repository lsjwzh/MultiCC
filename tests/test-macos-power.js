'use strict';

const assert = require('assert');
const {
  elevatedCommand,
  getLidSleepPrevention,
  getLidModeSettings,
  isAvailable,
  parseBatteryStatus,
  parseLidSleepPrevention,
  readBattery,
  setLidSleepPrevention,
  sleepNow,
} = require('../plugins/utils/macos-power');

// The daemon path is covered in test-powerd.js; here it is always absent so
// these cases never touch a real intent file on a machine that has it installed.
const NO_POWERD = { setIntent: () => false };
// The elevated path must not depend on whether this checkout happens to carry
// the installer, so the prompt cases name a path that does not exist (the
// plain-pmset command) — the combined command has its own case below.
const NO_INSTALLER = require('node:path').join(__dirname, '../scripts/install-powerd.sh');

assert.strictEqual(isAvailable('darwin'), true);
assert.strictEqual(isAvailable('linux'), false);

assert.strictEqual(parseLidSleepPrevention(`
Battery Power:
 disablesleep          1
AC Power:
 disablesleep          1
`), true);
assert.strictEqual(parseLidSleepPrevention('System-wide power settings:\n SleepDisabled\t\t1\n'), true);
assert.strictEqual(parseLidSleepPrevention('System-wide power settings:\n SleepDisabled\t\t0\n'), false);
assert.strictEqual(parseLidSleepPrevention('Battery Power:\n sleep 1\n'), false);
assert.strictEqual(parseLidSleepPrevention('disablesleep 1\ndisablesleep 0\n'), false);

(async () => {
  assert.deepStrictEqual(await getLidSleepPrevention({ platform: 'linux' }), {
    available: false,
    enabled: false,
  });

  for (const [intent, observed, expected] of [['off', 1, false], ['none', 1, false], ['on', 0, true], ['on', 1, true]]) {
    const settings = await getLidModeSettings({
      platform: 'darwin', powerd: { readIntent: () => intent },
      execFile: (file, args, options, cb) => cb(null, `SleepDisabled ${observed}\n`, ''),
    });
    assert.deepStrictEqual(settings, { available: true, enabled: expected, systemSleepDisabled: !!observed });
  }

  let readArgs;
  assert.deepStrictEqual(await getLidSleepPrevention({
    platform: 'darwin',
    execFile(file, args, options, callback) {
      readArgs = { file, args, options };
      callback(null, 'System-wide power settings:\n SleepDisabled 1\n', '');
    },
  }), { available: true, enabled: true });
  assert.strictEqual(readArgs.file, '/usr/bin/pmset');
  assert.deepStrictEqual(readArgs.args, ['-g']);
  assert.strictEqual(readArgs.options.encoding, 'utf8');
  assert.strictEqual(readArgs.options.timeout, 5000);

  const invocations = [];
  const status = await setLidSleepPrevention(true, {
    platform: 'darwin',
    powerd: NO_POWERD,
    powerdInstaller: NO_INSTALLER,
    execFile(file, args, options, callback) {
      invocations.push({ file, args, options });
      if (file === '/usr/bin/pmset') {
        callback(null, 'Battery Power:\n disablesleep 1\nAC Power:\n disablesleep 1\n', '');
      } else {
        callback(null, '', '');
      }
    },
  });

  assert.strictEqual(invocations[0].file, '/usr/bin/osascript');
  assert.match(invocations[0].args[1], /install-powerd\.sh/);
  assert.match(invocations[0].args[1], /power-intent/);
  assert.strictEqual(invocations[0].options.timeout, 120000);
  assert.strictEqual(invocations[1].file, '/usr/bin/pmset');
  assert.deepStrictEqual(status, { available: true, enabled: true });

  const combined = elevatedCommand(true, { user: 'green' });
  assert.match(combined, /install 'green' &&/);
  assert.match(combined, /'on' > .*power-intent.* && .*disablesleep 1/);
  assert.throws(() => elevatedCommand(false, { powerdInstaller: '/nonexistent/install.sh' }), /组件缺失/);
  assert.ok(elevatedCommand(true, { user: "a'b" }).includes("'a'\\''b'"), 'shell quotes are escaped independently');

  // powerd 已经装着：写下意图即可，一个密码框都不该弹。
  let daemonIntents = [];
  let daemonStatusReads = 0;
  const daemonStatus = await setLidSleepPrevention(true, {
    platform: 'darwin',
    powerd: { setIntent: (value) => { daemonIntents.push(value); return true; } },
    powerdWaitMs: 50,
    powerdPollMs: 1,
    execFile(file, args, options, callback) {
      daemonStatusReads += 1;
      callback(null, 'System-wide power settings:\n SleepDisabled 1\n', '');
    },
  });
  assert.deepStrictEqual(daemonIntents, [true]);
  assert.strictEqual(daemonStatusReads, 1, '意图生效就该立刻收手，不再问第二次');
  assert.deepStrictEqual(daemonStatus, { available: true, enabled: true });

  await assert.rejects(
    setLidSleepPrevention(false, { platform: 'linux' }),
    /only available on macOS/
  );

  await assert.rejects(
    setLidSleepPrevention(false, {
      platform: 'darwin',
      powerd: NO_POWERD,
      powerdInstaller: NO_INSTALLER,
      execFile(file, args, options, callback) {
        const error = new Error('execution error: User canceled. (-128)');
        callback(error, '', '');
      },
    }),
    /已取消授权/
  );

  await assert.rejects(
    setLidSleepPrevention(true, {
      platform: 'darwin',
      powerd: NO_POWERD,
      powerdInstaller: NO_INSTALLER,
      execFile(file, args, options, callback) {
        callback(null, file === '/usr/bin/pmset' ? 'Battery Power:\n sleep 1\n' : '', '');
      },
    }),
    /系统尚未生效/
  );

  await assert.rejects(
    getLidSleepPrevention({
      platform: 'darwin',
      execFile(file, args, options, callback) {
        callback(new Error('pmset unavailable'), '', 'permission denied');
      },
    }),
    /pmset unavailable/
  );

  // readBattery：pmset -g batt 解析 + 非 macOS 不可用。
  assert.deepStrictEqual(await readBattery({ platform: 'linux' }), {
    available: false,
    source: null,
    percent: null,
  });

  let battArgs;
  assert.deepStrictEqual(await readBattery({
    platform: 'darwin',
    execFile(file, args, options, callback) {
      battArgs = { file, args };
      callback(null, "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t7%; discharging; present: true\n", '');
    },
  }), { available: true, source: 'battery', percent: 7 });
  assert.deepStrictEqual(battArgs.args, ['-g', 'batt']);

  assert.deepStrictEqual(parseBatteryStatus("Now drawing from 'AC Power'\n -InternalBattery-0\t100%; charged\n"), { source: 'ac', percent: 100 });

  // sleepNow：三级回退 —— pmset 失败落到 System Events，再失败落到 Finder。
  const sleepCalls = [];
  const failPmset = {
    platform: 'darwin',
    execFile(file, args, options, callback) {
      sleepCalls.push(file);
      if (file === '/usr/bin/pmset') callback(new Error('not root'), '', '');
      else callback(null, '', '');
    },
  };
  assert.deepStrictEqual(await sleepNow(failPmset), { ok: true, method: 'system-events' });
  assert.deepStrictEqual(sleepCalls, ['/usr/bin/pmset', '/usr/bin/osascript']);

  const allFail = {
    platform: 'darwin',
    execFile(file, args, options, callback) {
      sleepCalls.push(file + ':fail');
      callback(new Error('nope'), '', '');
    },
  };
  const failed = await sleepNow(allFail);
  assert.strictEqual(failed.ok, false);
  assert.equal(failed.errors.length, 3);

  console.log('macOS power settings tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
