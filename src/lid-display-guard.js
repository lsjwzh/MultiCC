'use strict';

// 合盖熄屏 / 开盖点亮：合盖时关掉显示器（只熄屏，不睡系统），开盖时唤回来。
//
// 为什么需要它（2026-09-28 实测）：「关盖运行」把 SleepDisabled 设成 1，掐掉了
// 「合盖 → 睡」这条链，而 macOS 在**不能睡**的时候不会顺手关内屏 —— 于是盖合着、
// 屏还亮着，白烧整块屏 + WindowServer + 前台渲染。
//
// 为什么住在 server 进程里，而不是再来一个 LaunchAgent：这个守卫只在「关盖运行」
// 期间有意义，而「关盖运行」的意义就是 MultiCC 还活着 —— 那个常驻进程就是 server
// 自己。搬进来只多花每轮一次 ioreg（7.7ms），而且屏亮着的时候连 pmset 都不用查；
// 换来的是少一个 LaunchAgent、少一个 bash 循环、少一份自管日志、少一条 plist 安装链。
//
// 能做的只有两条，都不需要 root：
//   ① 合盖且屏还亮 → `pmset displaysleepnow`（合盖期间被外设唤醒的，下一轮再熄）
//   ② 刚开盖       → `caffeinate -u -t 1` 保险唤醒（屏已亮时无害）
//
// 轮询两档：合盖 5s（唯一需要灵敏的时段 —— 等你开盖 / 把被唤醒的屏再熄掉），
// 开盖 60s（你在用电脑，这时什么都别做）。
//
// 判「屏亮没亮」只能信 powerd 的断言（`pmset -g assertions` 里的
// 'Prevent sleep while display is on'）：AppleARMBacklight 的 brightness /
// BrightnessMicroAmps 熄屏前后**一个字节都不变**（2026-09-28 对照实测
// 3558µA / 168775mNit 熄屏前后相同），拿它判断会永远以为屏是亮的。
//
// 动作只在「决策发生变化」时发一次，不是每轮都发：外接显示器合盖当主机用时屏是
// **该亮**的，每 5 秒去熄一次就是跟用户抢屏幕；用户合盖后再敲键盘点亮内屏，同理
// 不去关它（决策没变）。命令失败则把上次决策清成 none，下一轮重试一次。
const { execFile } = require('node:child_process');

const CLOSED_MS = 5000;
const OPEN_MS = 60000;
const PROBE_TIMEOUT_MS = 5000;

// 纯函数，便于把决策表钉死在测试里。
function clamshellClosed(output) {
  return /"AppleClamshellState"\s*=\s*Yes/.test(String(output));
}

function displayOn(output) {
  return /Prevent sleep while display is on/.test(String(output));
}

// closed 盖合? on 屏亮? prev 上一轮盖状态 → off（熄屏）| wake（唤醒）| none（不动）
function decide(closed, on, prev) {
  if (closed) return on ? 'off' : 'none';
  return prev ? 'wake' : 'none';
}

// 合盖走快档，为的是秒级发现开盖。
function intervalFor(closed, { closedMs = CLOSED_MS, openMs = OPEN_MS } = {}) {
  return closed ? closedMs : openMs;
}

function runFile(file, args, run) {
  return new Promise((resolve) => {
    run(file, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

function createLidDisplayGuard({
  platform = process.platform,
  run = execFile,
  log = () => {},
  closedMs = CLOSED_MS,
  openMs = OPEN_MS,
} = {}) {
  let timer = null;
  let busy = false;
  let lastAction = 'none';
  let prevClosed = false;
  let lastError = null;
  let lastRunAt = null;
  const state = { closed: null, displayOn: null };

  function isAvailable() {
    return platform === 'darwin';
  }

  function running() {
    return timer !== null;
  }

  async function act(action) {
    if (action === 'none' || action === lastAction) {
      lastAction = action;
      return;
    }
    const [file, args] = action === 'off'
      ? ['/usr/bin/pmset', ['displaysleepnow']]
      : ['/usr/bin/caffeinate', ['-u', '-t', '1']];
    const output = await runFile(file, args, run);
    if (output === null) {
      // 失败就当这一轮没发生过：清掉上次决策，下一轮同一条决策会再来一次。
      lastError = action === 'off' ? 'displaysleepnow failed' : 'display wake failed';
      lastAction = 'none';
      log(`lid-display-guard: ${lastError}`);
      return;
    }
    lastAction = action;
    lastRunAt = Date.now();
    log(action === 'off' ? 'lid-display-guard: 合盖 -> 熄屏' : 'lid-display-guard: 开盖 -> 唤醒显示器');
  }

  async function tick() {
    if (!isAvailable() || busy) return getStatus();
    busy = true;
    try {
      const clamshell = await runFile('/usr/bin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '1'], run);
      if (clamshell === null) {
        lastError = 'ioreg failed';
        return getStatus();
      }
      const closed = clamshellClosed(clamshell);
      let on = false;
      let known = true;
      if (closed) {
        const display = await runFile('/usr/bin/pmset', ['-g', 'assertions'], run);
        known = display !== null;
        if (!known) lastError = 'pmset failed';
        else on = displayOn(display);
      }
      state.closed = closed;
      // 开盖时不查 pmset，屏的实况是「不知道」而不是「灭着」。
      state.displayOn = closed ? (known ? on : null) : null;
      if (known) {
        lastError = null;
        await act(decide(closed, on, prevClosed));
      }
      prevClosed = closed;
    } catch (error) {
      lastError = error.message || String(error);
    } finally {
      busy = false;
      schedule();
    }
    return getStatus();
  }

  function schedule() {
    if (!running()) return;
    timer = setTimeout(() => { void tick(); }, intervalFor(state.closed === true, { closedMs, openMs }));
    if (typeof timer.unref === 'function') timer.unref();
  }

  function start() {
    if (!isAvailable() || running()) return getStatus();
    // 新一轮从「盖的状态未知、什么都没做过」开始：第一轮只读状态，不动屏幕。
    lastAction = 'none';
    prevClosed = false;
    state.closed = null;
    state.displayOn = null;
    lastError = null;
    timer = setTimeout(() => { void tick(); }, 0);
    if (typeof timer.unref === 'function') timer.unref();
    return getStatus();
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
    state.closed = null;
    state.displayOn = null;
    lastError = null;
    return getStatus();
  }

  // 跟着「关盖运行」的实况走：开关开着（pmset 说 SleepDisabled=1）就守，关了就不守。
  // 幂等，UI 每次读到电源状态时调一次即可，不必另做一套持久化开关。
  function sync(enabled) {
    if (!isAvailable()) return getStatus();
    if (enabled) start(); else stop();
    return getStatus();
  }

  function getStatus() {
    return {
      available: isAvailable(),
      enabled: running(),
      closed: state.closed,
      displayOn: state.displayOn,
      lastAction,
      lastRunAt,
      error: lastError,
    };
  }

  return { isAvailable, getStatus, start, stop, sync, tick };
}

module.exports = {
  createLidDisplayGuard,
  decide,
  intervalFor,
  clamshellClosed,
  displayOn,
  CLOSED_MS,
  OPEN_MS,
};
