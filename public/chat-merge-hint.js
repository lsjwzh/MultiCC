/* ── chat-merge-hint.js ─────────────────────────────────────────────────────
 * Collapse / expand controller for the #merge-hint bar.
 *
 * The amber "worktree mergeable" bar can cover action buttons near the
 * composer, so the user can collapse it into a small edge-hugging pill
 * (same interaction model as the diff dock FAB in chat-diff.js): the pill
 * itself can then be dragged anywhere, and on release it snaps to the nearer
 * vertical edge. Until it is dragged it keeps the stylesheet's resting place
 * (right edge, above the composer, safe-area aware); once dragged, the
 * placement is remembered for the browser-session (sessionStorage) as an
 * edge + a fraction of the usable height, so a rotation or a resize
 * re-derives it instead of stranding it off-screen.
 *
 * chat.js toggles .show on #merge-hint from applyMergeStatus(); we observe
 * that class change instead of requiring call-site changes there.
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var STORE_KEY = 'multicc.mergeHintCollapsed';
  var POS_KEY = 'multicc.mergeHintFab';
  var EDGE_MARGIN = 12;
  var DRAG_SLOP = 5; // px before a press counts as a drag, not a tap

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

  function clamp(value, lo, hi) {
    if (!Number.isFinite(value)) return lo;
    return value < lo ? lo : (value > hi ? hi : value);
  }
  function viewportW() { return window.innerWidth || 1024; }
  function viewportH() { return window.innerHeight || 768; }
  function fabSize(fab) {
    // 隐藏时量不到：退回样式表里的 34px（粗指针那档是 44，只有真显示时才知道）。
    return (fab && fab.offsetWidth) || 34;
  }

  // null = 用户没拖过，位置仍归样式表管（右侧贴边、让开输入区、含安全区）。
  var pos = null;
  // 拖动结束时浏览器还会补一个 click；那一下是「松手」，不是「点开」。
  var ignoreClick = false;

  function loadPos() {
    try {
      var raw = window.sessionStorage && window.sessionStorage.getItem(POS_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object') return;
      pos = {
        side: saved.side === 'left' ? 'left' : 'right',
        topRatio: clamp(Number(saved.topRatio), 0, 1),
      };
    } catch (_) {
      // Private-mode or a corrupt entry: the default spot is perfectly usable.
    }
  }
  function savePos() {
    try {
      if (window.sessionStorage) window.sessionStorage.setItem(POS_KEY, JSON.stringify(pos));
    } catch (_) {}
  }

  function placeFab(fab) {
    if (!fab || !fab.style || !pos) return;
    var size = fabSize(fab);
    var maxTop = Math.max(EDGE_MARGIN, viewportH() - size - EDGE_MARGIN);
    var top = clamp(Math.round(pos.topRatio * (viewportH() - size)), EDGE_MARGIN, maxTop);
    var left = pos.side === 'left'
      ? EDGE_MARGIN
      : Math.max(EDGE_MARGIN, viewportW() - size - EDGE_MARGIN);
    fab.style.left = left + 'px';
    fab.style.top = top + 'px';
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
  }

  // ── Drag: any position while pressed, nearest vertical edge on release ──
  function bindFab(fab) {
    var pressing = false, moved = false, startX = 0, startY = 0, offX = 0, offY = 0;

    fab.addEventListener('pointerdown', function (e) {
      pressing = true;
      moved = false;
      ignoreClick = false;
      startX = e.clientX || 0;
      startY = e.clientY || 0;
      // 实时几何，不读 pos：没拖过的药丸的位置只有样式表知道。
      var rect = fab.getBoundingClientRect();
      offX = startX - rect.left;
      offY = startY - rect.top;
      if (fab.setPointerCapture && e.pointerId != null) {
        try { fab.setPointerCapture(e.pointerId); } catch (_) {}
      }
    });

    fab.addEventListener('pointermove', function (e) {
      if (!pressing) return;
      var x = e.clientX || 0, y = e.clientY || 0;
      if (!moved && Math.abs(x - startX) + Math.abs(y - startY) < DRAG_SLOP) return;
      moved = true;
      if (fab.classList) fab.classList.add('dragging');
      var size = fabSize(fab);
      fab.style.left = clamp(x - offX, EDGE_MARGIN, Math.max(EDGE_MARGIN, viewportW() - size - EDGE_MARGIN)) + 'px';
      fab.style.top = clamp(y - offY, EDGE_MARGIN, Math.max(EDGE_MARGIN, viewportH() - size - EDGE_MARGIN)) + 'px';
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
    });

    function endPress(e) {
      if (!pressing) return;
      pressing = false;
      if (fab.releasePointerCapture && e && e.pointerId != null) {
        try { fab.releasePointerCapture(e.pointerId); } catch (_) {}
      }
      if (fab.classList) fab.classList.remove('dragging');
      if (!moved) return; // 点按：交给 click 展开
      ignoreClick = true;
      var size = fabSize(fab);
      var left = parseFloat(fab.style.left) || 0;
      var top = parseFloat(fab.style.top) || 0;
      pos = {
        side: (left + size / 2) < viewportW() / 2 ? 'left' : 'right',
        topRatio: clamp(top / Math.max(1, viewportH() - size), 0, 1),
      };
      placeFab(fab);
      savePos();
    }
    fab.addEventListener('pointerup', endPress);
    fab.addEventListener('pointercancel', endPress);
  }

  function apply(bar, fab) {
    var ready = bar.classList.contains('show');
    var collapsed = isCollapsed();
    bar.classList.toggle('collapsed', collapsed);
    var wasHidden = fab.hidden;
    fab.hidden = !(ready && collapsed);
    // 尺寸要显示之后才量得到，所以复位放在这里而不是加载时。
    if (!fab.hidden && wasHidden) placeFab(fab);
    if (!fab.hidden) fab.title = tt('mergeHintExpand', '展开合并提示');
  }

  function init() {
    var bar = document.getElementById('merge-hint');
    var fab = document.getElementById('merge-hint-fab');
    if (!bar || !fab) return;

    loadPos();
    bindFab(fab);
    window.addEventListener('resize', function () { placeFab(fab); });

    var collapseBtn = document.getElementById('merge-hint-collapse-btn');
    if (collapseBtn) {
      collapseBtn.title = tt('mergeHintCollapse', '收起');
      collapseBtn.addEventListener('click', function () {
        setCollapsed(true);
        apply(bar, fab);
      });
    }
    fab.addEventListener('click', function () {
      if (ignoreClick) { ignoreClick = false; return; }
      setCollapsed(false);
      apply(bar, fab);
    });

    new MutationObserver(function () { apply(bar, fab); })
      .observe(bar, { attributes: true, attributeFilter: ['class'] });
    placeFab(fab);
    apply(bar, fab);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
