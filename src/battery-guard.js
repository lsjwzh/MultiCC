'use strict';

// 进程内掉电保护：只在「关盖运行」（pmset disablesleep=1，即系统睡眠被用户故意
// 禁掉）开着时武装。电池放电且电量 ≤ trigger% 时让机器立刻睡眠；触发后闩锁，
// 直到插电或电量回升 ≥ rearm% 才重新武装，避免睡眠-唤醒循环反复触发。
// 语义与早期 root LaunchDaemon 方案（~/.battery-sleep-guard）一致，搬进 server
// 进程后随「关盖运行」开关联动，不再需要单独 sudo 安装。

const NEVER_GUARDED_STATUS = Object.freeze({
  running: false,
  intervalMs: 0,
  thresholds: { trigger: 0, rearm: 0 },
  sleepPrevention: false,
  latched: false,
  triggerCount: 0,
  lastCheckTs: 0,
  lastBattery: null,
  lastSleepResult: null,
  error: null,
});

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('battery guard dependencies are required');
  if (!deps.macosPower || typeof deps.macosPower !== 'object') {
    throw new TypeError('battery guard dependency missing: macosPower');
  }
  for (const name of ['readBattery', 'getLidSleepPrevention', 'sleepNow']) {
    if (typeof deps.macosPower[name] !== 'function') {
      throw new TypeError(`battery guard dependency missing: macosPower.${name}`);
    }
  }
  return deps;
}

function createBatteryGuardRuntime(rawDeps) {
  const deps = assertDependencies(rawDeps);
  const {
    macosPower,
    logger = console,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    intervalMs = 60 * 1000,
    thresholds = { trigger: 5, rearm: 8 },
  } = deps;
  if (!(thresholds.trigger >= 1 && thresholds.rearm > thresholds.trigger)) {
    throw new TypeError('battery guard thresholds require rearm > trigger >= 1');
  }

  let timer = null;
  let checking = false;
  let latched = false;
  let triggerCount = 0;
  let sleepPrevention = false;
  let lastCheckTs = 0;
  let lastBattery = null;
  let lastSleepResult = null;
  let error = null;

  function getStatus() {
    return {
      running: timer !== null,
      intervalMs,
      thresholds: { ...thresholds },
      sleepPrevention,
      latched,
      triggerCount,
      lastCheckTs,
      lastBattery: lastBattery ? { ...lastBattery } : null,
      lastSleepResult: lastSleepResult ? { ...lastSleepResult } : null,
      error,
    };
  }

  async function check() {
    if (checking) return getStatus();
    checking = true;
    try {
      const [battery, lid] = await Promise.all([
        macosPower.readBattery(),
        macosPower.getLidSleepPrevention(),
      ]);
      lastCheckTs = Date.now();
      lastBattery = { source: battery.source, percent: battery.percent };
      sleepPrevention = !!lid.enabled;
      error = null;

      const percent = battery.percent;
      if (percent == null || !battery.source) return getStatus();

      // 闩锁复位：插电或回升到 rearm 以上才允许下一次触发（关盖运行已关也复位）。
      if (latched && (battery.source === 'ac' || percent >= thresholds.rearm || !sleepPrevention)) {
        latched = false;
      }

      if (!latched && sleepPrevention && battery.source === 'battery' && percent <= thresholds.trigger) {
        lastSleepResult = await macosPower.sleepNow();
        latched = true;
        triggerCount += 1;
        if (lastSleepResult && lastSleepResult.ok) {
          logger.log(`[multicc/battery-guard] battery ${percent}% <= ${thresholds.trigger}% while sleep prevention is on -> slept via ${lastSleepResult.method}`);
        } else {
          logger.warn('[multicc/battery-guard] battery trigger reached but every sleep method failed', lastSleepResult);
        }
      }
      return getStatus();
    } catch (caught) {
      error = caught && caught.message ? caught.message : String(caught);
      // 电池读数偶发失败不应杀掉轮询；只在连续失败时留状态供 API 观察。
      return getStatus();
    } finally {
      checking = false;
    }
  }

  function start() {
    if (timer !== null) return;
    timer = setIntervalFn(() => { void check(); }, intervalMs);
    void check();
    return runtime;
  }

  function stop() {
    if (timer === null) return;
    clearIntervalFn(timer);
    timer = null;
  }

  const runtime = { start, stop, check, getStatus };
  return runtime;
}

module.exports = {
  NEVER_GUARDED_STATUS,
  createBatteryGuardRuntime,
};
