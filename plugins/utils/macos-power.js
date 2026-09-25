'use strict';

const { execFile } = require('child_process');
const { createPrivilegedHelper } = require('../../src/privileged-helper');
const { createPowerd } = require('../../src/powerd');

function isAvailable(platform = process.platform) {
  return platform === 'darwin';
}

function parseLidSleepPrevention(output) {
  const systemValue = String(output).match(/^\s*SleepDisabled\s+(\d+)\s*$/mi);
  if (systemValue) return Number(systemValue[1]) === 1;

  const values = [...String(output).matchAll(/^\s*disablesleep\s+(\d+)\s*$/gm)]
    .map(match => Number(match[1]));
  return values.length > 0 && values.every(value => value === 1);
}

function runFile(file, args, options, run = execFile) {
  return new Promise((resolve, reject) => {
    run(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

async function getLidSleepPrevention(options = {}) {
  const platform = options.platform || process.platform;
  if (!isAvailable(platform)) return { available: false, enabled: false };

  const output = await runFile('/usr/bin/pmset', ['-g'], {
    encoding: 'utf8',
    timeout: 5000,
  }, options.execFile || execFile);
  return { available: true, enabled: parseLidSleepPrevention(output) };
}

async function setLidSleepPrevention(enabled, options = {}) {
  const platform = options.platform || process.platform;
  if (!isAvailable(platform)) throw new Error('This setting is only available on macOS');

  const value = enabled ? '1' : '0';

  // First choice: the powerd LaunchDaemon. Recording the intent is what makes
  // "on" survive other programs resetting it; launchd runs the job as soon as
  // the file changes, so wait briefly for the setting to land. If it does not
  // (daemon not loaded, launchd slow), the intent is still recorded and the
  // one-shot paths below apply the change now.
  const powerd = options.powerd || createPowerd({ platform });
  if (powerd.setIntent(enabled)) {
    const deadline = Date.now() + (options.powerdWaitMs ?? 6000);
    for (;;) {
      const status = await getLidSleepPrevention(options);
      if (status.enabled === enabled) return status;
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, options.powerdPollMs ?? 250));
    }
  }

  // Next: the optional sudoers helper, which runs this exact
  // command with no password. It returns null when it is not installed (the
  // normal case) rather than failing, so the prompt below stays the fallback
  // and nothing about this function's contract depends on the helper existing.
  const helper = options.privileged || createPrivilegedHelper({ platform, run: options.execFile || execFile });
  const viaHelper = await helper.run(enabled ? 'lid-sleep-on' : 'lid-sleep-off');
  if (!viaHelper || !viaHelper.ok) {
    const script = `do shell script "/usr/bin/pmset -a disablesleep ${value}" with administrator privileges`;
    try {
      await runFile('/usr/bin/osascript', ['-e', script], { timeout: 120000 }, options.execFile || execFile);
    } catch (error) {
      const detail = `${error.message || ''} ${error.stderr || ''}`;
      if (/User canceled|(-128)/i.test(detail)) {
        throw new Error('Administrator authorization was canceled');
      }
      throw new Error(`Failed to update macOS power settings: ${error.message}`);
    }
  }

  const status = await getLidSleepPrevention(options);
  if (status.enabled !== enabled) {
    throw new Error('macOS power setting did not take effect');
  }
  return status;
}

function parseBatteryStatus(output) {
  const text = String(output);
  const sourceMatch = text.match(/drawing from '([^']+)'/i);
  const percentMatch = text.match(/(\d+)%;/);
  // pmset prints e.g. "Now drawing from 'Battery Power'" / "'AC Power'".
  const source = sourceMatch
    ? (/battery/i.test(sourceMatch[1]) ? 'battery' : 'ac')
    : null;
  const percent = percentMatch ? Number(percentMatch[1]) : null;
  return { source, percent };
}

async function readBattery(options = {}) {
  const platform = options.platform || process.platform;
  if (!isAvailable(platform)) return { available: false, source: null, percent: null };

  const output = await runFile('/usr/bin/pmset', ['-g', 'batt'], {
    encoding: 'utf8',
    timeout: 5000,
  }, options.execFile || execFile);
  const { source, percent } = parseBatteryStatus(output);
  return { available: true, source, percent };
}

// Immediate sleep without root: pmset sleepnow usually needs root, so fall back
// to user-level Apple events. Each method is tried in order until one succeeds.
async function sleepNow(options = {}) {
  const attempts = [
    { method: 'pmset', file: '/usr/bin/pmset', args: ['sleepnow'] },
    { method: 'system-events', file: '/usr/bin/osascript', args: ['-e', 'tell application "System Events" to sleep'] },
    { method: 'finder', file: '/usr/bin/osascript', args: ['-e', 'tell application "Finder" to sleep'] },
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      await runFile(attempt.file, attempt.args, { timeout: 15000 }, options.execFile || execFile);
      return { ok: true, method: attempt.method };
    } catch (error) {
      errors.push(`${attempt.method}: ${error.message || error}`);
    }
  }
  return { ok: false, errors };
}

module.exports = {
  getLidSleepPrevention,
  isAvailable,
  parseBatteryStatus,
  parseLidSleepPrevention,
  readBattery,
  setLidSleepPrevention,
  sleepNow,
};
