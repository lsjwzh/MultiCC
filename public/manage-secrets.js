'use strict';

// /manage「敏感信息」面板 — 本地密钥保险箱的前端。
// 后端见 src/secrets-vault.js（GET/POST/DELETE /api/secrets）。
// 独立文件而非 manage.js：manage.js 是 migration-debt 棘轮文件，只减不增。
// 面板约定：列表永远只拿元数据；值仅在用户点「显示/复制」时经
// /api/secrets/:name/value 单条读取，且不落任何日志或缓存。

(function initSecretsView() {
  if (typeof window === 'undefined' || typeof window.document === 'undefined') return;
  const api = window.MultiCCApi;
  const qs = typeof tokenQS === 'function' ? tokenQS : () => '';
  const notify = (msg, isError) => {
    if (typeof showToast === 'function') showToast(msg, isError);
  };

  const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function loadSecrets() {
    const list = document.getElementById('secrets-list');
    if (!list) return;
    try {
      const entries = await api.json('/api/secrets' + qs('?'));
      const cnt = document.getElementById('secrets-count');
      if (cnt) cnt.textContent = entries.length ? `(${entries.length})` : '';
      const nav = document.getElementById('nav-secrets-count');
      if (nav) nav.textContent = entries.length;
      if (!entries.length) {
        list.innerHTML = '<div style="color:var(--faint);font-size:13px;">保险箱是空的。用上方表单添加，或在聊天里让 agent 调用 request_secret_input 弹安全输入框。</div>';
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
      + 'display:flex;align-items:center;gap:10px;background:var(--bg-soft);';
    row.innerHTML = `
      <span style="font-size:15px;">🔑</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;color:var(--text);font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${esc(e.name)}
        </div>
        <div style="font-size:11px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${esc(e.description || '')}${e.description ? ' · ' : ''}${e.source === 'agent' ? 'agent 收集' : '手动'} · 更新于 ${esc(fmtTime(e.updatedAt))}
        </div>
      </div>
      <button class="btn btn-sm" data-act="reveal" title="显示/复制值">👁</button>
      <button class="btn btn-sm" data-act="copy" title="复制值到剪贴板">⧉</button>
      <button class="btn btn-sm" data-act="edit" title="载入到上方表单编辑">✎</button>
      <button class="btn btn-sm btn-danger" data-act="del" title="删除">✕</button>`;
    row.querySelector('[data-act="reveal"]').onclick = () => revealSecret(e, row);
    row.querySelector('[data-act="copy"]').onclick = () => copySecret(e);
    row.querySelector('[data-act="edit"]').onclick = () => editSecret(e);
    row.querySelector('[data-act="del"]').onclick = () => deleteSecret(e);
    return row;
  }

  // 显示值：单条拉取，toggle 展示，行内渲染，不进任何日志。
  async function revealSecret(e, row) {
    const btn = row.querySelector('[data-act="reveal"]');
    const existing = row.querySelector('.secret-value-view');
    if (existing) { existing.remove(); btn.textContent = '👁'; return; }
    try {
      const result = await api.json(`/api/secrets/${encodeURIComponent(e.name)}/value` + qs('?'));
      const view = document.createElement('div');
      view.className = 'secret-value-view';
      view.style.cssText = 'flex-basis:100%;font-family:var(--mono);font-size:12px;color:var(--text);'
        + 'background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 10px;'
        + 'word-break:break-all;';
      view.textContent = result.value || '';
      row.style.flexWrap = 'wrap';
      row.appendChild(view);
      btn.textContent = '🙈';
    } catch (err) { notify(err.message || String(err), true); }
  }

  async function copySecret(e) {
    try {
      const result = await api.json(`/api/secrets/${encodeURIComponent(e.name)}/value` + qs('?'));
      await navigator.clipboard.writeText(String(result.value || ''));
      notify('已复制到剪贴板');
    } catch (err) { notify(err.message || String(err), true); }
  }

  function editSecret(e) {
    const nameEl = document.getElementById('secret-name');
    const descEl = document.getElementById('secret-desc');
    if (nameEl) nameEl.value = e.name || '';
    if (descEl) descEl.value = e.description || '';
    const valEl = document.getElementById('secret-value');
    if (valEl) { valEl.value = ''; valEl.placeholder = '留空保持原值不变；输入新值则覆盖'; }
    nameEl?.focus();
  }

  async function deleteSecret(e) {
    const ok = typeof showConfirm === 'function'
      ? await showConfirm(`删除敏感条目 ${e.name}？agent 之后将无法使用它。`, { danger: true })
      : window.confirm(`删除敏感条目 ${e.name}？`);
    if (!ok) return;
    try {
      await api.json(`/api/secrets/${encodeURIComponent(e.name)}` + qs('?'), { method: 'DELETE' });
      notify(`已删除 ${e.name}`);
      loadSecrets();
    } catch (err) { notify(err.message || String(err), true); }
  }

  async function secretsSave() {
    const nameEl = document.getElementById('secret-name');
    const valEl = document.getElementById('secret-value');
    const descEl = document.getElementById('secret-desc');
    const name = (nameEl?.value || '').trim();
    if (!NAME_RE.test(name)) { notify('名称仅支持字母数字 _ . -，长度 1-64', true); return; }
    const value = valEl?.value || '';
    if (!value) { notify('值不能为空（编辑已有条目时输入新值覆盖）', true); return; }
    try {
      await api.json('/api/secrets' + qs('?'), {
        method: 'POST',
        json: { name, value, description: (descEl?.value || '').trim(), source: 'user' },
      });
      notify(`已保存 ${name} 到本地保险箱`);
      if (nameEl) nameEl.value = '';
      if (valEl) { valEl.value = ''; valEl.placeholder = '密钥明文，仅存本地'; }
      if (descEl) descEl.value = '';
      loadSecrets();
    } catch (err) { notify(err.message || String(err), true); }
  }

  window.loadSecrets = loadSecrets;
  window.secretsSave = secretsSave;
})();
