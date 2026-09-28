'use strict';

// Host 电源设置的三个共享单例（合盖熄屏守卫的轮询、unlock-password 的钥匙串读写、
// unlock-probe 的 Agent 读取授权探测）。server.js 已经顶到 3000 行硬上限，路由模块直接
// 在这里拿单例，不再需要从 server.js 注入；测试可以通过 deps 覆盖
// （见 host-read/host-write 的 `deps.x || getX()` 回落）。
const { createLidDisplayGuard } = require('./lid-display-guard');
const { createUnlockPassword } = require('./macos-unlock-password');
const { createUnlockProbe } = require('./macos-unlock-probe');

let lidDisplayGuard = null;
let unlockPassword = null;
let unlockProbe = null;

function getLidDisplayGuard() {
  return lidDisplayGuard || (lidDisplayGuard = createLidDisplayGuard());
}

function getUnlockPassword() {
  return unlockPassword || (unlockPassword = createUnlockPassword());
}

function getUnlockProbe() {
  return unlockProbe || (unlockProbe = createUnlockProbe());
}

// 开机对账，server 启动时调一次。「关盖运行」是持久设置（SleepDisabled 由 powerd 守着，
// 重启还在），而熄屏守卫只活在这个进程里 —— 所以启动时必须自己读一次真设置决定守不守。
// 合着盖开机、又没人去点开界面的时候，屏正是亮着的那个最费电的状态，只有这里能救。
async function startPowerRuntimes({ macosPower } = {}) {
  const guard = getLidDisplayGuard();
  try {
    const status = await macosPower.getLidSleepPrevention();
    guard.sync(Boolean(status.available && status.enabled));
  } catch {
    // 读不到当前设置就先不守：守卫只在确认「关盖运行」开着时才该去动屏幕。
  }
  return guard;
}

module.exports = {
  getLidDisplayGuard,
  getUnlockPassword,
  getUnlockProbe,
  startPowerRuntimes,
  resetPowerServices: () => { lidDisplayGuard = null; unlockPassword = null; unlockProbe = null; },
};
