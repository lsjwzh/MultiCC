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
      if (msg.type !== 'output') return;
      // Skip replay buffer (first 5s after connect)
      if (Date.now() - mon.connectedAt < 5000) return;

      const text = stripAnsi(msg.data);
      const printable = text.replace(/\s+/g, '');

      mon.recentText += text;
      if (mon.recentText.length > 3000) mon.recentText = mon.recentText.slice(-2000);

      if (printable.length > 0) {
        mon.chars += printable.length;
        if (mon.state === 'idle') {
          mon.state = 'active';
          // New activity: clear old status and reset alert so next event can fire
          clearSessionStatus(sessionId);
          _alertedSessions.delete(sessionId);
        }
      }

      // Only judge status AFTER output stops for NOTIFY_IDLE_MS
      if (mon.idleTimer) clearTimeout(mon.idleTimer);
      mon.idleTimer = setTimeout(() => {
        if (mon.state === 'active' && mon.chars >= NOTIFY_MIN_CHARS) {
          const tail = mon.recentText.slice(-2000);
          // Still working (spinner/thinking) — don't judge yet, wait longer
          if (isInProgress(tail)) {
            mon.idleTimer = setTimeout(() => mon.idleTimer && (mon.state = 'idle', mon.chars = 0, mon.recentText = ''), NOTIFY_IDLE_MS);
            return;
          }
          if (matchesWaiting(tail)) {
            alertSession(sessionId, 'waiting', '等待操作');
          } else {
            alertSession(sessionId, 'completed', '任务已完成');
          }
        }
        mon.state = 'idle';
        mon.chars = 0;
        mon.recentText = '';
      }, NOTIFY_IDLE_MS);
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
    // Default: expand all directories on first load
    if (_expandedDirs.size === 0 && directories.length > 0) {
      for (const d of directories) _expandedDirs.add(d.id);
    }
    renderDashboard(directories, sessions);
    syncMonitors(sessions);
    if (typeof wechatPopulateSessionSelect === 'function') wechatPopulateSessionSelect(sessions);
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
  const claudeCount = groups.claude_terminal.length + groups.claude_chat.length;
  const codexCount = groups.codex_terminal.length + groups.codex_chat.length;

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
          <div class="dir-stats">
            <span class="stat-pill"><strong>${total}</strong> sessions</span>
            <span class="stat-pill"><strong>${active}</strong> active</span>
            <span class="stat-pill claude"><strong>${claudeCount}</strong> Claude</span>
            <span class="stat-pill codex"><strong>${codexCount}</strong> Codex</span>
          </div>
        </div>
        <button class="btn btn-danger dir-danger" title="Delete directory" onclick="deleteDirectory('${escapeHtml(id)}')">Del</button>
      </div>
      <div class="dir-actions">
        <button class="btn add-claude" title="New Claude terminal" onclick="newSessionInDir('${escapeHtml(id)}','claude','terminal')">+ Claude Term</button>
        <button class="btn add-claude" title="New Claude chat" onclick="newSessionInDir('${escapeHtml(id)}','claude','chat')">+ Claude Chat</button>
        <button class="btn add-codex" title="New Codex terminal" onclick="newSessionInDir('${escapeHtml(id)}','codex','terminal')">+ Codex Term</button>
        <button class="btn add-codex" title="New Codex chat" onclick="newSessionInDir('${escapeHtml(id)}','codex','chat')">+ Codex Chat</button>
      </div>
      <div class="dir-body">
        ${bodyHtml}
      </div>
    </div>`;
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

  const openBtn = s.kind === 'chat'
    ? `<button class="btn" onclick="event.stopPropagation(); openSessionChat('${escapeHtml(s.id)}')">Open</button>`
    : `<button class="btn" onclick="event.stopPropagation(); openSessionNewTab('${escapeHtml(s.id)}')">Open</button>`;

  return `
    <div class="sess-row${focusedClass}" data-id="${escapeHtml(s.id)}" onclick="openSessionInline('${escapeHtml(s.id)}','${escapeHtml(s.kind || 'terminal')}')">
      <div class="sess-row-top">
        <span class="cli-chip ${s.cli || 'claude'}">${escapeHtml(s.cli || 'claude')}</span>
        <span class="kind-chip">${escapeHtml(s.kind || 'terminal')}</span>
        <span class="sess-status ${statusCls}" id="sess-status-${escapeHtml(s.id)}">${statusText}</span>
      </div>
      <div class="sess-id">#${escapeHtml(s.id)}</div>
      <div class="sess-label">${escapeHtml(s.label || s.cwd || '')}</div>
      <div class="sess-file" id="sess-file-${escapeHtml(s.id)}" style="font-size:11px;color:#d29922;font-family:monospace;${wb && wb.currentFile ? '' : 'display:none'}">${wb && wb.currentFile ? '✎ ' + escapeHtml(wb.currentFile.split('/').pop()) : ''}</div>
      <div class="sess-row-bottom">
        <span class="sess-label">${escapeHtml(formatRelative(s.lastActivity || s.createdAt))}</span>
        <span class="sess-actions">
          ${openBtn}
          <button class="btn" onclick="event.stopPropagation(); mergeSession('${escapeHtml(s.id)}')" title="把 worktree 合并回基分支">合并</button>
          <button class="btn btn-danger" onclick="event.stopPropagation(); deleteSession('${escapeHtml(s.id)}')">Del</button>
        </span>
      </div>
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
  setTimeout(() => document.getElementById('newdir-name').focus(), 50);
}

function closeNewDirectoryModal() {
  const modal = document.getElementById('newdir-modal');
  if (modal) modal.style.display = 'none';
}

async function submitNewDirectory() {
  const name = document.getElementById('newdir-name').value.trim();
  const dirPath = document.getElementById('newdir-path').value.trim();
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
      body: JSON.stringify({ name, path: dirPath }),
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

async function deleteDirectory(id) {
  const dir = _cachedDirectories.find(d => d.id === id);
  if (!dir) return;
  const hasSessions = _cachedSessions.some(s => s.dirId === id);
  const msg = hasSessions
    ? `Delete "${dir.name}" and ALL its sessions? This cannot be undone.`
    : `Delete empty directory "${dir.name}"?`;
  if (!confirm(msg)) return;
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

async function newSessionInDir(dirId, cli, kind) {
  try {
    const res = await fetch(`/api/directories/${dirId}/sessions${tokenQS('?')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cli, kind }),
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
  if (!confirm(`Delete session ${id}?\nThe PTY process will be terminated.`)) return;
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

async function mergeSession(id) {
  if (!confirm(`把会话 ${id} 的 worktree 合并回基分支？\n未提交的改动会先自动提交。`)) return;
  try {
    const res = await fetch(`/api/sessions/${id}/merge` + tokenQS('?'), { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.merged ? `已合并 ${data.commits} 个提交回基分支` : (data.message || '没有新提交需要合并'));
    } else if (res.status === 409) {
      showToast(`合并冲突，已 abort：${(data.conflicts || []).join(', ')}`, true);
    } else {
      showToast(`合并失败：${data.error || res.status}`, true);
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  }
}

/* ── Workspace status board (live agent statuses per directory) ── */
const _workspaceWs = new Map();      // dirId → WebSocket
const _workspaceStatus = new Map();  // sessionId → { status, currentFile, lastActivity }

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
        _workspaceStatus.set(s.id, { status: s.status, currentFile: s.currentFile, lastActivity: s.lastActivity });
        updateSessionStatusDom(s.id);
      }
    } else if (msg.type === 'status') {
      _workspaceStatus.set(msg.sessionId, { status: msg.status, currentFile: msg.currentFile, lastActivity: msg.lastActivity });
      updateSessionStatusDom(msg.sessionId);
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
    chip.textContent = info.text;
    chip.className = 'sess-status ' + info.cls;
  }
  const fileEl = document.getElementById(`sess-file-${sessionId}`);
  if (fileEl) {
    fileEl.textContent = st.currentFile ? '✎ ' + st.currentFile.split('/').pop() : '';
    fileEl.style.display = st.currentFile ? '' : 'none';
  }
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
    if (data.image) {
      qrImg.src = data.image.startsWith('data:') ? data.image : `data:image/png;base64,${data.image}`;
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
    defaultSession: document.getElementById('wx-session').value,
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
    defaultSession: document.getElementById('wx-session').value,
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

function wechatPopulateSessionSelect(sessions) {
  const sel = document.getElementById('wx-session');
  if (!sel) return;
  const current = sel.value || sel.dataset.pending || '';
  sel.innerHTML = '<option value="">-- 选择会话 --</option>';
  for (const s of sessions) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.id} — ${s.cwd || '?'}${s.active ? '' : ' (inactive)'}`;
    if (s.id === current) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.dataset.pending = '';
}

async function wechatLoadConfig() {
  try {
    const res = await fetch('/api/wechat/config' + tokenQS('?'));
    const cfg = await res.json();
    document.getElementById('wx-idle').value = cfg.outputIdle || 5000;
    const sel = document.getElementById('wx-session');
    if (sel) sel.dataset.pending = cfg.defaultSession || '';
    wechatSetLoginUI(!!cfg.loggedIn);
  } catch (_) {}
}

async function wechatCheckStatus() {
  try {
    const res = await fetch('/api/wechat/status' + tokenQS('?'));
    const data = await res.json();
    wechatSetLoginUI(data.loggedIn);
    if (data.running) {
      wechatSetRunning(true);
      wechatConnectSSE();
      // Load existing log
      try {
        const logRes = await fetch('/api/wechat/log' + tokenQS('?'));
        const entries = await logRes.json();
        for (const e of entries.slice(-50)) wechatAppendLog(e);
      } catch (_) {}
    }
  } catch (_) {}
}

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
  if (!confirm('Delete all temporary uploaded files?')) return;
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

/* ── Init ── */
loadDashboard();
loadVoiceSettings();
loadPushDiagnostics();
loadNotifySettings();
loadApkInfo();
loadUploadStats();
wechatLoadConfig();
wechatCheckStatus();
auxConnect();
autoRefreshTimer = setInterval(loadDashboard, 5000);
// Refresh push diagnostics periodically and on visibility change
setInterval(loadPushDiagnostics, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadPushDiagnostics();
});
