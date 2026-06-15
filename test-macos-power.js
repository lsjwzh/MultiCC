'use strict';

const assert = require('assert');
const {
  getLidSleepPrevention,
  isAvailable,
  parseLidSleepPrevention,
  setLidSleepPrevention,
} = require('./macos-power');

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

assert.deepStrictEqual(getLidSleepPrevention({ platform: 'linux' }), {
  available: false,
  enabled: false,
});

let readArgs;
assert.deepStrictEqual(getLidSleepPrevention({
  platform: 'darwin',
  execFileSync(file, args) {
    readArgs = { file, args };
    return 'System-wide power settings:\n SleepDisabled 1\n';
  },
}), { available: true, enabled: true });
assert.deepStrictEqual(readArgs, { file: '/usr/bin/pmset', args: ['-g'] });

(async () => {
  let invocation;
  const status = await setLidSleepPrevention(true, {
    platform: 'darwin',
    execFile(file, args, options, callback) {
      invocation = { file, args, options };
      callback(null, '', '');
    },
    execFileSync() {
      return 'Battery Power:\n disablesleep 1\nAC Power:\n disablesleep 1\n';
    },
  });

  assert.strictEqual(invocation.file, '/usr/bin/osascript');
  assert.deepStrictEqual(invocation.args, [
    '-e',
    'do shell script "/usr/bin/pmset -a disablesleep 1" with administrator privileges',
  ]);
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
        callback(null, '', '');
      },
      execFileSync() {
        return 'Battery Power:\n sleep 1\n';
      },
    }),
    /did not take effect/
  );

  console.log('macOS power settings tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
