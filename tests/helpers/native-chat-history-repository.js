'use strict';

// Test-side stand-in for the retired src/session/adapters/chat-history-file-repository.js
// factory signature: tests keep passing a data dir, and this helper computes
// the chat_history root the way server.js does before calling the native
// facade factory. Production code calls getNative().chatHistoryFileRepositoryCreate
// directly.
const { createPaths } = require('../../src/paths');
const { getNative } = require('../../src/native/binding');
const { reportFailure } = require('../../src/state/store');

function createChatHistoryFileRepository({ dataDir, appendEnabled } = {}) {
  return getNative().chatHistoryFileRepositoryCreate({
    root: createPaths({ dataDir }).chatHistoryDir,
    appendEnabled,
    reportFailure,
  });
}

module.exports = { createChatHistoryFileRepository };
