'use strict';

const { createPaths } = require('../../paths');
const { getNative } = require('../../native/runtime');
const { reportFailure } = require('../../state/store');

// 历史文件协议、路径规则、追加账本与全部文件 IO 都由 Rust 唯一拥有。
// 这里只计算数据根、构造原生所有者并转发同步调用；没有可注入文件系统，
// 也没有 Node 回退路径。
function createChatHistoryFileRepository({
  dataDir,
  appendEnabled = process.env.MULTICC_HISTORY_APPEND !== '0',
} = {}) {
  const root = createPaths({ dataDir }).chatHistoryDir;
  const anchor = { ports: { root, appendEnabled, reportFailure } };
  const owner = new (getNative().RustChatHistoryRepository)(anchor);
  const methods = ['deleteSession', 'fileFor', 'hasPersistedDelivery', 'listSessionIds',
    'read', 'readVisibility', 'renameSession', 'write', 'writeVisibility', 'visibilityFileFor'];
  function asyncFailure(error) {
    if (error.errorType === 'SyntaxError' && typeof error.jsonSource === 'string') {
      JSON.parse(error.jsonSource);
    }
    const Constructor = error.errorType === 'TypeError' ? TypeError : Error;
    const failure = new Constructor(error.message);
    if (error.code) failure.code = error.code;
    if (error.errno != null) failure.errno = error.errno;
    if (error.syscall) failure.syscall = error.syscall;
    if (error.path) failure.path = error.path;
    if (error.dest) failure.dest = error.dest;
    return failure;
  }
  return Object.freeze({ root, ...Object.fromEntries(methods.map(method =>
    [method, (...args) => owner.run(anchor, method, args)])),
    readStrict: (sessionId, { allowEmpty = false } = {}) => owner.run(anchor, 'readStrict', [sessionId, allowEmpty]),
    writeAsync: async (sessionId, messagesJson) => {
      const id = String(sessionId);
      try {
        const result = await owner.writeAsync(id, String(messagesJson));
        if (result.error) {
          const failure = asyncFailure(result.error);
          if (result.error.operation) {
            reportFailure(failure, {
              operation: result.error.operation,
              target: result.error.target || result.error.path || root,
            });
          }
          throw failure;
        }
        // 字节回执（总字节+行尾偏移）交给 FIFO 驱动的 completeMutationStep，
        // 历史服务据它登记增量账本，下一笔只写尾巴。full=true 表示整份重写，
        // 回执的行尾覆盖全文，登记时直接替换窗口而不是并入。
        return { bytes: result.bytes ?? null, ends: result.ends ?? null, full: true };
      } finally {
        // The worker may have changed the file even when result resolution
        // failed. A stale append ledger is unsafe either way.
        try { owner.run(anchor, 'invalidateWrite', [id]); } catch (_) {}
      }
    },
    // 尾部增量写：payload 是历史服务恒等前缀比较产出的
    // { tail, keepBytes, expectedBytes }。appended=false 表示账本错位，或文件系统
    // 不支持安全克隆尾部替换；驱动据此整份重发一次自愈。
    appendAsync: async (sessionId, payload) => {
      const id = String(sessionId);
      try {
        const result = await owner.appendAsync(id, String(payload.tail), payload.keepBytes, payload.expectedBytes);
        if (result.error) {
          const failure = asyncFailure(result.error);
          if (result.error.operation) {
            reportFailure(failure, {
              operation: result.error.operation,
              target: result.error.target || result.error.path || root,
            });
          }
          throw failure;
        }
        return { appended: result.appended === true, bytes: result.bytes ?? null, ends: result.ends ?? null, full: false };
      } finally {
        try { owner.run(anchor, 'invalidateWrite', [id]); } catch (_) {}
      }
    },
    // Visibility writes take the same durable path as transcript writes: the
    // queue head decides the snapshot, the worker performs the atomic replace,
    // and only a resolved write lets the runtime publish the cache.
    writeVisibilityAsync: async (sessionId, stateJson) => {
      const id = String(sessionId);
      try {
        const result = await owner.writeVisibilityAsync(id, String(stateJson));
        if (result.error) {
          const failure = asyncFailure(result.error);
          if (result.error.operation) {
            reportFailure(failure, {
              operation: result.error.operation,
              target: result.error.target || result.error.path || root,
            });
          }
          throw failure;
        }
      } finally {
        try { owner.run(anchor, 'invalidateWrite', [id]); } catch (_) {}
      }
    },
    hasPersistedDeliveryAsync: async (sessionId, deliveryId) => {
      const identity = String(deliveryId || '');
      if (!identity) return false;
      const result = await owner.hasPersistedDeliveryAsync(String(sessionId), identity);
      if (result.error) throw asyncFailure(result.error);
      return result.found === true;
    },
  });
}

function safeSessionName(sessionId) {
  return getNative().chatHistorySafeSessionName(sessionId);
}

module.exports = { createChatHistoryFileRepository, safeSessionName };
