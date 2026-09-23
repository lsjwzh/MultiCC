'use strict';

const assert = require('assert');
const {
  getLidSleepPrevention,
  isAvailable,
  parseBatteryStatus,
  parseLidSleepPrevention,
  readBattery,
  setLidSleepPrevention,
  sleepNow,
} = require('../plugins/utils/macos-power');

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
    // No privileged helper installed — the case this block is about. Stated
    // explicitly because the injected execFile below answers every command
    // successfully, which would otherwise look like a helper that is present.
    privileged: { run: async () => null },
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
  assert.deepStrictEqual(invocations[0].args, [
    '-e',
    'do shell script "/usr/bin/pmset -a disablesleep 1" with administrator privileges',
  ]);
  assert.strictEqual(invocations[0].options.timeout, 120000);
  assert.strictEqual(invocations[1].file, '/usr/bin/pmset');
  assert.deepStrictEqual(status, { available: true, enabled: true });

  await assert.rejects(
    setLidSleepPrevention(false, { platform: 'linux' }),
    /only available on macOS/
  );

  await assert.rejects(
    setLidSleepPrevention(false, {
      platform: 'darwin',
      execFile(file, args, options, callback) {
        const error = new Error('execution error: User canceled. (-128)');
        callback(error, '', '');
      },
    }),
    /authorization was canceled/
  );

  await assert.rejects(
    setLidSleepPrevention(true, {
      platform: 'darwin',
      execFile(file, args, options, callback) {
        callback(null, file === '/usr/bin/pmset' ? 'Battery Power:\n sleep 1\n' : '', '');
      },
    }),
    /did not take effect/
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
