'use strict';

const fs = require('fs');
const path = require('path');
const { createPaths } = require('../../paths');
const { atomicWriteText, ensurePrivateDir } = require('../../runtime-security');
const { getNative } = require('../../native/runtime');

// 同步文件端口暂时保留，以兼容宿主的写入确认及可注入文件系统。
// 格式、路径规则、追加账本及失败处理由 Rust 唯一拥有；宿主异步化后再迁 IO。
function createChatHistoryFileRepository({
  dataDir,
  fsImpl = fs,
  writeText = atomicWriteText,
  appendEnabled = process.env.MULTICC_HISTORY_APPEND !== '0',
} = {}) {
  const root = createPaths({ dataDir }).chatHistoryDir;
  const anchor = { ports: { root, fsImpl, path, writeText, appendEnabled,
    ensureDir: dir => fsImpl === fs ? ensurePrivateDir(dir)
      : fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 }),
  } };
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
