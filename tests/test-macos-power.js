'use strict';

const assert = require('assert');
const {
  getLidSleepPrevention,
  isAvailable,
  parseLidSleepPrevention,
  setLidSleepPrevention,
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

  console.log('macOS power settings tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
