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
      } finally {
        // The worker may have changed the file even when result resolution
        // failed. A stale append ledger is unsafe either way.
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
