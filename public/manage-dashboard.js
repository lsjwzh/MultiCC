'use strict';

// Dashboard/directory/session-card controller extracted from manage.js.
// This classic script consumes only the page's sanitized summary caches; it never
// accepts auth tokens or raw provider credential objects.

// Directory/card grid template — phone screens get a single minmax(0,1fr) column
// so long nowrap content (e.g. file paths in dir-cards) cannot force the grid
// track wider than the viewport and clip cards on the right.
const MOBILE_GRID_BREAKPOINT = 860;
function directoryGridTemplate() {
  return window.innerWidth <= MOBILE_GRID_BREAKPOINT
    ? 'minmax(0, 1fr)'
    : 'repeat(auto-fill, minmax(400px, 1fr))';
}
// Re-apply the grid template when the viewport size class changes (portrait ↔
// landscape, or window resize). We only adjust when crossing the breakpoint to
// avoid recomputing on every pixel of resize. Containers we manage mark
// themselves with the .multicc-auto-grid class (see renderDirectories / cron).
let _lastGridWasMobile = window.innerWidth <= MOBILE_GRID_BREAKPOINT;
window.addEventListener('resize', () => {
  const isMobile = window.innerWidth <= MOBILE_GRID_BREAKPOINT;
  if (isMobile === _lastGridWasMobile) return;
  _lastGridWasMobile = isMobile;
  for (const el of document.querySelectorAll('.multicc-auto-grid')) {
    if (el.style.display === 'grid') el.style.gridTemplateColumns = directoryGridTemplate();
  }
});

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
  return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(iso) {
  if (!iso) return tt('notAvailable');
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatRelative(iso) {
  if (!iso) return tt('notAvailable');
  const diff = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (diff < 5) return tt('justNow');
  if (diff < 60) return tt('secondsAgo', { n: diff });
  if (diff < 3600) return tt('minutesAgo', { n: Math.floor(diff / 60) });
  return tt('hoursAgo', { n: Math.floor(diff / 3600) });
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

async function startMonitor(sessionId) {
  if (monitors.has(sessionId)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let wsUrl = `${proto}//${location.host}/?id=${encodeURIComponent(sessionId)}`;
  try { wsUrl = await window.multiccWsUrl(wsUrl); } catch (_) { return; }
  if (monitors.has(sessionId)) return;

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

// Fold every live signal we hold for a session into one canonical status, using
// the shared registry (public/status-presentation.js). Every session surface on
// this page goes through here, so a card, its summary line and its KPI popup row
// cannot disagree. `active` is process liveness, not a business state: it only
// decides idle vs offline when no business signal exists.
function sessionCardStatusFor(sessionId, active) {
  return window.MultiCCStatusPresentation.sessionCardStatus({
    workspaceStatus: _workspaceStatus.get(sessionId)?.status,
    monitorStatus: _sessionStatus.get(sessionId),
    active,
  });
}

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
      fetch('/api/directories'),
      fetch('/api/sessions'),
    ]);
    const directories = await dirRes.json();
    const sessions = await sessRes.json();
    _cachedDirectories = directories;
    _cachedSessions = sessions;
    openBellForExistingSessionsOnce(sessions);
    // Load provider list in background if not yet loaded, then re-render
    // session cards so provider names resolve from IDs.
    if (!_providerData.available) {
      loadProviders().then(() => renderDashboard(_cachedDirectories, _cachedSessions));
    }
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
    <div class="session-card${focusedClass}" data-id="${escapeHtml(s.id)}" onclick="openAuxHistoryModal()" style="border-color:#8957e5;">
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
          <button class="btn btn-sm" onclick="event.stopPropagation(); openAuxHistoryModal()">History</button>
        </span>
      </div>
    </div>`;
}

// ── Aux AI model config ──
let _auxConfig = null; // { protocol, providerId, model, providersByProtocol }
function _auxModelLabel() {
  if (!_auxConfig) return 'auxqueue';
  const protocol = _auxConfig.protocol === 'openai' ? 'openai' : 'anthropic';
  const providerList = _auxConfig.providersByProtocol?.[protocol] || [];
  const prov = _auxConfig.providerId
    ? (providerList.find(p => p.id === _auxConfig.providerId)?.name || '未配置')
    : '未配置';
  return `${protocol} · ${prov} · ${_auxConfig.model || '未选择模型'}`;
}
async function loadAuxConfig() {
  try {
    const res = await fetch('/api/aux/config');
    _auxConfig = await res.json();
  } catch (_) { _auxConfig = null; }
}
function refreshAuxProviderOptions() {
  const protocol = (document.getElementById('aux-protocol')?.value || _auxConfig?.protocol || 'anthropic') === 'openai'
    ? 'openai'
    : 'anthropic';
  const sel = document.getElementById('aux-provider');
  if (!sel) return;
  const list = _auxConfig?.providersByProtocol?.[protocol] || [];
  sel.innerHTML = '<option value="">请选择 Provider</option>'
    + list.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} · ${escapeHtml(p.wireApi || '')}</option>`).join('');
  const saved = _auxConfig?.protocol === protocol ? (_auxConfig?.providerId || '') : '';
  sel.value = list.some(provider => provider.id === saved) ? saved : (list[0]?.id || '');
  refreshAuxModelOptions();
}
// Provider → Model linkage: populate the model dropdown from the selected
// callable provider's model catalog.
function refreshAuxModelOptions() {
  const protocol = (document.getElementById('aux-protocol')?.value || _auxConfig?.protocol || 'anthropic') === 'openai'
    ? 'openai'
    : 'anthropic';
  const provId = document.getElementById('aux-provider')?.value || '';
  const sel = document.getElementById('aux-model');
  if (!sel) return;
  const list = _auxConfig?.providersByProtocol?.[protocol] || [];
  const prov = list.find(p => p.id === provId);
  const models = (prov && Array.isArray(prov.modelOptions)) ? prov.modelOptions.slice() : [];
  sel.innerHTML = '<option value="">请选择模型</option>'
    + models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
  const saved = _auxConfig?.providerId === provId ? (_auxConfig?.model || '') : '';
  sel.value = models.includes(saved) ? saved : (models[0] || '');
}
async function openAuxModal() {
  await loadAuxConfig();
  const protocolSel = document.getElementById('aux-protocol');
  if (protocolSel) protocolSel.value = _auxConfig?.protocol === 'openai' ? 'openai' : 'anthropic';
  refreshAuxProviderOptions();
  const st = document.getElementById('aux-modal-status');
  if (st) st.textContent = '';
  document.getElementById('aux-modal')?.classList.add('visible');
}
function closeAuxModal() {
  document.getElementById('aux-modal')?.classList.remove('visible');
}
async function saveAuxConfig() {
  const st = document.getElementById('aux-modal-status');
  const protocol = (document.getElementById('aux-protocol')?.value || 'anthropic') === 'openai' ? 'openai' : 'anthropic';
  const providerId = document.getElementById('aux-provider')?.value || '';
  const model = document.getElementById('aux-model')?.value || '';
  if (st) st.textContent = '保存中…';
  try {
    const res = await fetch('/api/aux/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocol, providerId, model }),
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
// Re-judge EVERY non-system session's goal/phase with the current aux model.
// Uses the existing /api/reclassify-all endpoint with onlyJunk:false (all
// sessions, not just the ones with junk goals). Results arrive async via WS.
async function reclassifyAllSessions() {
  const st = document.getElementById('aux-modal-status');
  const btn = document.getElementById('aux-reclassify-btn');
  if (btn) btn.disabled = true;
  if (st) st.textContent = '重跑中…';
  try {
    const res = await fetch('/api/reclassify-all', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ onlyJunk: false }),
    });
    const data = await res.json();
    if (!res.ok || data.error) { if (st) st.textContent = data.error || '重跑失败'; return; }
    if (st) st.textContent = `已重跑 ${data.count} 个会话，结果稍后异步更新 ✓`;
  } catch (e) {
    if (st) st.textContent = '重跑失败：' + (e?.message || e);
  } finally {
    if (btn) btn.disabled = false;
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
    // Phone screens: single column that can shrink (min 0) so long nowrap
    // path strings inside cards can't force the track past the viewport.
    listEl.style.gridTemplateColumns = directoryGridTemplate();
    listEl.style.gap = '12px';
    listEl.classList.add('multicc-auto-grid');
  } else {
    listEl.style.display = '';
    listEl.style.gridTemplateColumns = '';
    listEl.style.gap = '';
    listEl.classList.remove('multicc-auto-grid');
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
    { sep: true },
    { label: '+ OpenCode Chat', onclick: () => newSessionInDir(dirId, 'opencode', 'chat') },
    { label: '+ OpenCode Terminal', onclick: () => newSessionInDir(dirId, 'opencode', 'terminal') },
    { sep: true },
    { label: '+ ZCode Chat', onclick: () => newSessionInDir(dirId, 'zcode', 'chat') },
    { label: '+ ZCode Terminal', onclick: () => newSessionInDir(dirId, 'zcode', 'terminal') },
    { sep: true },
    { label: '+ Qoder CN Chat', onclick: () => newSessionInDir(dirId, 'qoder', 'chat') },
    { label: '+ Qoder CN Terminal', onclick: () => newSessionInDir(dirId, 'qoder', 'terminal') },
  ]);
}

function showDirMenu(ev, dirId) {
  ev.stopPropagation();
  const dir = (_cachedDirectories || []).find(d => d.id === dirId);
  const ps = dir?.pushState || {};
  const items = [];
  // Dirty main working tree — surface a quick way to inspect/commit uncommitted
  // files before they tangle a session worktree merge.
  if (typeof ps.dirty === 'number' && ps.dirty > 0) {
    items.push({ label: `⚠ ${ps.dirty} 个未提交文件`, onclick: () => showUncommittedFiles(dirId) });
    items.push({ sep: true });
  }
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
    items.push({ label: tt('changeModel', { model: modelDisplayName(s?.model || '', s?.provider) }), onclick: () => changeSessionModel(sessionId) });
  }
  items.push({ label: s?.rolePrompt ? tt('rolePromptSet') : tt('rolePrompt'), onclick: () => changeSessionRole(sessionId) });
  items.push({ sep: true });
  items.push({ label: mergeLabel, ready: mergeReady, onclick: () => mergeSession(sessionId) });
  // Commander can only be removed by deleting its whole fleet (backend enforces
  // this too); hide the single-session delete entry for it.
  if (s?.type !== 'commander') {
    items.push({ sep: true });
    items.push({ label: tt('deleteSession'), danger: true, onclick: () => deleteSession(sessionId) });
  }
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
  // Same registry, same fold as the session card — this list used to have its own
  // precedence and its own emoji table, which is how a card and its popup row
  // could disagree about the same session.
  const cls = sessionCardStatusFor(s.id, s.active);
  const spec = window.MultiCCStatusPresentation.presentation('session', cls);
  const text = tt(spec.labelKey);
  const emoji = spec.icon;
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

// Session list grouped by kind only (chat / terminal). CLI is no longer a
// grouping axis — each card carries its own CLI chip (see renderSessionRow),
// so mixed-CLI fleets stay readable inside two flat groups. Reused by the
// focus-mode inline list and the directory-detail modal.
function renderDirSessionGroups(dirSessions) {
  const groups = { chat: [], terminal: [] };
  for (const s of dirSessions) {
    const kind = (s.kind || 'terminal') === 'chat' ? 'chat' : 'terminal';
    groups[kind].push(s);
  }
  const renderGroup = (kind, label) => {
    const ss = groups[kind];
    if (!ss || !ss.length) return '';
    // Commander stays pinned to the top of its group (D1 keeps it ≤1 per fleet).
    ss.sort((a, b) => (b.type === 'commander' ? 1 : 0) - (a.type === 'commander' ? 1 : 0));
    const rows = ss.map(s => renderSessionRow(s)).join('');
    return `
      <div class="sess-group ${kind}">
        <div class="sess-group-label">${label} (${ss.length})</div>
        <div class="sess-card-grid">${rows}</div>
      </div>`;
  };
  return [
    renderGroup('chat', 'Chats'),
    renderGroup('terminal', 'Terminals'),
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
  const sessionModel = sessionInfo && (sessionInfo.effectiveModel || sessionInfo.model) ? modelDisplayName(sessionInfo.effectiveModel || sessionInfo.model, sessionInfo.provider) : '';

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
          <div style="font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(sessionLabel)}${sessionInfo.type === 'commander' ? ' <span class="cmdr-badge" title="指挥官">🎖 指挥</span>' : ''}</div>
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
    // The old 3-colour dot could not express error at all — a failed worker looked
    // exactly like an idle one. Both the indicator and the chip now come from the
    // registry, so error shows ❌ + danger tone here too.
    const info = wbStatusInfo(task.status);
    const activityText = task.currentFile
      ? `📝 ${task.currentFile.split('/').pop()}`
      : (task.summary || defaultActivityText(task.status));

    return `
      <div class="task-progress-card" data-session-id="${escapeHtml(task.sessionId)}"
           style="height:56px;display:flex;align-items:center;gap:12px;padding:0 16px;cursor:pointer;"
           onclick="event.stopPropagation(); openSessionInline('${escapeHtml(task.sessionId)}')">
        <!-- 状态指示灯（图标 + 无障碍名称，不再只靠颜色） -->
        ${window.MultiCCStatusPresentation.statusBadgeHtml('session', info.status, {
          translate: tt, showLabel: false,
        })}
        <!-- 会话标签（+所属Fleet） -->
        <span style="font-size:13px;color:var(--text);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;flex-shrink:0;">${escapeHtml(task.label)}${task.dirName ? `<span style="color:var(--faint);font-weight:400;"> · ${escapeHtml(task.dirName)}</span>` : ''}</span>
        <!-- 状态标签 -->
        <span class="mc-status-pill st-tone-${escapeHtml(info.tone)}">${escapeHtml(info.text)}</span>
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
    case 'thinking': return `🤔 ${tt('activityThinking')}`;
    case 'editing': return `✏️ ${tt('activityEditing')}`;
    case 'running': return `⚙️ ${tt('activityRunning')}`;
    case 'waiting': return `⏳ ${tt('activityWaiting')}`;
    case 'completed': return `✅ ${tt('activityCompleted')}`;
    case 'error': return `❌ ${tt('activityError')}`;
    case 'idle': return `💤 ${tt('activityIdle')}`;
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
  // Dirty main working tree — warns the user that merging session branches into
  // a dirty main will tangle unrelated local edits into the merge. Clicking the
  // badge opens a file list + quick-commit affordance.
  const dirtyCount = (typeof ps.dirty === 'number' && ps.dirty > 0) ? ps.dirty : 0;
  const dirtyBadge = dirtyCount > 0
    ? `<span class="dir-dirty-badge" title="主分支有 ${dirtyCount} 个未提交文件，合并前请先提交" onclick="event.stopPropagation(); showUncommittedFiles('${escapeHtml(id)}')">⚠ ${dirtyCount}未提交</span>`
    : '';
  const headerActions = `
        <button class="btn add-new btn-sm" title="${escapeHtml(tt('createSession'))}" onclick="event.stopPropagation(); showNewSessionMenu(event, '${escapeHtml(id)}')">${escapeHtml(tt('createSession'))}</button>
        <button class="btn-icon" title="项目备忘 (multicc.memo.md)" onclick="event.stopPropagation(); openMemo('${escapeHtml(id)}')">📝</button>
        <button class="btn-icon${pushPending ? ' has-pending' : ''}" title="更多操作${pushPending ? `（有 ${ps.ahead} 个提交待 push）` : ''}${dirtyCount > 0 ? `（${dirtyCount} 个未提交文件）` : ''}" onclick="event.stopPropagation(); showDirMenu(event, '${escapeHtml(id)}')">⋯</button>`;

  const headerMain = `
        <div class="dir-main">
          <span class="dir-name">${escapeHtml(dir.name)}</span>
          <span class="dir-path" title="${escapeHtml(dir.path)}">${escapeHtml(shortenPath(dir.path, maxPath))}</span>
          ${dirtyBadge}
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
  window._currentDetailDir = dirId;
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
  // Show git tree button
  const gitBtn = document.getElementById('dir-detail-git');
  if (gitBtn) gitBtn.style.display = '';
  if (typeof refreshTaskBoard === 'function') refreshTaskBoard(true);
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
// Detail modal content tab: classic sessions view vs task board. Remembered
// across re-renders/openings so WS-driven redraws don't yank the user back.
let _dirDetailTab = 'sessions';   // 'sessions' | 'taskboard'
function switchDirDetailTab(tab) {
  _dirDetailTab = tab === 'taskboard' ? 'taskboard' : 'sessions';
  if (_detailDirId) renderDirectoryDetailBody(_detailDirId);
}
function renderDirectoryDetailBody(dirId) {
  const body = document.getElementById('dir-detail-body');
  if (!body) return;
  const hasBoard = typeof renderTaskBoardSection === 'function';
  let tabs = '';
  if (hasBoard) {
    const taskCount = typeof _tbTasksForDir === 'function' ? _tbTasksForDir(dirId).length : 0;
    tabs = `
      <div class="dd-tabs">
        <button class="dd-tab${_dirDetailTab === 'sessions' ? ' on' : ''}" onclick="switchDirDetailTab('sessions')">🖥 会话</button>
        <button class="dd-tab${_dirDetailTab === 'taskboard' ? ' on' : ''}" onclick="switchDirDetailTab('taskboard')">📋 任务板${taskCount ? ` (${taskCount})` : ''}</button>
      </div>`;
  }
  const boardTabActive = hasBoard && _dirDetailTab === 'taskboard';
  const content = boardTabActive
    ? renderTaskBoardSection(dirId, { tabbed: true })
    : renderEventTimeline(dirId) + renderDirSessionGroups(dirSessionsOf(dirId));
  body.innerHTML = tabs + content;
  // The board composer sits outside this re-rendered body (static container in
  // the modal) so typed text/recording survive WS-driven redraws.
  if (typeof syncTaskBoardDirComposer === 'function') syncTaskBoardDirComposer(dirId, boardTabActive);
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
    showToast('该Fleet未设置 Git remote', true);
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
    const res = await fetch(`/api/directories/${id}/push`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast(data.pushed ? `已推送 ${data.before.ahead} 个提交` : '没有待 push 的提交');
    await loadDashboard();
  } catch (error) {
    showToast(`Push 失败：${error.message}`, true);
  }
}

// ── Uncommitted-files warning (dirty main working tree) ──
// A dirty main tangles session worktree merges with unrelated local edits, so
// the directory card surfaces a ⚠ badge; this opens a file list + quick-commit.
const UNCOMMITTED_MODAL_HTML = `
<div class="modal-overlay" id="uncommitted-modal" onclick="if(event.target===this) closeUncommittedFiles()">
  <div class="modal" style="max-width:680px">
    <div class="modal-header">
      <h3>⚠ 未提交文件</h3>
      <button class="btn-icon" onclick="closeUncommittedFiles()">✕</button>
    </div>
    <div class="modal-body" style="max-height:60vh;overflow:auto">
      <div id="uncommitted-list">加载中…</div>
    </div>
    <div class="modal-footer" style="display:flex;gap:8px;align-items:center;justify-content:space-between">
      <span id="uncommitted-summary" style="color:var(--muted);font-size:13px"></span>
      <div style="display:flex;gap:8px">
        <button class="btn" onclick="closeUncommittedFiles()">关闭</button>
        <button class="btn add-new" id="uncommitted-commit-btn" onclick="commitAllUncommitted()">全部提交</button>
      </div>
    </div>
  </div>
</div>`;
let _uncommittedDirId = null;
function showUncommittedFiles(dirId) {
  _uncommittedDirId = dirId;
  const dir = (_cachedDirectories || []).find(d => d.id === dirId);
  const overlay = document.createElement('div');
  overlay.innerHTML = UNCOMMITTED_MODAL_HTML;
  document.body.appendChild(overlay.firstElementChild);
  const listEl = document.getElementById('uncommitted-list');
  const summaryEl = document.getElementById('uncommitted-summary');
  const commitBtn = document.getElementById('uncommitted-commit-btn');
  const header = document.querySelector('#uncommitted-modal .modal-header h3');
  if (dir && header) header.textContent = `⚠ ${dir.name} · 未提交文件`;
  if (dir && summaryEl) summaryEl.textContent = dir.path;
  if (commitBtn) commitBtn.style.display = 'none';
  fetch(`/api/directories/${dirId}/uncommitted`)
    .then(r => r.json())
    .then(data => {
      if (!data.files || data.files.length === 0) {
        listEl.innerHTML = `<div style="color:var(--muted);padding:24px;text-align:center">没有未提交文件 ✓</div>`;
        return;
      }
      commitBtn.style.display = '';
      const badge = m => `<span class="git-status-tag" style="display:inline-block;width:28px;text-align:center;font-family:var(--mono);font-size:12px;color:var(--muted)">${m}</span>`;
      listEl.innerHTML = `<div style="font-family:var(--mono);font-size:13px;display:flex;flex-direction:column;gap:2px">${
        data.files.map(f => `<div style="display:flex;gap:8px;align-items:center;padding:4px 6px;border-radius:4px" onmouseover="this.style.background='var(--panel-2)'" onmouseout="this.style.background=''">${badge(escapeHtml(f.status.trim() || '??'))}<span style="word-break:break-all">${escapeHtml(f.path)}</span></div>`).join('')
      }</div>`;
      if (summaryEl) summaryEl.textContent = `${data.files.length} 个未提交文件`;
    })
    .catch(err => { listEl.innerHTML = `<div style="color:var(--danger)">加载失败：${escapeHtml(err.message)}</div>`; });
}
function closeUncommittedFiles() {
  _uncommittedDirId = null;
  const m = document.getElementById('uncommitted-modal');
  if (m) m.remove();
}
async function commitAllUncommitted() {
  const dirId = _uncommittedDirId;
  if (!dirId) return;
  const msg = await showPrompt('提交信息（留空使用自动信息）', '', { okText: '提交' });
  if (msg === null) return; // cancelled
  const btn = document.getElementById('uncommitted-commit-btn');
  if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
  try {
    const res = await fetch(`/api/directories/${dirId}/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg || undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast(data.committed ? `已提交 ${data.pushState?.dirty === 0 ? '所有' : ''}未提交改动` : '没有需要提交的改动');
    closeUncommittedFiles();
    await loadDashboard();
  } catch (error) {
    showToast(`提交失败：${error.message}`, true);
    if (btn) { btn.disabled = false; btn.textContent = '全部提交'; }
  }
}

function fifoQueueHint(sessionId, queue) {
  const depth = Math.max(0, Math.floor(Number(queue?.depth) || 0));
  const classifyState = _workspaceClassify.get(sessionId)?.classifyState
    || queue?.classifyState || null;
  if (classifyState === 'W') {
    return `${depth} 条任务已派发；目标会话正在等待用户回复，之后按 FIFO 执行`;
  }
  if (classifyState === 'E' || queue?.state === 'frozen') {
    return `${depth} 条任务已派发并在 FIFO 中等待；目标会话当前暂停，需先恢复`;
  }
  if (classifyState === 'P' || ['starting', 'running', 'assessing'].includes(queue?.state)) {
    return `${depth} 条任务已派发；将在目标会话当前任务完成后按 FIFO 执行`;
  }
  return `${depth} 条任务已派发，正在目标会话的 FIFO 中等待执行`;
}

function updateSessionQueueDom(sessionId) {
  const queue = _workspaceQueues.get(sessionId);
  const badge = document.getElementById(`sess-queue-${sessionId}`);
  if (!badge) return;
  const depth = Math.max(0, Math.floor(Number(queue?.depth) || 0));
  badge.textContent = depth > 0 ? `📥 FIFO ${depth}` : '';
  badge.title = depth > 0 ? fifoQueueHint(sessionId, queue) : '';
  badge.style.display = depth > 0 ? '' : 'none';
}

function applyWorkspaceQueueStatus(input) {
  const sessionId = String(input?.sessionId || '');
  if (!sessionId) return;
  const previous = _workspaceQueues.get(sessionId);
  const updatedAt = Math.max(0, Math.floor(Number(input.updatedAt) || 0));
  if (previous && previous.updatedAt > updatedAt) return;
  _workspaceQueues.set(sessionId, {
    depth: Math.max(0, Math.floor(Number(input.depth) || 0)),
    state: String(input.state || 'idle'),
    classifyState: input.classifyState || null,
    updatedAt,
  });
  updateSessionQueueDom(sessionId);
}

function applyWorkspaceQueueSnapshot(items) {
  for (const item of Array.isArray(items) ? items : []) applyWorkspaceQueueStatus(item);
}

function renderSessionRow(s) {
  const focusedClass = s.id === _focusedSessionId ? ' focused' : '';
  // CLI marker: groups are now kind-only (chat/terminal), so each card shows its
  // own CLI chip. Unknown CLIs fall back to a neutral 'other' style.
  const cli = (s.cli || 'claude').toLowerCase();
  const cliClass = ['claude', 'codex', 'opencode', 'zcode', 'qoder'].includes(cli) ? cli : 'other';
  // Live workspace status (from /ws/workspace) takes precedence when available.
  const wb = _workspaceStatus.get(s.id);
  // One canonical verdict for the card, folded by the shared registry. It also
  // guarantees an `error` signal cannot be overwritten by a parallel optimistic
  // one, and that `s.active` (process liveness) only decides idle vs offline.
  const cardStatus = sessionCardStatusFor(s.id, s.active);
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
  const model = s.effectiveModel ? modelDisplayName(s.effectiveModel, s.provider) : '';
  // Resolve provider display name from cached provider list (may be async-loaded;
  // falls back to the raw id or nothing).
  const provInfo = s.provider ? (_providerData.providers || []).find(p => p.id === s.provider) : null;
  const provName = provInfo ? provInfo.name : (s.provider ? s.provider.slice(0, 8) : '');
  const wbFile = (wb && wb.currentFile) ? wb.currentFile.split('/').pop() : '';
  const sm = _workspaceSummaries.get(s.id);
  const summary = sm && sm.summary ? sm.summary : '';
  // Status icon for the summary line: makes "状态 + 任务简介" visible at a glance.
  // Same registry as the dot, so the two can never disagree — this line used to
  // have its own ternary that had no error glyph at all.
  const summaryIco = window.MultiCCStatusPresentation.presentation('session', cardStatus).icon;
  const runtimeText = sessionRunTimeText(s.id);
  const queue = _workspaceQueues.get(s.id);
  const queueDepth = Math.max(0, Math.floor(Number(queue?.depth) || 0));
  const queueTitle = queueDepth > 0 ? fifoQueueHint(s.id, queue) : '';

  const openBtn = s.kind === 'chat'
    ? `<button class="btn-icon" onclick="event.stopPropagation(); openSessionChat('${escapeHtml(s.id)}')" title="${escapeHtml(tt('openInNewTab'))}">🔗</button>`
    : `<button class="btn-icon" onclick="event.stopPropagation(); openSessionNewTab('${escapeHtml(s.id)}')" title="${escapeHtml(tt('openInNewTab'))}">🔗</button>`;

  // Lean 2-line card: status is a colour dot (hover for text), the alias is the
  // headline, and cli/time/model sit in one muted line. The CLI chip identifies
  // the backing CLI now that groups are kind-only; #id, delete and the rest
  // live in the ⋯ menu / title attribute.
  return `
    <div class="lean${isSessionRunning(s.id) ? ' card-border-rainbow' : ''}${focusedClass}" data-id="${escapeHtml(s.id)}" onclick="openSessionInline('${escapeHtml(s.id)}','${escapeHtml(s.kind || 'terminal')}')">
      ${window.MultiCCStatusPresentation.statusBadgeHtml('session', cardStatus, {
        translate: tt, showLabel: false, className: 'dot', id: `sess-status-${s.id}`,
      })}
      <span class="classify-badge" id="sess-classify-${escapeHtml(s.id)}" style="display:none"></span>
      <div class="lean-main">
        <div class="lean-name" title="#${escapeHtml(s.id)}">${escapeHtml(displayName)}${s.type === 'commander' ? '<span class="cmdr-badge" title="指挥官：只分发任务、不亲自执行；不可单独删除">🎖 指挥</span>' : ''}<span class="sess-notes" id="sess-notes-${escapeHtml(s.id)}"${pendingNotes > 0 ? '' : ' style="display:none"'}>${pendingNotes > 0 ? '📨 ' + pendingNotes : ''}</span><span class="sess-queue" id="sess-queue-${escapeHtml(s.id)}" title="${escapeHtml(queueTitle)}"${queueDepth > 0 ? '' : ' style="display:none"'}>${queueDepth > 0 ? `📥 FIFO ${queueDepth}` : ''}</span></div>
        <div class="lean-meta">
          <span class="cli-chip ${cliClass}" title="CLI: ${escapeHtml(cli)}">${escapeHtml(cli)}</span>
          <span class="sep">·</span><span>${escapeHtml(formatRelative(sessionLastInteractionMs(s) || s.createdAt))}</span>
          ${provName ? `<span class="sep">·</span><span class="provider-chip" title="Provider：${escapeHtml(s.provider || '')}">${escapeHtml(provName)}</span>` : ''}
          ${model ? `<span class="sep">·</span><span class="model" title="模型：${escapeHtml(s.effectiveModel || '')}">${escapeHtml(model)}</span>` : ''}
        </div>
        <div class="sess-file" id="sess-file-${escapeHtml(s.id)}"${wbFile ? '' : ' style="display:none"'}>${wbFile ? '✎ ' + escapeHtml(wbFile) : ''}</div>
        <div class="sess-summary" id="sess-summary-${escapeHtml(s.id)}" title="${summary ? '最近任务：' + escapeHtml(summary) : ''}"${summary ? '' : ' style="display:none"'}>${summary ? summaryIco + ' ' + escapeHtml(summary) : ''}</div>
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
    const res = await fetch('/api/fs/list?path=' + encodeURIComponent(val));
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
    const res = await fetch('/api/directories', {
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
