'use strict';

// /manage「服务与文档」面板 — 文档 / Web 服务管理表的前端。
// 后端见 src/docs-registry.js（GET/POST/PATCH/DELETE /api/docs-registry）。
// 独立文件而非 manage.js：manage.js 是 migration-debt 棘轮文件，只减不增。

(function initDocsRegistryView() {
  const api = window.MultiCCApi;
  const qs = typeof tokenQS === 'function' ? tokenQS : () => '';
  const t = typeof tt === 'function' ? tt : (k) => k;
  const notify = (msg, isError) => {
    if (typeof showToast === 'function') showToast(msg, isError);
  };

  const KIND_ICON = { page: '📄', file: '📎', service: '🌐' };
  const STATUS_DOT = { up: '🟢', down: '⚪', starting: '🟡', unknown: '❔' };

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function loadDocsRegistry() {
    const list = document.getElementById('docsreg-list');
    if (!list) return;
    try {
      const entries = await api.json('/api/docs-registry' + qs('?'));
      const cnt = document.getElementById('docsreg-count');
      if (cnt) cnt.textContent = entries.length ? `(${entries.length})` : '';
      if (!entries.length) {
        list.innerHTML = `<div style="color:var(--faint);font-size:13px;">${esc(t('docsregEmpty'))}</div>`;
        return;
      }
      list.innerHTML = '';
      for (const e of entries) list.appendChild(renderRow(e));
    } catch (err) {
      list.innerHTML = `<div style="color:#f85149;font-size:13px;">${esc(err.message || err)}</div>`;
    }
  }

  function renderRow(e) {
    const row = document.createElement('div');
    row.style.cssText = 'border:1px solid var(--line);border-radius:10px;padding:10px 14px;'
      + 'display:flex;align-items:center;gap:10px;background:var(--bg-soft);'
      + (e.expired ? 'opacity:.55;' : '');
    const icon = KIND_ICON[e.kind] || '📄';
    const href = esc(e.url);
    const expiredTag = e.expired
      ? `<span style="font-size:11px;color:#d29922;border:1px solid #d2992255;border-radius:10px;padding:0 6px;">${esc(t('docsregExpired'))}</span>`
      : '';
    const pinTag = e.pinned ? '📌' : '';
    const isSvc = e.kind === 'service';
    const dot = isSvc ? `<span title="${esc(t('docsregStatus_' + (e.status || 'unknown')))}">${STATUS_DOT[e.status] || '❔'}</span>` : '';
    const portTag = isSvc && e.port ? ` · :${e.port}` : '';
    const svcBtns = isSvc ? `
      <button class="btn btn-sm" data-act="log" title="${esc(t('docsregLog'))}">📜</button>
      ${e.status === 'up' || e.status === 'starting'
        ? `<button class="btn btn-sm btn-danger" data-act="stop" title="${esc(t('docsregStop'))}">⏹</button>`
        : `<button class="btn btn-sm btn-green" data-act="start" title="${esc(t(e.startCmd ? 'docsregStart' : 'docsregNoCmd'))}" ${e.startCmd ? '' : 'disabled'}>▶</button>`}`
      : '';
    row.innerHTML = `
      <span style="font-size:15px;">${icon}</span>
      ${dot}
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${pinTag} <a href="${href}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;">${esc(e.title)}</a> ${expiredTag}
        </div>
        <div style="font-size:11px;color:var(--faint);font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${href}${portTag}${e.sessionId ? ' · ' + esc(e.sessionId) : ''} · ${esc(fmtTime(e.createdAt))}
        </div>
      </div>
      ${svcBtns}
      <button class="btn btn-sm" data-act="pin" title="${esc(t(e.pinned ? 'docsregUnpin' : 'docsregPin'))}">${e.pinned ? '📌' : '📍'}</button>
      <button class="btn btn-sm btn-danger" data-act="del" title="${esc(t('delete'))}">✕</button>`;
    row.querySelector('[data-act="pin"]').onclick = () => togglePin(e);
    row.querySelector('[data-act="del"]').onclick = () => removeEntry(e);
    const startBtn = row.querySelector('[data-act="start"]');
    if (startBtn) startBtn.onclick = () => svcAction(e, 'start');
    const stopBtn = row.querySelector('[data-act="stop"]');
    if (stopBtn) stopBtn.onclick = () => svcAction(e, 'stop');
    const logBtn = row.querySelector('[data-act="log"]');
    if (logBtn) logBtn.onclick = () => window.open(`/api/docs-registry/${encodeURIComponent(e.id)}/log` + qs('?'), '_blank');
    return row;
  }

  async function svcAction(e, action) {
    try {
      await api.json(`/api/docs-registry/${encodeURIComponent(e.id)}/${action}` + qs('?'), { method: 'POST' });
      notify(t(action === 'start' ? 'docsregStarted' : 'docsregStopped'));
    } catch (err) { notify(err.message || String(err), true); }
    loadDocsRegistry();
  }

  async function togglePin(e) {
    try {
      await api.json(`/api/docs-registry/${encodeURIComponent(e.id)}` + qs('?'), {
        method: 'PATCH', json: { pinned: !e.pinned },
      });
      loadDocsRegistry();
    } catch (err) { notify(err.message || String(err), true); }
  }

  async function removeEntry(e) {
    const ok = typeof showConfirm === 'function'
      ? await showConfirm(t('docsregConfirmDelete', { title: e.title }), { danger: true })
      : true;
    if (!ok) return;
    try {
      await api.json(`/api/docs-registry/${encodeURIComponent(e.id)}` + qs('?'), { method: 'DELETE' });
      notify(t('docsregDeleted'));
      loadDocsRegistry();
    } catch (err) { notify(err.message || String(err), true); }
  }

  async function addService() {
    const title = typeof showPrompt === 'function' ? await showPrompt(t('docsregAddTitle')) : null;
    if (!title) return;
    const url = typeof showPrompt === 'function' ? await showPrompt(t('docsregAddUrl')) : null;
    if (!url) return;
    const startCmd = typeof showPrompt === 'function' ? await showPrompt(t('docsregAddCmd')) : null;
    const cwd = startCmd && typeof showPrompt === 'function' ? await showPrompt(t('docsregAddCwd')) : null;
    try {
      await api.json('/api/docs-registry' + qs('?'), {
        method: 'POST',
        json: { kind: 'service', title, url, source: 'user', ...(startCmd ? { startCmd } : {}), ...(cwd ? { cwd } : {}) },
      });
      notify(t('docsregAdded'));
      loadDocsRegistry();
    } catch (err) { notify(err.message || String(err), true); }
  }

  window.loadDocsRegistry = loadDocsRegistry;
  window.docsRegistryAddService = addService;

  // 服务状态是活的：面板可见时每 5s 静默重拉（30s 服务端探活的读取端）。
  setInterval(() => {
    if (document.body && document.body.dataset.view === 'docs') loadDocsRegistry();
  }, 5000);
})();
