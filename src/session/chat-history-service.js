'use strict';

const { assertChatHistoryPort } = require('./ports');

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

function stableTools(value) {
  return JSON.stringify(value || null);
}

function sameAssistantPayload(left, right) {
  return !!left && !!right
    && left.role === 'assistant' && right.role === 'assistant'
    && left.content === right.content
    && stableTools(left.tools) === stableTools(right.tools);
}

function isInjectedNudge(msg) {
  return !!msg && msg.role === 'user'
    && typeof msg.content === 'string'
    && msg.content.trimStart().startsWith('🔇');
}

function assistantContains(prev, latest) {
  if (!prev || !latest) return false;
  if (prev.role !== 'assistant' || latest.role !== 'assistant') return false;
  if (prev._interim || latest._interim) return false;
  if (stableTools(prev.tools) !== stableTools(latest.tools)) return false;

  const prevContent = prev.content;
  const latestContent = latest.content;

  // Exact match
  if (prevContent === latestContent) return true;

  // Prefix containment: latest starts with prev and prev is long enough
  if (typeof prevContent === 'string' && typeof latestContent === 'string') {
    return prevContent.length >= 16 && latestContent.startsWith(prevContent);
  }

  // Structured content: JSON.stringify fallback
  if (typeof prevContent === 'object' && typeof latestContent === 'object') {
    const prevStr = JSON.stringify(prevContent);
    const latestStr = JSON.stringify(latestContent);
    if (prevStr === latestStr) return true;
    return prevStr.length >= 16 && latestStr.startsWith(prevStr);
  }

  return false;
}

function findPrevAssistant(messages, startIndex) {
  for (let i = startIndex; i >= 0; i--) {
    const candidate = messages[i];
    if (isInjectedNudge(candidate)) continue;
    if (candidate.role === 'assistant' && candidate._interim) continue;
    if (candidate.role === 'user' && !isInjectedNudge(candidate)) return null; // real user = stop
    if (candidate.role === 'assistant' && !candidate._interim) return candidate;
  }
  return null;
}

function cleanThinkingBlocks(message) {
  if (!message || !Array.isArray(message.content)) return message;
  message.content = message.content.filter((block) => !(
    block && block.type === 'thinking' && (!block.thinking || !/\S/.test(block.thinking))
  ));
  return message;
}

function freezeEvent(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeEvent(child);
  return Object.freeze(value);
}

function createChatHistoryService({
  history,
  idFactory,
  clock = Date.now,
  maxMessages = 10000,
  retentionPolicy = null,
  postPersist = null,
  onPostPersistError = () => {},
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
  if (postPersist !== null && typeof postPersist !== 'function') {
    throw new TypeError('[session] postPersist must be a function');
  }
  if (typeof onPostPersistError !== 'function') {
    throw new TypeError('[session] onPostPersistError must be a function');
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
    const normalized = [];
    for (const item of source.filter(item => item && typeof item === 'object')) {
      const message = cleanThinkingBlocks(jsonClone(item));
      if (message.role && !message.id) message.id = String(idFactory());
      if (message.role === 'assistant' && !message._interim) {
        while (normalized.at(-1)?.role === 'assistant' && normalized.at(-1)?._interim) {
          normalized.pop();
        }
        const prevInNormalized = findPrevAssistant(normalized, normalized.length - 1);
        if (prevInNormalized && assistantContains(prevInNormalized, message)) {
          normalized.splice(normalized.indexOf(prevInNormalized), 1);
        }
      } else if (message.role === 'assistant' && message._interim) {
        const previous = normalized.at(-1);
        if (previous?.role === 'assistant' && previous._interim) {
          message.id = previous.id || message.id;
          normalized[normalized.length - 1] = message;
          continue;
        }
        // System continuations do not always persist a visible user message,
        // so adjacency alone cannot prove that an interim belongs to the
        // previous turn. Drop only a byte-equivalent late timer snapshot.
        if (previous?.role === 'assistant' && !previous._interim
            && sameAssistantPayload(previous, message)) {
          continue;
        }
      }
      normalized.push(message);
    }
    return normalized;
  }

  function current(sessionId) {
    const key = String(sessionId);
    if (!cache.has(key)) cache.set(key, normalize(history.read(key)));
    return cache.get(key);
  }

  function read(sessionId) {
    return jsonClone(current(sessionId));
  }

  // Read-only view of the committed transcript, without the deep clone read()
  // pays for. For a caller that only inspects messages, or that isolates just
  // the slice it hands out, cloning the whole transcript is pure cost: the WS
  // replay on connect used read() twice per connection — once to page out five
  // messages, once to total token usage — and reconnects run at a few per
  // second, so those clones alone could saturate a core.
  //
  // The returned array and its messages are shared with the cache and with
  // every other viewer. Callers must not mutate either; anything that hands
  // messages outside this module must clone what it hands out (see paginate).
  function view(sessionId) {
    return current(sessionId);
  }

  // The mutators below need an array they may push/pop/splice without disturbing
  // the cache — they do not need private copies of the messages themselves, and
  // never mutate one that is already in the transcript (each builds its own new
  // message object first). read()'s deep clone is the public contract for
  // callers outside this module and stays as it is; internally, isolating the
  // array alone turns a full serialize + parse of the whole history into a
  // pointer copy.
  function workingCopy(sessionId) {
    return current(sessionId).slice();
  }

  function emitPostPersist(event, afterCommit) {
    const committed = freezeEvent(jsonClone(event));
    for (const callback of [postPersist, afterCommit]) {
      if (typeof callback !== 'function') continue;
      try { callback(committed); }
      catch (error) {
        try { onPostPersistError(error, committed); } catch (_) {}
      }
    }
  }

  function persist(sessionId, messages, event, afterCommit) {
    const key = String(sessionId);
    // `messages` is always an array this module built for the caller (a working
    // copy or a freshly normalized one), and its messages are immutable once
    // stored, so the cache only needs its own array — not a deep clone of every
    // message, which on a large transcript was a second full serialize on top of
    // the one history.write() already performs.
    const snapshot = messages.slice();
    history.write(key, snapshot);
    cache.set(key, snapshot);
    emitPostPersist({ sessionId: key, ...event }, afterCommit);
  }

  function invalidate(sessionId) {
    cache.delete(String(sessionId));
  }

  function deleteSession(sessionId, { afterCommit } = {}) {
    const key = String(sessionId);
    const deleted = history.deleteSession(key);
    cache.delete(key);
    emitPostPersist({ type: 'delete', sessionId: key, deleted }, afterCommit);
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

  function containsDelivery(sessionId, deliveryId) {
    const id = String(deliveryId || '');
    if (!id) return false;
    return current(sessionId).some(message => message && (
      message.deliveryId === id || message.clientMsgId === id
    ));
  }

  function append(sessionId, value, { afterCommit } = {}) {
    if (!value || typeof value !== 'object') throw new TypeError('[session] chat message must be an object');
    const messages = workingCopy(sessionId);
    const message = cleanThinkingBlocks(jsonClone(value));
    if (!message.id) message.id = String(idFactory());
    if (!message.ts) message.ts = Number(clock());

    if (message.role === 'assistant' && !message._interim) {
      while (messages.length && messages[messages.length - 1].role === 'assistant' && messages[messages.length - 1]._interim) {
        messages.pop();
      }
    }

    if (message.role === 'assistant' && !message._interim && messages.length) {
      const prev = findPrevAssistant(messages, messages.length - 1);
      if (prev && assistantContains(prev, message)) {
        const prevIndex = messages.indexOf(prev);
        messages.splice(prevIndex, 1);
        messages.push(message);
        const trimmedDropped = trim(sessionId, messages);
        const allDropped = Object.freeze([jsonClone(prev), ...jsonClone(trimmedDropped)]);
        const result = withLazyMessages({
          deduplicated: true,
          dropped: allDropped,
          message: jsonClone(message),
        }, messages);
        persist(sessionId, messages, {
          type: 'append',
          deduplicated: true,
          dropped: result.dropped,
          message: result.message,
        }, afterCommit);
        return result;
      }
    }

    messages.push(message);
    const dropped = trim(sessionId, messages);
    const result = withLazyMessages({
      deduplicated: false,
      dropped: jsonClone(dropped),
      message: jsonClone(message),
    }, messages);
    persist(sessionId, messages, {
      type: 'append',
      deduplicated: false,
      dropped: result.dropped,
      message: result.message,
    }, afterCommit);
    return result;
  }

  function upsertInterim(sessionId, value, { afterCommit } = {}) {
    if (!value || typeof value !== 'object') throw new TypeError('[session] interim message must be an object');
    const messages = workingCopy(sessionId);
    const message = cleanThinkingBlocks(jsonClone(value));
    if (message.role !== undefined && message.role !== 'assistant') {
      throw new TypeError('[session] interim message must have assistant role');
    }
    message.role = 'assistant';
    message._interim = true;

    // System continuations can start without a visible user history record.
    // Ignore only the exact cumulative snapshot already made durable; a
    // different interim may belong to a legitimate injected continuation.
    const latest = messages.at(-1);
    if (latest?.role === 'assistant' && !latest._interim
        && sameAssistantPayload(latest, message)) {
      return withLazyMessages({
        ignored: true,
        replaced: false,
        dropped: Object.freeze([]),
        message: jsonClone(latest),
      }, messages);
    }

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
    const result = withLazyMessages({
      replaced,
      dropped: jsonClone(dropped),
      message: jsonClone(message),
    }, messages);
    persist(sessionId, messages, {
      type: 'interim',
      replaced,
      dropped: result.dropped,
      message: result.message,
    }, afterCommit);
    return result;
  }

  function replace(sessionId, values, { afterCommit, reason = null } = {}) {
    const messages = normalize(values);
    const dropped = trim(sessionId, messages);
    const result = withLazyMessages({ dropped: jsonClone(dropped) }, messages);
    persist(sessionId, messages, {
      type: 'replace',
      reason: reason == null ? null : String(reason).slice(0, 80),
      dropped: result.dropped,
    }, afterCommit);
    return result;
  }

  function remove(sessionId, messageId, { afterCommit } = {}) {
    const messages = workingCopy(sessionId);
    const index = messages.findIndex(message => message.id === messageId);
    if (index < 0) return withLazyMessages({ removed: false }, messages);
    const [removed] = messages.splice(index, 1);
    const result = withLazyMessages({ removed: true, message: jsonClone(removed) }, messages);
    persist(sessionId, messages, {
      type: 'remove',
      message: result.message,
    }, afterCommit);
    return result;
  }

  function paginate(sessionId, { before, limit = 5 } = {}) {
    const messages = current(sessionId);
    const pageSize = Math.max(1, Math.min(100, parseInt(limit, 10) || 5));
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
    const messages = current(sessionId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const ts = Number(message && message.role === 'assistant' && message.ts);
      if (Number.isFinite(ts) && ts > 0) return new Date(ts);
    }
    return null;
  }

  return Object.freeze({
    append,
    containsDelivery,
    deleteSession,
    hasPersistedDelivery,
    invalidate,
    latestAssistantAt,
    paginate,
    read,
    remove,
    replace,
    upsertInterim,
    view,
  });
}

module.exports = { cleanThinkingBlocks, createChatHistoryService };
