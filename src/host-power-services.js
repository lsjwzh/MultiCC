'use strict';

// Host 电源设置的三个共享单例（keep-awake 的 caffeinate 子进程、unlock-password
// 的钥匙串读写、unlock-probe 的 Agent 读取授权探测）。server.js 已经顶到 3000 行硬上限，
// 路由模块直接在这里拿单例，不再需要从 server.js 注入；测试可以通过 deps 覆盖
// （见 host-read/host-write 的 `deps.x || getX()` 回落）。
const { createKeepAwake } = require('./keep-awake');
const { createUnlockPassword } = require('./macos-unlock-password');
const { createUnlockProbe } = require('./macos-unlock-probe');

let keepAwake = null;
let unlockPassword = null;
let unlockProbe = null;

function getKeepAwake() {
  return keepAwake || (keepAwake = createKeepAwake());
}

function getUnlockPassword() {
  return unlockPassword || (unlockPassword = createUnlockPassword());
}

function getUnlockProbe() {
  return unlockProbe || (unlockProbe = createUnlockProbe());
}

module.exports = {
  getKeepAwake,
  getUnlockPassword,
  getUnlockProbe,
  resetPowerServices: () => { keepAwake = null; unlockPassword = null; unlockProbe = null; },
};