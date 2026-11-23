'use strict';

// agy 多账号的 Node 侧入口：所有存储规则（`active.json`、16hex id 校验、
// 目录存在性、按绑定解析与 fail-closed）只有一份：native/core/src/agy_accounts.rs，
// 经原生模块暴露。这里不再解析 JSON、也不自己拼路径 —— 任何账号读写规则都在 Rust。

const { getNative } = require('./native/runtime');

function missingAccountError(reason) {
  const error = new Error('所选 Antigravity 账户已不存在，请在运行配置里重新选择账户');
  error.code = 'AGY_ACCOUNT_MISSING';
  if (reason) error.cause = reason;
  return error;
}

/// 校验某个 agy 账号是否存在且拥有独立 HOME 目录（由 Rust 原生模块判定）。
function hasAccount(id, home = process.env.HOME) {
  if (!home || typeof id !== 'string' || !id.trim()) return false;
  const native = getNative();
  if (typeof native.agyHasAccount !== 'function') return false;
  return !!native.agyHasAccount(String(home), id.trim());
}

/// 按绑定解析 agy 的 HOME：
/// - 显式传入 accountId 时：交由 Rust 严格校验，不存在或畸形直接抛 AGY_ACCOUNT_MISSING（fail-closed）；
/// - 未传或为空时：沿用全局活动账号（active.json），未钉账号或目录不存在返回 null，调用方保持真实 HOME 不动。
function accountEnv(home = process.env.HOME, accountId = null) {
  const explicit = accountId == null ? '' : String(accountId).trim();
  if (!home) {
    if (explicit) throw missingAccountError();
    return null;
  }
  const native = getNative();
  if (explicit) {
    if (typeof native.agyResolveAccountHome !== 'function') {
      throw missingAccountError('agyResolveAccountHome unavailable');
    }
    try {
      const pinned = native.agyResolveAccountHome(String(home), explicit);
      if (!pinned) throw missingAccountError();
      return { HOME: pinned };
    } catch (error) {
      if (error && error.code === 'AGY_ACCOUNT_MISSING') throw error;
      throw missingAccountError(error);
    }
  }
  const pinned = typeof native.agyResolveAccountHome === 'function'
    ? native.agyResolveAccountHome(String(home), null)
    : native.agyAccountHome(String(home));
  return pinned ? { HOME: pinned } : null;
}

module.exports = { accountEnv, hasAccount };
