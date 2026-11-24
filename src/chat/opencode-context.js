'use strict';

// 迁移桥接：Rust 负责只读数据库查询、用量归一化和模型窗口解析。
// 数据库与目录 I/O 在原生工作线程执行；宿主迁入 Rust 后可移除本桥接。
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { getNative } = require('../native/runtime');

const DEFAULT_THRESHOLD = 0.85;
function clampThreshold(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(0.95, Math.max(0.5, n)) : DEFAULT_THRESHOLD;
}
function resolveThreshold(env = process.env) {
  const value = env.MULTICC_OPENCODE_CONTEXT_THRESHOLD;
  return value != null && value !== '' ? clampThreshold(value) : DEFAULT_THRESHOLD;
}

function createOpencodeContextReader(deps = {}) {
  const env = deps.env || process.env;
  const home = env.HOME || os.homedir();
  const dbPath = deps.dbPath || path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode', 'opencode.db');
  const cachePath = deps.cachePath || path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'opencode', 'models.json');
  const threshold = deps.threshold != null ? clampThreshold(deps.threshold) : resolveThreshold(env);
  const nativeModule = deps.getNative || (() => getNative());
  async function invoke(fields) {
    try {
      const native = nativeModule();
      return JSON.parse(await native.readOpencodeContext(JSON.stringify({ dbPath, cachePath, threshold, ...fields })));
    } catch (error) {
      deps.logger?.warn?.('opencode_context_read_failed', { reason: error?.code || 'read-failed' });
      return { found: false, reason: 'read-failed' };
    }
  }
  return Object.freeze({
    read: (sessionId, modelId) => invoke({ sessionId, modelId }), threshold,
    cursor: sessionId => invoke({ op: 'cursor', sessionId }),
    turnUsage: (sessionId, cursor) => invoke({ op: 'turn_usage', sessionId, cursor }),
  });
}

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
  const { buildHandoffCheckpoint, clearAllNativeCliStates } = require('../cli-switch');
  persisted.pendingCliHandoff = getNative().prepareOpencodeRotationHandoff(persisted,
    () => buildHandoffCheckpoint({ session: persisted, fromCli: 'opencode', toCli: 'opencode', history: history() }),
    () => `checkpoint_${crypto.randomBytes(8).toString('hex')}`);
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

module.exports = {
  DEFAULT_THRESHOLD, clampThreshold, resolveThreshold, createOpencodeContextReader,
  createOpencodeContextGuard, enforceOpencodeContextForTurn,
};
