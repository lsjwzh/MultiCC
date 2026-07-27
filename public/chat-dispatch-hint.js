/* ── chat-dispatch-hint.js ───────────────────────────────────────────────────
 * Commander-only「不派发给其他会话」switch that lives on #pre-input-bar and
 * appends one routing instruction to the end of every prompt sent from the box.
 *
 * The Commander decides per turn whether to hand work to other sessions. This
 * switch lets the user pin that decision from the UI instead of restating it in
 * prose each time:
 *   unchecked (default) → ask it to spread the work via route_task
 *   checked             → forbid dispatch; the work stays in this session
 *
 * Exposes: window.MultiCCChatDispatchHint = { createDispatchHint, decorate, … }
 * chat-composer.js calls decorate(text) right before staging + sending, so the
 * bubble on screen and the text the model receives are the same string.
 *
 * The switch only appears when GET /api/sessions/:id reports type==='commander';
 * in every other session decorate() is the identity function.
 * ────────────────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  var STORE_PREFIX = 'multicc.noDispatch.';

  // Both suffixes speak the Commander's own vocabulary: route_task is its only
  // dispatch channel, so an instruction phrased around it reads as a constraint
  // it already knows how to obey.
  var SUFFIX_SPREAD = '\n\n[派发要求] 请尽可能把本次任务拆分，并通过 route_task 派发给其它会话并行完成；只有确实无法派发的部分才留在当前会话自己做。';
  var SUFFIX_KEEP = '\n\n[派发要求] 不要派发给其它会话（不要调用 route_task），请在当前会话内直接完成本次任务。';

  function defaultStorage(win) {
    try { return win && win.localStorage ? win.localStorage : null; } catch (_) { return null; }
  }

  function readStore(storage, key) {
    try { return storage ? storage.getItem(key) : null; } catch (_) { return null; }
  }

  function writeStore(storage, key, value) {
    try { if (storage) storage.setItem(key, value); } catch (_) {}
  }

  function defaultLoadSession(win) {
    return function (sessionId) {
      var config = win && win.MultiCCChatAiConfig;
      if (!config || typeof config.loadSession !== 'function') {
        return Promise.reject(new Error('MultiCCChatAiConfig is unavailable'));
      }
      return config.loadSession(sessionId);
    };
  }

  function createDispatchHint(options) {
    var opts = options || {};
    var win = opts.window || global;
    var doc = opts.document || (win && win.document) || null;
    var storage = opts.storage === undefined ? defaultStorage(win) : opts.storage;
    var loadSession = opts.loadSession || defaultLoadSession(win);
    var sessionId = opts.sessionId || '';

    var labelEl = null;
    var inputEl = null;
    // `enabled` is the commander gate; a non-commander session never decorates.
    var enabled = false;
    var noDispatch = false;

    function storeKey() { return STORE_PREFIX + sessionId; }

    function render() {
      if (labelEl) labelEl.hidden = !enabled;
      if (inputEl) inputEl.checked = noDispatch;
    }

    function setNoDispatch(value, persist) {
      noDispatch = !!value;
      if (persist !== false && sessionId) writeStore(storage, storeKey(), noDispatch ? '1' : '0');
      render();
    }

    function setEnabled(value) {
      enabled = !!value;
      render();
    }

    function bind() {
      if (!doc || typeof doc.getElementById !== 'function') return;
      labelEl = doc.getElementById('no-dispatch-label');
      inputEl = doc.getElementById('no-dispatch-check');
      if (inputEl && typeof inputEl.addEventListener === 'function') {
        inputEl.addEventListener('change', function () { setNoDispatch(!!inputEl.checked); });
      }
      // Restore without writing back, so a session that never touched the switch
      // keeps an empty slot rather than a synthesised default.
      var stored = sessionId ? readStore(storage, storeKey()) : null;
      if (stored === '1' || stored === '0') setNoDispatch(stored === '1', false);
      render();
    }

    function mount() {
      bind();
      if (!sessionId) {
        setEnabled(false);
        return Promise.resolve(false);
      }
      return Promise.resolve()
        .then(function () { return loadSession(sessionId); })
        .then(function (info) { setEnabled(!!info && info.type === 'commander'); return enabled; })
        // Fail closed: an unknown session role must not silently rewrite prompts.
        .catch(function () { setEnabled(false); return false; });
    }

    function decorate(text) {
      if (!enabled || typeof text !== 'string' || !text.trim()) return text;
      return text + (noDispatch ? SUFFIX_KEEP : SUFFIX_SPREAD);
    }

    return Object.freeze({
      mount: mount,
      decorate: decorate,
      setEnabled: setEnabled,
      setNoDispatch: function (value) { setNoDispatch(value); },
      isEnabled: function () { return enabled; },
      isNoDispatch: function () { return noDispatch; },
    });
  }

  var active = null;

  function decorate(text) {
    return active ? active.decorate(text) : text;
  }

  function boot() {
    var sessionId = '';
    try {
      sessionId = new global.URLSearchParams(global.location.search).get('session') || '';
    } catch (_) { sessionId = ''; }
    active = createDispatchHint({ window: global, document: global.document, sessionId: sessionId });
    return active.mount();
  }

  global.MultiCCChatDispatchHint = Object.freeze({
    createDispatchHint: createDispatchHint,
    decorate: decorate,
    boot: boot,
    current: function () { return active; },
    SUFFIX_SPREAD: SUFFIX_SPREAD,
    SUFFIX_KEEP: SUFFIX_KEEP,
    STORE_PREFIX: STORE_PREFIX,
  });

  // Tests load this file into a bare context and drive createDispatchHint
  // directly; auto-booting there would fire a stray session fetch.
  if (global.document && global.__multiccDispatchHintNoAutoBoot !== true) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', function () { boot(); });
    } else {
      boot();
    }
  }
})(typeof window !== 'undefined' ? window : this);
