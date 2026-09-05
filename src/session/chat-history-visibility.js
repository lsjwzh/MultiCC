'use strict';

// Display state is separate from the canonical transcript. IDs, not timestamps
// or array offsets, survive imported/out-of-order messages and annotation edits.
function createChatHistoryVisibility({ history, service, limitFor }) {
  const cache = new Map();
  function hidden(sessionId) {
    const key = String(sessionId);
    if (!cache.has(key)) {
      const state = history.readVisibility?.(key);
      cache.set(key, new Set(state?.hiddenIds || []));
    }
    return cache.get(key);
  }
  function filter(sessionId, messages, { bounded = true } = {}) {
    const ids = hidden(sessionId);
    const visible = messages.filter(message => !ids.has(message.id));
    return bounded ? visible.slice(-limitFor(sessionId)) : visible;
  }
  function hide(sessionId, ids) {
    const key = String(sessionId);
    const next = new Set([...hidden(key), ...ids]);
    if (typeof history.writeVisibility !== 'function') {
      throw new TypeError('history.writeVisibility is required');
    }
    // Legacy transcripts may receive IDs on read. Persist those IDs before
    // recording a visibility decision so it also survives a server restart.
    service.ensurePersistedIds(key);
    history.writeVisibility(key, { version: 1, hiddenIds: [...next] });
    cache.set(key, next);
  }
  function clear(sessionId, keep = 0) {
    const visible = filter(sessionId, service.view(sessionId), { bounded: false });
    // An in-flight answer keeps streaming; clearing the view never stops work.
    const completed = visible.filter(message => !message._interim);
    const removed = completed.slice(0, Math.max(0, completed.length - keep));
    hide(sessionId, removed.map(message => message.id));
    return { keep, removedCount: removed.length, retainedCount: visible.length - removed.length };
  }
  function remove(sessionId, messageId) {
    if (!service.view(sessionId).some(message => message.id === messageId)) return false;
    hide(sessionId, [messageId]);
    return true;
  }
  return Object.freeze({ filter, clear, remove, invalidate: id => cache.delete(String(id)) });
}

module.exports = { createChatHistoryVisibility };
