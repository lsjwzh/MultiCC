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
let _tbGatheringFloat = null;       // 归拢中浮窗 DOM
let _tbPendingTaskIds = [];         // 等待定位的新任务 id

const _tbEsc = (s) => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Status glyph for a task row. Delegates to the shared registry so the icon,
// tone and "may it animate" policy are the same here, on the fleet cards, in the
// chat bars and in the app — and so an errored task always renders ❌ with an
// accessible name instead of a bare colour.
function _tbStatusIcon(display) {
  return window.MultiCCStatusPresentation.statusBadgeHtml('task', display.status, {
    translate: window.t,
    showLabel: false,
    className: 'tb-icon',
  });
}

function _tbTimeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  return `${Math.floor(s / 86400)}天前`;
}

function _tbModuleAssignmentHtml(task) {
  const assignment = task && task.moduleAssignment;
  if (!assignment) return '';
  const title = assignment.lastError ? ` title="${_tbEsc(assignment.lastError)}"` : '';
  const label = assignment.running ? '归类中…' : assignment.lastError ? '重新归类' : '归类';
  return `<button class="btn btn-sm tb-reclassify" onclick="reclassifyTaskBoardTask(event,'${_tbEsc(task.id)}')"${assignment.running ? ' disabled' : ''}${title}>${label}</button>`;
}

function _tbQuickArchiveHtml(task) {
  return `<button class="btn btn-sm tb-quick-archive" onclick="archiveTaskBoardTask(event,'${_tbEsc(task.id)}',this)" title="快捷归档该任务">归档</button>`;
}

function _tbRoutingHtml(task) {
  const label = window.MultiCCTaskBoardUi.taskRoutingLabel(task);
  return label ? `<span class="tb-route-state">🫡 ${_tbEsc(label)}</span>` : '';
}

async function refreshTaskBoard(force) {
  if (!force && Date.now() - _tbFetchedAt < 3000) return;   // debounce bursts
  try {
    const r = await fetch('/api/task-board');
    const d = await r.json();
    if (!d || !d.ok) return;
    _tbBoard = window.MultiCCTaskBoardUi.reconcileSnapshot(d);
    _tbFetchedAt = Date.now();
    // Re-render wherever the board is currently visible.
    if (typeof _detailModalOpen === 'function' && _detailModalOpen()
        && typeof renderDirectoryDetailBody === 'function') {
      renderDirectoryDetailBody(_detailDirId);
    }
    if (_tbDetailTaskId) loadTaskBoardDetail(_tbDetailTaskId, true);
    // 刷新后定位新任务（若有待定位的）
    if (_tbPendingTaskIds.length) {
      const tid = _tbPendingTaskIds[0];
      _tbPendingTaskIds = [];
      setTimeout(() => _tbScrollToTask(tid), 100);
    }
  } catch (_) {}
}

// Debounced entry point for WS task_board_update events (manage.js).
// evt = { type:'task_board_update', taskIds:[], kind?:'created' }
function onTaskBoardUpdate(evt) {
  clearTimeout(_tbTimer);
  if (evt && evt.kind === 'created' && evt.taskIds && evt.taskIds.length) {
    _tbPendingTaskIds = evt.taskIds;
    _tbHideGatheringFloat();
  }
  _tbTimer = setTimeout(() => refreshTaskBoard(true), 400);
}

// Tasks that belong to a directory: any turn ref recorded in it, or the
// module anchored there (covers fresh tasks whose refs lost dirId).
function _tbTasksForDir(dirId) {
  const modDir = new Map(_tbBoard.modules.map(m => [m.id, m.dirId]));
  return _tbBoard.tasks.filter(t => t.status !== 'archived'
    && ((t.dirIds || []).includes(dirId) || modDir.get(t.moduleId) === dirId));
}

function _tbTaskRowHtml(task) {
  const display = window.MultiCCTaskBoardUi.taskDisplayState(task);
  const clsRun = display.running ? ' running' : '';
  const attempt = Number(task.attemptCount) > 1
    ? `<span class="tb-dim">${Number(task.attemptCount)} 次投递</span>` : '';
  const body = task.body
    ? `<details class="tb-body-fold" onclick="event.stopPropagation()"><summary>任务正文</summary><pre>${_tbEsc(task.body)}</pre></details>`
    : task.identityState === 'orphaned_admission' || task.identityState === 'legacy_unresolved'
      ? '<span class="tb-body-pending">旧记录缺少 canonical 正文，未自动合并</span>'
      : '<span class="tb-body-pending">正文等待目标会话持久化…</span>';
  return `
    <div class="tb-task${display.done ? ' done' : ''}${clsRun}" data-task-id="${_tbEsc(task.id)}" title="在聊天视图中打开" onclick="openTaskChatView('${_tbEsc(task.id)}')">
      ${_tbStatusIcon(display)}
      <span class="tb-title-cell">
        <span class="tb-title">${_tbEsc(task.title)}</span>
        ${body}
      </span>
      <span class="tb-task-meta"><span class="tb-run-state st-tone-${display.tone}">${_tbEsc(display.label)}</span>${_tbRoutingHtml(task)}${attempt}${_tbModuleAssignmentHtml(task)}${_tbQuickArchiveHtml(task)}<span class="tb-dim">${task.refCount}轮 · ${_tbEsc(_tbTimeAgo(task.lastTs))}</span></span>
    </div>`;
}

// Synchronous section HTML for renderDirectoryDetailBody (data from cache;
// openDirectoryDetail triggers the async refresh). With {tabbed:true} the
// board fills its own tab, so the section chrome (border + "任务板" head that
// would duplicate the tab label) is dropped.
function renderTaskBoardSection(dirId, opts) {
  const tasks = _tbTasksForDir(dirId);
  const completedCount = tasks.filter(t =>
    window.MultiCCTaskBoardUi.taskDisplayState(t).done).length;
  const cleanupButton = `<button class="btn btn-sm tb-clean-completed" onclick="archiveCompletedTaskBoard(event,'${_tbEsc(dirId)}',this)" title="归档全部已完成任务"${completedCount ? '' : ' disabled'}>🧹 一键清理${completedCount ? ` (${completedCount})` : ''}</button>`;
  const rowsHtml = [];
  const byModule = new Map();
  for (const t of tasks) {
    if (!byModule.has(t.moduleId)) byModule.set(t.moduleId, []);
    byModule.get(t.moduleId).push(t);
  }
  const mods = window.MultiCCTaskBoardUi.sortModules(
    _tbBoard.modules.filter(m => byModule.has(m.id)),
  );
  for (const mod of mods) {
    const list = window.MultiCCTaskBoardUi.sortTasks(byModule.get(mod.id));
    const identity = window.MultiCCTaskBoardUi.partitionTaskIdentity(list);
    const collapsed = _tbCollapsed.has(mod.id);
    const batch = mod.source === 'classify'
      ? `<button class="btn btn-sm tb-reclassify-all" onclick="reclassifyPendingTaskBoard(event,'${_tbEsc(dirId)}')">全部重新归类</button>`
      : '';
    rowsHtml.push(`
      <div class="tb-mod" onclick="toggleTaskBoardModule('${_tbEsc(mod.id)}')">
        <span>${collapsed ? '▸' : '▾'} <b>${_tbEsc(mod.name)}</b> · ${list.length}</span>
        <span class="tb-mod-actions">${batch}<span class="tb-dim">${_tbEsc(_tbTimeAgo(mod.lastTs))}</span></span>
      </div>`);
    if (collapsed) continue;
    for (const task of identity.canonical) rowsHtml.push(_tbTaskRowHtml(task));
    if (identity.unresolved.length) {
      rowsHtml.push(`<details class="tb-legacy-group" onclick="event.stopPropagation()">
        <summary>历史身份待确认 · ${identity.unresolved.length}（未自动合并）</summary>
        ${identity.unresolved.map(_tbTaskRowHtml).join('')}
      </details>`);
    }
  }
  // Orphans (module list pruned or filtered out) still need to be reachable.
  const seen = new Set(mods.map(m => m.id));
  for (const task of window.MultiCCTaskBoardUi.sortTasks(tasks.filter(x => !seen.has(x.moduleId)))) {
    rowsHtml.push(_tbTaskRowHtml(task));
  }
  const body = rowsHtml.length
    ? rowsHtml.join('')
    : '<div class="tb-empty">还没有任务。从任务面板或 Commander 发起新任务后会显示在这里。</div>';
  if (opts && opts.tabbed) {
    const stat = `<div class="tb-stat" style="display:flex;align-items:center;justify-content:space-between;gap:8px">
      <span>${tasks.length ? `${mods.length || 1} 模块 · ${tasks.length} 任务` : '暂无任务'}</span>
      <span>${cleanupButton}<button class="btn-icon" onclick="event.stopPropagation();refreshTaskBoard(true)" title="刷新任务板" style="margin-left:8px">🔄</button></span>
    </div>`;
    return `<div class="tb-section tb-tabbed">${stat}${body}</div>`;
  }
  return `
    <div class="tb-section">
      <div class="tb-section-head">
        <span>📋 任务板 <span class="tb-dim">${tasks.length ? `${mods.length || 1} 模块 · ${tasks.length} 任务` : ''}</span></span>
        ${cleanupButton}
      </div>
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

// ── Composer (chat-parity input: attach/paste, voice, goal) ─────────────────
// One factory used by both the board-tab composer (dir-level routing) and the
// task-detail composer (task-level routing). Fire-and-forget by design: no
// streaming/cancel state — a sent message is sent.
//
// Feature parity with the chat composer:
//   attach/paste → POST /api/upload (FormData 'file') → absolute path appended
//   to the message text (same convention the chat composer uses);
//   voice → MediaRecorder → POST /api/voice/stt → transcript into the input;
//   goal → goal:true + goalLimits{maxRounds,maxBudget}, note prepended
//   server-side via buildGoalLimitNote (byte-equal to chat's goal mode).

function createTbComposer(host, opts) {
  host.innerHTML = `
    <div class="tb-compose">
      <div class="tb-chiprow" style="display:none"></div>
      <textarea class="tb-input" placeholder="${_tbEsc(opts.placeholder || '输入消息…（支持粘贴图片/文件，Enter 发送，Shift+Enter 换行）')}"></textarea>
      <div class="tb-goalrow" style="display:none">
        <span class="tb-dim">🎯 Goal 模式</span>
        <label class="tb-dim">轮次上限 <input type="number" class="tb-goal-rounds" value="200" min="0" max="200"></label>
        <label class="tb-dim">token 预算 <input type="number" class="tb-goal-budget" step="1000" min="0" placeholder="不限"></label>
      </div>
      <div class="tb-compose-row">
        <button class="btn btn-sm tb-attach-btn" title="上传图片/文件">📎</button>
        <button class="btn btn-sm tb-mic-btn" title="语音输入">🎙</button>
        <button class="btn btn-sm tb-goal-btn" title="以 Goal 模式发送（自主任务，带轮次/预算上限）">🎯</button>
        <button class="btn btn-sm tb-send-btn">🚀 发送</button>
        <span class="tb-result"></span>
      </div>
      ${opts.hint ? `<div class="tb-dim" style="margin-top:4px">${_tbEsc(opts.hint)}</div>` : ''}
      <input type="file" multiple hidden class="tb-file-input">
    </div>`;
  const $q = (sel) => host.querySelector(sel);
  const input = $q('.tb-input');
  const chiprow = $q('.tb-chiprow');
  const sendBtn = $q('.tb-send-btn');
  const micBtn = $q('.tb-mic-btn');
  const goalBtn = $q('.tb-goal-btn');
  const goalRow = $q('.tb-goalrow');
  const fileInput = $q('.tb-file-input');
  const resultEl = $q('.tb-result');
  let pendingClientMsgId = '';
  let pendingText = '';

  const setResult = (text, cls) => { resultEl.textContent = text || ''; resultEl.className = 'tb-result' + (cls ? ' ' + cls : ''); };

  // Attachments — upload immediately, keep the returned path on a chip.
  async function uploadFile(file) {
    const chip = document.createElement('span');
    chip.className = 'tb-fchip';
    chip.textContent = `⏳ ${file.name || '文件'}`;
    chiprow.style.display = '';
    chiprow.appendChild(chip);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name || 'pasted');
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok || !d.path) throw new Error(d.error || r.status);
      chip.dataset.path = d.path;
      chip.textContent = `📄 ${d.name || file.name}`;
      const x = document.createElement('span');
      x.className = 'tb-fchip-x';
      x.textContent = ' ✕';
      x.onclick = () => { chip.remove(); if (!chiprow.children.length) chiprow.style.display = 'none'; };
      chip.appendChild(x);
    } catch (e) {
      chip.textContent = `⚠️ ${file.name || '文件'} 上传失败`;
      setTimeout(() => { chip.remove(); if (!chiprow.children.length) chiprow.style.display = 'none'; }, 3000);
    }
  }
  $q('.tb-attach-btn').onclick = () => fileInput.click();
  fileInput.onchange = () => { for (const f of fileInput.files) uploadFile(f); fileInput.value = ''; };
  input.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) { e.preventDefault(); for (const f of files) uploadFile(f); }
  });

  // Voice — simplest press-to-toggle MediaRecorder → one-shot STT.
  let recorder = null;
  let recChunks = [];
  micBtn.onclick = async () => {
    if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (_) { setResult('无法访问麦克风', 'err'); return; }
    recChunks = [];
    const mime = window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : undefined;
    try { recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
    catch (_) { stream.getTracks().forEach(t => t.stop()); setResult('浏览器不支持录音', 'err'); return; }
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      micBtn.classList.remove('rec');
      const blob = new Blob(recChunks, { type: 'audio/webm' });
      if (!blob.size) return;
      setResult('转写中…');
      try {
        const fd = new FormData();
        fd.append('file', blob, 'recording.webm');
        const r = await fetch('/api/voice/stt', { method: 'POST', body: fd });
        const d = await r.json();
        if (!r.ok || !d.text) throw new Error(d.error || '无转写结果');
        input.value = input.value ? `${input.value} ${d.text.trim()}` : d.text.trim();
        input.focus();
        setResult('');
      } catch (e) { setResult(`转写失败：${e.message}`, 'err'); }
    };
    recorder.start();
    micBtn.classList.add('rec');
    setResult('录音中，点 🎙 结束…');
  };

  // Goal toggle — show the limits row while armed.
  goalBtn.onclick = () => {
    const on = goalBtn.classList.toggle('on');
    goalRow.style.display = on ? '' : 'none';
  };

  async function doSend() {
    let text = input.value.trim();
    const paths = [...chiprow.querySelectorAll('.tb-fchip[data-path]')].map(c => c.dataset.path);
    if (paths.length) text = (text ? text + ' ' : '') + paths.join(' ');
    if (!text) { setResult('请输入内容', 'err'); return; }
    const payload = { text };
    if (!pendingClientMsgId || pendingText !== text) {
      pendingClientMsgId = window.crypto?.randomUUID
        ? window.crypto.randomUUID()
        : `tb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      pendingText = text;
    }
    payload.clientMsgId = pendingClientMsgId;
    if (goalBtn.classList.contains('on')) {
      payload.goal = true;
      payload.goalLimits = {};
      const rounds = $q('.tb-goal-rounds').value;
      const budget = $q('.tb-goal-budget').value;
      if (rounds !== '') payload.goalLimits.maxRounds = rounds;
      if (budget !== '') payload.goalLimits.maxBudget = budget;
    }
    sendBtn.disabled = true;
    setResult('路由中…');
    try {
      const okText = await opts.submit(payload);
      setResult(okText || '已发送', 'ok');
      input.value = '';
      chiprow.innerHTML = '';
      chiprow.style.display = 'none';
      pendingClientMsgId = '';
      pendingText = '';
    } catch (e) { setResult(String(e.message || e), 'err'); }
    finally { sendBtn.disabled = false; }
  }
  sendBtn.onclick = doSend;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); }
  });

  return {
    reset() {
      input.value = '';
      chiprow.innerHTML = '';
      chiprow.style.display = 'none';
      pendingClientMsgId = '';
      pendingText = '';
      setResult('');
    },
    focus() { input.focus(); },
  };
}

// Board-tab composer (dir-level routing) — lives in the static #tb-dir-composer
// container so WS-driven re-renders of #dir-detail-body never wipe its state.
let _tbDirComposer = null;
let _tbDirComposerDirId = null;

function syncTaskBoardDirComposer(dirId, visible) {
  const host = document.getElementById('tb-dir-composer');
  if (!host) return;
  host.style.display = visible ? '' : 'none';
  if (!visible) return;
  _tbDirComposerDirId = dirId;
  if (!_tbDirComposer) {
    _tbDirComposer = createTbComposer(host, {
    placeholder: '向该 Fleet 派发消息…（Commander 单向路由到空闲 worker）',
      submit: async (payload) => {
        const r = await fetch('/api/task-board/send', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, dirId: _tbDirComposerDirId }),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.note || d.error || r.status);
        if (d.taskId) _tbPendingTaskIds = [d.taskId];
        await refreshTaskBoard(true);
        return d.taskRunId || d.routingMode === 'commander'
          ? `已创建「新任务」并交给 Commander「${d.commanderLabel || d.targetLabel}」${d.queued ? '（已安全排队）' : ''}`
          : `已创建「新任务」并路由到「${d.targetLabel}」`;
      },
    });
  }
}

// ── Task detail modal (stacked above dir-detail) ────────────────────────────

let _tbTaskComposer = null;
let _tbTaskComposerTaskId = null;

function _tbEnsureTaskComposer(task) {
  const host = document.getElementById('tb-task-composer');
  if (!host) return;
  if (!_tbTaskComposer) {
    _tbTaskComposer = createTbComposer(host, {
      placeholder: '向该任务派发后续消息…（Commander 单向路由到空闲 worker）',
      submit: async (payload) => {
        const r = await fetch(`/api/task-board/tasks/${encodeURIComponent(_tbTaskComposerTaskId)}/send`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.note || d.error || r.status);
        _tbShowGatheringFloat();
        setTimeout(() => refreshTaskBoard(true), 1500);
        if (d.taskRunId || d.routingMode === 'commander') {
          const commanderLabel = d.commanderLabel || d.targetLabel;
          const worker = d.workerLabel || d.workerSessionId;
          return worker
            ? `已由 Commander「${commanderLabel}」单向路由到「${worker}」${d.elasticWorkerCreated ? '（已动态增加 worker）' : d.queued ? '（已安全排队）' : ''}`
            : `已交给 Commander「${commanderLabel}」路由执行${d.queued ? '（已安全排队）' : ''}，回复将自动归档回本任务`;
        }
        return `已路由到「${d.targetLabel}」，回复将自动归档回本任务`;
      },
    });
  }
  if (_tbTaskComposerTaskId !== task.id) _tbTaskComposer.reset();
  _tbTaskComposerTaskId = task.id;
}

// M2 · the default task entry: the unified chat view in a new tab (the same
// window.open pattern manage.js uses for chat sessions). The stacked modal
// below stays mounted for now (M4 retires it).
function openTaskChatView(taskId) {
  if (event) event.stopPropagation();
  window.open(`/chat.html?task=${encodeURIComponent(taskId)}`, '_blank');
}

/** @deprecated (M2, design D3): task rows now open the unified chat view
 *  (chat.html?task=). This stacked modal has no default entry left and is
 *  retired in M4 — kept reachable for that transition only. */
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
  renderTaskBoardDetail(d);
  const msgsBox = content.querySelector('.tb-msgs');
  if (msgsBox) msgsBox.scrollTop = prevScroll != null ? prevScroll : msgsBox.scrollHeight;
}

function renderTaskBoardDetail(d) {
  const content = document.getElementById('tb-detail-content');
  const t = d.task;
  const mod = _tbBoard.modules.find(m => m.id === t.moduleId);
  const labels = _tbBoard.sessionLabels || {};
  const display = window.MultiCCTaskBoardUi.taskDisplayState(t);

  const chips = t.sessionIds.map(sid => {
    const href = window.MultiCCTaskBoardUi.sessionChatUrl(sid);
    return `<a class="tb-chip tb-session-link" href="${_tbEsc(href)}" target="_blank" rel="noopener noreferrer" title="在新标签打开对应会话">🖥 ${_tbEsc(labels[sid] || sid)} ↗</a>`;
  });
  const routingLabel = window.MultiCCTaskBoardUi.taskRoutingLabel(t);
  if (routingLabel) chips.unshift(`<span class="tb-chip tb-route-state">🫡 ${_tbEsc(routingLabel)}</span>`);
  const chipHtml = chips
    .concat((t.areas || []).map(a => `<span class="tb-chip">${_tbEsc(a)}</span>`)).join('');

  const msgs = (d.items || []).map(it => {
    const time = it.ts ? new Date(it.ts).toLocaleString('zh-CN', { hour12: false }) : '?';
    const sessionHref = window.MultiCCTaskBoardUi.sessionChatUrl(it.sessionId, it.messageId);
    const tag = sessionHref ? 'a' : 'div';
    const linkAttrs = sessionHref
      ? ` href="${_tbEsc(sessionHref)}" target="_blank" rel="noopener noreferrer" title="打开会话并定位到这条消息"`
      : '';
    return `
      <${tag} class="tb-msg ${it.role}${sessionHref ? ' tb-msg-link' : ''}"${linkAttrs}>
        <div class="tb-msg-head">
          <span class="tb-msg-sess">${_tbEsc(it.sessionLabel || it.sessionId || '临时执行')}${sessionHref ? ' ↗' : ''}</span>
          <span>${_tbEsc(time)}</span>
          <span class="tb-msg-role-${it.role}">${it.role === 'user' ? '👤 用户' : '🤖 助手'}</span>
          ${it.lost ? '<span style="color:var(--danger)">（原消息已清理，仅存摘要）</span>' : ''}
        </div>
        <div class="tb-msg-body"></div>
      </${tag}>`;
  }).join('') || '<div class="tb-empty">该任务还没有关联对话。</div>';

  const recentRuns = window.MultiCCTaskBoardUi.recentTaskRuns(d);
  const runHistory = recentRuns.length
    ? `<details class="tb-run-history" data-testid="task-run-history" open>
        <summary>最近执行 · ${recentRuns.length}</summary>
        <div class="tb-run-history-list">${recentRuns
          .map(run => window.MultiCCTaskBoardUi.renderTaskRunSummary(run)).join('')}</div>
      </details>`
    : '';

  content.innerHTML = `
    <div class="tb-d-head">
      <div class="tb-dim">${_tbEsc(mod ? mod.name : '未分组')} ›</div>
      <div class="tb-d-title-row">
        <span class="tb-d-title">${_tbEsc(t.title)}</span>
        ${window.MultiCCStatusPresentation.statusBadgeHtml('task', display.status, {
          translate: window.t,
          className: `tb-badge${display.running ? ' on' : ''}`,
        })}
        <span class="tb-d-actions">
          ${t.moduleAssignment
            ? `<button class="btn btn-sm" onclick="reclassifyTaskBoardTask(event,'${_tbEsc(t.id)}')"${t.moduleAssignment.running ? ' disabled' : ''}>🔄 ${t.moduleAssignment.running ? '归类中…' : t.moduleAssignment.lastError ? '重新归类' : '归类'}</button>`
            : ''}
          ${t.status !== 'active'
            ? `<button class="btn btn-sm" onclick="setTaskBoardStatus('${_tbEsc(t.id)}','active',event)">♻️ 重开</button>`
            : `<button class="btn btn-sm" onclick="setTaskBoardStatus('${_tbEsc(t.id)}','done',event)">✅ 完成</button>`}
          ${t.worktreePath
            ? `<button class="btn btn-sm" title="把任务分支合并回基分支并删除任务 worktree（运行中的任务会被拒绝）" onclick="cleanupTaskWorktree(event,'${_tbEsc(t.id)}',this)">🧹 清理 worktree</button>`
            : ''}
          <button class="btn btn-sm" onclick="archiveTaskBoardTask(event,'${_tbEsc(t.id)}',this)">🗄 归档</button>
        </span>
      </div>
      <div class="tb-chips">${chipHtml}</div>
      ${t.body ? `<details class="tb-body-detail"><summary>${t.legacy ? '旧记录任务正文' : '完整任务正文'}</summary><pre>${_tbEsc(t.body)}</pre></details>` : '<div class="tb-body-pending">正文尚未进入目标会话历史。</div>'}
    </div>
    ${runHistory}
    <div class="tb-msgs">${msgs}</div>`;

  // Message bodies as textContent (never trust chat text as HTML).
  const bodies = content.querySelectorAll('.tb-msg-body');
  (d.items || []).forEach((it, i) => { if (bodies[i]) bodies[i].textContent = it.text || '（空）'; });

  window.MultiCCTaskBoardUi.bindPendingQuestionAnswers(content, async payload => {
    const response = await fetch(`/api/task-board/tasks/${encodeURIComponent(t.id)}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || response.status);
    setTimeout(() => {
      if (_tbDetailTaskId === t.id) loadTaskBoardDetail(t.id, true);
      refreshTaskBoard(true);
    }, 0);
    return result;
  });

  // Composer lives outside the re-rendered content, so refreshes never wipe
  // a half-typed message or an in-progress recording.
  _tbEnsureTaskComposer(t);
}

async function setTaskBoardStatus(taskId, status, ev) {
  if (ev) ev.stopPropagation();
  try {
    const r = await fetch(`/api/task-board/tasks/${encodeURIComponent(taskId)}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);
    if (status === 'archived') closeTaskBoardDetail();
    else loadTaskBoardDetail(taskId, true);
    refreshTaskBoard(true);
    return true;
  } catch (e) {
    if (typeof showToast === 'function') showToast(`操作失败：${e.message}`, true);
    return false;
  }
}

// M3 · one-click task worktree cleanup (D2): merge the task branch back, then
// remove the worktree and clear the ledger fields. Each server-side step is
// idempotent; a refusal (run active, conflicts, dirty tree) leaves everything
// untouched and tells the user why.
async function cleanupTaskWorktree(ev, taskId, button) {
  if (ev) ev.stopPropagation();
  if (!confirm('把任务分支合并回基分支并删除任务 worktree？（正在执行的任务会被拒绝）')) return;
  if (button) button.disabled = true;
  try {
    const r = await fetch(`/api/task-board/tasks/${encodeURIComponent(taskId)}/cleanup-worktree`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      const notes = {
        run_active: '任务正在执行，结束后再清理',
        merge_failed: '合并失败：请先在任务 chat 中处理冲突再试',
        worktree_remove_refused: 'worktree 有未提交或未合并改动，已安全拒绝',
      };
      throw new Error(notes[d.code] || d.error || d.code || r.status);
    }
    if (typeof showToast === 'function') {
      showToast(d.merged ? '已合并并清理任务 worktree' : '无新提交，worktree 已清理');
    }
    setTimeout(() => {
      if (_tbDetailTaskId === taskId) loadTaskBoardDetail(taskId, true);
      refreshTaskBoard(true);
    }, 0);
  } catch (e) {
    if (typeof showToast === 'function') showToast(`清理失败：${e.message}`, true);
    if (button) button.disabled = false;
  }
}

async function archiveTaskBoardTask(ev, taskId, button) {
  if (ev) ev.stopPropagation();
  if (!confirm('归档该任务？（从任务板隐藏，数据保留）')) return;
  if (button) button.disabled = true;
  const archived = await setTaskBoardStatus(taskId, 'archived', ev);
  if (!archived && button) button.disabled = false;
}

async function archiveCompletedTaskBoard(ev, dirId, button) {
  if (ev) ev.stopPropagation();
  if (button) button.disabled = true;
  try {
    const r = await fetch('/api/task-board/archive-completed', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dirId }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || r.status);
    if (_tbDetailTaskId && (d.taskIds || []).includes(_tbDetailTaskId)) {
      closeTaskBoardDetail();
    }
    if (typeof showToast === 'function') showToast(`已归档 ${d.archivedCount} 个已完成任务`);
    await refreshTaskBoard(true);
  } catch (e) {
    if (typeof showToast === 'function') showToast(`一键清理失败：${e.message}`, true);
    if (button) button.disabled = false;
  }
}

async function reclassifyTaskBoardTask(ev, taskId) {
  if (ev) ev.stopPropagation();
  const btn = ev && ev.currentTarget;
  if (btn) btn.disabled = true;
  try {
    const r = await fetch(`/api/task-board/tasks/${encodeURIComponent(taskId)}/reclassify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.note || d.error || r.status);
    if (typeof showToast === 'function') showToast('已加入重新归类队列');
    await refreshTaskBoard(true);
  } catch (e) {
    if (typeof showToast === 'function') showToast(`重新归类失败：${e.message}`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function reclassifyPendingTaskBoard(ev, dirId) {
  if (ev) ev.stopPropagation();
  const btn = ev && ev.currentTarget;
  if (btn) btn.disabled = true;
  try {
    const r = await fetch('/api/task-board/reclassify-pending', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dirId }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.note || d.error || r.status);
    if (typeof showToast === 'function') showToast(`已加入 ${d.queued} 个任务，跳过 ${d.skipped} 个`);
    await refreshTaskBoard(true);
  } catch (e) {
    if (typeof showToast === 'function') showToast(`批量归类失败：${e.message}`, true);
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

// ── 归拢中浮窗 + 定位高亮 ─────────────────────────────────────────────────
function _tbShowGatheringFloat() {
  if (_tbGatheringFloat) return;
  _tbGatheringFloat = document.createElement('div');
  _tbGatheringFloat.style.cssText = 'position:fixed;bottom:20px;right:20px;background:rgba(0,0,0,0.85);color:#fff;padding:12px 18px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.3)';
  _tbGatheringFloat.innerHTML = '<span style="display:inline-block;animation:spin 1s linear infinite">🔄</span> 任务归拢中…';
  document.body.appendChild(_tbGatheringFloat);
  const style = document.createElement('style');
  style.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(style);
  // 1.5s 超时兜底
  setTimeout(() => _tbHideGatheringFloat(), 1500);
}

function _tbHideGatheringFloat() {
  if (_tbGatheringFloat) {
    _tbGatheringFloat.remove();
    _tbGatheringFloat = null;
  }
}

function _tbScrollToTask(taskId) {
  // dir-detail-body 是滚动容器（manage.html 的弹窗里）
  const container = document.getElementById('dir-detail-body');
  if (!container) return;
  const allTasks = container.querySelectorAll('.tb-task');
  for (const el of allTasks) {
    if (el.textContent.includes(taskId) || el.onclick?.toString().includes(taskId)) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.outline = '2px solid #f9c74f';
      el.style.outlineOffset = '2px';
      setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = ''; }, 3000);
      break;
    }
  }
}
