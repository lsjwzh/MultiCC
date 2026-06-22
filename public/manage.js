'use strict';

let autoRefreshTimer = null;
let _cachedSessions = [];
let _focusedSessionId = null;
const _urlToken = new URLSearchParams(location.search).get('token');
function tokenQS(prefix) { return _urlToken ? `${prefix}token=${_urlToken}` : ''; }

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
        const waiting = msg.state === 'waiting';
        alertSession(
          sessionId,
          waiting ? 'waiting' : 'completed',
          msg.message || (waiting ? '等待操作' : '任务已完成'),
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

/* ── Alerts (one-shot voice, silenced once user views the session) ── */
const _alertedSessions = new Set(); // sessions whose current alert has been read

function alertSession(sessionId, type, message) {
  // Always update the persistent status badge
  setSessionStatus(sessionId, type);
  // Voice: only if this alert hasn't been read yet
  if (_alertedSessions.has(sessionId)) return;
  if (window.speechSynthesis) {
    const text = `Session ${sessionId}: ${message}`;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1.1;
    utterance.volume = 0.8;
    window.speechSynthesis.speak(utterance);
  }
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
    syncMonitors(sessions);
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
        <span class="client-count" style="color:#d2a8ff;">auxqueue</span>
        <button class="btn btn-sm" onclick="event.stopPropagation(); focusAux()">History</button>
      </div>
    </div>`;
}

function renderSessions(sessions) {
  // Back-compat: rerender using the cached directory list (status updates etc.)
  renderDashboard(_cachedDirectories, sessions);
}

function renderDashboard(directories, sessions) {
  const auxSessions = sessions.filter(s => s.type === 'aux');
  const regularSessions = sessions.filter(s => s.type !== 'aux');
  const isFocused = !!_focusedSessionId;

  // Aux section (always first)
  const auxEl = document.getElementById('aux-section');
  if (auxEl) {
    auxEl.innerHTML = auxSessions.length
      ? `<div class="session-grid" style="margin-bottom:16px;">${auxSessions.map(s => renderAuxCard(s, isFocused)).join('')}</div>`
      : '';
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

  const dirHtml = directories.map(d => renderDirectoryBlock(d, byDir.get(d.id) || [])).join('');
  const orphanHtml = orphans.length ? renderOrphans(orphans) : '';
  listEl.innerHTML = dirHtml + orphanHtml;

  // Keep a live workspace socket open for every expanded directory.
  for (const d of directories) {
    if (_expandedDirs.has(d.id)) connectWorkspace(d.id);
  }
}

// ── Popover menu (kebab ⋯ buttons) ──
let _openPopover = null;
function _closePopover() {
  if (_openPopover) { _openPopover.remove(); _openPopover = null; }
  document.removeEventListener('mousedown', _closePopover, true);
  document.removeEventListener('keydown', _popoverKeydown, true);
  window.removeEventListener('resize', _closePopover);
  window.removeEventListener('scroll', _closePopover, true);
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
  setTimeout(() => {
    document.addEventListener('mousedown', _closePopover, true);
    document.addEventListener('keydown', _popoverKeydown, true);
    window.addEventListener('resize', _closePopover);
    window.addEventListener('scroll', _closePopover, true);
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
  items.push({ label: '改名', onclick: () => renameDirectory(dirId) });
  items.push({ label: `默认角色提示词${dir?.rolePrompt ? '（已设）' : ''}`, onclick: () => changeDirectoryRole(dirId) });
  items.push({ sep: true });
  items.push({ label: '删除目录', danger: true, onclick: () => deleteDirectory(dirId) });
  showPopoverMenu(ev.currentTarget, items);
}

function showSessionMenu(ev, sessionId) {
  ev.stopPropagation();
  const st = _workspaceStatus.get(sessionId);
  const s = _cachedSessions.find(x => x.id === sessionId);
  const ms = st?.mergeState || s?.mergeState || {};
  const mergeReady = !!ms.mergeReady;
  const mergeLabel = mergeReady
    ? `✓ 合并到 ${ms.baseBranch || 'main'}${ms.ahead ? `（${ms.ahead} 个提交）` : ''}`
    : `合并到 ${ms.baseBranch || 'main'}`;
  const items = [
    { label: '改名', onclick: () => renameSession(sessionId) },
    { label: '留言', onclick: () => openNoteModal(sessionId) },
    { label: 'Diff', onclick: () => showDiff(sessionId) },
  ];
  if ((s?.cli || 'claude') === 'claude') {
    items.push({ label: `切换模型（${modelShortName(s?.model || '')}）`, onclick: () => changeSessionModel(sessionId) });
  }
  items.push({ label: `角色提示词${s?.rolePrompt ? '（已设）' : ''}`, onclick: () => changeSessionRole(sessionId) });
  items.push({ sep: true });
  items.push({ label: mergeLabel, ready: mergeReady, onclick: () => mergeSession(sessionId) });
  items.push({ sep: true });
  items.push({ label: '删除会话', danger: true, onclick: () => deleteSession(sessionId) });
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
  if ((s.kind || 'terminal') === 'chat') openSessionChat(s.id);
  else openSessionNewTab(s.id);
}

// Render a popover from a KPI tile: each session shown as "dir / alias", click
// jumps straight to it. Shared by the 等待输入 and 活跃会话 tiles.
function showSessionListPopup(ev, sessions, prefix, emptyText) {
  ev.stopPropagation();
  const items = sessions.map(s => {
    const alias = s.label || s.id;
    const dir = _dirNameById(s.dirId);
    return { label: `${prefix} ${dir ? `${dir} / ${alias}` : alias}`, onclick: () => jumpToSession(s) };
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

// Popup from the "活跃会话" KPI tile.
function showActiveSessions(ev) {
  const list = (_cachedSessions || []).filter(s => s.active && s.type !== 'aux');
  showSessionListPopup(ev, list, '🟢', '没有活跃的会话');
}

function renderDirectoryBlock(dir, dirSessions) {
  const openClass = _expandedDirs.has(dir.id) ? ' open' : '';
  const id = dir.id;
  const maxPath = _focusedSessionId ? 30 : 60;

  // Split sessions by (cli, kind)
  const groups = {
    claude_terminal: [], claude_chat: [],
    codex_terminal: [], codex_chat: [],
  };
  for (const s of dirSessions) {
    const key = `${s.cli || 'claude'}_${s.kind || 'terminal'}`;
    if (groups[key]) groups[key].push(s);
  }

  const total = dirSessions.length;
  const active = dirSessions.filter(s => s.active).length;
  // Git push state (ahead) surfaces as a tiny dot on the ⋯ menu; the full
  // action lives inside showDirMenu now (P2: declutter the header).
  const ps = dir.pushState || {};
  const pushPending = ps.available !== false && ps.hasRemote && ps.ahead > 0;

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

  const bodyHtml = [
    renderGroup('claude', 'terminal', 'Claude Terminals'),
    renderGroup('claude', 'chat', 'Claude Chats'),
    renderGroup('codex',  'terminal', 'Codex Terminals'),
    renderGroup('codex',  'chat', 'Codex Chats'),
  ].filter(Boolean).join('') || '<div class="dir-empty">No sessions yet</div>';

  return `
    <div class="dir-block${openClass}" data-dir-id="${escapeHtml(id)}">
      <div class="dir-header">
        <button class="dir-toggle" title="Expand project" onclick="toggleDirectory('${escapeHtml(id)}')"></button>
        <div class="dir-main">
          <span class="dir-name" onclick="toggleDirectory('${escapeHtml(id)}')">${escapeHtml(dir.name)}</span>
          <span class="dir-path" title="${escapeHtml(dir.path)}">${escapeHtml(shortenPath(dir.path, maxPath))}</span>
          <div class="dir-meta">
            <span><strong>${total}</strong> sessions</span>
            ${active > 0 ? `<span class="sep">·</span><span class="active-count"><strong>${active}</strong> active</span>` : ''}
          </div>
        </div>
        <button class="btn add-new btn-sm" title="新建会话" onclick="event.stopPropagation(); showNewSessionMenu(event, '${escapeHtml(id)}')">+ 新建 ▾</button>
        <button class="btn-icon" title="项目备忘 (multicc.memo.md)" onclick="event.stopPropagation(); openMemo('${escapeHtml(id)}')">📝</button>
        <button class="btn-icon${pushPending ? ' has-pending' : ''}" title="更多操作${pushPending ? `（有 ${ps.ahead} 个提交待 push）` : ''}" onclick="event.stopPropagation(); showDirMenu(event, '${escapeHtml(id)}')">⋯</button>
      </div>
      <div class="dir-body">
        ${renderEventTimeline(id)}
        ${bodyHtml}
      </div>
    </div>`;
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
  let statusText = 'idle', statusCls = '';
  if (s.active) { statusCls = 'active'; statusText = 'active'; }
  if (monStatus === 'waiting') { statusCls = 'waiting'; statusText = '等待'; }
  else if (monStatus === 'completed') { statusCls = 'completed'; statusText = '完成'; }
  else if (mon && mon.state === 'active') { statusCls = 'active'; statusText = '运行中'; }
  // Live workspace status (from /ws/workspace) takes precedence when available.
  const wb = _workspaceStatus.get(s.id);
  if (wb) { const info = wbStatusInfo(wb.status); statusText = info.text; statusCls = info.cls; }
  const pendingNotes = _workspaceNotes.get(s.id) || 0;
  const mergeState = wb?.mergeState || s.mergeState || {};
  const mergeReady = !!mergeState.mergeReady;
  const mergeTitle = mergeReady
    ? `可合并：${mergeState.dirty ? '有未提交改动' : ''}${mergeState.dirty && mergeState.ahead > 0 ? '，' : ''}${mergeState.ahead > 0 ? `${mergeState.ahead} 个提交领先` : ''}`
    : '把 worktree 合并回基分支';
  const displayName = s.label || s.id;
  const model = s.model ? modelShortName(s.model) : '';
  const wbFile = (wb && wb.currentFile) ? wb.currentFile.split('/').pop() : '';
  const sm = _workspaceSummaries.get(s.id);
  const summary = sm && sm.summary ? sm.summary : '';

  const openBtn = s.kind === 'chat'
    ? `<button class="btn btn-sm" onclick="event.stopPropagation(); openSessionChat('${escapeHtml(s.id)}')">Open</button>`
    : `<button class="btn btn-sm" onclick="event.stopPropagation(); openSessionNewTab('${escapeHtml(s.id)}')">Open</button>`;

  // Lean 2-line card: status is a colour dot (hover for text), the alias is the
  // headline, and time/model sit in one muted line. cli/kind chips are dropped
  // (the group header already says "Claude Chats"); #id, delete and the rest
  // live in the ⋯ menu / title attribute.
  return `
    <div class="lean${focusedClass}" data-id="${escapeHtml(s.id)}" onclick="openSessionInline('${escapeHtml(s.id)}','${escapeHtml(s.kind || 'terminal')}')">
      <span class="dot ${statusCls}" id="sess-status-${escapeHtml(s.id)}" title="${escapeHtml(statusText)}"></span>
      <div class="lean-main">
        <div class="lean-name" title="#${escapeHtml(s.id)}">${escapeHtml(displayName)}<span class="sess-notes" id="sess-notes-${escapeHtml(s.id)}"${pendingNotes > 0 ? '' : ' style="display:none"'}>${pendingNotes > 0 ? '📨 ' + pendingNotes : ''}</span></div>
        <div class="lean-meta">
          <span>${escapeHtml(formatRelative(s.lastActivity || s.createdAt))}</span>
          ${model ? `<span class="sep">·</span><span class="model" title="模型：${escapeHtml(s.model)}">${escapeHtml(model)}</span>` : ''}
        </div>
        <div class="sess-file" id="sess-file-${escapeHtml(s.id)}"${wbFile ? '' : ' style="display:none"'}>${wbFile ? '✎ ' + escapeHtml(wbFile) : ''}</div>
        <div class="sess-summary" id="sess-summary-${escapeHtml(s.id)}" title="${summary ? '最近任务：' + escapeHtml(summary) : ''}"${summary ? '' : ' style="display:none"'}>${summary ? '🗒 ' + escapeHtml(summary) : ''}</div>
      </div>
      <span class="lean-actions">
        ${openBtn}
        <button class="btn-icon${mergeReady ? ' merge-ready' : ''}" id="sess-menu-${escapeHtml(s.id)}" title="${escapeHtml(mergeReady ? mergeTitle + '（点击展开更多）' : '更多操作（改名/留言/Diff/合并/删除）')}" onclick="event.stopPropagation(); showSessionMenu(event, '${escapeHtml(s.id)}')">⋯</button>
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

function toggleDirectory(id) {
  if (_expandedDirs.has(id)) { _expandedDirs.delete(id); disconnectWorkspace(id); }
  else { _expandedDirs.add(id); connectWorkspace(id); }
  renderDashboard(_cachedDirectories, _cachedSessions);
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
  { value: '', label: '默认（跟随 Claude 设置）' },
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'claude-fable-5[1m]', label: 'Fable 5 (1M context)' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: '__custom__', label: '自定义…' },
];

function modelShortName(model) {
  const opt = CLAUDE_MODEL_OPTIONS.find(o => o.value === model);
  return opt ? opt.label : model;
}

// WebView-safe model picker (same pattern as _dialog). Resolves to '' (default),
// a model string, or null (cancelled).
function showModelPicker({ title = '选择该会话使用的模型', okText = '创建', current = '' } = {}) {
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
      opt.value = o.value; opt.textContent = o.label;
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
    cancel.className = 'btn'; cancel.textContent = '取消';
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
  let model = null;
  if (cli === 'claude') {
    const picked = await showModelPicker();
    if (picked === null) return; // cancelled
    model = picked || null;
  }
  try {
    const res = await fetch(`/api/directories/${dirId}/sessions${tokenQS('?')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cli, kind, model }),
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

async function changeSessionModel(id) {
  const sess = _cachedSessions.find(s => s.id === id);
  if (!sess) return;
  const picked = await showModelPicker({
    title: '切换该会话使用的模型',
    okText: '保存',
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

// Route an inline-open request by session kind (terminal → iframe, chat → chat page)
function openSessionInline(id, kind) {
  if (kind === 'chat') {
    // Chat doesn't have an inline iframe panel yet — open in a new tab
    openSessionChat(id);
    return;
  }
  focusSession(id);
}

/* ── Focus panel: embed terminal iframe ── */
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
  const iframe = document.createElement('iframe');
  iframe.className = focusIframe.className;
  iframe.id = '';
  iframe.sandbox = focusIframe.sandbox.toString();
  iframe.style.cssText = 'flex:1;border:none;width:100%;height:100%;background:#0d1117;display:none;';
  iframe.src = `/?id=${id}${tokenParam}`;
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
    // Clean up cached iframe
    const cachedFrame = _iframeCache.get(id);
    if (cachedFrame) { cachedFrame.remove(); _iframeCache.delete(id); }
    if (_focusedSessionId === id) closeFocusPanel();
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

/* ── Workspace status board (live agent statuses per directory) ── */
const _workspaceWs = new Map();        // dirId → WebSocket
const _workspaceStatus = new Map();    // sessionId → { status, currentFile, lastActivity, mergeState }
const _workspaceEvents = new Map();    // dirId → event[]
const _workspaceNotes = new Map();     // sessionId → pending note count
const _workspaceSummaries = new Map(); // sessionId → { summary, ts } — 最近任务 one-liner

function wbStatusInfo(status) {
  switch (status) {
    case 'thinking': return { text: '思考中', cls: 'active' };
    case 'editing':  return { text: '编辑中', cls: 'active' };
    case 'running':  return { text: '运行中', cls: 'active' };
    case 'waiting':  return { text: '等待',   cls: 'waiting' };
    default:         return { text: 'idle',  cls: '' };
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
        _workspaceStatus.set(s.id, { status: s.status, currentFile: s.currentFile, lastActivity: s.lastActivity, mergeState: s.mergeState || null });
        _workspaceNotes.set(s.id, s.pendingNotes || 0);
        if (s.summary) _workspaceSummaries.set(s.id, { summary: s.summary, ts: s.summaryTs || 0 });
        updateSessionStatusDom(s.id);
        updateSessionNotesDom(s.id);
        updateSessionMergeDom(s.id);
        updateSessionSummaryDom(s.id);
      }
      _workspaceEvents.set(dirId, msg.events || []);
      updateEventTimelineDom(dirId);
    } else if (msg.type === 'status') {
      _workspaceStatus.set(msg.sessionId, { status: msg.status, currentFile: msg.currentFile, lastActivity: msg.lastActivity, mergeState: msg.mergeState || _workspaceStatus.get(msg.sessionId)?.mergeState || null });
      updateSessionStatusDom(msg.sessionId);
      updateSessionMergeDom(msg.sessionId);
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
    } else if (msg.type === 'note_pending') {
      _workspaceNotes.set(msg.sessionId, msg.count || 0);
      updateSessionNotesDom(msg.sessionId);
    } else if (msg.type === 'summary') {
      _workspaceSummaries.set(msg.sessionId, { summary: msg.summary, ts: msg.ts || 0 });
      updateSessionSummaryDom(msg.sessionId);
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
  const events = (_workspaceEvents.get(dirId) || []).slice(-12).reverse();
  const n = events.length;
  const open = _expandedEvents.has(dirId);
  const rowsHtml = n
    ? events.map(e => `<div class="wb-event-row"><span class="t">${new Date(e.ts).toLocaleTimeString()}</span> ${escapeHtml(eventLabel(e))}</div>`).join('')
    : '<div class="wb-event-row dim">暂无活动</div>';
  return `<div class="wb-events" id="wb-events-${escapeHtml(dirId)}">
    <button class="events-bar" onclick="event.stopPropagation(); toggleEventsCollapsed('${escapeHtml(dirId)}')">🕔 最近活动${n ? ` (${n})` : ''} <span class="caret">${open ? '▴' : '▾'}</span></button>
    <div class="wb-events-list"${open ? '' : ' style="display:none"'}>${rowsHtml}</div>
  </div>`;
}

function toggleEventsCollapsed(dirId) {
  if (_expandedEvents.has(dirId)) _expandedEvents.delete(dirId);
  else _expandedEvents.add(dirId);
  updateEventTimelineDom(dirId);
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
    cancel.className = 'btn'; cancel.textContent = cancelText || '取消';
    const ok = document.createElement('button');
    ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-green'); ok.textContent = okText || '确定';
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

async function loadCronTasks() {
  const list = document.getElementById('cron-list');
  if (!list) return;
  try {
    const res = await fetch('/api/cron' + tokenQS('?'));
    const tasks = await res.json();
    const cnt = document.getElementById('cron-count');
    if (cnt) cnt.textContent = tasks.length ? `(${tasks.length})` : '';
    if (!tasks.length) {
      list.innerHTML = '<div style="color:#6e7681;font-size:13px;">还没有定时任务。点「+ 新建」，或让 agent 帮你登记。</div>';
      return;
    }
    list.innerHTML = '';
    for (const t of tasks) {
      const row = document.createElement('div');
      row.style.cssText = 'border:1px solid #21262d;border-radius:8px;padding:10px 12px;background:#0d1117;';
      const statusColor = t.lastStatus === 'ok' ? '#3fb950' : (t.lastStatus ? '#f85149' : '#6e7681');
      const statusTxt = t.lastStatus ? `上次 ${_cronTime(t.lastRunAt)} · ${t.lastStatus === 'ok' ? '成功' : (t.lastError || t.lastStatus)}` : '尚未运行';
      row.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-weight:600;color:#f0f6fc;">${escapeHtml(t.name)}</span>
          <span style="font-size:11px;padding:1px 6px;border-radius:4px;background:${t.enabled ? '#23863622' : '#6e768122'};color:${t.enabled ? '#3fb950' : '#8b949e'};">${t.enabled ? '启用' : '停用'}</span>
          <span style="flex:1;"></span>
          <button class="btn btn-sm" title="立即运行" onclick="runCronTask('${t.id}')">▶ 运行</button>
          <button class="btn btn-sm" onclick="toggleCronTask('${t.id}', ${t.enabled ? 'false' : 'true'})">${t.enabled ? '停用' : '启用'}</button>
          <button class="btn btn-sm" onclick="openCronModal('${t.id}')">编辑</button>
          <button class="btn btn-sm btn-danger" onclick="deleteCronTask('${t.id}')">删除</button>
        </div>
        <div style="font-size:12px;color:#8b949e;margin-top:6px;font-family:monospace;">
          <code style="color:#d29922;">${escapeHtml(t.cron)}</code> · 📁 ${escapeHtml(t.dirName)} · ${escapeHtml(t.cli)} · 创建者 ${escapeHtml(t.createdBy)}
        </div>
        <div style="font-size:12px;color:#6e7681;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml((t.prompt || '').slice(0, 80))}${(t.prompt || '').length > 80 ? '…' : ''}</div>
        <div style="font-size:11px;margin-top:4px;color:${statusColor};">${escapeHtml(statusTxt)}${t.enabled && t.nextRunAt ? ` · 下次 ${_cronTime(t.nextRunAt)}` : ''}</div>
      `;
      list.appendChild(row);
    }
  } catch (err) {
    list.innerHTML = `<div style="color:#f85149;font-size:13px;">加载失败：${escapeHtml(err.message)}</div>`;
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

function renderProviderList() {
  const box = document.getElementById('provider-list');
  if (!box) return;
  if (!_providerData.providers.length) {
    box.innerHTML = '<span style="color:var(--faint);font-size:13px">还没有 provider。' +
      (_providerData.available ? '在下方新增。' : 'cc-switch 不可用。') + '</span>';
    return;
  }
  box.innerHTML = _providerData.providers.map(p => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;">
      <span style="font-size:11px;padding:2px 6px;border-radius:4px;background:var(--bg-soft);color:var(--faint)">${escapeHtml(p.appType)}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;color:var(--text);font-weight:600">${escapeHtml(p.name)} <span style="font-weight:400;font-size:11px;color:var(--faint)">${p.source === 'ccswitch' ? '· 来自 cc-switch' : '· 本地'}</span></div>
        <div style="font-size:11px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.isOfficial ? '默认登录 / 订阅' : (p.baseUrl || ''))}${p.model ? ' · ' + escapeHtml(p.model) : ''}${p.tokenMask ? ' · ' + escapeHtml(p.tokenMask) : ''}</div>
      </div>
      <button class="btn" style="padding:4px 10px;font-size:12px" onclick="editProvider('${escapeHtml(p.appType)}','${escapeHtml(p.id)}')">编辑</button>
      <button class="btn" style="padding:4px 10px;font-size:12px" onclick="deleteProvider('${escapeHtml(p.appType)}','${escapeHtml(p.id)}','${escapeHtml(p.name)}')">删除</button>
    </div>`).join('');
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
  overlay.innerHTML = `
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:440px;max-width:92vw;">
      <div style="font-size:14px;color:#c9d1d9;font-weight:600;margin-bottom:14px">编辑 Provider · ${escapeHtml(p.appType)}</div>
      ${field('名称', p.name, '名称')}
      ${field('Base URL', p.baseUrl, 'https://…（留空=官方/订阅）')}
      ${field('Model', p.model, '可选')}
      ${field('API Key', '', p.hasToken ? '留空 = 保留原 key（' + (p.tokenMask || '已设置') + '）' : '未设置', 'password')}
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
        <button class="btn" id="ep-cancel" style="font-size:13px">取消</button>
        <button class="btn btn-green" id="ep-save" style="font-size:13px">保存</button>
      </div>
      <div id="ep-status" class="status-text" style="margin-top:8px"></div>
    </div>`;
  document.body.appendChild(overlay);
  const val = (k) => overlay.querySelector(`input[data-k="${k}"]`).value.trim();
  const close = () => overlay.remove();
  overlay.querySelector('#ep-cancel').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#ep-save').onclick = async () => {
    const body = { name: val('名称'), baseUrl: val('Base URL'), model: val('Model') };
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
auxConnect();
autoRefreshTimer = setInterval(loadDashboard, 5000);
// Refresh push diagnostics periodically and on visibility change
setInterval(loadPushDiagnostics, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadPushDiagnostics();
});
