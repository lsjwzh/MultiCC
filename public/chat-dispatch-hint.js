/* ── chat-dispatch-hint.js ───────────────────────────────────────────────────
 * Commander-only dispatch-mode radio group on #pre-input-bar. Evolves the old
 * two-state「不派发」checkbox into a three-way choice the user pins from the UI:
 *   dispatch_master (default) → dispatch via dispatch_master and WAIT for the
 *                                result callback (two-way / needs receipt).
 *   route_task                → dispatch via route_task, fire-and-forget
 *                                (one-way / no callback).
 *   none                      → no dispatch; finish in this session.
 *
 * Exposes: window.MultiCCChatDispatchHint = { createDispatchHint, decorate, … }
 * chat-composer.js calls decorate(text) right before staging + sending, so the
 * bubble on screen and the text the model receives are the same string.
 *
 * The group only appears when GET /api/sessions/:id reports type==='commander';
 * in every other session decorate() is the identity function.
 * ────────────────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  var STORE_PREFIX = 'multicc.dispatchMode.';
  var LEGACY_PREFIX = 'multicc.noDispatch.'; // old boolean switch — migrated once

  var MODE_DISPATCH_MASTER = 'dispatch_master';
  var MODE_ROUTE_TASK = 'route_task';
  var MODE_NONE = 'none';
  var MODES = [MODE_DISPATCH_MASTER, MODE_ROUTE_TASK, MODE_NONE];
  var DEFAULT_MODE = MODE_DISPATCH_MASTER;

  // English on purpose — the model obeys English tool-routing instructions more
  // reliably. Each suffix names the exact tool so the constraint is unambiguous.
  var SUFFIX_DISPATCH_MASTER = '\n\n[Dispatch] After a brief analysis, dispatch this to another session via the dispatch_master tool. The result will flow back to this session asynchronously.';
  var SUFFIX_ROUTE_TASK = '\n\n[Dispatch] After a brief analysis, dispatch this to another session via the route_task tool (fire-and-forget, no callback needed).';
  var SUFFIX_NONE = '\n\n[Dispatch] Do not dispatch to other sessions this turn. Handle it entirely within the current session.';

  function suffixFor(mode) {
    if (mode === MODE_NONE) return SUFFIX_NONE;
    if (mode === MODE_ROUTE_TASK) return SUFFIX_ROUTE_TASK;
    return SUFFIX_DISPATCH_MASTER;
  }

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

    var groupEl = null;
    var radios = [];
    // The narrow-screen face: a pill showing the current choice, plus the sheet
    // it opens. Both are optional — a page without them still works.
    var pillEl = null;
    var pillIconEl = null;
    var pillLabelEl = null;
    var sheetEl = null;
    var sheetOpts = [];
    // `enabled` is the commander gate; a non-commander session never decorates.
    var enabled = false;
    var mode = DEFAULT_MODE;

    function storeKey() { return STORE_PREFIX + sessionId; }

    function segmentFor(value) {
      for (var i = 0; i < radios.length; i += 1) {
        if (radios[i].value === value) return radios[i].parentNode || null;
      }
      return null;
    }

    // The pill mirrors whichever segment is selected, carrying over its i18n key
    // so a language switch re-translates it like any other labelled element.
    function renderPill() {
      if (!pillEl) return;
      if (typeof pillEl.setAttribute === 'function') pillEl.setAttribute('data-mode', mode);
      var seg = segmentFor(mode);
      if (!seg || typeof seg.querySelector !== 'function') return;
      var icon = seg.querySelector('.dm-icon');
      var text = seg.querySelector('.dm-text');
      if (icon && pillIconEl) pillIconEl.textContent = icon.textContent;
      if (text && pillLabelEl) {
        pillLabelEl.textContent = text.textContent;
        if (text.dataset && text.dataset.i18n && pillLabelEl.dataset) {
          pillLabelEl.dataset.i18n = text.dataset.i18n;
        }
      }
    }

    function render() {
      if (groupEl) groupEl.hidden = !enabled;
      radios.forEach(function (r) { r.checked = (r.value === mode); });
      sheetOpts.forEach(function (opt) {
        if (typeof opt.setAttribute === 'function') {
          opt.setAttribute('aria-checked', opt.getAttribute('data-mode') === mode ? 'true' : 'false');
        }
      });
      renderPill();
    }

    function setSheetOpen(open) {
      if (!sheetEl) return;
      sheetEl.hidden = !open;
      if (pillEl && typeof pillEl.setAttribute === 'function') {
        pillEl.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
    }

    function setMode(value, persist) {
      var next = MODES.indexOf(value) >= 0 ? value : DEFAULT_MODE;
      mode = next;
      if (persist !== false && sessionId) writeStore(storage, storeKey(), next);
      render();
    }

    function setEnabled(value) {
      enabled = !!value;
      // A sheet left open while the control is being hidden would float over a
      // session that no longer has the switch.
      if (!enabled) setSheetOpen(false);
      render();
    }

    function bind() {
      if (!doc || typeof doc.getElementById !== 'function') return;
      groupEl = doc.getElementById('dispatch-mode-group');
      if (groupEl && typeof groupEl.querySelectorAll === 'function') {
        radios = Array.prototype.slice.call(
          groupEl.querySelectorAll('input[name="dispatch-mode"]')
        );
      }
      radios.forEach(function (r) {
        if (typeof r.addEventListener === 'function') {
          r.addEventListener('change', function () { if (r.checked) setMode(r.value); });
        }
      });

      pillEl = doc.getElementById('dispatch-mode-pill');
      pillIconEl = doc.getElementById('dispatch-mode-pill-icon');
      pillLabelEl = doc.getElementById('dispatch-mode-pill-label');
      sheetEl = doc.getElementById('dispatch-mode-sheet');
      if (sheetEl && typeof sheetEl.querySelectorAll === 'function') {
        sheetOpts = Array.prototype.slice.call(sheetEl.querySelectorAll('.dm-sheet-opt'));
      }
      if (pillEl && typeof pillEl.addEventListener === 'function') {
        pillEl.addEventListener('click', function () { setSheetOpen(true); });
      }
      sheetOpts.forEach(function (opt) {
        if (typeof opt.addEventListener !== 'function') return;
        opt.addEventListener('click', function () {
          setMode(opt.getAttribute('data-mode'));
          setSheetOpen(false);
        });
      });
      // Tapping the scrim or pressing Escape dismisses without changing anything.
      if (sheetEl && typeof sheetEl.addEventListener === 'function') {
        sheetEl.addEventListener('click', function (event) {
          var target = event && event.target;
          if (target && typeof target.hasAttribute === 'function' && target.hasAttribute('data-dm-close')) {
            setSheetOpen(false);
          }
        });
      }
      if (typeof doc.addEventListener === 'function') {
        doc.addEventListener('keydown', function (event) {
          if (event && event.key === 'Escape' && sheetEl && !sheetEl.hidden) setSheetOpen(false);
        });
      }
      // Restore: prefer the new mode key; fall back to the legacy boolean once,
      // then the default. Restore never writes back, so an untouched session
      // keeps an empty slot rather than a synthesised default.
      var stored = sessionId ? readStore(storage, storeKey()) : null;
      if (MODES.indexOf(stored) >= 0) {
        setMode(stored, false);
      } else {
        var legacy = sessionId ? readStore(storage, LEGACY_PREFIX + sessionId) : null;
        if (legacy === '1') setMode(MODE_NONE, false);
        else if (legacy === '0') setMode(MODE_DISPATCH_MASTER, false);
      }
      render();
    }

    // Resolving the role can race ahead of the session being fully ready /
    // created: a transient loadSession failure at boot would otherwise hide the
    // group forever. A concrete answer (commander OR not) is final; only a
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
      return text + suffixFor(mode);
    }

    return Object.freeze({
      mount: mount,
      decorate: decorate,
      setEnabled: setEnabled,
      setMode: function (value) { setMode(value); },
      getMode: function () { return mode; },
      isEnabled: function () { return enabled; },
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
    SUFFIX_DISPATCH_MASTER: SUFFIX_DISPATCH_MASTER,
    SUFFIX_ROUTE_TASK: SUFFIX_ROUTE_TASK,
    SUFFIX_NONE: SUFFIX_NONE,
    MODE_DISPATCH_MASTER: MODE_DISPATCH_MASTER,
    MODE_ROUTE_TASK: MODE_ROUTE_TASK,
    MODE_NONE: MODE_NONE,
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
