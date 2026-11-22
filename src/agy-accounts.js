'use strict';

// agy 多账号的 Node 侧入口，只剩 spawn 时要用的一次读取。
//
// 存储规则（`active.json`、16hex id 校验、目录存在性）只有一份：
// native/core/src/agy_accounts.rs，经原生模块 agyAccountHome 暴露。这里不再
// 解析 JSON、也不自己拼路径 —— 任何新增账号逻辑都进 Rust，不进 JS。

const { getNative } = require('./native/runtime');

/// 活动账号的 HOME。没有钉账号（本机登录）或账号目录不存在时返回 null，
/// 调用方据此保持真实 `HOME` 不动。
function accountEnv(home = process.env.HOME) {
  if (!home) return null;
  const pinned = getNative().agyAccountHome(String(home));
  return pinned ? { HOME: pinned } : null;
}

module.exports = { accountEnv };
