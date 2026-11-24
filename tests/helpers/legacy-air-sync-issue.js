'use strict';
const { getNative } = require('../native/runtime');

// Only pass the fixed public DTO back to HTTP/WS. Node's error causes and
// SQLite wrappers may carry the useful code on a nested error.
function describeAirIssue(error) {
  try {
    const native = getNative();
    for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth++) {
      const issue = native.airSummaryIssue(String(cause.code || ''), String(cause.message || '').slice(0, 1024));
      if (issue) return issue;
    }
  } catch {
    return { code: 'rust_backend_unavailable', message: '无法加载当前版本的 Rust 诊断接口，请检查模块版本并重启 MultiCC。' };
  }
  return { code: 'air_refresh_failed', message: '首页摘要更新失败。请查看服务日志中的 air_sync_refresh_failed 记录。' };
}

// A failed write is an observed event, not a permanent claim about remaining
// disk space. Keep it briefly so a browser reconnecting after the write sees it.
function createAirStorageNotice() {
  let recent = null;
  return {
    record(error) {
      const issue = describeAirIssue(error);
      if (!['ENOSPC', 'SQLITE_FULL'].includes(issue.code)) return false;
      recent = { ...issue, message: '最近一次数据写入失败。' + issue.message, at: Date.now() };
      return true;
    },
    current() { return recent && Date.now() - recent.at < 300_000 ? recent : null; },
  };
}

module.exports = { describeAirIssue, createAirStorageNotice };
