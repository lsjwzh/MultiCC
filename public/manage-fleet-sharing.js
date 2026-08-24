'use strict';

// Imported Fleets are adapted into the same directory/session records consumed
// by the dashboard. This module only handles remote addressing and capability
// routing; cards, detail views and session actions stay in the shared UI path.
(function fleetSharingUi(global) {
  let externalFleets = [];
  let activeFleetId = null;
  const externalDirectories = new Map();
  const externalSessions = new Map();
  const baseFetch = global.fetch.bind(global);

  function syntheticSessionId(fleetId, remoteSessionId) {
    return `${fleetId}::${remoteSessionId}`;
  }

  function externalProxyUrl(url, fleet, remotePathname) {
    url.pathname = `/api/external-fleets/${encodeURIComponent(fleet.id)}/remote${remotePathname}`;
    return url;
  }

  function rewriteExternalRequest(input) {
    let url;
    try {
      const raw = input instanceof Request ? input.url : String(input);
      url = new URL(raw, location.href);
    } catch (_) { return input; }
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return input;

    let match = /^\/api\/directories\/([^/]+)(.*)$/.exec(url.pathname);
    if (match) {
      let directoryId;
      try { directoryId = decodeURIComponent(match[1]); } catch (_) { return input; }
      const fleet = externalDirectories.get(directoryId);
      if (fleet && fleet.interactive) {
        externalProxyUrl(url, fleet, `/api/directories/${encodeURIComponent(fleet.sourceFleetId)}${match[2]}`);
      }
    } else {
      match = /^\/api\/sessions\/([^/]+)(.*)$/.exec(url.pathname);
      if (match) {
        let sessionId;
        try { sessionId = decodeURIComponent(match[1]); } catch (_) { return input; }
        const entry = externalSessions.get(sessionId);
        if (entry && entry.fleet.interactive) {
          externalProxyUrl(url, entry.fleet, `/api/sessions/${encodeURIComponent(entry.remote.id)}${match[2]}`);
        }
      }
    }
    if (input instanceof Request) return new Request(url.href, input);
    return url.href;
  }

  global.fetch = function fleetAwareFetch(input, init) {
    return baseFetch(rewriteExternalRequest(input), init);
  };

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
      <div id="fleet-share-modal" class="modal-backdrop fleet-share-modal" role="dialog" aria-modal="true" aria-labelledby="fleet-share-title" onclick="if(event.target===this)closeFleetShareModal()">
        <div class="modal-card">
          <div class="fs-modal-head"><h3 id="fleet-share-title">分享 Fleet</h3><button class="fs-modal-close" type="button" onclick="closeFleetShareModal()" aria-label="关闭分享 Fleet 弹窗" title="关闭">×</button></div>
          <div class="fs-modal-body">
          <div id="fleet-share-sub" class="fs-sub"></div>
          <div class="fs-field"><label for="fleet-share-password">访问密码（至少 6 位）</label><input id="fleet-share-password" type="password" autocomplete="new-password" /></div>
          <div class="fs-row">
            <div class="fs-field"><label for="fleet-share-days">有效天数</label><input id="fleet-share-days" type="number" min="1" max="365" value="7" /></div>
            <div class="fs-field"><label for="fleet-share-accesses">最多导入次数</label><input id="fleet-share-accesses" type="number" min="1" max="10000" value="10" /></div>
          </div>
          <div class="fs-field"><label for="fleet-share-description">给接收方的说明（可选）</label><textarea id="fleet-share-description" maxlength="500"></textarea></div>
          <div class="fs-note">接收方可查看并操作此 Fleet 的会话和代码变更；不会获得 Provider 凭据或其他 Fleet 的管理权限。</div>
          <div id="fleet-share-error" class="fs-error"></div>
          <div class="fs-actions"><button class="btn" type="button" onclick="closeFleetShareModal()">取消</button><button id="fleet-share-create" class="btn btn-green" type="button" onclick="createFleetShare()">生成分享链接</button></div>
          <div id="fleet-share-result" class="fs-result"><strong>分享链接已生成</strong><div class="fs-copy-row"><input id="fleet-share-url" readonly /><button class="btn" type="button" onclick="copyFleetShareUrl()">复制</button></div><div class="fs-note" style="margin-top:7px">请把密码通过单独渠道发给接收方。</div></div>
          <div class="fs-existing"><h4>现有分享</h4><div id="fleet-share-list"><span class="fs-note">加载中…</span></div></div>
          </div>
        </div>
      </div>
      <div id="fleet-import-modal" class="modal-backdrop fleet-share-modal" role="dialog" aria-modal="true" aria-labelledby="fleet-import-title" onclick="if(event.target===this)closeImportFleetModal()">
        <div class="modal-card">
          <div class="fs-modal-head"><h3 id="fleet-import-title">导入外部 Fleet</h3><button class="fs-modal-close" type="button" onclick="closeImportFleetModal()" aria-label="关闭导入 Fleet 弹窗" title="关闭">×</button></div>
          <div class="fs-modal-body">
          <div class="fs-sub">粘贴另一台 MultiCC 生成的 Fleet 分享链接。导入后会出现在 Fleet 列表中，操作仍在来源实例执行。</div>
          <div class="fs-field"><label for="fleet-import-url">分享链接</label><input id="fleet-import-url" type="url" autocomplete="off" placeholder="https://host/fleet-share/fleet_share_…" /></div>
          <div class="fs-field"><label for="fleet-import-password">分享密码</label><input id="fleet-import-password" type="password" autocomplete="off" /></div>
          <div class="fs-field"><label for="fleet-import-alias">本地别名（可选）</label><input id="fleet-import-alias" type="text" maxlength="120" placeholder="例如：远程开发机" /></div>
          <div class="fs-note">密码只用于本次导入，不会保存到本机；本机仅保存随机的 Fleet 范围授权。</div>
          <div id="fleet-import-error" class="fs-error"></div>
          <div class="fs-actions"><button class="btn" type="button" onclick="closeImportFleetModal()">取消</button><button id="fleet-import-submit" class="btn btn-green" type="button" onclick="submitImportFleet()">导入</button></div>
          </div>
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
    el('fleet-share-sub').textContent = `为「${fleet.name}」创建跨实例、Fleet 范围的操作授权。`;
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

  function closeFleetShareModal() {
    closeModal('fleet-share-modal');
    const password = el('fleet-share-password');
    if (password) password.value = '';
  }

  function closeImportFleetModal() {
    closeModal('fleet-import-modal');
    const password = el('fleet-import-password');
    if (password) password.value = '';
  }

  function closeVisibleFleetModal(event) {
    if (event.key !== 'Escape') return;
    const importModal = el('fleet-import-modal');
    const shareModal = el('fleet-share-modal');
    if (importModal && importModal.classList.contains('visible')) closeImportFleetModal();
    else if (shareModal && shareModal.classList.contains('visible')) closeFleetShareModal();
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

  function dashboardData() {
    externalDirectories.clear();
    externalSessions.clear();
    const directories = [];
    const sessions = [];
    for (const fleet of externalFleets) {
      externalDirectories.set(fleet.id, fleet);
      directories.push({
        id: fleet.id,
        name: fleet.name,
        path: fleet.sourceOrigin,
        description: fleet.description || '',
        createdAt: fleet.importedAt,
        external: true,
        interactive: fleet.interactive === true,
        externalFleetId: fleet.id,
        sourceFleetId: fleet.sourceFleetId,
        sourceOrigin: fleet.sourceOrigin,
        pushState: { available: false },
      });
      for (const remote of fleet.sessions || []) {
        const id = syntheticSessionId(fleet.id, remote.id);
        const session = {
          ...remote,
          id,
          dirId: fleet.id,
          external: true,
          externalFleetId: fleet.id,
          remoteSessionId: remote.id,
          sourceOrigin: fleet.sourceOrigin,
          active: remote.active === true,
        };
        externalSessions.set(id, { fleet, remote });
        sessions.push(session);
      }
    }
    return { directories, sessions };
  }

  async function loadExternalFleetData() {
    try {
      const response = await baseFetch('/api/external-fleets');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      externalFleets = Array.isArray(data.fleets) ? data.fleets : [];
      return dashboardData();
    } catch (error) {
      console.error('Failed to load external Fleets:', error);
      externalFleets = [];
      return dashboardData();
    }
  }

  async function loadExternalFleets() { return loadDashboard(); }

  function sessionIdForRemote(directoryId, remoteSessionId) {
    const fleet = externalDirectories.get(directoryId);
    return fleet ? syntheticSessionId(fleet.id, remoteSessionId) : remoteSessionId;
  }

  function externalSessionPageUrl(sessionId) {
    const entry = externalSessions.get(sessionId);
    if (!entry) return '';
    const params = new URLSearchParams({ external: entry.fleet.id });
    if (entry.remote.kind === 'chat') {
      params.set('session', entry.remote.id);
      return `/chat.html?${params.toString()}`;
    }
    params.set('id', entry.remote.id);
    return `/?${params.toString()}`;
  }

  function sessionPageUrl(sessionId, kind) {
    return externalSessionPageUrl(sessionId) || (kind === 'chat'
      ? `/chat.html?session=${encodeURIComponent(sessionId)}`
      : `/?id=${encodeURIComponent(sessionId)}`);
  }

  function ensureInteractiveSession(session) {
    if (!session?.external || externalDirectories.get(session.dirId)?.interactive) return true;
    openImportFleetModal(session.externalFleetId);
    return false;
  }

  function sessionSubtitle(session) {
    return session.external
      ? `#${session.remoteSessionId} · ${session.sourceOrigin || '外部 Fleet'}`
      : `#${session.id} · ${session.cwd || ''}`;
  }

  function apiUrlForDirectory(url, directoryId) {
    const fleet = externalDirectories.get(directoryId);
    if (!fleet || !fleet.interactive) return url;
    const parsed = new URL(url, location.href);
    return externalProxyUrl(parsed, fleet, parsed.pathname).pathname + parsed.search;
  }

  async function externalWorkspaceWsUrl(rawUrl, directoryId) {
    const fleet = externalDirectories.get(directoryId);
    if (!fleet || !fleet.interactive) return '';
    const remoteUrl = new URL(rawUrl, location.href);
    remoteUrl.searchParams.set('dirId', fleet.sourceFleetId);
    const response = await baseFetch(`/api/external-fleets/${encodeURIComponent(fleet.id)}/ws-ticket`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pathname: remoteUrl.pathname, directoryId: fleet.sourceFleetId }),
    });
    if (!response.ok) throw new Error(`External Fleet WebSocket ticket failed: HTTP ${response.status}`);
    const data = await response.json();
    const source = new URL(data.wsOrigin);
    remoteUrl.protocol = source.protocol;
    remoteUrl.host = source.host;
    remoteUrl.searchParams.set('ticket', data.ticket);
    return remoteUrl.toString();
  }

  function workspaceWsUrl(rawUrl, directoryId) {
    return externalDirectories.has(directoryId)
      ? externalWorkspaceWsUrl(rawUrl, directoryId)
      : global.multiccWsUrl(rawUrl);
  }

  function adaptWorkspaceMessage(directoryId, message) {
    const fleet = externalDirectories.get(directoryId);
    if (!fleet || !message || typeof message !== 'object') return message;
    const mapId = id => id ? syntheticSessionId(fleet.id, id) : id;
    const mapped = { ...message };
    if (Array.isArray(message.sessions)) {
      mapped.sessions = message.sessions.map(session => ({ ...session, id: mapId(session.id) }));
    }
    if (Array.isArray(message.queues)) {
      mapped.queues = message.queues.map(queue => ({ ...queue, sessionId: mapId(queue.sessionId) }));
    }
    if (Array.isArray(message.events)) {
      mapped.events = message.events.map(event => ({ ...event, sessionId: mapId(event.sessionId) }));
    }
    if (message.sessionId) mapped.sessionId = mapId(message.sessionId);
    if (message.event) mapped.event = { ...message.event, sessionId: mapId(message.event.sessionId) };
    return mapped;
  }

  function parseWorkspaceMessage(directoryId, data) {
    return adaptWorkspaceMessage(directoryId, JSON.parse(data));
  }

  async function refreshExternalFleet(id) {
    try {
      const response = await baseFetch(`/api/external-fleets/${encodeURIComponent(id)}/refresh`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      await loadExternalFleets();
      showToast(`外部 Fleet「${data.fleet.name}」已刷新`);
    } catch (error) { showToast(`刷新失败：${error.message}`, true); }
  }

  async function removeExternalFleet(id) {
    const fleet = externalFleets.find(item => item.id === id);
    if (!fleet || !(await showConfirm(`移除外部 Fleet「${fleet.name}」？来源实例不会受影响。`, { danger: true, okText: '移除' }))) return;
    try {
      const response = await baseFetch(`/api/external-fleets/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      await loadExternalFleets();
      showToast('外部 Fleet 已移除');
    } catch (error) { showToast(`移除失败：${error.message}`, true); }
  }

  ensureModals();
  document.addEventListener('keydown', closeVisibleFleetModal);
  Object.assign(global, {
    closeFleetShareModal,
    closeImportFleetModal,
    copyFleetShareUrl,
    createFleetShare,
    loadExternalFleetData,
    loadExternalFleets,
    openFleetShareModal,
    openImportFleetModal,
    refreshExternalFleet,
    removeExternalFleet,
    revokeFleetShare,
    submitImportFleet,
  });
  global.MultiCCFleetSharing = Object.freeze({
    apiUrlForDirectory,
    adaptWorkspaceMessage,
    ensureInteractiveSession,
    externalDirectory: id => externalDirectories.get(id) || null,
    externalSession: id => externalSessions.get(id) || null,
    externalSessionPageUrl,
    externalWorkspaceWsUrl,
    sessionPageUrl,
    sessionSubtitle,
    sessionIdForRemote,
    workspaceWsUrl,
    parseWorkspaceMessage,
  });
})(window);
