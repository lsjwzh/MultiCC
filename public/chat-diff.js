/* ── chat-diff.js ───────────────────────────────────────────────────────────
 * Codex-style file-level diff viewer for the web chat.
 *
 * Exposes:  window.chatDiffViewer = { open(sessionId), close() }
 *
 * Depends on globals supplied by sibling scripts (all loaded before chat.js):
 *   - window.withToken(url)            (chat.js; function decl → window property)
 *   - chatLiveUi.renderDiff(container, text)  (chat.js top-level const)
 *   - fetch / document / window / crypto.randomUUID
 *
 * Endpoints (see server-side contract):
 *   GET  /api/sessions/:id/diff/files         → file list + totals
 *   GET  /api/sessions/:id/diff/file?path=…   → single-file patch
 *   POST /api/aux/enqueue  { id, type:'diff_summary', prompt, meta } → { ok, result, taskId }
 *   POST /api/aux/cancel   { id }                                   → { ok:true }
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var MAX_PATCH_CHARS = 24000;       // truncate patch before sending to aux
  var MAX_RENDERED_FILES_FIRST = 20; // first paint of file list
  var STATUS_COLOR = {
    M: '#58a6ff', A: '#3fb950', D: '#f85149', R: '#bc8cff',
    T: '#d29922', C: '#d29922',
  };
  var STATUS_LABEL = { M: 'M', A: 'A', D: 'D', R: 'R', T: 'T', C: 'C' };

  // ── Global accessors (deferred to call-time so script load order is fine) ──
  function withToken(url) {
    try {
      if (typeof window !== 'undefined' && typeof window.withToken === 'function') {
        return window.withToken(url);
      }
    } catch (_) {}
    return url;
  }
  function getLiveUi() {
    try {
      // chatLiveUi is a top-level const in chat.js; visible via shared global
      // lexical environment once chat.js has executed.
      if (typeof chatLiveUi !== 'undefined' && chatLiveUi && typeof chatLiveUi.renderDiff === 'function') {
        return chatLiveUi;
      }
    } catch (_) {}
    if (typeof window !== 'undefined' && window.chatLiveUi && typeof window.chatLiveUi.renderDiff === 'function') {
      return window.chatLiveUi;
    }
    return null;
  }
  function uuid() {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
    return 'cd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function clampId(id) {
    var s = String(id || '');
    if (!s || s.length > 80) return uuid();
    return s;
  }

  // ── Path helpers ──
  function splitPath(p) {
    var idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    if (idx === -1) return { dir: '', base: p };
    return { dir: p.slice(0, idx + 1), base: p.slice(idx + 1) };
  }
  function middleEllipsis(p, max) {
    max = max || 48;
    if (p.length <= max) return p;
    var keep = max - 1;
    var headLen = Math.max(4, Math.ceil(keep * 0.35));
    var tailLen = keep - headLen;
    if (tailLen < 4) { tailLen = 4; headLen = keep - tailLen; }
    return p.slice(0, headLen) + '…' + p.slice(p.length - tailLen);
  }

  // ── Viewer state ──
  var state = {
    sessionId: null,
    listData: null,            // cached /diff/files response
    listFetchedAt: 0,
    currentPath: null,         // path when in detail view
    requestToken: 0,           // bumped on every view switch / open / close
    summaryCache: {},          // { [path]: string }
    patchCache: {},            // { [path]: string }
    activeSummary: null,       // { id, path, abortController }
    collapsed: false,          // summary bar collapse state
    renderedAll: false,        // file list: have we rendered all rows?
  };

  // ── DOM refs (populated on first open) ──
  var dom = {};
  function ensureDom() {
    if (dom.modal) return;
    dom.modal = document.getElementById('diff-modal');
    dom.title = document.getElementById('diff-title');
    dom.subTitle = document.getElementById('diff-subtitle');
    dom.closeBtn = document.getElementById('diff-close-btn');
    dom.listView = document.getElementById('diff-list-view');
    dom.summaryBar = document.getElementById('diff-summary-bar');
    dom.summaryText = document.getElementById('diff-summary-text');
    dom.summaryAdds = document.getElementById('diff-summary-adds');
    dom.summaryDels = document.getElementById('diff-summary-dels');
    dom.summaryChevron = document.getElementById('diff-summary-chevron');
    dom.fileList = document.getElementById('diff-file-list');
    dom.detailView = document.getElementById('diff-detail-view');
    dom.backBtn = document.getElementById('diff-back-btn');
    dom.detailBasename = document.getElementById('diff-detail-basename');
    dom.detailDir = document.getElementById('diff-detail-dir');
    dom.detailBadge = document.getElementById('diff-detail-badge');
    dom.detailStat = document.getElementById('diff-detail-stat');
    dom.aiPanel = document.getElementById('diff-ai-panel');
    dom.aiContent = document.getElementById('diff-ai-content');
    dom.patchContainer = document.getElementById('diff-patch');

    if (dom.closeBtn) dom.closeBtn.addEventListener('click', function (e) { e.preventDefault(); close(); });
    if (dom.backBtn) dom.backBtn.addEventListener('click', function (e) { e.preventDefault(); backToList(); });
    if (dom.summaryBar) dom.summaryBar.addEventListener('click', toggleCollapse);
    if (dom.modal) {
      dom.modal.addEventListener('click', function (e) {
        if (e.target === dom.modal) close();
      });
    }
    document.addEventListener('keydown', function (e) {
      if (!dom.modal || !dom.modal.classList.contains('open')) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
  }

  // ── Public API ──
  function open(sessionId) {
    ensureDom();
    if (!dom.modal) return;
    if (!sessionId) {
      // Mirror the legacy chat.js guard.
      try { if (typeof addSystemMsg === 'function') addSystemMsg('无 session id，无法查看 diff'); } catch (_) {}
      return;
    }
    // Cancel anything in flight, then reset view state.
    cancelActiveSummary();
    // Caches are per-session: clear when the session id changes to avoid
    // showing a previous session's summary/patch for the same path.
    if (state.sessionId !== sessionId) {
      state.summaryCache = {};
      state.patchCache = {};
    }
    state.sessionId = sessionId;
    state.requestToken++;
    state.currentPath = null;
    state.listData = null;
    state.listFetchedAt = 0;
    state.renderedAll = false;
    state.collapsed = false;

    dom.title.textContent = 'Diff · ' + sessionId;
    dom.subTitle.textContent = '加载中…';
    showListView();
    renderEmptyFileList('加载中…');
    dom.modal.classList.add('open');

    fetchFiles(sessionId);
  }

  function close() {
    ensureDom();
    if (!dom.modal) return;
    cancelActiveSummary();
    state.requestToken++;
    state.currentPath = null;
    dom.modal.classList.remove('open');
    // Reset to list view so a re-open starts clean.
    showListView();
  }

  // ── List view ──
  function showListView() {
    if (!dom.listView) return;
    dom.listView.style.display = 'flex';
    if (dom.detailView) dom.detailView.style.display = 'none';
    state.currentPath = null;
  }
  function showDetailView() {
    if (!dom.detailView) return;
    dom.listView.style.display = 'none';
    dom.detailView.style.display = 'flex';
  }

  function renderEmptyFileList(msg) {
    if (!dom.fileList) return;
    dom.fileList.textContent = '';
    var row = document.createElement('div');
    row.className = 'diff-file-empty';
    row.textContent = msg || '（无变更）';
    dom.fileList.appendChild(row);
    if (dom.summaryText) dom.summaryText.textContent = msg ? '' : '已更改 0 个文件';
    if (dom.summaryAdds) dom.summaryAdds.textContent = '+0';
    if (dom.summaryDels) dom.summaryDels.textContent = '−0';
  }

  function fetchFiles(sessionId) {
    var token = state.requestToken;
    var url = withToken('/api/sessions/' + encodeURIComponent(sessionId) + '/diff/files');
    fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) {
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (body) {
          throw new Error(body.error || ('HTTP ' + r.status));
        });
        return r.json();
      })
      .then(function (data) {
        if (token !== state.requestToken) return; // stale
        state.listData = data || {};
        state.listFetchedAt = Date.now();
        renderListView();
      })
      .catch(function (err) {
        if (token !== state.requestToken) return;
        renderEmptyFileList('加载失败：' + (err && err.message ? err.message : String(err)));
      });
  }

  function renderListView() {
    var data = state.listData || {};
    var ms = data.mergeState || {};
    // Subtitle (mirrors legacy chat.js concatenation).
    var parts = [];
    if (data.branch) parts.push(data.branch + ' -> ' + (data.baseBranch || ''));
    parts.push((ms.ahead || 0) + ' 个提交领先');
    if (ms.dirty) parts.push('含未提交改动');
    if (data.truncated) parts.push('已截断');
    dom.subTitle.textContent = parts.join(' · ');

    var files = Array.isArray(data.files) ? data.files : [];
    var totalAdd = data.totalAdditions || 0;
    var totalDel = data.totalDeletions || 0;
    dom.summaryText.textContent = '已更改 ' + files.length + ' 个文件';
    dom.summaryAdds.textContent = '+' + totalAdd;
    dom.summaryDels.textContent = '−' + totalDel;
    applyCollapse();

    dom.fileList.textContent = '';
    if (data.error) {
      var errRow = document.createElement('div');
      errRow.className = 'diff-file-empty diff-file-error';
      errRow.textContent = '错误：' + data.error;
      dom.fileList.appendChild(errRow);
      return;
    }
    if (files.length === 0) {
      renderEmptyFileList('（无变更）');
      return;
    }
    var firstN = files.slice(0, MAX_RENDERED_FILES_FIRST);
    firstN.forEach(function (f) { dom.fileList.appendChild(buildFileRow(f)); });
    if (files.length > MAX_RENDERED_FILES_FIRST) {
      var more = document.createElement('button');
      more.type = 'button';
      more.className = 'diff-file-more';
      var remaining = files.length - MAX_RENDERED_FILES_FIRST;
      more.textContent = '查看另外 ' + remaining + ' 个文件 ›';
      more.addEventListener('click', function () {
        // Render the rest; the "more" row removes itself.
        more.remove();
        files.slice(MAX_RENDERED_FILES_FIRST).forEach(function (f) {
          dom.fileList.appendChild(buildFileRow(f));
        });
        state.renderedAll = true;
      });
      dom.fileList.appendChild(more);
    } else {
      state.renderedAll = true;
    }
  }

  function buildFileRow(file) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'diff-file-row';
    row.dataset.path = file.path || '';

    var badge = document.createElement('span');
    badge.className = 'diff-status-badge';
    var st = file.status || 'M';
    badge.textContent = STATUS_LABEL[st] || st.charAt(0);
    badge.style.color = STATUS_COLOR[st] || '#8b949e';
    badge.style.borderColor = STATUS_COLOR[st] || '#30363d';
    row.appendChild(badge);

    var pathWrap = document.createElement('span');
    pathWrap.className = 'diff-file-path';
    pathWrap.dir = 'ltr';
    var split = splitPath(file.path || '');
    if (split.dir) {
      var dirSpan = document.createElement('span');
      dirSpan.className = 'diff-file-dir';
      dirSpan.textContent = middleEllipsis(split.dir, 40);
      pathWrap.appendChild(dirSpan);
    }
    var baseSpan = document.createElement('span');
    baseSpan.className = 'diff-file-base';
    baseSpan.textContent = split.base || file.path || '';
    pathWrap.appendChild(baseSpan);
    row.appendChild(pathWrap);

    var stat = document.createElement('span');
    stat.className = 'diff-file-stat';
    if (file.additions > 0) {
      var a = document.createElement('span'); a.className = 'diff-stat-add'; a.textContent = '+' + file.additions;
      stat.appendChild(a);
    }
    if (file.deletions > 0) {
      var d = document.createElement('span'); d.className = 'diff-stat-del'; d.textContent = '−' + file.deletions;
      stat.appendChild(d);
    }
    row.appendChild(stat);

    var chev = document.createElement('span');
    chev.className = 'diff-file-chevron';
    chev.setAttribute('aria-hidden', 'true');
    chev.textContent = '›';
    row.appendChild(chev);

    row.title = file.path || '';
    row.addEventListener('click', function () { openDetail(file); });
    return row;
  }

  function toggleCollapse() {
    state.collapsed = !state.collapsed;
    applyCollapse();
  }
  function applyCollapse() {
    if (!dom.fileList || !dom.summaryChevron) return;
    dom.fileList.style.display = state.collapsed ? 'none' : '';
    dom.summaryChevron.classList.toggle('collapsed', state.collapsed);
  }

  // ── Detail view ──
  function openDetail(file) {
    var token = ++state.requestToken;
    var path = file.path || '';
    if (!path) return;
    cancelActiveSummary();
    state.currentPath = path;

    // Header.
    dom.detailBadge.textContent = STATUS_LABEL[file.status] || (file.status || '?').charAt(0);
    dom.detailBadge.style.color = STATUS_COLOR[file.status] || '#8b949e';
    dom.detailBadge.style.borderColor = STATUS_COLOR[file.status] || '#30363d';
    var split = splitPath(path);
    dom.detailBasename.textContent = split.base || path;
    dom.detailDir.textContent = split.dir || '';
    dom.detailDir.title = path;
    dom.detailStat.textContent = '';
    if (file.additions > 0 || file.deletions > 0) {
      dom.detailStat.textContent = '+' + (file.additions || 0) + ' −' + (file.deletions || 0);
    }

    // AI panel + patch: reset.
    dom.aiContent.textContent = '';
    dom.patchContainer.textContent = '';
    showDetailView();

    // 1) AI summary: cache hit → render immediately; else start request.
    if (state.summaryCache[path] != null) {
      renderAiResult(state.summaryCache[path]);
    } else {
      startSummary(token, path, file.status);
    }

    // 2) Patch: fetch (or cache) then render. Even if AI summary is cached,
    //    we still need to show the patch.
    renderPatch(token, path);
  }

  function backToList() {
    cancelActiveSummary();
    state.requestToken++;
    state.currentPath = null;
    showListView();
  }

  // ── AI summary ──
  function startSummary(token, path, status) {
    if (!dom.aiContent) return;
    renderAiLoading();

    // Step A: ensure we have the patch (needed for the prompt body).
    var patchP;
    if (state.patchCache[path] != null) {
      patchP = Promise.resolve(state.patchCache[path]);
    } else {
      patchP = fetchPatch(state.sessionId, path, token).then(function (patch) {
        if (token !== state.requestToken) throw new Error('__stale__');
        state.patchCache[path] = patch;
        return patch;
      });
    }

    patchP.then(function (patch) {
      if (token !== state.requestToken) return; // stale
      var id = clampId(uuid());
      var ac = new AbortController();
      state.activeSummary = { id: id, path: path, abortController: ac };

      var prompt = buildSummaryPrompt(path, status, patch);
      var body = { id: id, type: 'diff_summary', prompt: prompt, meta: { sessionName: state.sessionId, path: path } };
      var url = withToken('/api/aux/enqueue');

      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (data) {
          if (token !== state.requestToken) return;
          if (state.activeSummary && state.activeSummary.id === id) state.activeSummary = null;
          if (data && data.ok && data.result != null) {
            var text = String(data.result);
            state.summaryCache[path] = text;
            renderAiResult(text);
          } else if (data && data.error === 'cancelled') {
            // Treat as cancelled: leave whatever was showing.
          } else {
            var msg = (data && data.error) || '未知错误';
            renderAiError(msg, function () { startSummary(token, path, status); });
          }
        })
        .catch(function (err) {
          if (token !== state.requestToken) return;
          if (state.activeSummary && state.activeSummary.id === id) state.activeSummary = null;
          if (err && (err.name === 'AbortError' || err.message === '__stale__')) return;
          renderAiError((err && err.message) || String(err), function () { startSummary(token, path, status); });
        });
    }).catch(function (err) {
      if (token !== state.requestToken) return;
      if (err && err.message === '__stale__') return;
      // Patch fetch failed → we can still try the summary without a patch body,
      // but the contract says the patch is required. Surface the error instead.
      renderAiError('无法获取 diff 内容：' + ((err && err.message) || String(err)), function () {
        startSummary(token, path, status);
      });
    });
  }

  function buildSummaryPrompt(path, status, patch) {
    var truncated = false;
    var body = String(patch || '');
    if (body.length > MAX_PATCH_CHARS) {
      body = body.slice(0, MAX_PATCH_CHARS);
      truncated = true;
    }
    var statusText = STATUS_LABEL[status] || status || 'M';
    return [
      '你是一个代码审查助手。请用中文简要总结以下 git diff 中单个文件的改动（文件：' + path + '，状态：' + statusText + '）。',
      '要求：1) 一两句话说明这个文件改了什么、为什么；',
      '2) 用 2-4 条要点列出关键改动；',
      '3) 若发现潜在风险或值得注意的点，最后一行列出，没有则不列。',
      '总输出控制在 200 字以内，纯文本，不要用 markdown 代码块。',
      'diff 内容如下：',
      '',
      body,
      truncated ? '(diff 过长已截断)' : '',
    ].join('\n');
  }

  function renderAiLoading() {
    dom.aiContent.textContent = '';
    var wrap = document.createElement('div');
    wrap.className = 'diff-ai-loading';
    var sp = document.createElement('span');
    sp.className = 'diff-spinner';
    wrap.appendChild(sp);
    var txt = document.createElement('span');
    txt.textContent = 'AI 正在总结改动…';
    wrap.appendChild(txt);
    dom.aiContent.appendChild(wrap);
  }

  function renderAiResult(text) {
    dom.aiContent.textContent = '';
    var out = document.createElement('div');
    out.className = 'diff-ai-result';
    out.textContent = String(text || '');
    dom.aiContent.appendChild(out);
  }

  function renderAiError(msg, onRetry) {
    dom.aiContent.textContent = '';
    var wrap = document.createElement('div');
    wrap.className = 'diff-ai-error';
    var t = document.createElement('span');
    t.textContent = '摘要失败：' + msg;
    wrap.appendChild(t);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'diff-ai-retry';
    btn.textContent = '重试';
    btn.addEventListener('click', function (e) { e.preventDefault(); onRetry(); });
    wrap.appendChild(btn);
    dom.aiContent.appendChild(wrap);
  }

  function cancelActiveSummary() {
    var cur = state.activeSummary;
    if (!cur) return;
    state.activeSummary = null;
    try { cur.abortController.abort(); } catch (_) {}
    // Best-effort cancel on the server; keepalive so it survives modal teardown.
    try {
      var body = JSON.stringify({ id: cur.id });
      var url = withToken('/api/aux/cancel');
      if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(url, blob)) return;
      }
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
    } catch (_) {}
  }

  // ── Patch fetch + render ──
  function fetchPatch(sessionId, path, token) {
    var url = withToken('/api/sessions/' + encodeURIComponent(sessionId) + '/diff/file?path=' + encodeURIComponent(path));
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) {
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (body) {
          throw new Error(body.error || ('HTTP ' + r.status));
        });
        return r.json();
      })
      .then(function (data) {
        if (token !== state.requestToken) throw new Error('__stale__');
        if (data && data.error) throw new Error(data.error);
        return String((data && data.patch) || '');
      });
  }

  function renderPatch(token, path) {
    if (state.patchCache[path] != null) {
      paintPatch(state.patchCache[path]);
      return;
    }
    // Loading placeholder.
    dom.patchContainer.textContent = '';
    var loading = document.createElement('div');
    loading.className = 'diff-line diff-meta';
    loading.style.cssText = 'text-align:center;padding:24px;';
    loading.textContent = '加载 diff…';
    dom.patchContainer.appendChild(loading);

    fetchPatch(state.sessionId, path, token)
      .then(function (patch) {
        if (token !== state.requestToken) return;
        state.patchCache[path] = patch;
        paintPatch(patch);
      })
      .catch(function (err) {
        if (token !== state.requestToken) return;
        if (err && err.message === '__stale__') return;
        dom.patchContainer.textContent = '';
        var errLine = document.createElement('div');
        errLine.className = 'diff-line diff-del';
        errLine.textContent = 'diff 加载失败：' + ((err && err.message) || String(err));
        dom.patchContainer.appendChild(errLine);
      });
  }

  function paintPatch(patch) {
    if (!dom.patchContainer) return;
    dom.patchContainer.textContent = '';
    var live = getLiveUi();
    if (live && typeof live.renderDiff === 'function') {
      live.renderDiff(dom.patchContainer, patch);
    } else {
      // Fallback: monospace pre-wrap text.
      var pre = document.createElement('pre');
      pre.style.cssText = 'margin:0;padding:8px 16px;white-space:pre-wrap;word-break:break-word;font-family:monospace;font-size:12px;color:#c9d1d9;';
      pre.textContent = String(patch || '');
      dom.patchContainer.appendChild(pre);
    }
  }

  // ── Expose ──
  window.chatDiffViewer = Object.freeze({ open: open, close: close });
})();
