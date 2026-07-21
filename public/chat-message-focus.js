'use strict';

// Exact message deep-link controller for the classic chat page. It deliberately
// knows nothing about timestamps: a navigation target is satisfied only when a
// DOM node with the requested durable message id exists.
(function attachChatMessageFocus(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCChatMessageFocus = api;
})(typeof window !== 'undefined' ? window : globalThis, function createApi() {
  const DEFAULT_HIGHLIGHT_MS = 3200;
  const DEFAULT_CLASS_NAME = 'msg-jump-target';

  function normalizeMessageId(value) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, 160);
  }

  function readTargetMessageId(search) {
    try {
      const source = typeof search === 'string'
        ? search
        : (search && typeof search.search === 'string' ? search.search : '');
      return normalizeMessageId(new URLSearchParams(source.split('#', 1)[0]).get('message') || '');
    } catch (_) {
      return '';
    }
  }

  function createMessageFocusController(options = {}) {
    const targetId = normalizeMessageId(options.targetId || '');
    const findById = typeof options.findById === 'function'
      ? options.findById : function noElement() { return null; };
    const fetchAround = typeof options.fetchAround === 'function'
      ? options.fetchAround : async function noPage() { return { found: false, messages: [] }; };
    const mergeMessages = typeof options.mergeMessages === 'function'
      ? options.mergeMessages : function noMerge() {};
    const setTimeoutFn = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
    const clearTimeoutFn = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
    const className = normalizeMessageId(options.className || DEFAULT_CLASS_NAME)
      || DEFAULT_CLASS_NAME;
    const highlightMs = Number.isFinite(options.highlightMs) && options.highlightMs >= 0
      ? options.highlightMs : DEFAULT_HIGHLIGHT_MS;
    const reportError = typeof options.onError === 'function' ? options.onError : function noop() {};

    let state = targetId ? 'pending' : 'idle';
    let request = null;
    let highlighted = null;
    let highlightTimer = null;

    function clearHighlight() {
      if (highlightTimer !== null) clearTimeoutFn(highlightTimer);
      highlightTimer = null;
      if (highlighted && highlighted.classList) highlighted.classList.remove(className);
      highlighted = null;
    }

    function focusExactElement(element) {
      if (!element || !targetId) return false;
      clearHighlight();
      highlighted = element;
      if (element.classList) element.classList.add(className);
      if (typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      }
      state = 'focused';
      if (highlightMs > 0) {
        highlightTimer = setTimeoutFn(clearHighlight, highlightMs);
        if (highlightTimer && typeof highlightTimer.unref === 'function') highlightTimer.unref();
      }
      return true;
    }

    function focusCurrent() {
      return focusExactElement(targetId ? findById(targetId) : null);
    }

    async function loadAndFocus() {
      if (!targetId) return false;
      if (focusCurrent()) return true;
      state = 'loading';
      try {
        const page = await fetchAround(targetId);
        const source = page && typeof page === 'object' ? page : {};
        if (source.found !== true || !Array.isArray(source.messages)) {
          state = 'missing';
          return false;
        }
        mergeMessages(source.messages, source);
        if (focusCurrent()) return true;
        state = 'missing';
        return false;
      } catch (error) {
        state = 'missing';
        try { reportError(error); } catch (_) {}
        return false;
      }
    }

    function ensureFocused() {
      if (!targetId || state === 'missing') return Promise.resolve(false);
      if (state === 'focused') return Promise.resolve(true);
      if (!request) {
        request = loadAndFocus().finally(() => { request = null; });
      }
      return request;
    }

    function dispose() {
      clearHighlight();
      state = 'idle';
    }

    return Object.freeze({
      clearHighlight,
      dispose,
      ensureFocused,
      focusCurrent,
      getState: () => state,
      getTargetId: () => targetId,
      shouldHoldBottom: () => !!targetId && state !== 'missing' && state !== 'idle',
    });
  }

  return Object.freeze({
    DEFAULT_CLASS_NAME,
    DEFAULT_HIGHLIGHT_MS,
    createMessageFocusController,
    normalizeMessageId,
    readTargetMessageId,
  });
});
