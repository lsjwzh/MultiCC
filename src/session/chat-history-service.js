'use strict';

const { assertChatHistoryPort } = require('./ports');

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableTools(value) {
  return JSON.stringify(value || null);
}

function cleanThinkingBlocks(message) {
  if (!message || !Array.isArray(message.content)) return message;
  message.content = message.content.filter((block) => !(
    block && block.type === 'thinking' && (!block.thinking || !/\S/.test(block.thinking))
  ));
  return message;
}

function createChatHistoryService({
  history,
  idFactory,
  clock = Date.now,
  maxMessages = 10000,
  retentionPolicy = null,
} = {}) {
  assertChatHistoryPort(history);
  if (typeof idFactory !== 'function') throw new TypeError('[session] idFactory must be a function');
  if (typeof clock !== 'function') throw new TypeError('[session] clock must be a function');
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1) {
    throw new TypeError('[session] maxMessages must be a positive integer');
  }
  if (retentionPolicy !== null && typeof retentionPolicy !== 'function') {
    throw new TypeError('[session] retentionPolicy must be a function');
  }
  const cache = new Map();

  function retentionLimit(sessionId) {
    if (!retentionPolicy) return maxMessages;
    const policy = retentionPolicy(String(sessionId));
    const limit = policy && typeof policy === 'object' ? policy.maxMessages : policy;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError('[session] retentionPolicy must return a positive integer or { maxMessages }');
    }
    return limit;
  }

  function trim(sessionId, messages) {
    const limit = retentionLimit(sessionId);
    return messages.length > limit
      ? messages.splice(0, messages.length - limit)
      : [];
  }

  function normalize(source) {
    if (!Array.isArray(source)) return [];
    return source.filter(item => item && typeof item === 'object').map((item) => {
      const message = cleanThinkingBlocks(jsonClone(item));
      if (message.role && !message.id) message.id = String(idFactory());
      return message;
    });
  }

  function read(sessionId) {
    const key = String(sessionId);
    if (!cache.has(key)) cache.set(key, normalize(history.read(key)));
    return jsonClone(cache.get(key));
  }

  function persist(sessionId, messages) {
    const key = String(sessionId);
    const snapshot = jsonClone(messages);
    history.write(key, snapshot);
    cache.set(key, snapshot);
  }

  function invalidate(sessionId) {
    cache.delete(String(sessionId));
  }

  function deleteSession(sessionId) {
    const key = String(sessionId);
    const deleted = history.deleteSession(key);
    cache.delete(key);
    return deleted;
  }

  // This deliberately bypasses the service cache. Durable orchestration uses
  // it as the proof that a delivery reached disk before acknowledging its
  // outbox lease; a cached message is not sufficient evidence.
  function hasPersistedDelivery(sessionId, deliveryId) {
    const id = String(deliveryId || '');
    if (!id) return false;
    return history.hasPersistedDelivery(String(sessionId), id);
  }

  function append(sessionId, value) {
    if (!value || typeof value !== 'object') throw new TypeError('[session] chat message must be an object');
    const messages = read(sessionId);
    const message = cleanThinkingBlocks(jsonClone(value));
    if (!message.id) message.id = String(idFactory());
    if (!message.ts) message.ts = Number(clock());

    if (message.role === 'assistant' && !message._interim) {
      while (messages.length && messages[messages.length - 1].role === 'assistant' && messages[messages.length - 1]._interim) {
        messages.pop();
      }
    }

    if (message.role === 'assistant' && messages.length) {
      const previous = messages[messages.length - 1];
      if (previous.role === 'assistant' && previous.content === message.content &&
          stableTools(previous.tools) === stableTools(message.tools)) {
        if (message.usage !== undefined) previous.usage = message.usage;
        if (message.cost !== undefined) previous.cost = message.cost;
        if (message.durationMs !== undefined) previous.durationMs = message.durationMs;
        if (message.ts !== undefined) previous.ts = message.ts;
        const dropped = trim(sessionId, messages);
        persist(sessionId, messages);
        return Object.freeze({
          deduplicated: true,
          dropped: jsonClone(dropped),
          message: jsonClone(previous),
          messages: jsonClone(messages),
        });
      }
    }

    messages.push(message);
    const dropped = trim(sessionId, messages);
    persist(sessionId, messages);
    return Object.freeze({
      deduplicated: false,
      dropped: jsonClone(dropped),
      message: jsonClone(message),
      messages: jsonClone(messages),
    });
  }

  function upsertInterim(sessionId, value) {
    if (!value || typeof value !== 'object') throw new TypeError('[session] interim message must be an object');
    const messages = read(sessionId);
    const message = cleanThinkingBlocks(jsonClone(value));
    if (message.role !== undefined && message.role !== 'assistant') {
      throw new TypeError('[session] interim message must have assistant role');
    }
    message.role = 'assistant';
    message._interim = true;

    // Collapse a trailing run left by an older implementation into one entry.
    // Preserve the first visible interim id so an already-rendered bubble keeps
    // the same address while its content is refreshed.
    let firstInterim = messages.length;
    while (firstInterim > 0) {
      const candidate = messages[firstInterim - 1];
      if (!candidate || candidate.role !== 'assistant' || !candidate._interim) break;
      firstInterim -= 1;
    }
    const replaced = firstInterim < messages.length;
    const previous = replaced ? messages[firstInterim] : null;
    message.id = String((previous && previous.id) || message.id || idFactory());
    if (!message.ts) message.ts = Number(clock());
    if (replaced) messages.splice(firstInterim, messages.length - firstInterim, message);
    else messages.push(message);

    const dropped = trim(sessionId, messages);
    persist(sessionId, messages);
    return Object.freeze({
      replaced,
      dropped: jsonClone(dropped),
      message: jsonClone(message),
      messages: jsonClone(messages),
    });
  }

  function replace(sessionId, values) {
    const messages = normalize(values);
    const dropped = trim(sessionId, messages);
    persist(sessionId, messages);
    return Object.freeze({ messages: jsonClone(messages), dropped: jsonClone(dropped) });
  }

  function remove(sessionId, messageId) {
    const messages = read(sessionId);
    const index = messages.findIndex(message => message.id === messageId);
    if (index < 0) return Object.freeze({ removed: false, messages: jsonClone(messages) });
    const [removed] = messages.splice(index, 1);
    persist(sessionId, messages);
    return Object.freeze({ removed: true, message: jsonClone(removed), messages: jsonClone(messages) });
  }

  function paginate(sessionId, { before, limit = 30 } = {}) {
    const messages = read(sessionId);
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(limit) || 30)));
    let end = messages.length;
    if (before) {
      const index = messages.findIndex(message => message.id === before);
      if (index < 0) {
        return Object.freeze({ messages: [], hasMore: false, before: null });
      }
      end = index;
    }
    const start = Math.max(0, end - pageSize);
    return Object.freeze({
      messages: jsonClone(messages.slice(start, end)),
      hasMore: start > 0,
      before: start > 0 ? messages[start].id : null,
    });
  }

  function latestAssistantAt(sessionId) {
    const messages = read(sessionId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const ts = Number(message && message.role === 'assistant' && message.ts);
      if (Number.isFinite(ts) && ts > 0) return new Date(ts);
    }
    return null;
  }

  return Object.freeze({
    append,
    deleteSession,
    hasPersistedDelivery,
    invalidate,
    latestAssistantAt,
    paginate,
    read,
    remove,
    replace,
    upsertInterim,
  });
}

module.exports = { cleanThinkingBlocks, createChatHistoryService };
