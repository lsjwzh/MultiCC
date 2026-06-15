'use strict';

const { execFile, execFileSync } = require('child_process');

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

function getLidSleepPrevention(options = {}) {
  const platform = options.platform || process.platform;
  if (!isAvailable(platform)) return { available: false, enabled: false };

  const runSync = options.execFileSync || execFileSync;
  const output = runSync('/usr/bin/pmset', ['-g'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return { available: true, enabled: parseLidSleepPrevention(output) };
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

async function setLidSleepPrevention(enabled, options = {}) {
  const platform = options.platform || process.platform;
  if (!isAvailable(platform)) throw new Error('This setting is only available on macOS');

  const value = enabled ? '1' : '0';
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

  const status = getLidSleepPrevention(options);
  if (status.enabled !== enabled) {
    throw new Error('macOS power setting did not take effect');
  }
  return status;
}

module.exports = {
  getLidSleepPrevention,
  isAvailable,
  parseLidSleepPrevention,
  setLidSleepPrevention,
};
