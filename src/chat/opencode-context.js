'use strict';

// 迁移桥接：Rust 负责只读数据库查询、用量归一化和模型窗口解析。
// 数据库与目录 I/O 在原生工作线程执行；宿主迁入 Rust 后可移除本桥接。
const path = require('node:path');
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
  const nativeModule = deps.getNative || (() => getNative('opencode_context'));
  async function invoke(fields) {
    try {
      const native = nativeModule();
      if (typeof native?.readOpencodeContext !== 'function') return { found: false, reason: 'native-unavailable' };
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

module.exports = { DEFAULT_THRESHOLD, clampThreshold, resolveThreshold, createOpencodeContextReader };
