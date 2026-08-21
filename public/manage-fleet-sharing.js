'use strict';

// Fleet sharing UI is intentionally isolated from the dashboard controller.
// The source side manages bounded capabilities; the target side renders only
// read-only snapshots returned by the authenticated external-Fleet API.
(function fleetSharingUi(global) {
  let externalFleets = [];
  let activeFleetId = null;

  function el(id) { return document.getElementById(id); }
  function setError(id, message) {
    const target = el(id);
    if (!target) return;
    target.textContent = message || '';
    target.style.display = message ? 'block' : 'none';
  }
  function closeModal(id) { const modal = el(id); if (modal) modal.classList.remove('visible'); }
  function displayDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : '—';
  }

  function ensureModals() {
    if (el('fleet-share-modal')) return;
    const host = document.createElement('div');
    host.innerHTML = `
      <div id="fleet-share-modal" class="modal-backdrop fleet-share-modal">
        <div class="modal-card">
          <h3>分享 Fleet</h3>
          <div id="fleet-share-sub" class="fs-sub"></div>
          <div class="fs-field"><label for="fleet-share-password">访问密码（至少 6 位）</label><input id="fleet-share-password" type="password" autocomplete="new-password" /></div>
          <div class="fs-row">
            <div class="fs-field"><label for="fleet-share-days">有效天数</label><input id="fleet-share-days" type="number" min="1" max="365" value="7" /></div>
            <div class="fs-field"><label for="fleet-share-accesses">最多导入次数</label><input id="fleet-share-accesses" type="number" min="1" max="10000" value="10" /></div>
          </div>
          <div class="fs-field"><label for="fleet-share-description">给接收方的说明（可选）</label><textarea id="fleet-share-description" maxlength="500"></textarea></div>
          <div class="fs-note">只分享 Fleet 名称、说明和会话摘要；不会分享代码路径、聊天内容、Provider 凭据或管理权限。</div>
          <div id="fleet-share-error" class="fs-error"></div>
          <div class="fs-actions"><button class="btn" type="button" onclick="closeFleetShareModal()">取消</button><button id="fleet-share-create" class="btn btn-green" type="button" onclick="createFleetShare()">生成分享链接</button></div>
          <div id="fleet-share-result" class="fs-result"><strong>分享链接已生成</strong><div class="fs-copy-row"><input id="fleet-share-url" readonly /><button class="btn" type="button" onclick="copyFleetShareUrl()">复制</button></div><div class="fs-note" style="margin-top:7px">请把密码通过单独渠道发给接收方。</div></div>
          <div class="fs-existing"><h4>现有分享</h4><div id="fleet-share-list"><span class="fs-note">加载中…</span></div></div>
        </div>
      </div>
      <div id="fleet-import-modal" class="modal-backdrop fleet-share-modal">
        <div class="modal-card">
          <h3 id="fleet-import-title">导入外部 Fleet</h3>
          <div class="fs-sub">粘贴另一台 MultiCC 生成的 Fleet 分享链接。导入结果是只读快照，不会在本机创建 Git 仓库或会话。</div>
          <div class="fs-field"><label for="fleet-import-url">分享链接</label><input id="fleet-import-url" type="url" autocomplete="off" placeholder="https://host/fleet-share/fleet_share_…" /></div>
          <div class="fs-field"><label for="fleet-import-password">分享密码</label><input id="fleet-import-password" type="password" autocomplete="off" /></div>
          <div class="fs-field"><label for="fleet-import-alias">本地别名（可选）</label><input id="fleet-import-alias" type="text" maxlength="120" placeholder="例如：远程开发机" /></div>
          <div class="fs-note">密码只用于本次请求，不会保存到本机。刷新快照时需要重新输入。</div>
          <div id="fleet-import-error" class="fs-error"></div>
          <div class="fs-actions"><button class="btn" type="button" onclick="closeImportFleetModal()">取消</button><button id="fleet-import-submit" class="btn btn-green" type="button" onclick="submitImportFleet()">导入</button></div>
        </div>
      </div>`;
    while (host.firstElementChild) document.body.appendChild(host.firstElementChild);
  }

  function renderShareList(shares) {
    const list = el('fleet-share-list');
    if (!list) return;
    if (!shares.length) {
      list.innerHTML = '<span class="fs-note">还没有有效分享。</span>';
      return;
    }
    list.innerHTML = shares.map(share => `
      <div class="fs-share-row">
        <div style="min-width:0"><div class="fs-share-url" title="${escapeHtml(share.url)}">${escapeHtml(share.url)}</div><div class="fs-share-meta">${share.expired ? '已过期' : `剩余 ${share.remainingAccesses}/${share.maxAccesses} 次`} · 截止 ${escapeHtml(displayDate(share.expiresAt))}</div></div>
        <button class="btn btn-sm btn-danger" type="button" onclick="revokeFleetShare('${escapeHtml(share.token)}')">撤销</button>
      </div>`).join('');
  }

  async function loadFleetShares() {
    if (!activeFleetId) return;
    try {
      const response = await fetch(`/api/fleets/${encodeURIComponent(activeFleetId)}/shares`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      renderShareList(data.shares || []);
    } catch (error) {
      const list = el('fleet-share-list');
      if (list) list.innerHTML = `<span class="fs-error" style="display:block">${escapeHtml(error.message)}</span>`;
    }
  }

  function openFleetShareModal(fleetId) {
    ensureModals();
    const fleet = (_cachedDirectories || []).find(item => item.id === fleetId);
    if (!fleet) return;
    activeFleetId = fleetId;
    el('fleet-share-sub').textContent = `为「${fleet.name}」创建跨实例只读分享。`;
    el('fleet-share-password').value = '';
    el('fleet-share-days').value = '7';
    el('fleet-share-accesses').value = '10';
    el('fleet-share-description').value = '';
    el('fleet-share-result').style.display = 'none';
    setError('fleet-share-error', '');
    el('fleet-share-modal').classList.add('visible');
    loadFleetShares();
    setTimeout(() => el('fleet-share-password').focus(), 30);
  }

  async function createFleetShare() {
    if (!activeFleetId) return;
    const button = el('fleet-share-create');
    setError('fleet-share-error', '');
    button.disabled = true;
    try {
      const response = await fetch(`/api/fleets/${encodeURIComponent(activeFleetId)}/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          password: el('fleet-share-password').value,
          expiresInDays: Number(el('fleet-share-days').value),
          maxAccesses: Number(el('fleet-share-accesses').value),
          description: el('fleet-share-description').value,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      el('fleet-share-url').value = data.url;
      el('fleet-share-result').style.display = 'block';
      await loadFleetShares();
      showToast('Fleet 分享链接已生成');
    } catch (error) {
      setError('fleet-share-error', error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function revokeFleetShare(token) {
    if (!activeFleetId) return;
    if (!(await showConfirm('撤销这个 Fleet 分享？已发出的链接会立即失效。', { danger: true, okText: '撤销' }))) return;
    try {
      const response = await fetch(`/api/fleets/${encodeURIComponent(activeFleetId)}/share/${encodeURIComponent(token)}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      await loadFleetShares();
      showToast('Fleet 分享已撤销');
    } catch (error) { showToast(`撤销失败：${error.message}`, true); }
  }

  async function copyFleetShareUrl() {
    const value = el('fleet-share-url').value;
    try { await navigator.clipboard.writeText(value); }
    catch (_) { el('fleet-share-url').select(); document.execCommand('copy'); }
    showToast('分享链接已复制');
  }

  function openImportFleetModal(externalId) {
    ensureModals();
    const existing = externalId ? externalFleets.find(item => item.id === externalId) : null;
    el('fleet-import-title').textContent = existing ? '刷新外部 Fleet' : '导入外部 Fleet';
    el('fleet-import-url').value = existing ? existing.shareUrl : '';
    el('fleet-import-password').value = '';
    el('fleet-import-alias').value = existing ? existing.alias : '';
    setError('fleet-import-error', '');
    el('fleet-import-modal').classList.add('visible');
    setTimeout(() => (existing ? el('fleet-import-password') : el('fleet-import-url')).focus(), 30);
  }

  async function submitImportFleet() {
    const button = el('fleet-import-submit');
    setError('fleet-import-error', '');
    button.disabled = true;
    try {
      const response = await fetch('/api/external-fleets/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shareUrl: el('fleet-import-url').value.trim(),
          password: el('fleet-import-password').value,
          alias: el('fleet-import-alias').value.trim(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      closeModal('fleet-import-modal');
      await loadExternalFleets();
      showToast(`已导入外部 Fleet「${data.fleet.name}」`);
    } catch (error) {
      setError('fleet-import-error', error.message);
    } finally {
      button.disabled = false;
    }
  }

  function renderExternalFleets() {
    const section = el('external-fleet-section');
    const list = el('external-fleet-list');
    if (!section || !list) return;
    section.hidden = externalFleets.length === 0;
    el('external-fleet-count').textContent = String(externalFleets.length);
    list.innerHTML = externalFleets.map(fleet => {
      const samples = (fleet.sessions || []).slice(0, 6).map(session =>
        `<span class="external-session-chip" title="${escapeHtml(session.label)}">${escapeHtml(session.cli)} · ${escapeHtml(session.label)}</span>`).join('');
      const remaining = Math.max(0, fleet.sessionCount - Math.min(6, (fleet.sessions || []).length));
      return `<article class="external-fleet-card">
        <div class="external-fleet-head"><div class="external-fleet-main"><div class="external-fleet-name">${escapeHtml(fleet.name)}<span class="external-fleet-badge">外部 · 只读</span></div><div class="external-fleet-origin" title="${escapeHtml(fleet.sourceOrigin)}">${escapeHtml(fleet.sourceOrigin)}</div></div></div>
        ${fleet.description ? `<div class="external-fleet-desc">${escapeHtml(fleet.description)}</div>` : ''}
        <div class="external-fleet-sessions">${samples || '<span class="fs-note">没有会话摘要</span>'}${remaining ? `<span class="external-session-chip">+${remaining}</span>` : ''}</div>
        <div class="external-fleet-foot"><span class="stamp">${fleet.sessionCount} 会话 · ${escapeHtml(displayDate(fleet.refreshedAt))}</span><button class="btn btn-sm" type="button" onclick="openImportFleetModal('${escapeHtml(fleet.id)}')">刷新</button><button class="btn btn-sm btn-danger" type="button" onclick="removeExternalFleet('${escapeHtml(fleet.id)}')">移除</button></div>
      </article>`;
    }).join('');
  }

  async function loadExternalFleets() {
    try {
      const response = await fetch('/api/external-fleets');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      externalFleets = Array.isArray(data.fleets) ? data.fleets : [];
      renderExternalFleets();
    } catch (error) {
      console.error('Failed to load external Fleets:', error);
    }
  }

  async function removeExternalFleet(id) {
    const fleet = externalFleets.find(item => item.id === id);
    if (!fleet || !(await showConfirm(`移除外部 Fleet「${fleet.name}」？来源实例不会受影响。`, { danger: true, okText: '移除' }))) return;
    try {
      const response = await fetch(`/api/external-fleets/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      await loadExternalFleets();
      showToast('外部 Fleet 已移除');
    } catch (error) { showToast(`移除失败：${error.message}`, true); }
  }

  ensureModals();
  Object.assign(global, {
    closeFleetShareModal: () => closeModal('fleet-share-modal'),
    closeImportFleetModal: () => closeModal('fleet-import-modal'),
    copyFleetShareUrl,
    createFleetShare,
    loadExternalFleets,
    openFleetShareModal,
    openImportFleetModal,
    removeExternalFleet,
    revokeFleetShare,
    submitImportFleet,
  });
})(window);
