'use strict';

// Per-device "send key" preference. Two modes:
//   enter      Enter sends, Shift + Enter inserts a newline (the old behaviour).
//   mod-enter  Enter inserts a newline, Cmd/Ctrl + Enter sends.
// The chat page and the Air page's chat iframe share one localStorage key, so a
// change made in Settings is picked up by the next keydown with no event plumbing.
(function installSendKey(root) {
  const MODES = ['enter', 'mod-enter'];
  const STORE_KEY = 'multicc_send_key';
  const EVENT_NAME = 'multicc-send-key-change';

  function safeStorage() {
    // Accessing localStorage itself throws on file:// and in locked-down private modes.
    try { return root.localStorage || null; } catch (_) { return null; }
  }

  function create(env) {
    const options = env || {};
    const has = name => Object.prototype.hasOwnProperty.call(options, name);
    const nav = has('navigator') ? options.navigator : root.navigator;
    const win = options.window || root;
    // Resolve lazily: touching localStorage at load throws (and warns) in Node
    // tests and in some locked-down browsers.
    let storageResolved = false;
    let cachedStorage;
    function storage() {
      if (!storageResolved) {
        storageResolved = true;
        cachedStorage = has('storage') ? options.storage : safeStorage();
      }
      return cachedStorage;
    }

    function normalize(mode) {
      return MODES.indexOf(mode) === -1 ? 'enter' : mode;
    }

    function get() {
      const store = storage();
      if (!store || typeof store.getItem !== 'function') return 'enter';
      try { return normalize(store.getItem(STORE_KEY)); } catch (_) { return 'enter'; }
    }

    function set(mode) {
      const next = normalize(mode);
      const store = storage();
      if (store && typeof store.setItem === 'function') {
        try { store.setItem(STORE_KEY, next); } catch (_) { /* private mode: keep the in-memory mode */ }
      }
      // Same-document listeners (Air settings row) repaint from this; the chat
      // iframe is a different document and reads localStorage fresh instead.
      try {
        const Ctor = typeof root.CustomEvent === 'function' ? root.CustomEvent
          : (typeof root.Event === 'function' ? root.Event : null);
        if (Ctor && typeof win.dispatchEvent === 'function') {
          win.dispatchEvent(new Ctor(EVENT_NAME, { detail: { mode: next } }));
        }
      } catch (_) {}
      return next;
    }

    function isSend(event, opts) {
      if (!event || event.key !== 'Enter') return false;
      // Safari fires the IME-confirm Enter with isComposing=false but keyCode 229;
      // sending there would swallow the character being composed.
      if (event.isComposing || event.keyCode === 229) return false;
      if (event.ctrlKey || event.metaKey) return true;
      // Soft keyboards have no Shift/Cmd, so plain Enter must never send on mobile.
      if (opts && opts.mobile) return false;
      return get() === 'enter' ? !event.shiftKey : false;
    }

    function modLabel() {
      const platform = [
        nav && nav.userAgentData && nav.userAgentData.platform,
        nav && nav.platform,
        nav && nav.userAgent,
      ].filter(Boolean).join(' ');
      return /Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘' : 'Ctrl';
    }

    // The quick-task box keeps its i18n key in sync with the mode: a later
    // applyI18n() re-reads data-i18n-placeholder, so swapping both stays correct.
    function syncPlaceholder(el) {
      if (!el) return null;
      const key = get() === 'mod-enter'
        ? (modLabel() === '⌘' ? 'airQuickTaskPlaceholderModEnterMac' : 'airQuickTaskPlaceholderModEnterCtrl')
        : 'airQuickTaskPlaceholder';
      el.setAttribute('data-i18n-placeholder', key);
      const t = options.translate || root.t;
      if (typeof t === 'function') {
        try { el.placeholder = t(key); } catch (_) {}
      }
      return key;
    }

    return { MODES, STORE_KEY, EVENT_NAME, get, set, isSend, modLabel, syncPlaceholder };
  }

  const api = create({});
  api.create = create;
  root.MultiCCSendKey = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
