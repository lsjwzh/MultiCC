'use strict';

// Rust 决定准入；Node 仅通过既有宿主端口保存交接摘要与广播。
// 不修改 OpenCode 数据库。宿主迁入 Rust 后可删除这一层。
const crypto = require('node:crypto');
const { getNative } = require('../native/runtime');
const { createOpencodeContextReader } = require('./opencode-context');
const { buildHandoffCheckpoint, clearAllNativeCliStates } = require('../cli-switch');

function createOpencodeContextGuard(deps = {}) {
  const reader = deps.contextReader || createOpencodeContextReader(deps);
  const nativeModule = deps.getNative || (() => getNative());
  async function enforce(record = {}) {
    try {
      const native = nativeModule();
      const nativeId = record._streamSessionId || record.cliSessionId || null;
      const usage = nativeId ? await reader.read(nativeId, record.model || null) : null;
      return Object.freeze(JSON.parse(native.planOpencodeContext(JSON.stringify({
        record: { kind: record.kind, cliSessionId: record.cliSessionId, _streamSessionId: record._streamSessionId }, usage,
      }))));
    } catch (error) {
      deps.logger?.warn?.('opencode_context_guard_failed', { reason: error?.code || 'error' });
      return Object.freeze({ action: 'skipped', reason: 'error' });
    }
  }
  return Object.freeze({ enforce });
}

async function enforceOpencodeContextForTurn({ guard, persisted, sessionName, history,
  rememberActiveCliState, savePersistedSessionsBestEffort, logger, appendEvent, chatBroadcast, assertCurrent }) {
  const nativeId = persisted._streamSessionId || persisted.cliSessionId;
  const model = persisted.model;
  const verdict = await guard.enforce(persisted);
  assertCurrent?.();
  if (nativeId !== (persisted._streamSessionId || persisted.cliSessionId) || model !== persisted.model) {
    return { action: 'skipped', reason: 'native_changed' };
  }
  if (verdict.action !== 'rotate') return verdict;
  const pending = persisted.pendingCliHandoff?.status === 'pending' ? persisted.pendingCliHandoff : null;
  // 跨 CLI 交接可能正在复用超限的旧会话；保留原交接摘要，仅换原生目标。
  const checkpoint = { ...(pending?.checkpoint || buildHandoffCheckpoint({
    session: persisted, fromCli: 'opencode', toCli: 'opencode', history: history(),
  })), reason: 'auto_native_context_rotate' };
  persisted.pendingCliHandoff = {
    ...pending, id: pending?.id || `checkpoint_${crypto.randomBytes(8).toString('hex')}`,
    fromCli: pending?.fromCli || 'opencode', toCli: 'opencode',
    createdAt: pending?.createdAt || checkpoint.createdAt, status: 'pending',
    reason: 'auto_native_context_rotate', reusedTarget: false, checkpoint,
  };
  const clearedNativeSessions = clearAllNativeCliStates(persisted);
  rememberActiveCliState(persisted);
  savePersistedSessionsBestEffort('runtime.opencode-context-rotate');
  logger.warn('opencode_context_rotated', { sessionId: sessionName,
    rotatedCliSessionId: verdict.cliSessionId, reason: verdict.reason, tokensTotal: verdict.tokensTotal,
    contextLimit: verdict.contextLimit, ratio: verdict.ratio, threshold: verdict.threshold, clearedNativeSessions });
  appendEvent(persisted.dirId, 'opencode_context_rotated', verdict.message, sessionName);
  chatBroadcast(sessionName, { type: 'system', subtype: 'native_context_rotated', auto: true, message: verdict.message });
  return verdict;
}

module.exports = { createOpencodeContextGuard, enforceOpencodeContextForTurn };
