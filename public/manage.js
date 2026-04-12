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
  const activeIds = new Set(sessions.filter(s => s.active).map(s => s.id));
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

/* ── Session loading ── */
async function loadSessions() {
  try {
    const res = await fetch('/api/sessions' + tokenQS('?'));
    const sessions = await res.json();
    _cachedSessions = sessions;
    renderSessions(sessions);
    syncMonitors(sessions);
    if (typeof wechatPopulateSessionSelect === 'function') wechatPopulateSessionSelect(sessions);
  } catch (err) {
    console.error('Failed to load sessions:', err);
    document.getElementById('session-list').innerHTML =
      `<div class="empty-state"><p style="color:#f85149">Failed to load sessions: ${err.message}</p></div>`;
  }
}

function renderSessions(sessions) {
  const el = document.getElementById('session-list');

  if (sessions.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🖥️</div>
        <p>No active sessions</p>
        <button class="btn btn-green" onclick="newSession()">+ New Session</button>
      </div>`;
    return;
  }

  // Sort: active first, then by lastActivity desc
  sessions.sort((a, b) => {
    if (a.active !== b.active) return b.active ? 1 : -1;
    const aTime = a.lastActivity ? new Date(a.lastActivity) : new Date(0);
    const bTime = b.lastActivity ? new Date(b.lastActivity) : new Date(0);
    return bTime - aTime;
  });

  const isFocused = !!_focusedSessionId;
  const maxCwd = isFocused ? 24 : 36;

  const cards = sessions.map(s => {
    const shortCwd = shortenPath(s.cwd, maxCwd);
    const monStatus = _sessionStatus.get(s.id);
    const mon = monitors.get(s.id);
    let statusClass, statusText;
    if (!s.active) {
      statusClass = 'inactive'; statusText = 'Stopped';
    } else if (monStatus === 'waiting') {
      statusClass = 'waiting'; statusText = '等待操作';
    } else if (monStatus === 'completed') {
      statusClass = 'completed'; statusText = '任务完成';
    } else if (mon && mon.state === 'active') {
      statusClass = 'running'; statusText = '运行中';
    } else {
      statusClass = 'idle'; statusText = '空闲';
    }
    const lastAct = s.lastActivity ? formatRelative(s.lastActivity) : 'N/A';
    const created = formatTime(s.createdAt);
    const focusedClass = s.id === _focusedSessionId ? ' focused' : '';

    return `
      <div class="session-card${focusedClass}" data-id="${escapeHtml(s.id)}" onclick="focusSession('${escapeHtml(s.id)}')">
        <div class="card-top">
          <span class="session-id">#${escapeHtml(s.id)}</span>
          <span class="status-badge ${statusClass}">${statusText}</span>
        </div>
        <div class="card-body">
          <div class="card-field">
            <span class="field-label">cwd</span>
            <span class="field-value cwd-value" title="${escapeHtml(s.cwd || '')}">${escapeHtml(shortCwd)}</span>
          </div>
          <div class="card-field">
            <span class="field-label">Created</span>
            <span class="field-value">${escapeHtml(created)}</span>
          </div>
          ${isFocused ? '' : `<div class="card-field">
            <span class="field-label">Active</span>
            <span class="field-value">${escapeHtml(lastAct)}</span>
          </div>`}
        </div>
        <div class="card-footer">
          <span class="client-count"><span class="count-num">${s.clients}</span> conn</span>
          <button class="btn btn-sm" onclick="event.stopPropagation(); openSessionNewTab('${escapeHtml(s.id)}')">Terminal</button>
          <button class="btn btn-sm" onclick="event.stopPropagation(); openSessionChat('${escapeHtml(s.id)}', '${escapeHtml(s.cwd || '')}')">Chat</button>
          <button class="btn btn-sm btn-danger" onclick="event.stopPropagation(); deleteSession('${escapeHtml(s.id)}')">Del</button>
        </div>
      </div>`;
  }).join('');

  el.innerHTML = `<div class="session-grid">${cards}</div>`;
  // Re-apply persistent status badges (DOM was rebuilt)
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

function openSessionChat(id, cwd) {
  const urlToken = new URLSearchParams(location.search).get('token');
  const params = new URLSearchParams();
  if (urlToken) params.set('token', urlToken);
  if (cwd) params.set('cwd', cwd);
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

function newSession() {
  window.open('/', '_blank');
  setTimeout(loadSessions, 800);
}

function showToast(msg, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.style.background = isError ? '#f85149' : '#238636';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

/* ── Keyboard shortcut: Esc to close focus panel ── */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _focusedSessionId) closeFocusPanel();
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

/* ── Init ── */
loadSessions();
loadVoiceSettings();
loadPushDiagnostics();
loadNotifySettings();
loadApkInfo();
loadUploadStats();
wechatLoadConfig();
wechatCheckStatus();
autoRefreshTimer = setInterval(loadSessions, 5000);
// Refresh push diagnostics periodically and on visibility change
setInterval(loadPushDiagnostics, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadPushDiagnostics();
});
