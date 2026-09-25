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
    return d.toLocaleString(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  }

  // 活动时间走全站唯一那份（shared/format.js，dashboard.html 里先于本文件加载）：
  // 档位和措辞都在那一张表里，这里只补一个本页的老规矩 —— 超过一个月的活动时间
  // 直接给绝对时刻，「37 天前」在这一页没有意义。原来这一份的「刚刚」档是 10 秒，
  // 别处是 5 秒，同一句话在两个页面上不一样。
  function formatRelative(ts) {
    if (!ts) return '-';
    var then = new Date(ts);
    if (isNaN(then.getTime())) return '-';
    if (Date.now() - then.getTime() >= 30 * 86400000) return formatAbsolute(ts);
    return window.MultiCCFormat.formatRelativeTime(then.getTime(), { placeholder: '-' });
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
    html += statCard('总会话数', data.total || 0, '');
    // Active
    html += statCard('活跃会话', data.active || 0, data.total ? (Math.round((data.active / data.total) * 100) + '% 活跃') : '');
    // By CLI
    html += statCard('CLI 分布', Object.keys(byCli).length || 0, cliDetails || '无数据');

    // Also render byKind as an extra card if available
    var byKind = data.byKind || {};
    var kindDetails = Object.keys(byKind).map(function (k) {
      return '<span>' + esc(k) + ': ' + byKind[k] + '</span>';
    }).join('');
    html += statCard('类型分布', Object.keys(byKind).length || 0, kindDetails || '无数据');

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
      empty.innerHTML = '<div class="icon">📭</div><div>没有符合条件的会话</div>';
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
      '<th>状态</th>' +
      '<th>ID</th>' +
      '<th>标签</th>' +
      '<th>CLI</th>' +
      '<th>类型</th>' +
      '<th>创建时间</th>' +
      '<th>最后活动</th>' +
      '</tr></thead>';
    table.innerHTML = thead;
    var tbodyEl = document.createElement('tbody');

    data.sessions.forEach(function (s) {
      var tr = document.createElement('tr');

      // Active dot
      var activeClass = s.active ? 'yes' : 'no';
      var activeTitle = s.active ? '活跃' : '非活跃';
      tr.appendChild(td('<span class="active-dot ' + activeClass + '" title="' + activeTitle + '"></span><span class="mobile-status-text">' + activeTitle + '</span>', '状态'));

      // ID
      tr.appendChild(td('<span class="mono">' + esc(s.id || '-') + '</span>', 'ID'));

      // Label
      tr.appendChild(td(esc(s.label || s.id || '-'), '标签'));

      // CLI
      var cliCls = s.cli === 'claude' || s.cli === 'claude-exp' ? 'claude' : (s.cli === 'codex' || s.cli === 'codex-exp') ? 'codex-exp' : 'other';
      tr.appendChild(td('<span class="cli-badge"><span class="cli-dot ' + cliCls + '"></span>' + esc(s.cli || '-') + '</span>', 'CLI'));

      // Kind
      var kindCls = s.kind || 'other';
      tr.appendChild(td('<span class="kind-badge ' + kindCls + '">' + esc(s.kind || '-') + '</span>', '类型'));

      // Created at
      tr.appendChild(td('<span class="mono">' + formatAbsolute(s.createdAt) + '</span>', '创建'));

      // Last activity
      tr.appendChild(td('<span class="mono">' + formatRelative(s.lastActivity) + '</span>', '活动'));

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
    wrap.innerHTML = '<div class="loading-state">加载中…</div>';
  }

  // ── HTML escape ──────────────────────────────────────────────
  // Five characters, shared with every other page (shared/dom-helpers.js is
  // loaded by dashboard.html before this file).
  function esc(s) { return escapeHtml(s); }

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
        showError('数据加载失败: ' + (err.message || err) + ' — 将在 ' + (REFRESH_INTERVAL / 1000) + 's 后重试');
        lastFetchOk = false;
      }
      // If we have no data yet, show loading state
      var wrap = el('table-wrap');
      if (!wrap.querySelector('.sessions-table')) {
        wrap.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><div>等待 API 可用…</div></div>';
      }
    });
  }

  function updateRefreshIndicator(ok) {
    var dot = el('refresh-dot');
    var label = el('refresh-label');
    if (ok) {
      dot.style.background = 'var(--green)';
      label.textContent = '已更新 ' + new Date().toLocaleTimeString();
    } else {
      dot.style.background = 'var(--red)';
      label.textContent = '连接失败';
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
        showError('语音模块未加载，请刷新页面后重试');
        return;
      }
      btn.disabled = true;
      client.launch({}).then(function (result) {
        if (!result.ok) showError('语音：' + (result.message || result.code));
        else hideError();
      }).catch(function (err) {
        showError('语音启动异常: ' + (err && err.message ? err.message : err));
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
