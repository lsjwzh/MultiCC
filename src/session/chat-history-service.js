'use strict';

const { assertChatHistoryPort } = require('./ports');
const { getNative } = require('../native/runtime');

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// Attach the post-write transcript to a mutation result without paying for it.
//
// Every mutation used to return `messages: jsonClone(messages)` — a deep clone
// of the entire transcript — and the two hot callers discard it: chat-history's
// append path ignores the result, and the streaming interim timer fires
// upsertInterim on a debounce for the whole length of a turn. On a multi-MB
// history that clone is a full serialize + parse per keystroke-sized update, on
// the event loop, thrown away.
//
// The array is snapshotted eagerly (a pointer copy — message objects are never
// mutated once they are in the transcript, only the array structure is) and
// deep-cloned lazily on first access, memoized so repeated reads keep returning
// the same array. Callers that do read `.messages` therefore see exactly what
// they saw before: an isolated deep copy of the state at return time.
function withLazyMessages(result, messages) {
  const snapshot = messages.slice();
  let cloned;
  Object.defineProperty(result, 'messages', {
    get() {
      if (cloned === undefined) cloned = jsonClone(snapshot);
      return cloned;
    },
    enumerable: true,
    configurable: false,
  });
  return Object.freeze(result);
}

function createChatHistoryService({
  history,
  idFactory,
  clock = Date.now,
  maxMessages = 10000,
  retentionPolicy = null,
  postPersist = null,
  onPostPersistError = () => {},
  canDeleteSession = null,
  isMessageProtected = (_sessionId, message) => !!message.taskId,
  referencingTasks = () => [],
} = {}) {
  assertChatHistoryPort(history);
  if (typeof idFactory !== 'function') throw new TypeError('[session] idFactory must be a function');
  if (typeof clock !== 'function') throw new TypeError('[session] clock must be a function');
  if (canDeleteSession !== null && typeof canDeleteSession !== 'function') throw new TypeError('[session] canDeleteSession must be a function');
  if (typeof isMessageProtected !== 'function') throw new TypeError('[session] isMessageProtected must be a function');
  if (typeof referencingTasks !== 'function') throw new TypeError('[session] referencingTasks must be a function');
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1) {
    throw new TypeError('[session] maxMessages must be a positive integer');
  }
  if (retentionPolicy !== null && typeof retentionPolicy !== 'function') {
    throw new TypeError('[session] retentionPolicy must be a function');
  }
  if (postPersist !== null && typeof postPersist !== 'function') {
    throw new TypeError('[session] postPersist must be a function');
  }
  if (typeof onPostPersistError !== 'function') {
    throw new TypeError('[session] onPostPersistError must be a function');
  }
  // ECMAScript getter/JSON 适配保留在宿主；缓存、事务和历史规则均归 Rust。
  const anchor = { ports: { history, idFactory, clock, maxMessages, retentionPolicy,
    postPersist, onPostPersistError, canDeleteSession, isMessageProtected,
    referencingTasks, withLazyMessages } };
  const owner = new (getNative().RustChatHistory)(anchor);
  const methods = ['append', 'assertCanDeleteSession', 'containsDelivery', 'deleteSession',
    'hasPersistedDelivery', 'ensurePersistedIds', 'invalidate', 'latestAssistantAt',
    'paginate', 'read', 'remove', 'replace', 'upsertInterim', 'view'];
  return Object.freeze(Object.fromEntries(methods.map(method =>
    [method, (...args) => owner.run(anchor, method, args)])));
}

function cleanThinkingBlocks(message) {
  return getNative().chatHistoryCleanThinkingBlocks(message);
}

module.exports = { cleanThinkingBlocks, createChatHistoryService };
