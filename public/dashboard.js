/**
 * MultiCC Dashboard — data fetching & rendering
 * Vanilla JS, no frameworks. Auto-refreshes every 5 seconds.
 * API contract: GET /api/dashboard/sessions, GET /api/dashboard/stats
 */
(function () {
  'use strict';

  var REFRESH_INTERVAL = 5000; // 5 seconds
  var refreshTimer = null;
  var lastFetchOk = true;

  // Current filter state
  var filters = {
    kind: '',     // '' | 'chat' | 'terminal' | 'gateway'
    active: ''    // '' | 'true' | 'false'
  };

  // ── DOM helpers ──────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }
  function text(t) { return document.createTextNode(t); }

  // ── Time formatting ──────────────────────────────────────────
  function formatAbsolute(ts) {
    if (!ts) return '-';
    var d;
    if (typeof ts === 'number') d = new Date(ts);
    else d = new Date(ts);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleString(getLocale(), {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function formatRelative(ts) {
    if (!ts) return '-';
    var then;
    if (typeof ts === 'number') then = new Date(ts);
    else then = new Date(ts);
    if (isNaN(then.getTime())) return '-';

    var diffMs = Date.now() - then.getTime();
    var diffSec = Math.floor(diffMs / 1000);
    var diffMin = Math.floor(diffSec / 60);
    var diffHr = Math.floor(diffMin / 60);
    var diffDay = Math.floor(diffHr / 24);

    if (diffSec < 10) return t('dashboardJustNow');
    if (diffSec < 60) return t('dashboardSecondsAgo', { n: diffSec });
    if (diffMin < 60) return t('dashboardMinutesAgo', { n: diffMin });
    if (diffHr < 24) return t('dashboardHoursAgo', { n: diffHr });
    if (diffDay < 30) return t('dashboardDaysAgo', { n: diffDay });
    return formatAbsolute(ts);
  }

  // ── API calls ────────────────────────────────────────────────
  function buildSessionsUrl() {
    var params = [];
    if (filters.kind) params.push('kind=' + encodeURIComponent(filters.kind));
    if (filters.active) params.push('active=' + encodeURIComponent(filters.active));
    var qs = params.length ? '?' + params.join('&') : '';
    return '/api/dashboard/sessions' + qs;
  }

  function fetchJson(url) {
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
  }

  // ── Rendering: Stats ────────────────────────────────────────
  function renderStats(data) {
    if (!data) { el('stats-grid').style.opacity = '.4'; return; }
    el('stats-grid').style.opacity = '1';

    var byCli = data.byCli || {};
    var cliDetails = Object.keys(byCli).map(function (k) {
      var cls = k === 'claude' || k === 'claude-exp' ? 'claude' : (k === 'codex' || k === 'codex-exp') ? 'codex-exp' : 'other';
      return '<span><span class="cli-dot ' + cls + '"></span>' + esc(k) + ': ' + byCli[k] + '</span>';
    }).join('');

    var html = '';
    // Total
    html += statCard(t('dashboardStatTotal'), data.total || 0, '');
    // Active
    html += statCard(t('activeSessions'), data.active || 0, data.total ? t('dashboardActivePct', { pct: Math.round((data.active / data.total) * 100) }) : '');
    // By CLI
    html += statCard(t('dashboardStatCli'), Object.keys(byCli).length || 0, cliDetails || t('dashboardNoData'));

    // Also render byKind as an extra card if available
    var byKind = data.byKind || {};
    var kindDetails = Object.keys(byKind).map(function (k) {
      return '<span>' + esc(k) + ': ' + byKind[k] + '</span>';
    }).join('');
    html += statCard(t('dashboardStatKind'), Object.keys(byKind).length || 0, kindDetails || t('dashboardNoData'));

    el('stats-grid').innerHTML = html;
  }

  function statCard(label, value, detail) {
    var html = '<div class="stat-card">';
    html += '<div class="stat-label">' + esc(label) + '</div>';
    html += '<div class="stat-value">' + esc(String(value)) + '</div>';
    if (detail) html += '<div class="stat-detail">' + detail + '</div>';
    html += '</div>';
    return html;
  }

  // ── Rendering: Sessions table ───────────────────────────────
  function renderSessions(data) {
    var wrap = el('table-wrap');

    if (!data || !data.sessions || data.sessions.length === 0) {
      wrap.style.display = 'block';
      var empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '<div class="icon">📭</div><div>' + esc(t('dashboardNoSessions')) + '</div>';
      wrap.innerHTML = '';
      wrap.appendChild(empty);
      el('session-count').textContent = '0';
      return;
    }

    // Restore table structure
    wrap.innerHTML = '';
    var table = document.createElement('table');
    table.className = 'sessions-table';
    var thead = '<thead><tr>' +
      '<th>' + esc(t('dashboardColStatus')) + '</th>' +
      '<th>ID</th>' +
      '<th>' + esc(t('dashboardColLabel')) + '</th>' +
      '<th>CLI</th>' +
      '<th>' + esc(t('dashboardColKind')) + '</th>' +
      '<th>' + esc(t('dashboardColCreated')) + '</th>' +
      '<th>' + esc(t('dashboardColLastActivity')) + '</th>' +
      '</tr></thead>';
    table.innerHTML = thead;
    var tbodyEl = document.createElement('tbody');

    data.sessions.forEach(function (s) {
      var tr = document.createElement('tr');

      // Active dot
      var activeClass = s.active ? 'yes' : 'no';
      var activeTitle = s.active ? t('dashboardActive') : t('dashboardInactive');
      tr.appendChild(td('<span class="active-dot ' + activeClass + '" title="' + activeTitle + '"></span><span class="mobile-status-text">' + activeTitle + '</span>', t('dashboardColStatus')));

      // ID
      tr.appendChild(td('<span class="mono">' + esc(s.id || '-') + '</span>', 'ID'));

      // Label
      tr.appendChild(td(esc(s.label || s.id || '-'), t('dashboardColLabel')));

      // CLI
      var cliCls = s.cli === 'claude' || s.cli === 'claude-exp' ? 'claude' : (s.cli === 'codex' || s.cli === 'codex-exp') ? 'codex-exp' : 'other';
      tr.appendChild(td('<span class="cli-badge"><span class="cli-dot ' + cliCls + '"></span>' + esc(s.cli || '-') + '</span>', 'CLI'));

      // Kind
      var kindCls = s.kind || 'other';
      tr.appendChild(td('<span class="kind-badge ' + kindCls + '">' + esc(s.kind || '-') + '</span>', t('dashboardColKind')));

      // Created at
      tr.appendChild(td('<span class="mono">' + formatAbsolute(s.createdAt) + '</span>', t('dashboardColCreated')));

      // Last activity
      tr.appendChild(td('<span class="mono">' + formatRelative(s.lastActivity) + '</span>', t('dashboardColLastActivity')));

      tbodyEl.appendChild(tr);
    });

    table.appendChild(tbodyEl);
    wrap.appendChild(table);
    el('session-count').textContent = String(data.sessions.length);
  }

  function td(html, label) {
    var tdEl = document.createElement('td');
    if (label) tdEl.setAttribute('data-label', label);
    tdEl.innerHTML = html;
    return tdEl;
  }

  // ── Error / loading states ──────────────────────────────────
  function showError(msg) {
    var box = el('error-box');
    box.textContent = '⚠️ ' + msg;
    box.style.display = 'block';
  }
  function hideError() {
    el('error-box').style.display = 'none';
  }

  function showLoading() {
    var wrap = el('table-wrap');
    wrap.innerHTML = '<div class="loading-state">' + esc(t('loading')) + '</div>';
  }

  // ── HTML escape ──────────────────────────────────────────────
  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Data loading ────────────────────────────────────────────
  function loadAll() {
    // Fetch stats and sessions in parallel
    var statsP = fetchJson('/api/dashboard/stats').then(function (d) { return d; });
    var sessP = fetchJson(buildSessionsUrl()).then(function (d) { return d; });

    return Promise.all([statsP, sessP]).then(function (results) {
      hideError();
      lastFetchOk = true;
      renderStats(results[0]);
      renderSessions(results[1]);
      updateRefreshIndicator(true);
    }).catch(function (err) {
      updateRefreshIndicator(false);
      if (lastFetchOk) {
        // Only show error on first failure
        showError(t('dashboardLoadFailed', { message: err.message || err, sec: REFRESH_INTERVAL / 1000 }));
        lastFetchOk = false;
      }
      // If we have no data yet, show loading state
      var wrap = el('table-wrap');
      if (!wrap.querySelector('.sessions-table')) {
        wrap.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><div>' + esc(t('dashboardWaitingApi')) + '</div></div>';
      }
    });
  }

  function updateRefreshIndicator(ok) {
    var dot = el('refresh-dot');
    var label = el('refresh-label');
    if (ok) {
      dot.style.background = 'var(--green)';
      label.textContent = t('dashboardUpdatedAt', { time: new Date().toLocaleTimeString(getLocale()) });
    } else {
      dot.style.background = 'var(--red)';
      label.textContent = t('dashboardDisconnected');
    }
  }

  // ── Filter wiring ──────────────────────────────────────────
  function initFilters() {
    var kindSelect = el('filter-kind');
    kindSelect.addEventListener('change', function () {
      filters.kind = kindSelect.value;
      loadAll();
    });

    var btns = document.querySelectorAll('.filter-active');
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        btns.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        filters.active = btn.dataset.value;
        loadAll();
      });
    });
  }

  // ── Auto refresh ────────────────────────────────────────────
  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(loadAll, REFRESH_INTERVAL);
  }
  function stopAutoRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  // ── Global realtime voice ───────────────────────────────────
  // No sourceSessionId: this is the machine-wide entry point, so the Host routes
  // through the voice router rather than binding to any one session.
  function initGlobalVoice() {
    var btn = el('voice-global-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var client = window.MultiCCVoiceLaunch;
      if (!client || typeof client.launch !== 'function') {
        showError(t('dashboardVoiceModuleMissing'));
        return;
      }
      btn.disabled = true;
      client.launch({}).then(function (result) {
        if (!result.ok) showError(t('dashboardVoiceFailed', { message: result.message || result.code }));
        else hideError();
      }).catch(function (err) {
        showError(t('dashboardVoiceLaunchError', { message: err && err.message ? err.message : err }));
      }).then(function () {
        btn.disabled = false;
      });
    });
  }

  // ── Init ────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    initFilters();
    initGlobalVoice();
    showLoading();
    loadAll().then(function () {
      startAutoRefresh();
    });
  });

  // Pause refresh when tab is hidden, resume when visible
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopAutoRefresh();
    } else {
      loadAll().then(startAutoRefresh);
    }
  });

})();
