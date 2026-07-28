/* ── chat-merge-hint.js ─────────────────────────────────────────────────────
 * Collapse / expand controller for the #merge-hint bar.
 *
 * The amber "worktree mergeable" bar can cover action buttons near the
 * composer, so the user can collapse it into a small edge-hugging pill
 * (same interaction model as the diff dock FAB in chat-diff.js).
 * Collapsed state is remembered for the browser-session (sessionStorage).
 *
 * chat.js toggles .show on #merge-hint from applyMergeStatus(); we observe
 * that class change instead of requiring call-site changes there.
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var STORE_KEY = 'multicc.mergeHintCollapsed';

  function isCollapsed() {
    try { return sessionStorage.getItem(STORE_KEY) === '1'; } catch (_) { return false; }
  }
  function setCollapsed(v) {
    try { sessionStorage.setItem(STORE_KEY, v ? '1' : '0'); } catch (_) {}
  }
  function tt(key, fallback) {
    try { if (typeof window.t === 'function') return window.t(key); } catch (_) {}
    return fallback;
  }

  function apply(bar, fab) {
    var ready = bar.classList.contains('show');
    var collapsed = isCollapsed();
    bar.classList.toggle('collapsed', collapsed);
    fab.hidden = !(ready && collapsed);
    if (!fab.hidden) fab.title = tt('mergeHintExpand', '展开合并提示');
  }

  function init() {
    var bar = document.getElementById('merge-hint');
    var fab = document.getElementById('merge-hint-fab');
    if (!bar || !fab) return;

    var collapseBtn = document.getElementById('merge-hint-collapse-btn');
    if (collapseBtn) {
      collapseBtn.title = tt('mergeHintCollapse', '收起');
      collapseBtn.addEventListener('click', function () {
        setCollapsed(true);
        apply(bar, fab);
      });
    }
    fab.addEventListener('click', function () {
      setCollapsed(false);
      apply(bar, fab);
    });

    new MutationObserver(function () { apply(bar, fab); })
      .observe(bar, { attributes: true, attributeFilter: ['class'] });
    apply(bar, fab);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
