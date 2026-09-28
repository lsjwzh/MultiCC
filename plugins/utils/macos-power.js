'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPowerd } = require('../../src/powerd');

const ELEVATE_TIMEOUT_MS = 120000;
const POWERD_INSTALLER = path.join(__dirname, '..', '..', 'scripts', 'install-powerd.sh');

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

// 轮询等设置落地：powerd 是 launchd 按 WatchPaths 拉起来的，从写完 power-intent 到
// pmset 真的变过来有几百毫秒。生效返回那一刻的状态，超时返回 null（超时不代表失败：
// 意图已经记下了，只是这一次没能确认）。
async function settlesTo(enabled, options = {}) {
  const deadline = Date.now() + (options.powerdWaitMs ?? 6000);
  for (;;) {
    const status = await getLidSleepPrevention(options);
    if (status.enabled === enabled) return status;
    if (Date.now() >= deadline) return null;
    await new Promise(resolve => setTimeout(resolve, options.powerdPollMs ?? 250));
  }
}

// AppleScript 把整条命令当**一个双引号字符串**收，所以这两个字符要在边界上转义。
// 插进来的只有一个仓库内路径和一个用户名（脚本自己还会再校验一次）。
const forAppleScript = (text) => String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

// 「关盖运行」要改的是一条只有 root 能改的设置，所以第一次必然要一次管理员授权 ——
// 这一次顺手把 powerd 也装上。装完以后这个设置由 launchd 守着（重启、别的程序改回去
// 都会被恢复），而 MultiCC 之后每次切换只需要往 power-intent 里写一个词：这就是
// 「输一次密码，以后不再出」。脚本缺失（比如独立包里没带上）也照改设置，那种机器只是
// 每次切换都要再问一次密码，功能不会因此不能用。
function elevatedCommand(enabled, { user = os.userInfo().username, powerdInstaller = POWERD_INSTALLER } = {}) {
  const pmset = `/usr/bin/pmset -a disablesleep ${enabled ? '1' : '0'}`;
  if (!fs.existsSync(powerdInstaller)) return pmset;
  const install = `/bin/sh '${forAppleScript(powerdInstaller)}' install '${forAppleScript(user)}' >/dev/null 2>&1`;
  // 分隔符是分号不是 &&：powerd 装不上时，这次授权至少要真的把设置改掉。
  return `${install}; ${pmset}`;
}

async function elevateLidSleep(enabled, options = {}) {
  const command = elevatedCommand(enabled, options);
  const script = `do shell script "${forAppleScript(command)}" with administrator privileges`;
  try {
    await runFile('/usr/bin/osascript', ['-e', script], {
      encoding: 'utf8',
      timeout: ELEVATE_TIMEOUT_MS,
    }, options.execFile || execFile);
  } catch (error) {
    const detail = `${error.message || ''} ${error.stderr || ''}`;
    if (/User canceled|(-128)/i.test(detail)) {
      throw new Error('Administrator authorization was canceled');
    }
    throw new Error(`Failed to update macOS power settings: ${error.message}`);
  }
}

async function setLidSleepPrevention(enabled, options = {}) {
  const platform = options.platform || process.platform;
  if (!isAvailable(platform)) throw new Error('This setting is only available on macOS');

  // ① powerd 已经在守（第一次开启时装上的）：写下意图就够了，launchd 会照做，
  //    这次切换不需要任何密码，重启之后也还是这个意图。
  const powerd = options.powerd || createPowerd({ platform });
  const settled = powerd.setIntent(enabled) ? await settlesTo(enabled, options) : null;
  if (settled) return settled;

  // ② 没装上 / 没在跑：弹一次管理员授权框，一次做完「装 powerd + 改设置」。
  await (options.elevate || elevateLidSleep)(enabled, options);

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
  elevatedCommand,
  getLidSleepPrevention,
  isAvailable,
  parseBatteryStatus,
  parseLidSleepPrevention,
  readBattery,
  setLidSleepPrevention,
  sleepNow,
};
