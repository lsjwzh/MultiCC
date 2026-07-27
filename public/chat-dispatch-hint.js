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

  // Both suffixes are in English on purpose: the Commander model obeys English
  // tool-routing instructions more reliably, and route_task is its only dispatch
  // channel, so an instruction phrased around it reads as a constraint it
  // already knows how to obey.
  var SUFFIX_SPREAD = '\n\n[Dispatch] After a brief analysis, dispatch this task to other sessions in parallel via the route_task tool. Only keep in the current session what truly cannot be dispatched.';
  var SUFFIX_KEEP = '\n\n[Dispatch] Do not dispatch this task. Do not call the route_task tool. Complete the entire task yourself within the current session.';

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

    // Resolving the role can race ahead of the session being fully ready /
    // created: a transient loadSession failure at boot would otherwise hide the
    // switch forever. A concrete answer (commander OR not) is final; only a
    // thrown/rejected lookup is retried. A non-commander role stays fail-closed
    // and never rewrites prompts.
    var roleMaxRetries = opts.roleMaxRetries == null ? 4 : opts.roleMaxRetries;
    var roleRetryDelayMs = opts.roleRetryDelayMs == null ? 1500 : opts.roleRetryDelayMs;

    function resolveRole(attempt) {
      return Promise.resolve()
        .then(function () { return loadSession(sessionId); })
        .then(function (info) {
          setEnabled(!!info && info.type === 'commander');
          return enabled;
        })
        .catch(function () {
          if (attempt < roleMaxRetries) {
            return new Promise(function (resolve) {
              setTimeout(function () { resolve(resolveRole(attempt + 1)); }, roleRetryDelayMs);
            });
          }
          setEnabled(false); return false;
        });
    }

    function mount() {
      bind();
      if (!sessionId) {
        setEnabled(false);
        return Promise.resolve(false);
      }
      return resolveRole(0);
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
