/* Compact recent-dispatch dock for the Web chat.
 *
 * The REST projection is authoritative: durable dispatch records joined with
 * the target session FIFO. This module never parses chat text and never receives
 * task prompts/results. The five-row summary puts live work first, then recent
 * terminal records, providing context without turning into another task board.
 */
(function (global, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!global || !global.document) return;
  global.MultiCCChatDispatchActivity = api;
  function start() {
    var params;
    try { params = new global.URLSearchParams(global.location.search); } catch (_) { return; }
    var sessionId = params.get('session') || '';
    if (!sessionId) return;
    api.createDispatchActivity({ window: global, document: global.document, sessionId: sessionId });
  }
  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TERMINAL = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
  var MAX_VISIBLE = 5;
  var FAB_HIT_SIZE = 44;
  var FAB_MARGIN = 12;
  var FAB_TOP = 54;
  var FAB_BOTTOM = 70;
  var FAB_BOTTOM_NARROW = 104;
  var FAB_DRAG_SLOP = 6;
  var DOCK_STORE_KEY = 'multicc.dispatchActivityDock';

  function numberOrZero(value) {
    var number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function freshness(entry) {
    return numberOrZero(entry.completedAt || entry.updatedAt || entry.startedAt || entry.createdAt);
  }

  function activePriority(entry) {
    if (entry.queueState === 'started' || entry.queueState === 'running') return 0;
    if (entry.queueState === 'queued') return 1;
    return 2;
  }

  function normalizeDispatches(rows) {
    var seen = new Set();
    var parsed = [];
    (Array.isArray(rows) ? rows : []).forEach(function (raw) {
      if (!raw || typeof raw !== 'object') return;
      var operationId = String(raw.operationId || '');
      if (!operationId || seen.has(operationId)) return;
      seen.add(operationId);
      var status = String(raw.status || 'unknown');
      parsed.push({
        operationId: operationId,
        status: status,
        terminal: raw.terminal === true || TERMINAL.has(status),
        relation: String(raw.relation || 'owner'),
        ownerSessionId: raw.ownerSessionId == null ? '' : String(raw.ownerSessionId),
        targetSessionId: raw.targetSessionId == null ? '' : String(raw.targetSessionId),
        executionSessionId: raw.executionSessionId == null ? '' : String(raw.executionSessionId),
        mode: raw.mode == null ? '' : String(raw.mode),
        queueState: String(raw.queueState || 'unknown'),
        queuePosition: Number.isFinite(Number(raw.queuePosition)) ? Number(raw.queuePosition) : null,
        queueLength: Number.isFinite(Number(raw.queueLength)) ? Number(raw.queueLength) : null,
        createdAt: numberOrZero(raw.createdAt),
        startedAt: numberOrZero(raw.startedAt),
        completedAt: numberOrZero(raw.completedAt),
        updatedAt: numberOrZero(raw.updatedAt),
      });
    });
    parsed.sort(function (a, b) {
      if (a.terminal !== b.terminal) return a.terminal ? 1 : -1;
      if (!a.terminal && activePriority(a) !== activePriority(b)) {
        return activePriority(a) - activePriority(b);
      }
      return freshness(b) - freshness(a) || b.operationId.localeCompare(a.operationId);
    });
    return parsed;
  }

  function navigationCandidates(entry) {
    if (!entry || entry.relation === 'self') return [];
    var raw = entry.relation === 'target'
      ? [entry.ownerSessionId]
      : [entry.executionSessionId, entry.targetSessionId];
    return raw.filter(function (id, index) { return id && raw.indexOf(id) === index; });
  }

  function navigationSessionId(entry, knownSessions) {
    var candidates = navigationCandidates(entry);
    if (knownSessions && typeof knownSessions.has === 'function') {
      var known = candidates.find(function (id) { return knownSessions.has(id); });
      if (known) return known;
    }
    return candidates[0] || '';
  }

  function buildSessionUrl(currentHref, target) {
    var url = new URL('chat.html', currentHref);
    url.search = '';
    url.hash = '';
    url.searchParams.set('session', target);
    return url.toString();
  }

  function createDispatchActivity(options) {
    var opts = options || {};
    var win = opts.window;
    var doc = opts.document;
    var sessionId = String(opts.sessionId || '');
    var fetchFn = opts.fetch || (win && win.fetch ? win.fetch.bind(win) : null);
    if (!win || !doc || !sessionId || !fetchFn) return null;

    var fab = doc.getElementById('dispatch-activity-fab');
    var badge = doc.getElementById('dispatch-activity-count');
    var panel = doc.getElementById('dispatch-activity-panel');
    var title = doc.getElementById('dispatch-activity-title');
    var list = doc.getElementById('dispatch-activity-list');
    var refreshButton = doc.getElementById('dispatch-activity-refresh');
    var collapseButton = doc.getElementById('dispatch-activity-collapse');
    if (!fab || !badge || !panel || !title || !list) return null;

    var state = { entries: [], expanded: false, inFlight: false, destroyed: false };
    var dock = {
      sideRight: false,
      dy: 1,
      drag: null,
      suppressClick: false,
    };
    var storage = opts.storage || null;
    if (!storage) {
      try { storage = win.localStorage || null; } catch (_) { storage = null; }
    }
    var names = new Map();
    var generation = 0;
    var timer = null;
    var suppressTimer = null;
    var intervalMs = Number.isFinite(opts.intervalMs) ? Math.max(1000, opts.intervalMs) : 10000;
    var translate = typeof opts.translate === 'function'
      ? opts.translate
      : function (key, params) {
        return typeof win.t === 'function' ? win.t(key, params) : key;
      };

    function text(key, params, fallback) {
      var translated = translate(key, params);
      return translated && translated !== key ? translated : fallback;
    }

    function clamp(value, minimum, maximum) {
      return Math.min(maximum, Math.max(minimum, value));
    }

    function isNarrow() {
      try {
        return typeof win.matchMedia === 'function'
          && !!win.matchMedia('(max-width: 760px)').matches;
      } catch (_) { return false; }
    }

    function dockBand() {
      var width = Number(win.innerWidth) || 0;
      var height = Number(win.innerHeight) || 0;
      if (!width || !height) return null;
      var bottomInset = isNarrow() ? FAB_BOTTOM_NARROW : FAB_BOTTOM;
      var bottom = Math.max(FAB_TOP, height - bottomInset - FAB_HIT_SIZE);
      return { width: width, height: height, top: FAB_TOP, bottom: bottom, bottomInset: bottomInset };
    }

    function loadDock() {
      if (!storage || typeof storage.getItem !== 'function') return;
      try {
        var saved = JSON.parse(storage.getItem(DOCK_STORE_KEY) || 'null');
        if (!saved || typeof saved !== 'object') return;
        dock.sideRight = saved.side === 'right';
        if (Number.isFinite(Number(saved.dy))) dock.dy = clamp(Number(saved.dy), 0, 1);
      } catch (_) {}
    }

    function persistDock() {
      if (!storage || typeof storage.setItem !== 'function') return;
      try {
        storage.setItem(DOCK_STORE_KEY, JSON.stringify({
          side: dock.sideRight ? 'right' : 'left',
          dy: dock.dy,
        }));
      } catch (_) {}
    }

    function positionFab() {
      var band = dockBand();
      if (!band || !fab.style) return;
      var top = clamp(
        band.top + clamp(dock.dy, 0, 1) * (band.bottom - band.top),
        band.top,
        band.bottom,
      );
      fab.style.left = Math.round(dock.sideRight
        ? band.width - FAB_MARGIN - FAB_HIT_SIZE
        : FAB_MARGIN) + 'px';
      fab.style.top = Math.round(top) + 'px';
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
    }

    function positionPanel() {
      var band = dockBand();
      if (!band || !panel.style) return;
      var fabTop = Number.parseFloat(fab.style.top) || band.top;
      var panelHeight = Number(panel.offsetHeight) || 280;
      var maxTop = Math.max(band.top, band.height - band.bottomInset - panelHeight);
      panel.style.top = Math.round(clamp(fabTop, band.top, maxTop)) + 'px';
      panel.style.bottom = 'auto';
      panel.style.left = dock.sideRight ? 'auto' : FAB_MARGIN + 'px';
      panel.style.right = dock.sideRight ? FAB_MARGIN + 'px' : 'auto';
    }

    function settleDock() {
      var drag = dock.drag;
      dock.drag = null;
      var band = dockBand();
      if (fab.classList) fab.classList.remove('dispatch-activity-dragging');
      if (!drag || !band) { positionFab(); return; }
      dock.sideRight = drag.left + FAB_HIT_SIZE / 2 > band.width / 2;
      var top = clamp(drag.top, band.top, band.bottom);
      var span = band.bottom - band.top;
      dock.dy = span > 0 ? clamp((top - band.top) / span, 0, 1) : 1;
      persistDock();
      positionFab();
      if (state.expanded) positionPanel();
    }

    function displayName(id) { return names.get(id) || id || text('dispatchUnknownSession', null, 'Unknown session'); }

    function modeLabel(mode) {
      if (mode === 'sync') return text('dispatchModeSync', null, 'sync');
      if (mode === 'async') return text('dispatchModeAsync', null, 'async');
      if (mode === 'one_way') return text('dispatchModeOneWay', null, 'one-way');
      return '';
    }

    function stateLabel(entry) {
      if (entry.terminal) {
        if (entry.status === 'completed') return text('dispatchStateCompleted', null, 'completed');
        if (entry.status === 'failed') return text('dispatchStateFailed', null, 'failed');
        if (entry.status === 'interrupted') return text('dispatchStateInterrupted', null, 'interrupted');
        if (entry.status === 'cancelled') return text('dispatchStateCancelled', null, 'cancelled');
      }
      if (entry.queueState === 'queued') {
        if (entry.queuePosition == null) return text('dispatchStateQueuedNoPos', null, 'queued');
        if (entry.queueLength != null && entry.queueLength > 1) {
          return text('dispatchStateQueuedLen', {
            pos: entry.queuePosition, len: entry.queueLength,
          }, '#' + entry.queuePosition + ' of ' + entry.queueLength);
        }
        return text('dispatchStateQueued', { pos: entry.queuePosition }, 'queued #' + entry.queuePosition);
      }
      if (entry.queueState === 'started' || entry.queueState === 'running') {
        return text('dispatchStateRunning', null, 'running');
      }
      return text('dispatchStateUnknown', null, 'unknown');
    }

    function stateClass(entry) {
      if (entry.terminal) {
        if (entry.status === 'completed') return 'is-completed';
        if (entry.status === 'failed' || entry.status === 'interrupted') return 'is-failed';
        return 'is-terminal';
      }
      if (entry.queueState === 'queued') return 'is-queued';
      if (entry.queueState === 'started' || entry.queueState === 'running') return 'is-running';
      return 'is-unknown';
    }

    function jump(target) {
      if (!target) return;
      // Keep the current observer alive (especially for sync dispatch) and open
      // the worker beside it. noopener prevents the new chat from controlling us.
      win.open(buildSessionUrl(win.location.href, target), '_blank', 'noopener');
    }

    function rowFor(entry) {
      var target = navigationSessionId(entry, names);
      var incoming = entry.relation === 'target';
      var row = doc.createElement('button');
      row.type = 'button';
      row.className = 'dispatch-activity-row ' + stateClass(entry);
      row.dataset.operationId = entry.operationId;
      row.disabled = !target;

      var icon = doc.createElement('span');
      icon.className = 'dispatch-activity-direction';
      icon.textContent = incoming ? '↙' : '↗';

      var body = doc.createElement('span');
      body.className = 'dispatch-activity-row-body';
      var direction = incoming
        ? text('dispatchDirIn', { name: displayName(target) }, 'From ' + displayName(target))
        : text('dispatchDirOut', { name: displayName(target) }, 'To ' + displayName(target));
      var mode = modeLabel(entry.mode);
      body.textContent = mode ? direction + ' · ' + mode : direction;

      var status = doc.createElement('span');
      status.className = 'dispatch-activity-state';
      status.textContent = stateLabel(entry);

      var chevron = doc.createElement('span');
      chevron.className = 'dispatch-activity-chevron';
      chevron.textContent = target ? '›' : '';

      row.appendChild(icon);
      row.appendChild(body);
      row.appendChild(status);
      row.appendChild(chevron);
      if (target) row.addEventListener('click', function () { jump(target); });
      return row;
    }

    function render() {
      var entries = state.entries;
      var activeCount = entries.filter(function (entry) { return !entry.terminal; }).length;
      var empty = entries.length === 0;
      fab.hidden = empty || state.expanded;
      panel.hidden = empty || !state.expanded;
      badge.textContent = activeCount > 0 ? (activeCount > 99 ? '99+' : String(activeCount)) : '';
      fab.setAttribute('aria-label', text('dispatchQueueExpand', null, 'Open recent dispatches'));
      fab.setAttribute('aria-expanded', state.expanded ? 'true' : 'false');
      title.textContent = text('dispatchRecentTitle', { n: entries.length }, 'Recent dispatches ' + entries.length);
      list.replaceChildren();
      entries.slice(0, MAX_VISIBLE).forEach(function (entry) { list.appendChild(rowFor(entry)); });
      if (entries.length > MAX_VISIBLE) {
        var more = doc.createElement('div');
        more.className = 'dispatch-activity-more';
        more.textContent = text('dispatchQueueMore', { n: entries.length - MAX_VISIBLE }, '+' + (entries.length - MAX_VISIBLE) + ' more');
        list.appendChild(more);
      }
      positionFab();
      if (state.expanded && !empty) positionPanel();
    }

    async function loadNames() {
      try {
        var response = await fetchFn('/api/sessions');
        if (!response.ok) return;
        var payload = await response.json();
        var rows = Array.isArray(payload) ? payload : (Array.isArray(payload.sessions) ? payload.sessions : []);
        rows.forEach(function (session) {
          var id = String(session && session.id || '');
          if (!id) return;
          names.set(id, String(session.label || id));
        });
        render();
      } catch (_) {}
    }

    async function refresh() {
      if (state.destroyed || state.inFlight) return;
      state.inFlight = true;
      var requestGeneration = ++generation;
      try {
        var url = '/api/sessions/' + encodeURIComponent(sessionId)
          + '/dispatches?activeOnly=false&relation=both&recentTerminalLimit=5';
        var response = await fetchFn(url);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var payload = await response.json();
        if (state.destroyed || requestGeneration !== generation) return;
        state.entries = normalizeDispatches(payload && payload.dispatches);
        render();
      } catch (_) {
        // Keep the last authoritative snapshot. A transient transport error is
        // not evidence that a queued/running dispatch completed.
      } finally {
        state.inFlight = false;
      }
    }

    function expand() { state.expanded = true; render(); }
    function collapse() { state.expanded = false; render(); }
    function onVisibility() { if (!doc.hidden) refresh(); }
    function onKey(event) { if (event.key === 'Escape' && state.expanded) collapse(); }

    function onFabPointerDown(event) {
      if (event.button !== undefined && event.button !== 0) return;
      var band = dockBand();
      if (!band) return;
      dock.drag = {
        pointerId: event.pointerId,
        startX: Number(event.clientX) || 0,
        startY: Number(event.clientY) || 0,
        left: Number.parseFloat(fab.style.left) || FAB_MARGIN,
        top: Number.parseFloat(fab.style.top) || band.top,
        moved: false,
      };
      try {
        if (typeof fab.setPointerCapture === 'function' && event.pointerId !== undefined) {
          fab.setPointerCapture(event.pointerId);
        }
      } catch (_) {}
    }

    function onFabPointerMove(event) {
      var drag = dock.drag;
      if (!drag || event.pointerId !== undefined && event.pointerId !== drag.pointerId) return;
      var band = dockBand();
      if (!band) return;
      var x = Number(event.clientX) || 0;
      var y = Number(event.clientY) || 0;
      var dx = x - drag.startX;
      var dy = y - drag.startY;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < FAB_DRAG_SLOP) return;
        drag.moved = true;
        if (fab.classList) fab.classList.add('dispatch-activity-dragging');
      }
      drag.left = clamp(
        drag.left + dx,
        FAB_MARGIN,
        Math.max(FAB_MARGIN, band.width - FAB_MARGIN - FAB_HIT_SIZE),
      );
      drag.top = clamp(drag.top + dy, band.top, band.bottom);
      drag.startX = x;
      drag.startY = y;
      fab.style.left = Math.round(drag.left) + 'px';
      fab.style.top = Math.round(drag.top) + 'px';
    }

    function finishFabPointer(event) {
      var drag = dock.drag;
      if (!drag || event.pointerId !== undefined && event.pointerId !== drag.pointerId) return;
      try {
        if (typeof fab.releasePointerCapture === 'function' && event.pointerId !== undefined) {
          fab.releasePointerCapture(event.pointerId);
        }
      } catch (_) {}
      if (!drag.moved) {
        dock.drag = null;
        return;
      }
      settleDock();
      dock.suppressClick = true;
      var defer = typeof win.setTimeout === 'function' ? win.setTimeout.bind(win) : setTimeout;
      suppressTimer = defer(function () {
        dock.suppressClick = false;
        suppressTimer = null;
      }, 0);
    }

    function cancelFabPointer(event) {
      var drag = dock.drag;
      if (!drag || event.pointerId !== undefined && event.pointerId !== drag.pointerId) return;
      settleDock();
    }

    function onFabClick(event) {
      if (dock.suppressClick) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        return;
      }
      expand();
    }

    function onBlur() { if (dock.drag) settleDock(); }
    function onResize() {
      positionFab();
      if (state.expanded) positionPanel();
    }

    loadDock();
    positionFab();
    fab.addEventListener('pointerdown', onFabPointerDown);
    fab.addEventListener('pointermove', onFabPointerMove);
    fab.addEventListener('pointerup', finishFabPointer);
    fab.addEventListener('pointercancel', cancelFabPointer);
    fab.addEventListener('click', onFabClick);
    if (refreshButton) refreshButton.addEventListener('click', refresh);
    if (collapseButton) collapseButton.addEventListener('click', collapse);
    doc.addEventListener('visibilitychange', onVisibility);
    doc.addEventListener('keydown', onKey);
    win.addEventListener('focus', refresh);
    win.addEventListener('blur', onBlur);
    win.addEventListener('resize', onResize);
    timer = win.setInterval(function () { if (!doc.hidden) refresh(); }, intervalMs);
    loadNames();
    refresh();

    return {
      refresh: refresh,
      expand: expand,
      collapse: collapse,
      snapshot: function () { return state.entries.slice(); },
      destroy: function () {
        state.destroyed = true;
        generation += 1;
        if (timer != null) win.clearInterval(timer);
        if (suppressTimer != null && typeof win.clearTimeout === 'function') win.clearTimeout(suppressTimer);
        fab.removeEventListener('pointerdown', onFabPointerDown);
        fab.removeEventListener('pointermove', onFabPointerMove);
        fab.removeEventListener('pointerup', finishFabPointer);
        fab.removeEventListener('pointercancel', cancelFabPointer);
        fab.removeEventListener('click', onFabClick);
        if (refreshButton) refreshButton.removeEventListener('click', refresh);
        if (collapseButton) collapseButton.removeEventListener('click', collapse);
        doc.removeEventListener('visibilitychange', onVisibility);
        doc.removeEventListener('keydown', onKey);
        win.removeEventListener('focus', refresh);
        win.removeEventListener('blur', onBlur);
        win.removeEventListener('resize', onResize);
      },
    };
  }

  return {
    MAX_VISIBLE: MAX_VISIBLE,
    normalizeDispatches: normalizeDispatches,
    navigationCandidates: navigationCandidates,
    navigationSessionId: navigationSessionId,
    buildSessionUrl: buildSessionUrl,
    createDispatchActivity: createDispatchActivity,
  };
});
