'use strict';

// 任务仓储升级闸门：server.js 在构造任何运行时之前调用。老用户第一次启动新版时库要从
// v1 升到 v2（真实库 35–70 秒，主线程同步阻塞）；这段时间由工作线程先占住端口报告进度，
// 启动器看到「正在升级」会继续等，不会误报失败或把进程杀掉打断迁移。
// - 不需要迁移（新装、已是新版本）：只做一次只读探测，零开销返回。
// - 空间不足：不崩溃，进度页说明需要多少空间，每 30 秒重试，腾出空间后自动继续启动。
// - 其他失败：迁移已整体回滚；进度页报告原因并停在这里，不进入崩溃重启循环（每次重启
//   都会重做整库备份）。收到 SIGTERM/SIGINT 照常退出：此时还没有安装任何信号处理器。
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const RETRY_MS = 30_000;

function startPage({ file, port, host, behindGateway = false }) {
  const signal = new SharedArrayBuffer(4);
  const flag = new Int32Array(signal);
  let worker;
  try {
    worker = new Worker(path.join(__dirname, 'migration-page-worker.js'), {
      workerData: { signal, port, host: LOOPBACK.has(host) ? host : '127.0.0.1', behindGateway, progressFile: `${file}.migration.json` },
    });
  } catch { return null; }
  worker.on('error', () => {});
  // 主线程马上要进入同步迁移，必须先确认端口已经在听。
  Atomics.wait(flag, 0, 0, 3000);
  if (Atomics.load(flag, 0) !== 1) { worker.terminate(); return null; }
  return {
    fail(failure) { worker.postMessage({ type: 'failure', failure }); },
    stop() {
      worker.postMessage({ type: 'stop' });
      // 正式服务稍后要在同一端口上监听：等工作线程真正关掉端口再往下走。
      Atomics.wait(flag, 0, 1, 3000);
      worker.unref();
    },
  };
}

function needsSpace(error) { return /task_store_migration_needs_space/.test(String(error?.message || error)); }

function runTaskStoreMigrationGate({ file, port, host, addon, logger = console,
  openPage = startPage, sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }) {
  if (typeof addon?.taskStoreMigrationPending !== 'function' || !addon.taskStoreMigrationPending(file)) {
    // 上次在整理阶段被杀：库已经是新版本，进度文件却留下了。
    try { fs.rmSync(`${file}.migration.json`, { force: true }); } catch {}
    return { migrated: false };
  }
  logger.info('[multicc] 正在把任务数据升级到 v2（仅此一次，期间端口只提供升级进度）');
  const page = openPage({ file, port, host });
  for (let attempt = 0; ; attempt += 1) {
    if (attempt) page?.fail(null);
    try {
      const report = JSON.parse(addon.migrateTaskStore(file));
      logger.info('[multicc] 任务仓储已升级到 v2', report);
      page?.stop();
      return { migrated: true, report };
    } catch (error) {
      const retrying = needsSpace(error);
      logger.error(`[multicc] 任务数据升级未完成，数据没有改动：${error.message}`
        + (retrying ? `；腾出磁盘空间后 ${RETRY_MS / 1000} 秒内自动重试` : ''));
      page?.fail({ error: error.message, retrying });
      if (!retrying) for (;;) sleep(60 * 60 * 1000);
      sleep(RETRY_MS);
    }
  }
}

// server.js 的唯一挂载点：数据目录、端口与原生模块都按正式启动同样的方式解析。原生模块
// 不可用时什么都不做，由正式打开去报告；端口配置只在确实要迁移时才解析，解析失败就不开
// 进度页（迁移照做，配置错误留给正式启动去报）。
function runAtBoot(env = process.env) {
  let addon = null;
  try { addon = require('../native/runtime').getNative(); } catch {}
  const file = require('../paths').createPaths({ dataDir: env.MULTICC_DATA_DIR }).taskShellDbFile;
  return runTaskStoreMigrationGate({ file, addon, openPage: () => {
    try {
      const { port, host } = require('../network-policy').resolveNetworkPolicy(env);
      const gatewayChild = require('../gateway-child');
      if (gatewayChild.isGatewayChild(env)) {
        // Behind the front door the public port is owned by Rust; the page must
        // take the reserved loopback port and speak PROXY until the migration
        // finishes and the main server takes that same port over.
        const internalPort = gatewayChild.internalPort(env);
        if (!internalPort) return null;
        return startPage({ file, port: internalPort, host: '127.0.0.1', behindGateway: true });
      }
      return startPage({ file, port, host });
    } catch { return null; }
  } });
}

module.exports = { runTaskStoreMigrationGate, startPage, runAtBoot };
