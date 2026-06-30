'use strict';

let autoRefreshTimer = null;
let _cachedSessions = [];
let _focusedSessionId = null;
const _urlToken = new URLSearchParams(location.search).get('token');
function tokenQS(prefix) { return _urlToken ? `${prefix}token=${_urlToken}` : ''; }
function tt(key, params) { return (window.t || ((k) => k))(key, params); }
const NOTIFY_EXISTING_SESSIONS_MIGRATION_KEY = 'multicc_notify_existing_sessions_opened_20260629';

// Directory ordering with localStorage persistence
let _dirOrder = JSON.parse(localStorage.getItem('multicc_dir_order') || '[]');

function saveDirOrder() {
  localStorage.setItem('multicc_dir_order', JSON.stringify(_dirOrder));
}

function getDirOrder() {
  return [..._dirOrder];
}

function reorderDirectories(newOrder) {
  _dirOrder = newOrder;
  saveDirOrder();
}

/* ── Helpers ── */
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(iso) {
  if (!iso) return 'N/A';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatRelative(iso) {
  if (!iso) return 'N/A';
  const diff = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function formatDuration(sec) {
  if (!sec || sec < 0) return '';
  const s = Math.floor(sec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function shortenPath(p, maxLen) {
  if (!p) return '(unknown)';
  if (p.length <= maxLen) return p;
  return '...' + p.slice(-(maxLen - 3));
}

function inlineEncoded(value) {
  return encodeURIComponent(value).replace(/'/g, '%27');
}

/* ── Notification monitoring via WebSocket ── */
const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z~]|\][^\x07]*(?:\x07|\x1b\\)|[()][AB012]|.)/g;
const WAITING_PATTERNS = [
  // Claude Code TUI: selection list hints
  /Enter to select/i, /to navigate/i, /Esc to cancel/i,
  // Claude Code TUI: common interactive prompts
  /Would you like to proceed/i,
  /auto-accept edits/i,
  /manually approve edits/i,
  /shift\+tab to approve/i,
  /Tell Claude what to change/i,
  // Claude Code TUI: numbered options with ❯ marker
  /[❯›]\s*\d\.\s/,
  // General numbered option lists
  /^\s*[1-9][.)]\s*.+\n\s*[2-9][.)]\s*/m,
  // Yes/No prompts
  /\[Y\/n\]/, /\[y\/N\]/, /\(y\/n\)/i, /\(yes\/no\)/i,
  /Do you want to/i, /Yes\s*\/\s*No/i,
  // Permission / approval prompts
  /Allow\s*(once|always)/i, /Approve\??/i,
  /Run\s+command\??/i,
];
// Claude Code "thinking" spinner patterns — task is still in progress
const IN_PROGRESS_PATTERNS = [
  /[✽✻✶✳✢·⠙⠹⠸⠼⠴⠦⠧⠇⠏⠋⠹]\s*\w+ing/i,  // ✽ Flummoxing… / · Fermenting…
  /\w+ing…/,                                     // Sprouting…, Brewing…
  /Envisioning|Thinking|Generating|Processing/i,
  /tokens?\s*·/,                                  // "↓ 1.0k tokens ·" streaming indicator
  /Running\s+in\s+the\s+background/i,
];
function isInProgress(text) {
  for (const pat of IN_PROGRESS_PATTERNS) {
    if (pat.test(text)) return true;
  }
  return false;
}
const NOTIFY_IDLE_MS = 8000;
const NOTIFY_MIN_CHARS = 80;

// Per-session monitor state: { ws, state, chars, recentText, idleTimer, connectedAt }
const monitors = new Map();
// Notification log entries: [{ id, sessionId, type, message, time }]

function stripAnsi(str) {
  return str.replace(ANSI_RE, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function matchesWaiting(text) {
  for (const pat of WAITING_PATTERNS) {
    if (pat.test(text)) return true;
  }
  return false;
}

function startMonitor(sessionId) {
  if (monitors.has(sessionId)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const urlToken = new URLSearchParams(location.search).get('token');
  const tokenParam = urlToken ? `&token=${urlToken}` : '';
  const wsUrl = `${proto}//${location.host}/?id=${sessionId}${tokenParam}`;

  let ws;
  try { ws = new WebSocket(wsUrl); } catch (_) { return; }

  const mon = {
    ws,
    state: 'idle',
    chars: 0,
    recentText: '',
    idleTimer: null,
    connectedAt: 0,
  };
  monitors.set(sessionId, mon);

  ws.onopen = () => { mon.connectedAt = Date.now(); };

  ws.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data);
      // Completion/waiting is no longer judged from raw output here. The server
      // runs the aux-AI on idle and pushes a `notify` verdict (single judge,
      // consistent with chat). We just render it.
      if (msg.type === 'notify') {
        // Running = in-progress status update (task started / periodic summary).
        // Update the badge but do NOT trigger voice alert or mark the session
        // as alerted — that would steal the slot from the real completion event.
        if (msg.state === 'running') {
          setSessionStatus(sessionId, 'running');
          return;
        }
        const st = msg.state === 'waiting' ? 'waiting'
          : msg.state === 'error' ? 'error' : 'completed';
        alertSession(
          sessionId,
          st,
          msg.message || (st === 'waiting' ? '等待交互' : st === 'error' ? '出现异常' : '任务完成'),
        );
        return;
      }
      // New output → release the alert latch so the next verdict can fire again.
      if (msg.type === 'output') {
        if (Date.now() - mon.connectedAt < 5000) return; // skip replay buffer
        const printable = stripAnsi(msg.data).replace(/\s+/g, '');
        if (printable.length > 0 && _alertedSessions.has(sessionId)) {
          clearSessionStatus(sessionId);
          _alertedSessions.delete(sessionId);
        }
      }
    } catch (_) {}
  };

  ws.onclose = () => {
    if (mon.idleTimer) clearTimeout(mon.idleTimer);
    monitors.delete(sessionId);
  };
  ws.onerror = () => {};
}

function stopMonitor(sessionId) {
  const mon = monitors.get(sessionId);
  if (!mon) return;
  if (mon.idleTimer) clearTimeout(mon.idleTimer);
  try { mon.ws.close(); } catch (_) {}
  monitors.delete(sessionId);
}

function syncMonitors(sessions) {
  const activeIds = new Set(sessions.filter(s => s.active && s.type !== 'aux').map(s => s.id));
  // Start monitors for new active sessions
  for (const id of activeIds) {
    if (!monitors.has(id)) startMonitor(id);
  }
  // Stop monitors for sessions that are no longer active
  for (const id of monitors.keys()) {
    if (!activeIds.has(id)) stopMonitor(id);
  }
}

function openBellForExistingSessionsOnce(sessions) {
  if (localStorage.getItem(NOTIFY_EXISTING_SESSIONS_MIGRATION_KEY) === 'done') return;
  if (typeof enableTaskNotifyForSessions === 'function') {
    enableTaskNotifyForSessions(sessions);
  }
  localStorage.setItem(NOTIFY_EXISTING_SESSIONS_MIGRATION_KEY, 'done');
}

/* ── Session status (persistent badge on card) ── */
// Tracks each session's display status: 'waiting' | 'completed' | null
const _sessionStatus = new Map();

function setSessionStatus(sessionId, type) {
  if (_sessionStatus.get(sessionId) === type) return; // no change
  _sessionStatus.set(sessionId, type);
  renderSessions(_cachedSessions);
}

function clearSessionStatus(sessionId) {
  if (!_sessionStatus.has(sessionId)) return; // already clear
  _sessionStatus.delete(sessionId);
  renderSessions(_cachedSessions);
}

/* ── Session review status (persistent badge on card) ── */
// Tracks review state: 'needs_review' | 'reviewing' | 'reviewed' | null
const _reviewStatus = new Map();
function setReviewStatus(sessionId, status) {
  if (_reviewStatus.get(sessionId) === status) return;
  _reviewStatus.set(sessionId, status);
  updateReviewInDOM(sessionId, status);
}
function clearReviewStatus(sessionId) {
  if (!_reviewStatus.has(sessionId)) return;
  _reviewStatus.delete(sessionId);
  updateReviewInDOM(sessionId, null);
}
function updateReviewCard(card, status) {
  const badge = card.querySelector('.status-badge');
  const dot = card.querySelector('.dot');
  const reviewBadge = card.querySelector('.review-badge');
  const reviewBtn = card.querySelector('.review-action-btn');
  if (badge) {
    badge.classList.remove('reviewed', 'reviewing', 'needs_review');
    if (status) badge.classList.add(status);
  }
  if (dot) {
    dot.classList.remove('needs_review', 'reviewing', 'reviewed');
    if (status) dot.classList.add(status);
  }
  if (reviewBadge) {
    if (status === 'needs_review') {
      reviewBadge.style.display = '';
      reviewBadge.textContent = '🔴 待评审';
      reviewBadge.style.background = 'rgba(248,81,73,.18)';
      reviewBadge.style.color = '#f85149';
      reviewBadge.style.borderColor = 'rgba(248,81,73,.35)';
    } else if (status === 'reviewing') {
      reviewBadge.style.display = '';
      reviewBadge.textContent = '🔵 评审中';
      reviewBadge.style.background = 'rgba(106,163,255,.18)';
      reviewBadge.style.color = '#6aa3ff';
      reviewBadge.style.borderColor = 'rgba(106,163,255,.35)';
    } else if (status === 'reviewed') {
      reviewBadge.style.display = '';
      reviewBadge.textContent = '🟢 已评审';
      reviewBadge.style.background = 'rgba(58,214,197,.18)';
      reviewBadge.style.color = '#3ad6c5';
      reviewBadge.style.borderColor = 'rgba(58,214,197,.35)';
    } else {
      reviewBadge.style.display = 'none';
    }
  }
  if (reviewBtn) reviewBtn.style.display = status === 'reviewed' ? 'none' : '';
}

/* ── Card border rainbow animation helpers ── */
function isSessionRunning(sessionId) {
  // 1. Live workspace status (from /ws/workspace) — thinking/editing/running
  const st = _workspaceStatus.get(sessionId);
  if (st && (st.status === 'thinking' || st.status === 'editing' || st.status === 'running')) return true;
  // 2. Monitor-detected running state (from terminal notify messages)
  if (_sessionStatus.get(sessionId) === 'running') return true;
  // 3. Monitor active state (fallback)
  const mon = monitors.get(sessionId);
  if (mon && (mon.state === 'active' || mon.state === 'running')) return true;
  return false;
}
function isAnySessionInDirRunning(dirId) {
  return (dirSessionsOf(dirId) || []).some(s => isSessionRunning(s.id));
}
function applyCardBorderState(cardEl, isRunning) {
  if (!cardEl) return;
  if (isRunning) cardEl.classList.add('card-border-rainbow');
  else cardEl.classList.remove('card-border-rainbow');
}
function refreshCardBordersForDir(dirId) {
  const running = isAnySessionInDirRunning(dirId);
  const dirCard = document.querySelector('.dir-card[data-dir-id="' + escapeHtml(dirId) + '"]');
  applyCardBorderState(dirCard, running);
  (dirSessionsOf(dirId) || []).forEach(s => {
    document.querySelectorAll('.lean[data-id="' + escapeHtml(s.id) + '"]').forEach(card => {
      applyCardBorderState(card, isSessionRunning(s.id));
    });
  });
}
function refreshAllCardBorders() {
  (_cachedDirectories || []).forEach(d => refreshCardBordersForDir(d.id));
  document.querySelectorAll('#directory-list > .dir-block:not([data-dir-id]) .lean').forEach(card => {
    const sid = card.getAttribute('data-id');
    applyCardBorderState(card, sid ? isSessionRunning(sid) : false);
  });
}
function updateReviewInDOM(sessionId, status) {
  const leanCards = document.querySelectorAll('.lean[data-id="' + escapeHtml(sessionId) + '"]');
  leanCards.forEach(card => applyReviewToLeanCard(card, status));
  const otherCards = document.querySelectorAll('[data-id="' + escapeHtml(sessionId) + '"]:not(.lean)');
  otherCards.forEach(card => {
    const badge = card.querySelector('.status-badge');
    if (badge) {
      badge.classList.remove('reviewed', 'reviewing', 'needs_review');
      if (status) badge.classList.add(status);
    }
  });
}
function applyReviewToLeanCard(card, status) {
  const dot = card.querySelector('.dot');
  const reviewBadge = card.querySelector('.review-badge');
  const reviewBtn = card.querySelector('.review-action-btn');
  if (dot) {
    dot.classList.remove('needs_review', 'reviewing', 'reviewed');
    if (status) dot.classList.add(status);
  }
  if (reviewBadge) {
    if (status === 'needs_review') {
      reviewBadge.style.display = '';
      reviewBadge.textContent = '🔴 待评审';
      reviewBadge.style.background = 'rgba(248,81,73,.18)';
      reviewBadge.style.color = '#f85149';
      reviewBadge.style.borderColor = 'rgba(248,81,73,.35)';
    } else if (status === 'reviewing') {
      reviewBadge.style.display = '';
      reviewBadge.textContent = '🔵 评审中';
      reviewBadge.style.background = 'rgba(106,163,255,.18)';
      reviewBadge.style.color = '#6aa3ff';
      reviewBadge.style.borderColor = 'rgba(106,163,255,.35)';
    } else if (status === 'reviewed') {
      reviewBadge.style.display = '';
      reviewBadge.textContent = '🟢 已评审';
      reviewBadge.style.background = 'rgba(58,214,197,.18)';
      reviewBadge.style.color = '#3ad6c5';
      reviewBadge.style.borderColor = 'rgba(58,214,197,.35)';
    } else {
      reviewBadge.style.display = 'none';
    }
  }
  if (reviewBtn) reviewBtn.style.display = status === 'reviewed' ? 'none' : '';
}
/* ── Alerts (one-shot voice, silenced once user views the session) ── */
const _alertedSessions = new Set(); // sessions whose current alert has been read

function alertSession(sessionId, type, message) {
  // Always update the persistent status badge
  setSessionStatus(sessionId, type);
  if (typeof getTaskNotifyEnabled === 'function' && !getTaskNotifyEnabled(sessionId)) return;
  // Voice: only if this alert hasn't been read yet
  if (_alertedSessions.has(sessionId)) return;
  if (document.visibilityState !== 'visible' && typeof showLocalTaskNotification === 'function') {
    showLocalTaskNotification({
      sessionId,
      type,
      title: type === 'waiting' ? `MultiCC #${sessionId}: 等待操作` : `MultiCC #${sessionId}: 完成`,
      body: message,
      url: location.pathname + location.search,
    });
  }
  if (window.speechSynthesis) {
    const text = `Session ${sessionId}: ${message}`;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1.1;
    utterance.volume = 0.8;
    window.speechSynthesis.speak(utterance);
  }
  _alertedSessions.add(sessionId);
}

function acknowledgeSession(sessionId) {
  // Mark alert as read — stop voice, but do NOT clear the status badge
  _alertedSessions.add(sessionId);
  window.speechSynthesis && window.speechSynthesis.cancel();
}

/* ── Dashboard loading: fetches directories + sessions in parallel ── */
let _cachedDirectories = [];
const _expandedDirs = new Set();  // dirIds currently expanded in the tree

async function loadSessions() { return loadDashboard(); }  // back-compat alias

async function loadDashboard() {
  try {
    const [dirRes, sessRes] = await Promise.all([
      fetch('/api/directories' + tokenQS('?')),
      fetch('/api/sessions' + tokenQS('?')),
    ]);
    const directories = await dirRes.json();
    const sessions = await sessRes.json();
    _cachedDirectories = directories;
    _cachedSessions = sessions;
    openBellForExistingSessionsOnce(sessions);
    if (!_auxConfig) loadAuxConfig().then(() => renderSessions(_cachedSessions || []));
    // Default expand: only directories that have an active session (keeps the
    // board calm). Fall back to expanding all when nothing is active.
    if (_expandedDirs.size === 0 && directories.length > 0) {
      const activeDirIds = new Set(
        sessions.filter(s => s.active && s.type !== 'aux').map(s => s.dirId));
      if (activeDirIds.size) {
        for (const id of activeDirIds) if (id) _expandedDirs.add(id);
      } else {
        for (const d of directories) _expandedDirs.add(d.id);
      }
    }
    renderDashboard(directories, sessions);
refreshAllCardBorders();
syncMonitors(sessions);
    startRuntimeTicker();
  } catch (err) {
    console.error('Failed to load dashboard:', err);
    const el = document.getElementById('directory-list');
    if (el) el.innerHTML = `<div class="empty-state"><p style="color:#f85149">Failed to load: ${err.message}</p></div>`;
  }
}

function renderAuxCard(s, isFocused) {
  const focusedClass = s.id === _focusedSessionId ? ' focused' : '';
  const aux = s.auxStatus || {};
  let statusClass, statusText;
  if (aux.processing) {
    statusClass = 'running'; statusText = '处理中';
  } else if (aux.queueDepth > 0) {
    statusClass = 'waiting'; statusText = `${aux.queueDepth} 排队`;
  } else {
    statusClass = 'idle'; statusText = aux.warmReady ? '就绪' : '空闲';
  }
  const lastAct = s.lastActivity ? formatRelative(s.lastActivity) : 'N/A';
  const totalTasks = aux.totalProcessed || 0;
  const warmDot = aux.warmReady ? '<span title="进程已预热" style="color:#3fb950;">●</span>' : '<span title="进程未就绪" style="color:#484f58;">○</span>';

  return `
    <div class="session-card${focusedClass}" data-id="${escapeHtml(s.id)}" onclick="focusAux()" style="border-color:#8957e5;">
      <div class="card-top">
        <span class="session-id" style="color:#d2a8ff;">AI Assistant</span>
        <span class="status-badge ${statusClass}">${statusText}</span>
      </div>
      <div class="card-body">
        <div class="card-field">
          <span class="field-label">Tasks</span>
          <span class="field-value">${totalTasks} processed ${warmDot}</span>
        </div>
        ${isFocused ? '' : `<div class="card-field">
          <span class="field-label">Active</span>
          <span class="field-value">${escapeHtml(lastAct)}</span>
        </div>`}
      </div>
      <div class="card-footer">
        <span class="client-count" style="color:#d2a8ff;" title="辅助 AI 当前模型">${escapeHtml(_auxModelLabel())}</span>
        <span style="display:flex;gap:6px;">
          <button class="btn btn-sm" onclick="event.stopPropagation(); openAuxModal()">模型</button>
          <button class="btn btn-sm" onclick="event.stopPropagation(); focusAux()">History</button>
        </span>
      </div>
    </div>`;
}

// ── Aux AI model config ──
let _auxConfig = null; // { providerId, model, providers:[{id,name}] }
function _auxModelLabel() {
  if (!_auxConfig) return 'auxqueue';
  const prov = _auxConfig.providerId
    ? ((_auxConfig.providers || []).find(p => p.id === _auxConfig.providerId)?.name || '自定义')
    : '默认登录';
  return `${prov} · ${_auxConfig.model || 'haiku'}`;
}
async function loadAuxConfig() {
  try {
    const res = await fetch('/api/aux/config' + tokenQS('?'));
    _auxConfig = await res.json();
  } catch (_) { _auxConfig = null; }
}
async function openAuxModal() {
  await loadAuxConfig();
  const sel = document.getElementById('aux-provider');
  if (sel) {
    sel.innerHTML = '<option value="">默认登录（订阅 / OAuth）</option>'
      + (_auxConfig?.providers || []).map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
    sel.value = _auxConfig?.providerId || '';
  }
  const inp = document.getElementById('aux-model');
  if (inp) inp.value = _auxConfig?.model || '';
  const st = document.getElementById('aux-modal-status');
  if (st) st.textContent = '';
  document.getElementById('aux-modal')?.classList.add('visible');
}
function closeAuxModal() {
  document.getElementById('aux-modal')?.classList.remove('visible');
}
async function saveAuxConfig() {
  const st = document.getElementById('aux-modal-status');
  const providerId = document.getElementById('aux-provider')?.value || '';
  const model = document.getElementById('aux-model')?.value || '';
  if (st) st.textContent = '保存中…';
  try {
    const res = await fetch('/api/aux/config' + tokenQS('?'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, model }),
    });
    const data = await res.json();
    if (!data.ok) { if (st) st.textContent = data.error || '保存失败'; return; }
    await loadAuxConfig();
    if (st) st.textContent = '已保存 ✓';
    renderSessions(_cachedSessions || []);
    setTimeout(closeAuxModal, 600);
  } catch (e) {
    if (st) st.textContent = '保存失败：' + (e?.message || e);
  }
}

function renderSessions(sessions) {
  // Back-compat: rerender using the cached directory list (status updates etc.)
  renderDashboard(_cachedDirectories, sessions);
}

function renderDashboard(directories, sessions) {
  const auxSessions = sessions.filter(s => s.type === 'aux');
  const regularSessions = sessions.filter(s => s.type !== 'aux');
  const isFocused = !!_focusedSessionId;

  // Aux section (always first)：AI Assistant 虚拟卡片 + 右侧任务进度滚动展示
  const auxEl = document.getElementById('aux-section');
  if (auxEl) {
    if (!auxSessions.length) {
      auxEl.innerHTML = '';
    } else if (isFocused) {
      // 聚焦模式侧栏较窄，沿用原网格布局，不放滚动器
      auxEl.innerHTML = `<div class="session-grid" style="margin-bottom:16px;">${auxSessions.map(s => renderAuxCard(s, isFocused)).join('')}</div>`;
    } else {
      auxEl.innerHTML = `
        <div style="display:flex;gap:16px;align-items:stretch;margin-bottom:16px;">
          <div style="flex:0 0 300px;max-width:300px;display:flex;flex-direction:column;gap:16px;">
            ${auxSessions.map(s => renderAuxCard(s, isFocused)).join('')}
          </div>
          <div id="aux-task-scroller" style="flex:1;min-width:0;position:relative;">
            ${renderTaskProgressScroller(sessions)}
          </div>
        </div>`;
      layoutTaskScroller();
    }
  }

  // Directory tree
  const listEl = document.getElementById('directory-list');
  if (!listEl) return;

  if (directories.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📁</div>
        <p>No directories yet</p>
        <button class="btn btn-green" onclick="openNewDirectoryModal()">+ New Directory</button>
      </div>`;
    return;
  }

  // Group sessions by dirId
  const byDir = new Map();
  for (const s of regularSessions) {
    if (!s.dirId) continue;
    if (!byDir.has(s.dirId)) byDir.set(s.dirId, []);
    byDir.get(s.dirId).push(s);
  }

  const orphans = regularSessions.filter(s => !s.dirId);

  // Sort directories by saved order
  const dirOrder = getDirOrder();
  const sortedDirs = [...directories].sort((a, b) => {
    const idxA = dirOrder.indexOf(a.id);
    const idxB = dirOrder.indexOf(b.id);
    // If both are in the order, sort by order
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    // If only a is in the order, a comes first
    if (idxA !== -1) return -1;
    // If only b is in the order, b comes first
    if (idxB !== -1) return 1;
    // Neither is in the order, keep original order
    return 0;
  });

  const dirHtml = sortedDirs.map(d => renderDirectoryBlock(d, byDir.get(d.id) || [])).join('');
  const orphanHtml = orphans.length ? renderOrphans(orphans) : '';
  listEl.innerHTML = dirHtml + orphanHtml;

  // 应用网格布局（仅在概览模式）
  if (!_focusedSessionId) {
    listEl.style.display = 'grid';
    listEl.style.gridTemplateColumns = 'repeat(auto-fill, minmax(400px, 1fr))';
    listEl.style.gap = '12px';
  } else {
    listEl.style.display = '';
    listEl.style.gridTemplateColumns = '';
    listEl.style.gap = '';
  }

  // Keep a live workspace socket open for every directory so the compact card
  // previews (recent activity + latest task) stay live without expanding.
  for (const d of directories) connectWorkspace(d.id);

  // If the detail modal is open, keep its content in sync with reloads.
  if (_detailModalOpen()) { renderDirectoryDetailBody(_detailDirId); updateDirDetailPush(_detailDirId); }

  // Initialize drag-and-drop for directory cards (only in overview mode)
  if (!_focusedSessionId) {
    initDirCardDragDrop();
  }
}

// ── Drag and Drop for Directory Cards ─────────────────────────────────────────
let _draggedDirId = null;
let _dragOverDirId = null;

function initDirCardDragDrop() {
  const cards = document.querySelectorAll('#directory-list .dir-card');
  cards.forEach(card => {
    card.setAttribute('draggable', 'true');
    card.style.cursor = 'grab';

    card.addEventListener('dragstart', (e) => {
      _draggedDirId = card.dataset.dirId;
      card.style.opacity = '0.5';
      card.style.cursor = 'grabbing';
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.dirId);
    });

    card.addEventListener('dragend', () => {
      card.style.opacity = '1';
      card.style.cursor = 'grab';
      _draggedDirId = null;
      _dragOverDirId = null;
      // Remove all drag-over indicators
      document.querySelectorAll('.dir-card.drag-over').forEach(el => el.classList.remove('drag-over'));
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const targetId = card.dataset.dirId;
      if (targetId !== _draggedDirId) {
        _dragOverDirId = targetId;
        card.classList.add('drag-over');
      }
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
      _dragOverDirId = null;
    });

    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const targetId = card.dataset.dirId;
      if (_draggedDirId && targetId && _draggedDirId !== targetId) {
        // Get current order, initializing with all directory IDs if empty
        let currentOrder = getDirOrder();

        // If order is empty, initialize with all current directory IDs
        if (currentOrder.length === 0) {
          document.querySelectorAll('#directory-list .dir-card').forEach(c => {
            currentOrder.push(c.dataset.dirId);
          });
        }

        const draggedIdx = currentOrder.indexOf(_draggedDirId);
        const targetIdx = currentOrder.indexOf(targetId);

        let newOrder = [...currentOrder];

        if (draggedIdx === -1 && targetIdx === -1) {
          // Both new - add target, then insert dragged before it
          newOrder.push(targetId);
          newOrder.push(_draggedDirId);
          // Swap to put dragged before target
          const tIdx = newOrder.length - 1;
          const dIdx = newOrder.length - 2;
          newOrder[dIdx] = targetId;
          newOrder[tIdx] = _draggedDirId;
        } else if (draggedIdx === -1) {
          // Dragged is new - insert before target
          newOrder.splice(targetIdx, 0, _draggedDirId);
        } else if (targetIdx === -1) {
          // Target is new - add at end, move dragged there
          newOrder.splice(draggedIdx, 1);
          newOrder.push(_draggedDirId);
        } else {
          // Both exist - move dragged to target position
          newOrder.splice(draggedIdx, 1);
          // Recalculate target index after removal
          const newTargetIdx = newOrder.indexOf(targetId);
          newOrder.splice(newTargetIdx, 0, _draggedDirId);
        }

        reorderDirectories(newOrder);
        // Re-render the directory list
        renderSessions(_cachedSessions);
      }
    });
  });
}

// ── Popover menu (kebab ⋯ buttons) ──
let _openPopover = null;
let _popoverOpenedAt = 0;
let _popoverScrollY = 0;
// On touch devices a tap often emits a tiny scroll/bounce and a burst of
// synthesized mouse events right after the menu opens; closing on the very first
// of those made the menu look "unclickable" (it opened then vanished instantly).
// Guard: ignore any outside-close trigger for a short window after opening, and
// only treat a *meaningful* scroll delta as intent to dismiss.
const _POPOVER_GUARD_MS = 350;
function _closePopover() {
  if (_openPopover) { _openPopover.remove(); _openPopover = null; }
  document.removeEventListener('mousedown', _onOutsideDown, true);
  document.removeEventListener('touchstart', _onOutsideDown, true);
  document.removeEventListener('keydown', _popoverKeydown, true);
  window.removeEventListener('resize', _closePopover);
  window.removeEventListener('scroll', _onPopoverScroll, true);
}
function _guardActive() { return (Date.now() - _popoverOpenedAt) < _POPOVER_GUARD_MS; }
function _onOutsideDown(e) {
  if (_guardActive()) return;                      // ignore the opening tap's own burst
  if (_openPopover && _openPopover.contains(e.target)) return; // taps inside handled by item onclick
  _closePopover();
}
function _onPopoverScroll() {
  if (_guardActive()) return;                      // ignore tap-jitter / rubber-band right after open
  if (Math.abs(window.scrollY - _popoverScrollY) < 24) return; // tolerate tiny scrolls
  _closePopover();
}
function _popoverKeydown(e) { if (e.key === 'Escape') _closePopover(); }
function showPopoverMenu(triggerEl, items) {
  _closePopover();
  const menu = document.createElement('div');
  menu.className = 'popover-menu';
  menu.addEventListener('mousedown', e => e.stopPropagation());
  for (const item of items) {
    if (item.sep) {
      const s = document.createElement('div'); s.className = 'sep'; menu.appendChild(s); continue;
    }
    const btn = document.createElement('button');
    btn.textContent = item.label;
    if (item.danger) btn.classList.add('danger');
    if (item.ready) btn.classList.add('ready');
    btn.onclick = (e) => { e.stopPropagation(); _closePopover(); item.onclick(); };
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  const rect = triggerEl.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + 4;
  let left = rect.right - menuRect.width;
  if (left < 4) left = 4;
  if (top + menuRect.height > window.innerHeight - 4) top = Math.max(4, rect.top - menuRect.height - 4);
  menu.style.top = top + 'px';
  menu.style.left = left + 'px';
  _openPopover = menu;
  _popoverOpenedAt = Date.now();
  _popoverScrollY = window.scrollY;
  setTimeout(() => {
    document.addEventListener('mousedown', _onOutsideDown, true);
    document.addEventListener('touchstart', _onOutsideDown, true);
    document.addEventListener('keydown', _popoverKeydown, true);
    window.addEventListener('resize', _closePopover);
    window.addEventListener('scroll', _onPopoverScroll, true);
  }, 0);
}

function showNewSessionMenu(ev, dirId) {
  ev.stopPropagation();
  showPopoverMenu(ev.currentTarget, [
    { label: '+ Claude Chat', onclick: () => newSessionInDir(dirId, 'claude', 'chat') },
    { label: '+ Claude Terminal', onclick: () => newSessionInDir(dirId, 'claude', 'terminal') },
    { sep: true },
    { label: '+ Codex Chat', onclick: () => newSessionInDir(dirId, 'codex', 'chat') },
    { label: '+ Codex Terminal', onclick: () => newSessionInDir(dirId, 'codex', 'terminal') },
  ]);
}

function showDirMenu(ev, dirId) {
  ev.stopPropagation();
  const dir = (_cachedDirectories || []).find(d => d.id === dirId);
  const ps = dir?.pushState || {};
  const items = [];
  // Git push moved off the header into this menu (P2: declutter the dir header).
  if (ps.available !== false && ps.hasRemote) {
    const label = ps.ahead > 0
      ? `↑ 推送 ${ps.ahead} 个提交`
      : (ps.behind > 0 ? `↓ 落后 ${ps.behind}（需先 pull）` : '✓ Git 已同步');
    items.push({ label, onclick: () => pushDirectory(dirId) });
    items.push({ sep: true });
  }
  items.push({ label: tt('rename'), onclick: () => renameDirectory(dirId) });
  items.push({ label: dir?.rolePrompt ? tt('rolePromptSet') : tt('rolePrompt'), onclick: () => changeDirectoryRole(dirId) });
  items.push({ sep: true });
  items.push({ label: tt('deleteDirectory'), danger: true, onclick: () => deleteDirectory(dirId) });
  showPopoverMenu(ev.currentTarget, items);
}

function showSessionMenu(ev, sessionId) {
  ev.stopPropagation();
  const st = _workspaceStatus.get(sessionId);
  const s = _cachedSessions.find(x => x.id === sessionId);
  const ms = st?.mergeState || s?.mergeState || {};
  const mergeReady = !!ms.mergeReady;
  const mergeLabel = mergeReady
    ? tt('mergeToAhead', { base: ms.baseBranch || 'main', n: ms.ahead || 0 })
    : tt('mergeTo', { base: ms.baseBranch || 'main' });
  const items = [
    { label: tt('rename'), onclick: () => renameSession(sessionId) },
    { label: tt('note'), onclick: () => openNoteModal(sessionId) },
    { label: 'Diff', onclick: () => showDiff(sessionId) },
  ];
  if ((s?.cli || 'claude') === 'claude') {
    items.push({ label: tt('changeModel', { model: modelShortName(s?.model || '') }), onclick: () => changeSessionModel(sessionId) });
  }
  items.push({ label: s?.rolePrompt ? tt('rolePromptSet') : tt('rolePrompt'), onclick: () => changeSessionRole(sessionId) });
  items.push({ sep: true });
  items.push({ label: mergeLabel, ready: mergeReady, onclick: () => mergeSession(sessionId) });
  items.push({ sep: true });
  items.push({ label: tt('deleteSession'), danger: true, onclick: () => deleteSession(sessionId) });
  showPopoverMenu(ev.currentTarget, items);
}

// Deduplicated set of session ids currently waiting on user input (a session may
// appear in both the monitor map and the live workspace map).
function waitingSessionIds() {
  const ids = new Set();
  if (typeof _sessionStatus !== 'undefined' && _sessionStatus)
    for (const [id, v] of _sessionStatus) if (v === 'waiting') ids.add(id);
  if (typeof _workspaceStatus !== 'undefined' && _workspaceStatus)
    for (const [id, v] of _workspaceStatus) if (v && v.status === 'waiting') ids.add(id);
  return ids;
}

function _dirNameById(dirId) {
  const d = (_cachedDirectories || []).find(x => x.id === dirId);
  return d ? d.name : '';
}

function jumpToSession(s) {
  // 直接在本页面（弹层）打开会话，而不是开新标签页。
  openSessionModal(s.id);
}

// 会话的「实时运行状态 + 最近任务简介」，供 KPI 弹层各块统一展示。
function sessionStatusBrief(s) {
  const wb = _workspaceStatus.get(s.id);
  let text, cls;
  if (wb) {
    const info = wbStatusInfo(wb.status); text = info.text; cls = info.cls;
  } else if (s.active) {
    text = tt('active'); cls = 'active';
  } else {
    const ms = _sessionStatus.get(s.id);
    if (ms === 'waiting') { text = tt('waiting'); cls = 'waiting'; }
    else if (ms === 'completed') { text = tt('completed'); cls = 'completed'; }
    else if (ms === 'error') { text = tt('error'); cls = 'error'; }
    else if (ms === 'running') { text = tt('running'); cls = 'active'; }
    else { text = tt('idle'); cls = ''; }
  }
  const emoji = cls === 'active' ? '🟢' : (cls === 'waiting' ? '⏳' : (cls === 'completed' ? '✅' : (cls === 'error' ? '❌' : '⚪')));
  const sm = _workspaceSummaries.get(s.id);
  let summary = sm && sm.summary ? sm.summary : '';
  if (summary.length > 40) summary = summary.slice(0, 40) + '…';
  const runtime = sessionRunTimeText(s.id);
  return { text, cls, emoji, summary, runtime };
}

// Render a popover from a KPI tile: each row shows 会话名 + 运行状态 + 最近任务简介，
// click opens it in-page. Shared by the 等待输入 / 活跃会话 tiles.
function showSessionListPopup(ev, sessions, prefix, emptyText) {
  ev.stopPropagation();
  const items = sessions.map(s => {
    const alias = s.label || s.id;
    const dir = _dirNameById(s.dirId);
    const name = dir ? `${dir} / ${alias}` : alias;
    const b = sessionStatusBrief(s);
    let label = `${b.emoji} ${name} · ${b.text}`;
    if (b.runtime) label += ` · ${b.runtime}`;
    if (b.summary) label += ` — ${b.summary}`;
    return { label, onclick: () => jumpToSession(s) };
  });
  if (!items.length) items.push({ label: emptyText, onclick: () => {} });
  showPopoverMenu(ev.currentTarget, items);
}

// Popup from the "等待输入" KPI tile.
function showWaitingSessions(ev) {
  const ids = waitingSessionIds();
  const list = (_cachedSessions || []).filter(s => ids.has(s.id));
  showSessionListPopup(ev, list, '⏳', '没有等待输入的会话');
}

// 「活跃会话」口径：最近 12 小时内使用过的会话（按最近交互时间倒序），
// 而非"此刻进程还连着"。供 KPI 数字与弹层共用，保证两者一致。
const RECENT_USE_WINDOW_MS = 12 * 3600 * 1000;
function isRecentlyUsed(s) {
  if (!s || s.type === 'aux') return false;
  const ms = sessionLastInteractionMs(s);
  return ms > 0 && (Date.now() - ms) <= RECENT_USE_WINDOW_MS;
}
function recentlyUsedSessions() {
  return (_cachedSessions || [])
    .filter(isRecentlyUsed)
    .sort((a, b) => sessionLastInteractionMs(b) - sessionLastInteractionMs(a));
}

// Popup from the "活跃会话" KPI tile.
function showActiveSessions(ev) {
  showSessionListPopup(ev, recentlyUsedSessions(), '🟢', '最近 12 小时没有使用过的会话');
}

// Jump for a cron task: open the session it drives (cron fires into a dedicated
// chat session, stored as lastSessionId). Never-run tasks have none yet → fall
// back to the task's edit/run modal.
function jumpToCronTask(t) {
  if (t.lastSessionId && (_cachedSessions || []).some(s => s.id === t.lastSessionId)) {
    openSessionModal(t.lastSessionId);
  } else {
    openCronModal(t.id);
  }
}

// Popup from the "定时任务" KPI tile: each task as "name · cron · dir"; click jumps
// to the session it drives (↗) or opens its setup if it hasn't run yet.
function showCronTasks(ev) {
  ev.stopPropagation();
  const tasks = (typeof _cronTasksCache !== 'undefined' && _cronTasksCache) ? _cronTasksCache : [];
  const items = tasks.map(t => {
    const live = t.lastSessionId && (_cachedSessions || []).some(s => s.id === t.lastSessionId);
    return {
      label: `${t.enabled ? '⏰' : '⏸'} ${t.name || '(未命名)'}${t.dirName ? ' · ' + t.dirName : ''} ${live ? '↗' : '⚙'}`,
      onclick: () => jumpToCronTask(t),
    };
  });
  if (!items.length) items.push({ label: '还没有定时任务，点这里去登记', onclick: () => setView('cron') });
  showPopoverMenu(ev.currentTarget, items);
}

// Session list grouped by (cli, kind). Reused by the focus-mode inline list and
// the directory-detail modal.
function renderDirSessionGroups(dirSessions) {
  const groups = {
    claude_terminal: [], claude_chat: [],
    codex_terminal: [], codex_chat: [],
  };
  for (const s of dirSessions) {
    const key = `${s.cli || 'claude'}_${s.kind || 'terminal'}`;
    if (groups[key]) groups[key].push(s);
  }
  const renderGroup = (cli, kind, label) => {
    const ss = groups[`${cli}_${kind}`];
    if (!ss.length) return '';
    const rows = ss.map(s => renderSessionRow(s)).join('');
    return `
      <div class="sess-group ${cli}">
        <div class="sess-group-label">${label} (${ss.length})</div>
        <div class="sess-card-grid">${rows}</div>
      </div>`;
  };
  return [
    renderGroup('claude', 'terminal', 'Claude Terminals'),
    renderGroup('claude', 'chat', 'Claude Chats'),
    renderGroup('codex',  'terminal', 'Codex Terminals'),
    renderGroup('codex',  'chat', 'Codex Chats'),
  ].filter(Boolean).join('') || `<div class="dir-empty">${escapeHtml(tt('noSessions'))}</div>`;
}

// Sessions belonging to a directory (excludes the aux assistant).
function dirSessionsOf(dirId) {
  return (_cachedSessions || []).filter(s => s.dirId === dirId && s.type !== 'aux');
}

// 会话「最近交互时间」(ms)：取实时工作区状态、会话最近回复、创建时间中的最新者。
// lastActivity/createdAt 是 ISO 字符串（不能直接相减），workspaceStatus.lastActivity 是毫秒数，
// 这里统一归一化成毫秒再比较，供卡片排序与显示用。
function sessionLastInteractionMs(s) {
  if (!s) return 0;
  const st = _workspaceStatus.get(s.id);
  let best = 0;
  for (const c of [st && st.lastActivity, s.lastActivity, s.createdAt]) {
    if (c == null) continue;
    const ms = typeof c === 'number' ? c : Date.parse(c);
    if (Number.isFinite(ms) && ms > best) best = ms;
  }
  return best;
}

// ── 任务运行时长 ──────────────────────────────────────────────────────────
// 从用户发出消息（任务开始 runStartedAt）算起，任务执行了多久。进行中
// (thinking/editing/running) 实时累加；终止/等待时冻结到 runEndedAt。
function isRunningWbStatus(status) {
  return status === 'thinking' || status === 'editing' || status === 'running';
}
// 返回运行时长(ms)，无法计算时返回 null。
function runDurationMs(st) {
  if (!st || !st.runStartedAt) return null;
  const live = isRunningWbStatus(st.status) && !st.runEndedAt;
  const end = live ? Date.now() : (st.runEndedAt || st.runStartedAt);
  return Math.max(0, end - st.runStartedAt);
}
// 紧凑中文时长：12秒 / 3分20秒 / 1时05分。
function formatRunDuration(ms) {
  if (ms == null || ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (h > 0) return `${h}时${String(m).padStart(2, '0')}分`;
  if (m > 0) return `${m}分${String(sec).padStart(2, '0')}秒`;
  return `${sec}秒`;
}
// 会话运行时长短语（带 ⏱ 前缀），无可用数据时返回空串。供卡片/弹层共用。
function sessionRunTimeText(sessionId) {
  const ms = runDurationMs(_workspaceStatus.get(sessionId));
  const txt = formatRunDuration(ms);
  return txt ? `⏱ ${txt}` : '';
}

// Compact preview shown on the overview card: unified card with activity block,
// recent session, and quick-open button. Full detail lives in the modal.
function renderDirPreview(dirId, dirSessions) {
  // 获取最近活动（最多3条）
  const events = (_workspaceEvents.get(dirId) || []).slice(-3).reverse();

  // 取「最近交互过」的 session（按最近交互时间降序，含实时活动）
  let latestSession = null;
  if (dirSessions && dirSessions.length > 0) {
    const sorted = [...dirSessions].sort(
      (a, b) => sessionLastInteractionMs(b) - sessionLastInteractionMs(a));
    latestSession = sorted[0];
  }

  const sessionInfo = latestSession;
  const sessionSummary = latestSession ? _workspaceSummaries.get(latestSession.id) : null;
  const sessionActive = sessionInfo && sessionInfo.active;
  const sessionLabel = sessionInfo ? (sessionInfo.label || sessionInfo.id) : null;
  const sessionModel = sessionInfo && sessionInfo.model ? modelShortName(sessionInfo.model) : '';

  // 活动块内容
  let activityContent = '';
  if (sessionActive) {
    activityContent = `
      <span class="dot active" style="width:8px;height:8px;"></span>
      <span style="color:var(--accent);">正在运行</span>
    `;
  } else if (events.length > 0) {
    const lastEvent = events[0];
    activityContent = `
      <span style="color:var(--muted);">上次 ${new Date(lastEvent.ts).toLocaleTimeString()}</span>
      <span style="color:var(--faint);">· ${escapeHtml(eventLabel(lastEvent))}</span>
    `;
  } else {
    activityContent = `<span style="color:var(--faint);">暂无活动</span>`;
  }

  // Session 块内容 - 固定高度 56px 保证卡片对齐
  let sessionContent = '';
  if (sessionInfo) {
    sessionContent = `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:rgba(0,0,0,0.15);border-radius:8px;min-height:56px;height:56px;">
        <span class="dot ${sessionActive ? 'active' : ''}" style="width:8px;height:8px;"></span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(sessionLabel)}</div>
          <div style="font-size:11px;color:var(--faint);display:flex;gap:6px;align-items:center;">
            <span>${escapeHtml(formatRelative(sessionLastInteractionMs(sessionInfo) || sessionInfo.createdAt))}</span>
            ${sessionModel ? `<span>· ${escapeHtml(sessionModel)}</span>` : ''}
          </div>
          ${sessionSummary && sessionSummary.summary ? `<div style="font-size:11px;color:var(--muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">🗒 ${escapeHtml(sessionSummary.summary)}</div>` : ''}
        </div>
        <button class="btn btn-sm" onclick="event.stopPropagation(); event.preventDefault(); openSessionChat('${escapeHtml(sessionInfo.id)}')" title="快捷打开会话">
          打开
        </button>
      </div>
    `;
  } else {
    sessionContent = `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:rgba(0,0,0,0.15);border-radius:8px;min-height:56px;height:56px;">
        <span style="font-size:12px;color:var(--faint);">暂无关联会话</span>
      </div>
    `;
  }

  return `
    <div class="dir-preview" id="dir-preview-${escapeHtml(dirId)}" style="padding:12px 17px 17px;display:flex;flex-direction:column;gap:10px;">
      <!-- 活动块 - 固定高度 36px 保证卡片对齐 -->
      <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:rgba(0,0,0,0.2);border-radius:8px;min-height:36px;height:36px;">
        <span style="font-size:12px;color:var(--faint);">活动</span>
        ${activityContent}
      </div>
      <!-- 最近 session 块 -->
      ${sessionContent}
    </div>
  `;
}

function updateDirPreview(dirId) {
  const el = document.getElementById(`dir-preview-${dirId}`);
  if (el) el.outerHTML = renderDirPreview(dirId, dirSessionsOf(dirId));
}
function updateDirPreviewForSession(sessionId) {
  const s = (_cachedSessions || []).find(x => x.id === sessionId);
  if (s && s.dirId) updateDirPreview(s.dirId);
}

// 刷新首页 AI Assistant 卡片右侧的全局任务进度滚动展示器
function updateGlobalTaskScroller() {
  const el = document.getElementById('aux-task-scroller');
  if (el) {
    el.innerHTML = renderTaskProgressScroller(_cachedSessions || []);
    layoutTaskScroller();
  }
}

// 任务进度滚动展示器 - 展示所有目录下正在进行中的任务状态
// 放在首页「AI Assistant」虚拟卡片右侧的空白区域，自动轮播：thinking、editing、running、waiting
function renderTaskProgressScroller(sessions) {
  // 取「当天用过的会话」（跨所有目录，非 aux），按最近使用时间倒序
  const activeTasks = [];
  for (const s of (sessions || [])) {
    if (s.type === 'aux') continue;
    const st = _workspaceStatus.get(s.id);
    // 最近使用时间：优先用 workspace 实时状态里的，回退到会话列表里的
    const ts = (st && st.lastActivity) || s.lastActivity || s.createdAt || 0;
    if (!isToday(ts)) continue;
    const summary = _workspaceSummaries.get(s.id);
    const dir = (_cachedDirectories || []).find(d => d.id === s.dirId);
    activeTasks.push({
      sessionId: s.id,
      label: s.label || s.id,
      dirName: dir ? dir.name : '',
      status: st ? st.status : 'idle',
      currentFile: st ? st.currentFile : null,
      summary: summary?.summary,
      lastActivity: ts,
    });
  }
  // 反向排序：最近用过的排最前
  activeTasks.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));

  // 当天无任何会话时显示占位（填满整块空白区域，垂直居中）
  if (activeTasks.length === 0) {
    return `
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.15);border-radius:var(--radius);border:1px solid var(--line);">
        <span style="font-size:12px;color:var(--faint);opacity:0.8;">${escapeHtml(tt('noActiveTask'))}</span>
      </div>
    `;
  }

  // 任务进度卡片（单行紧凑布局，每行 56px）
  const cards = activeTasks.map(task => {
    const info = wbStatusInfo(task.status);
    const statusColor = info.cls === 'active' ? '#6aa3ff' : (info.cls === 'waiting' ? '#e3b341' : '#5b616c');
    const activityText = task.currentFile
      ? `📝 ${task.currentFile.split('/').pop()}`
      : (task.summary || defaultActivityText(task.status));

    return `
      <div class="task-progress-card" data-session-id="${escapeHtml(task.sessionId)}"
           style="height:56px;display:flex;align-items:center;gap:12px;padding:0 16px;cursor:pointer;"
           onclick="event.stopPropagation(); openSessionInline('${escapeHtml(task.sessionId)}')">
        <!-- 状态指示灯 -->
        <span style="width:8px;height:8px;border-radius:50%;background:${statusColor};box-shadow:0 0 6px ${statusColor};flex-shrink:0;"></span>
        <!-- 会话标签（+所属目录） -->
        <span style="font-size:13px;color:var(--text);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;flex-shrink:0;">${escapeHtml(task.label)}${task.dirName ? `<span style="color:var(--faint);font-weight:400;"> · ${escapeHtml(task.dirName)}</span>` : ''}</span>
        <!-- 状态标签 -->
        <span style="padding:3px 8px;font-size:10px;color:${statusColor};background:${statusColor}33;border:1px solid ${statusColor}55;border-radius:4px;flex-shrink:0;">${escapeHtml(info.text)}</span>
        <!-- 当前活动 -->
        <span style="flex:1;min-width:0;font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(activityText)}</span>
      </div>
    `;
  }).join('');

  // 视口高度跟随容器（与左侧 AI 卡片等高），渲染后由 layoutTaskScroller 按可用高度
  // 计算「同时可见几行」，行数装不下时再逐行无缝轮播。
  const count = activeTasks.length;
  return `
    <div style="position:absolute;inset:0;overflow:hidden;background:rgba(0,0,0,0.15);border-radius:var(--radius);border:1px solid var(--line);">
      <div id="task-scroller-viewport" style="width:100%;height:100%;overflow:hidden;">
        <div class="task-scroller-inner" data-count="${count}">
          ${cards}
        </div>
      </div>
    </div>
  `;
}

// 按视口实际高度布局任务滚动器：算出能同时显示几行；装得下就全显示、不轮播，
// 装不下就在尾部接上「头部 N 行」的副本，用 CSS 动画逐行无缝向上滚。
const TASK_ROW_H = 56;
const TASK_DWELL_SEC = 6; // 轮播时每行停留秒数
function layoutTaskScroller() {
  const vp = document.getElementById('task-scroller-viewport');
  if (!vp) return;
  const inner = vp.querySelector('.task-scroller-inner');
  if (!inner) return;
  const count = parseInt(inner.dataset.count || '0', 10);
  if (count <= 0) return;
  const h = vp.clientHeight || TASK_ROW_H;
  const rows = Math.max(1, Math.floor(h / TASK_ROW_H));

  inner.style.animation = 'none';
  // 先清掉上一轮可能追加过的副本，只留原始 count 行
  while (inner.children.length > count) inner.removeChild(inner.lastChild);

  if (count <= rows) {
    // 全部能同时显示，无需轮播
    inner.dataset.looped = '';
    return;
  }

  // 装不下：尾部追加头部 rows 行做无缝衔接
  const clones = [];
  for (let i = 0; i < rows; i++) clones.push(inner.children[i].outerHTML);
  inner.insertAdjacentHTML('beforeend', clones.join(''));
  inner.dataset.looped = String(rows);
  ensureTaskScrollerKeyframes(count, TASK_ROW_H);
  void inner.offsetHeight; // 强制 reflow，确保动画从头播放
  inner.style.animation = `taskScroll ${count * TASK_DWELL_SEC}s linear infinite`;
}
// 窗口尺寸变化时按新高度重排可见行数
window.addEventListener('resize', () => layoutTaskScroller());

// 当天判断
function isToday(ts) {
  if (!ts) return false;
  const d = new Date(ts), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

// 按当前任务条数生成轮播关键帧：逐行向上滚，每行停留一段后快速滑到下一行；
// 末尾滚到 -count*rowH（此处显示的是尾部副本=头部几行），与起点画面一致，循环无缝。
// 只有一个全局滚动器，因此直接覆盖同名 @keyframes 即可
function ensureTaskScrollerKeyframes(count, rowH) {
  if (count < 2) return;
  rowH = rowH || 56;
  let styleEl = document.getElementById('task-scroller-kf');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'task-scroller-kf';
    document.head.appendChild(styleEl);
  }
  const sig = `${count}x${rowH}`;
  if (styleEl.dataset.sig === sig) return; // 签名没变就不重建
  const step = 100 / count;
  let frames = '';
  for (let i = 0; i < count; i++) {
    const winStart = i * step;
    const slideStart = winStart + step * 0.82; // 每行窗口末尾 18% 用来滑动
    const winEnd = (i + 1) * step;
    frames += `${winStart.toFixed(2)}%,${slideStart.toFixed(2)}%{transform:translateY(${-(i * rowH)}px)}`;
    frames += `${winEnd.toFixed(2)}%{transform:translateY(${-((i + 1) * rowH)}px)}`;
  }
  styleEl.textContent = `@keyframes taskScroll{${frames}}`;
  styleEl.dataset.sig = sig;
}

function defaultActivityText(status) {
  switch (status) {
    case 'thinking': return '🤔 正在思考...';
    case 'editing': return '✏️ 正在编辑文件';
    case 'running': return '⚙️ 正在执行命令';
    case 'waiting': return '⏳ 等待用户输入';
    case 'completed': return '✅ 已完成';
    case 'error': return '❌ 出现异常';
    case 'idle': return '💤 空闲';
    default: return '...';
  }
}

function renderDirectoryBlock(dir, dirSessions) {
  const id = dir.id;
  const maxPath = _focusedSessionId ? 30 : 60;

  const total = dirSessions.length;
  const active = dirSessions.filter(s => s.active).length;
  // Git push state (ahead) surfaces as a tiny dot on the ⋯ menu; the full
  // action lives inside showDirMenu now (P2: declutter the header).
  const ps = dir.pushState || {};
  const pushPending = ps.available !== false && ps.hasRemote && ps.ahead > 0;

  const headerActions = `
        <button class="btn add-new btn-sm" title="${escapeHtml(tt('createSession'))}" onclick="event.stopPropagation(); showNewSessionMenu(event, '${escapeHtml(id)}')">${escapeHtml(tt('createSession'))}</button>
        <button class="btn-icon" title="项目备忘 (multicc.memo.md)" onclick="event.stopPropagation(); openMemo('${escapeHtml(id)}')">📝</button>
        <button class="btn-icon${pushPending ? ' has-pending' : ''}" title="更多操作${pushPending ? `（有 ${ps.ahead} 个提交待 push）` : ''}" onclick="event.stopPropagation(); showDirMenu(event, '${escapeHtml(id)}')">⋯</button>`;

  const headerMain = `
        <div class="dir-main">
          <span class="dir-name">${escapeHtml(dir.name)}</span>
          <span class="dir-path" title="${escapeHtml(dir.path)}">${escapeHtml(shortenPath(dir.path, maxPath))}</span>
          <div class="dir-meta">
            <span><strong>${total}</strong> ${escapeHtml(tt('sessions'))}</span>
            ${active > 0 ? `<span class="sep">·</span><span class="active-count"><strong>${active}</strong> ${escapeHtml(tt('active'))}</span>` : ''}
          </div>
        </div>`;

  // Sidebar (focus) mode keeps the inline, always-open session list so you can
  // switch sessions without a popup. Overview mode shows a compact card whose
  // body is a 2-line preview; clicking opens the full detail in a modal.
  if (_focusedSessionId) {
    return `
    <div class="dir-block open${isAnySessionInDirRunning(id) ? ' card-border-rainbow' : ''}" data-dir-id="${escapeHtml(id)}">
      <div class="dir-header">
        ${headerMain}
        ${headerActions}
      </div>
      <div class="dir-body">
        ${renderEventTimeline(id)}
        ${renderDirSessionGroups(dirSessions)}
      </div>
    </div>`;
  }

  // Overview mode: unified card with min-height and grid layout
  return `
    <div class="dir-block dir-card${isAnySessionInDirRunning(id) ? ' card-border-rainbow' : ''}" data-dir-id="${escapeHtml(id)}" onclick="openDirectoryDetail('${escapeHtml(id)}')" style="display:flex;flex-direction:column;min-height:160px;">
      <div class="dir-header">
        ${headerMain}
        ${headerActions}
      </div>
      ${renderDirPreview(id, dirSessions)}
    </div>`;
}

// ── Directory detail modal (replaces the old inline accordion) ──
let _detailDirId = null;
function openDirectoryDetail(dirId) {
  const dir = (_cachedDirectories || []).find(d => d.id === dirId);
  if (!dir) return;
  _detailDirId = dirId;
  connectWorkspace(dirId);
  const title = document.getElementById('dir-detail-title');
  const sub = document.getElementById('dir-detail-subtitle');
  if (title) title.textContent = dir.name;
  if (sub) { sub.textContent = dir.path; sub.title = dir.path; }
  const addBtn = document.getElementById('dir-detail-add');
  if (addBtn) addBtn.onclick = (e) => { e.stopPropagation(); showNewSessionMenu(e, dirId); };
  const memoBtn = document.getElementById('dir-detail-memo');
  if (memoBtn) memoBtn.onclick = (e) => { e.stopPropagation(); openMemo(dirId); };
  updateDirDetailPush(dirId);
  renderDirectoryDetailBody(dirId);
  const m = document.getElementById('dir-detail-modal');
  if (m) m.classList.add('visible');
}
// Git-push button inside the detail modal — mirrors the action in the dir ⋯ menu.
// Hidden when there's no remote; otherwise reflects ahead/behind/synced state.
function updateDirDetailPush(dirId) {
  const btn = document.getElementById('dir-detail-push');
  if (!btn) return;
  const dir = (_cachedDirectories || []).find(d => d.id === dirId);
  const ps = (dir && dir.pushState) || {};
  if (ps.available === false || !ps.hasRemote) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  let label, color, title;
  if (ps.ahead > 0) {
    label = `↑ 推送 ${ps.ahead}`; color = 'var(--amber)';
    title = `推送 ${ps.ahead} 个提交到 ${ps.remote || 'remote'}/${ps.remoteBranch || ''}`;
  } else if (ps.behind > 0) {
    label = `↓ 落后 ${ps.behind}`; color = 'var(--muted)';
    title = `本地落后远端 ${ps.behind} 个提交，需先 pull`;
  } else {
    label = '✓ 已同步'; color = 'var(--codex)'; title = 'Git 已同步';
  }
  btn.textContent = label;
  btn.style.color = color;
  btn.title = title;
  btn.onclick = (e) => { e.stopPropagation(); pushDirectory(dirId); };
}
function renderDirectoryDetailBody(dirId) {
  const body = document.getElementById('dir-detail-body');
  if (!body) return;
  body.innerHTML = renderEventTimeline(dirId) + renderDirSessionGroups(dirSessionsOf(dirId));
}
function closeDirectoryDetail() {
  _detailDirId = null;
  const m = document.getElementById('dir-detail-modal');
  if (m) m.classList.remove('visible');
}
function _detailModalOpen() {
  const m = document.getElementById('dir-detail-modal');
  return _detailDirId && m && m.classList.contains('visible');
}

async function pushDirectory(id) {
  const dir = (_cachedDirectories || []).find(d => d.id === id);
  if (!dir) return;
  const state = dir.pushState || {};
  if (state.available === false) {
    showToast(`无法读取 Git 状态：${state.reason || '未知错误'}`, true);
    return;
  }
  if (!state.hasRemote) {
    showToast('该目录未设置 Git remote', true);
    return;
  }
  if (!state.ahead) {
    showToast(state.behind > 0 ? `本地落后远端 ${state.behind} 个提交，请先 pull` : '没有待 push 的提交');
    return;
  }
  if (!(await showConfirm(
    `将 ${state.ahead} 个提交推送到 ${state.remote}/${state.remoteBranch}？`,
    { okText: 'Push' }
  ))) return;
  try {
    const res = await fetch(`/api/directories/${id}/push${tokenQS('?')}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast(data.pushed ? `已推送 ${data.before.ahead} 个提交` : '没有待 push 的提交');
    await loadDashboard();
  } catch (error) {
    showToast(`Push 失败：${error.message}`, true);
  }
}

function renderSessionRow(s) {
  const focusedClass = s.id === _focusedSessionId ? ' focused' : '';
  const monStatus = _sessionStatus.get(s.id);
  const mon = monitors.get(s.id);
  let statusText = tt('idle'), statusCls = '';
  if (s.active) { statusCls = 'active'; statusText = tt('active'); }
  if (monStatus === 'waiting') { statusCls = 'waiting'; statusText = tt('waiting'); }
  else if (monStatus === 'completed') { statusCls = 'completed'; statusText = tt('completed'); }
  else if (mon && mon.state === 'active') { statusCls = 'active'; statusText = tt('running'); }
  // Live workspace status (from /ws/workspace) takes precedence when available.
  const wb = _workspaceStatus.get(s.id);
  if (wb) { const info = wbStatusInfo(wb.status); statusText = info.text; statusCls = info.cls; }
  const pendingNotes = _workspaceNotes.get(s.id) || 0;
  const mergeState = wb?.mergeState || s.mergeState || {};
  const mergeReady = !!mergeState.mergeReady;
  const hasConflict = !!mergeState.conflict;
  const conflictFiles = mergeState.conflictFiles || [];
  const conflictTitle = hasConflict
    ? `同步冲突：${conflictFiles.length} 个文件待解决（${conflictFiles.slice(0, 5).join(', ')}）— 点击查看如何解决`
    : '';
  const mergeDetail = [
    mergeState.dirty ? tt('dirtyChanges') : '',
    mergeState.ahead > 0 ? tt('aheadCommits', { n: mergeState.ahead }) : '',
  ].filter(Boolean).join('，');
  const mergeTitle = mergeReady
    ? tt('mergeReadyTitle', { detail: mergeDetail })
    : tt('mergeWorktreeTitle');
  const displayName = s.label || s.id;
  const model = s.model ? modelShortName(s.model) : '';
  const wbFile = (wb && wb.currentFile) ? wb.currentFile.split('/').pop() : '';
  const sm = _workspaceSummaries.get(s.id);
  const summary = sm && sm.summary ? sm.summary : '';
  const runtimeText = sessionRunTimeText(s.id);

  const openBtn = s.kind === 'chat'
    ? `<button class="btn-icon" onclick="event.stopPropagation(); openSessionChat('${escapeHtml(s.id)}')" title="${escapeHtml(tt('openInNewTab'))}">🔗</button>`
    : `<button class="btn-icon" onclick="event.stopPropagation(); openSessionNewTab('${escapeHtml(s.id)}')" title="${escapeHtml(tt('openInNewTab'))}">🔗</button>`;

  // Lean 2-line card: status is a colour dot (hover for text), the alias is the
  // headline, and time/model sit in one muted line. cli/kind chips are dropped
  // (the group header already says "Claude Chats"); #id, delete and the rest
  // live in the ⋯ menu / title attribute.
  return `
    <div class="lean${isSessionRunning(s.id) ? ' card-border-rainbow' : ''}${focusedClass}" data-id="${escapeHtml(s.id)}" onclick="openSessionInline('${escapeHtml(s.id)}','${escapeHtml(s.kind || 'terminal')}')">
      <span class="dot ${statusCls}" id="sess-status-${escapeHtml(s.id)}" title="${escapeHtml(statusText)}"></span>
      <div class="lean-main">
        <div class="lean-name" title="#${escapeHtml(s.id)}">${escapeHtml(displayName)}<span class="sess-notes" id="sess-notes-${escapeHtml(s.id)}"${pendingNotes > 0 ? '' : ' style="display:none"'}>${pendingNotes > 0 ? '📨 ' + pendingNotes : ''}</span></div>
        <div class="lean-meta">
          <span>${escapeHtml(formatRelative(sessionLastInteractionMs(s) || s.createdAt))}</span>
          ${model ? `<span class="sep">·</span><span class="model" title="模型：${escapeHtml(s.model)}">${escapeHtml(model)}</span>` : ''}
        </div>
        <div class="sess-file" id="sess-file-${escapeHtml(s.id)}"${wbFile ? '' : ' style="display:none"'}>${wbFile ? '✎ ' + escapeHtml(wbFile) : ''}</div>
        <div class="sess-summary" id="sess-summary-${escapeHtml(s.id)}" title="${summary ? '最近任务：' + escapeHtml(summary) : ''}"${summary ? '' : ' style="display:none"'}>${summary ? '🗒 ' + escapeHtml(summary) : ''}</div>
        <div class="sess-runtime" id="sess-runtime-${escapeHtml(s.id)}"${runtimeText ? '' : ' style="display:none"'}>${escapeHtml(runtimeText)}</div>
      </div>
      <span class="lean-actions">
        ${hasConflict ? `<button class="sess-conflict-btn" id="sess-conflict-${escapeHtml(s.id)}" title="${escapeHtml(conflictTitle)}" onclick="event.stopPropagation(); showSyncConflictHelp('${escapeHtml(s.id)}')">⚠️${conflictFiles.length > 0 ? ' ' + conflictFiles.length : ''}</button>` : ''}
        ${mergeReady ? `<button class="sess-merge-btn" id="sess-merge-${escapeHtml(s.id)}" title="${escapeHtml(mergeTitle)} — 点击合并" onclick="event.stopPropagation(); mergeSession('${escapeHtml(s.id)}')">🔀${mergeState.ahead > 0 ? ' ' + mergeState.ahead : ''}</button>` : ''}
        ${openBtn}
        <button class="btn-icon${mergeReady ? ' merge-ready' : ''}" id="sess-menu-${escapeHtml(s.id)}" title="${escapeHtml(mergeReady ? tt('moreSessionActionsReady', { detail: mergeTitle }) : tt('moreSessionActions'))}" onclick="event.stopPropagation(); showSessionMenu(event, '${escapeHtml(s.id)}')">⋯</button>
      </span>
    </div>`;
}

function renderOrphans(sessions) {
  // Edge case: sessions without a directory (shouldn't happen post-migration)
  return `
    <div class="dir-block open">
      <div class="dir-header">
        <span class="dir-name">(Orphan sessions)</span>
        <span class="dir-path">— no directory assigned</span>
      </div>
      <div class="dir-body">
        ${sessions.map(s => renderSessionRow(s)).join('')}
      </div>
    </div>`;
}

/* ── Directory management ── */
function openNewDirectoryModal() {
  const modal = document.getElementById('newdir-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  document.getElementById('newdir-name').value = '';
  document.getElementById('newdir-path').value = '';
  document.getElementById('newdir-error').style.display = 'none';
  const sg = document.getElementById('newdir-suggest');
  if (sg) { sg.style.display = 'none'; sg.innerHTML = ''; }
  const cc = document.getElementById('newdir-create');
  if (cc) cc.checked = false;
  _newDirEntries = [];
  setTimeout(() => document.getElementById('newdir-name').focus(), 50);
}

// Filesystem path autocomplete for the "new directory" path field.
let _newDirSuggestTimer = null;
let _newDirEntries = [];
function onNewDirPathInput() {
  clearTimeout(_newDirSuggestTimer);
  _newDirSuggestTimer = setTimeout(fetchNewDirSuggestions, 180);
}
async function fetchNewDirSuggestions() {
  const val = document.getElementById('newdir-path').value;
  const box = document.getElementById('newdir-suggest');
  if (!box) return;
  try {
    const res = await fetch('/api/fs/list?path=' + encodeURIComponent(val) + tokenQS('&'));
    if (!res.ok) { box.style.display = 'none'; return; }
    const data = await res.json();
    renderNewDirSuggestions(data.entries || []);
  } catch (_) { box.style.display = 'none'; }
}
function renderNewDirSuggestions(entries) {
  _newDirEntries = entries;
  const box = document.getElementById('newdir-suggest');
  if (!box) return;
  if (!entries.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.innerHTML = entries.map((e, i) =>
    `<div onclick="pickNewDirSuggestion(${i})" onmouseover="this.style.background='#161b22'" onmouseout="this.style.background='transparent'" style="padding:6px 10px;cursor:pointer;font-family:monospace;font-size:12px;color:#c9d1d9;border-bottom:1px solid #21262d;">📁 ${escapeHtml(e.name)}</div>`
  ).join('');
  box.style.display = 'block';
}
function pickNewDirSuggestion(i) {
  const e = _newDirEntries[i];
  if (!e) return;
  const pathEl = document.getElementById('newdir-path');
  pathEl.value = e.path + '/';
  const nameEl = document.getElementById('newdir-name');
  if (!nameEl.value.trim()) nameEl.value = e.name;
  pathEl.focus();
  fetchNewDirSuggestions();   // drill into the chosen directory
}

function closeNewDirectoryModal() {
  const modal = document.getElementById('newdir-modal');
  if (modal) modal.style.display = 'none';
}

async function submitNewDirectory() {
  const name = document.getElementById('newdir-name').value.trim();
  const dirPath = document.getElementById('newdir-path').value.trim();
  const create = !!document.getElementById('newdir-create')?.checked;
  const errEl = document.getElementById('newdir-error');
  errEl.style.display = 'none';
  if (!name || !dirPath) {
    errEl.textContent = 'Name and path are required';
    errEl.style.display = 'block';
    return;
  }
  try {
    const res = await fetch('/api/directories' + tokenQS('?'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, path: dirPath, create }),
    });
    if (!res.ok) {
      const err = await res.json();
      errEl.textContent = err.error || `HTTP ${res.status}`;
      errEl.style.display = 'block';
      return;
    }
    const dir = await res.json();
    _expandedDirs.add(dir.id);
    closeNewDirectoryModal();
    showToast(`Directory "${dir.name}" created`);
    loadDashboard();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

// ── Per-directory memo (multicc.memo.md, plain markdown) ──
let _memoDirId = null;

function openMemo(dirId) {
  const dir = (_cachedDirectories || []).find(d => d.id === dirId);
  if (!dir) { showToast('Directory not found', true); return; }
  _memoDirId = dirId;
  const modal = document.getElementById('memo-modal');
  const ta = document.getElementById('memo-text');
  const statusEl = document.getElementById('memo-status');
  document.getElementById('memo-title').textContent = `📝 ${dir.name} · 备忘`;
  document.getElementById('memo-subtitle').textContent = '加载中…';
  ta.value = '';
  statusEl.textContent = '';
  modal.style.display = 'flex';
  // Ctrl/Cmd+S to save
  ta.onkeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      memoSave();
    }
  };
  fetch(`/api/directories/${encodeURIComponent(dirId)}/memo${tokenQS('?')}`)
    .then(r => r.json())
    .then(data => {
      ta.value = data.text || '';
      document.getElementById('memo-subtitle').textContent =
        `${data.path || ''}${data.exists ? '' : ' · 文件尚未创建（保存即创建）'}`;
      ta.focus();
    })
    .catch(e => {
      document.getElementById('memo-subtitle').textContent = '加载失败：' + e.message;
    });
}

function closeMemoModal() {
  const ta = document.getElementById('memo-text');
  if (ta) ta.onkeydown = null;
  document.getElementById('memo-modal').style.display = 'none';
  memoPickerClose();
  _memoDirId = null;
}

async function memoSave() {
  if (!_memoDirId) return;
  const text = document.getElementById('memo-text').value;
  const statusEl = document.getElementById('memo-status');
  statusEl.textContent = '保存中…';
  try {
    const res = await fetch(`/api/directories/${encodeURIComponent(_memoDirId)}/memo${tokenQS('?')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      statusEl.textContent = '保存失败：' + (err.error || res.status);
      return;
    }
    statusEl.textContent = `已保存 · ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    statusEl.textContent = '保存失败：' + e.message;
  }
}

// Pull the cursor's line text out of the textarea, stripped of a leading
// markdown list/checkbox marker so what we send is just the task content.
function memoCurrentLineText() {
  const ta = document.getElementById('memo-text');
  if (!ta) return '';
  const v = ta.value;
  const pos = ta.selectionStart;
  const before = v.lastIndexOf('\n', Math.max(0, pos - 1));
  const after = v.indexOf('\n', pos);
  const start = before === -1 ? 0 : before + 1;
  const end = after === -1 ? v.length : after;
  let line = v.slice(start, end);
  line = line.replace(/^\s*[-*+]\s+\[[ xX]\]\s*/, '');   // - [ ] / - [x]
  line = line.replace(/^\s*[-*+]\s+/, '');                // - / * / +
  line = line.replace(/^\s*\d+\.\s+/, '');                // 1.
  line = line.replace(/^\s*#+\s+/, '');                   // headings
  return line.trim();
}

function memoSendCurrentLine() {
  if (!_memoDirId) return;
  const text = memoCurrentLineText();
  const statusEl = document.getElementById('memo-status');
  if (!text) { statusEl.textContent = '当前行为空，无法发送'; return; }
  const sessions = (_cachedSessions || [])
    .filter(s => s.dirId === _memoDirId && s.kind === 'chat' && s.type !== 'aux' && s.type !== 'gateway');
  if (!sessions.length) {
    statusEl.textContent = '该目录还没有 chat 会话，请先新建一个';
    return;
  }
  const preview = text.length > 120 ? text.slice(0, 120) + '…' : text;
  document.getElementById('memo-picker-preview').textContent = preview;
  const listEl = document.getElementById('memo-picker-list');
  listEl.innerHTML = sessions.map(s => {
    const cs = _sessionStatus.get(s.id);
    const status = (cs && cs.status) || (s.active ? 'active' : 'idle');
    const label = s.label && s.label !== s.id ? `${escapeHtml(s.label)} <span style="color:#6e7681;">${escapeHtml(s.id)}</span>` : escapeHtml(s.id);
    const safeId = escapeHtml(s.id).replace(/'/g, "\\'");
    return `<button class="btn" style="text-align:left;padding:8px 10px;display:flex;justify-content:space-between;gap:10px;" onclick="memoConfirmSend('${safeId}')"><span style="overflow:hidden;text-overflow:ellipsis;">${label}</span><span style="color:#6e7681;font-size:11px;flex-shrink:0;">${escapeHtml(status)}</span></button>`;
  }).join('');
  document.getElementById('memo-picker').style.display = 'flex';
}

function memoPickerClose() {
  const p = document.getElementById('memo-picker');
  if (p) p.style.display = 'none';
}

async function memoConfirmSend(sessionId) {
  if (!_memoDirId) return;
  const text = memoCurrentLineText();
  if (!text) return;
  memoPickerClose();
  const statusEl = document.getElementById('memo-status');
  statusEl.textContent = `发送到 ${sessionId}…`;
  try {
    const res = await fetch(`/api/directories/${encodeURIComponent(_memoDirId)}/memo/send${tokenQS('?')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sessionId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      statusEl.textContent = '发送失败：' + (err.error || res.status);
      return;
    }
    statusEl.textContent = `已发送到 ${sessionId} · ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    statusEl.textContent = '发送失败：' + e.message;
  }
}

async function renameDirectory(id) {
  const dir = _cachedDirectories.find(d => d.id === id);
  if (!dir) return;
  const next = await showPrompt('重命名目录', dir.name || '');
  if (next === null) return;
  const name = next.trim();
  if (!name) { showToast('名称不能为空', true); return; }
  if (name.length > 80) { showToast('名称过长（最多 80 字）', true); return; }
  try {
    const res = await fetch(`/api/directories/${id}${tokenQS('?')}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) { const err = await res.json(); showToast(`Error: ${err.error || res.status}`, true); return; }
    showToast(`已重命名为 ${name}`);
    loadDashboard();
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  }
}

async function deleteDirectory(id) {
  const dir = _cachedDirectories.find(d => d.id === id);
  if (!dir) return;
  const hasSessions = _cachedSessions.some(s => s.dirId === id);
  const msg = hasSessions
    ? `Delete "${dir.name}" and ALL its sessions? This cannot be undone.`
    : `Delete empty directory "${dir.name}"?`;
  if (!(await showConfirm(msg, { danger: true, okText: '删除' }))) return;
  try {
    const qs = tokenQS('?');
    const url = `/api/directories/${id}${qs}${qs ? '&' : '?'}force=1`;
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json();
      showToast(`Error: ${err.error}`, true);
      return;
    }
    showToast(`Directory "${dir.name}" deleted`);
    _expandedDirs.delete(id);
    loadDashboard();
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  }
}

// Claude model choices for new sessions. value '' = follow the user's /model default.
const CLAUDE_MODEL_OPTIONS = [
  { value: '', labelKey: 'defaultClaudeSetting' },
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'claude-fable-5[1m]', label: 'Fable 5 (1M context)' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: '__custom__', labelKey: 'custom' },
];

function modelShortName(model) {
  const opt = CLAUDE_MODEL_OPTIONS.find(o => o.value === model);
  return opt ? (opt.labelKey ? tt(opt.labelKey) : opt.label) : model;
}

// WebView-safe model picker (same pattern as _dialog). Resolves to '' (default),
// a model string, or null (cancelled).
function showModelPicker({ title = tt('modelTitle'), okText = tt('create'), current = '' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:380px;max-width:94vw;';
    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:14px;color:#c9d1d9;line-height:1.6;margin-bottom:12px;';
    msg.textContent = title;
    box.appendChild(msg);

    const isKnown = CLAUDE_MODEL_OPTIONS.some(o => o.value === current);
    const select = document.createElement('select');
    select.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;';
    for (const o of CLAUDE_MODEL_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = o.value; opt.textContent = o.labelKey ? tt(o.labelKey) : o.label;
      select.appendChild(opt);
    }
    select.value = isKnown ? current : '__custom__';
    box.appendChild(select);

    const custom = document.createElement('input');
    custom.type = 'text';
    custom.placeholder = '模型 ID，如 claude-opus-4-8';
    custom.value = isKnown ? '' : current;
    custom.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;display:none;';
    box.appendChild(custom);
    const syncCustom = () => {
      custom.style.display = select.value === '__custom__' ? '' : 'none';
    };
    syncCustom();
    select.onchange = () => { syncCustom(); if (select.value === '__custom__') custom.focus(); };

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const cancel = document.createElement('button');
    cancel.className = 'btn'; cancel.textContent = tt('cancel');
    const ok = document.createElement('button');
    ok.className = 'btn btn-green'; ok.textContent = okText;
    row.appendChild(cancel); row.appendChild(ok);
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = (result) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(result);
    };
    const accept = () => close(select.value === '__custom__' ? custom.value.trim() : select.value);
    const reject = () => close(null);
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); reject(); }
      else if (e.key === 'Enter') { e.preventDefault(); accept(); }
    }
    ok.onclick = accept;
    cancel.onclick = reject;
    overlay.onclick = (e) => { if (e.target === overlay) reject(); };
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => select.focus(), 0);
  });
}

async function newSessionInDir(dirId, cli, kind) {
  // Single dialog: name + role + provider + model
  let providers = [];
  try {
    const appType = cli === 'codex' ? 'codex' : 'claude';
    const pres = await fetch(`/api/providers?appType=${appType}${tokenQS('&')}`);
    if (pres.ok) {
      const data = await pres.json();
      providers = data.providers || [];
    }
  } catch (_) {}

  const result = await showCreateSessionDialog({
    cli, kind, providers,
    isClaude: cli === 'claude',
  });
  if (result === null) return; // cancelled

  const { label, rolePrompt, provider, model } = result;

  try {
    const body = { cli, kind };
    if (label.trim()) body.label = label.trim();
    if (model) body.model = model;
    if (provider !== null && provider !== undefined && provider !== '') body.provider = provider;
    if (rolePrompt.trim()) body.rolePrompt = rolePrompt.trim();

    const res = await fetch(`/api/directories/${dirId}/sessions${tokenQS('?')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json();
      showToast(`Error: ${err.error}`, true);
      return;
    }
    const sess = await res.json();
    showToast(`Created ${cli} ${kind}: ${sess.id}`);
    _expandedDirs.add(dirId);
    await loadDashboard();
    // Open it immediately
    openSessionInline(sess.id, sess.kind);
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  }
}

// Single unified creation dialog (name + role + provider + model)
function showCreateSessionDialog({ cli, kind, providers = [], isClaude = true }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:440px;max-width:94vw;max-height:90vh;overflow-y:auto;';

    const title = document.createElement('div');
    title.style.cssText = 'font-size:15px;color:#f2f4f7;font-weight:600;margin-bottom:14px;';
    title.textContent = `新建 ${cli === 'codex' ? 'Codex' : 'Claude'} ${kind === 'chat' ? 'Chat' : 'Terminal'}`;
    box.appendChild(title);

    // ── Name input ──
    const nameLabel = document.createElement('div');
    nameLabel.style.cssText = 'font-size:11px;color:#8b949e;margin-bottom:4px;';
    nameLabel.textContent = '会话名称（可选）';
    box.appendChild(nameLabel);
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = '留空自动生成';
    nameInput.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;box-sizing:border-box;';
    box.appendChild(nameInput);

    // ── Role prompt ──
    const roleLabel = document.createElement('div');
    roleLabel.style.cssText = 'font-size:11px;color:#8b949e;margin-bottom:4px;';
    roleLabel.textContent = '角色提示词（可选）';
    box.appendChild(roleLabel);
    const roleInput = document.createElement('textarea');
    roleInput.placeholder = '留空则继承目录默认角色';
    roleInput.rows = 3;
    roleInput.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;resize:vertical;font-family:inherit;box-sizing:border-box;';
    box.appendChild(roleInput);

    // ── Provider select ──
    const provLabel = document.createElement('div');
    provLabel.style.cssText = 'font-size:11px;color:#8b949e;margin-bottom:4px;';
    provLabel.textContent = 'Provider';
    box.appendChild(provLabel);
    const provSelect = document.createElement('select');
    provSelect.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;box-sizing:border-box;';
    const defOpt = document.createElement('option');
    defOpt.value = ''; defOpt.textContent = '默认登录 / 订阅（不覆盖）';
    provSelect.appendChild(defOpt);
    providers.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name + (p.isOfficial ? ' · 订阅' : '') + (p.model ? ' · ' + p.model : '');
      provSelect.appendChild(opt);
    });
    box.appendChild(provSelect);

    // ── Model select (claude only) ──
    let modelSelect = null, modelCustom = null;
    if (isClaude) {
      const modelLabel = document.createElement('div');
      modelLabel.style.cssText = 'font-size:11px;color:#8b949e;margin-bottom:4px;';
      modelLabel.textContent = '模型';
      box.appendChild(modelLabel);
      modelSelect = document.createElement('select');
      modelSelect.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:6px;box-sizing:border-box;';
      for (const o of CLAUDE_MODEL_OPTIONS) {
        const opt = document.createElement('option');
        opt.value = o.value; opt.textContent = o.labelKey ? tt(o.labelKey) : o.label;
        modelSelect.appendChild(opt);
      }
      box.appendChild(modelSelect);

      modelCustom = document.createElement('input');
      modelCustom.type = 'text';
      modelCustom.placeholder = '模型 ID，如 claude-opus-4-8';
      modelCustom.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;display:none;box-sizing:border-box;';
      box.appendChild(modelCustom);
      const syncCustom = () => { modelCustom.style.display = modelSelect.value === '__custom__' ? '' : 'none'; };
      syncCustom();
      modelSelect.onchange = () => { syncCustom(); if (modelSelect.value === '__custom__') modelCustom.focus(); };
    }

    // ── Buttons ──
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:4px;';
    const cancel = document.createElement('button');
    cancel.className = 'btn'; cancel.textContent = tt('cancel');
    const ok = document.createElement('button');
    ok.className = 'btn btn-green'; ok.textContent = tt('create');
    row.appendChild(cancel); row.appendChild(ok);
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    nameInput.focus();

    const close = (result) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(result);
    };
    const accept = () => {
      let model = null;
      if (isClaude) {
        model = modelSelect.value === '__custom__' ? modelCustom.value.trim() : modelSelect.value;
      }
      close({
        label: nameInput.value,
        rolePrompt: roleInput.value,
        provider: provSelect.value,
        model: model || null,
      });
    };
    const reject = () => close(null);
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); reject(); }
      else if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); accept(); }
    }
    ok.onclick = accept;
    cancel.onclick = reject;
    overlay.onclick = (e) => { if (e.target === overlay) reject(); };
    document.addEventListener('keydown', onKey, true);
  });
}

async function changeSessionModel(id) {
  const sess = _cachedSessions.find(s => s.id === id);
  if (!sess) return;
  const picked = await showModelPicker({
    title: tt('modelTitle'),
    okText: tt('save'),
    current: sess.model || '',
  });
  if (picked === null) return; // cancelled
  try {
    const res = await fetch(`/api/sessions/${id}${tokenQS('?')}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: picked }),
    });
    if (!res.ok) {
      const err = await res.json();
      showToast(`Error: ${err.error}`, true);
      return;
    }
    const hint = sess.kind === 'terminal' ? '（重启会话后生效）' : '（下一轮对话生效）';
    showToast(`模型已切换为 ${modelShortName(picked)} ${hint}`);
    loadDashboard();
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  }
}

// WebView-safe multi-line role-prompt editor. Resolves to the entered text
// (empty string = clear), or null when cancelled.
function showRoleEditor({ title, current = '', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:560px;max-width:94vw;';
    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:14px;color:#c9d1d9;line-height:1.6;margin-bottom:10px;';
    msg.textContent = title;
    box.appendChild(msg);

    const ta = document.createElement('textarea');
    ta.value = current || '';
    ta.placeholder = placeholder;
    ta.rows = 8;
    ta.style.cssText = 'width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;line-height:1.5;padding:10px;outline:none;resize:vertical;margin-bottom:6px;font-family:inherit;';
    box.appendChild(ta);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;color:#8b949e;margin-bottom:12px;';
    hint.textContent = '留空＝清除（会话将继承目录默认角色）。Ctrl/⌘+Enter 保存。';
    box.appendChild(hint);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const cancel = document.createElement('button');
    cancel.className = 'btn'; cancel.textContent = '取消';
    const ok = document.createElement('button');
    ok.className = 'btn btn-green'; ok.textContent = '保存';
    row.appendChild(cancel); row.appendChild(ok);
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = (result) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(result);
    };
    const accept = () => {
      if (ta.value.length > 8000) { showToast('角色提示词过长（上限 8000 字）', true); return; }
      close(ta.value);
    };
    const reject = () => close(null);
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); reject(); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); accept(); }
    }
    ok.onclick = accept;
    cancel.onclick = reject;
    overlay.onclick = (e) => { if (e.target === overlay) reject(); };
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => ta.focus(), 0);
  });
}

async function changeSessionRole(id) {
  const sess = _cachedSessions.find(s => s.id === id);
  if (!sess) return;
  const next = await showRoleEditor({
    title: `会话角色提示词 — ${sess.label || sess.id}`,
    current: sess.rolePrompt || '',
    placeholder: '例如：你是开发保姆，被触发时用 multicc-trigger skill 检查 git 改动并提醒提交和测试，不要擅自改代码。',
  });
  if (next === null) return; // cancelled
  try {
    const res = await fetch(`/api/sessions/${id}${tokenQS('?')}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rolePrompt: next }),
    });
    if (!res.ok) { const err = await res.json(); showToast(`Error: ${err.error}`, true); return; }
    const hint = (sess.cli || 'claude') === 'codex' ? '（Codex 仅新会话首轮生效）' : '（下一轮对话生效）';
    showToast(`${next.trim() ? '角色已更新' : '已清除会话角色（继承目录默认）'} ${hint}`);
    loadDashboard();
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  }
}

async function changeDirectoryRole(id) {
  const dir = (_cachedDirectories || []).find(d => d.id === id);
  if (!dir) return;
  const next = await showRoleEditor({
    title: `目录默认角色 — ${dir.name}`,
    current: dir.rolePrompt || '',
    placeholder: '该目录下所有会话的默认角色。单个会话可在「角色提示词」里单独覆盖。',
  });
  if (next === null) return;
  try {
    const res = await fetch(`/api/directories/${id}${tokenQS('?')}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rolePrompt: next }),
    });
    if (!res.ok) { const err = await res.json(); showToast(`Error: ${err.error}`, true); return; }
    showToast(`${next.trim() ? '目录默认角色已更新' : '已清除目录默认角色'}（对未单独设角色的会话下一轮生效）`);
    loadDashboard();
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  }
}

async function renameSession(id) {
  const sess = _cachedSessions.find(s => s.id === id);
  if (!sess) return;
  const next = await showPrompt('Rename session', sess.label || sess.id);
  if (next === null) return;
  const label = next.trim();
  if (label.length > 80) {
    showToast('Name is too long (max 80 chars)', true);
    return;
  }
  try {
    const res = await fetch(`/api/sessions/${id}${tokenQS('?')}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    });
    if (!res.ok) {
      const err = await res.json();
      showToast(`Error: ${err.error || res.status}`, true);
      return;
    }
    showToast(label ? `Renamed to ${label}` : 'Session name reset');
    await loadDashboard();
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  }
}

/* ── Session iframe pool: hot-start cache ── */
const MAX_CACHED_IFRAMES = 6;
const _sessionIframePool = new Map(); // sessionId → { iframe, lastUsed }
const _sessionIframeBody = document.getElementById('session-modal-body');

function _getOrCreateSessionIframe(id, kind) {
  // Return cached if still alive
  const cached = _sessionIframePool.get(id);
  if (cached && cached.iframe && cached.iframe.parentNode) {
    cached.lastUsed = Date.now();
    return cached.iframe;
  }

  // Evict least recently used if at capacity
  if (_sessionIframePool.size >= MAX_CACHED_IFRAMES) {
    let oldestId = null, oldest = Infinity;
    for (const [sid, entry] of _sessionIframePool) {
      if (sid === _currentSessionModalId) continue; // don't evict the currently shown one
      if (entry.lastUsed < oldest) { oldest = entry.lastUsed; oldestId = sid; }
    }
    if (oldestId) {
      const evicted = _sessionIframePool.get(oldestId);
      if (evicted && evicted.iframe && evicted.iframe.parentNode) {
        evicted.iframe.remove();
      }
      _sessionIframePool.delete(oldestId);
    }
  }

  // Create new iframe
  const iframe = document.createElement('iframe');
  iframe.sandbox = 'allow-same-origin allow-scripts allow-forms allow-popups';
  iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:none;background:#0d1117;';

  const urlToken = new URLSearchParams(location.search).get('token');
  const tokenParam = urlToken ? (kind === 'chat' ? `&token=${urlToken}` : `&token=${urlToken}`) : '';

  if (kind === 'chat') {
    iframe.src = `/chat.html?session=${id}${tokenParam}`;
  } else {
    iframe.src = `/?id=${id}${tokenParam}`;
  }

  _sessionIframeBody.appendChild(iframe);
  _sessionIframePool.set(id, { iframe, lastUsed: Date.now(), kind });
  return iframe;
}

/* ── Session view modal (large centered modal) ── */
const sessionModal = document.getElementById('session-modal');
const sessionModalTitle = document.getElementById('session-modal-title');
const sessionModalSubtitle = document.getElementById('session-modal-subtitle');
const sessionModalNewtab = document.getElementById('session-modal-newtab');
let _currentSessionModalId = null;
let _currentSessionModalKind = null;

function openSessionModal(id) {
  const s = _cachedSessions.find(sess => sess.id === id);
  if (!s) return;

  acknowledgeSession(id);
  const kind = s.kind || 'terminal';

  // Set title
  sessionModalTitle.textContent = kind === 'chat' ? '💬 Chat Session' : '🖥 Terminal Session';
  sessionModalSubtitle.textContent = `#${id} · ${s.cwd || ''}`;

  // Hide all pooled iframes first
  for (const [, entry] of _sessionIframePool) {
    if (entry.iframe && entry.iframe.style) entry.iframe.style.display = 'none';
  }

  // Get or create the iframe for this session, show it
  const iframe = _getOrCreateSessionIframe(id, kind);
  iframe.style.display = '';

  _currentSessionModalId = id;
  _currentSessionModalKind = kind;

  // Show modal
  sessionModal.classList.add('visible');
}

function closeSessionModal() {
  sessionModal.classList.remove('visible');
  // Do NOT clear src or remove iframe — just hide modal;
  // iframes stay cached for hot restart.
  // The title/subtitle will be overwritten on next open.
}

sessionModalNewtab.addEventListener('click', () => {
  if (_currentSessionModalId) {
    if (_currentSessionModalKind === 'chat') {
      openSessionChat(_currentSessionModalId);
    } else {
      openSessionNewTab(_currentSessionModalId);
    }
  }
});

// Route an inline-open request: open in large centered modal
function openSessionInline(id, kind) {
  openSessionModal(id);
}

/* ── Focus panel: embed terminal iframe (kept for aux history view) ── */
const focusPanel   = document.getElementById('focus-panel');
const focusIframe  = document.getElementById('focus-iframe');
const focusId      = document.getElementById('focus-id');
const focusCwd     = document.getElementById('focus-cwd');
const focusNewtab  = document.getElementById('focus-newtab');
const focusCloseBtn = document.getElementById('focus-close');

// Iframe pool: cache loaded session iframes to avoid re-loading on switch
const _iframeCache = new Map(); // sessionId → iframe element
const focusContainer = focusIframe.parentElement;

function getOrCreateIframe(id) {
  if (_iframeCache.has(id)) return _iframeCache.get(id);
  const urlToken = new URLSearchParams(location.search).get('token');
  const tokenParam = urlToken ? `&token=${urlToken}` : '';

  // Determine session kind to set appropriate URL
  const s = _cachedSessions.find(sess => sess.id === id);
  const kind = s?.kind || 'terminal';

  const iframe = document.createElement('iframe');
  iframe.className = focusIframe.className;
  iframe.id = '';
  iframe.dataset.sessionId = id;
  iframe.dataset.sessionKind = kind;
  iframe.sandbox = focusIframe.sandbox.toString();
  iframe.style.cssText = 'flex:1;border:none;width:100%;height:100%;background:#0d1117;display:none;';

  // Chat sessions use /chat.html, terminal sessions use /?id=
  if (kind === 'chat') {
    iframe.src = `/chat.html?session=${id}${tokenParam.replace('&', '&')}`;
  } else {
    iframe.src = `/?id=${id}${tokenParam}`;
  }

  focusContainer.appendChild(iframe);
  _iframeCache.set(id, iframe);
  return iframe;
}

function focusSession(id) {
  const s = _cachedSessions.find(s => s.id === id);
  if (!s) return;

  acknowledgeSession(id);

  if (_focusedSessionId === id) return;
  _focusedSessionId = id;

  document.body.classList.add('has-focus');
  focusId.textContent = '#' + id;
  focusCwd.textContent = s.cwd || '';
  focusCwd.title = s.cwd || '';

  // Hide all cached iframes + the original placeholder
  focusIframe.style.display = 'none';
  for (const [, frame] of _iframeCache) frame.style.display = 'none';

  // Show (or create) the iframe for this session
  const frame = getOrCreateIframe(id);
  frame.style.display = '';

  renderSessions(_cachedSessions);
}

function closeFocusPanel() {
  _focusedSessionId = null;
  document.body.classList.remove('has-focus');
  // Just hide, don't destroy
  for (const [, frame] of _iframeCache) frame.style.display = 'none';
  renderSessions(_cachedSessions);
}

focusCloseBtn.addEventListener('click', closeFocusPanel);
focusNewtab.addEventListener('click', () => {
  if (_focusedSessionId) openSessionNewTab(_focusedSessionId);
});

function openSessionNewTab(id) {
  const urlToken = new URLSearchParams(location.search).get('token');
  const tokenParam = urlToken ? `?token=${urlToken}&id=${id}` : `?id=${id}`;
  window.open(`/${tokenParam}`, '_blank');
  acknowledgeSession(id);
}

function openSessionChat(id, _cwd) {
  // cwd is ignored now — server derives it from the session's directory
  const urlToken = new URLSearchParams(location.search).get('token');
  const params = new URLSearchParams();
  if (urlToken) params.set('token', urlToken);
  params.set('session', id);
  window.open(`/chat.html?${params.toString()}`, '_blank');
}

async function deleteSession(id) {
  if (!(await showConfirm(`Delete session ${id}?\nThe PTY process will be terminated.`, { danger: true, okText: '删除' }))) return;
  try {
    const res = await fetch(`/api/sessions/${id}` + tokenQS('?'), { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json();
      showToast(`Error: ${err.error}`, true);
      return;
    }
    showToast(`Session ${id} deleted`);
    // Clean up cached iframes (both focus panel and session modal pool)
    const cachedFrame = _iframeCache.get(id);
    if (cachedFrame) { cachedFrame.remove(); _iframeCache.delete(id); }
    const poolEntry = _sessionIframePool.get(id);
    if (poolEntry && poolEntry.iframe && poolEntry.iframe.parentNode) { poolEntry.iframe.remove(); _sessionIframePool.delete(id); }
    if (_focusedSessionId === id) closeFocusPanel();
    if (_currentSessionModalId === id) { _currentSessionModalId = null; _currentSessionModalKind = null; }
    loadSessions();
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  }
}

async function showDiff(sessionId) {
  const modal = document.getElementById('diff-modal');
  const titleEl = document.getElementById('diff-title');
  const subEl = document.getElementById('diff-subtitle');
  const statEl = document.getElementById('diff-stat');
  const contentEl = document.getElementById('diff-content');
  if (!modal) return;
  titleEl.textContent = `Diff · ${sessionId}`;
  subEl.textContent = '加载中…';
  statEl.textContent = '';
  contentEl.innerHTML = '';
  modal.style.display = 'flex';
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/diff${tokenQS('?')}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      subEl.textContent = `错误：${err.error || res.status}`;
      return;
    }
    const data = await res.json();
    const ms = data.mergeState || {};
    const parts = [];
    if (data.branch) parts.push(`${data.branch} → ${data.baseBranch || ''}`);
    parts.push(`${ms.ahead || 0} 个提交领先`);
    if (ms.dirty) parts.push('含未提交改动');
    if (data.truncated) parts.push('已截断到 1MB');
    subEl.textContent = parts.join(' · ');
    statEl.textContent = (data.stat || '').trim() || '(无变更)';
    contentEl.innerHTML = renderDiffLines(data.diff || '');
    if (data.error) {
      const errLine = document.createElement('div');
      errLine.className = 'diff-line diff-del';
      errLine.textContent = `错误：${data.error}`;
      contentEl.appendChild(errLine);
    }
  } catch (e) {
    subEl.textContent = `请求失败：${e.message}`;
  }
}

function closeDiffModal() {
  const modal = document.getElementById('diff-modal');
  if (modal) modal.style.display = 'none';
}

function showMergeConflictDiff(sessionId, data) {
  const modal = document.getElementById('diff-modal');
  if (!modal) return;
  const conflicts = data.conflicts || [];
  document.getElementById('diff-title').textContent = `合并冲突 · ${sessionId}`;
  document.getElementById('diff-subtitle').textContent =
    `${conflicts.length} 个冲突文件 · 合并已 abort，基分支未改动${data.conflictDiffTruncated ? ' · Diff 已截断' : ''}`;
  document.getElementById('diff-stat').textContent = conflicts.join('\n') || '(未获取到冲突文件)';
  document.getElementById('diff-content').innerHTML = renderDiffLines(data.conflictDiff || '');
  modal.style.display = 'flex';
}

function renderDiffLines(text) {
  if (!text || !text.trim()) {
    return '<div class="diff-line diff-meta" style="text-align:center;padding:24px;">（无变更）</div>';
  }
  const MAX_LINES = 5000;
  const lines = text.split('\n');
  const truncated = lines.length > MAX_LINES;
  const arr = truncated ? lines.slice(0, MAX_LINES) : lines;
  const parts = [];
  for (const raw of arr) {
    let cls = 'diff-line';
    if (/^[+\- ]*(<<<<<<<|=======|>>>>>>>)/.test(raw)) {
      cls += ' diff-conflict';
    } else if (raw.startsWith('diff --git') || raw.startsWith('diff --cc') || raw.startsWith('index ') || raw.startsWith('+++ ') || raw.startsWith('--- ') || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('rename ') || raw.startsWith('similarity ')) {
      cls += ' diff-head';
    } else if (raw.startsWith('@@')) cls += ' diff-hunk';
    else if (raw.startsWith('+')) cls += ' diff-add';
    else if (raw.startsWith('-')) cls += ' diff-del';
    const safe = escapeHtml(raw);
    parts.push(`<span class="${cls}">${safe || '&nbsp;'}</span>`);
  }
  if (truncated) {
    parts.push(`<span class="diff-line diff-meta">… 行数过多已截断（${lines.length - MAX_LINES} 行省略）</span>`);
  }
  return parts.join('');
}

async function mergeSession(id) {
  if (!(await showConfirm(`把会话 ${id} 的 worktree 合并回基分支？\n未提交的改动会先自动提交。`, { okText: '合并' }))) return;
  try {
    const res = await fetch(`/api/sessions/${id}/merge` + tokenQS('?'), { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.merged ? `已合并 ${data.commits} 个提交回基分支` : (data.message || '没有新提交需要合并'));
      const prev = _workspaceStatus.get(id) || {};
      _workspaceStatus.set(id, { ...prev, mergeState: { ...(prev.mergeState || {}), mergeReady: false, dirty: false, ahead: 0 } });
      updateSessionMergeDom(id);
      await loadDashboard();
    } else if (res.status === 409) {
      showToast(`合并冲突，已 abort：${(data.conflicts || []).join(', ')}`, true);
      showMergeConflictDiff(id, data);
    } else {
      showToast(`合并失败：${data.error || res.status}`, true);
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  }
}

/* ── Sync conflict (parked rebase) help + resolve controls ── */
async function showSyncConflictHelp(id) {
  const st = _workspaceStatus.get(id);
  const ms = st?.mergeState || {};
  const files = ms.conflictFiles || [];
  const wt = (_cachedSessions.find(s => s.id === id) || {}).worktreePath || '<worktree>';
  const msg = `会话 ${id} 同步时与基分支发生冲突，rebase 已暂停。\n\n` +
    `冲突文件（${files.length}）：\n${files.map(f => '  · ' + f).join('\n') || '  (无)'}\n\n` +
    `手动解决步骤：\n` +
    `1. 进入 worktree：cd ${wt}\n` +
    `2. 编辑上面的文件，消除 <<<<<<< / ======= / >>>>>>> 冲突标记\n` +
    `3. 解决后点「继续」（= git add -A && git rebase --continue）\n\n` +
    `点「继续」表示已解决；点「取消」可暂时关闭。`;
  // Primary path: user resolved → continue. Cancel just closes; aborting the
  // rebase is offered as an explicit follow-up so it can't happen by accident.
  const cont = await showConfirm(msg, { okText: '继续', cancelText: '取消' });
  if (cont) { await resolveRebase(id, 'continue'); return; }
  const abort = await showConfirm(
    `要放弃这次同步、把 worktree 回滚到同步前的状态吗？\n（git rebase --abort，本地已提交的改动不受影响）`,
    { okText: '放弃 rebase', cancelText: '保留冲突现场', danger: true });
  if (abort) await resolveRebase(id, 'abort');
}

async function resolveRebase(id, action) {
  try {
    const res = await fetch(`/api/sessions/${id}/rebase` + tokenQS('?'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const data = await res.json();
    if (res.ok) {
      if (data.aborted) showToast('已放弃 rebase，worktree 回到同步前状态');
      else if (data.done) showToast('冲突已解决，同步完成');
      else showToast('rebase 已继续');
      await loadDashboard();
    } else if (res.status === 409) {
      showToast(`仍有冲突未解决：${(data.conflicts || []).join(', ')}`, true);
    } else {
      showToast(`操作失败：${data.error || res.status}`, true);
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  }
}

/* ── Workspace status board (live agent statuses per directory) ── */
const _workspaceWs = new Map();        // dirId → WebSocket
const _workspaceStatus = new Map();    // sessionId → { status, currentFile, lastActivity, mergeState }
const _workspaceEvents = new Map();    // dirId → event[]
const _workspaceNotes = new Map();     // sessionId → pending note count
const _workspaceSummaries = new Map(); // sessionId → { summary, ts } — 最近任务 one-liner

function wbStatusInfo(status) {
  switch (status) {
    case 'thinking': return { text: tt('thinking'), cls: 'active' };
    case 'editing':  return { text: tt('editing'), cls: 'active' };
    case 'running':  return { text: tt('running'), cls: 'active' };
    case 'waiting':  return { text: tt('waiting'), cls: 'waiting' };
    case 'completed': return { text: tt('completed'), cls: 'completed' };
    case 'error':    return { text: tt('error'), cls: 'error' };
    default:         return { text: tt('idle'), cls: '' };
  }
}

function connectWorkspace(dirId) {
  if (_workspaceWs.has(dirId)) return;  // idempotent
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let url = `${proto}//${location.host}/ws/workspace?dirId=${encodeURIComponent(dirId)}`;
  if (_urlToken) url += `&token=${_urlToken}`;
  let ws;
  try { ws = new WebSocket(url); } catch (_) { return; }
  _workspaceWs.set(dirId, ws);
  ws.onmessage = ({ data }) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'snapshot') {
      for (const s of msg.sessions) {
        _workspaceStatus.set(s.id, { status: s.status, currentFile: s.currentFile, lastActivity: s.lastActivity, runStartedAt: s.runStartedAt || null, runEndedAt: s.runEndedAt || null, mergeState: s.mergeState || null });
        _workspaceNotes.set(s.id, s.pendingNotes || 0);
        if (s.summary) _workspaceSummaries.set(s.id, { summary: s.summary, ts: s.summaryTs || 0 });
        updateSessionStatusDom(s.id);
        updateSessionNotesDom(s.id);
        updateSessionMergeDom(s.id);
        updateSessionSummaryDom(s.id);
        updateSessionRuntimeDom(s.id);
      }
      _workspaceEvents.set(dirId, msg.events || []);
      updateEventTimelineDom(dirId);
      updateDirPreview(dirId);
      refreshAllCardBorders();
      updateGlobalTaskScroller();
    } else if (msg.type === 'status') {
      _workspaceStatus.set(msg.sessionId, { status: msg.status, currentFile: msg.currentFile, lastActivity: msg.lastActivity, runStartedAt: msg.runStartedAt || null, runEndedAt: msg.runEndedAt || null, mergeState: msg.mergeState || _workspaceStatus.get(msg.sessionId)?.mergeState || null });
      updateSessionStatusDom(msg.sessionId);
      updateSessionMergeDom(msg.sessionId);
      updateSessionRuntimeDom(msg.sessionId);
      refreshAllCardBorders();
      updateGlobalTaskScroller();
    } else if (msg.type === 'merge_status') {
      const prev = _workspaceStatus.get(msg.sessionId) || {};
      _workspaceStatus.set(msg.sessionId, { ...prev, mergeState: msg.mergeState || null });
      updateSessionMergeDom(msg.sessionId);
    } else if (msg.type === 'event') {
      const arr = _workspaceEvents.get(dirId) || [];
      arr.push(msg.event);
      if (arr.length > 200) arr.shift();
      _workspaceEvents.set(dirId, arr);
      updateEventTimelineDom(dirId);
      updateDirPreview(dirId);
    } else if (msg.type === 'note_pending') {
      _workspaceNotes.set(msg.sessionId, msg.count || 0);
      updateSessionNotesDom(msg.sessionId);
    } else if (msg.type === 'summary') {
      _workspaceSummaries.set(msg.sessionId, { summary: msg.summary, ts: msg.ts || 0 });
      updateSessionSummaryDom(msg.sessionId);
      updateDirPreviewForSession(msg.sessionId);
      updateGlobalTaskScroller();
    }
  };
  ws.onclose = () => { if (_workspaceWs.get(dirId) === ws) _workspaceWs.delete(dirId); };
  ws.onerror = () => {};
}

function disconnectWorkspace(dirId) {
  const ws = _workspaceWs.get(dirId);
  if (ws) { try { ws.close(); } catch (_) {} _workspaceWs.delete(dirId); }
}

function updateSessionStatusDom(sessionId) {
  const st = _workspaceStatus.get(sessionId);
  if (!st) return;
  const chip = document.getElementById(`sess-status-${sessionId}`);
  if (chip) {
    const info = wbStatusInfo(st.status);
    chip.className = 'dot ' + info.cls;   // dot conveys status by colour
    chip.title = info.text;               // text on hover
  }
  const fileEl = document.getElementById(`sess-file-${sessionId}`);
  if (fileEl) {
    fileEl.textContent = st.currentFile ? '✎ ' + st.currentFile.split('/').pop() : '';
    fileEl.style.display = st.currentFile ? '' : 'none';
  }
}

function eventLabel(evt) {
  const who = evt.sessionLabel || evt.sessionId || '';
  switch (evt.type) {
    case 'session_created': return `🆕 新建会话 ${who}（${evt.detail || ''}）`;
    case 'session_renamed': return `✏️ 会话改名为 ${evt.detail || who}`;
    case 'session_model_changed': return `🧠 切换模型 ${evt.detail || who}`;
    case 'session_deleted': return `🗑 删除会话 ${evt.detail || who}`;
    case 'merged':          return `🔀 ${who} 合并：${evt.detail || ''}`;
    case 'memory_updated':  return `🧠 ${who} ${evt.detail || '更新会话记忆'}`;
    case 'synced':          return `🔄 ${who} 同步：${evt.detail || ''}`;
    case 'sync_conflict':   return `⚠️ ${who} ${evt.detail || '同步冲突'}`;
    case 'dispatch':        return `📤 ${who} 分发 ${evt.detail || ''}`;
    case 'note':            return `📨 ${who} 留言 ${evt.detail || ''}`;
    case 'note_delivered':  return `📬 ${who}：${evt.detail || ''}`;
    default:                return `· ${evt.type} ${who}`;
  }
}

// Which directories currently have their event timeline expanded. Collapsed by
// default (P0: the "synced…" block used to eat a lot of vertical space). The set
// survives live re-renders so an expanded timeline stays open when new events
// stream in.
const _expandedEvents = new Set();

function renderEventTimeline(dirId) {
  // Modal/card preview: only the 3 most recent events. The full log lives on
  // a standalone page (openEventsPage) so the popup stays compact.
  const allEvents = (_workspaceEvents.get(dirId) || []).slice(-12).reverse();
  const displayEvents = allEvents.slice(0, 3);
  const n = displayEvents.length;
  const total = allEvents.length;

  const rowsHtml = n
    ? displayEvents.map(e => `<div class="wb-event-row"><span class="t">${new Date(e.ts).toLocaleTimeString()}</span> ${escapeHtml(eventLabel(e))}</div>`).join('')
    : '<div class="wb-event-row dim">暂无活动</div>';

  const expandBtnHtml = total > 3
    ? `<button class="btn btn-sm" style="margin-top:8px;font-size:11px;" onclick="event.stopPropagation(); openEventsPage('${escapeHtml(dirId)}')">查看全部 (${total} 条) ↗</button>`
    : '';

  return `<div class="wb-events" id="wb-events-${escapeHtml(dirId)}">
    <div style="padding:8px 10px;background:rgba(0,0,0,0.2);border-radius:8px;margin-bottom:12px;">
      <div style="font-size:12px;color:var(--faint);margin-bottom:6px;">活动</div>
      <div class="wb-events-list" style="display:block;">${rowsHtml}</div>
      ${expandBtnHtml}
    </div>
  </div>`;
}

function openEventsPage(dirId) {
  const qs = _urlToken
    ? `?dirId=${encodeURIComponent(dirId)}&token=${encodeURIComponent(_urlToken)}`
    : `?dirId=${encodeURIComponent(dirId)}`;
  window.open(`events.html${qs}`, '_blank');
}

function updateEventTimelineDom(dirId) {
  const el = document.getElementById(`wb-events-${dirId}`);
  if (el) el.outerHTML = renderEventTimeline(dirId);
}

function updateSessionSummaryDom(sessionId) {
  const el = document.getElementById(`sess-summary-${sessionId}`);
  if (!el) return;
  const s = _workspaceSummaries.get(sessionId);
  const text = s && s.summary ? s.summary : '';
  el.textContent = text ? '🗒 ' + text : '';
  el.title = text ? `最近任务：${text}` : '';
  el.style.display = text ? '' : 'none';
}

// Refresh one session's run-time line from the live workspace status.
function updateSessionRuntimeDom(sessionId) {
  const el = document.getElementById(`sess-runtime-${sessionId}`);
  if (!el) return;
  const text = sessionRunTimeText(sessionId);
  el.textContent = text;
  el.style.display = text ? '' : 'none';
}

// Live ticker: while any session is mid-run the elapsed time must visibly count
// up, so re-render every visible run-time line once a second (cheap; only touches
// existing nodes). Started once on first call.
let _runtimeTicker = null;
function startRuntimeTicker() {
  if (_runtimeTicker) return;
  _runtimeTicker = setInterval(() => {
    const nodes = document.querySelectorAll('[id^="sess-runtime-"]');
    for (const el of nodes) {
      const id = el.id.slice('sess-runtime-'.length);
      const text = sessionRunTimeText(id);
      el.textContent = text;
      el.style.display = text ? '' : 'none';
    }
  }, 1000);
}

function updateSessionNotesDom(sessionId) {
  const el = document.getElementById(`sess-notes-${sessionId}`);
  if (!el) return;
  const n = _workspaceNotes.get(sessionId) || 0;
  el.textContent = n > 0 ? `📨 ${n}` : '';
  el.style.display = n > 0 ? '' : 'none';
}

function updateSessionMergeDom(sessionId) {
  const btn = document.getElementById(`sess-menu-${sessionId}`);
  if (!btn) return;
  const st = _workspaceStatus.get(sessionId);
  const ms = st?.mergeState || {};
  const ready = !!ms.mergeReady;
  btn.classList.toggle('merge-ready', ready);
  btn.title = ready
    ? `可合并：${ms.dirty ? '有未提交改动' : ''}${ms.dirty && ms.ahead > 0 ? '，' : ''}${ms.ahead > 0 ? `${ms.ahead} 个提交领先` : ''}`
    : '把 worktree 合并回基分支';

  // Live-sync the conflict badge (⚠️ N) — a parked rebase conflict that needs
  // manual resolution. Created/removed independently of the merge badge.
  const actionsForConflict = btn.parentElement;
  const hasConflict = !!ms.conflict;
  const conflictFiles = ms.conflictFiles || [];
  let cbadge = document.getElementById(`sess-conflict-${sessionId}`);
  if (hasConflict) {
    const ctitle = `同步冲突：${conflictFiles.length} 个文件待解决（${conflictFiles.slice(0, 5).join(', ')}）— 点击查看如何解决`;
    if (!cbadge) {
      cbadge = document.createElement('button');
      cbadge.className = 'sess-conflict-btn';
      cbadge.id = `sess-conflict-${sessionId}`;
      cbadge.onclick = (e) => { e.stopPropagation(); showSyncConflictHelp(sessionId); };
      actionsForConflict.insertBefore(cbadge, actionsForConflict.firstChild);
    }
    cbadge.textContent = `⚠️${conflictFiles.length > 0 ? ' ' + conflictFiles.length : ''}`;
    cbadge.title = ctitle;
  } else if (cbadge) {
    cbadge.remove();
  }

  // Live-sync the inline merge badge (🔀 N) — create/update/remove to match
  // the current merge state without re-rendering the whole row.
  const actions = btn.parentElement;
  let badge = document.getElementById(`sess-merge-${sessionId}`);
  if (ready) {
    const label = `🔀${ms.ahead > 0 ? ' ' + ms.ahead : ''}`;
    const title = `可合并：${ms.dirty ? '有未提交改动' : ''}${ms.dirty && ms.ahead > 0 ? '，' : ''}${ms.ahead > 0 ? `${ms.ahead} 个提交领先` : ''} — 点击合并`;
    if (!badge) {
      badge = document.createElement('button');
      badge.className = 'sess-merge-btn';
      badge.id = `sess-merge-${sessionId}`;
      badge.onclick = (e) => { e.stopPropagation(); mergeSession(sessionId); };
      actions.insertBefore(badge, actions.firstChild);
    }
    badge.textContent = label;
    badge.title = title;
  } else if (badge) {
    badge.remove();
  }
}

/* ── Leave-a-note modal ── */
function openNoteModal(fromId) {
  const from = _cachedSessions.find(s => s.id === fromId);
  if (!from) return;
  const siblings = _cachedSessions.filter(s =>
    s.dirId === from.dirId && s.id !== fromId && s.type !== 'aux');
  if (!siblings.length) { showToast('该目录下没有其他会话可留言', true); return; }

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:#000000bb;z-index:20000;display:flex;align-items:center;justify-content:center;';
  const opts = siblings.map(s =>
    `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label || s.id)} (${escapeHtml(s.cli)}/${escapeHtml(s.kind)})</option>`).join('');
  overlay.innerHTML = `
    <div style="background:#161b22;border:1px solid #30363d;border-radius:10px;padding:18px;width:440px;max-width:92vw;">
      <div style="font-size:14px;font-weight:600;color:#f0f6fc;margin-bottom:4px;">给同目录 agent 留言</div>
      <div style="font-size:11px;color:#8b949e;margin-bottom:12px;">来自 ${escapeHtml(from.label || from.id)}。留言会在对方下一轮对话开始时送达。</div>
      <select id="note-target" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:7px 9px;margin-bottom:10px;">${opts}</select>
      <textarea id="note-body" rows="4" placeholder="留言内容…" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;resize:vertical;outline:none;"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
        <button class="btn" id="note-cancel">取消</button>
        <button class="btn btn-green" id="note-send">发送</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#note-cancel').onclick = close;
  overlay.querySelector('#note-send').onclick = async () => {
    const toId = overlay.querySelector('#note-target').value;
    const body = overlay.querySelector('#note-body').value.trim();
    if (!body) { showToast('留言内容不能为空', true); return; }
    try {
      const res = await fetch(`/api/sessions/${fromId}/notes` + tokenQS('?'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toSessionId: toId, body }),
      });
      const data = await res.json();
      if (res.ok) { showToast('留言已发送'); close(); }
      else showToast(`发送失败：${data.error || res.status}`, true);
    } catch (err) {
      showToast(`Error: ${err.message}`, true);
    }
  };
}

function newSession() {
  // Legacy: `/` no longer works without an existing session id. Prompt for a directory.
  showToast('Create a directory first, then add sessions to it', true);
  openNewDirectoryModal();
}

function showToast(msg, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.style.background = isError ? '#f85149' : '#238636';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// In-DOM replacements for native prompt()/confirm(): many Android WebViews suppress
// the native JS dialogs (returning null/false), which silently broke rename/delete.
// These work everywhere. Both return a Promise.
function _dialog({ message, value, danger, okText, cancelText, withInput }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:380px;max-width:94vw;';
    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:14px;color:#c9d1d9;line-height:1.6;white-space:pre-wrap;margin-bottom:12px;';
    msg.textContent = message;
    box.appendChild(msg);

    let input = null;
    if (withInput) {
      input = document.createElement('input');
      input.type = 'text';
      input.value = value || '';
      input.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;';
      box.appendChild(input);
    }

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const cancel = document.createElement('button');
    cancel.className = 'btn'; cancel.textContent = cancelText || tt('cancel');
    const ok = document.createElement('button');
    ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-green'); ok.textContent = okText || tt('confirm');
    row.appendChild(cancel); row.appendChild(ok);
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = (result) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(result);
    };
    const accept = () => close(withInput ? input.value : true);
    const reject = () => close(withInput ? null : false);
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); reject(); }
      else if (e.key === 'Enter' && (withInput || document.activeElement === ok)) { e.preventDefault(); accept(); }
    }
    ok.onclick = accept;
    cancel.onclick = reject;
    overlay.onclick = (e) => { if (e.target === overlay) reject(); };
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => { if (input) { input.focus(); input.select(); } else ok.focus(); }, 0);
  });
}
function showConfirm(message, opts = {}) { return _dialog({ message, danger: opts.danger, okText: opts.okText, cancelText: opts.cancelText, withInput: false }); }
function showPrompt(message, value = '', opts = {}) { return _dialog({ message, value, okText: opts.okText, cancelText: opts.cancelText, withInput: true }); }

/* ── Keyboard shortcut: Esc to close focus panel or modal ── */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('newdir-modal');
    if (modal && modal.style.display === 'flex') { closeNewDirectoryModal(); return; }
    if (_focusedSessionId) closeFocusPanel();
  }
  if (e.key === 'Enter') {
    const modal = document.getElementById('newdir-modal');
    if (modal && modal.style.display === 'flex' &&
        (e.target.id === 'newdir-name' || e.target.id === 'newdir-path')) {
      submitNewDirectory();
    }
  }
});

/* ── Voice Settings ── */
async function loadVoiceSettings() {
  try {
    const res = await fetch('/api/settings/voice' + tokenQS('?'));
    const data = await res.json();
    document.getElementById('vs-base-url').value = data.baseUrl || '';
    document.getElementById('vs-api-key').value = '';
    document.getElementById('vs-api-key').placeholder = data.hasKey ? data.apiKey : 'sk-or-v1-...';
    document.getElementById('vs-model').value = data.model || '';
    document.getElementById('ws-base-url').value = data.whisperBaseUrl || '';
    document.getElementById('ws-api-key').value = '';
    document.getElementById('ws-api-key').placeholder = data.hasWhisperKey ? data.whisperApiKey : 'gsk_... (留空则复用 OpenRouter Key)';
    document.getElementById('ws-model').value = data.whisperModel || '';
    document.getElementById('ws-language').value = data.whisperLanguage || 'zh';
    document.getElementById('ws-prompt').value = data.whisperPrompt || '';
  } catch (_) {}
}

async function saveVoiceSettings() {
  const vsStatus = document.getElementById('vs-status');
  const wsStatus = document.getElementById('ws-status');
  const body = {};
  const baseUrl = document.getElementById('vs-base-url').value.trim();
  const apiKey = document.getElementById('vs-api-key').value.trim();
  const model = document.getElementById('vs-model').value.trim();
  if (baseUrl) body.baseUrl = baseUrl;
  if (apiKey) body.apiKey = apiKey;
  if (model) body.model = model;
  const wsBaseUrl = document.getElementById('ws-base-url').value.trim();
  const wsApiKey = document.getElementById('ws-api-key').value.trim();
  const wsModel = document.getElementById('ws-model').value.trim();
  if (wsBaseUrl) body.whisperBaseUrl = wsBaseUrl;
  if (wsApiKey) body.whisperApiKey = wsApiKey;
  if (wsModel) body.whisperModel = wsModel;
  const wsLanguage = document.getElementById('ws-language').value.trim();
  const wsPrompt = document.getElementById('ws-prompt').value.trim();
  body.whisperLanguage = wsLanguage;
  body.whisperPrompt = wsPrompt;

  if (Object.keys(body).length === 0) {
    vsStatus.textContent = 'No changes';
    vsStatus.className = 'status-text';
    wsStatus.textContent = 'No changes';
    wsStatus.className = 'status-text';
    return;
  }

  try {
    const res = await fetch('/api/settings/voice' + tokenQS('?'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    vsStatus.textContent = 'Saved';
    vsStatus.className = 'status-text ok';
    wsStatus.textContent = 'Saved';
    wsStatus.className = 'status-text ok';
    showToast('Voice settings saved');
    loadVoiceSettings();
  } catch (err) {
    vsStatus.textContent = `Failed: ${err.message}`;
    vsStatus.className = 'status-text err';
    wsStatus.textContent = `Failed: ${err.message}`;
    wsStatus.className = 'status-text err';
  }
}

/* ── Goal precheck settings ── */
const GOAL_DIM_KEYS = ['objective', 'criteria', 'scope', 'executable'];
async function loadGoalSettings() {
  try {
    const res = await fetch('/api/settings/goal' + tokenQS('?'));
    const d = await res.json();
    const dims = d.dimensions || {};
    for (const k of GOAL_DIM_KEYS) {
      const el = document.getElementById('goal-dim-' + k);
      if (el) el.checked = dims[k] !== false;
    }
    const ms = document.getElementById('goal-min-score');
    if (ms) ms.value = (d.minScore != null ? d.minScore : 60);
  } catch (_) {}
}

async function saveGoalSettings() {
  const status = document.getElementById('goal-status');
  const dimensions = {};
  for (const k of GOAL_DIM_KEYS) {
    const el = document.getElementById('goal-dim-' + k);
    dimensions[k] = el ? el.checked : true;
  }
  let minScore = parseInt(document.getElementById('goal-min-score').value, 10);
  if (!Number.isFinite(minScore)) minScore = 60;
  try {
    const res = await fetch('/api/settings/goal' + tokenQS('?'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dimensions, minScore }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status.textContent = 'Saved';
    status.className = 'status-text ok';
    showToast('Goal 预检设置已保存');
    loadGoalSettings();
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
    status.className = 'status-text err';
  }
}

/* ── macOS Power Settings ── */
async function loadMacosPowerSettings() {
  const section = document.getElementById('macos-power-section');
  const nav = document.getElementById('macos-power-nav');
  const toggle = document.getElementById('macos-lid-sleep-toggle');
  const status = document.getElementById('macos-power-status');
  if (!section || !toggle || !status) return;

  let available = false;
  try {
    const res = await fetch('/api/settings/power' + tokenQS('?'));
    const data = await res.json();
    if (!data.available) {
      section.style.display = 'none';
      if (nav) nav.style.display = 'none';
      return;
    }
    available = true;
    section.style.display = '';
    if (nav) nav.style.display = '';
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    toggle.checked = !!data.enabled;
    status.textContent = data.enabled ? '已开启' : '已关闭';
    status.className = `status-text ${data.enabled ? 'ok' : ''}`;
  } catch (error) {
    section.style.display = available ? '' : 'none';
    if (nav) nav.style.display = available ? '' : 'none';
    if (available) {
      status.textContent = `读取失败：${error.message}`;
      status.className = 'status-text err';
    }
  }
}

async function saveMacosPowerSettings() {
  const toggle = document.getElementById('macos-lid-sleep-toggle');
  const status = document.getElementById('macos-power-status');
  const requested = toggle.checked;
  toggle.disabled = true;
  status.textContent = '等待管理员授权…';
  status.className = 'status-text';

  try {
    const res = await fetch('/api/settings/power' + tokenQS('?'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: requested }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    toggle.checked = !!data.enabled;
    status.textContent = data.enabled ? '已开启' : '已关闭';
    status.className = `status-text ${data.enabled ? 'ok' : ''}`;
    showToast(data.enabled ? '已开启关盖保持运行' : '已恢复关盖睡眠');
  } catch (error) {
    toggle.checked = !requested;
    status.textContent = `设置失败：${error.message}`;
    status.className = 'status-text err';
  } finally {
    toggle.disabled = false;
  }
}

/* ── Streaming ASR Settings (modal) ── */
function _asrBadge(el, ready) {
  if (!el) return;
  el.textContent = ready ? '● 就绪' : '○ 未配置';
  el.style.color = ready ? '#3fb950' : '#6e7681';
}

async function loadAsrSettings() {
  try {
    const res = await fetch('/api/settings/voice' + tokenQS('?'));
    const data = await res.json();
    const a = data.asr || {};
    const st = a.status || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
    const ph = (id, has, hint) => { const el = document.getElementById(id); if (el) { el.value = ''; el.placeholder = has ? '已配置（留空不修改）' : hint; } };

    if (document.getElementById('asr-provider')) document.getElementById('asr-provider').value = a.provider || 'openai';
    ph('asr-openai-key', a.hasOpenaiKey, 'sk-...');
    set('asr-openai-url', a.openaiUrl);
    set('asr-openai-model', a.openaiModel);
    ph('asr-volc-appid', a.hasVolcAppId, '火山 App ID');
    ph('asr-volc-token', a.hasVolcToken, '火山 Access Token');
    set('asr-volc-resource', a.volcResourceId);
    set('asr-volc-url', a.volcUrl);
    set('asr-funasr-url', a.funasrUrl);
    set('asr-funasr-mode', a.funasrMode);

    _asrBadge(document.getElementById('asr-openai-badge'), st.openai && st.openai.ready);
    _asrBadge(document.getElementById('asr-volc-badge'), st.volcano && st.volcano.ready);
    _asrBadge(document.getElementById('asr-funasr-badge'), st.funasr && st.funasr.ready);

    // Summary line on the Voice Settings card
    const sum = document.getElementById('asr-summary');
    if (sum) {
      const names = { openai: 'OpenAI Realtime', volcano: '火山引擎', funasr: 'FunASR' };
      const ready = [];
      if (st.openai && st.openai.ready) ready.push('OpenAI');
      if (st.volcano && st.volcano.ready) ready.push('火山');
      if (st.funasr && st.funasr.ready) ready.push('FunASR');
      sum.textContent = `默认：${names[a.provider] || a.provider || '—'}` + (ready.length ? ` · 已配置：${ready.join('、')}` : ' · 尚未配置任何提供商');
      sum.style.color = ready.length ? '#8b949e' : '#d29922';
    }
  } catch (_) {}
}

function openAsrModal() {
  const m = document.getElementById('asr-modal');
  if (m) { m.style.display = 'flex'; loadAsrSettings(); }
}
function closeAsrModal() {
  const m = document.getElementById('asr-modal');
  if (m) m.style.display = 'none';
}

async function saveAsrSettings() {
  const status = document.getElementById('asr-status');
  const val = (id) => (document.getElementById(id)?.value || '').trim();
  const asr = { provider: val('asr-provider') };       // provider always sent
  const opt = (k, id) => { const v = val(id); if (v) asr[k] = v; };  // only send non-empty
  opt('openaiApiKey', 'asr-openai-key');
  opt('openaiUrl', 'asr-openai-url');
  opt('openaiModel', 'asr-openai-model');
  opt('volcAppId', 'asr-volc-appid');
  opt('volcAccessToken', 'asr-volc-token');
  opt('volcResourceId', 'asr-volc-resource');
  opt('volcUrl', 'asr-volc-url');
  opt('funasrUrl', 'asr-funasr-url');
  opt('funasrMode', 'asr-funasr-mode');

  try {
    const res = await fetch('/api/settings/voice' + tokenQS('?'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asr }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (status) { status.textContent = '已保存'; status.style.color = '#3fb950'; }
    showToast('流式 ASR 设置已保存');
    loadAsrSettings();
  } catch (err) {
    if (status) { status.textContent = `失败：${err.message}`; status.style.color = '#f85149'; }
  }
}

/* ── Scheduled Tasks (定时任务) ── */
function _cronTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 获取 session 的简介
function _getCronSessionSummary(sessionId) {
  if (!sessionId) return null;
  const sm = _workspaceSummaries.get(sessionId);
  return sm && sm.summary ? sm.summary : null;
}

// 获取 session 信息
function _getCronSessionInfo(sessionId) {
  if (!sessionId) return null;
  const sess = (_cachedSessions || []).find(s => s.id === sessionId);
  return sess || null;
}

async function loadCronTasks() {
  const list = document.getElementById('cron-list');
  if (!list) return;
  try {
    const res = await fetch('/api/cron' + tokenQS('?'));
    const tasks = await res.json();
    _cronTasksCache = tasks;   // keep for the KPI popup
    const cnt = document.getElementById('cron-count');
    if (cnt) cnt.textContent = tasks.length ? `(${tasks.length})` : '';
    if (!tasks.length) {
      list.innerHTML = '<div style="color:#6e7681;font-size:13px;">还没有定时任务。点「+ 新建」，或让 agent 帮你登记。</div>';
      return;
    }
    list.innerHTML = '';
    for (const t of tasks) {
      const row = document.createElement('div');
      row.className = 'cron-task-card';
      row.style.cssText = 'border:1px solid var(--line);border-radius:12px;padding:14px 16px;background:var(--bg-soft);display:flex;flex-direction:column;gap:10px;min-height:160px;';

      // 获取最近 session 信息
      const sessionInfo = _getCronSessionInfo(t.lastSessionId);
      const sessionSummary = _getCronSessionSummary(t.lastSessionId);
      const sessionActive = sessionInfo && sessionInfo.active;
      const sessionLabel = sessionInfo ? (sessionInfo.label || sessionInfo.id) : null;
      const sessionModel = sessionInfo && sessionInfo.model ? modelShortName(sessionInfo.model) : '';

      // 活动状态
      const statusColor = t.lastStatus === 'ok' ? 'var(--accent)' : (t.lastStatus ? 'var(--danger)' : 'var(--faint)');

      row.innerHTML = `
        <!-- 标题行 -->
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-weight:600;color:var(--text);font-size:15px;">${escapeHtml(t.name)}</span>
          <span style="font-size:11px;padding:2px 7px;border-radius:5px;background:${t.enabled ? 'rgba(63,185,80,0.15)' : 'rgba(110,118,129,0.15)'};color:${t.enabled ? 'var(--accent)' : 'var(--faint)'};font-weight:500;">${t.enabled ? '启用' : '停用'}</span>
          <span style="flex:1;"></span>
        </div>

        <!-- 活动块 -->
        <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:rgba(0,0,0,0.2);border-radius:8px;min-height:36px;">
          <span style="font-size:12px;color:var(--faint);">活动</span>
          ${sessionActive ? `
            <span class="dot active" style="width:8px;height:8px;"></span>
            <span style="font-size:12px;color:var(--accent);">正在运行</span>
          ` : t.lastRunAt ? `
            <span style="font-size:12px;color:var(--muted);">上次 ${_cronTime(t.lastRunAt)}</span>
            <span style="font-size:12px;color:${statusColor};">· ${t.lastStatus === 'ok' ? '成功' : (t.lastError || t.lastStatus)}</span>
            ${t.enabled && t.nextRunAt ? `<span style="font-size:12px;color:var(--faint);">· 下次 ${_cronTime(t.nextRunAt)}</span>` : ''}
          ` : `
            <span style="font-size:12px;color:var(--faint);">尚未运行</span>
          `}
        </div>

        <!-- 最近 session 块 -->
        ${sessionInfo ? `
          <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:rgba(0,0,0,0.15);border-radius:8px;cursor:pointer;" onclick="event.stopPropagation(); openSessionChat('${escapeHtml(t.lastSessionId)}')" title="点击打开会话">
            <span class="dot ${sessionActive ? 'active' : ''}" style="width:8px;height:8px;"></span>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(sessionLabel)}</div>
              <div style="font-size:11px;color:var(--faint);display:flex;gap:6px;align-items:center;">
                <span>${escapeHtml(formatRelative(sessionInfo.lastActivity || sessionInfo.createdAt))}</span>
                ${sessionModel ? `<span>· ${escapeHtml(sessionModel)}</span>` : ''}
              </div>
              ${sessionSummary ? `<div style="font-size:11px;color:var(--muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">🗒 ${escapeHtml(sessionSummary)}</div>` : ''}
            </div>
            <button class="btn btn-sm" onclick="event.stopPropagation(); openSessionChat('${escapeHtml(t.lastSessionId)}')" title="打开会话">
              打开
            </button>
          </div>
        ` : `
          <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:rgba(0,0,0,0.15);border-radius:8px;">
            <span style="font-size:12px;color:var(--faint);">暂无关联会话</span>
          </div>
        `}

        <!-- 详情行 -->
        <div style="font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;">
          <code style="color:var(--amber);font-family:monospace;">${escapeHtml(t.cron)}</code>
          <span>·</span>
          <span>📁 ${escapeHtml(t.dirName)}</span>
          <span>·</span>
          <span>${escapeHtml(t.cli)}</span>
          <span>·</span>
          <span>创建者 ${escapeHtml(t.createdBy)}</span>
        </div>

        <!-- prompt 预览 -->
        <div style="font-size:12px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:6px 10px;background:rgba(0,0,0,0.1);border-radius:6px;">
          💬 ${escapeHtml((t.prompt || '').slice(0, 120))}${(t.prompt || '').length > 120 ? '…' : ''}
        </div>

        <!-- 操作按钮 -->
        <div style="display:flex;gap:6px;margin-top:auto;padding-top:4px;border-top:1px solid var(--line);">
          <button class="btn btn-sm" title="立即运行" onclick="runCronTask('${t.id}')">▶ 运行</button>
          <button class="btn btn-sm" onclick="toggleCronTask('${t.id}', ${t.enabled ? 'false' : 'true'})">${t.enabled ? '停用' : '启用'}</button>
          <button class="btn btn-sm" onclick="openCronModal('${t.id}')">编辑</button>
          <span style="flex:1;"></span>
          <button class="btn btn-sm btn-danger" onclick="deleteCronTask('${t.id}')">删除</button>
        </div>
      `;
      list.appendChild(row);
    }

    // 添加卡片网格样式
    list.style.display = 'grid';
    list.style.gridTemplateColumns = 'repeat(auto-fill, minmax(400px, 1fr))';
    list.style.gap = '12px';
  } catch (err) {
    list.innerHTML = `<div style="color:var(--danger);font-size:13px;">加载失败：${escapeHtml(err.message)}</div>`;
  }
}

let _cronTasksCache = [];
function _populateCronDirs(selectedId) {
  const sel = document.getElementById('cron-f-dir');
  if (!sel) return;
  sel.innerHTML = '';
  for (const d of (_cachedDirectories || [])) {
    const o = document.createElement('option');
    o.value = d.id; o.textContent = d.name;
    if (d.id === selectedId) o.selected = true;
    sel.appendChild(o);
  }
}

async function openCronModal(id) {
  const m = document.getElementById('cron-modal');
  if (!m) return;
  document.getElementById('cron-modal-status').textContent = '';
  document.getElementById('cron-next-hint').textContent = '';
  const title = document.getElementById('cron-modal-title');
  let task = null;
  if (id) {
    try { _cronTasksCache = await (await fetch('/api/cron' + tokenQS('?'))).json(); } catch (_) {}
    task = _cronTasksCache.find(t => t.id === id) || null;
  }
  title.textContent = task ? '⏰ 编辑定时任务' : '⏰ 新建定时任务';
  document.getElementById('cron-edit-id').value = task ? task.id : '';
  document.getElementById('cron-f-name').value = task ? task.name : '';
  _populateCronDirs(task ? task.dirId : ((_cachedDirectories[0] && _cachedDirectories[0].id) || ''));
  document.getElementById('cron-f-cli').value = task ? task.cli : 'claude';
  document.getElementById('cron-f-cron').value = task ? task.cron : '0 9 * * *';
  document.getElementById('cron-f-prompt').value = task ? task.prompt : '';
  document.getElementById('cron-f-enabled').checked = task ? task.enabled : true;
  m.style.display = 'flex';
}
function closeCronModal() {
  const m = document.getElementById('cron-modal');
  if (m) m.style.display = 'none';
}
function cronPreset(expr) {
  document.getElementById('cron-f-cron').value = expr;
  document.getElementById('cron-next-hint').textContent = '';
}

async function saveCronTask() {
  const status = document.getElementById('cron-modal-status');
  const id = document.getElementById('cron-edit-id').value;
  const body = {
    name: document.getElementById('cron-f-name').value.trim(),
    dirId: document.getElementById('cron-f-dir').value,
    cli: document.getElementById('cron-f-cli').value,
    cron: document.getElementById('cron-f-cron').value.trim(),
    prompt: document.getElementById('cron-f-prompt').value,
    enabled: document.getElementById('cron-f-enabled').checked,
  };
  if (!body.name) { status.textContent = '任务名不能为空'; status.style.color = '#f85149'; return; }
  if (!body.prompt.trim()) { status.textContent = 'prompt 不能为空'; status.style.color = '#f85149'; return; }
  try {
    const url = '/api/cron' + (id ? '/' + id : '') + tokenQS('?');
    const res = await fetch(url, {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { status.textContent = data.error || `HTTP ${res.status}`; status.style.color = '#f85149'; return; }
    showToast(id ? '已更新定时任务' : '已创建定时任务');
    closeCronModal();
    loadCronTasks();
  } catch (err) {
    status.textContent = `失败：${err.message}`; status.style.color = '#f85149';
  }
}

async function runCronTask(id) {
  try {
    const res = await fetch(`/api/cron/${id}/run` + tokenQS('?'), { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) showToast(`运行失败：${data.error || res.status}`, true);
    else showToast('已触发，正在新建会话执行');
    loadCronTasks();
  } catch (err) { showToast(`运行失败：${err.message}`, true); }
}

async function toggleCronTask(id, enabled) {
  try {
    const res = await fetch(`/api/cron/${id}` + tokenQS('?'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) { const e = await res.json(); showToast(`Error: ${e.error}`, true); return; }
    loadCronTasks();
  } catch (err) { showToast(`Error: ${err.message}`, true); }
}

async function deleteCronTask(id) {
  if (!(await showConfirm('删除这个定时任务？', { danger: true, okText: '删除' }))) return;
  try {
    const res = await fetch(`/api/cron/${id}` + tokenQS('?'), { method: 'DELETE' });
    if (!res.ok) { const e = await res.json(); showToast(`Error: ${e.error}`, true); return; }
    showToast('已删除');
    loadCronTasks();
  } catch (err) { showToast(`Error: ${err.message}`, true); }
}

/* ── QR Code ── */
async function showQR() {
  const modal = document.getElementById('qr-modal');
  const canvas = document.getElementById('qr-canvas');
  const urlText = document.getElementById('qr-url-text');

  let url;
  try {
    const res = await fetch('/api/server-info' + tokenQS('?'));
    const info = await res.json();
    const tokenQuery = info.token ? `?token=${info.token}` : '';
    url = info.url + '/manage' + tokenQuery;
  } catch (_) {
    // Fallback to current browser URL with token from current page
    const curToken = new URLSearchParams(location.search).get('token');
    const tokenQuery = curToken ? `?token=${curToken}` : '';
    url = window.location.origin + '/manage' + tokenQuery;
  }

  urlText.textContent = url;

  // qrcode-generator API
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();

  const cellSize = 6;
  const margin = 8;
  const count = qr.getModuleCount();
  const size = count * cellSize + margin * 2;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) {
        ctx.fillRect(margin + c * cellSize, margin + r * cellSize, cellSize, cellSize);
      }
    }
  }

  modal.classList.add('visible');
}

function hideQR(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('qr-modal').classList.remove('visible');
}

/* ── WeChat Bridge (iLink) ── */
let _wxEvtSource = null;
let _wxRunning = false;
let _wxLoginPollTimer = null;

function wechatSetLoginUI(loggedIn) {
  const btnQR = document.getElementById('wx-btn-qr');
  const btnLogout = document.getElementById('wx-btn-logout');
  const qrImg = document.getElementById('wx-qr-img');
  const statusEl = document.getElementById('wx-login-status');
  if (loggedIn) {
    btnQR.style.display = 'none';
    btnLogout.style.display = '';
    qrImg.style.display = 'none';
    statusEl.textContent = '已登录微信';
    statusEl.style.color = '#3fb950';
  } else {
    btnQR.style.display = '';
    btnLogout.style.display = 'none';
    statusEl.textContent = '';
  }
}

function wechatSetRunning(running) {
  _wxRunning = running;
  const btnStart = document.getElementById('wx-btn-start');
  const btnStop = document.getElementById('wx-btn-stop');
  const badge = document.getElementById('wx-running-badge');
  btnStart.disabled = running;
  btnStop.disabled = !running;
  badge.style.display = running ? '' : 'none';
}

async function wechatGetQR() {
  const statusEl = document.getElementById('wx-login-status');
  statusEl.textContent = '获取二维码中...';
  statusEl.style.color = '#d29922';
  try {
    const res = await fetch('/api/wechat/qrcode' + tokenQS('?'));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const qrImg = document.getElementById('wx-qr-img');
    const img = data.image || '';
    if (img) {
      if (/^https?:\/\//i.test(img)) {
        renderQrUrlToImg(qrImg, img);
      } else if (img.startsWith('data:')) {
        qrImg.src = img;
      } else {
        qrImg.src = `data:image/png;base64,${img}`;
      }
      qrImg.onerror = () => {
        if (data.qrcode) {
          qrImg.onerror = null;
          renderQrUrlToImg(qrImg, wechatLoginUrl(data.qrcode));
        }
      };
      qrImg.style.display = 'block';
    } else if (data.qrcode) {
      renderQrUrlToImg(qrImg, wechatLoginUrl(data.qrcode));
      qrImg.style.display = 'block';
    }
    statusEl.textContent = '请用微信扫描二维码';
    if (_wxLoginPollTimer) clearInterval(_wxLoginPollTimer);
    _wxLoginPollTimer = setInterval(wechatPollLogin, 2000);
  } catch (e) {
    statusEl.textContent = `获取失败: ${e.message}`;
    statusEl.style.color = '#f85149';
  }
}

function wechatLoginUrl(qrcodeToken) {
  return `https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=${encodeURIComponent(qrcodeToken)}&bot_type=3`;
}

function renderQrUrlToImg(imgEl, url) {
  if (typeof qrcode !== 'function') {
    imgEl.src = url;
    return;
  }
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const cellSize = 5;
  const margin = 8;
  const count = qr.getModuleCount();
  const size = count * cellSize + margin * 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) {
        ctx.fillRect(margin + c * cellSize, margin + r * cellSize, cellSize, cellSize);
      }
    }
  }
  imgEl.src = canvas.toDataURL('image/png');
}

async function wechatPollLogin() {
  try {
    const res = await fetch('/api/wechat/login-status' + tokenQS('?'));
    const data = await res.json();
    if (data.status === 'confirmed') {
      if (_wxLoginPollTimer) { clearInterval(_wxLoginPollTimer); _wxLoginPollTimer = null; }
      wechatSetLoginUI(true);
      showToast('微信登录成功');
    } else if (data.status === 'expired' || data.status === 'error') {
      if (_wxLoginPollTimer) { clearInterval(_wxLoginPollTimer); _wxLoginPollTimer = null; }
      const statusEl = document.getElementById('wx-login-status');
      statusEl.textContent = data.error || '二维码已过期';
      statusEl.style.color = '#f85149';
      document.getElementById('wx-qr-img').style.display = 'none';
    }
  } catch (_) {}
}

async function wechatLogout() {
  try {
    await fetch('/api/wechat/logout' + tokenQS('?'), { method: 'POST' });
    wechatSetLoginUI(false);
    wechatSetRunning(false);
    wechatDisconnectSSE();
    showToast('已退出微信登录');
  } catch (e) {
    showToast(`退出失败: ${e.message}`, true);
  }
}

async function wechatStart() {
  const body = {
    outputIdle: Number(document.getElementById('wx-idle').value) || 5000,
  };
  try {
    const res = await fetch('/api/wechat/start' + tokenQS('?'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    wechatSetRunning(true);
    wechatConnectSSE();
    showToast('微信桥接已启动');
  } catch (e) {
    showToast(`启动失败: ${e.message}`, true);
  }
}

async function wechatStop() {
  try {
    await fetch('/api/wechat/stop' + tokenQS('?'), { method: 'POST' });
    wechatSetRunning(false);
    wechatDisconnectSSE();
    showToast('微信桥接已停止');
  } catch (e) {
    showToast(`停止失败: ${e.message}`, true);
  }
}

async function wechatSaveConfig() {
  const body = {
    outputIdle: Number(document.getElementById('wx-idle').value) || 5000,
  };
  try {
    const res = await fetch('/api/wechat/config' + tokenQS('?'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('微信配置已保存');
  } catch (e) {
    showToast(`保存失败: ${e.message}`, true);
  }
}

function wechatConnectSSE() {
  wechatDisconnectSSE();
  _wxEvtSource = new EventSource('/api/wechat/events' + tokenQS('?'));
  _wxEvtSource.onmessage = (e) => {
    try { wechatAppendLog(JSON.parse(e.data)); } catch (_) {}
  };
  _wxEvtSource.onerror = () => {
    wechatDisconnectSSE();
    if (_wxRunning) setTimeout(wechatConnectSSE, 3000);
  };
}

function wechatDisconnectSSE() {
  if (_wxEvtSource) { _wxEvtSource.close(); _wxEvtSource = null; }
}

const _wxPrefixes = { in: '← WeChat', out: '→ Claude', system: 'SYS', error: 'ERR' };
const _wxColors = { in: '#58a6ff', out: '#3fb950', system: '#d29922', error: '#f85149' };

function wechatAppendLog(entry) {
  const log = document.getElementById('wx-log');
  // Remove placeholder
  const ph = log.querySelector('div[style*="text-align:center"]');
  if (ph) ph.remove();

  const div = document.createElement('div');
  div.style.cssText = `border-left:2px solid ${_wxColors[entry.type] || '#484f58'};padding:2px 6px;line-height:1.4;word-break:break-word;`;
  const d = new Date(entry.ts);
  const time = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`;
  const prefix = _wxPrefixes[entry.type] || entry.type;
  div.innerHTML = `<span style="color:#484f58;font-size:10px;margin-right:4px;">${time}</span><span style="color:${_wxColors[entry.type]};font-weight:600;">${escapeHtml(prefix)}</span> ${escapeHtml(entry.text || '')}`;
  log.appendChild(div);

  while (log.children.length > 100) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

/* ── Gateway session ── */
function _wxSelectedCli() {
  const checked = document.querySelector('input[name="wx-gw-cli"]:checked');
  return checked ? checked.value : 'claude';
}

function wechatRenderGateway(gw) {
  const stateEl = document.getElementById('wx-gw-state');
  const createBtn = document.getElementById('wx-gw-create');
  const openBtn = document.getElementById('wx-gw-open');
  const resetBtn = document.getElementById('wx-gw-reset');
  const destroyBtn = document.getElementById('wx-gw-destroy');
  if (!stateEl) return;

  if (gw) {
    stateEl.textContent = `${gw.cli}`;
    stateEl.style.background = '#23863640';
    stateEl.style.color = '#3fb950';
    createBtn.style.display = 'none';
    openBtn.style.display = '';
    resetBtn.style.display = '';
    destroyBtn.style.display = '';
    // Sync radio with current cli
    const radio = document.querySelector(`input[name="wx-gw-cli"][value="${gw.cli}"]`);
    if (radio) radio.checked = true;
  } else {
    stateEl.textContent = '未创建';
    stateEl.style.background = '#21262d';
    stateEl.style.color = '#8b949e';
    createBtn.style.display = '';
    openBtn.style.display = 'none';
    resetBtn.style.display = 'none';
    destroyBtn.style.display = 'none';
  }
}

async function wechatGatewayRefresh() {
  try {
    const res = await fetch('/api/wechat/gateway' + tokenQS('?'));
    const gw = await res.json();
    wechatRenderGateway(gw);
    return gw;
  } catch (_) { return null; }
}

async function wechatGatewayCreate() {
  const cli = _wxSelectedCli();
  try {
    const res = await fetch('/api/wechat/gateway' + tokenQS('?'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cli }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    wechatRenderGateway(data);
    showToast(`Gateway 已创建 (${cli})`);
  } catch (e) { showToast(`创建失败: ${e.message}`, true); }
}

async function wechatGatewaySwitchCli() {
  const cli = _wxSelectedCli();
  try {
    const res = await fetch('/api/wechat/gateway' + tokenQS('?'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cli }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    wechatRenderGateway(data);
    showToast(`已切换到 ${cli}`);
  } catch (e) {
    showToast(`切换失败: ${e.message}`, true);
    wechatGatewayRefresh();  // revert radio
  }
}

function wechatGatewayOpen() {
  const url = '/chat?session=__gateway__' + tokenQS('&');
  window.open(url, '_blank');
}

async function wechatGatewayReset() {
  if (!(await showConfirm('清空 Gateway 对话历史？', { danger: true, okText: '清空' }))) return;
  try {
    const res = await fetch('/api/wechat/gateway/reset' + tokenQS('?'), { method: 'POST' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    showToast('已清空对话历史');
  } catch (e) { showToast(`重置失败: ${e.message}`, true); }
}

async function wechatGatewayDestroy() {
  if (!(await showConfirm('销毁 Gateway 会话？历史会保留在 chat_history。', { danger: true, okText: '销毁' }))) return;
  try {
    const res = await fetch('/api/wechat/gateway' + tokenQS('?'), { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    wechatRenderGateway(null);
    showToast('Gateway 已销毁');
  } catch (e) { showToast(`销毁失败: ${e.message}`, true); }
}

async function wechatLoadConfig() {
  try {
    const res = await fetch('/api/wechat/config' + tokenQS('?'));
    const cfg = await res.json();
    document.getElementById('wx-idle').value = cfg.outputIdle || 5000;
    wechatSetLoginUI(!!cfg.loggedIn);
  } catch (_) {}
}

async function wechatCheckStatus() {
  try {
    const res = await fetch('/api/wechat/status' + tokenQS('?'));
    const data = await res.json();
    wechatSetLoginUI(data.loggedIn);
    wechatRenderGateway(data.gateway);
    if (data.running) {
      wechatSetRunning(true);
      wechatConnectSSE();
      try {
        const logRes = await fetch('/api/wechat/log' + tokenQS('?'));
        const entries = await logRes.json();
        for (const e of entries.slice(-50)) wechatAppendLog(e);
      } catch (_) {}
    }
  } catch (_) {}
}

// Hook up radio change → switch cli (only when gateway already exists)
document.addEventListener('change', (e) => {
  if (e.target && e.target.name === 'wx-gw-cli') {
    const stateEl = document.getElementById('wx-gw-state');
    if (stateEl && stateEl.textContent !== '未创建') wechatGatewaySwitchCli();
  }
});

/* ───────────────────────── Feishu Bridge ───────────────────────── */
let _fsEvtSource = null;
let _fsRunning = false;

function feishuSetConfigured(configured) {
  const el = document.getElementById('fs-cfg-state');
  if (!el) return;
  el.textContent = configured ? '已配置' : '未配置';
  el.style.background = configured ? '#23863640' : '#21262d';
  el.style.color = configured ? '#3fb950' : '#8b949e';
}

function feishuSetRunning(running) {
  _fsRunning = running;
  const btnStart = document.getElementById('fs-btn-start');
  const btnStop = document.getElementById('fs-btn-stop');
  const badge = document.getElementById('fs-running-badge');
  const wsBadge = document.getElementById('fs-ws-badge');
  if (btnStart) btnStart.disabled = running;
  if (btnStop) btnStop.disabled = !running;
  if (badge) badge.style.display = running ? '' : 'none';
  if (wsBadge) wsBadge.style.display = running ? '' : 'none';
}

async function feishuSaveConfig() {
  const body = {
    appId: document.getElementById('fs-appid').value.trim(),
    domain: document.getElementById('fs-domain').value,
  };
  const secret = document.getElementById('fs-appsecret').value;
  if (secret) body.appSecret = secret;       // empty = keep existing
  const statusEl = document.getElementById('fs-cfg-status');
  try {
    const res = await fetch('/api/feishu/config' + tokenQS('?'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    document.getElementById('fs-appsecret').value = '';
    if (statusEl) statusEl.textContent = '已保存';
    showToast('飞书凭证已保存');
    feishuLoadConfig();
  } catch (e) {
    if (statusEl) statusEl.textContent = `保存失败: ${e.message}`;
    showToast(`保存失败: ${e.message}`, true);
  }
}

async function feishuStart() {
  try {
    const res = await fetch('/api/feishu/start' + tokenQS('?'), { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    feishuSetRunning(true);
    feishuConnectSSE();
    showToast('飞书桥接已启动');
  } catch (e) {
    showToast(`启动失败: ${e.message}`, true);
  }
}

async function feishuStop() {
  try {
    await fetch('/api/feishu/stop' + tokenQS('?'), { method: 'POST' });
    feishuSetRunning(false);
    feishuDisconnectSSE();
    showToast('飞书桥接已停止');
  } catch (e) {
    showToast(`停止失败: ${e.message}`, true);
  }
}

function feishuConnectSSE() {
  feishuDisconnectSSE();
  _fsEvtSource = new EventSource('/api/feishu/events' + tokenQS('?'));
  _fsEvtSource.onmessage = (e) => { try { feishuAppendLog(JSON.parse(e.data)); } catch (_) {} };
  _fsEvtSource.onerror = () => {
    feishuDisconnectSSE();
    if (_fsRunning) setTimeout(feishuConnectSSE, 3000);
  };
}

function feishuDisconnectSSE() {
  if (_fsEvtSource) { _fsEvtSource.close(); _fsEvtSource = null; }
}

const _fsPrefixes = { in: '← 飞书', out: '→ Claude', system: 'SYS', error: 'ERR' };
const _fsColors = { in: '#58a6ff', out: '#3fb950', system: '#d29922', error: '#f85149' };

function feishuAppendLog(entry) {
  const log = document.getElementById('fs-log');
  if (!log) return;
  const ph = log.querySelector('div[style*="text-align:center"]');
  if (ph) ph.remove();
  const div = document.createElement('div');
  div.style.cssText = `border-left:2px solid ${_fsColors[entry.type] || '#484f58'};padding:2px 6px;line-height:1.4;word-break:break-word;`;
  const d = new Date(entry.ts);
  const time = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`;
  const prefix = _fsPrefixes[entry.type] || entry.type;
  div.innerHTML = `<span style="color:#484f58;font-size:10px;margin-right:4px;">${time}</span><span style="color:${_fsColors[entry.type]};font-weight:600;">${escapeHtml(prefix)}</span> ${escapeHtml(entry.text || '')}`;
  log.appendChild(div);
  while (log.children.length > 100) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

/* ── Feishu Gateway session ── */
function _fsSelectedCli() {
  const checked = document.querySelector('input[name="fs-gw-cli"]:checked');
  return checked ? checked.value : 'claude';
}

function feishuRenderGateway(gw) {
  const stateEl = document.getElementById('fs-gw-state');
  const createBtn = document.getElementById('fs-gw-create');
  const openBtn = document.getElementById('fs-gw-open');
  const resetBtn = document.getElementById('fs-gw-reset');
  const destroyBtn = document.getElementById('fs-gw-destroy');
  if (!stateEl) return;
  if (gw) {
    stateEl.textContent = `${gw.cli}`;
    stateEl.style.background = '#23863640';
    stateEl.style.color = '#3fb950';
    createBtn.style.display = 'none';
    openBtn.style.display = '';
    resetBtn.style.display = '';
    destroyBtn.style.display = '';
    const radio = document.querySelector(`input[name="fs-gw-cli"][value="${gw.cli}"]`);
    if (radio) radio.checked = true;
  } else {
    stateEl.textContent = '未创建';
    stateEl.style.background = '#21262d';
    stateEl.style.color = '#8b949e';
    createBtn.style.display = '';
    openBtn.style.display = 'none';
    resetBtn.style.display = 'none';
    destroyBtn.style.display = 'none';
  }
}

async function feishuGatewayRefresh() {
  try {
    const res = await fetch('/api/feishu/gateway' + tokenQS('?'));
    const gw = await res.json();
    feishuRenderGateway(gw);
    return gw;
  } catch (_) { return null; }
}

async function feishuGatewayCreate() {
  const cli = _fsSelectedCli();
  try {
    const res = await fetch('/api/feishu/gateway' + tokenQS('?'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cli }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    feishuRenderGateway(data);
    showToast(`飞书 Gateway 已创建 (${cli})`);
  } catch (e) { showToast(`创建失败: ${e.message}`, true); }
}

async function feishuGatewaySwitchCli() {
  const cli = _fsSelectedCli();
  try {
    const res = await fetch('/api/feishu/gateway' + tokenQS('?'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cli }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    feishuRenderGateway(data);
    showToast(`已切换到 ${cli}`);
  } catch (e) {
    showToast(`切换失败: ${e.message}`, true);
    feishuGatewayRefresh();
  }
}

function feishuGatewayOpen() {
  const url = '/chat?session=__feishu_gateway__' + tokenQS('&');
  window.open(url, '_blank');
}

async function feishuGatewayReset() {
  if (!(await showConfirm('清空飞书 Gateway 对话历史？', { danger: true, okText: '清空' }))) return;
  try {
    const res = await fetch('/api/feishu/gateway/reset' + tokenQS('?'), { method: 'POST' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    showToast('已清空对话历史');
  } catch (e) { showToast(`重置失败: ${e.message}`, true); }
}

async function feishuGatewayDestroy() {
  if (!(await showConfirm('销毁飞书 Gateway 会话？历史会保留在 chat_history。', { danger: true, okText: '销毁' }))) return;
  try {
    const res = await fetch('/api/feishu/gateway' + tokenQS('?'), { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    feishuRenderGateway(null);
    showToast('飞书 Gateway 已销毁');
  } catch (e) { showToast(`销毁失败: ${e.message}`, true); }
}

async function feishuLoadConfig() {
  try {
    const res = await fetch('/api/feishu/config' + tokenQS('?'));
    const cfg = await res.json();
    if (document.getElementById('fs-appid')) document.getElementById('fs-appid').value = cfg.appId || '';
    if (document.getElementById('fs-domain')) document.getElementById('fs-domain').value = cfg.domain || 'feishu';
    feishuSetConfigured(!!cfg.configured);
  } catch (_) {}
}

async function feishuCheckStatus() {
  try {
    const res = await fetch('/api/feishu/status' + tokenQS('?'));
    const data = await res.json();
    feishuSetConfigured(!!data.configured);
    feishuRenderGateway(data.gateway);
    if (data.running) {
      feishuSetRunning(true);
      feishuConnectSSE();
      try {
        const logRes = await fetch('/api/feishu/log' + tokenQS('?'));
        const entries = await logRes.json();
        for (const e of entries.slice(-50)) feishuAppendLog(e);
      } catch (_) {}
    }
  } catch (_) {}
}

// Hook up radio change → switch cli (only when feishu gateway already exists)
document.addEventListener('change', (e) => {
  if (e.target && e.target.name === 'fs-gw-cli') {
    const stateEl = document.getElementById('fs-gw-state');
    if (stateEl && stateEl.textContent !== '未创建') feishuGatewaySwitchCli();
  }
});

/* ── Generic token-based bridges: Telegram / Discord / Slack ──
   All three share Feishu's exact REST surface + gateway model; only the config
   fields differ. One data-driven controller drives all of them (id prefix per
   platform), instead of copy-pasting the Feishu functions three times. */
const TOKEN_BRIDGES = {
  telegram: { api: '/api/telegram', idp: 'tg', name: 'Telegram', session: '__telegram_gateway__', fields: ['botToken'], logIn: '← Telegram' },
  discord:  { api: '/api/discord',  idp: 'dc', name: 'Discord',  session: '__discord_gateway__',  fields: ['botToken'], logIn: '← Discord' },
  slack:    { api: '/api/slack',    idp: 'sk', name: 'Slack',    session: '__slack_gateway__',    fields: ['botToken', 'appToken'], logIn: '← Slack' },
};
const _bridgeEvt = {};       // platform → EventSource
const _bridgeRunning = {};   // platform → bool
function _bid(p, suffix) { return document.getElementById(TOKEN_BRIDGES[p].idp + '-' + suffix); }

function bridgeSetConfigured(p, configured) {
  const el = _bid(p, 'cfg-state');
  if (!el) return;
  el.textContent = configured ? '已配置' : '未配置';
  el.style.background = configured ? '#23863640' : '';
  el.style.color = configured ? '#3fb950' : '';
}
function bridgeSetRunning(p, running) {
  _bridgeRunning[p] = running;
  const s = _bid(p, 'btn-start'), e = _bid(p, 'btn-stop'), b = _bid(p, 'running-badge'), w = _bid(p, 'ws-badge');
  if (s) s.disabled = running;
  if (e) e.disabled = !running;
  if (b) b.style.display = running ? '' : 'none';
  if (w) w.style.display = running ? '' : 'none';
}
async function bridgeSaveConfig(p) {
  const def = TOKEN_BRIDGES[p];
  const body = {};
  for (const f of def.fields) { const v = (_bid(p, f)?.value || '').trim(); if (v) body[f] = v; } // empty = keep existing
  const statusEl = _bid(p, 'cfg-status');
  try {
    const res = await fetch(def.api + '/config' + tokenQS('?'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    for (const f of def.fields) { const el = _bid(p, f); if (el) el.value = ''; }
    if (statusEl) statusEl.textContent = '已保存';
    showToast(`${def.name} 凭证已保存`);
    bridgeLoadConfig(p);
  } catch (err) {
    if (statusEl) statusEl.textContent = `保存失败: ${err.message}`;
    showToast(`保存失败: ${err.message}`, true);
  }
}
async function bridgeStart(p) {
  const def = TOKEN_BRIDGES[p];
  try {
    const res = await fetch(def.api + '/start' + tokenQS('?'), { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    bridgeSetRunning(p, true);
    bridgeConnectSSE(p);
    showToast(`${def.name} 桥接已启动`);
  } catch (err) { showToast(`启动失败: ${err.message}`, true); }
}
async function bridgeStop(p) {
  const def = TOKEN_BRIDGES[p];
  try {
    await fetch(def.api + '/stop' + tokenQS('?'), { method: 'POST' });
    bridgeSetRunning(p, false);
    bridgeDisconnectSSE(p);
    showToast(`${def.name} 桥接已停止`);
  } catch (err) { showToast(`停止失败: ${err.message}`, true); }
}
function bridgeConnectSSE(p) {
  const def = TOKEN_BRIDGES[p];
  bridgeDisconnectSSE(p);
  const es = new EventSource(def.api + '/events' + tokenQS('?'));
  es.onmessage = (e) => { try { bridgeAppendLog(p, JSON.parse(e.data)); } catch (_) {} };
  es.onerror = () => { bridgeDisconnectSSE(p); if (_bridgeRunning[p]) setTimeout(() => bridgeConnectSSE(p), 3000); };
  _bridgeEvt[p] = es;
}
function bridgeDisconnectSSE(p) { if (_bridgeEvt[p]) { _bridgeEvt[p].close(); _bridgeEvt[p] = null; } }

const _bridgeLogColors = { in: '#58a6ff', out: '#3fb950', system: '#d29922', error: '#f85149' };
function bridgeAppendLog(p, entry) {
  const def = TOKEN_BRIDGES[p];
  const log = _bid(p, 'log');
  if (!log) return;
  const ph = log.querySelector('div[style*="text-align:center"]');
  if (ph) ph.remove();
  const div = document.createElement('div');
  div.style.cssText = `border-left:2px solid ${_bridgeLogColors[entry.type] || '#484f58'};padding:2px 6px;line-height:1.4;word-break:break-word;`;
  const d = new Date(entry.ts);
  const time = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`;
  const prefixMap = { in: def.logIn, out: '→ Agent', system: 'SYS', error: 'ERR' };
  const prefix = prefixMap[entry.type] || entry.type;
  div.innerHTML = `<span style="color:#484f58;font-size:10px;margin-right:4px;">${time}</span><span style="color:${_bridgeLogColors[entry.type] || '#8b949e'};font-weight:600;">${escapeHtml(prefix)}</span> ${escapeHtml(entry.text || '')}`;
  log.appendChild(div);
  while (log.children.length > 100) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}
function _bridgeSelectedCli(p) {
  const checked = document.querySelector(`input[name="${TOKEN_BRIDGES[p].idp}-gw-cli"]:checked`);
  return checked ? checked.value : 'claude';
}
function bridgeRenderGateway(p, gw) {
  const stateEl = _bid(p, 'gw-state'), createBtn = _bid(p, 'gw-create'), openBtn = _bid(p, 'gw-open'),
        resetBtn = _bid(p, 'gw-reset'), destroyBtn = _bid(p, 'gw-destroy');
  if (!stateEl) return;
  if (gw) {
    stateEl.textContent = gw.cli;
    stateEl.style.background = '#23863640'; stateEl.style.color = '#3fb950';
    createBtn.style.display = 'none'; openBtn.style.display = ''; resetBtn.style.display = ''; destroyBtn.style.display = '';
    const radio = document.querySelector(`input[name="${TOKEN_BRIDGES[p].idp}-gw-cli"][value="${gw.cli}"]`);
    if (radio) radio.checked = true;
  } else {
    stateEl.textContent = '未创建';
    stateEl.style.background = ''; stateEl.style.color = '';
    createBtn.style.display = ''; openBtn.style.display = 'none'; resetBtn.style.display = 'none'; destroyBtn.style.display = 'none';
  }
}
async function bridgeGatewayRefresh(p) {
  try { const res = await fetch(TOKEN_BRIDGES[p].api + '/gateway' + tokenQS('?')); const gw = await res.json(); bridgeRenderGateway(p, gw); return gw; }
  catch (_) { return null; }
}
async function bridgeGatewayCreate(p) {
  const def = TOKEN_BRIDGES[p], cli = _bridgeSelectedCli(p);
  try {
    const res = await fetch(def.api + '/gateway' + tokenQS('?'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cli }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    bridgeRenderGateway(p, data);
    showToast(`${def.name} Gateway 已创建 (${cli})`);
  } catch (err) { showToast(`创建失败: ${err.message}`, true); }
}
async function bridgeGatewaySwitchCli(p) {
  const def = TOKEN_BRIDGES[p], cli = _bridgeSelectedCli(p);
  try {
    const res = await fetch(def.api + '/gateway' + tokenQS('?'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cli }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    bridgeRenderGateway(p, data);
    showToast(`已切换到 ${cli}`);
  } catch (err) { showToast(`切换失败: ${err.message}`, true); bridgeGatewayRefresh(p); }
}
function bridgeGatewayOpen(p) {
  window.open('/chat?session=' + encodeURIComponent(TOKEN_BRIDGES[p].session) + tokenQS('&'), '_blank');
}
async function bridgeGatewayReset(p) {
  const def = TOKEN_BRIDGES[p];
  if (!(await showConfirm(`清空 ${def.name} Gateway 对话历史？`, { danger: true, okText: '清空' }))) return;
  try {
    const res = await fetch(def.api + '/gateway/reset' + tokenQS('?'), { method: 'POST' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    showToast('已清空对话历史');
  } catch (err) { showToast(`重置失败: ${err.message}`, true); }
}
async function bridgeGatewayDestroy(p) {
  const def = TOKEN_BRIDGES[p];
  if (!(await showConfirm(`销毁 ${def.name} Gateway 会话？历史会保留在 chat_history。`, { danger: true, okText: '销毁' }))) return;
  try {
    const res = await fetch(def.api + '/gateway' + tokenQS('?'), { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    bridgeRenderGateway(p, null);
    showToast(`${def.name} Gateway 已销毁`);
  } catch (err) { showToast(`销毁失败: ${err.message}`, true); }
}
async function bridgeLoadConfig(p) {
  try { const res = await fetch(TOKEN_BRIDGES[p].api + '/config' + tokenQS('?')); const cfg = await res.json(); bridgeSetConfigured(p, !!cfg.configured); } catch (_) {}
}
async function bridgeCheckStatus(p) {
  const def = TOKEN_BRIDGES[p];
  try {
    const res = await fetch(def.api + '/status' + tokenQS('?'));
    const data = await res.json();
    bridgeSetConfigured(p, !!data.configured);
    bridgeRenderGateway(p, data.gateway);
    if (data.running) {
      bridgeSetRunning(p, true);
      bridgeConnectSSE(p);
      try { const logRes = await fetch(def.api + '/log' + tokenQS('?')); const entries = await logRes.json(); for (const e of entries.slice(-50)) bridgeAppendLog(p, e); } catch (_) {}
    }
  } catch (_) {}
}
// radio change → switch cli when that platform's gateway already exists
document.addEventListener('change', (e) => {
  if (!e.target || !e.target.name) return;
  for (const p of Object.keys(TOKEN_BRIDGES)) {
    if (e.target.name === TOKEN_BRIDGES[p].idp + '-gw-cli') {
      const stateEl = _bid(p, 'gw-state');
      if (stateEl && stateEl.textContent !== '未创建') bridgeGatewaySwitchCli(p);
    }
  }
});

/* ── Push Notification Diagnostics ── */

function formatTimestamp(ts) {
  if (!ts) return '—';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

async function loadPushDiagnostics() {
  // Client-side info
  if (typeof getPushInfo === 'function') {
    const info = getPushInfo();
    const permEl = document.getElementById('push-d-permission');
    const subEl = document.getElementById('push-d-sub-status');
    const epEl = document.getElementById('push-d-endpoint');
    const platEl = document.getElementById('push-d-platform');
    const toggleEl = document.getElementById('push-d-toggle');

    if (permEl) {
      permEl.textContent = info.permission;
      permEl.style.color = info.permission === 'granted' ? '#3fb950' : info.permission === 'denied' ? '#f85149' : '#d29922';
    }
    if (subEl) {
      if (info.subscribed) {
        subEl.textContent = 'Active';
        subEl.style.color = '#3fb950';
      } else {
        subEl.textContent = 'None';
        subEl.style.color = '#8b949e';
      }
    }
    if (epEl) {
      if (info.endpoint) {
        const ep = info.endpoint;
        epEl.textContent = ep.length > 60 ? ep.slice(0, 40) + '...' + ep.slice(-15) : ep;
      } else {
        epEl.textContent = '—';
      }
    }
    if (platEl) platEl.textContent = info.platform;
    if (toggleEl) {
      toggleEl.textContent = info.subscribed ? 'Push ON' : 'Push';
      toggleEl.className = info.subscribed ? 'btn btn-green' : 'btn';
    }
  }

  // Server-side health
  try {
    const res = await fetch('/api/push/health' + tokenQS('?'));
    if (!res.ok) return;
    const data = await res.json();

    const g = data.global;
    document.getElementById('push-d-last-push').textContent = g.lastPushTime
      ? `${formatTimestamp(g.lastPushTime)} (${g.lastPushType})`
      : 'Never';

    const total = g.totalSuccess + g.totalFail;
    const rateEl = document.getElementById('push-d-rate');
    if (total > 0) {
      const pct = Math.round(g.totalSuccess / total * 100);
      rateEl.textContent = `${pct}% (${g.totalSuccess}/${total})`;
      rateEl.style.color = pct >= 90 ? '#3fb950' : pct >= 70 ? '#d29922' : '#f85149';
    } else {
      rateEl.textContent = 'No data';
      rateEl.style.color = '#8b949e';
    }

    document.getElementById('push-d-total').textContent = g.totalSent || '0';
    document.getElementById('push-d-sub-count').textContent = data.subscriptionCount || '0';

    // Last error from any subscription
    let lastErr = null;
    for (const s of data.subscriptions || []) {
      if (s.lastFailTime && (!lastErr || s.lastFailTime > lastErr.time)) {
        lastErr = { time: s.lastFailTime, reason: s.lastFailReason };
      }
    }
    const errEl = document.getElementById('push-d-last-error');
    if (lastErr) {
      errEl.textContent = `${lastErr.reason} (${formatTimestamp(lastErr.time)})`;
      errEl.style.color = '#f85149';
    } else {
      errEl.textContent = 'None';
      errEl.style.color = '#3fb950';
    }
  } catch (e) {
    console.error('[manage] Failed to load push health:', e);
  }
}

async function sendTestPush() {
  const statusEl = document.getElementById('push-d-test-status');
  statusEl.textContent = 'Sending...';
  statusEl.className = 'status-text';
  try {
    const res = await fetch('/api/push/test' + tokenQS('?'), { method: 'POST' });
    const data = await res.json();
    statusEl.textContent = `Sent to ${data.subscribers} subscriber(s)`;
    statusEl.className = 'status-text ok';
    setTimeout(() => loadPushDiagnostics(), 2000);
  } catch (e) {
    statusEl.textContent = 'Failed: ' + e.message;
    statusEl.className = 'status-text err';
  }
}

async function loadNotifySettings() {
  try {
    const res = await fetch('/api/settings/notify' + tokenQS('?'));
    const cfg = await res.json();
    const barkInput = document.getElementById('push-d-bark');
    const webhookInput = document.getElementById('push-d-webhook');
    // Show full URL only if user has set one (server masks it for GET)
    if (barkInput && cfg.hasBark) barkInput.placeholder = cfg.barkUrl || 'Configured';
    if (webhookInput && cfg.webhookUrl) webhookInput.value = cfg.webhookUrl;
  } catch (_) {}
}

async function saveNotifySettings() {
  const statusEl = document.getElementById('push-d-backup-status');
  const barkVal = document.getElementById('push-d-bark').value.trim();
  const webhookVal = document.getElementById('push-d-webhook').value.trim();
  const body = {};
  if (barkVal) body.barkUrl = barkVal;
  if (webhookVal !== undefined) body.webhookUrl = webhookVal;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (_urlToken) headers['X-Access-Token'] = _urlToken;
    const res = await fetch('/api/settings/notify', { method: 'POST', headers, body: JSON.stringify(body) });
    if (res.ok) {
      statusEl.textContent = 'Saved';
      statusEl.className = 'status-text ok';
      showToast('Notification settings saved');
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (e) {
    statusEl.textContent = 'Error: ' + e.message;
    statusEl.className = 'status-text err';
  }
}

async function testBark() {
  const statusEl = document.getElementById('push-d-backup-status');
  statusEl.textContent = 'Testing Bark...';
  statusEl.className = 'status-text';
  try {
    const res = await fetch('/api/push/test-bark' + tokenQS('?'), { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    statusEl.textContent = 'Bark test sent';
    statusEl.className = 'status-text ok';
  } catch (e) {
    statusEl.textContent = 'Bark: ' + e.message;
    statusEl.className = 'status-text err';
  }
}

async function testWebhook() {
  const statusEl = document.getElementById('push-d-backup-status');
  statusEl.textContent = 'Testing Webhook...';
  statusEl.className = 'status-text';
  try {
    const res = await fetch('/api/push/test-webhook' + tokenQS('?'), { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    statusEl.textContent = 'Webhook test sent';
    statusEl.className = 'status-text ok';
  } catch (e) {
    statusEl.textContent = 'Webhook: ' + e.message;
    statusEl.className = 'status-text err';
  }
}

/* ── 外网穿透监控 Tunnel ── */
function tnlFmtStatus(p, prov) {
  // p = runtime provider state; prov = config provider {enabled,url}
  if (!prov.enabled) return '未启用';
  if (!prov.url) return '未配置 URL';
  if (p.healthy === null || !p.lastCheckAt) return '等待首次探活…';
  const when = new Date(p.lastCheckAt).toLocaleTimeString();
  let s = p.healthy ? `正常 (HTTP ${p.lastHttpCode})` : `异常 (HTTP ${p.lastHttpCode}，连续失败 ${p.consecutiveFails})`;
  s += ` · ${when}`;
  if (p.restartTimes && p.restartTimes.length) s += ` · 近1h重启 ${p.restartTimes.length} 次`;
  if (p.lastAction) s += ` · ${p.lastAction}`;
  return s;
}

// ── Access token (external-access login password) ──
async function loadAccessToken() {
  const input = document.getElementById('tnl-token');
  const hint = document.getElementById('tnl-token-hint');
  const btn = document.getElementById('tnl-token-save');
  if (!input) return;
  try {
    const res = await fetch('/api/settings/access-token' + tokenQS('?'));
    const d = await res.json();
    if (d.canEdit) {
      // localhost: editable. Show placeholder reflecting current state.
      input.disabled = false;
      input.readOnly = false;
      input.value = '';
      input.placeholder = d.hasToken ? '已设置（留空保存=清除；输入新值=修改）' : '未设置';
      if (hint) { hint.textContent = '· 本机可修改'; hint.style.color = 'var(--faint)'; }
      if (btn) btn.disabled = false;
    } else {
      // remote: read-only masked.
      input.disabled = true;
      input.readOnly = true;
      input.value = d.masked || '';
      input.placeholder = d.hasToken ? '' : '未设置';
      if (hint) { hint.textContent = '· 仅本机可修改'; hint.style.color = 'var(--faint)'; }
      if (btn) btn.disabled = true;
    }
  } catch (_) {}
}

async function saveAccessToken() {
  const input = document.getElementById('tnl-token');
  const msg = document.getElementById('tnl-token-msg');
  if (!input || input.disabled) return;
  const token = input.value;
  if (token.includes('****')) { if (msg) { msg.textContent = '未修改'; msg.className = 'status-text'; } return; }
  if (token.trim() && !confirm('保存后，外网/局域网访问都需要用此密码登录，旧的登录会话会失效。确定？')) return;
  if (!token.trim() && !confirm('留空保存将清除访问密码，任何人凭 URL 即可访问。确定？')) return;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (_urlToken) headers['X-Access-Token'] = _urlToken;
    const res = await fetch('/api/settings/access-token', { method: 'POST', headers, body: JSON.stringify({ token }) });
    const d = await res.json();
    if (!res.ok || d.error) throw new Error(d.error || ('HTTP ' + res.status));
    if (msg) { msg.textContent = d.hasToken ? '已保存' : '已清除'; msg.className = 'status-text ok'; }
    showToast('访问密码已更新');
    loadAccessToken();
  } catch (e) {
    if (msg) { msg.textContent = '错误: ' + e.message; msg.className = 'status-text err'; }
  }
}

async function loadTunnelSettings() {
  loadAccessToken();
  try {
    const res = await fetch('/api/settings/tunnel' + tokenQS('?'));
    const st = await res.json();
    const c = st.config, av = st.availability || {}, pr = st.providers || {};
    // availability hints
    const phAvail = document.getElementById('tnl-ph-avail');
    if (phAvail) phAvail.textContent = av.phddns ? '· 已安装' : '· 未检测到 PhDDNS.app';
    const tsAvail = document.getElementById('tnl-ts-avail');
    if (tsAvail) tsAvail.textContent = av.tailscale ? '· CLI 可用' : '· 未检测到 tailscale CLI';
    // phddns
    document.getElementById('tnl-ph-enabled').checked = !!c.phddns.enabled;
    document.getElementById('tnl-ph-url').value = c.phddns.url || '';
    document.getElementById('tnl-ph-status').textContent = tnlFmtStatus(pr.phddns || {}, c.phddns);
    // tailscale
    document.getElementById('tnl-ts-enabled').checked = !!c.tailscale.enabled;
    document.getElementById('tnl-ts-url').value = c.tailscale.url || '';
    document.getElementById('tnl-ts-status').textContent = tnlFmtStatus(pr.tailscale || {}, c.tailscale);
    document.getElementById('tnl-ts-funnel').checked = !!c.tailscale.funnel;
    document.getElementById('tnl-ts-funnelport').value = c.tailscale.funnelPort || 3000;
    loadFunnelStatus();
    loadIpv6Status();
    // advanced
    document.getElementById('tnl-interval').value = c.intervalSec;
    document.getElementById('tnl-failthreshold').value = c.failThreshold;
    document.getElementById('tnl-cooldown').value = c.restartCooldownSec;
    document.getElementById('tnl-maxrestarts').value = c.maxRestartsPerHour;
  } catch (_) {}
}

async function saveTunnelSettings() {
  const msg = document.getElementById('tnl-adv-msg');
  const numOr = (id) => { const v = parseInt(document.getElementById(id).value, 10); return Number.isFinite(v) ? v : undefined; };
  const body = {
    phddns: {
      enabled: document.getElementById('tnl-ph-enabled').checked,
      url: document.getElementById('tnl-ph-url').value.trim(),
    },
    tailscale: {
      enabled: document.getElementById('tnl-ts-enabled').checked,
      url: document.getElementById('tnl-ts-url').value.trim(),
      funnel: document.getElementById('tnl-ts-funnel').checked,
    },
  };
  const fp = parseInt(document.getElementById('tnl-ts-funnelport').value, 10);
  if (Number.isFinite(fp) && fp > 0) body.tailscale.funnelPort = fp;
  const iv = numOr('tnl-interval'); if (iv) body.intervalSec = iv;
  const ft = numOr('tnl-failthreshold'); if (ft) body.failThreshold = ft;
  const cd = numOr('tnl-cooldown'); if (cd !== undefined) body.restartCooldownSec = cd;
  const mr = numOr('tnl-maxrestarts'); if (mr) body.maxRestartsPerHour = mr;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (_urlToken) headers['X-Access-Token'] = _urlToken;
    const res = await fetch('/api/settings/tunnel', { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (msg) { msg.textContent = '已保存'; msg.className = 'status-text ok'; }
    showToast('外网穿透设置已保存');
    loadTunnelSettings();
  } catch (e) {
    if (msg) { msg.textContent = '错误: ' + e.message; msg.className = 'status-text err'; }
  }
}

async function restartTunnel(provider) {
  const msgId = provider === 'phddns' ? 'tnl-ph-msg' : 'tnl-ts-msg';
  const msg = document.getElementById(msgId);
  if (msg) { msg.textContent = '正在重启…'; msg.className = 'status-text'; }
  try {
    const headers = {};
    if (_urlToken) headers['X-Access-Token'] = _urlToken;
    const res = await fetch('/api/tunnel/restart/' + provider, { method: 'POST', headers });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
    if (msg) { msg.textContent = data.message || '已触发重启'; msg.className = 'status-text ok'; }
    setTimeout(loadTunnelSettings, 1500);
  } catch (e) {
    if (msg) { msg.textContent = '失败: ' + e.message; msg.className = 'status-text err'; }
  }
}

// Read-only Funnel status text (tailscale funnel status output).
async function loadFunnelStatus() {
  const el = document.getElementById('tnl-ts-funnelstatus');
  if (!el) return;
  try {
    const res = await fetch('/api/tunnel/funnel' + tokenQS('?'));
    const data = await res.json();
    el.textContent = (data.status && data.status.trim()) || '未开启 (No serve config)';
  } catch (_) { el.textContent = '—'; }
}

// Detect whether remote clients can reach this host via direct IPv6 (vs DERP relay).
// `manual` = triggered by the 检测 button → show a transient "检测中…" hint.
async function loadIpv6Status(manual) {
  const sEl = document.getElementById('tnl-ipv6-status');
  const aEl = document.getElementById('tnl-ipv6-addr');
  if (!sEl) return;
  if (manual) sEl.textContent = '检测中…';
  try {
    const res = await fetch('/api/tunnel/ipv6' + tokenQS('?'));
    const d = await res.json();
    if (!res.ok || d.error) throw new Error(d.error || ('HTTP ' + res.status));
    const ts = d.tailscale || {};
    if (d.directReady) {
      sEl.textContent = '✅ 就绪 — 远程可走 IPv6 直连';
      sEl.style.color = 'var(--green, #16a34a)';
    } else if (!d.host || !d.host.hasGlobalV6) {
      sEl.textContent = '❌ 本机无全局 IPv6（路由器/ISP 未下发）';
      sEl.style.color = 'var(--err, #dc2626)';
    } else if (ts.available && ts.ipv6 === false) {
      sEl.textContent = '⚠️ 有本机地址但 Tailscale 测不通 IPv6（可能被运营商拦入站）';
      sEl.style.color = 'var(--warn, #d97706)';
    } else {
      sEl.textContent = '✅ 本机有全局 IPv6' + (ts.available ? '' : '（无 tailscale CLI，未二次验证）');
      sEl.style.color = 'var(--green, #16a34a)';
    }
    const addrs = (d.host && d.host.addresses || []).map(x => `${x.address} (${x.iface})`);
    let line = addrs.length ? addrs.join('\n') : '无';
    if (ts.detail) line += `\nTailscale netcheck → IPv6: ${ts.detail}`;
    if (ts.nearestDerp) line += `\n最近 DERP 中继: ${ts.nearestDerp}`;
    if (aEl) aEl.textContent = line;
  } catch (e) {
    sEl.textContent = '检测失败: ' + e.message;
    sEl.style.color = 'var(--err, #dc2626)';
  }
}

// Apply the Funnel checkbox: open/close public-internet exposure on the port.
async function applyFunnel() {
  const msg = document.getElementById('tnl-ts-msg');
  const on = document.getElementById('tnl-ts-funnel').checked;
  const port = parseInt(document.getElementById('tnl-ts-funnelport').value, 10) || 3000;
  if (on && !confirm(`确定开启 Funnel 公网访问？\n这会把端口 ${port} 暴露到整个互联网（任何人凭 URL 可访问）。\n请确认已设置足够强的 ACCESS_TOKEN。`)) return;
  if (msg) { msg.textContent = on ? '正在开启 Funnel…' : '正在关闭 Funnel…'; msg.className = 'status-text'; }
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (_urlToken) headers['X-Access-Token'] = _urlToken;
    const res = await fetch('/api/tunnel/funnel', { method: 'POST', headers, body: JSON.stringify({ on, port }) });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || data.message || ('HTTP ' + res.status));
    if (msg) { msg.textContent = data.message || '完成'; msg.className = 'status-text ok'; }
    // Persist the funnel flag/port into config too, then refresh status.
    saveTunnelSettings();
    setTimeout(loadFunnelStatus, 1200);
  } catch (e) {
    if (msg) { msg.textContent = '失败: ' + e.message; msg.className = 'status-text err'; }
  }
}

/* ── APK info ── */
async function loadApkInfo() {
  const btn = document.getElementById('apk-btn');
  if (!btn) return;
  try {
    const resp = await fetch('/api/apk-info' + tokenQS('?'));
    const info = await resp.json();
    if (info.exists) {
      const d = new Date(info.mtime);
      const time = `${d.getMonth()+1}-${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      const sizeMB = (info.size / 1048576).toFixed(1);
      btn.textContent = `APK (${time})`;
      btn.title = `Download Android App — ${sizeMB}MB — Updated ${time}`;
    }
  } catch {}
}

/* ── Installed skills + Claude history management ── */
let _agentSkills = [];
let _claudeHistory = [];

async function loadAgentSkills() {
  const list = document.getElementById('skills-list');
  if (!list) return;
  list.innerHTML = '<div class="resource-empty">Loading…</div>';
  try {
    const res = await fetch('/api/agent-resources/skills' + tokenQS('?'));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    _agentSkills = data.skills || [];
    document.getElementById('skills-summary').textContent =
      `${data.counts?.claude || 0} Claude · ${data.counts?.codex || 0} Codex`;
    renderSkills();
  } catch (err) {
    list.innerHTML = `<div class="resource-empty">Load failed: ${escapeHtml(err.message)}</div>`;
  }
}

function renderSkills() {
  const list = document.getElementById('skills-list');
  if (!list) return;
  const q = (document.getElementById('skills-filter')?.value || '').trim().toLowerCase();
  const skills = _agentSkills.filter(s =>
    !q || `${s.provider} ${s.source} ${s.name} ${s.description} ${s.path}`.toLowerCase().includes(q));
  if (!skills.length) {
    list.innerHTML = '<div class="resource-empty">No matching skills</div>';
    return;
  }
  list.innerHTML = skills.map(s => `
    <div class="resource-row">
      <span class="resource-badge ${escapeHtml(s.provider)}">${escapeHtml(s.provider)}</span>
      <div class="resource-main">
        <div class="resource-title">${escapeHtml(s.name || '(unnamed skill)')}</div>
        ${s.description ? `<div class="resource-desc" title="${escapeHtml(s.description)}">${escapeHtml(s.description)}</div>` : ''}
        <div class="resource-meta" title="${escapeHtml(s.path)}">${escapeHtml(s.source)} · ${escapeHtml(s.path)}</div>
      </div>
    </div>`).join('');
}

async function loadClaudeHistory() {
  const list = document.getElementById('claude-history-list');
  if (!list) return;
  list.innerHTML = '<div class="resource-empty">Loading…</div>';
  try {
    const res = await fetch('/api/agent-resources/claude-sessions' + tokenQS('?'));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    _claudeHistory = data.sessions || [];
    document.getElementById('claude-history-summary').textContent =
      `${data.count || 0} sessions · ${fmtSize(data.totalSize || 0)} · ${data.protectedCount || 0} protected`;
    renderClaudeHistory();
  } catch (err) {
    list.innerHTML = `<div class="resource-empty">Load failed: ${escapeHtml(err.message)}</div>`;
  }
}

function renderClaudeHistory() {
  const list = document.getElementById('claude-history-list');
  if (!list) return;
  const q = (document.getElementById('claude-history-filter')?.value || '').trim().toLowerCase();
  const sessions = _claudeHistory.filter(s =>
    !q || `${s.id} ${s.title} ${s.preview} ${s.cwd} ${s.project}`.toLowerCase().includes(q));
  if (!sessions.length) {
    list.innerHTML = '<div class="resource-empty">No matching Claude history sessions</div>';
    return;
  }
  list.innerHTML = sessions.map(s => {
    const updated = new Date(s.updatedAt).toLocaleString();
    return `
      <div class="resource-row">
        ${s.linked ? '<span class="resource-badge protected">protected</span>' : '<span class="resource-badge claude">history</span>'}
        <div class="resource-main">
          <div class="resource-title" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</div>
          <div class="resource-desc" title="${escapeHtml(s.cwd || s.project)}">${escapeHtml(s.cwd || s.project)}</div>
          <div class="resource-meta">${escapeHtml(s.id)} · ${escapeHtml(updated)} · ${fmtSize(s.size || 0)}</div>
        </div>
        <button class="btn btn-danger btn-sm" ${s.linked ? 'disabled title="Linked to MultiCC"' : ''}
          onclick="deleteClaudeHistorySession(decodeURIComponent('${inlineEncoded(s.project)}'),decodeURIComponent('${inlineEncoded(s.id)}'))">Delete</button>
      </div>`;
  }).join('');
}

async function deleteClaudeHistorySession(project, id) {
  if (!confirm(`Delete Claude history session ${id}?\nThis cannot be undone.`)) return;
  const status = document.getElementById('claude-history-status');
  try {
    status.textContent = 'Deleting…';
    const url = `/api/agent-resources/claude-sessions/${encodeURIComponent(project)}/${encodeURIComponent(id)}${tokenQS('?')}`;
    const res = await fetch(url, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    status.textContent = `Deleted ${id}, freed ${fmtSize(data.freed || 0)}`;
    await loadClaudeHistory();
  } catch (err) {
    status.textContent = `Delete failed: ${err.message}`;
  }
}

async function cleanupClaudeHistory() {
  const days = Number(document.getElementById('claude-history-age').value);
  if (!confirm(`Delete every unprotected Claude history session older than ${days} days?\nThis cannot be undone.`)) return;
  const status = document.getElementById('claude-history-status');
  try {
    status.textContent = 'Cleaning…';
    const suffix = tokenQS('?');
    const url = `/api/agent-resources/claude-sessions${suffix}${suffix ? '&' : '?'}olderThanDays=${days}`;
    const res = await fetch(url, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    status.textContent = `Deleted ${data.deleted} sessions, freed ${fmtSize(data.freed || 0)}`;
    await loadClaudeHistory();
  } catch (err) {
    status.textContent = `Cleanup failed: ${err.message}`;
  }
}

/* ── Temp upload stats & cleanup ── */
function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}

async function loadUploadStats() {
  try {
    const res = await fetch('/api/uploads/stats' + tokenQS('?'));
    const data = await res.json();
    document.getElementById('st-count').textContent = data.count + ' files';
    document.getElementById('st-size').textContent = fmtSize(data.totalSize);
    document.getElementById('st-dir').textContent = data.dir;
    document.getElementById('st-cleanup-btn').disabled = data.count === 0;
    document.getElementById('st-status').textContent = '';
  } catch (err) {
    document.getElementById('st-status').textContent = 'Load failed';
  }
}

async function cleanupUploads() {
  const stStatus = document.getElementById('st-status');
  if (!(await showConfirm('Delete all temporary uploaded files?', { danger: true, okText: '删除' }))) return;
  try {
    stStatus.textContent = 'Cleaning...';
    const res = await fetch('/api/uploads/cleanup' + tokenQS('?'), { method: 'DELETE' });
    const data = await res.json();
    stStatus.textContent = `Deleted ${data.deleted} files, freed ${fmtSize(data.freed)}`;
    loadUploadStats();
  } catch (err) {
    stStatus.textContent = 'Cleanup failed';
  }
}

/* ── AuxQueue: history viewer + WebSocket ── */
let _auxWs = null;
let _auxHistory = [];
let _auxConnected = false;

function auxConnect() {
  if (_auxWs && _auxWs.readyState <= 1) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const tokenParam = _urlToken ? `?token=${_urlToken}` : '';
  _auxWs = new WebSocket(`${proto}//${location.host}/ws/aux${tokenParam}`);

  _auxWs.onopen = () => { _auxConnected = true; };

  _auxWs.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'aux_history') {
        _auxHistory = msg.messages || [];
        if (_focusedSessionId === '__aux__') renderAuxPanel();
      } else if (msg.type === 'aux_init') {
        // status info on connect — will be refreshed via /api/sessions
      } else if (msg.type === 'aux_event') {
        // Real-time task event — append to history display
        if (msg.status === 'done' || msg.status === 'error') {
          // Refresh history from full data on next render
          loadSessions();
        }
        if (_focusedSessionId === '__aux__') renderAuxTaskEvent(msg);
      }
    } catch (_) {}
  };

  _auxWs.onclose = () => {
    _auxConnected = false;
    setTimeout(auxConnect, 5000);
  };
  _auxWs.onerror = () => {};
}

function focusAux() {
  acknowledgeSession('__aux__');
  if (_focusedSessionId === '__aux__') return;
  _focusedSessionId = '__aux__';

  document.body.classList.add('has-focus');
  focusId.textContent = 'AI Assistant';
  focusId.style.color = '#d2a8ff';
  focusCwd.textContent = 'AuxQueue — Intent Classification Service';

  // Hide all cached iframes + the original placeholder
  focusIframe.style.display = 'none';
  for (const [, frame] of _iframeCache) frame.style.display = 'none';

  // Show aux history panel
  let auxPanel = document.getElementById('aux-panel');
  if (!auxPanel) {
    auxPanel = document.createElement('div');
    auxPanel.id = 'aux-panel';
    auxPanel.style.cssText = 'flex:1;overflow-y:auto;padding:16px;font-family:monospace;font-size:12px;background:#0d1117;';
    focusContainer.appendChild(auxPanel);
  }
  auxPanel.style.display = '';
  renderAuxPanel();
  renderSessions(_cachedSessions);

  // Ensure WS connected
  auxConnect();
}

function renderAuxPanel() {
  const panel = document.getElementById('aux-panel');
  if (!panel) return;

  if (_auxHistory.length === 0) {
    panel.innerHTML = '<div style="text-align:center;color:#484f58;padding:40px 0;">No tasks yet</div>';
    return;
  }

  // Group history into task pairs (user prompt + assistant result)
  const tasks = [];
  for (let i = 0; i < _auxHistory.length; i++) {
    const msg = _auxHistory[i];
    if (msg.role === 'user' && i + 1 < _auxHistory.length && _auxHistory[i + 1].role === 'assistant') {
      tasks.push({ input: msg, output: _auxHistory[i + 1] });
      i++; // skip assistant
    } else if (msg.role === 'user') {
      tasks.push({ input: msg, output: null });
    }
  }

  // Reverse to show newest first
  tasks.reverse();

  const html = tasks.map(t => {
    const time = new Date(t.input.ts);
    const timeStr = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}:${time.getSeconds().toString().padStart(2, '0')}`;
    const taskType = t.input.taskType || 'unknown';
    const meta = t.input.meta || {};
    const metaStr = meta.sessionName ? `session=${escapeHtml(meta.sessionName)}` : '';

    let resultHtml = '<span style="color:#d29922;">pending...</span>';
    let durationHtml = '';
    if (t.output) {
      const isErr = t.output.error;
      const isCancelled = t.output.cancelled;
      const text = escapeHtml((t.output.content || '').trim());
      const color = isErr ? '#f85149' : isCancelled ? '#d29922' : '#3fb950';
      const label = isErr ? 'ERR' : isCancelled ? 'CANCELLED' : text;
      resultHtml = `<span style="color:${color};font-weight:600;">${label}</span>`;
      if (t.output.durationMs) durationHtml = `<span style="color:#484f58;margin-left:8px;">${(t.output.durationMs / 1000).toFixed(1)}s</span>`;
    }

    // Truncated prompt preview
    const promptPreview = escapeHtml((t.input.content || '').split('\n').pop().slice(0, 80));

    return `
      <div style="border-left:2px solid #8957e5;padding:6px 10px;margin-bottom:8px;background:#161b22;border-radius:0 6px 6px 0;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <span style="color:#484f58;">${timeStr}</span>
          <span style="color:#d2a8ff;font-weight:600;">${escapeHtml(taskType)}</span>
          <span style="color:#6e7681;">${metaStr}</span>
          <span style="margin-left:auto;">${resultHtml}${durationHtml}</span>
        </div>
        <div style="color:#8b949e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(t.input.content || '')}">${promptPreview}</div>
      </div>`;
  }).join('');

  panel.innerHTML = html;
}

function renderAuxTaskEvent(msg) {
  // For real-time events, just show a transient notification at top of panel
  const panel = document.getElementById('aux-panel');
  if (!panel) return;
  const statusColors = { queued: '#d29922', processing: '#58a6ff', done: '#3fb950', error: '#f85149', cancelled: '#6e7681' };
  const color = statusColors[msg.status] || '#8b949e';
  const existing = document.getElementById('aux-live-status');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = 'aux-live-status';
  div.style.cssText = `padding:8px 12px;margin-bottom:12px;background:#21262d;border-radius:6px;border:1px solid ${color};color:${color};font-weight:600;`;
  div.textContent = `${msg.status.toUpperCase()}: ${msg.task?.type || ''}${msg.result ? ' → ' + msg.result : ''}${msg.error ? ' → ' + msg.error : ''}`;
  panel.prepend(div);
  // Auto-remove after 10s
  setTimeout(() => { if (div.parentNode) div.remove(); }, 10000);
}

// Override closeFocusPanel to also hide aux panel
const _origCloseFocus = closeFocusPanel;
closeFocusPanel = function() {
  const auxPanel = document.getElementById('aux-panel');
  if (auxPanel) auxPanel.style.display = 'none';
  focusId.style.color = ''; // reset color
  _origCloseFocus();
};

// Also hide aux panel when focusing a regular session
const _origFocusSession = focusSession;
focusSession = function(id) {
  const auxPanel = document.getElementById('aux-panel');
  if (auxPanel) auxPanel.style.display = 'none';
  focusId.style.color = ''; // reset color
  _origFocusSession(id);
};

/* ── Provider config (cc-switch) ── */
let _providerData = { available: false, providers: [], defaults: { claude: null, codex: null } };
const PROVIDER_PRESETS = [
  { key: 'claude-subscription', label: 'Claude 官方订阅', appType: 'claude', baseUrl: '', model: '', note: '无需 key，留空 Key 直接创建=走本地登录/订阅' },
  { key: 'claude-api', label: 'Claude 官方 API', appType: 'claude', baseUrl: 'https://api.anthropic.com', model: '' },
  { key: 'claude-glm', label: '智谱 GLM', appType: 'claude', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-4.6' },
  { key: 'claude-deepseek', label: 'DeepSeek', appType: 'claude', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat' },
  { key: 'claude-minimax', label: 'MiniMax', appType: 'claude', baseUrl: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-M2' },
  { key: 'claude-qwen', label: 'Qwen 通义千问', appType: 'claude', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic', model: 'qwen3-coder-plus' },
  { key: 'claude-openrouter', label: 'OpenRouter', appType: 'claude', baseUrl: 'https://openrouter.ai/api', model: 'anthropic/claude-sonnet-4.5', note: '必须用 /api 不是 /api/v1' },
  { key: 'codex-official', label: 'Codex 官方', appType: 'codex', baseUrl: '', model: '', note: '走 ChatGPT 登录' },
  { key: 'codex-deepseek', label: 'DeepSeek', appType: 'codex', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', useChatResponsesProxy: true, note: '✅ 经本地代理转换 chat→responses' },
  { key: 'codex-glm', label: '智谱 GLM', appType: 'codex', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6', useChatResponsesProxy: true, note: '✅ 经本地代理转换 chat→responses' },
  { key: 'codex-qwen', label: 'Qwen 通义千问', appType: 'codex', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-coder-plus', useChatResponsesProxy: true, note: '✅ 经本地代理转换 chat→responses' },
  { key: 'codex-minimax', label: 'MiniMax', appType: 'codex', baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-M2', useChatResponsesProxy: true, note: '✅ 经本地代理转换 chat→responses' },
  { key: 'codex-openrouter', label: 'OpenRouter', appType: 'codex', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', useChatResponsesProxy: false, note: '✅ 直连 responses 协议（原生支持）' },
];

function providerModelList(primary, raw) {
  const seen = new Set();
  return [primary, ...(raw || '').split(/[\n,]/)]
    .map(s => String(s || '').trim())
    .filter(s => s && !seen.has(s) && seen.add(s));
}

function syncNewProviderProxyVisibility() {
  const appType = document.getElementById('prov-new-apptype');
  const row = document.getElementById('prov-new-proxy-row');
  if (row && appType) row.style.display = appType.value === 'codex' ? '' : 'none';
}
document.getElementById('prov-new-apptype')?.addEventListener('change', syncNewProviderProxyVisibility);

function applyProviderPreset() {
  const presetSel = document.getElementById('prov-new-preset');
  const appType = document.getElementById('prov-new-apptype');
  const name = document.getElementById('prov-new-name');
  const baseUrl = document.getElementById('prov-new-baseurl');
  const token = document.getElementById('prov-new-token');
  const model = document.getElementById('prov-new-model');
  const models = document.getElementById('prov-new-models');
  const proxy = document.getElementById('prov-new-chat-proxy');
  const status = document.getElementById('prov-new-status');
  if (!presetSel || !appType || !name || !baseUrl || !token || !model) return;

  const preset = PROVIDER_PRESETS.find(p => p.key === presetSel.value);
  if (!preset) {
    name.value = '';
    baseUrl.value = '';
    model.value = '';
    if (models) models.value = '';
    if (proxy) proxy.checked = false;
    if (status) { status.textContent = ''; status.className = 'status-text'; }
    return;
  }

  appType.value = preset.appType;
  appType.dispatchEvent(new Event('change', { bubbles: true }));
  name.value = preset.label;
  baseUrl.value = preset.baseUrl;
  model.value = preset.model;
  if (models) models.value = preset.model || '';
  if (proxy) proxy.checked = !!preset.useChatResponsesProxy;
  token.value = '';
  if (status) {
    status.textContent = preset.note || '已套用模板，请填写 API Key';
    status.className = 'status-text';
  }
  token.focus();
}

syncNewProviderProxyVisibility();

async function loadProviders() {
  try {
    const res = await fetch('/api/providers' + tokenQS('?'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _providerData = await res.json();
  } catch (_) {
    _providerData = { available: true, ccSwitchAvailable: false, providers: [], defaults: { claude: null, codex: null } };
  }
  // cc-switch only gates the import button, not the store itself.
  const ccUnavail = document.getElementById('provider-ccswitch-unavailable');
  if (ccUnavail) ccUnavail.style.display = _providerData.ccSwitchAvailable ? 'none' : '';
  const importBtn = document.getElementById('prov-import-btn');
  if (importBtn) importBtn.disabled = !_providerData.ccSwitchAvailable;
  renderProviderDefaults();
  renderProviderList();
  loadGlobalUsage();
}

// ── Global Claude Code token usage (from ~/.claude/projects transcripts) ──
let _globalUsage = null;
let _guWindow = 'month';

async function loadGlobalUsage(force) {
  const body = document.getElementById('global-usage-body');
  if (body && force) body.innerHTML = '<span style="color:var(--faint);font-size:13px">重新扫描中…</span>';
  try {
    const base = '/api/token-usage/global';
    const qs = tokenQS('?');
    const url = base + qs + (force ? (qs ? '&refresh=1' : '?refresh=1') : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _globalUsage = await res.json();
  } catch (e) {
    if (body) body.innerHTML = `<span class="status-text err">加载失败：${escapeHtml(e.message)}</span>`;
    return;
  }
  renderGlobalUsage();
}

function setGuWindow(w) { _guWindow = w; renderGlobalUsage(); }

function renderGuTrend() {
  const byDay = (_globalUsage && _globalUsage.byDay) || {};
  const days = Object.keys(byDay).sort().slice(-14);
  if (!days.length) return '';
  const totals = days.map(d => Object.values(byDay[d]).reduce((a, b) => a + b, 0));
  const max = Math.max(...totals, 1);
  const bars = days.map((d, i) => {
    const pct = Math.max(2, Math.round(totals[i] / max * 100));
    return `<div style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--faint);margin-bottom:2px">
      <span style="width:48px">${d.slice(5)}</span>
      <div style="flex:1;background:var(--bg-soft);border-radius:3px;overflow:hidden;height:11px"><div style="width:${pct}%;height:100%;background:var(--amber);opacity:.55"></div></div>
      <span style="width:56px;text-align:right">${formatTokens(totals[i])}</span>
    </div>`;
  }).join('');
  return `<div style="margin-top:12px"><div style="font-size:11px;color:var(--faint);margin-bottom:6px">近 ${days.length} 个有活动的日子（含缓存总 token/天）</div>${bars}</div>`;
}

function renderGlobalUsage() {
  const body = document.getElementById('global-usage-body');
  if (!body || !_globalUsage) return;
  document.querySelectorAll('#gu-tabs .gu-tab').forEach(b => {
    b.classList.toggle('btn-green', b.dataset.w === _guWindow);
  });
  const w = _globalUsage.windows[_guWindow] || {};
  const rows = Object.entries(w).map(([model, b]) => ({
    model, ...b, total: b.inputTokens + b.outputTokens + b.cacheWrite + b.cacheRead,
  })).sort((a, b) => b.total - a.total);
  if (!rows.length) { body.innerHTML = '<span style="color:var(--faint);font-size:13px">该时段暂无数据</span>'; return; }
  const ft = formatTokens;
  let tin = 0, tout = 0, tcw = 0, tcr = 0, tmsg = 0;
  const trh = rows.map(r => {
    tin += r.inputTokens; tout += r.outputTokens; tcw += r.cacheWrite; tcr += r.cacheRead; tmsg += r.msgs;
    const isClaude = /claude|opus|haiku|sonnet|fable/i.test(r.model);
    return `<tr>
      <td style="padding:4px 8px;font-size:11px;color:${isClaude ? 'var(--amber)' : 'var(--faint)'}">${escapeHtml(r.model)}</td>
      <td style="padding:4px 8px;text-align:right">${ft(r.inputTokens)}</td>
      <td style="padding:4px 8px;text-align:right">${ft(r.outputTokens)}</td>
      <td style="padding:4px 8px;text-align:right;color:var(--faint)">${ft(r.cacheWrite)}</td>
      <td style="padding:4px 8px;text-align:right;color:var(--faint)">${ft(r.cacheRead)}</td>
      <td style="padding:4px 8px;text-align:right;font-weight:600">${ft(r.total)}</td>
    </tr>`;
  }).join('');
  const fresh = tin + tout, grand = tin + tout + tcw + tcr;
  const gen = _globalUsage.generatedAt ? new Date(_globalUsage.generatedAt).toLocaleTimeString() : '';
  body.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="color:var(--faint);font-size:11px">
        <th style="text-align:left;padding:4px 8px">模型</th><th style="text-align:right;padding:4px 8px">输入</th><th style="text-align:right;padding:4px 8px">输出</th><th style="text-align:right;padding:4px 8px">缓存写</th><th style="text-align:right;padding:4px 8px">缓存读</th><th style="text-align:right;padding:4px 8px">总计</th>
      </tr></thead>
      <tbody>${trh}</tbody>
      <tfoot><tr style="border-top:1px solid var(--line);font-weight:600">
        <td style="text-align:left;padding:6px 8px">合计</td><td style="text-align:right;padding:6px 8px">${ft(tin)}</td><td style="text-align:right;padding:6px 8px">${ft(tout)}</td><td style="text-align:right;padding:6px 8px">${ft(tcw)}</td><td style="text-align:right;padding:6px 8px">${ft(tcr)}</td><td style="text-align:right;padding:6px 8px">${ft(grand)}</td>
      </tr></tfoot>
    </table>
    <div style="margin-top:8px;font-size:12px;color:var(--muted)">
      新鲜 token（输入+输出，反映真实工作量）：<b style="color:var(--text)">${ft(fresh)}</b> · 含缓存总量：${ft(grand)} · ${tmsg} 次响应${gen ? ` · 扫描于 ${gen}` : ''}
    </div>
    ${renderGuTrend()}`;
}

async function importProviders() {
  const status = document.getElementById('prov-import-status');
  try {
    const res = await fetch('/api/providers/import' + tokenQS('?'), { method: 'POST' });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    if (status) { status.textContent = `已导入 ${d.imported} 个、刷新 ${d.updated} 个`; status.className = 'status-text ok'; }
    showToast(`从 cc-switch 同步：新增 ${d.imported}、刷新 ${d.updated}（共 ${d.total}）`);
    loadProviders();
  } catch (err) {
    if (status) { status.textContent = `Failed: ${err.message}`; status.className = 'status-text err'; }
  }
}

function providerLabel(p) {
  const bits = [p.name];
  if (p.isOfficial) bits.push('· 默认登录/订阅');
  else if (p.baseUrl) bits.push('· ' + p.baseUrl.replace(/^https?:\/\//, ''));
  if (p.model) bits.push('· ' + p.model);
  return bits.join(' ');
}

function renderProviderDefaults() {
  for (const cli of ['claude', 'codex']) {
    const sel = document.getElementById('prov-default-' + cli);
    if (!sel) continue;
    const list = _providerData.providers.filter(p => p.appType === cli);
    const cur = _providerData.defaults[cli] || '';
    sel.innerHTML = '<option value="">默认登录 / 订阅（不覆盖）</option>' +
      list.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(providerLabel(p))}</option>`).join('');
    sel.value = cur;
  }
}

function formatTokens(n) {
  if (n == null || n === 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function renderProviderList() {
  const box = document.getElementById('provider-list');
  if (!box) return;
  if (!_providerData.providers.length) {
    box.innerHTML = '<span style="color:var(--faint);font-size:13px">还没有 provider。' +
      (_providerData.available ? '在下方新增。' : 'cc-switch 不可用。') + '</span>';
    return;
  }
  box.innerHTML = _providerData.providers.map(p => {
    const stat = (_providerData.stats || []).find(s => s.providerId === p.id);
    let statHtml = '';
    if (stat) {
      const wf = (w) => {
        if (!w || (w.inputTokens + w.outputTokens === 0)) return '';
        const i = formatTokens(w.inputTokens);
        const o = formatTokens(w.outputTokens);
        return `I:${i}/O:${o}`;
      };
      const parts = [];
      if (stat.today) { const s = wf(stat.today); if (s) parts.push(`日${s}`); }
      if (stat.week) { const s = wf(stat.week); if (s) parts.push(`周${s}`); }
      if (stat.month) { const s = wf(stat.month); if (s) parts.push(`月${s}`); }
      parts.push(`累计 <b>${formatTokens(stat.totalTokens)}</b>（${stat.turnCount}轮/${stat.sessionCount}会话）`);
      statHtml = parts.join(' · ');
    }
    return `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;">
      <span style="font-size:11px;padding:2px 6px;border-radius:4px;background:var(--bg-soft);color:var(--faint)">${escapeHtml(p.appType)}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;color:var(--text);font-weight:600">${escapeHtml(p.name)} <span style="font-weight:400;font-size:11px;color:var(--faint)">${p.source === 'ccswitch' ? '· 来自 cc-switch' : '· 本地'}</span></div>
        ${statHtml ? `<div style="font-size:11px;color:var(--amber);margin-top:3px">${statHtml}</div>` : ''}
        <div style="font-size:11px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.isOfficial ? '默认登录 / 订阅' : (p.baseUrl || ''))}${(p.modelOptions || []).length > 1 ? ' · ' + (p.modelOptions || []).length + ' models' : (p.model ? ' · ' + escapeHtml(p.model) : '')}${p.useChatResponsesProxy ? ' · chat→responses' : ''}${p.tokenMask ? ' · ' + escapeHtml(p.tokenMask) : ''}</div>
      </div>
      <button class="btn" style="padding:4px 10px;font-size:12px" onclick="editProvider('${escapeHtml(p.appType)}','${escapeHtml(p.id)}')">编辑</button>
      <button class="btn" style="padding:4px 10px;font-size:12px" onclick="deleteProvider('${escapeHtml(p.appType)}','${escapeHtml(p.id)}','${escapeHtml(p.name)}')">删除</button>
    </div>`;
  }).join('');
}

async function saveProviderDefaults() {
  const status = document.getElementById('prov-default-status');
  const body = {
    claude: document.getElementById('prov-default-claude').value || '',
    codex: document.getElementById('prov-default-codex').value || '',
  };
  try {
    const res = await fetch('/api/provider-defaults' + tokenQS('?'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    _providerData.defaults = d.defaults;
    if (status) { status.textContent = 'Saved'; status.className = 'status-text ok'; }
    showToast('全局默认 provider 已保存');
  } catch (err) {
    if (status) { status.textContent = `Failed: ${err.message}`; status.className = 'status-text err'; }
  }
}

async function createProvider() {
  const status = document.getElementById('prov-new-status');
  const body = {
    appType: document.getElementById('prov-new-apptype').value,
    name: document.getElementById('prov-new-name').value.trim(),
    baseUrl: document.getElementById('prov-new-baseurl').value.trim(),
    authToken: document.getElementById('prov-new-token').value.trim(),
    model: document.getElementById('prov-new-model').value.trim(),
  };
  body.models = providerModelList(body.model, document.getElementById('prov-new-models')?.value || '');
  body.useChatResponsesProxy = document.getElementById('prov-new-chat-proxy')?.checked === true;
  if (!body.name) { if (status) { status.textContent = '名称必填'; status.className = 'status-text err'; } return; }
  try {
    const res = await fetch('/api/providers' + tokenQS('?'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    if (status) { status.textContent = 'Created'; status.className = 'status-text ok'; }
    showToast('Provider 已创建：' + body.name);
    document.getElementById('prov-new-name').value = '';
    document.getElementById('prov-new-baseurl').value = '';
    document.getElementById('prov-new-token').value = '';
    document.getElementById('prov-new-model').value = '';
    document.getElementById('prov-new-models').value = '';
    document.getElementById('prov-new-chat-proxy').checked = false;
    const presetSel = document.getElementById('prov-new-preset');
    if (presetSel) presetSel.value = '';
    loadProviders();
  } catch (err) {
    if (status) { status.textContent = `Failed: ${err.message}`; status.className = 'status-text err'; }
  }
}

function editProvider(appType, id) {
  const p = _providerData.providers.find(x => x.appType === appType && x.id === id);
  if (!p) return;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
  const field = (label, val, ph, type = 'text') =>
    `<label style="display:block;margin-bottom:10px"><div style="font-size:12px;color:var(--faint);margin-bottom:4px">${label}</div>
     <input data-k="${label}" type="${type}" value="${escapeHtml(val || '')}" placeholder="${escapeHtml(ph)}" autocomplete="off"
       style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;box-sizing:border-box"></label>`;
  const textarea = (label, val, ph) =>
    `<label style="display:block;margin-bottom:10px"><div style="font-size:12px;color:var(--faint);margin-bottom:4px">${label}</div>
     <textarea data-k="${label}" rows="3" placeholder="${escapeHtml(ph)}"
       style="width:100%;min-height:74px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;box-sizing:border-box">${escapeHtml(val || '')}</textarea></label>`;
  overlay.innerHTML = `
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:440px;max-width:92vw;">
      <div style="font-size:14px;color:#c9d1d9;font-weight:600;margin-bottom:14px">编辑 Provider · ${escapeHtml(p.appType)}</div>
      ${field('名称', p.name, '名称')}
      ${field('Base URL', p.baseUrl, 'https://…（留空=官方/订阅）')}
      ${field('Model', p.model, '可选')}
      ${textarea('模型列表', (p.modelOptions || []).join('\n'), '每行一个模型；留空则只使用 Model')}
      ${appType === 'codex' ? `<label style="display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px;margin-bottom:10px">
        <input id="ep-chat-proxy" type="checkbox" ${p.useChatResponsesProxy ? 'checked' : ''}> OpenAI chat 协议转 response 协议
      </label>` : ''}
      ${field('API Key', '', p.hasToken ? '留空 = 保留原 key（' + (p.tokenMask || '已设置') + '）' : '未设置', 'password')}
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
        <button class="btn" id="ep-cancel" style="font-size:13px">取消</button>
        <button class="btn btn-green" id="ep-save" style="font-size:13px">保存</button>
      </div>
      <div id="ep-status" class="status-text" style="margin-top:8px"></div>
    </div>`;
  document.body.appendChild(overlay);
  const val = (k) => overlay.querySelector(`[data-k="${k}"]`).value.trim();
  const close = () => overlay.remove();
  overlay.querySelector('#ep-cancel').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#ep-save').onclick = async () => {
    const body = {
      name: val('名称'),
      baseUrl: val('Base URL'),
      model: val('Model'),
      models: providerModelList(val('Model'), val('模型列表')),
    };
    if (appType === 'codex') body.useChatResponsesProxy = overlay.querySelector('#ep-chat-proxy')?.checked === true;
    const tok = val('API Key');
    if (tok) body.authToken = tok;  // blank = keep existing
    const st = overlay.querySelector('#ep-status');
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(appType)}/${encodeURIComponent(id)}` + tokenQS('?'), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      showToast('Provider 已更新');
      close();
      loadProviders();
    } catch (err) { st.textContent = 'Failed: ' + err.message; st.className = 'status-text err'; }
  };
}

async function deleteProvider(appType, id, name) {
  if (!confirm(`删除 provider「${name}」？（会从 cc-switch 移除）`)) return;
  try {
    const res = await fetch(`/api/providers/${encodeURIComponent(appType)}/${encodeURIComponent(id)}` + tokenQS('?'), { method: 'DELETE' });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    showToast('已删除：' + name);
    loadProviders();
  } catch (err) {
    showToast('删除失败：' + err.message);
  }
}

/* ── Init ── */
loadDashboard();
loadProviders();
loadVoiceSettings();
loadGoalSettings();
loadMacosPowerSettings();
loadAsrSettings();
loadCronTasks();
loadPushDiagnostics();
loadNotifySettings();
loadTunnelSettings();
loadApkInfo();
loadAgentSkills();
loadClaudeHistory();
loadUploadStats();
wechatLoadConfig();
wechatCheckStatus();
feishuLoadConfig();
feishuCheckStatus();
for (const _p of Object.keys(TOKEN_BRIDGES)) { bridgeLoadConfig(_p); bridgeCheckStatus(_p); }
auxConnect();
autoRefreshTimer = setInterval(loadDashboard, 5000);
// Refresh push diagnostics periodically and on visibility change
setInterval(loadPushDiagnostics, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadPushDiagnostics();
});

// Mobile sidebar: click on backdrop (body::before) to close nav
document.addEventListener('click', (e) => {
  if (window.innerWidth <= 860 && document.body.classList.contains('nav-open')) {
    // Check if click is outside the nav (on the backdrop area)
    const nav = document.getElementById('nav');
    if (!nav.contains(e.target) && e.target.id !== 'nav-toggle') {
      document.body.classList.remove('nav-open');
    }
  }
});
