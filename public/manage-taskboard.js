'use strict';

// Task board widget for the directory-detail modal (manage.html).
// Renders the AI-tagged module→task tree inside #dir-detail-body and a
// stacked task-detail modal (#tb-detail-modal) with the cross-session
// conversation trail plus the panel-level composer that auto-routes.
//
// Self-contained: own fetch/cache/escape helpers, no load-order dependency
// on manage-dashboard.js beyond being called from renderDirectoryDetailBody.

let _tbBoard = { modules: [], tasks: [], sessionLabels: {} };
let _tbFetchedAt = 0;
let _tbTimer = null;
const _tbCollapsed = new Set();     // module ids collapsed in the tree
let _tbDetailTaskId = null;

const _tbEsc = (s) => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function _tbTimeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  return `${Math.floor(s / 86400)}天前`;
}

async function refreshTaskBoard(force) {
  if (!force && Date.now() - _tbFetchedAt < 3000) return;   // debounce bursts
  try {
    const r = await fetch('/api/task-board');
    const d = await r.json();
    if (!d || !d.ok) return;
    _tbBoard = d;
    _tbFetchedAt = Date.now();
    // Re-render wherever the board is currently visible.
    if (typeof _detailModalOpen === 'function' && _detailModalOpen()
        && typeof renderDirectoryDetailBody === 'function') {
      renderDirectoryDetailBody(_detailDirId);
    }
    if (_tbDetailTaskId) loadTaskBoardDetail(_tbDetailTaskId, true);
  } catch (_) {}
}

// Debounced entry point for WS task_board_update events (manage.js).
function onTaskBoardUpdate() {
  clearTimeout(_tbTimer);
  _tbTimer = setTimeout(() => refreshTaskBoard(true), 400);
}

// Tasks that belong to a directory: any turn ref recorded in it, or the
// module anchored there (covers fresh tasks whose refs lost dirId).
function _tbTasksForDir(dirId) {
  const modDir = new Map(_tbBoard.modules.map(m => [m.id, m.dirId]));
  return _tbBoard.tasks.filter(t => t.status !== 'archived'
    && ((t.dirIds || []).includes(dirId) || modDir.get(t.moduleId) === dirId));
}

// Synchronous section HTML for renderDirectoryDetailBody (data from cache;
// openDirectoryDetail triggers the async refresh). With {tabbed:true} the
// board fills its own tab, so the section chrome (border + "任务板" head that
// would duplicate the tab label) is dropped.
function renderTaskBoardSection(dirId, opts) {
  const tasks = _tbTasksForDir(dirId);
  const rowsHtml = [];
  const byModule = new Map();
  for (const t of tasks) {
    if (!byModule.has(t.moduleId)) byModule.set(t.moduleId, []);
    byModule.get(t.moduleId).push(t);
  }
  const mods = _tbBoard.modules.filter(m => byModule.has(m.id));
  for (const mod of mods) {
    const list = byModule.get(mod.id);
    const collapsed = _tbCollapsed.has(mod.id);
    rowsHtml.push(`
      <div class="tb-mod" onclick="toggleTaskBoardModule('${_tbEsc(mod.id)}')">
        <span>${collapsed ? '▸' : '▾'} <b>${_tbEsc(mod.name)}</b> · ${list.length}</span>
        <span class="tb-dim">${_tbEsc(_tbTimeAgo(mod.lastTs))}</span>
      </div>`);
    if (collapsed) continue;
    for (const t of list) {
      rowsHtml.push(`
        <div class="tb-task${t.status === 'done' ? ' done' : ''}" onclick="openTaskBoardDetail('${_tbEsc(t.id)}')">
          <span class="tb-dot"></span>
          <span class="tb-title">${_tbEsc(t.title)}</span>
          <span class="tb-dim">${t.refCount}轮 · ${_tbEsc(_tbTimeAgo(t.lastTs))}</span>
        </div>`);
    }
  }
  // Orphans (module list pruned or filtered out) still need to be reachable.
  const seen = new Set(mods.map(m => m.id));
  for (const t of tasks.filter(x => !seen.has(x.moduleId))) {
    rowsHtml.push(`
      <div class="tb-task${t.status === 'done' ? ' done' : ''}" onclick="openTaskBoardDetail('${_tbEsc(t.id)}')">
        <span class="tb-dot"></span>
        <span class="tb-title">${_tbEsc(t.title)}</span>
        <span class="tb-dim">${t.refCount}轮</span>
      </div>`);
  }
  const body = rowsHtml.length
    ? rowsHtml.join('')
    : '<div class="tb-empty">还没有任务。对话结束后由 AI 自动归档到这里。</div>';
  if (opts && opts.tabbed) {
    const stat = tasks.length
      ? `<div class="tb-stat">${mods.length || 1} 模块 · ${tasks.length} 任务</div>` : '';
    return `<div class="tb-section tb-tabbed">${stat}${body}</div>`;
  }
  return `
    <div class="tb-section">
      <div class="tb-section-head">📋 任务板 <span class="tb-dim">${tasks.length ? `${mods.length || 1} 模块 · ${tasks.length} 任务` : ''}</span></div>
      ${body}
    </div>`;
}

function toggleTaskBoardModule(modId) {
  if (event) event.stopPropagation();
  _tbCollapsed.has(modId) ? _tbCollapsed.delete(modId) : _tbCollapsed.add(modId);
  if (typeof renderDirectoryDetailBody === 'function' && typeof _detailDirId !== 'undefined' && _detailDirId) {
    renderDirectoryDetailBody(_detailDirId);
  }
}

// ── Task detail modal (stacked above dir-detail) ────────────────────────────

function openTaskBoardDetail(taskId) {
  if (event) event.stopPropagation();
  _tbDetailTaskId = taskId;
  const m = document.getElementById('tb-detail-modal');
  if (m) m.classList.add('visible');
  const body = document.getElementById('tb-detail-content');
  if (body) body.innerHTML = '<div class="tb-empty">加载中…</div>';
  loadTaskBoardDetail(taskId);
}

function closeTaskBoardDetail() {
  _tbDetailTaskId = null;
  const m = document.getElementById('tb-detail-modal');
  if (m) m.classList.remove('visible');
}

async function loadTaskBoardDetail(taskId, silent) {
  let d;
  try {
    const r = await fetch(`/api/task-board/tasks/${encodeURIComponent(taskId)}/messages`);
    d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || r.status);
  } catch (e) {
    if (!silent) {
      const body = document.getElementById('tb-detail-content');
      if (body) body.innerHTML = `<div class="tb-empty">加载失败：${_tbEsc(e.message)}</div>`;
    }
    return;
  }
  if (_tbDetailTaskId !== taskId) return;
  const content = document.getElementById('tb-detail-content');
  if (!content) return;
  const prevScroll = content.querySelector('.tb-msgs')?.scrollTop;
  const prevInput = content.querySelector('#tb-input')?.value;
  renderTaskBoardDetail(d);
  const msgsBox = content.querySelector('.tb-msgs');
  if (msgsBox) msgsBox.scrollTop = prevScroll != null ? prevScroll : msgsBox.scrollHeight;
  if (prevInput) content.querySelector('#tb-input').value = prevInput;
}

function renderTaskBoardDetail(d) {
  const content = document.getElementById('tb-detail-content');
  const t = d.task;
  const mod = _tbBoard.modules.find(m => m.id === t.moduleId);
  const labels = _tbBoard.sessionLabels || {};

  const chips = t.sessionIds.map(sid => `<span class="tb-chip">🖥 ${_tbEsc(labels[sid] || sid)}</span>`)
    .concat((t.areas || []).map(a => `<span class="tb-chip">${_tbEsc(a)}</span>`)).join('');

  const msgs = (d.items || []).map(it => {
    const time = it.ts ? new Date(it.ts).toLocaleString('zh-CN', { hour12: false }) : '?';
    return `
      <div class="tb-msg ${it.role}">
        <div class="tb-msg-head">
          <span class="tb-msg-sess">${_tbEsc(it.sessionLabel || it.sessionId)}</span>
          <span>${_tbEsc(time)}</span>
          <span class="tb-msg-role-${it.role}">${it.role === 'user' ? '👤 用户' : '🤖 助手'}</span>
          ${it.lost ? '<span style="color:var(--danger)">（原消息已清理，仅存摘要）</span>' : ''}
        </div>
        <div class="tb-msg-body"></div>
      </div>`;
  }).join('') || '<div class="tb-empty">该任务还没有关联对话。</div>';

  const targetOptions = ['<option value="">🎯 自动路由</option>']
    .concat(t.sessionIds.map(sid => `<option value="${_tbEsc(sid)}">${_tbEsc(labels[sid] || sid)}</option>`)).join('');

  content.innerHTML = `
    <div class="tb-d-head">
      <div class="tb-dim">${_tbEsc(mod ? mod.name : '未分组')} ›</div>
      <div class="tb-d-title-row">
        <span class="tb-d-title">${_tbEsc(t.title)}</span>
        <span class="tb-badge${t.status === 'active' ? ' on' : ''}">${t.status === 'active' ? '进行中' : t.status === 'done' ? '已完成' : '已归档'}</span>
        <span class="tb-d-actions">
          ${t.status === 'active'
            ? `<button class="btn btn-sm" onclick="setTaskBoardStatus('${_tbEsc(t.id)}','done')">✅ 完成</button>`
            : `<button class="btn btn-sm" onclick="setTaskBoardStatus('${_tbEsc(t.id)}','active')">♻️ 重开</button>`}
          <button class="btn btn-sm" onclick="if(confirm('归档该任务？（从任务板隐藏，数据保留）'))setTaskBoardStatus('${_tbEsc(t.id)}','archived')">🗄 归档</button>
        </span>
      </div>
      <div class="tb-chips">${chips}</div>
    </div>
    <div class="tb-msgs">${msgs}</div>
    <div class="tb-compose">
      <textarea id="tb-input" placeholder="向该任务派发后续消息…（不接入任何会话，发送时自动路由到合适的会话）"></textarea>
      <div class="tb-compose-row">
        <select id="tb-target">${targetOptions}</select>
        <button class="btn btn-sm" id="tb-send" onclick="sendTaskBoardMessage('${_tbEsc(t.id)}')">🚀 发送</button>
        <span class="tb-result" id="tb-result"></span>
      </div>
    </div>`;

  // Message bodies as textContent (never trust chat text as HTML).
  const bodies = content.querySelectorAll('.tb-msg-body');
  (d.items || []).forEach((it, i) => { if (bodies[i]) bodies[i].textContent = it.text || '（空）'; });
}

async function setTaskBoardStatus(taskId, status) {
  if (event) event.stopPropagation();
  try {
    const r = await fetch(`/api/task-board/tasks/${encodeURIComponent(taskId)}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);
    if (status === 'archived') closeTaskBoardDetail();
    else loadTaskBoardDetail(taskId, true);
    refreshTaskBoard(true);
  } catch (e) {
    if (typeof showToast === 'function') showToast(`操作失败：${e.message}`, true);
  }
}

async function sendTaskBoardMessage(taskId) {
  const input = document.getElementById('tb-input');
  const resultEl = document.getElementById('tb-result');
  const btn = document.getElementById('tb-send');
  const text = (input?.value || '').trim();
  if (!text) { if (resultEl) { resultEl.textContent = '请输入内容'; resultEl.className = 'tb-result err'; } return; }
  if (btn) btn.disabled = true;
  if (resultEl) { resultEl.textContent = '路由中…'; resultEl.className = 'tb-result'; }
  try {
    const target = document.getElementById('tb-target')?.value || undefined;
    const r = await fetch(`/api/task-board/tasks/${encodeURIComponent(taskId)}/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, target }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.note || d.error || r.status);
    if (resultEl) {
      resultEl.textContent = `已路由到「${d.targetLabel}」，回复将自动归档回本任务`;
      resultEl.className = 'tb-result ok';
    }
    if (input) input.value = '';
    setTimeout(() => refreshTaskBoard(true), 1500);
  } catch (e) {
    if (resultEl) { resultEl.textContent = String(e.message); resultEl.className = 'tb-result err'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Periodic reconciliation while a board surface is visible (WS loss fallback).
setInterval(() => {
  const modalOpen = typeof _detailModalOpen === 'function' && _detailModalOpen();
  if (modalOpen || _tbDetailTaskId) refreshTaskBoard(true);
}, 60000);
refreshTaskBoard(true);
