'use strict';
// 持久化失败 → 首页告警的接线门面。server.js 的行长棘轮连字节都不许涨，
// 所以 notice 单例、两处失败挂钩（stateStore / sessionPersistence）和发布器
// 绑定都住在这里，server.js 只剩一次 require 与两行挂载。
const { createAirStorageNotice } = require('./air-sync-issue');

const notice = createAirStorageNotice();
let publishStatus = null;

// 上报一次失败：够格（ENOSPC/SQLITE_FULL）才记，记了就推给已挂载的首页。
function report(error) {
  if (notice.record(error)) publishStatus?.();
}

module.exports = {
  report,
  storageNotice: notice.current,
  bindPublisher(publish) { publishStatus = publish; },
  // stateStore 的失败挂钩：上报告警 + 计数 + 日志，一次装好。
  installStateStoreReporter(stateStore, { metrics, logger }) {
    stateStore.setFailureReporter((error, meta) => {
      report(error);
      metrics.inc('multicc_persistence_failures_total');
      logger.error('persistence_failure', { ...meta, error: error && error.message });
    });
  },
  // sessionPersistence 的 onFailure 同款形状。
  sessionPersistenceOnFailure({ metrics, logger }) {
    return ({ error, mode, source, attempt, dirty }) => {
      report(error);
      metrics.inc('multicc_session_persistence_failures_total');
      logger.error('session_persistence_failure', {
        mode, source, attempt, dirty, error: error && error.message,
      });
    };
  },
};
