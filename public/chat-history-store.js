'use strict';

// Pure history state for the classic chat page. This module deliberately owns
// no DOM nodes, network clients, auth material, timers, or rendering callbacks.
// The host receives immutable plans and performs the corresponding effects.
(function attachChatHistoryStore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCChatHistoryStore = api;
})(typeof window !== 'undefined' ? window : globalThis, function createApi() {
  const DEFAULT_PAGE_SIZE = 5;

  function numberOrZero(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function historyMessages(value) {
    return Array.isArray(value)
      ? value.filter(message => message && typeof message === 'object')
      : [];
  }

  function messageId(message) {
    return message && typeof message.id === 'string' && message.id
      ? message.id
      : null;
  }

  function usageSummary(messages, authoritativeUsage) {
    if (authoritativeUsage && typeof authoritativeUsage === 'object') {
      return Object.freeze({
        input: numberOrZero(authoritativeUsage.inputTokens),
        output: numberOrZero(authoritativeUsage.outputTokens),
      });
    }

    let input = 0;
    let output = 0;
    for (const message of messages) {
      if (message.role !== 'assistant' || !message.usage) continue;
      input += numberOrZero(message.usage.input_tokens);
      output += numberOrZero(message.usage.output_tokens);
    }
    return Object.freeze({ input, output });
  }

  // Context usage belongs to the latest assistant turn. A streaming tail with
  // no usage is explicitly zero; it must not inherit the preceding turn.
  function lastTurnTokens(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'assistant') continue;
      if (!message.usage) return 0;
      return numberOrZero(message.usage.input_tokens)
        + numberOrZero(message.usage.output_tokens)
        + numberOrZero(message.usage.cache_read_input_tokens)
        + numberOrZero(message.usage.cache_creation_input_tokens);
    }
    return 0;
  }

  function historyPlan(payload, options = {}) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const messages = historyMessages(source.messages);
    const oldest = messages.find(message => messageId(message));
    const tail = messages[messages.length - 1];
    const streamingTail = tail && tail.role === 'assistant' && tail.streaming
      ? Object.freeze({ id: messageId(tail), content: tail.content || '' })
      : null;
    const mode = options.mode === 'reconcile' ? 'reconcile' : 'initial';
    const visibleIds = new Set(Array.isArray(options.visibleIds)
      ? options.visibleIds.filter(id => typeof id === 'string' && id)
      : []);
    const operations = [];
    const operationIndexById = new Map();

    for (const message of messages) {
      const id = messageId(message);
      if (mode === 'reconcile' && !id) {
        // An id-less reconnect entry cannot be proven distinct from a bubble
        // already rendered before disconnect. The one exception is the
        // authoritative in-progress tail, which the host can reconcile against
        // its single id-less streaming bubble without cloning stored DOM.
        if (message === tail && message.role === 'assistant' && message.streaming) {
          operations.push(Object.freeze({ kind: 'stream-tail', id: null, message }));
        }
        continue;
      }
      const operation = Object.freeze({
        kind: id && visibleIds.has(id) ? 'update' : 'append',
        id,
        message,
      });
      if (id && operationIndexById.has(id)) {
        // If a malformed/retried page repeats an id, the last authoritative
        // representation wins while the host still performs one DOM effect.
        operations[operationIndexById.get(id)] = operation;
      } else {
        if (id) operationIndexById.set(id, operations.length);
        operations.push(operation);
      }
    }

    return Object.freeze({
      mode,
      messages: Object.freeze(messages.slice()),
      operations: Object.freeze(operations),
      sessionTokens: usageSummary(messages, source.tokenUsage),
      hasAuthoritativeUsage: !!source.tokenUsage,
      usedTokens: lastTurnTokens(messages),
      oldestMessageId: oldest ? messageId(oldest) : null,
      hasMore: !!source.hasMore,
      streamingTail,
    });
  }

  function initialPlan(payload) {
    return historyPlan(payload, { mode: 'initial' });
  }

  function createHistoryStore(options = {}) {
    const requestedPageSize = Number(options.pageSize);
    const pageSize = Number.isInteger(requestedPageSize) && requestedPageSize > 0
      ? requestedPageSize
      : DEFAULT_PAGE_SIZE;
    let initialAccepted = false;
    let exhausted = false;
    let hasMore = false;
    let oldestMessageId = null;
    let generation = 0;
    let requestSequence = 0;
    let activeRequest = null;

    function snapshot() {
      return Object.freeze({
        initialAccepted,
        loading: !!activeRequest,
        exhausted,
        hasMore,
        oldestMessageId,
        pageSize,
        generation,
        activeRequestId: activeRequest ? activeRequest.requestId : null,
      });
    }

    function acceptHistory(payload, visibleIds = []) {
      const mode = initialAccepted ? 'reconcile' : 'initial';
      initialAccepted = true;
      // A fresh authoritative page supersedes any older request that was in
      // flight before a reconnect.
      generation += 1;
      activeRequest = null;
      const plan = historyPlan(payload, { mode, visibleIds });
      oldestMessageId = plan.oldestMessageId;
      hasMore = plan.hasMore && !!oldestMessageId;
      exhausted = !hasMore;
      return Object.freeze({ ...plan, generation });
    }

    // Compatibility for callers that still explicitly mean “first page”. New
    // hosts should use acceptHistory so reconnects are reconciled, not ignored.
    function acceptInitial(payload) {
      if (initialAccepted) return null;
      return acceptHistory(payload, []);
    }

    function beginOlder() {
      if (activeRequest || exhausted || !hasMore || !oldestMessageId) return null;
      const request = Object.freeze({
        before: oldestMessageId,
        limit: pageSize,
        generation,
        requestId: `${generation}:${++requestSequence}`,
      });
      activeRequest = request;
      return request;
    }

    function matchesActive(request) {
      return !!request && !!activeRequest
        && request.generation === generation
        && request.requestId === activeRequest.requestId;
    }

    function completeOlder(request, payload) {
      if (!matchesActive(request)) {
        return Object.freeze({ stale: true, messages: Object.freeze([]), ...snapshot() });
      }
      activeRequest = null;
      const source = payload && typeof payload === 'object' ? payload : {};
      const messages = historyMessages(source.messages);
      const next = messages.find(message => messageId(message));
      const nextCursor = next ? messageId(next) : null;
      const progressed = !!nextCursor && nextCursor !== oldestMessageId;
      if (progressed) oldestMessageId = nextCursor;
      hasMore = !!source.hasMore && messages.length > 0 && progressed;
      exhausted = !hasMore;
      return Object.freeze({
        stale: false,
        messages: Object.freeze(messages.slice()),
        ...snapshot(),
      });
    }

    function rejectOlder(request) {
      if (!matchesActive(request)) return snapshot();
      activeRequest = null;
      return snapshot();
    }

    function deleteMessage(id, nextOldestMessageId = null) {
      if (!id || id !== oldestMessageId) return snapshot();
      // Deleting the pagination cursor invalidates its in-flight response. Move
      // to the next visible persisted message when possible; otherwise stop
      // until the next authoritative chat_history page establishes a cursor.
      generation += 1;
      activeRequest = null;
      oldestMessageId = typeof nextOldestMessageId === 'string' && nextOldestMessageId
        ? nextOldestMessageId
        : null;
      hasMore = hasMore && !!oldestMessageId;
      exhausted = !hasMore;
      return snapshot();
    }

    function reset() {
      generation += 1;
      initialAccepted = false;
      activeRequest = null;
      exhausted = false;
      hasMore = false;
      oldestMessageId = null;
      return snapshot();
    }

    return Object.freeze({
      acceptHistory,
      acceptInitial,
      beginOlder,
      completeOlder,
      deleteMessage,
      rejectOlder,
      reset,
      snapshot,
    });
  }

  return Object.freeze({
    DEFAULT_PAGE_SIZE,
    createHistoryStore,
    historyPlan,
    initialPlan,
  });
});
