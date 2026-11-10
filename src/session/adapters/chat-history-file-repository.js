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
  return Object.freeze({ root, ...Object.fromEntries(methods.map(method =>
    [method, (...args) => owner.run(anchor, method, args)])),
    readStrict: (sessionId, { allowEmpty = false } = {}) => owner.run(anchor, 'readStrict', [sessionId, allowEmpty]),
  });
}

function safeSessionName(sessionId) {
  return getNative().chatHistorySafeSessionName(sessionId);
}

module.exports = { createChatHistoryFileRepository, safeSessionName };
