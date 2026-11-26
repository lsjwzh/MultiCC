'use strict';

const { getNative } = require('../../native/binding');

// The getter retains a V8 array snapshot and clones message objects only when
// a caller reads the transcript. The native service owns the mutation result.
function withLazyMessages(result, messages) {
  const snapshot = messages.slice();
  let cloned;
  Object.defineProperty(result, 'messages', {
    enumerable: true,
    get() {
      if (cloned === undefined) cloned = JSON.parse(JSON.stringify(snapshot));
      return cloned;
    },
  });
  return Object.freeze(result);
}

function createChatHistoryServiceWithOwner(options = {}) {
  const native = getNative();
  return native.historyServiceWithOwner(native, options, withLazyMessages);
}

module.exports = {
  cleanThinkingBlocks: message => getNative().chatHistoryCleanThinkingBlocks(message),
  createChatHistoryService: (options = {}) => createChatHistoryServiceWithOwner(options).service,
  createChatHistoryServiceWithOwner,
};
