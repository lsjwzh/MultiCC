'use strict';

// 运行期防锁（Keep awake）：任务期间不让显示器休眠 / 触发锁屏。
// 机制 = 用户态 `caffeinate -d -i -u`（防显示器休眠 + 防空闲 + 声明用户活跃，
// 屏保不会起来，锁屏也就不会因“显示器休眠/屏保”触发），不需要 root。
// 关键设计：`-w <server pid>` 让 caffeinate 在宿主进程退出时自动退出并释放
// assertion —— 服务被 kill 之后绝不会留下一只孤儿 caffeinate 让屏幕永远亮着。
// 这是运行时开关（不进 .env）：服务重启后回到关闭态，由用户在全局设置里再开。
const { spawn } = require('node:child_process');

function createKeepAwake({ platform = process.platform, spawnFn = spawn, watcherPid = process.pid, log = () => {} } = {}) {
  let child = null;
  let lastError = null;

  function isAvailable() {
    return platform === 'darwin';
  }

  function running() {
    return child !== null && child.exitCode === null && child.signalCode === null;
  }

  function getStatus() {
    return { available: isAvailable(), enabled: running(), error: running() ? null : lastError };
  }

  function stop() {
    if (child && child.exitCode === null) {
      log('keep-awake: stopping caffeinate');
      child.kill('SIGTERM');
    }
    child = null;
  }

  function start() {
    if (running()) return;
    lastError = null;
    let proc;
    try {
      proc = spawnFn('/usr/bin/caffeinate', ['-d', '-i', '-u', '-w', String(watcherPid)], { stdio: 'ignore' });
    } catch (error) {
      lastError = error.message || String(error);
      log(`keep-awake: spawn failed: ${lastError}`);
      return;
    }
    proc.on('exit', (code, signal) => {
      if (child === proc) {
        lastError = `caffeinate exited (code=${code} signal=${signal})`;
        log(`keep-awake: ${lastError}`);
        child = null;
      }
    });
    proc.unref();
    child = proc;
  }

  async function setEnabled(enabled) {
    if (!isAvailable()) throw new Error('This setting is only available on macOS');
    if (enabled) start(); else stop();
    return getStatus();
  }

  return { isAvailable, getStatus, setEnabled, stop };
}

module.exports = { createKeepAwake };