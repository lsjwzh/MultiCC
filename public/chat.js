'use strict';

// ── Realtime Voice Output (TTS) Integration ──────────────────────────────────
// Provides streaming text-to-speech for AI responses
let _voiceOutputEnabled = false;
let _voiceOutputProvider = 'edge';
let _voiceOutputInstance = null;
let _ttsTextBuffer = '';
let _ttsEnabled = localStorage.getItem('voiceOutputEnabled') === 'true';

// Initialize voice output from settings
async function initVoiceOutput() {
  try {
    const res = await fetch(withToken('/api/settings/voice'));
    const config = await res.json();
    if (config.tts) {
      _voiceOutputProvider = config.tts.provider || 'edge';
      _ttsEnabled = localStorage.getItem('voiceOutputEnabled') === 'true';
    }
  } catch (_) {}
}

// Speak text via TTS (streaming)
async function speakText(text) {
  if (!_ttsEnabled || !text || _voiceOutputInstance) return;

  const wsUrl = `ws${location.protocol.slice(4)}//${location.host}/ws/tts`;

  _voiceOutputInstance = new VoiceOutput({
    wsUrl,
    provider: _voiceOutputProvider,
    onReady: () => console.log('[TTS] Ready'),
    onPlaying: () => console.log('[TTS] Playing'),
    onDone: () => {
      _voiceOutputInstance = null;
      _ttsTextBuffer = '';
    },
    onError: (msg) => {
      console.error('[TTS] Error:', msg);
      _voiceOutputInstance = null;
    },
  });

  try {
    await _voiceOutputInstance.speak(text);
  } catch (_) {
    _voiceOutputInstance = null;
  }
}

// Stop TTS playback
function stopTts() {
  if (_voiceOutputInstance) {
    _voiceOutputInstance.stop();
    _voiceOutputInstance = null;
  }
}

// Toggle voice output
function toggleVoiceOutput() {
  _ttsEnabled = !_ttsEnabled;
  localStorage.setItem('voiceOutputEnabled', _ttsEnabled);
  if (!_ttsEnabled) stopTts();
  return _ttsEnabled;
}
// ── End Voice Output Integration ──────────────────────────────────────────────

// Disable browser scroll restoration — we always want to scroll to latest message
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

/* ── Config ── */
const _params = new URLSearchParams(location.search);
const _token = _params.get('token') || '';
let _cwd = _params.get('cwd') || '';
const _sessionName = _params.get('session') || '';  // dashboard session name
const _hasNativeBridge = typeof window.MultiCCBridge !== 'undefined' && !!window.MultiCCBridge;
function tt(key, params) { return (window.t || ((k) => k))(key, params); }

function withToken(url) {
  if (!_token) return url;
  return url + (url.includes('?') ? '&' : '?') + `token=${encodeURIComponent(_token)}`;
}

/* ── Dynamic favicon + title from session name ── */
const _TAB_COLORS = ['#58a6ff','#f78166','#3fb950','#d29922','#bc8cff','#f97583','#79c0ff','#56d364'];
function _hashColor(s) {
  let h = 0; for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i) * 31) | 0;
  return _TAB_COLORS[Math.abs(h) % _TAB_COLORS.length];
}
let _baseTitle = _sessionName ? `${_sessionName} — MultiCC Chat` : 'MultiCC Chat';
// `text` is what shows in the tab title (e.g. "dir / alias"); `letterSrc` seeds
// the favicon letter/colour (defaults to text). Passing only an id keeps the
// old behaviour as a fallback until the friendly identity loads.
function updateTabIdentity(text, letterSrc) {
  if (!text) return;
  _baseTitle = `${text} — MultiCC Chat`;
  document.title = _baseTitle;
  const src = (letterSrc || text).toString();
  const letter = (src.charAt(0) || '?').toUpperCase();
  const color = _hashColor(src);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#161b22"/><text x="32" y="45" text-anchor="middle" font-family="system-ui,sans-serif" font-size="38" font-weight="700" fill="${color}">${letter}</text></svg>`;
  let link = document.querySelector('link[rel="icon"]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
  link.type = 'image/svg+xml';
  link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}
if (_sessionName) updateTabIdentity(_sessionName);

// Resolve the friendly "directory / alias" identity from the API and upgrade the
// tab title (the URL only carries the session id). Best-effort: on any failure
// the id-based title above stays.
async function loadSessionIdentity() {
  if (!_sessionName) return;
  try {
    const [sessions, dirs] = await Promise.all([
      fetch(withToken('/api/sessions')).then(r => r.json()).catch(() => null),
      fetch(withToken('/api/directories')).then(r => r.json()).catch(() => null),
    ]);
    const sArr = Array.isArray(sessions) ? sessions : (sessions && sessions.sessions) || [];
    const s = sArr.find(x => x.id === _sessionName);
    if (!s) return;
    const alias = (s.label && s.label.trim()) ? s.label.trim() : s.id;
    let dir = '';
    if (s.dirId) {
      const dArr = Array.isArray(dirs) ? dirs : (dirs && dirs.directories) || [];
      const d = dArr.find(x => x.id === s.dirId);
      if (d && d.name) dir = d.name;
    }
    const identity = dir ? `${dir} / ${alias}` : alias;
    updateTabIdentity(identity, alias);
    // Also surface it in the header bar (the visible session title).
    const titleEl = document.getElementById('session-title');
    if (titleEl) { titleEl.textContent = identity; titleEl.title = identity; }
  } catch (e) { /* keep the id-based title */ }
}
loadSessionIdentity();
// Double-click the visible session title in the header to rename it.
// Use event delegation so it works even if the span is repopulated later.
  const _stEl = document.getElementById('session-title');
  if (_stEl) _stEl.style.cursor = 'pointer';
  document.addEventListener('dblclick', (ev) => {
    const el = ev.target.closest('#session-title');
    if (!el) return;
    ev.preventDefault();
    ev.stopPropagation();
    renameSessionFromChat();
  });

/* ── Markdown setup ── */
if (typeof marked !== 'undefined' && marked.setOptions) {
  marked.setOptions({
    highlight(code, lang) {
      if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, { language: lang }).value; } catch (_) {}
      }
      return code;
    },
    breaks: true,
    gfm: true,
  });
}

function renderMarkdown(text) {
  if (!text) return '';
  return (typeof marked !== 'undefined' && marked.parse) ? marked.parse(text) : escHtml(text);
}

// Assistant markdown may reference local-filesystem images, e.g. ![](/tmp/x.png).
// The browser can't load those directly, so rewrite such <img> to stream through
// the existing /api/download?inline=1 route — this is how the agent shows images
// to the user. Web URLs (http/https/data/blob//api/…) are left untouched.
const _LOCAL_IMG_RE = /^(?:file:\/\/|\/(?:tmp|Users|home|var|private|opt|Volumes|mnt|root|data)\/|[A-Za-z]:[\\/])/;
function fixupLocalImages(root) {
  if (!root) return;
  root.querySelectorAll('img').forEach(img => {
    const raw = img.getAttribute('src') || '';
    if (!_LOCAL_IMG_RE.test(raw)) return;
    const p = raw.replace(/^file:\/\//, '');
    const url = withToken('/api/download?path=' + encodeURIComponent(p) + '&inline=1');
    const name = p.split(/[\\/]/).pop();
    img.src = url;
    img.style.maxWidth = '100%';
    img.style.borderRadius = '8px';
    img.style.cursor = 'zoom-in';
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(url, name));
    img.addEventListener('error', () => {
      if (img.dataset.failed) return;
      img.dataset.failed = '1';
      const note = document.createElement('div');
      note.style.cssText = 'font-size:12px;color:#f85149;font-family:monospace';
      note.textContent = '⚠ 无法加载图片: ' + p;
      img.replaceWith(note);
    });
  });
}

/* ── DOM refs ── */
const messagesEl  = document.getElementById('messages');
const inputEl     = document.getElementById('input');
const sendBtn     = document.getElementById('send-btn');
const statusEl    = document.getElementById('status');
const costBar     = document.getElementById('cost-bar');
const cwdPathEl   = document.getElementById('cwd-path');
const attachArea  = document.getElementById('attach-area');
const attachBtn   = document.getElementById('attach-btn');
const fileInput   = document.getElementById('file-input');
const micBtn      = document.getElementById('mic-btn');
const micToast    = document.getElementById('mic-toast');
const cancelBtn   = document.getElementById('cancel-btn');
const mergeBtn    = document.getElementById('merge-btn');
const mergeHint   = document.getElementById('merge-hint');
const mergeHintBtn = document.getElementById('merge-hint-btn');
const headerMoreBtn = document.getElementById('header-more-btn');
const headerMoreMenu = document.getElementById('header-more-menu');
const headerMoreWrap = document.getElementById('header-more-wrap');
const HEADER_MORE_IDS = ['model-btn', 'role-btn', 'memory-btn', 'stream-btn', 'auto-commit-btn', 'share-btn'];

function syncHeaderMoreMenu() {
  if (!headerMoreMenu || !headerMoreWrap) return;
  const compact = window.innerWidth <= 760;
  const header = document.getElementById('header');
  if (!header) return;
  if (compact) {
    for (const id of HEADER_MORE_IDS) {
      const el = document.getElementById(id);
      if (el && el.parentElement !== headerMoreMenu) headerMoreMenu.appendChild(el);
    }
  } else {
    for (const id of HEADER_MORE_IDS) {
      const el = document.getElementById(id);
      if (el && el.parentElement !== header) header.insertBefore(el, headerMoreWrap);
    }
    headerMoreMenu.classList.remove('open');
  }
}

headerMoreBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  const willOpen = !headerMoreMenu?.classList.contains('open');
  if (willOpen) openHeaderMoreModal();
});
headerMoreMenu?.addEventListener('click', (e) => {
  if (e.target.closest('.hdr-btn')) closeHeaderMoreModal();
});
document.addEventListener('click', (e) => {
  if (headerMoreWrap && !headerMoreWrap.contains(e.target) &&
      (!_headerMoreBackdrop || !_headerMoreBackdrop.contains(e.target))) {
    closeHeaderMoreModal();
  }
});
window.addEventListener('resize', syncHeaderMoreMenu);
setTimeout(syncHeaderMoreMenu, 0);

// Phone (<=760px): render the "more" menu as a centered modal with a backdrop,
// so items never get clipped by the viewport edge. Desktop keeps the original
// dropdown behavior.
let _headerMoreBackdrop = null;
function openHeaderMoreModal() {
  closeHeaderMoreModal();
  const compact = window.innerWidth <= 760;
  if (compact) {
    _headerMoreBackdrop = document.createElement('div');
    _headerMoreBackdrop.style.cssText =
      'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px;';
    // Re-parent the menu into the backdrop so it can be centered.
    _headerMoreBackdrop.appendChild(headerMoreMenu);
    document.body.appendChild(_headerMoreBackdrop);
    _headerMoreBackdrop.onclick = (e) => { if (e.target === _headerMoreBackdrop) closeHeaderMoreModal(); };
  }
  headerMoreMenu?.classList.add('open');
}
function closeHeaderMoreModal() {
  headerMoreMenu?.classList.remove('open');
  // Restore the menu to its original wrap when we tore it out for modal mode.
  if (_headerMoreBackdrop) {
    headerMoreWrap?.appendChild(headerMoreMenu);
    _headerMoreBackdrop.remove();
    _headerMoreBackdrop = null;
  }
}

/* ── State ── */
let ws = null;
let sessionId = null;

// Simple HTML escape helper (memo + s2s pickers rely on this at top level)
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Open the project's memo (multicc.memo.md) as an in-page popup.
async function openMemo() {
  const mm = document.getElementById('memo-modal');
  if (!mm) return;
  if (mm.classList.contains('open')) { closeMemo(); return; }

  // Resolve dirId from session info
  let dirId = _memoDirId;
  if (!dirId) {
    try {
      const r = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}`));
      if (r.ok) {
        const s = await r.json();
        dirId = s.dirId || (s.persisted && s.persisted.dirId) || '';
      }
    } catch (_) {}
    if (!dirId) {
      // Fallback: scan all sessions
      try {
        const all = await (await fetch(withToken('/api/sessions'))).json();
        const found = (Array.isArray(all) ? all : []).find(x => x.id === _sessionName);
        if (found) dirId = found.dirId || '';
      } catch (_) {}
    }
    _memoDirId = dirId || '';
  }

  if (!dirId) {
    const statusEl = document.getElementById('memo-status');
    if (statusEl) statusEl.textContent = '无法确定FleetID，会话可能没有归属Fleet';
    mm.classList.add('open');
    return;
  }

  await loadMemo();
  mm.classList.add('open');
  const ta = document.getElementById('memo-text');
  if (ta) setTimeout(() => ta.focus(), 100);
}
let _memoDirId = '';

function closeMemo() {
  const mm = document.getElementById('memo-modal');
  if (mm) mm.classList.remove('open');
  const picker = document.getElementById('memo-picker');
  if (picker) picker.classList.remove('open');
}

async function loadMemo() {
  const dirId = _memoDirId;
  if (!dirId) return;
  const statusEl = document.getElementById('memo-status');
  try {
    const r = await fetch(withToken(`/api/directories/${encodeURIComponent(dirId)}/memo`));
    if (!r.ok) { if (statusEl) statusEl.textContent = '加载失败：HTTP ' + r.status; return; }
    const data = await r.json();
    const ta = document.getElementById('memo-text');
    if (ta) ta.value = data.text || '';
    const subEl = document.getElementById('memo-subtitle');
    if (subEl) subEl.textContent = data.path || (data.exists ? '' : '· 文件尚未创建（保存即创建）');
    // Update title with directory name
    try {
      const dirs = await (await fetch(withToken('/api/directories'))).json();
      const d = (dirs || []).find(x => x.id === dirId);
      if (d) {
        const titleEl = document.getElementById('memo-title');
        if (titleEl) titleEl.textContent = `📝 ${d.name} · 备忘`;
      }
    } catch (_) {}
  } catch (e) { if (statusEl) statusEl.textContent = '加载失败：' + e.message; }
}

async function saveMemo() {
  const dirId = _memoDirId;
  if (!dirId) return;
  const text = document.getElementById('memo-text')?.value;
  if (text === undefined) return;
  const statusEl = document.getElementById('memo-status');
  if (statusEl) statusEl.textContent = '保存中…';
  try {
    const r = await fetch(withToken(`/api/directories/${encodeURIComponent(dirId)}/memo`), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); if (statusEl) statusEl.textContent = '保存失败：' + (e.error || r.status); return; }
    if (statusEl) statusEl.textContent = '已保存 · ' + new Date().toLocaleTimeString();
  } catch (e) { if (statusEl) statusEl.textContent = '保存失败：' + e.message; }
}

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
  line = line.replace(/^\s*[-*+]\s+\[[ xX]\]\s*/, '');
  line = line.replace(/^\s*[-*+]\s+/, '');
  line = line.replace(/^\s*\d+\.\s+/, '');
  line = line.replace(/^\s*#+\s+/, '');
  return line.trim();
}

async function memoOpenPicker() {
  const dirId = _memoDirId;
  if (!dirId) return;
  const text = memoCurrentLineText();
  if (!text) {
    const statusEl = document.getElementById('memo-status');
    if (statusEl) statusEl.textContent = '当前行为空，无法发送';
    return;
  }
  try {
    const all = await (await fetch(withToken('/api/sessions'))).json();
    const sessions = (Array.isArray(all) ? all : [])
      .filter(s => s.dirId === dirId && s.kind === 'chat' && s.type !== 'aux' && s.type !== 'gateway');
    if (!sessions.length) {
      const statusEl = document.getElementById('memo-status');
      if (statusEl) statusEl.textContent = '该Fleet还没有 chat 会话，请先新建一个';
      return;
    }
    const preview = document.getElementById('memo-picker-preview');
    if (preview) preview.textContent = text.length > 200 ? text.slice(0, 200) + '…' : text;
    const list = document.getElementById('memo-picker-list');
    if (list) {
      list.innerHTML = sessions.map(s => {
        const label = s.label && s.label !== s.id
          ? `${escapeHtml(s.label)} <span style="color:#6e7681;">${escapeHtml(s.id)}</span>`
          : escapeHtml(s.id);
        return `<button class="hdr-btn" data-id="${escapeHtml(s.id)}" style="width:100%;justify-content:space-between;"><span style="overflow:hidden;text-overflow:ellipsis;text-align:left;">${label}</span><span style="color:#6e7681;font-size:11px;flex-shrink:0;">${escapeHtml(s.kind || '')}</span></button>`;
      }).join('');
      for (const btn of list.querySelectorAll('button')) {
        btn.onclick = () => memoConfirmSend(btn.getAttribute('data-id'));
      }
    }
    const picker = document.getElementById('memo-picker');
    if (picker) picker.classList.add('open');
  } catch (e) {
    const statusEl = document.getElementById('memo-status');
    if (statusEl) statusEl.textContent = '加载会话列表失败：' + e.message;
  }
}

function memoPickerClose() {
  const picker = document.getElementById('memo-picker');
  if (picker) picker.classList.remove('open');
}

async function memoConfirmSend(sessionId) {
  memoPickerClose();
  const dirId = _memoDirId;
  const text = memoCurrentLineText();
  if (!text || !dirId) return;
  const statusEl = document.getElementById('memo-status');
  if (statusEl) statusEl.textContent = `发送到 ${sessionId}…`;
  try {
    const r = await fetch(withToken(`/api/directories/${encodeURIComponent(dirId)}/memo/send`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sessionId }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); if (statusEl) statusEl.textContent = '发送失败：' + (e.error || r.status); return; }
    if (statusEl) statusEl.textContent = '已发送到 ' + sessionId + ' · ' + new Date().toLocaleTimeString();
  } catch (e) { if (statusEl) statusEl.textContent = '发送失败：' + e.message; }
}

// Bind memo popup events after DOM loads
document.addEventListener('DOMContentLoaded', () => {
  const mm = document.getElementById('memo-modal');
  if (!mm) return;
  // Close on backdrop click
  mm.addEventListener('click', (e) => { if (e.target === mm) closeMemo(); });
  // Close button
  const closeBtn = document.getElementById('memo-close-btn');
  if (closeBtn) closeBtn.addEventListener('click', closeMemo);
  // Save button
  const saveBtn = document.getElementById('memo-save-btn');
  if (saveBtn) saveBtn.addEventListener('click', saveMemo);
  // Send line button
  const sendBtn = document.getElementById('memo-send-btn');
  if (sendBtn) sendBtn.addEventListener('click', memoOpenPicker);
  // Ctrl/Cmd+S to save
  const ta = document.getElementById('memo-text');
  if (ta) {
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveMemo();
      }
      if (e.key === 'Escape') closeMemo();
    });
  }
});
let isStreaming = false;
let _pendingCancel = false; // cancel requested while WS was disconnected

// Context window tracking
let _contextWindow = 1000000;
let _usedTokens = 0;
let _costText = '';  // latest cost summary string, kept separate from the context readout
let _sessionTokens = { input: 0, output: 0 };  // per-session cumulative token usage
let _turnStartMs = 0;  // wall-clock when the current turn was sent (live reply timing)
// Per-turn main/sub role breakdown (from claude-proxy onUsage, via
// role_token_stats WS). The CLI's result event merges main + all subagents into
// one usage block even across different providers; this separates them so
// "本轮" can show 主 A / 辅 B. Null when no subagent ran this turn.
let _roleTokens = { main: null, sub: null, subByProvider: [] };
// Per-turn accumulator for the LATEST streaming LLM step's usage, fed by
// message_start (input/cache) + message_delta (output). Drives the live
// `.msg-usage` footer on the currently-streaming bubble so token counts show
// during output, not only at turn end. Reset when a new turn starts.
// Shape: { inputTokens, outputTokens, cacheWrite, cacheRead }
let _liveStreamUsage = null;
// Provider-level time-window token stats (updated after each turn)
let _providerId = null;
let _providerName = null;
let _providerTokenWindows = null;  // { today, week, month, all } | null

let currentMsgEl = null;
let currentTextContent = '';
let currentToolCards = new Map();
let activeContentType = null;
let activeContentIndex = -1;
let currentCli = 'claude';
let _mergeReady = false;
let _syncConflict = false;
let _syncConflictFiles = [];
let _mergePollTimer = null;
// Track last-warned behind count so we surface a notice when the worktree first
// falls behind its base branch (or falls further), not on every 5s poll.
let _lastWarnedBehind = 0;

/* ── Debug panel ──
   Records every WS event and every thinking/streaming state transition so the
   "stuck on Thinking..." bug can be diagnosed live. The panel highlights the
   exact failure signature in red: thinking bubble visible while not streaming. */
const _dbgPanel   = document.getElementById('debug-panel');
const _dbgLogEl   = document.getElementById('dbg-log');
const _dbgStateEl = document.getElementById('dbg-state');
const _DBG_MAX = 600;
let _dbgEntries = [];

function _dbgTime() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function _wsStateName() {
  if (!ws) return 'null';
  return ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][ws.readyState] || String(ws.readyState);
}

function dbg(cat, text) {
  const time = _dbgTime();
  _dbgEntries.push(`${time} [${cat}] ${text}`);
  if (_dbgEntries.length > _DBG_MAX) _dbgEntries.shift();
  if (_dbgLogEl) {
    const line = document.createElement('div');
    line.className = 'dbg-line';
    line.innerHTML =
      `<span class="dbg-time">${time}</span> ` +
      `<span class="dbg-cat-${cat}">[${cat}]</span> ${escHtml(text)}`;
    const nearBottom = _dbgLogEl.scrollHeight - _dbgLogEl.scrollTop - _dbgLogEl.clientHeight < 60;
    _dbgLogEl.appendChild(line);
    while (_dbgLogEl.children.length > _DBG_MAX) _dbgLogEl.removeChild(_dbgLogEl.firstChild);
    if (nearBottom) _dbgLogEl.scrollTop = _dbgLogEl.scrollHeight;
  }
  dbgState();
}

function dbgState() {
  if (!_dbgStateEl) return;
  const wsName = _wsStateName();
  const thinking = !!thinkingEl;
  const stuck = thinking && !isStreaming;  // the exact bug signature
  const badges = [
    `<span class="dbg-badge ${wsName === 'OPEN' ? 'ok' : 'bad'}"><b>ws</b> ${wsName}</span>`,
    `<span class="dbg-badge ${isStreaming ? 'warn' : ''}"><b>streaming</b> ${isStreaming}</span>`,
    `<span class="dbg-badge ${stuck ? 'bad' : (thinking ? 'warn' : '')}"><b>thinking</b> ${thinking}</span>`,
    `<span class="dbg-badge"><b>msgEl</b> ${!!currentMsgEl}</span>`,
    `<span class="dbg-badge"><b>session</b> ${sessionId ? sessionId.slice(0, 8) : '-'}</span>`,
  ];
  if (stuck) badges.push('<span class="dbg-badge bad">&#9888; STUCK: thinking 显示中但已不在 streaming</span>');
  _dbgStateEl.innerHTML = badges.join('');
}

/* ── CWD display ── */
function updateCwdDisplay(p) {
  _cwd = p || _cwd;
  cwdPathEl.textContent = _cwd || '(unknown)';
  cwdPathEl.title = _cwd;
}
updateCwdDisplay(_cwd);

/* ── WebSocket with auto-reconnect ── */
let _reconnectAttempt = 0;
let _reconnectTimer = null;
let _historyLoaded = false;  // prevent duplicate history render across reconnects
let _wasConnected = false;       // true once we've successfully opened at least one WS
let _disconnectBannerEl = null;  // in-chat sticky banner while disconnected
let _isDisconnected = false;
let _disconnectEpisodeId = 0;
let _lastReconnectNoticeEpisode = 0;
let _lastInitInfoLine = '';
let _hiddenAt = 0;

function connect() {
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let url = `${proto}//${location.host}/ws/chat`;
  const params = [];
  if (_token) params.push(`token=${encodeURIComponent(_token)}`);
  if (_cwd) params.push(`cwd=${encodeURIComponent(_cwd)}`);
  if (_sessionName) params.push(`session=${encodeURIComponent(_sessionName)}`);
  if (sessionId) params.push(`resume=${encodeURIComponent(sessionId)}`);
  if (params.length) url += '?' + params.join('&');

  ws = new WebSocket(url);
  statusEl.textContent = 'Connecting...';
  statusEl.className = '';

  dbg('ws', `connect() → ${url.replace(/token=[^&]*/, 'token=***')}`);

  ws.onopen = () => {
    statusEl.textContent = 'Connected';
    statusEl.className = 'connected';
    _reconnectAttempt = 0;
    dbg('ws', 'onopen — 连接已建立');
    // If we'd shown the disconnect banner, replace it with a reconnected marker.
    if (_disconnectBannerEl) {
      _disconnectBannerEl.remove();
      _disconnectBannerEl = null;
      if (_disconnectEpisodeId !== _lastReconnectNoticeEpisode) {
        _lastReconnectNoticeEpisode = _disconnectEpisodeId;
        addSystemMsg('✓ 已重新连接');
      }
    }
    _isDisconnected = false;
    _wasConnected = true;
    // Show thinking while we wait for server's init message (which tells us real streaming state)
    if (isStreaming) showThinking();
    updateUI();
  };

  ws.onmessage = ({ data }) => {
    try {
      handleEvent(JSON.parse(data));
    } catch (e) {
      console.warn('Bad message:', data, e);
    }
  };

  ws.onclose = (e) => {
    dbg('ws', `onclose — code=${e.code} (isStreaming=${isStreaming})`);
    if (_wasConnected && !_isDisconnected) {
      _isDisconnected = true;
      _disconnectEpisodeId++;
    }
    // Don't reset isStreaming here — server may still be running.
    // UI stays in streaming state so user sees "reconnecting" rather than a broken state.
    updateUI();
    // Auto-reconnect with exponential backoff (1s, 2s, 4s, 8s, max 15s)
    const delay = Math.min(1000 * Math.pow(2, _reconnectAttempt), 15000);
    _reconnectAttempt++;
    const secs = Math.round(delay / 1000);
    statusEl.textContent = `Reconnecting in ${secs}s...`;
    statusEl.className = 'error';
    statusEl.onclick = () => { _reconnectAttempt = 0; connect(); };
    // Sticky in-chat banner so the reconnect state is visible without scrolling up.
    if (_wasConnected) showDisconnectBanner(secs);
    _reconnectTimer = setTimeout(connect, delay);
  };

  ws.onerror = () => {};
}

function isRecoverableCodexReconnectErrorText(text) {
  const s = String(text || '');
  return /^Codex 出错：Reconnecting\.\.\.\s*\d+\/\d+\s*\(/i.test(s)
    && /stream disconnected before completion|response\.completed/i.test(s);
}

/* ── Event handler ── */
function handleEvent(msg) {
  let _s = msg.type;
  if (msg.type === 'system') _s += `/${msg.subtype || '?'}` + ('is_streaming' in msg ? ` is_streaming=${msg.is_streaming}` : '');
  else if (msg.type === 'stream_event') _s += `/${msg.event?.type || '?'}`;
  else if (msg.type === 'assistant') {
    const kinds = (msg.message?.content || []).map(b => b.type).join(',');
    _s += kinds ? ` [${kinds}]` : '';
  }
  else if (msg.type === 'result') _s += ` cost=${msg.total_cost_usd ?? 'null'}`;
  else if (msg.type === 'error') _s += ` ${msg.error || ''}`;
  dbg('event', `WS ◀ ${_s}`);

  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        // Only the SERVER's init carries `is_streaming`. Claude CLI's own
        // stream-json init has the same shape but no `is_streaming`, and
        // must NOT be treated as a (re)connect init — otherwise it would
        // fire the "completed while disconnected" warning every single turn.
        if (!('is_streaming' in msg)) break;

        sessionId = msg.session_id || msg.session || sessionId;
        refreshNotifyPreference();
        if (!_sessionName && sessionId) updateTabIdentity(sessionId);
        if (msg.cwd) updateCwdDisplay(msg.cwd);
        // Update CLI badge in the header (Claude orange / Codex green)
        if (msg.cli) {
          currentCli = msg.cli;
          const badge = document.querySelector('.badge');
          if (badge) {
            badge.textContent = msg.cli === 'codex' ? 'Codex · Chat' : 'Claude · Chat';
            badge.style.background = msg.cli === 'codex' ? '#2ea043' : '#f78166';
          }
          if (document.title && !document.title.includes(msg.cli)) {
            document.title = `MultiCC Chat · ${msg.cli}`;
          }
        }
        const parts = [];
        if (sessionId) parts.push(`Session: ${sessionId.slice(0, 8)}...`);
        if (msg.cli) parts.push(msg.cli);
        if (msg.model) parts.push(msg.model);
        const initInfoLine = parts.join(' | ');
        if (initInfoLine && initInfoLine !== _lastInitInfoLine) {
          _lastInitInfoLine = initInfoLine;
          addSystemMsg(initInfoLine);
        }
        if (msg.effort !== undefined) {
          _sessionEffort = msg.effort || '';
          _sessionEffectiveEffort = msg.effectiveEffort || _sessionEffort || 'medium';
        }
        // 重新打开 / 断线重连时，用 init 携带的实际生效 provider/model 恢复顶部标签。
        // loadSessionModel() 仅首次加载执行；重连只走 init，缺这些字段就会显示 Default。
        // providerId 必须恢复，否则 AI 配置弹窗的 Provider 下拉会落到「默认登录」。
        if (msg.providerId !== undefined) _sessionProvider = msg.providerId || '';
        if (msg.providerName !== undefined) _sessionProviderDisplayName = msg.providerName || '';
        if (msg.cli) _sessionCli = msg.cli;
        // effectiveModel/model refresh unconditionally on reconnect, exactly like
        // provider/effort above — otherwise a server-side alias-map change leaves
        // the AI-config button showing the NEW provider paired with the OLD model.
        if (msg.effectiveModel !== undefined) {
          _sessionEffectiveModel = msg.effectiveModel || '';
          if (msg.model !== undefined) _sessionModel = msg.model || '';
        }
        if (msg.effort !== undefined || msg.providerName || msg.effectiveModel !== undefined || msg.providerId !== undefined) {
          updateEffortBtn();
          updateModelBtn();
        }
        // Sync streaming state with server on (re)connect
        if (msg.is_streaming && _pendingCancel) {
          // User cancelled while disconnected — now that we're back, send it
          _pendingCancel = false;
          ws.send(JSON.stringify({ type: 'cancel' }));
          // Don't enter streaming state — we just cancelled
        } else if (msg.is_streaming && !isStreaming) {
          isStreaming = true;
          showThinking();
          startTitleAnimation();
          updateUI();
        } else if (!msg.is_streaming && isStreaming) {
          // Task finished while we were disconnected. No notification here: the
          // aux-AI `notify` verdict (single judge) fired live at completion
          // time, and reconnecting means the tab is in front of the user again.
          isStreaming = false;
          hideThinking();
          finishStreaming();
          stopTitleAnimation();
          addSystemMsg('⚠️ Response completed while disconnected. Check history above.');
          updateUI();
        }
        // Capture provider info + time-window token stats from server.
        if (msg.providerId !== undefined) _providerId = msg.providerId;
        if (msg.providerName !== undefined) _providerName = msg.providerName;
        if (msg.providerTokenWindows) {
          _providerTokenWindows = msg.providerTokenWindows;
          updateContextBar();
        }
      } else if (msg.subtype === 'agent_notes' && Array.isArray(msg.notes)) {
        addAgentNotes(msg.notes);
      } else if (msg.message) {
        addSystemMsg(msg.message);
      }
      break;

    case 'session_id':
      if (msg.id) { sessionId = msg.id; refreshNotifyPreference(); if (!_sessionName) updateTabIdentity(msg.id); }
      break;

    case 'stream_event':
      handleStreamEvent(msg.event);
      break;

    case 'assistant':
      finalizeAssistantMsg(msg.message);
      break;

    case 'user':
      if (msg.tool_use_result || msg.message?.content) handleToolResult(msg);
      break;

    case 'result':
      isStreaming = false;
      var _resultBubble = currentMsgEl;  // capture before finishStreaming() nulls it
      finishStreaming();
      // Pass the per-role breakdown so the message footer shows 主/辅 split
      // (from claude-proxy onUsage) alongside the CLI's merged aggregate.
      if (msg.usage || _roleTokens.main) attachUsageLine(_resultBubble, msg.usage, _roleTokens);
      // Live timing line: prefer server-stamped durationMs, else client turn clock.
      if (_resultBubble) {
        const ce = _resultBubble.querySelector('.msg-content');
        if (ce && !ce.querySelector('.msg-timing')) {
          const dur = Number.isFinite(msg.durationMs) ? msg.durationMs
            : (_turnStartMs ? Date.now() - _turnStartMs : NaN);
          const timing = buildTimingLine({ role: 'assistant', ts: Date.now(), durationMs: dur });
          if (timing) ce.appendChild(timing);
        }
      }
      _turnStartMs = 0;
      stopTitleAnimation();
      // No notification here: a `result` only means the stream paused, which
      // happens between turns of a multi-step agent run too. The server's
      // aux-AI debounces the pause and sends a `notify` verdict — that's the
      // single judge (see 'notify' case).
      if (msg.total_cost_usd) {
        const durStr = Number.isFinite(msg.durationMs) ? fmtDuration(msg.durationMs) : (msg.duration_ms ? msg.duration_ms + 'ms' : '');
        _costText = `$${msg.total_cost_usd.toFixed(4)}`;
        if (durStr) _costText += ` | ${durStr}`;
        if (msg.num_turns) _costText += ` | ${msg.num_turns} turn(s)`;
      }
      // Accumulate per-session token totals.
      if (msg.usage) {
        _sessionTokens.input += msg.usage.input_tokens || 0;
        _sessionTokens.output += msg.usage.output_tokens || 0;
      }
      updateContextBar(msg.usage, msg.modelUsage);
      updateUI();
      // Auto-commit & merge if enabled for this turn (checkbox lives under the user message)
      autoCommitIfNeeded(_lastUserBubble);
      break;

    case 'provider_token_stats':
      if (msg.windows) {
        _providerTokenWindows = msg.windows;
        updateContextBar();
      }
      break;

    case 'role_token_stats':
      // Per-turn main/sub breakdown from the claude-proxy (the only place that
      // knows each request's real route). Drives the "本轮 主 A / 辅 B" split
      // that the merged CLI result event can't provide.
      if (msg.role) {
        _roleTokens = { main: msg.role.main || null, sub: msg.role.sub || null, subByProvider: msg.role.subByProvider || [] };
        // Live update: refresh the CURRENTLY STREAMING bubble's footer token
        // line as each /v1/messages response lands — previously the footer
        // stayed empty until the `result` event at turn end. currentMsgEl is
        // non-null mid-stream; pass null usage to let roleBreakdown drive the
        // numbers (the CLI's aggregate isn't available until result).
        if (currentMsgEl && isStreaming) {
          attachUsageLine(currentMsgEl, null, _roleTokens);
        }
        updateContextBar();
      }
      break;

    case 'chat_msg_meta': {
      // Server saved a message and assigned its history id — tag the newest
      // bubble of that role (if it isn't tagged yet) so its delete button
      // goes live without waiting for a reload.
      if (msg.id && msg.role) {
        const bubbles = messagesEl.querySelectorAll(msg.role === 'user' ? '.msg.user' : '.msg.assistant');
        const last = bubbles[bubbles.length - 1];
        if (last && !last.dataset.msgId) {
          last.dataset.msgId = msg.id;
          attachDeleteButton(last);
          attachForkButton(last);
        }
      }
      break;
    }

    case 'chat_msg_deleted': {
      // Broadcast from the server after a successful delete (from any client).
      if (msg.id) {
        const el = messagesEl.querySelector(`.msg[data-msg-id="${msg.id}"]`);
        if (el) el.remove();
      }
      break;
    }

    case 'chat_history':
      if (!_historyLoaded) {
        _historyLoaded = true;
        // Prefer server's authoritative token_usage.json accumulator over
        // reconstructing from the rolling chat_history window.
        replayHistory(msg.messages, msg.tokenUsage || null);
      }
      break;

    case 'rate_limit_event':
      break;

    case 'stream_end':
      // Safety net: server confirms process exited — ensure cancel button is
      // hidden. No notification here; the aux-AI `notify` verdict is the judge.
      if (isStreaming) {
        isStreaming = false;
        finishStreaming();
        stopTitleAnimation();
        updateUI();
      }
      break;

    case 'notify': {
      // Server-side aux-AI verdict that the turn finished / is waiting / running.
      // This is the single source of truth for notifications — we no longer
      // guess from `result` (which also fires between turns of an agent run).
      if (msg.state === 'running') {
        // In-progress summary: show a toast (even when tab is visible) but
        // don't play a sound — it's a status update, not an alert.
        showNotifyToast(msg.message || '任务进行中', 'running');
      } else {
        const waiting = msg.state === 'waiting';
        speakNotify(waiting ? '等待操作' : '任务已完成', waiting ? 'waiting' : 'completed');
      }
      break;
    }

    case 'error':
      if (isRecoverableCodexReconnectErrorText(msg.error || '')) {
        console.warn('[multicc/chat] suppressed recoverable codex reconnect:', msg.error);
        break;
      }
      addSystemMsg(`Error: ${msg.error || JSON.stringify(msg)}`);
      isStreaming = false;
      finishStreaming();
      stopTitleAnimation();
      updateUI();
      break;
  }
}

function handleStreamEvent(evt) {
  if (!evt) return;
  switch (evt.type) {
    case 'message_start':
      isStreaming = true;
      hideThinking();
      // Within ONE user turn, the agent loop emits a fresh message_start per
      // LLM step. Reuse the same bubble across the whole turn so all text and
      // tool cards land in one place (one bounded, scrollable .tool-stack)
      // instead of spawning a new bubble — and a new stack — on every step.
      // This matches how the server persists a turn (one assistant message
      // with all tools) and the codex path (no message_start at all).
      // The turn ends at `result` / `stream_end` / `error`, which all call
      // finishStreaming() and null currentMsgEl, so a genuinely new turn (or a
      // stale bubble left by an error) still starts a fresh bubble below.
      if (!currentMsgEl) {
        currentMsgEl = createAssistantBubble();
      } else if (currentTextContent && !currentTextContent.endsWith('\n\n')) {
        // Continuing the same turn: keep prior text but separate this step's
        // text from the previous step's with a blank line.
        currentTextContent += '\n\n';
      }
      startTitleAnimation();
      updateUI();
      // Live token display: message_start carries the input-side usage
      // (input_tokens, cache_read_input_tokens, cache_creation_input_tokens)
      // the instant this LLM step begins. Show it on the streaming bubble's
      // footer right away so the user sees token counts during output — not
      // only after the turn ends. output_tokens arrives later in
      // message_delta. Falls back to _roleTokens (proxy onUsage) for the
      // 主/辅 split when available.
      if (evt.message?.usage) {
        _liveStreamUsage = accumulateLiveUsage(evt.message.usage, _liveStreamUsage);
        attachUsageLine(currentMsgEl, null, _roleTokens.main ? _roleTokens : { main: _liveStreamUsage, sub: null, subByProvider: [] });
      }
      break;

    case 'content_block_start':
      activeContentIndex = evt.index;
      if (evt.content_block?.type === 'text') {
        activeContentType = 'text';
      } else if (evt.content_block?.type === 'tool_use') {
        activeContentType = 'tool_use';
        const card = createToolCard(evt.content_block.name, evt.content_block.id);
        currentToolCards.set(evt.index, {
          card, inputJson: '', name: evt.content_block.name, id: evt.content_block.id
        });
        appendToolCard(currentMsgEl.querySelector('.msg-content'), card);
      }
      break;

    case 'content_block_delta':
      if (evt.delta?.type === 'text_delta' && evt.delta.text) {
        currentTextContent += evt.delta.text;
        renderCurrentText();
        scrollToBottom();
      } else if (evt.delta?.type === 'input_json_delta' && evt.delta.partial_json) {
        const tc = currentToolCards.get(evt.index);
        if (tc) {
          tc.inputJson += evt.delta.partial_json;
          updateToolInput(tc);
        }
      }
      break;

    case 'content_block_stop':
      activeContentType = null;
      activeContentIndex = -1;
      break;

    case 'message_delta':
      if (evt.usage) {
        updateContextBar(evt.usage);
        // Live token display: message_delta carries output_tokens (cumulative
        // for this LLM step) near the end of the step. Accumulate into the
        // streaming bubble's footer line so output tokens appear as soon as
        // the step finishes — not only at turn-end result.
        _liveStreamUsage = accumulateLiveUsage(evt.usage, _liveStreamUsage);
        if (currentMsgEl) {
          attachUsageLine(currentMsgEl, null, _roleTokens.main ? _roleTokens : { main: _liveStreamUsage, sub: null, subByProvider: [] });
        }
      }
      break;
    case 'message_stop':
      break;
  }
}

function handleToolResult(msg) {
  const content = msg.message?.content;
  if (!content) return;
  const results = Array.isArray(content) ? content : [content];
  for (const r of results) {
    if (r.type !== 'tool_result') continue;
    for (const [, tc] of currentToolCards) {
      if (tc.id === r.tool_use_id) {
        const text = typeof r.content === 'string' ? r.content :
          Array.isArray(r.content) ? r.content.map(c => c.text || '').join('') : JSON.stringify(r.content);
        addToolResult(tc, text, r.is_error);
        break;
      }
    }
  }
  scrollToBottom();

  // Speak the assistant's response if TTS is enabled
  if (textForTts && _ttsEnabled && !_voiceOutputInstance) {
    speakText(textForTts.trim());
  }
}

function findCurrentToolCardById(id) {
  for (const [, tc] of currentToolCards) {
    if (tc.id === id) return tc;
  }
  return null;
}

function finalizeAssistantMsg(message) {
  if (!message?.content) return;
  // Real assistant content arrived — the thinking bubble must go away now.
  // Codex never emits a `message_start` stream event (which is what hides the
  // bubble for Claude), so without this the bubble lingers until `result`.
  hideThinking();

  // Collect text for TTS
  let textForTts = '';

  for (const block of message.content) {
    if (block.type === 'text' && block.text) {
      if (!currentMsgEl) currentMsgEl = createAssistantBubble();
      if (currentCli === 'codex') {
        currentTextContent += block.text;
      } else if (!currentTextContent) {
        currentTextContent = block.text;
      }
      textForTts += block.text;
      renderCurrentText();
      scrollToBottom();
    } else if (currentCli === 'codex' && block.type === 'tool_use' && block.id) {
      if (!currentMsgEl) currentMsgEl = createAssistantBubble();
      let tc = findCurrentToolCardById(block.id);
      if (!tc) {
        const card = createToolCard(block.name || 'Tool', block.id);
        tc = {
          card,
          inputJson: block.input ? JSON.stringify(block.input) : '',
          name: block.name || 'Tool',
          id: block.id,
        };
        currentToolCards.set(`id:${block.id}`, tc);
        appendToolCard(currentMsgEl.querySelector('.msg-content'), card);
      } else if (block.input) {
        tc.inputJson = JSON.stringify(block.input);
      }
      updateToolInput(tc);
      scrollToBottom();
    }
  }
}

function finishStreaming() {
  // Catch-all: every terminal/transition path funnels through here, so this is
  // the one reliable place to guarantee the thinking bubble is cleared.
  hideThinking();
  // Reset the per-step live usage accumulator — the next turn's message_start
  // starts fresh. The finalized footer (attached at result) used the CLI's
  // authoritative usage, so the live accumulator is no longer needed.
  _liveStreamUsage = null;
  if (currentMsgEl) {
    const dot = currentMsgEl.querySelector('.streaming-dot');
    if (dot) dot.classList.remove('streaming-dot');
    try {
      renderCurrentText(true);
    } catch (e) {
      console.warn('Failed to render final assistant text:', e);
      dbg('event', `render final failed: ${e.message}`);
    }
  }
  currentMsgEl = null;
  currentTextContent = '';
  currentToolCards = new Map();
}

/* ── Rendering ── */
function createAssistantBubble() {
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.innerHTML = '<div class="msg-content streaming-dot"></div>';
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

// Accumulate Anthropic-native usage (snake_case fields from message_start /
// message_delta SSE events) into the live streaming bucket (camelCase).
// output_tokens in message_delta is CUMULATIVE for this LLM step, so take
// max rather than sum; input/cache fields from message_start are the step's
// totals and are summed across steps within the turn.
function accumulateLiveUsage(usage, bucket) {
  if (!usage) return bucket;
  const b = bucket || { inputTokens: 0, outputTokens: 0, cacheWrite: 0, cacheRead: 0 };
  if (typeof usage.input_tokens === 'number') b.inputTokens += usage.input_tokens;
  if (typeof usage.output_tokens === 'number' && usage.output_tokens > b.outputTokens) b.outputTokens = usage.output_tokens;
  if (typeof usage.cache_creation_input_tokens === 'number') b.cacheWrite += usage.cache_creation_input_tokens;
  if (typeof usage.cache_read_input_tokens === 'number') b.cacheRead += usage.cache_read_input_tokens;
  return b;
}

// Build the per-message token usage line shown under an assistant bubble.
// `usage` mirrors Anthropic's shape (input_tokens / output_tokens /
// cache_read_input_tokens / cache_creation_input_tokens). Returns null when
// there's nothing meaningful to show.
//
// `roleBreakdown` (optional) splits the turn's tokens into 主 (main loop) vs
// 辅 (Task-tool subagents), each billed to its actual provider — the CLI's
// `result.usage` merges them into one aggregate even across different
// providers. When present, the line shows per-role totals with a tooltip
// breaking down each sub-provider; when absent, falls back to the merged
// aggregate. roleBreakdown shape: { main:{inputTokens,outputTokens,cacheWrite,cacheRead},
//                                   sub:{...}|null,
//                                   subByProvider:[{name,model,inputTokens,outputTokens,...}] }
function buildUsageLine(usage, roleBreakdown) {
  if (!usage && !roleBreakdown) return null;
  const i  = (usage && usage.input_tokens) || 0;
  const o  = (usage && usage.output_tokens) || 0;
  const cr = (usage && usage.cache_read_input_tokens) || 0;
  const cw = (usage && usage.cache_creation_input_tokens) || 0;
  const n = x => x.toLocaleString('en-US');

  // ── Role-split mode (主/辅) ──
  if (roleBreakdown && (roleBreakdown.main || roleBreakdown.sub)) {
    const sumB = (b) => b ? { i: b.inputTokens||0, o: b.outputTokens||0, cr: b.cacheRead||0, cw: b.cacheWrite||0, t: (b.inputTokens||0)+(b.outputTokens||0)+(b.cacheRead||0)+(b.cacheWrite||0) } : null;
    const mb = sumB(roleBreakdown.main);
    const sb = sumB(roleBreakdown.sub);
    // Aggregate (main+sub) for the headline numbers; equals the CLI's merged
    // total when both routes reported — keeps the row comparable to the old
    // single-number display, with the split as added detail.
    const ai = (mb?mb.i:0) + (sb?sb.i:0);
    const ao = (mb?mb.o:0) + (sb?sb.o:0);
    const acr = (mb?mb.cr:0) + (sb?sb.cr:0);
    const acw = (mb?mb.cw:0) + (sb?sb.cw:0);
    if (ai + ao + acr + acw === 0) return null;
    const el = document.createElement('div');
    el.className = 'msg-usage';
    // Tooltip: aggregate + per-role + per-sub-provider detail.
    let tip = `本条消息 token 用量\n合计 ${n(ai+ao+acr+acw)}\n`;
    if (mb) tip += `— 主 — 输入 ${n(mb.i)} 输出 ${n(mb.o)} 缓存读 ${n(mb.cr)} 缓存写 ${n(mb.cw)}\n`;
    if (sb) {
      tip += `— 辅 合计 — 输入 ${n(sb.i)} 输出 ${n(sb.o)} 缓存读 ${n(sb.cr)} 缓存写 ${n(sb.cw)}\n`;
      for (const p of (roleBreakdown.subByProvider || [])) {
        tip += `    · ${p.name||p.providerId} / ${p.model||'?'}: ↑入 ${n(p.inputTokens||0)} ↓出 ${n(p.outputTokens||0)}\n`;
      }
    }
    el.title = tip.trim();
    // Headline: ↑入 / ↓出 with a 主/辅 split suffix when subagents ran.
    let html =
      `<span class="u-in">&#8593;入 ${n(ai)}</span>` +
      `<span class="u-out">&#8595;出 ${n(ao)}</span>`;
    if (acr) html += `<span class="u-cache">&#9851;读 ${n(acr)}</span>`;
    if (acw) html += `<span class="u-cache">&#9851;写 ${n(acw)}</span>`;
    if (mb && sb) {
      const mt = mb.t, st = sb.t;
      html += `<span class="u-role" title="主 ${n(mt)} · 辅 ${n(st)}">主 ${n(mt)} · 辅 ${n(st)}</span>`;
    } else if (mb) {
      html += `<span class="u-role" title="仅主循环">主 ${n(mb.t)}</span>`;
    }
    el.innerHTML = html;
    return el;
  }

  // ── Legacy aggregate mode (no role info, e.g. official/non-proxy sessions) ──
  if (i + o + cr + cw === 0) return null;
  const el = document.createElement('div');
  el.className = 'msg-usage';
  el.title = `本条消息 token 用量\n输入 ${n(i)}\n输出 ${n(o)}\n缓存读 ${n(cr)}\n缓存写 ${n(cw)}\n合计 ${n(i + o + cr + cw)}`;
  el.innerHTML =
    `<span class="u-in">&#8593;入 ${n(i)}</span>` +
    `<span class="u-out">&#8595;出 ${n(o)}</span>` +
    (cr ? `<span class="u-cache">&#9851;读 ${n(cr)}</span>` : '') +
    (cw ? `<span class="u-cache">&#9851;写 ${n(cw)}</span>` : '');
  return el;
}

// Human-friendly duration: 820ms / 6.2s / 1m3s.
function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s % 60)}s`;
}

// Per-message timing line: reply clock time + interaction latency (durationMs).
// Shown under an assistant bubble so each reply records when it came back and
// how long the turn took.
function buildTimingLine(m) {
  const ts = Number(m.ts);
  const hasTs = Number.isFinite(ts) && ts > 0;
  const dur = Number(m.durationMs);
  const hasDur = Number.isFinite(dur) && dur >= 0;
  if (!hasTs && !hasDur) return null;
  const el = document.createElement('div');
  el.className = 'msg-timing';
  el.style.cssText = 'font-size:11px;color:#6e7681;display:flex;gap:10px;padding:1px 0;';
  let html = '';
  if (hasTs) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    html += `<span title="回复时间">&#128336; ${hh}:${mm}:${ss}</span>`;
  }
  if (hasDur) html += `<span title="本次交互耗时">&#9201; ${fmtDuration(dur)}</span>`;
  el.innerHTML = html;
  return el;
}

// ── Per-message delete ──
// Hover "×" on a bubble whose server-side history id is known. Deleting
// removes the entry from chat_history (display history only — the CLI's own
// conversation context is not rewritten). The button lives on the outer .msg
// element so renderCurrentText()'s .msg-content rebuilds can't wipe it.

// ── In-page dialog helpers (replaces native confirm/alert which browsers
// often suppress inside iframes) ──
function _chatConfirm(message, opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:360px;max-width:90vw;';
    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:14px;color:#c9d1d9;line-height:1.6;white-space:pre-wrap;margin-bottom:12px;';
    msg.textContent = message;
    box.appendChild(msg);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn'; cancelBtn.textContent = opts.cancelText || '取消';
    const okBtn = document.createElement('button');
    okBtn.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-green');
    okBtn.textContent = opts.okText || '确认';
    row.appendChild(cancelBtn); row.appendChild(okBtn);
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = (result) => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(result); };
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(false); } }
    okBtn.onclick = () => close(true);
    cancelBtn.onclick = () => close(false);
    overlay.onclick = (e) => { if (e.target === overlay) close(false); };
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => okBtn.focus(), 0);
  });
}
function _chatAlert(message, opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:360px;max-width:90vw;';
    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:14px;color:' + (opts.danger ? '#f85149' : '#c9d1d9') + ';line-height:1.6;white-space:pre-wrap;margin-bottom:12px;';
    msg.textContent = message;
    box.appendChild(msg);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const okBtn = document.createElement('button');
    okBtn.className = 'btn btn-green'; okBtn.textContent = opts.okText || '知道了';
    row.appendChild(okBtn);
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(); };
    function onKey(e) { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close(); } }
    okBtn.onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => okBtn.focus(), 0);
  });
}

function attachDeleteButton(msgEl) {
  if (!msgEl || !msgEl.dataset.msgId || msgEl.querySelector('.msg-del')) return;
  const btn = document.createElement('button');
  btn.className = 'msg-del';
  btn.title = '删除这条消息（仅从聊天记录移除）';
  btn.innerHTML = '&#10005;';
  btn.onclick = async (e) => {
    e.stopPropagation();
    const go = await _chatConfirm('删除这条消息？仅从聊天记录移除，不可恢复。', { danger: true, okText: '删除' });
    if (!go) return;
    try {
      const r = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/messages/${encodeURIComponent(msgEl.dataset.msgId)}`), { method: 'DELETE' });
      if (r.ok) {
        msgEl.remove();  // server also broadcasts chat_msg_deleted; removal is idempotent
      } else {
        const err = await r.json().catch(() => null);
        _chatAlert('删除失败：' + ((err && err.error) || r.status), { danger: true });
      }
    } catch (err) {
      _chatAlert('删除失败：' + err.message, { danger: true });
    }
  };
  msgEl.appendChild(btn);
}

// ── Per-message fork (Happier-parity: branch a session at any message) ──
// Forks the current session at the hovered message: the server creates a new
// session that replays the transcript up to (and including) this message as its
// starting context, copies the source's distilled memory, and inherits the same
// provider/model/effort/rolePrompt. The new session opens in a new tab so the
// user keeps their place in the original.
function attachForkButton(msgEl) {
  if (!msgEl || !msgEl.dataset.msgId || msgEl.querySelector('.msg-fork')) return;
  // Only fork from non-system messages (forking at the synthetic forkedFrom
  // meta message of an already-forked session is meaningless).
  if (msgEl.classList.contains('system')) return;
  const btn = document.createElement('button');
  btn.className = 'msg-fork';
  btn.title = '从此处分叉出新会话（保留到该点的上下文与记忆）';
  btn.innerHTML = '&#9741;';   // ⧉ branch symbol
  btn.onclick = async (e) => {
    e.stopPropagation();
    const prompt = '从此条消息处分叉出新会话？\n新会话将继承到该点的对话上下文与会话记忆，并在新标签页打开。';
    const go = await _chatConfirm(prompt, { okText: '分叉' });
    if (!go) return;
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '…';
    try {
      const r = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/fork`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ atMessageId: msgEl.dataset.msgId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      const newId = d.sessionId;
      const n = d.replayedMessages || 0;
      // Open the forked session's chat page in a new tab; keep the original open.
      const url = `${location.pathname}?session=${encodeURIComponent(newId)}${location.hash}`;
      window.open(url, '_blank');
      // Lightweight in-place toast via the existing debug-log channel.
      dbg('chat', `已分叉: ${newId} (replay ${n} 条) → 新标签页已打开`);
    } catch (err) {
      _chatAlert('分叉失败：' + err.message, { danger: true });
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  };
  msgEl.appendChild(btn);
}

// Attach (or refresh) the usage line on a given assistant bubble element.
function attachUsageLine(bubbleEl, usage, roleBreakdown) {
  if (!bubbleEl) return;
  const ce = bubbleEl.querySelector('.msg-content');
  if (!ce) return;
  const old = ce.querySelector('.msg-usage');
  if (old) old.remove();
  const line = buildUsageLine(usage, roleBreakdown);
  if (line) ce.appendChild(line);
}

function renderCurrentText(final = false) {
  if (!currentMsgEl) return;
  const contentEl = currentMsgEl.querySelector('.msg-content');
  if (!contentEl) return;

  // Detach the tool stack so it survives the innerHTML rebuild below, then
  // re-append it after the text so cards keep their place (and scroll state).
  const toolStack = contentEl.querySelector('.tool-stack');
  let html = '';
  if (currentTextContent.trim()) {
    html = renderMarkdown(currentTextContent);
  }

  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  contentEl.innerHTML = '';
  while (tmp.firstChild) contentEl.appendChild(tmp.firstChild);
  fixupLocalImages(contentEl);
  if (toolStack) contentEl.appendChild(toolStack);

  if (!final && isStreaming) {
    contentEl.classList.add('streaming-dot');
  } else {
    contentEl.classList.remove('streaming-dot');
  }

  if (final) {
    highlightCodeBlocks(contentEl);
  }
}

function highlightCodeBlocks(root) {
  const highlighter = window.hljs;
  if (!highlighter || typeof highlighter.highlightElement !== 'function') return;
  root.querySelectorAll('pre code').forEach(block => {
    try { highlighter.highlightElement(block); } catch (_) {}
  });
}

// Tool cards never go straight into .msg-content; they live in a single
// bounded, scrollable .tool-stack so a long tool run stays contained.
function getToolStack(contentEl) {
  let stack = contentEl.querySelector('.tool-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'tool-stack';
    contentEl.appendChild(stack);
  }
  return stack;
}

// Append a tool card into the turn's stack and keep the stack pinned to its
// latest entry (without scrolling the whole chat).
function appendToolCard(contentEl, card) {
  const stack = getToolStack(contentEl);
  stack.appendChild(card);
  stack.scrollTop = stack.scrollHeight;
}

function createToolCard(name, id) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.dataset.toolId = id;
  const icons = { Bash:'>',Read:'&#128196;',Edit:'&#9998;',Write:'&#128190;',Glob:'&#128269;',Grep:'&#128270;',Agent:'&#129302;' };
  card.innerHTML =
    `<div class="tool-header">` +
      `<span class="tool-icon">${icons[name]||'&#9881;'}</span>` +
      `<span class="tool-name">${escHtml(name)}</span>` +
      `<span class="tool-desc">running...</span>` +
      `<span class="tool-arrow">&#9654;</span>` +
    `</div>` +
    `<div class="tool-body"><pre class="tool-input"></pre></div>`;
  card.querySelector('.tool-header').onclick = () => card.classList.toggle('open');
  return card;
}

function updateToolInput(tc) {
  const pre = tc.card.querySelector('.tool-input');
  if (!pre) return;
  try {
    const parsed = JSON.parse(tc.inputJson);
    const desc = parsed.description || parsed.command || parsed.pattern || parsed.file_path || '';
    if (desc) tc.card.querySelector('.tool-desc').textContent = truncate(desc, 60);
    pre.textContent = JSON.stringify(parsed, null, 2);
  } catch (_) {
    pre.textContent = tc.inputJson;
  }
}

function addToolResult(tc, text, isError) {
  const body = tc.card.querySelector('.tool-body');
  if (!body) return;
  const label = document.createElement('div');
  label.className = 'tool-result-label' + (isError ? ' error' : '');
  label.textContent = isError ? 'Error:' : 'Result:';
  body.appendChild(label);
  const pre = document.createElement('pre');
  pre.textContent = truncate(text, 2000);
  body.appendChild(pre);
  tc.card.querySelector('.tool-desc').textContent = isError ? 'failed' : 'done';
}

let _lastUserBubble = null;  // the most recent user message bubble (holds the per-turn auto-commit checkbox)
function addUserMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg user';
  div.textContent = text;
  messagesEl.appendChild(div);
  // Per-message auto-commit checkbox lives under the user's own message.
  attachAutoCommitCheck(div, _sessionAutoCommit);
  _lastUserBubble = div;
  scrollToBottom();
  return div;
}

function addAgentNotes(notes) {
  const div = document.createElement('div');
  div.className = 'msg system-msg';
  div.style.cssText = 'background:rgba(210,153,34,.12);border:1px solid rgba(210,153,34,.4);' +
    'color:#d29922;border-radius:6px;padding:6px 10px;font-size:12px;text-align:left;align-self:stretch;';
  const lines = notes.map(n => `📨 来自「${n.from}」：${n.body}`).join('\n');
  div.textContent = '已注入跨 agent 留言到本轮上下文：\n' + lines;
  div.style.whiteSpace = 'pre-wrap';
  messagesEl.appendChild(div);
  scrollToBottom();
}

function addSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg system-msg';
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
}

function showDisconnectBanner(secs) {
  if (!_disconnectBannerEl) {
    _disconnectBannerEl = document.createElement('div');
    _disconnectBannerEl.className = 'msg system-msg disconnect-banner';
    _disconnectBannerEl.onclick = () => { _reconnectAttempt = 0; connect(); };
    messagesEl.appendChild(_disconnectBannerEl);
  }
  _disconnectBannerEl.textContent = `⚠️ 连接断开，${secs}s 后自动重连（点此立即重试）`;
  scrollToBottom();
}

/* ── Replay saved history ── */
function replayHistory(messages, serverTokenUsage) {
  if (!messages || !messages.length) {
    // Even without messages, serverTokenUsage may carry accumulated totals
    // from token_usage.json (e.g. all chat_history entries were trimmed).
    if (serverTokenUsage) {
      _sessionTokens = { input: serverTokenUsage.inputTokens || 0, output: serverTokenUsage.outputTokens || 0 };
      updateContextBar();
    }
    return;
  }
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    try {
    if (m.role === 'user') {
      const div = addUserMsg(m.content);
      if (m.id) { div.dataset.msgId = m.id; attachDeleteButton(div); attachForkButton(div); }
    } else if (m.role === 'assistant') {
      const div = document.createElement('div');
      div.className = 'msg assistant';
      const contentEl = document.createElement('div');
      contentEl.className = 'msg-content';

      // Render text as markdown
      if (m.content?.trim()) {
        contentEl.innerHTML = renderMarkdown(m.content);
        fixupLocalImages(contentEl);
        highlightCodeBlocks(contentEl);
      }

      // Render tool calls as collapsed cards inside a bounded scroll stack
      if (m.tools?.length) {
        const stack = getToolStack(contentEl);
        for (const tc of m.tools) {
          const card = document.createElement('div');
          card.className = 'tool-card';
          const icons = { Bash:'>',Read:'&#128196;',Edit:'&#9998;',Write:'&#128190;',Glob:'&#128269;',Grep:'&#128270;',Agent:'&#129302;' };
          const desc = tc.input?.description || tc.input?.command || tc.input?.pattern || tc.input?.file_path || '';
          const status = tc.is_error ? 'failed' : (tc.result !== undefined ? 'done' : '?');
          card.innerHTML =
            `<div class="tool-header">` +
              `<span class="tool-icon">${icons[tc.name]||'&#9881;'}</span>` +
              `<span class="tool-name">${escHtml(tc.name)}</span>` +
              `<span class="tool-desc">${escHtml(truncate(desc, 60) || status)}</span>` +
              `<span class="tool-arrow">&#9654;</span>` +
            `</div>` +
            `<div class="tool-body">` +
              `<pre class="tool-input">${escHtml(JSON.stringify(tc.input, null, 2))}</pre>` +
              (tc.result !== undefined ?
                `<div class="tool-result-label${tc.is_error ? ' error' : ''}">${tc.is_error ? 'Error:' : 'Result:'}</div>` +
                `<pre>${escHtml(tc.result)}</pre>` : '') +
            `</div>`;
          card.querySelector('.tool-header').onclick = () => card.classList.toggle('open');
          stack.appendChild(card);
        }
      }

      // Cancelled / cost indicator
      if (m.cancelled) {
        const tag = document.createElement('div');
        tag.className = 'msg system-msg';
        tag.style.cssText = 'font-size:11px;color:#f85149;padding:2px 0;';
        tag.textContent = '(cancelled)';
        contentEl.appendChild(tag);
      }

      // Per-message token usage line (input / output / cache read / cache write)
      if (m.usage) {
        const usageLine = buildUsageLine(m.usage);
        if (usageLine) contentEl.appendChild(usageLine);
      }

      // Per-message timing: reply clock time + interaction latency.
      if (m.role === 'assistant') {
        const timing = buildTimingLine(m);
        if (timing) contentEl.appendChild(timing);
      }

      div.appendChild(contentEl);
      messagesEl.appendChild(div);
      // In-progress replay tails (streaming:true) carry no id — not deletable yet.
      if (m.id) { div.dataset.msgId = m.id; attachDeleteButton(div); attachForkButton(div); }
    }
    } catch (err) {
      console.warn('[multicc] replayHistory: skipped message', mi, err.message);
    }
  }
  // Compute cumulative session token usage.
  // Prefer the server's authoritative accumulator (token_usage.json) which
  // never gets trimmed. Fall back to summing from chat_history messages.
  if (serverTokenUsage) {
    _sessionTokens = { input: serverTokenUsage.inputTokens || 0, output: serverTokenUsage.outputTokens || 0 };
  } else {
    _sessionTokens = { input: 0, output: 0 };
    for (const m of messages) {
      if (m.usage && m.role === 'assistant') {
        _sessionTokens.input += m.usage.input_tokens || 0;
        _sessionTokens.output += m.usage.output_tokens || 0;
      }
    }
  }
  // "本轮" = the LAST turn's context window size, NOT the session total.
  // Reconstruct it from the most recent assistant message's full usage
  // (input + output + cache), mirroring how live stream_event usage is computed.
  // Without this, _usedTokens stays 0 on reload and "本轮" disappears.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.usage) {
      const u = m.usage;
      _usedTokens = (u.input_tokens || 0) + (u.output_tokens || 0) +
        (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      break;
    }
  }
  // Rebuild context bar with latest session totals + last-turn context.
  if (_sessionTokens.input + _sessionTokens.output > 0) updateContextBar();

  // If the last message is an assistant message still streaming (e.g. WS
  // reconnected mid-turn), point currentMsgEl at its DOM element so the
  // stream replay events that follow will reuse this bubble instead of
  // creating a duplicate.
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant' && last.streaming) {
    const bubbles = messagesEl.querySelectorAll('.msg.assistant');
    if (bubbles.length > 0) {
      currentMsgEl = bubbles[bubbles.length - 1];
      currentTextContent = last.content || '';
    }
  }

  scrollToBottom();
  setTimeout(scrollToBottom, 300);
}

/* ── Thinking bubble ── */
let thinkingEl = null;

function showThinking() {
  if (thinkingEl) { dbg('think', 'showThinking() — 已在显示，忽略'); return; }
  thinkingEl = document.createElement('div');
  thinkingEl.className = 'thinking-bubble';
  thinkingEl.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div> Thinking...';
  messagesEl.appendChild(thinkingEl);
  scrollToBottom();
  dbg('think', 'showThinking() — 气泡已显示');
}

function hideThinking() {
  if (thinkingEl) {
    thinkingEl.remove();
    thinkingEl = null;
    dbg('think', 'hideThinking() — 气泡已移除');
  }
}

/* ── Send ── */
function newClientMsgId() {
  return 'c' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function send(opts = {}) {
  // opts may be a DOM Event (when bound directly as a handler) — only a plain
  // object with goal:true marks this as a Goal-mode send.
  const goalOpts = (opts && opts.goal === true) ? opts : null;
  let text = inputEl.value.trim();
  if (!text) return;

  // A new user message is a hard boundary. Codex can briefly leave a live
  // assistant bubble while the client-side streaming flag is already false,
  // so finalize any open bubble before appending the user's message.
  if (isStreaming || currentMsgEl) {
    hideThinking();
    isStreaming = false;
    finishStreaming();
    updateUI();
  }

  // Handle client-side slash commands
  if (text.startsWith('/')) {
    const cmd = text.split(/\s+/)[0].toLowerCase();
    if (cmd === '/clear') {
      // Clear chat UI and server history
      messagesEl.innerHTML = '';
      addSystemMsg('Chat cleared');
      inputEl.value = '';
      inputEl.style.height = 'auto';
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'clear_history' }));
      }
      return;
    }
    if (cmd === '/help') {
      addSystemMsg('Commands: /clear — clear chat history | /compact — ask Claude to compact context | /cost — show cost summary | /goal &lt;任务&gt; — 以 Goal 模式执行（受设置里的轮次/预算限制约束）');
      inputEl.value = '';
      inputEl.style.height = 'auto';
      return;
    }
    if (cmd === '/goal') {
      // Client-initiated Goal mode: wrap the task and re-send with the goal flag
      // so the server applies the configured round/budget limits.
      const sp = text.indexOf(' ');
      const task = sp === -1 ? '' : text.slice(sp + 1).trim();
      if (!task) {
        addSystemMsg('用法：/goal &lt;任务描述&gt; — 以 Goal 模式（目标驱动、自主执行到完成）发送，受设置里的轮次/预算限制约束。也可点输入框右侧 🎯 先做目标预检。');
        inputEl.value = '';
        inputEl.style.height = 'auto';
        return;
      }
      inputEl.value = goalWrap(task);
      inputEl.style.height = 'auto';
      send({ goal: true });   // limits omitted → server falls back to global config
      return;
    }
    // Other slash commands (like /compact, /cost) — pass through to Claude
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addSystemMsg('连接已断开，正在重连。请稍后再发送。');
    _reconnectAttempt = 0;
    connect();
    updateUI();
    return;
  }

  // Collect attachment paths
  const chips = attachArea.querySelectorAll('.attach-chip[data-path]');
  const paths = [];
  chips.forEach(c => { if (c.dataset.path) paths.push(c.dataset.path); c.remove(); });
  updateAttachArea();
  if (paths.length) text = text + ' ' + paths.join(' ');

  addUserMsg(text);
  inputEl.value = '';
  inputEl.style.height = 'auto';

  if (ws?.readyState === WebSocket.OPEN) {
    dbg('state', `send() — WS ▶ user_message (${text.length} chars)${goalOpts ? ' [goal]' : ''}`);
    try {
      const payload = { type: 'user_message', text, clientMsgId: newClientMsgId() };
      if (goalOpts) { payload.goal = true; payload.goalLimits = goalOpts.goalLimits || {}; }
      ws.send(JSON.stringify(payload));
      _pendingCancel = false;
      _turnStartMs = Date.now();  // client-side fallback for live reply timing
      isStreaming = true;
      showThinking();
      startTitleAnimation();
      dismissNotifyToast();
      updateUI();
    } catch (e) {
      addSystemMsg('发送失败，正在重连：' + e.message);
      inputEl.value = text;
      _reconnectAttempt = 0;
      connect();
      updateUI();
    }
  }
}

/* ── Cancel ── */
function cancelStreaming() {
  dbg('state', `cancelStreaming() — isStreaming=${isStreaming}`);
  // Always try to send cancel to server (idempotent on server side).
  // This avoids the race where a 'result' event sets isStreaming=false
  // right before the user's click is processed — we still want the
  // cancel signal to reach the server.
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'cancel' }));
    _pendingCancel = false;
  } else {
    // WS disconnected — remember the cancel intent so we can send it on reconnect
    _pendingCancel = true;
  }
  if (!isStreaming) return;
  hideThinking();
  isStreaming = false;
  finishStreaming();
  stopTitleAnimation();
  addSystemMsg('Cancelled');
  updateUI();
}

/* ── UI helpers ── */
function updateUI() {
  const connected = ws && ws.readyState === WebSocket.OPEN;
  // Always allow typing and sending — even during streaming (user may need to reply to a yes/no prompt)
  sendBtn.disabled = !connected;
  sendBtn.style.display = 'flex';
  cancelBtn.classList.toggle('show', isStreaming);
  inputEl.disabled = !connected;
}

function updateContextBar(usage, modelUsage) {
  // Extract context window from modelUsage if available
  if (modelUsage) {
    for (const key of Object.keys(modelUsage)) {
      if (modelUsage[key].contextWindow) _contextWindow = modelUsage[key].contextWindow;
    }
  }
  // Calculate used tokens for the current turn
  if (usage) {
    const input = usage.input_tokens || 0;
    const output = usage.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheCreate = usage.cache_creation_input_tokens || 0;
    _usedTokens = input + output + cacheRead + cacheCreate;
  }

  const parts = [];

  // ── Compact number formatter: 1234 → "1.2K", 1500000 → "1.5M" ──
  const fmt = n => n >= 1e6 ? (n/1e6).toFixed(1).replace(/\.0$/,'')+'M' : n >= 1e3 ? (n/1e3).toFixed(1).replace(/\.0$/,'')+'K' : String(n);
  const windowFmt = (w) => {
    if (!w || (w.inputTokens + w.outputTokens === 0)) return '';
    const i = fmt(w.inputTokens);
    const o = fmt(w.outputTokens);
    return `I:${i}/O:${o}`;
  };

  // ── Provider time-window stats ──
  if (_providerTokenWindows) {
    const pw = _providerTokenWindows;
    const label = _providerName || _providerId || 'Provider';
    const entries = [];
    if (pw.today) { const s = windowFmt(pw.today); if (s) entries.push(`日${s}`); }
    if (pw.week) { const s = windowFmt(pw.week); if (s) entries.push(`周${s}`); }
    if (pw.month) { const s = windowFmt(pw.month); if (s) entries.push(`月${s}`); }
    // Fallback: if daily data hasn't accumulated yet, show all-time total.
    // Prefixed 总 so it's clear this is lifetime, not today's, usage.
    if (!entries.length && pw.all) {
      const s = windowFmt(pw.all);
      if (s) entries.push(`总${s}`);
    }
    if (entries.length) {
      parts.push(`<span style="margin-right:10px;color:var(--amber);font-size:11px">[${escHtml(label)}] ${entries.join(' ')}</span>`);
    }
  }

  // ── Cost text (USD) ──
  if (_costText) parts.push(`<span style="margin-right:10px">${escHtml(_costText)}</span>`);

  // ── Session cumulative tokens ──
  const total = _sessionTokens.input + _sessionTokens.output;
  if (total > 0) {
    parts.push(`<span style="margin-right:10px;color:var(--faint);font-size:11px">会话累计 ${fmt(total)} tokens（in ${fmt(_sessionTokens.input)} / out ${fmt(_sessionTokens.output)}）</span>`);
  }

  // ── Current-turn context ──
  if (_usedTokens > 0) {
    const pct = Math.min(100, (_usedTokens / _contextWindow) * 100);
    const color = pct > 80 ? '#f85149' : pct > 50 ? '#d29922' : '#3fb950';
    const usedK = (_usedTokens / 1000).toFixed(1);
    const totalK = (_contextWindow / 1000).toFixed(0);
    parts.push(`<span style="font-size:11px;color:${color}">本轮 ${usedK}k/${totalK}k (${pct.toFixed(1)}%)</span>`);
    parts.push(`<span style="display:inline-block;width:60px;height:5px;background:#21262d;border-radius:3px;margin-left:4px;vertical-align:middle;"><span style="display:block;width:${pct}%;height:100%;background:${color};border-radius:3px;"></span></span>`);
  }
  if (parts.length) costBar.innerHTML = parts.join('');
}

function scrollToBottom() {
  requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '...' : s;
}

/* ── Auto-resize textarea ── */
let _lastTypingSent = 0;
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  // Notify server that user is typing (throttled: max once per 3s)
  if (ws && ws.readyState === WebSocket.OPEN && Date.now() - _lastTypingSent > 3000) {
    ws.send(JSON.stringify({ type: 'typing' }));
    _lastTypingSent = Date.now();
  }
});

// Desktop: Enter sends, Shift+Enter newline
// Mobile: use send button (Enter inserts newline for IME compatibility)
const _isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || window.innerWidth <= 768;

inputEl.addEventListener('keydown', (e) => {
  if (!_isMobile && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});

// Send button — works on both mobile and desktop
let _lastSendTapAt = 0;
function sendFromButton(e) {
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
  const now = Date.now();
  if (now - _lastSendTapAt < 600) return;
  _lastSendTapAt = now;
  send();
}
sendBtn.addEventListener('click', sendFromButton);
sendBtn.addEventListener('touchend', sendFromButton, { passive: false });

// Cancel button
let _lastCancelTapAt = 0;
function cancelFromButton(e) {
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
  const now = Date.now();
  if (now - _lastCancelTapAt < 600) return;
  _lastCancelTapAt = now;
  cancelStreaming();
}
cancelBtn.addEventListener('click', cancelFromButton);
cancelBtn.addEventListener('touchend', cancelFromButton, { passive: false });

function mergeStatusText(st) {
  if (!st || (!st.mergeReady && !(st.dirty || st.ahead > 0))) return tt('worktreeClean');
  // Dirty/ahead exist but merge is blocked — show why.
  if (!st.mergeReady && !st.baseCheckedOut) {
    return `Worktree has changes but cannot merge — ${st.baseBranch || 'main'} is not the active branch in the main directory.`;
  }
  const bits = [];
  if (st.dirty) bits.push(tt('dirtyChanges'));
  if ((st.ahead || 0) > 0) bits.push(tt('aheadCommits', { n: st.ahead }));
  return tt('worktreeMergeable', { detail: bits.join('，'), base: st.baseBranch || tt('defaultBase') });
}

function applyMergeStatus(st) {
  _mergeReady = !!(st && st.mergeReady);
  _syncConflict = !!(st && st.conflict);
  _syncConflictFiles = (st && st.conflictFiles) || [];
  if (mergeBtn) {
    mergeBtn.classList.toggle('merge-ready', _mergeReady);
    mergeBtn.title = _mergeReady ? mergeStatusText(st) : tt('mergeWorktreeTitle');
  }
  if (mergeHint) {
    mergeHint.classList.toggle('show', _mergeReady);
    const text = mergeHint.querySelector('.merge-hint-text');
    if (text) text.textContent = mergeStatusText(st);
  }
  applyBehindStatus(st);
}

// Persistent conflict banner: rendered while the worktree is parked mid-rebase
// after a conflicting sync. Stays put across refreshes (driven by merge state,
// not a one-shot toast) and offers in-place 继续 / 放弃 controls.
function applyConflictBanner(st) {
  let bar = document.getElementById('worktree-conflict-bar');
  const conflict = !!(st && st.conflict);
  if (!conflict) { if (bar) bar.remove(); return; }
  const files = (st && st.conflictFiles) || [];
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'worktree-conflict-bar';
    bar.className = 'worktree-conflict-bar';
    const anchor = document.getElementById('worktree-bar');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(bar, anchor.nextSibling);
    else document.body.insertBefore(bar, document.body.firstChild);
  }
  bar.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'conflict-label';
  label.textContent = `⚠️ 同步冲突：${files.length} 个文件待解决`;
  label.title = files.join('\n');
  const help = document.createElement('button');
  help.textContent = '如何解决';
  help.onclick = () => showConflictHelp(files);
  const cont = document.createElement('button');
  cont.className = 'conflict-continue';
  cont.textContent = '继续';
  cont.onclick = () => resolveRebase('continue');
  const abort = document.createElement('button');
  abort.className = 'conflict-abort';
  abort.textContent = '放弃';
  abort.onclick = () => resolveRebase('abort');
  bar.appendChild(label);
  bar.appendChild(help);
  bar.appendChild(cont);
  bar.appendChild(abort);
}

function showConflictHelp(files) {
  addSystemMsg(
    `同步与基分支冲突，rebase 已暂停。请按下面步骤手动解决：\n` +
    `冲突文件（${files.length}）：\n${files.map(f => '  · ' + f).join('\n') || '  (无)'}\n` +
    `1. 在本会话的 worktree 里编辑上述文件，消除 <<<<<<< / ======= / >>>>>>> 冲突标记\n` +
    `2. 解决后点横幅上的「继续」（= git add -A && git rebase --continue）\n` +
    `3. 想放弃本次同步、回到同步前状态，点「放弃」（= git rebase --abort）`);
}

// Continue or abort the parked rebase from the chat banner.
async function resolveRebase(action) {
  if (!_sessionName) { addSystemMsg('无 session id，无法操作 rebase'); return; }
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/rebase`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      if (data.aborted) addSystemMsg('✓ 已放弃 rebase，worktree 回到同步前状态');
      else if (data.done) addSystemMsg('✓ 冲突已解决，同步完成');
      else addSystemMsg('✓ rebase 已继续');
      refreshMergeStatus();
    } else if (res.status === 409 && data.conflicts) {
      addSystemMsg(`✗ 仍有冲突未解决：\n${data.conflicts.join(', ')}\n请全部解决后再点「继续」。`);
      refreshMergeStatus();
    } else {
      addSystemMsg(`✗ 操作失败：${data.error || res.status}`);
    }
  } catch (e) {
    addSystemMsg(`✗ 请求失败：${e.message}`);
  }
}

// Show the current worktree branch + a "behind base" warning at the top of the
// chat. Mirrors the Flutter app: a persistent banner while behind, plus a
// one-time system notice when it first goes (or falls further) behind.
function applyBehindStatus(st) {
  const behind = (st && Number(st.behind)) || 0;
  const branch = (st && st.branch) || '';
  const base = (st && st.baseBranch) || 'main';
  const bar = document.getElementById('worktree-bar');
  if (bar) {
    if (branch) {
      bar.classList.add('show');
      bar.classList.toggle('behind', behind > 0);
      const label = behind > 0
        ? tt('behindLabel', { branch, base, n: behind })
        : `⎇ ${branch}`;
      bar.innerHTML = '';
      const span = document.createElement('span');
      span.className = 'worktree-label';
      span.textContent = label;
      bar.appendChild(span);
      if (behind > 0) {
        const btn = document.createElement('button');
        btn.id = 'worktree-sync-btn';
        btn.textContent = tt('sync');
        btn.onclick = syncWorktree;
        bar.appendChild(btn);
      }
    } else {
      bar.classList.remove('show', 'behind');
      bar.innerHTML = '';
    }
  }
  if (behind > _lastWarnedBehind) {
    addSystemMsg(tt('behindBanner', { branch, base, n: behind }));
  }
  _lastWarnedBehind = behind;
  applyConflictBanner(st);
}

// One-click sync: pull the base branch into this session's worktree.
async function syncWorktree() {
  if (!_sessionName) { addSystemMsg('无 session id，无法同步'); return; }
  const btn = document.getElementById('worktree-sync-btn');
  if (btn) { btn.disabled = true; btn.textContent = tt('syncing'); }
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/sync`), { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      addSystemMsg(data.merged
        ? `✓ 已从 ${data.baseBranch || 'base'} 同步 ${data.commits} 个提交${data.committed ? '（已自动提交未保存改动）' : ''}`
        : (data.message || '已是最新'));
      refreshMergeStatus();
    } else if (res.status === 409 && data.conflicts) {
      addSystemMsg(`✗ 同步与基分支冲突，rebase 已暂停（worktree 处于冲突态）：\n${data.conflicts.join(', ')}\n请用上方横幅的「继续 / 放弃」处理，或在 worktree 手动解决。`);
      refreshMergeStatus();
    } else {
      addSystemMsg(`✗ 同步失败：${data.error || res.status}`);
    }
  } catch (e) {
    addSystemMsg(`✗ 同步请求失败：${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = tt('sync'); }
  }
}

async function refreshMergeStatus() {
  if (!_sessionName) return;
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/merge-status`));
    if (!res.ok) return;
    applyMergeStatus(await res.json());
  } catch (_) {}
}

function startMergeStatusPolling() {
  refreshMergeStatus();
  if (_mergePollTimer) clearInterval(_mergePollTimer);
  _mergePollTimer = setInterval(refreshMergeStatus, 5000);
}

/* ── Merge worktree button ── */
function confirmInPage(message) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:12000;background:#0009;display:flex;align-items:center;justify-content:center;padding:18px;';
    const card = document.createElement('div');
    card.style.cssText = 'width:min(92vw,420px);background:#0f1115;border:1px solid #30363d;border-radius:10px;box-shadow:0 18px 60px #000c;color:#e7eaee;overflow:hidden;';
    const title = document.createElement('div');
    title.textContent = '合并 worktree';
    title.style.cssText = 'padding:14px 16px;border-bottom:1px solid #20242b;font-size:15px;font-weight:700;color:#f2f4f7;';
    const body = document.createElement('div');
    body.textContent = message;
    body.style.cssText = 'padding:16px;white-space:pre-wrap;font-size:13px;line-height:1.55;color:#c9d1d9;';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid #20242b;';
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.style.cssText = 'border:1px solid #30363d;background:#161b22;color:#c9d1d9;border-radius:7px;padding:7px 13px;font-weight:700;cursor:pointer;';
    const ok = document.createElement('button');
    ok.textContent = '合并';
    ok.style.cssText = 'border:1px solid #58a6ff;background:#1f6feb;color:#fff;border-radius:7px;padding:7px 13px;font-weight:700;cursor:pointer;';
    const finish = (value) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter') finish(true);
    };
    cancel.onclick = () => finish(false);
    ok.onclick = () => finish(true);
    backdrop.onclick = (e) => { if (e.target === backdrop) finish(false); };
    document.addEventListener('keydown', onKey);
    actions.append(cancel, ok);
    card.append(title, body, actions);
    backdrop.append(card);
    document.body.append(backdrop);
    ok.focus();
  });
}

// Lightweight in-page text prompt (window.prompt is unreliable in WebViews).
// Resolves to the trimmed string, or null if cancelled.
function promptInPage(title, defaultValue) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:12000;background:#0009;display:flex;align-items:center;justify-content:center;padding:18px;';
    const card = document.createElement('div');
    card.style.cssText = 'width:min(92vw,440px);background:#0f1115;border:1px solid #30363d;border-radius:10px;box-shadow:0 18px 60px #000c;color:#e7eaee;overflow:hidden;';
    const head = document.createElement('div');
    head.textContent = title;
    head.style.cssText = 'padding:14px 16px;border-bottom:1px solid #20242b;font-size:15px;font-weight:700;color:#f2f4f7;';
    const body = document.createElement('div');
    body.style.cssText = 'padding:16px;';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaultValue || '';
    input.maxLength = 80;
    input.style.cssText = 'width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:7px;padding:9px 11px;font-size:14px;color:#e7eaee;outline:none;';
    input.placeholder = '会话别名（留空则重置为 id）';
    body.append(input);
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid #20242b;';
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.style.cssText = 'border:1px solid #30363d;background:#161b22;color:#c9d1d9;border-radius:7px;padding:7px 13px;font-weight:700;cursor:pointer;';
    const ok = document.createElement('button');
    ok.textContent = '保存';
    ok.style.cssText = 'border:1px solid #58a6ff;background:#1f6feb;color:#fff;border-radius:7px;padding:7px 13px;font-weight:700;cursor:pointer;';
    const finish = (value) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      else if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim()); }
    };
    cancel.onclick = () => finish(null);
    ok.onclick = () => finish(input.value.trim());
    backdrop.onclick = (e) => { if (e.target === backdrop) finish(null); };
    document.addEventListener('keydown', onKey);
    actions.append(cancel, ok);
    card.append(head, body, actions);
    backdrop.append(card);
    document.body.append(backdrop);
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

// Double-click the header session title to rename it.
async function renameSessionFromChat() {
  if (!_sessionName) { addSystemMsg('无 session id，无法改名'); return; }
  let current = _sessionName;
  try {
    const r = await fetch(withToken('/api/sessions'));
    const arr = (await r.json()) || [];
    const list = Array.isArray(arr) ? arr : (arr.sessions || []);
    const s = list.find(x => x.id === _sessionName);
    if (s && s.label) current = s.label;
  } catch (_) {}
  const next = await promptInPage('重命名会话', current);
  if (next === null) return;
  if (next.length > 80) { addSystemMsg('名称过长（最多 80 字符）'); return; }
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: next }),
    });
    const data = await res.json();
    if (!res.ok) { addSystemMsg('改名失败：' + (data.error || `HTTP ${res.status}`)); return; }
    addSystemMsg(next ? `✓ 会话已改名为 ${next}` : '✓ 会话名称已重置');
    await loadSessionIdentity();
  } catch (e) {
    addSystemMsg('改名失败：' + e.message);
  }
}

async function requestMerge() {
  if (!_sessionName) { addSystemMsg('无 session id，无法合并 worktree'); return; }
  const prompt = _mergeReady
    ? tt('mergeWorktreeConfirmReady')
    : tt('mergeWorktreeConfirm');
  if (!await confirmInPage(prompt)) return;
  addSystemMsg('正在合并 worktree...');
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/merge`), { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      addSystemMsg(data.merged
        ? `✓ 已合并 ${data.commits} 个提交回基分支${data.committed ? '（含本次自动提交）' : ''}${data.syncedBack ? '，并已自动把基分支同步回本 worktree' : ''}`
        : `✓ ${data.message || '没有新提交需要合并'}`);
      applyMergeStatus({ mergeReady: false, dirty: false, ahead: 0 });
      // Auto-sync may have changed the behind count — re-fetch real state.
      refreshMergeStatus();
    } else if (res.status === 409) {
      addSystemMsg('⚠️ 合并冲突，已 abort，基分支未改动。冲突文件：' + (data.conflicts || []).join(', '));
      addSystemMsg('请打开一个该Fleet的终端会话手动解决冲突。');
    } else {
      addSystemMsg('合并失败：' + (data.error || `HTTP ${res.status}`));
    }
  } catch (e) {
    addSystemMsg('合并请求失败：' + e.message);
  }
}

mergeBtn?.addEventListener('click', requestMerge);
mergeHintBtn?.addEventListener('click', requestMerge);

/* ── Auto-commit after task completion ── */
// Called after an assistant turn completes. If the per-message auto-commit
// checkbox is checked and the worktree has mergeable changes, silently
// trigger commit + merge.
let _autoCommitPending = false;  // prevent duplicate auto-commits
async function autoCommitIfNeeded(bubbleEl) {
  if (!bubbleEl || _autoCommitPending) return;
  const row = bubbleEl.querySelector('.msg-auto-commit');
  if (!row || row.classList.contains('done')) return;
  const cb = row.querySelector('input[type="checkbox"]');
  if (!cb || !cb.checked) return;
  // Check if there's actually something to merge
  if (!_mergeReady) return;
  _autoCommitPending = true;
  try {
    addSystemMsg('🚀 自动提交合并中（此轮开启了自动提交）...');
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/merge`), { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      addSystemMsg(data.merged
        ? `✓ 自动提交完成：已合并 ${data.commits} 个提交回基分支${data.committed ? '（含本次自动提交）' : ''}${data.syncedBack ? '，并已自动把基分支同步回本 worktree' : ''}`
        : `✓ 自动提交：${data.message || '没有新提交需要合并'}`);
      // Mark the checkbox as done
      row.classList.add('done');
      applyMergeStatus({ mergeReady: false, dirty: false, ahead: 0 });
      refreshMergeStatus();
    } else if (res.status === 409) {
      addSystemMsg('⚠️ 自动提交冲突，已 abort。冲突文件：' + (data.conflicts || []).join(', '));
    } else {
      addSystemMsg('自动提交失败：' + (data.error || `HTTP ${res.status}`));
    }
  } catch (e) {
    addSystemMsg('自动提交请求失败：' + e.message);
  } finally {
    _autoCommitPending = false;
  }
}

/* ── Diff viewer ── */
function escapeDiffHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    const safe = escapeDiffHtml(raw);
    parts.push(`<span class="${cls}">${safe || '&nbsp;'}</span>`);
  }
  if (truncated) {
    parts.push(`<span class="diff-line diff-meta">… 行数过多已截断（${lines.length - MAX_LINES} 行省略）</span>`);
  }
  return parts.join('');
}

async function showDiff() {
  if (!_sessionName) { addSystemMsg('无 session id，无法查看 diff'); return; }
  const modal = document.getElementById('diff-modal');
  const titleEl = document.getElementById('diff-title');
  const subEl = document.getElementById('diff-subtitle');
  const statEl = document.getElementById('diff-stat');
  const contentEl = document.getElementById('diff-content');
  if (!modal) return;
  titleEl.textContent = `Diff · ${_sessionName}`;
  subEl.textContent = '加载中…';
  statEl.textContent = '';
  contentEl.innerHTML = '';
  modal.classList.add('open');
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/diff`));
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
  if (modal) modal.classList.remove('open');
}

document.getElementById('merge-hint-diff-btn')?.addEventListener('click', showDiff);
document.getElementById('diff-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'diff-modal') closeDiffModal();
});

startMergeStatusPolling();

/* ── Per-session model switch ── */
const modelBtn = document.getElementById('model-btn');
// CLAUDE_MODEL_OPTIONS + modelShortName live in shared/models.js (loaded before chat.js).
let _sessionModel = '';        // raw per-session override (null/'' = follow default)
let _sessionEffectiveModel = ''; // model actually used at spawn time (for display)
const effortBtn = document.getElementById('effort-btn');
const EFFORT_OPTIONS = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
  { value: 'ultracode', label: 'ultracode' },
];
const CODEX_REASONING_OPTIONS = [
  { value: 'low', label: 'Low', desc: 'Fast responses with lighter reasoning' },
  { value: 'medium', label: 'Medium', desc: 'Balances speed and reasoning depth for everyday tasks' },
  { value: 'high', label: 'High', desc: 'Greater reasoning depth for complex problems' },
  { value: 'xhigh', label: 'Extra high', desc: 'Extra high reasoning depth for complex problems' },
];
let _sessionEffort = '';
let _sessionEffectiveEffort = 'medium';

function defaultEffortForCurrentCli() {
  return _sessionCli === 'codex' ? 'xhigh' : 'medium';
}

function updateModelBtn() {
  if (!modelBtn) return;
  const shown = _sessionEffectiveModel || _sessionModel;
  const provider = _sessionProviderDisplayName
    || (_sessionProvider ? providerShortName(_sessionProvider) : '')
    || tt('default');
  const model = shown ? modelDisplayName(shown, _sessionProvider) : tt('default');
  const effort = effortShortName(_sessionEffectiveEffort || _sessionEffort);
  modelBtn.textContent = `🧠 ${provider} | ${model} | ${effort}`;
  modelBtn.style.display = '';
}

function effortShortName(effort) {
  const v = effort || defaultEffortForCurrentCli();
  if (_sessionCli === 'codex') {
    if (v === 'xhigh') return 'Extra high';
    if (v === 'low') return 'Low';
    if (v === 'medium') return 'Medium';
    if (v === 'high') return 'High';
  }
  return v;
}

function updateEffortBtn() {
  if (!effortBtn) return;
  effortBtn.style.display = 'none';
  updateModelBtn();
}

function showEffortPicker(current) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:380px;max-width:94vw;color:#c9d1d9;';
    box.innerHTML = `
      <div style="font-size:15px;font-weight:600;margin-bottom:8px;">选择努力程度（下一轮生效）</div>
      <div style="font-size:12px;color:#8b949e;line-height:1.5;margin-bottom:12px;">Claude 支持 low / medium / high / xhigh / max。ultracode 会向 Claude 传 xhigh，并启用 MultiCC 跨会话 workflow 编排。</div>
      <select id="effort-select" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:14px;">
        ${EFFORT_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
      </select>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="effort-cancel" style="background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:6px 14px;cursor:pointer;">取消</button>
        <button id="effort-ok" style="background:#238636;border:1px solid #2ea043;border-radius:6px;color:#fff;font-size:13px;padding:6px 14px;cursor:pointer;">保存</button>
      </div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const select = box.querySelector('#effort-select');
    select.value = EFFORT_OPTIONS.some(o => o.value === current) ? current : defaultEffortForCurrentCli();
    const close = (r) => { overlay.remove(); resolve(r); };
    box.querySelector('#effort-ok').onclick = () => close(select.value);
    box.querySelector('#effort-cancel').onclick = () => close(null);
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
  });
}

function providerModelOptions(providerId) {
  const effectiveProviderId = effectiveProviderIdForChoices(providerId);
  if (!effectiveProviderId) return [];
  const p = _providerList.find(o => o.id === effectiveProviderId);
  return (p && Array.isArray(p.modelOptions)) ? p.modelOptions.filter(Boolean) : [];
}

// Alias↔model mapping for the selected provider (alias-only relays declare one
// model per tier, e.g. iFlytek opus/sonnet/haiku/fable → astron-code-latest).
// Returned shape matches the server summary: { opus:{model,name}, sonnet:{...}, ... }.
function providerAliasMap(providerId) {
  const effectiveProviderId = effectiveProviderIdForChoices(providerId);
  if (!effectiveProviderId) return null;
  const p = _providerList.find(o => o.id === effectiveProviderId);
  if (!p || !p.aliasMap) return null;
  const entries = Object.entries(p.aliasMap).filter(([, v]) => v && v.model);
  return entries.length ? Object.fromEntries(entries) : null;
}

// Ordered alias tiers [tier, {model,name}] for an alias-mapped relay, or [].
// Each tier is a real, selectable wire model on these relays (the server honors
// session.model === opus/sonnet/haiku/fable directly).
function providerAliasTiers(providerId) {
  return aliasTiersFromMap(providerAliasMap(providerId));
}

// Map a stored wire model id (e.g. claude-opus-4-8) back to its alias tier so the
// tier dropdown pre-selects instead of dropping into the custom-id field.
function normalizeModelForProvider(providerId, model) {
  if (!model) return model;
  for (const [t, m] of providerAliasTiers(providerId)) {
    if (t === model) return model;
    if (m.model === model) return t;
  }
  return model;
}

function buildModelChoices(providerId) {
  // Alias-mapped relays: offer the tiers directly so each option can read
  // "opus · GLM5.2 · glm-5.2" (别名 - 展示名 - 真实id).
  const tiers = providerAliasTiers(providerId);
  if (tiers.length) return ['', ...tiers.map(([t]) => t), '__custom__'];
  const opts = providerModelOptions(providerId);
  if (opts.length) return ['', ...opts, '__custom__'];
  if (_sessionCli === 'claude') return CLAUDE_MODEL_OPTIONS.map(o => o.value);
  return ['', '__custom__'];
}

function modelChoiceLabel(v, providerId) {
  // Alias tier option: "opus · GLM5.2 · glm-5.2" (别名 - 展示名 - 真实id).
  const map = providerAliasMap(providerId);
  if (map && map[v] && map[v].model) {
    const m = map[v];
    return formatAliasTierLabel(v, m);
  }
  if (v === '') return _sessionCli === 'codex' ? '默认（跟随 Provider）' : tt('default');
  const named = CLAUDE_MODEL_OPTIONS.find(o => o.value === v);
  if (named) return named.labelKey ? tt(named.labelKey) : named.label;
  if (v === '__custom__') return tt('custom');
  return v;
}

// Display name for the model chip: prefer an alias-mapped relay's real model
// name (e.g. GLM5.2), given either a tier key or a wire id it maps to.
function modelDisplayName(model, providerId) {
  if (!model) return model;
  const map = providerAliasMap(providerId);
  if (map) {
    if (map[model]) {
      const e = map[model];
      if (e.name) return e.name;     // 显示名优先（如 GLM5.2）
      if (e.model) return e.model;   // 否则用映射的真模型 id（如 glm-5.2），不回退到 tier 别名 opus
    }
    for (const v of Object.values(map)) {
      if (v && v.model === model) return v.name || model;
    }
  }
  return modelShortName(model);
}

function showAIConfigPicker({ provider, model, effort, subagent }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:480px;max-width:94vw;color:#c9d1d9;';
    box.innerHTML = `
      <div style="font-size:15px;font-weight:600;margin-bottom:8px;">AI 配置（下一轮生效）</div>
      <div style="font-size:12px;color:#8b949e;line-height:1.5;margin-bottom:12px;">Provider、Model、${_sessionCli === 'codex' ? 'Reasoning Level' : 'Effort'} 会一起保存。切换 Provider 后，Model 选项会按该 Provider 的可用模型联动更新。</div>
      <label style="display:block;font-size:12px;color:#8b949e;margin-bottom:5px;">Provider</label>
      <select id="ai-provider" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;"></select>
      <label style="display:block;font-size:12px;color:#8b949e;margin-bottom:5px;">Model</label>
      <select id="ai-model" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:8px;"></select>
      <input id="ai-model-custom" type="text" placeholder="模型 ID" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;display:none;">
      <label id="ai-effort-label" style="display:block;font-size:12px;color:#8b949e;margin-bottom:5px;">${_sessionCli === 'codex' ? 'Reasoning Level' : 'Effort'}</label>
      <select id="ai-effort" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:14px;"></select>
      <div style="height:1px;background:#30363d;margin:4px 0 14px;"></div>
      <div style="font-size:13px;font-weight:600;margin-bottom:2px;">子任务 (subagent)</div>
      <div style="font-size:11px;color:#8b949e;line-height:1.45;margin-bottom:10px;">Task 工具派生的子 agent 走的 provider+model（经 claude-proxy 路由，与主进程隔离）。留空=随主。</div>
      <label style="display:block;font-size:12px;color:#8b949e;margin-bottom:5px;">子任务 Provider</label>
      <select id="ai-sub-provider" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:10px;"></select>
      <label style="display:block;font-size:12px;color:#8b949e;margin-bottom:5px;">子任务 Model</label>
      <select id="ai-sub-model" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:6px;"></select>
      <input id="ai-sub-model-custom" type="text" placeholder="模型 ID" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:14px;display:none;">
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="ai-cancel" style="background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:6px 14px;cursor:pointer;">取消</button>
        <button id="ai-ok" style="background:#238636;border:1px solid #2ea043;border-radius:6px;color:#fff;font-size:13px;padding:6px 14px;cursor:pointer;">保存</button>
      </div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const providerSel = box.querySelector('#ai-provider');
    const modelSel = box.querySelector('#ai-model');
    const custom = box.querySelector('#ai-model-custom');
    const effortSel = box.querySelector('#ai-effort');
    const effortLabel = box.querySelector('#ai-effort-label');

    const providerDefault = document.createElement('option');
    providerDefault.value = '';
    providerDefault.textContent = tt('providerDefault');
    providerSel.appendChild(providerDefault);
    for (const p of _providerList) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name + (p.isOfficial ? ' · 订阅' : (p.baseUrl ? ' · ' + p.baseUrl.replace(/^https?:\/\//, '') : '')) + (p.model ? ' · ' + p.model : '');
      providerSel.appendChild(opt);
    }
    providerSel.value = provider || '';

    const effortOptions = _sessionCli === 'codex' ? CODEX_REASONING_OPTIONS : EFFORT_OPTIONS;
    for (const o of effortOptions) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.desc ? `${o.label} — ${o.desc}` : o.label;
      effortSel.appendChild(opt);
    }
    effortSel.value = effortOptions.some(o => o.value === effort) ? effort : defaultEffortForCurrentCli();

    // ── 子任务 (subagent) provider+model cascade — reuses the main helpers ──
    const subProviderSel = box.querySelector('#ai-sub-provider');
    const subModelSel = box.querySelector('#ai-sub-model');
    const subCustom = box.querySelector('#ai-sub-model-custom');
    const subDef = document.createElement('option');
    subDef.value = ''; subDef.textContent = '默认（随主）';
    subProviderSel.appendChild(subDef);
    for (const p of _providerList) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name + (p.isOfficial ? ' · 订阅' : (p.baseUrl ? ' · ' + p.baseUrl.replace(/^https?:\/\//, '') : ''));
      subProviderSel.appendChild(opt);
    }
    const initSub = subagent && subagent.providerId ? subagent : null;
    subProviderSel.value = initSub ? initSub.providerId : '';
    function syncSubCustom() { subCustom.style.display = subModelSel.value === '__custom__' ? '' : 'none'; }
    function rebuildSubModels(pid, pref) {
      pref = normalizeModelForProvider(pid, pref || '');
      const choices = buildModelChoices(pid);
      subModelSel.innerHTML = '';
      for (const v of choices) { const o = document.createElement('option'); o.value = v; o.textContent = modelChoiceLabel(v, pid); subModelSel.appendChild(o); }
      const isKnown = choices.includes(pref);
      subModelSel.value = isKnown ? pref : '__custom__';
      subCustom.value = isKnown ? '' : pref;
      syncSubCustom();
    }
    function refreshSubUI() {
      const pid = subProviderSel.value;
      subModelSel.disabled = !pid; subCustom.disabled = !pid;
      if (pid) rebuildSubModels(pid, initSub ? initSub.model : '');
      else { subModelSel.innerHTML = '<option value="">（随主）</option>'; subModelSel.value = ''; syncSubCustom(); }
    }
    refreshSubUI();
    subProviderSel.onchange = refreshSubUI;
    subModelSel.onchange = () => { syncSubCustom(); if (subModelSel.value === '__custom__') subCustom.focus(); };

    function rebuildModels(nextProvider, preferredModel) {
      // For alias-mapped relays a stored wire id (claude-opus-4-8) maps back to
      // its tier so the tier option pre-selects.
      preferredModel = normalizeModelForProvider(nextProvider, preferredModel || '');
      const choices = buildModelChoices(nextProvider);
      modelSel.innerHTML = '';
      for (const v of choices) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = modelChoiceLabel(v, nextProvider);
        modelSel.appendChild(opt);
      }
      const isKnown = choices.includes(preferredModel);
      modelSel.value = isKnown ? preferredModel : '__custom__';
      custom.value = isKnown ? '' : preferredModel;
      syncCustom();
    }
    function syncCustom() {
      custom.style.display = modelSel.value === '__custom__' ? '' : 'none';
    }

    rebuildModels(providerSel.value, model || '');
    providerSel.onchange = () => rebuildModels(providerSel.value, '');
    modelSel.onchange = () => { syncCustom(); if (modelSel.value === '__custom__') custom.focus(); };

    const close = (r) => { overlay.remove(); resolve(r); };
    box.querySelector('#ai-ok').onclick = () => {
      const pickedModel = modelSel.value === '__custom__' ? custom.value.trim() : modelSel.value;
      const subPid = subProviderSel.value;
      const subModel = subPid ? (subModelSel.value === '__custom__' ? subCustom.value.trim() : subModelSel.value) : '';
      close({
        provider: providerSel.value,
        model: pickedModel,
        effort: effortSel.value,
        subagent: subPid && subModel ? { providerId: subPid, model: subModel } : null,
      });
    };
    box.querySelector('#ai-cancel').onclick = () => close(null);
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
  });
}

async function loadSessionModel() {
  if (!_sessionName) return;
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}`));
    if (!res.ok) return;
    const info = await res.json();
    // Role prompt applies to every cli; load it first, then the claude-only model.
    _sessionRole = info.rolePrompt || '';
    updateRoleBtn();
    _sessionMemory = memoryToText(info.memory);
    updateMemoryBtn();
    // Provider switch applies to every cli (claude & codex both have providers).
    _sessionCli = info.cli || 'claude';
    _sessionProvider = info.provider || '';
    _sessionSubagent = info.subagent || null;
    updateSubagentPill();
    if (_sessionProvider) await ensureProviderList(_sessionCli === 'codex' ? 'codex' : 'claude');
    updateProviderBtn();
    _sessionModel = info.model || '';
    _sessionEffectiveModel = info.effectiveModel || info.model || '';
    _sessionEffort = info.effort || '';
    _sessionEffectiveEffort = info.effectiveEffort || _sessionEffort || defaultEffortForCurrentCli();
    updateModelBtn();
    updateEffortBtn();
    if ((info.cli || 'claude') !== 'claude') {
      updateAutoCommitBtn();
      return; // streaming is claude-only
    }
    _sessionStreaming = !!info.streaming;
    _sessionAutoContinue = !!info.autoContinue;
    updateStreamBtn();
    _sessionAutoCommit = !!info.autoCommit;
    updateAutoCommitBtn();
    _sessionAutoDispatch = !!info.autoDispatch;
    updateAutoDispatchCheck();
  } catch (_) {}
}

modelBtn?.addEventListener('click', async () => {
  // 每次打开前重新拉取一次会话配置，避免重连/加载未完成时弹窗显示默认值。
  await loadSessionModel();
  await ensureProviderList(_sessionCli === 'codex' ? 'codex' : 'claude');
  const picked = await showAIConfigPicker({
    provider: _sessionProvider,
    model: _sessionModel,
    effort: _sessionEffectiveEffort || _sessionEffort || defaultEffortForCurrentCli(),
    subagent: _sessionSubagent,
  });
  if (picked === null) return;
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: picked.provider, model: picked.model, effort: picked.effort, subagent: picked.subagent }),
    });
    const data = await res.json();
    if (!res.ok) { addSystemMsg('AI 配置保存失败：' + (data.error || `HTTP ${res.status}`)); return; }
    _sessionProvider = data.provider || '';
    _sessionSubagent = data.subagent || null;
    updateSubagentPill();
    _sessionModel = data.model || '';
    _sessionEffectiveModel = data.effectiveModel || data.model || '';
    _sessionEffort = data.effort || '';
    _sessionEffectiveEffort = data.effectiveEffort || _sessionEffort || defaultEffortForCurrentCli();
    updateModelBtn();
    const _savedModel = _sessionEffectiveModel || _sessionModel;
    addSystemMsg(`✓ AI 配置已保存：${providerShortName(_sessionProvider)} | ${_savedModel ? modelDisplayName(_savedModel, _sessionProvider) : tt('default')} | ${effortShortName(_sessionEffectiveEffort)}，下一轮对话生效`);
  } catch (e) {
    addSystemMsg('AI 配置保存失败：' + e.message);
  }
});

effortBtn?.addEventListener('click', async () => {
  const picked = await showEffortPicker(_sessionEffectiveEffort || _sessionEffort || defaultEffortForCurrentCli());
  if (picked === null) return;
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort: picked }),
    });
    const data = await res.json();
    if (!res.ok) { addSystemMsg('努力程度切换失败：' + (data.error || `HTTP ${res.status}`)); return; }
    _sessionEffort = data.effort || '';
    _sessionEffectiveEffort = data.effectiveEffort || _sessionEffort || defaultEffortForCurrentCli();
    updateEffortBtn();
    addSystemMsg(`✓ 努力程度已切换为 ${effortShortName(_sessionEffectiveEffort)}，下一轮对话生效`);
  } catch (e) {
    addSystemMsg('努力程度切换失败：' + e.message);
  }
});

/* ── Per-session provider switch (cc-switch) ── */
const providerBtn = document.getElementById('provider-btn');
let _sessionProvider = '';       // provider id ('' = default login)
let _sessionSubagent = null;     // {providerId, model} for Task-tool subagent (claude-proxy), null = 随主
let _sessionProviderDisplayName = '';  // 实际生效 provider 的显示名（init 兜底；_sessionProvider 为空或 _providerList 未加载时用）
let _sessionCli = 'claude';
let _providerList = [];           // cached [{id,appType,name,baseUrl,model,isOfficial}]
let _providerDefaults = { claude: null, codex: null };

function effectiveProviderIdForChoices(providerId) {
  return providerId || _providerDefaults[_sessionCli] || '';
}

function providerShortName(id) {
  if (!id) return tt('default');
  const p = _providerList.find(o => o.id === id);
  return p ? p.name : id.slice(0, 8);
}

function updateProviderBtn() {
  if (!providerBtn) return;
  providerBtn.style.display = 'none';
  updateModelBtn();
}

async function ensureProviderList(appType) {
  try {
    const res = await fetch(withToken(`/api/providers?appType=${encodeURIComponent(appType)}`));
    if (!res.ok) return [];
    const d = await res.json();
    _providerList = d.providers || [];
    _providerDefaults = d.defaults || _providerDefaults;
    return _providerList;
  } catch (_) { return []; }
}

function showProviderPicker(current, list) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:400px;max-width:94vw;';
    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:14px;color:#c9d1d9;line-height:1.6;margin-bottom:12px;';
    msg.textContent = tt('providerTitle');
    box.appendChild(msg);

    const select = document.createElement('select');
    select.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;';
    const optDef = document.createElement('option');
    optDef.value = ''; optDef.textContent = tt('providerDefault');
    select.appendChild(optDef);
    for (const p of list) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name + (p.isOfficial ? ' · 订阅' : (p.baseUrl ? ' · ' + p.baseUrl.replace(/^https?:\/\//, '') : '')) + (p.model ? ' · ' + p.model : '');
      select.appendChild(opt);
    }
    select.value = current || '';
    box.appendChild(select);
    if (!list.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:12px;color:#8b949e;margin-bottom:12px;';
      empty.textContent = tt('providerEmpty');
      box.appendChild(empty);
    }

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const cancel = document.createElement('button');
    cancel.textContent = tt('cancel');
    cancel.style.cssText = 'background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:6px 14px;cursor:pointer;';
    const ok = document.createElement('button');
    ok.textContent = tt('save');
    ok.style.cssText = 'background:#238636;border:1px solid #2ea043;border-radius:6px;color:#fff;font-size:13px;padding:6px 14px;cursor:pointer;';
    row.appendChild(cancel); row.appendChild(ok);
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = (result) => { overlay.remove(); resolve(result); };
    ok.onclick = () => close({ value: select.value });
    cancel.onclick = () => close(null);
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
  });
}

providerBtn?.addEventListener('click', async () => {
  const list = await ensureProviderList(_sessionCli === 'codex' ? 'codex' : 'claude');
  const picked = await showProviderPicker(_sessionProvider, list);
  if (picked === null) return;
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: picked.value }),
    });
    const data = await res.json();
    if (!res.ok) { addSystemMsg('Provider 切换失败：' + (data.error || `HTTP ${res.status}`)); return; }
    _sessionProvider = data.provider || '';
 _sessionModel = data.model || '';
    _sessionEffectiveModel = data.effectiveModel || data.model || '';
    updateProviderBtn();
 updateModelBtn();
    addSystemMsg(`✓ Provider 已切换为 ${providerShortName(_sessionProvider)}，下一轮对话生效`);
  } catch (e) {
    addSystemMsg('Provider 切换失败：' + e.message);
  }
});

/* ── Per-session role prompt (all CLIs) ── */
const roleBtn = document.getElementById('role-btn');
let _sessionRole = '';

function updateRoleBtn() {
  if (!roleBtn) return;
  const set = !!(_sessionRole && _sessionRole.trim());
  roleBtn.textContent = set ? tt('roleSet') : tt('role');
  roleBtn.title = set
    ? '该会话已设角色提示词，点击修改（下一轮对话生效）'
    : '设置该会话的角色提示词（下一轮对话生效）';
}

// ── Agent-preset (role library) helpers for the web role editor ──
// The web role editor was a bare textarea; these let it offer the same preset
// roles the app does, with featured presets pinned first.
let _agentPresetIndexCache = null;
async function fetchAgentPresetIndex() {
  if (_agentPresetIndexCache) return _agentPresetIndexCache;
  try {
    const res = await fetch(withToken('/api/agent-presets'));
    if (!res.ok) return null;
    _agentPresetIndexCache = await res.json();
    return _agentPresetIndexCache;
  } catch (_) { return null; }
}
async function fetchAgentPresetPrompt(id) {
  try {
    const res = await fetch(withToken('/api/agent-presets/' + encodeURIComponent(id)));
    if (!res.ok) return null;
    const d = await res.json();
    return d.prompt || null;
  } catch (_) { return null; }
}

// WebView-safe editor (native prompt/confirm are unreliable in Android WebViews).
function showRolePromptEditor(current) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:560px;max-width:94vw;';
    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:14px;color:#c9d1d9;line-height:1.6;margin-bottom:10px;';
    msg.textContent = '该会话的角色提示词（下一轮对话生效）';
    box.appendChild(msg);

    // Preset-role picker — mirrors the app's role library; featured pinned first.
    const presetRow = document.createElement('div');
    presetRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';
    const presetLabel = document.createElement('span');
    presetLabel.textContent = '预设角色';
    presetLabel.style.cssText = 'font-size:12px;color:#8b949e;white-space:nowrap;';
    const presetSel = document.createElement('select');
    presetSel.style.cssText = 'flex:1;min-width:0;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:7px 10px;outline:none;';
    const ph = document.createElement('option');
    ph.value = ''; ph.textContent = '从预设角色填入…（加载中）';
    presetSel.appendChild(ph);
    presetRow.appendChild(presetLabel);
    presetRow.appendChild(presetSel);
    box.appendChild(presetRow);
    fetchAgentPresetIndex().then((idx) => {
      if (!idx) { ph.textContent = '预设角色加载失败'; return; }
      ph.textContent = '从预设角色填入…';
      const presets = idx.presets || [];
      const byId = {};
      for (const p of presets) byId[p.id] = p;
      const feat = (idx.featured || []).map((id) => byId[id]).filter(Boolean);
      if (feat.length) {
        const og = document.createElement('optgroup'); og.label = '⭐ 推荐';
        for (const p of feat) {
          const o = document.createElement('option');
          o.value = p.id; o.textContent = `${p.emoji || ''} ${p.name}`.trim();
          og.appendChild(o);
        }
        presetSel.appendChild(og);
      }
      for (const c of (idx.categories || [])) {
        const items = presets.filter((x) => x.category === c.key);
        if (!items.length) continue;
        const og = document.createElement('optgroup'); og.label = c.label || c.key;
        for (const p of items) {
          const o = document.createElement('option');
          o.value = p.id; o.textContent = `${p.emoji || ''} ${p.name}`.trim();
          og.appendChild(o);
        }
        presetSel.appendChild(og);
      }
    });
    presetSel.addEventListener('change', async () => {
      const id = presetSel.value;
      presetSel.value = '';
      if (!id) return;
      presetSel.disabled = true;
      const prompt = await fetchAgentPresetPrompt(id);
      presetSel.disabled = false;
      if (prompt) { ta.value = prompt; ta.focus(); }
      else addSystemMsg('预设角色加载失败');
    });

    const ta = document.createElement('textarea');
    ta.value = current || '';
    ta.placeholder = '例如：你是开发保姆，被触发时用 multicc-trigger skill 检查 git 改动并提醒提交和测试，不要擅自改代码。';
    ta.rows = 8;
    ta.style.cssText = 'width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;line-height:1.5;padding:10px;outline:none;resize:vertical;margin-bottom:6px;font-family:inherit;';
    box.appendChild(ta);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;color:#8b949e;margin-bottom:12px;';
    hint.textContent = '留空＝清除（会话将继承Fleet默认角色）。Ctrl/⌘+Enter 保存。';
    box.appendChild(hint);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.style.cssText = 'background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:6px 14px;cursor:pointer;';
    const ok = document.createElement('button');
    ok.textContent = '保存';
    ok.style.cssText = 'background:#238636;border:1px solid #2ea043;border-radius:6px;color:#fff;font-size:13px;padding:6px 14px;cursor:pointer;';
    row.appendChild(cancel); row.appendChild(ok);
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = (result) => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(result); };
    const accept = () => {
      if (ta.value.length > 8000) { addSystemMsg('角色提示词过长（上限 8000 字）'); return; }
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

roleBtn?.addEventListener('click', async () => {
  const next = await showRolePromptEditor(_sessionRole);
  if (next === null) return; // cancelled
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rolePrompt: next }),
    });
    const data = await res.json();
    if (!res.ok) { addSystemMsg('角色保存失败：' + (data.error || `HTTP ${res.status}`)); return; }
    _sessionRole = data.rolePrompt || '';
    updateRoleBtn();
    addSystemMsg(_sessionRole
      ? '✓ 角色提示词已更新，下一轮对话生效'
      : '✓ 已清除会话角色（继承Fleet默认），下一轮对话生效');
  } catch (e) {
    addSystemMsg('角色保存失败：' + e.message);
  }
});

/* ── Per-session memory (distilled key problems + solutions) ── */
const memoryBtn = document.getElementById('memory-btn');
let _sessionMemory = '';

// The server stores session memory as structured entries [{type,text,ts}], but
// the web treats _sessionMemory as plain text (button state via .trim(), the
// editor textarea). Normalize any server payload (array | legacy string | null)
// to text so callers never crash on .trim() — a non-string here used to throw
// inside loadSessionModel() and silently abort it before later UI (e.g. the
// subagent pill) could render.
function memoryToText(m) {
  if (Array.isArray(m)) {
    return m.map(e => (e && typeof e.text === 'string') ? e.text : (typeof e === 'string' ? e : ''))
      .filter(Boolean).join('\n');
  }
  return typeof m === 'string' ? m : '';
}

function updateMemoryBtn() {
  if (!memoryBtn) return;
  const set = !!(_sessionMemory && _sessionMemory.trim());
  memoryBtn.textContent = set ? tt('memorySet') : tt('memory');
  memoryBtn.title = '会话记忆库：私有（仅本会话）＋公共（项目共享）记忆，每轮自动注入给模型；AI 也会自读写。点击查看/编辑';
}

// Folder-memory editor: two scopes (own = private to this session, shared =
// all sessions in the directory), each a folder of .md files. Reads/writes via
// /api/sessions/:id/memory (GET folder · PUT file · DELETE file). Replaces the
// old single-textarea distilled-memory editor.
async function openMemoryEditor() {
  let data;
  try {
    const r = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/memory`));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
  } catch (e) { addSystemMsg('记忆读取失败：' + e.message); return; }

  const model = {
    own:    { dir: (data.own && data.own.dir) || '', primary: (data.own && data.own.primary) || 'CLAUDE.md', files: {} },
    shared: { dir: (data.shared && data.shared.dir) || '', files: {} },
  };
  ((data.own && data.own.files) || []).forEach(f => { model.own.files[f.name] = f.content; });
  ((data.shared && data.shared.files) || []).forEach(f => { model.shared.files[f.name] = f.content; });

  let scope = 'own';
  let curName = (model.own.primary in model.own.files) ? model.own.primary : (Object.keys(model.own.files).sort()[0] || model.own.primary);
  if (!(curName in model.own.files)) model.own.files[curName] = '';

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
  const box = document.createElement('div');
  box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:10px;padding:16px;width:min(680px,95vw);max-height:88vh;display:flex;flex-direction:column;gap:10px;';

  const title = document.createElement('div');
  title.style.cssText = 'color:#f0f6fc;font-size:14px;font-weight:600;';
  title.textContent = '🧠 会话记忆库';
  const msg = document.createElement('div');
  msg.style.cssText = 'color:#8b949e;font-size:12px;line-height:1.5;';
  msg.textContent = '每轮对话自动注入「私有＋公共」记忆给模型。私有＝仅本会话；公共＝本项目所有会话共享。AI 也会自己读写这些文件。';

  const tabs = document.createElement('div');
  tabs.style.cssText = 'display:flex;gap:6px;';
  const tabOwn = document.createElement('button');
  const tabShared = document.createElement('button');
  const tabStyle = (a) => `background:${a?'#1f6feb':'#21262d'};border:1px solid ${a?'#388bfd':'#30363d'};border-radius:6px;color:${a?'#fff':'#c9d1d9'};font-size:12px;padding:5px 12px;cursor:pointer;`;
  tabOwn.textContent = '私有（仅本会话）';
  tabShared.textContent = '公共（项目共享）';

  const fileRow = document.createElement('div');
  fileRow.style.cssText = 'display:flex;gap:6px;align-items:center;';
  const sel = document.createElement('select');
  sel.style.cssText = 'flex:1;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:12px;padding:5px;';
  const newBtn = document.createElement('button');
  newBtn.textContent = '＋新建';
  newBtn.style.cssText = 'background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:12px;padding:5px 10px;cursor:pointer;';
  const delBtn = document.createElement('button');
  delBtn.textContent = '🗑删除';
  delBtn.style.cssText = 'background:#21262d;border:1px solid #30363d;border-radius:6px;color:#f85149;font-size:12px;padding:5px 10px;cursor:pointer;';

  const ta = document.createElement('textarea');
  ta.style.cssText = 'width:100%;flex:1;min-height:240px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;font-family:ui-monospace,monospace;padding:10px;resize:vertical;';
  const pathHint = document.createElement('div');
  pathHint.style.cssText = 'color:#6e7681;font-size:11px;word-break:break-all;';

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '关闭';
  closeBtn.style.cssText = 'background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:6px 14px;cursor:pointer;';
  const saveBtn = document.createElement('button');
  saveBtn.textContent = tt('save');
  saveBtn.style.cssText = 'background:#238636;border:1px solid #2ea043;border-radius:6px;color:#fff;font-size:13px;padding:6px 14px;cursor:pointer;';
  row.appendChild(closeBtn); row.appendChild(saveBtn);

  tabs.appendChild(tabOwn); tabs.appendChild(tabShared);
  fileRow.appendChild(sel); fileRow.appendChild(newBtn); fileRow.appendChild(delBtn);
  box.appendChild(title); box.appendChild(msg); box.appendChild(tabs); box.appendChild(fileRow); box.appendChild(ta); box.appendChild(pathHint); box.appendChild(row);
  overlay.appendChild(box); document.body.appendChild(overlay);

  const defName = (s) => s === 'own' ? (model.own.primary || 'CLAUDE.md') : 'README.md';
  function commit() { if (curName) model[scope].files[curName] = ta.value; }
  function renderTabs() { tabOwn.style.cssText = tabStyle(scope === 'own'); tabShared.style.cssText = tabStyle(scope === 'shared'); }
  function renderFiles() {
    if (!Object.keys(model[scope].files).length) model[scope].files[defName(scope)] = '';
    const names = Object.keys(model[scope].files).sort();
    if (!(curName in model[scope].files)) curName = names[0];
    sel.innerHTML = '';
    names.forEach(n => { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); });
    sel.value = curName;
    ta.value = model[scope].files[curName] || '';
    pathHint.textContent = (model[scope].dir || '') + '/' + curName;
  }
  function switchScope(s) { commit(); scope = s; const names = Object.keys(model[scope].files).sort(); curName = names[0] || defName(s); if (!(curName in model[scope].files)) model[scope].files[curName] = ''; renderTabs(); renderFiles(); }

  tabOwn.onclick = () => switchScope('own');
  tabShared.onclick = () => switchScope('shared');
  sel.onchange = () => { commit(); curName = sel.value; ta.value = model[scope].files[curName] || ''; pathHint.textContent = (model[scope].dir || '') + '/' + curName; };
  newBtn.onclick = () => {
    let n = (prompt('新建记忆文件名（.md）：', '') || '').trim();
    if (!n) return;
    if (!/\.md$/i.test(n)) n += '.md';
    if (!/^[\w.\- 一-龥]+\.md$/i.test(n)) { addSystemMsg('文件名不合法（仅字母/数字/中文/._- 加 .md）'); return; }
    commit();
    if (!(n in model[scope].files)) model[scope].files[n] = '';
    curName = n; renderFiles();
  };
  delBtn.onclick = async () => {
    if (!curName) return;
    if (!confirm(`删除 ${scope === 'own' ? '私有' : '公共'}记忆文件「${curName}」？不可恢复。`)) return;
    try {
      const r = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/memory`), {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, name: curName }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); addSystemMsg('删除失败：' + (d.error || ('HTTP ' + r.status))); return; }
    } catch (e) { addSystemMsg('删除失败：' + e.message); return; }
    delete model[scope].files[curName];
    curName = Object.keys(model[scope].files).sort()[0] || '';
    renderFiles();
    addSystemMsg('✓ 已删除记忆文件');
  };
  saveBtn.onclick = async () => {
    commit();
    if (!curName) { addSystemMsg('没有选中的文件'); return; }
    try {
      const r = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/memory`), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, name: curName, content: model[scope].files[curName] }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { addSystemMsg('保存失败：' + (d.error || ('HTTP ' + r.status))); return; }
      addSystemMsg(`✓ 已保存 ${scope === 'own' ? '私有' : '公共'}记忆 / ${curName}`);
      updateMemoryBtn();
    } catch (e) { addSystemMsg('保存失败：' + e.message); }
  };

  const close = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); };
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveBtn.onclick(); }
  }
  closeBtn.onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onKey, true);

  renderTabs(); renderFiles();
  setTimeout(() => ta.focus(), 0);
}

memoryBtn?.addEventListener('click', () => { openMemoryEditor(); });

// Live update when the aux AI distills new memory for this session.
function applyMemoryEvent(memory) { _sessionMemory = memoryToText(memory); updateMemoryBtn(); }

/* ── Per-session streaming + auto-continue (claude only) ── */
const streamBtn = document.getElementById('stream-btn');
let _sessionStreaming = false;
let _sessionAutoContinue = false;

function updateStreamBtn() {
  if (!streamBtn) return;
  streamBtn.style.display = '';
  const on = _sessionStreaming;
  streamBtn.textContent = on ? (_sessionAutoContinue ? tt('streamAuto') : tt('stream')) : tt('streamOff');
  streamBtn.style.opacity = on ? '1' : '0.6';
  streamBtn.title = '流式常驻：保持 claude 进程不退出、保住上下文（适合「等数据返回再继续」的任务）。\n自动接力：一轮只是在等后台结果时，自动续上（带护栏）。\n下一轮对话生效。';
}

// Two-toggle picker (WebView-safe; native confirm is unreliable in Android WebViews).
function showStreamSettings(streaming, autoContinue) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:460px;max-width:94vw;color:#c9d1d9;';
    box.innerHTML = `
      <div style="font-size:15px;font-weight:600;margin-bottom:12px;">流式 / 自动接力（下一轮生效）</div>
      <label style="display:flex;gap:10px;align-items:flex-start;margin-bottom:12px;cursor:pointer;">
        <input type="checkbox" id="ss-stream" ${streaming ? 'checked' : ''} style="margin-top:3px;">
        <span><b>流式常驻</b><br><span style="font-size:12px;color:#8b949e;">保持 claude 进程不退出、上下文常驻。turn 结束（哪怕模型说"等数据"）进程也活着待命，续接更快、更稳。</span></span>
      </label>
      <label style="display:flex;gap:10px;align-items:flex-start;margin-bottom:16px;cursor:pointer;">
        <input type="checkbox" id="ss-auto" ${autoContinue ? 'checked' : ''} style="margin-top:3px;">
        <span><b>自动接力（兜底）</b><br><span style="font-size:12px;color:#8b949e;">当一轮只是在"等后台任务/外部数据"且无需你操作时，自动发"继续"。带护栏：最多连续 5 次、你一发言就重置、已用 /wait 登记则不重复。</span></span>
      </label>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="ss-cancel" style="background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:6px 14px;cursor:pointer;">取消</button>
        <button id="ss-ok" style="background:#238636;border:1px solid #2ea043;border-radius:6px;color:#fff;font-size:13px;padding:6px 14px;cursor:pointer;">保存</button>
      </div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const close = (r) => { overlay.remove(); resolve(r); };
    box.querySelector('#ss-ok').onclick = () => close({ streaming: box.querySelector('#ss-stream').checked, autoContinue: box.querySelector('#ss-auto').checked });
    box.querySelector('#ss-cancel').onclick = () => close(null);
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
  });
}

streamBtn?.addEventListener('click', async () => {
  const picked = await showStreamSettings(_sessionStreaming, _sessionAutoContinue);
  if (picked === null) return;
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streaming: picked.streaming, autoContinue: picked.autoContinue }),
    });
    const data = await res.json();
    if (!res.ok) { addSystemMsg('保存失败：' + (data.error || `HTTP ${res.status}`)); return; }
    _sessionStreaming = !!data.streaming;
    _sessionAutoContinue = !!data.autoContinue;
    updateStreamBtn();
    addSystemMsg(`✓ 流式常驻=${_sessionStreaming ? '开' : '关'}，自动接力=${_sessionAutoContinue ? '开' : '关'}，下一轮对话生效`);
  } catch (e) {
    addSystemMsg('保存失败：' + e.message);
  }
});

/* ── Per-session auto-commit (auto commit & merge after task completion) ── */
const autoCommitBtn = document.getElementById('auto-commit-btn');
let _sessionAutoCommit = false;

function updateAutoCommitBtn() {
  if (!autoCommitBtn) return;
  autoCommitBtn.style.display = '';
  autoCommitBtn.textContent = _sessionAutoCommit ? tt('autoCommitOn') : tt('autoCommitOff');
  autoCommitBtn.style.opacity = _sessionAutoCommit ? '1' : '0.6';
  autoCommitBtn.title = tt('autoCommitTitle');
}

autoCommitBtn?.addEventListener('click', async () => {
  const newVal = !_sessionAutoCommit;
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoCommit: newVal }),
    });
    const data = await res.json();
    if (!res.ok) { addSystemMsg('保存失败：' + (data.error || `HTTP ${res.status}`)); return; }
    _sessionAutoCommit = !!data.autoCommit;
    updateAutoCommitBtn();
    addSystemMsg(_sessionAutoCommit ? '✓ 已开启「任务完成后自动提交合并」，每轮完成后将自动 commit 并合并回基分支' : '✓ 已关闭「任务完成后自动提交合并」');
  } catch (e) {
    addSystemMsg('保存失败：' + e.message);
  }
});

/* ── Per-session auto-dispatch (auto dispatch tasks to other sessions) ── */
const autoDispatchCheck = document.getElementById('auto-dispatch-check');
let _sessionAutoDispatch = false;

function updateAutoDispatchCheck() {
  if (autoDispatchCheck) autoDispatchCheck.checked = _sessionAutoDispatch;
}

/* ── Subagent pill: shows the current sub-task model; click opens AI config ── */
const subagentPill = document.getElementById('subagent-pill');
function updateSubagentPill() {
  const el = document.getElementById('subagent-pill-label');
  if (!el) return;
  // Show the REAL wire model id that hits the server (effectiveModel), not the
  // stored tier alias (opus/sonnet/…). Falls back to the raw model, then 随主.
  const m = _sessionSubagent && (_sessionSubagent.effectiveModel || _sessionSubagent.model);
  el.textContent = m || '随主';
}
subagentPill?.addEventListener('click', () => { modelBtn?.click(); });

autoDispatchCheck?.addEventListener('change', async () => {
  const newVal = autoDispatchCheck.checked;
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoDispatch: newVal }),
    });
    const data = await res.json();
    if (!res.ok) {
      addSystemMsg('保存失败：' + (data.error || `HTTP ${res.status}`));
      autoDispatchCheck.checked = _sessionAutoDispatch; // rollback
      return;
    }
    _sessionAutoDispatch = !!data.autoDispatch;
    updateAutoDispatchCheck();
    addSystemMsg(_sessionAutoDispatch ? '✓ 已开启「Auto dispatch」，会话可自动派发任务到其它 session' : '✓ 已关闭「Auto dispatch」');
  } catch (e) {
    addSystemMsg('保存失败：' + e.message);
    autoDispatchCheck.checked = _sessionAutoDispatch; // rollback
  }
});

/* ── Per-message auto-commit checkbox ── */
// Add a small checkbox under an assistant message bubble.
// Returns the checkbox element so caller can read .checked state later.
function attachAutoCommitCheck(bubbleEl, checked) {
  if (!bubbleEl) return null;
  // User bubbles hold their text directly (no .msg-content wrapper); attach to
  // the bubble itself in that case so the checkbox sits under "我" message.
  const ce = bubbleEl.querySelector('.msg-content') || bubbleEl;
  // Remove any existing auto-commit line
  const old = ce.querySelector('.msg-auto-commit');
  if (old) old.remove();
  const row = document.createElement('div');
  row.className = 'msg-auto-commit';
  row.title = tt('autoCommitTitle');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!checked;
  row.appendChild(cb);
  row.appendChild(document.createTextNode(' ' + tt('autoCommitPerMsg')));
  // Toggle when clicking the label area
  row.addEventListener('click', (e) => {
    if (e.target === cb) return; // native checkbox handles itself
    cb.checked = !cb.checked;
  });
  ce.appendChild(row);
  return cb;
}

/* ── Session sharing (external web links) ── */
const shareBtn = document.getElementById('share-btn');

async function shareApi(method, p, body) {
  // Defensive: ALL admin share-management routes are scoped under
  // /api/sessions/:id/... and Express treats an empty :id as a 404. Bail
  // early with a clear message instead of silently 404ing (which is what
  // made the 撤销 button look "dead" when the page had no ?session= param).
  if (!_sessionName) throw new Error('未获取到会话标识（session id），请从管理面板进入此会话后再使用分享功能');
  const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}${p}`), {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function shareRow(s) {
  const lvl = s.type === 'messages'
    ? `📎 消息快照·${s.messageCount || 0}条${s.hasPassword ? '·密码' : ''}`
    : (s.access === 'operate' ? '可对话' : (s.hasPassword ? '密码查看' : '公开查看'));
  const exp = s.expiresAt ? `，到期 ${new Date(s.expiresAt).toLocaleString()}` : '';
  return `<div class="share-row" data-token="${s.token}" style="border:1px solid #30363d;border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:12px;">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;"><b style="color:#79c0ff;">${lvl}</b><span style="color:#8b949e;">${exp}</span></div>
    <div style="display:flex;gap:6px;align-items:center;"><input readonly value="${s.url}" style="flex:1;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:11px;padding:5px 7px;font-family:var(--mono,monospace);"><button data-copy="${s.url}" style="background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:12px;padding:5px 10px;cursor:pointer;">复制</button><button data-del="${s.token}" style="background:#2d1418;border:1px solid #5c2228;border-radius:6px;color:#f85149;font-size:12px;padding:5px 10px;cursor:pointer;">撤销</button></div>
  </div>`;
}

async function openShareDialog() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
  const box = document.createElement('div');
  box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:560px;max-width:94vw;max-height:90vh;overflow:auto;color:#c9d1d9;';
  box.innerHTML = `
    <div style="font-size:15px;font-weight:600;margin-bottom:4px;">分享此会话（外部网页链接）</div>
    <div style="font-size:12px;color:#8b949e;line-height:1.6;margin-bottom:10px;">接收方在浏览器打开链接即可。<b style="color:#f0883e;">「可对话」= 对方能通过此会话在你机器上执行操作，务必设强密码、谨慎分享。</b></div>
    <div style="margin-bottom:12px;"><button id="sh-msgmode" style="background:#1b2330;border:1px solid #2d3a4f;border-radius:6px;color:#79c0ff;font-size:12px;padding:6px 10px;cursor:pointer;">✂️ 改为分享指定消息（只读快照）…</button></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
      <select id="sh-access" style="background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:7px 9px;">
        <option value="view">只读查看</option>
        <option value="operate">可对话（需密码）</option>
      </select>
      <input id="sh-pw" placeholder="密码（可读可留空；可对话必填）" style="flex:1;min-width:160px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:7px 9px;">
      <select id="sh-exp" style="background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:7px 9px;">
        <option value="0">永不过期</option><option value="1">1 小时</option><option value="24">1 天</option><option value="168">7 天</option>
      </select>
      <button id="sh-create" style="background:#238636;border:1px solid #2ea043;border-radius:6px;color:#fff;font-size:13px;padding:7px 14px;cursor:pointer;">生成链接</button>
    </div>
    <div id="sh-msg" style="font-size:12px;min-height:16px;margin-bottom:8px;"></div>
    <div style="font-size:12px;color:#8b949e;margin-bottom:6px;">已有分享：</div>
    <div id="sh-list"><div style="color:#8b949e;font-size:12px;">加载中…</div></div>
    <div style="display:flex;justify-content:flex-end;margin-top:12px;"><button id="sh-close" style="background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:6px 14px;cursor:pointer;">关闭</button></div>`;
  overlay.appendChild(box); document.body.appendChild(overlay);
  const close = () => overlay.remove();
  box.querySelector('#sh-close').onclick = close;
  box.querySelector('#sh-msgmode').onclick = () => { close(); openMessagePicker(); };
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  const msg = box.querySelector('#sh-msg');
  const listEl = box.querySelector('#sh-list');

  async function refresh() {
    try { const d = await shareApi('GET', '/shares'); listEl.innerHTML = d.shares.length ? d.shares.map(shareRow).join('') : '<div style="color:#8b949e;font-size:12px;">暂无</div>'; }
    catch (e) { listEl.innerHTML = `<div style="color:#f85149;font-size:12px;">${e.message}</div>`; }
  }
  // Use event delegation on listEl so bind() is never needed — handlers survive
  // any innerHTML replacement, and data-* attrs always read the live DOM.
  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.hasAttribute('data-copy')) {
      navigator.clipboard?.writeText(btn.dataset.copy);
      btn.textContent = '已复制';
      setTimeout(() => { if (btn.isConnected) btn.textContent = '复制'; }, 1200);
    } else if (btn.hasAttribute('data-del')) {
      if (!confirm('撤销这个分享链接？')) return;
      const token = btn.dataset.del;
      if (!token) return;
      btn.disabled = true;
      btn.textContent = '撤销中…';
      shareApi('DELETE', '/share/' + encodeURIComponent(token))
        .then(() => refresh())
        .catch(e => alert(e.message))
        .finally(() => { if (btn.isConnected) { btn.disabled = false; btn.textContent = '撤销'; } });
    }
  });
  box.querySelector('#sh-create').onclick = async () => {
    const access = box.querySelector('#sh-access').value;
    const password = box.querySelector('#sh-pw').value.trim();
    const hrs = parseInt(box.querySelector('#sh-exp').value, 10);
    if (access === 'operate' && !password) { msg.textContent = '「可对话」必须设置密码'; msg.style.color = '#f85149'; return; }
    const body = { access };
    if (password) body.password = password;
    if (hrs > 0) body.expiresAt = Date.now() + hrs * 3600 * 1000;
    try {
      const d = await shareApi('POST', '/share', body);
      msg.style.color = '#3fb950'; msg.textContent = '已生成：' + d.url;
      navigator.clipboard?.writeText(d.url);
      box.querySelector('#sh-pw').value = '';
      refresh();
    } catch (e) { msg.style.color = '#f85149'; msg.textContent = e.message; }
  };
  refresh();
}

shareBtn?.addEventListener('click', openShareDialog);

// Pick specific messages → share a read-only snapshot link.
async function openMessagePicker() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
  const box = document.createElement('div');
  box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:620px;max-width:94vw;max-height:90vh;display:flex;flex-direction:column;color:#c9d1d9;';
  box.innerHTML = `
    <div style="font-size:15px;font-weight:600;margin-bottom:4px;">分享指定消息（只读快照）</div>
    <div style="font-size:12px;color:#8b949e;margin-bottom:10px;">勾选要分享的消息；生成的是固定快照，原会话变动或删除都不影响。</div>
    <div id="mp-list" style="flex:1;overflow:auto;border:1px solid #30363d;border-radius:8px;padding:6px;margin-bottom:10px;min-height:120px;">加载中…</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">
      <label style="font-size:12px;color:#8b949e;display:flex;gap:4px;align-items:center;cursor:pointer;"><input type="checkbox" id="mp-all"> 全选</label>
      <span id="mp-count" style="font-size:12px;color:#8b949e;">已选 0 条</span>
      <input id="mp-pw" placeholder="密码（可留空=公开）" style="flex:1;min-width:140px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:7px 9px;">
      <select id="mp-exp" style="background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:7px 9px;">
        <option value="0">永不过期</option><option value="24">1 天</option><option value="168">7 天</option></select>
    </div>
    <div id="mp-msg" style="font-size:12px;min-height:16px;margin-bottom:8px;"></div>
    <div style="display:flex;justify-content:flex-end;gap:8px;">
      <button id="mp-cancel" style="background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:6px 14px;cursor:pointer;">关闭</button>
      <button id="mp-go" style="background:#238636;border:1px solid #2ea043;border-radius:6px;color:#fff;font-size:13px;padding:6px 14px;cursor:pointer;">生成链接</button>
    </div>`;
  overlay.appendChild(box); document.body.appendChild(overlay);
  const close = () => overlay.remove();
  box.querySelector('#mp-cancel').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  const listEl = box.querySelector('#mp-list'), countEl = box.querySelector('#mp-count'), msgEl = box.querySelector('#mp-msg');
  const updateCount = () => { countEl.textContent = `已选 ${listEl.querySelectorAll('input[type=checkbox]:checked').length} 条`; };

  let msgs = [];
  try {
    const r = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/history`));
    const d = await r.json(); msgs = d.messages || [];
  } catch (e) { listEl.textContent = '加载失败：' + e.message; return; }
  if (!msgs.length) { listEl.textContent = '暂无消息'; return; }
  const escH = (s) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  listEl.innerHTML = msgs.map((m, i) => {
    const who = m.role === 'user' ? '我' : 'AI';
    const preview = escH((m.content || '').replace(/\s+/g, ' ').slice(0, 120)) || (m.tools && m.tools.length ? `（${m.tools.length} 个工具调用）` : '（空）');
    return `<label style="display:flex;gap:8px;align-items:flex-start;padding:6px;border-bottom:1px solid #21262d;cursor:pointer;font-size:12px;">
      <input type="checkbox" data-i="${i}" style="margin-top:2px;">
      <span><b style="color:${m.role === 'user' ? '#79c0ff' : '#e7eaee'}">${who}</b> <span style="color:#8b949e">${preview}</span></span></label>`;
  }).join('');
  listEl.querySelectorAll('input[type=checkbox]').forEach(c => c.onchange = updateCount);
  box.querySelector('#mp-all').onchange = (e) => { listEl.querySelectorAll('input[type=checkbox]').forEach(c => c.checked = e.target.checked); updateCount(); };

  box.querySelector('#mp-go').onclick = async () => {
    const indices = [...listEl.querySelectorAll('input[type=checkbox]:checked')].map(c => parseInt(c.dataset.i, 10));
    if (!indices.length) { msgEl.style.color = '#f85149'; msgEl.textContent = '请至少选择一条消息'; return; }
    const password = box.querySelector('#mp-pw').value.trim();
    const hrs = parseInt(box.querySelector('#mp-exp').value, 10);
    const body = { indices }; if (password) body.password = password; if (hrs > 0) body.expiresAt = Date.now() + hrs * 3600 * 1000;
    try {
      const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/share-messages`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json(); if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      navigator.clipboard?.writeText(d.url);
      msgEl.style.color = '#3fb950'; msgEl.textContent = '已生成并复制：' + d.url;
    } catch (e) { msgEl.style.color = '#f85149'; msgEl.textContent = e.message; }
  };
}

updateRoleBtn();
loadSessionModel();

/* ── Clear context button (popup: clear all / keep last N) ── */
const clearCtxWrap = document.getElementById('clear-ctx-wrap');
const clearCtxMenu = document.getElementById('clear-ctx-menu');
let _clearMenuOpen = false;
function openClearMenu() { _clearMenuOpen = true; clearCtxMenu.style.display = 'block'; }
function closeClearMenu() { _clearMenuOpen = false; clearCtxMenu.style.display = 'none'; }
clearCtxWrap.addEventListener('click', (e) => { e.stopPropagation(); _clearMenuOpen ? closeClearMenu() : openClearMenu(); });
document.addEventListener('click', (e) => { if (_clearMenuOpen && !clearCtxWrap.contains(e.target)) closeClearMenu(); });
clearCtxMenu.addEventListener('click', (e) => e.stopPropagation());
function doClear(keepN) {
  if (isStreaming) cancelStreaming();
  if (keepN > 0) {
    const msgs = [...messagesEl.querySelectorAll('.msg:not(.system-msg)')];
    const remove = msgs.slice(0, Math.max(0, msgs.length - keepN));
    remove.forEach(el => el.remove());
    if (remove.length) addSystemMsg('Cleared ' + remove.length + ' earlier messages (keep last ' + keepN + ')');
  } else {
    messagesEl.innerHTML = '';
    addSystemMsg('Chat cleared');
  }
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'clear_history', keep: keepN }));
  }
  closeClearMenu();
}
clearCtxMenu.querySelector('[data-action="clear-all"]').addEventListener('click', () => doClear(0));
clearCtxMenu.querySelector('[data-action="clear-keep"]').addEventListener('click', () => {
  const n = parseInt(document.getElementById('clear-keep-n').value, 10);
  doClear(Math.max(1, n || 5));
});

/* ── File Attachment ── */
attachBtn.addEventListener('click', () => fileInput.click());

fileInput.onchange = () => {
  if (!fileInput.files.length) return;
  for (const file of fileInput.files) {
    uploadFile(file);
  }
  fileInput.value = '';
};

inputEl.addEventListener('paste', (e) => {
  const files = Array.from(e.clipboardData?.files || []);
  if (!files.length) return;
  for (const file of files) {
    uploadFile(file);
  }
});

function updateAttachArea() {
  attachArea.classList.toggle('has-items', attachArea.children.length > 0);
}

async function uploadFile(file) {
  const fileName = file.name || guessPastedFileName(file);
  const isImage = file.type.startsWith('image/');
  const chip = document.createElement('div');
  chip.className = 'attach-chip' + (isImage ? ' is-image' : '');
  chip.style.opacity = '0.5';

  // Build chip contents: thumbnail (if image) + name + remove button
  let thumbUrl = null;
  if (isImage) {
    thumbUrl = URL.createObjectURL(file);
    const img = document.createElement('img');
    img.className = 'chip-thumb';
    img.src = thumbUrl;
    chip.appendChild(img);
  }
  const nameSpan = document.createElement('span');
  nameSpan.className = 'chip-name';
  nameSpan.textContent = fileName;
  chip.appendChild(nameSpan);

  const rm = document.createElement('span');
  rm.className = 'chip-remove';
  rm.innerHTML = '&times;';
  rm.onclick = (e) => { e.stopPropagation(); chip.remove(); updateAttachArea(); if (thumbUrl) URL.revokeObjectURL(thumbUrl); };
  chip.appendChild(rm);

  // Click chip to preview image
  if (isImage) {
    chip.onclick = (e) => {
      if (e.target === rm) return;
      openLightbox(thumbUrl || chip.querySelector('.chip-thumb')?.src, fileName);
    };
    chip.title = 'Click to preview';
  }

  attachArea.appendChild(chip);
  updateAttachArea();

  try {
    const formData = new FormData();
    formData.append('file', file, fileName);
    const res = await fetch(withToken('/api/upload'), { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    chip.dataset.path = data.path;
    chip.style.opacity = '1';
  } catch (err) {
    nameSpan.textContent = `Failed: ${fileName}`;
    chip.style.borderColor = '#f85149';
    chip.style.opacity = '1';
    setTimeout(() => { chip.remove(); updateAttachArea(); }, 3000);
  }
}

/* ── Image lightbox ── */
const _lightbox = document.getElementById('img-lightbox');
function openLightbox(src, name) {
  _lightbox.querySelector('img').src = src;
  _lightbox.querySelector('.lb-name').textContent = name || '';
  _lightbox.classList.add('show');
}
function closeLightbox() {
  _lightbox.classList.remove('show');
  _lightbox.querySelector('img').src = '';
}
_lightbox.querySelector('.lb-close').onclick = closeLightbox;
_lightbox.onclick = (e) => { if (e.target === _lightbox) closeLightbox(); };

function guessPastedFileName(file) {
  const ext = file.type === 'image/jpeg'
    ? 'jpg'
    : (file.type || '').split('/')[1] || 'bin';
  return `pasted-file.${ext}`;
}

/* ── Voice Notifications (task complete / waiting for action) ── */
const notifyBtn   = document.getElementById('notify-btn');
const notifyToast = document.getElementById('notify-toast');
function currentNotifySessionId() {
  return _sessionName || sessionId || '';
}
let _notifyEnabled = typeof getTaskNotifyEnabled === 'function'
  ? getTaskNotifyEnabled(_sessionName)
  : true;
let _notifyLastCompleted = 0;
let _notifyLastAction = 0;
let _notifyToastTimer = null;

const NOTIFY_COOLDOWN = 8000;

function updateNotifyBtn() {
  if (!notifyBtn) return;
  const pushInfo = typeof getPushInfo === 'function' ? getPushInfo() : null;
  const pushOn = !!(pushInfo && pushInfo.subscribed);
  if (_notifyEnabled) {
    notifyBtn.style.background = '#1f6feb';
    notifyBtn.style.borderColor = '#58a6ff';
    notifyBtn.style.color = '#fff';
    notifyBtn.title = pushOn ? '任务提醒 (系统通知已开启)' : '任务提醒 (点击开启系统通知)';
  } else {
    notifyBtn.style.background = '#21262d';
    notifyBtn.style.borderColor = '#30363d';
    notifyBtn.style.color = '#c9d1d9';
    notifyBtn.title = '任务提醒 (已关闭)';
  }
}
updateNotifyBtn();

if (notifyBtn) {
  notifyBtn.addEventListener('click', async () => {
    const pushOn = typeof isPushSubscribed === 'function' && isPushSubscribed();
    if (_notifyEnabled && pushOn) {
      _notifyEnabled = false;
      if (typeof setTaskNotifyEnabled === 'function') setTaskNotifyEnabled(currentNotifySessionId(), false);
      updateNotifyBtn();
      if (typeof unsubscribePush === 'function') await unsubscribePush();
      updateNotifyBtn();
      return;
    }

    _notifyEnabled = true;
    if (typeof setTaskNotifyEnabled === 'function') setTaskNotifyEnabled(currentNotifySessionId(), true);
    updateNotifyBtn();
    if (typeof ensurePushSubscribed === 'function') {
      const ok = await ensurePushSubscribed();
      if (!ok) {
        _notifyEnabled = false;
        if (typeof setTaskNotifyEnabled === 'function') setTaskNotifyEnabled(currentNotifySessionId(), false);
      }
      updateNotifyBtn();
    }
  });
}

window.addEventListener('multicc-push-state', updateNotifyBtn);

function refreshNotifyPreference() {
  if (typeof getTaskNotifyEnabled === 'function') {
    _notifyEnabled = getTaskNotifyEnabled(currentNotifySessionId());
    updateNotifyBtn();
  }
}

function showNotifyToast(text, type) {
  if (!notifyToast) return;
  const closeBtn = notifyToast.querySelector('.toast-close');
  notifyToast.textContent = '';
  notifyToast.appendChild(document.createTextNode(text + ' '));
  notifyToast.appendChild(closeBtn);
  notifyToast.className = type;
  notifyToast.style.display = 'block';
  if (_notifyToastTimer) clearTimeout(_notifyToastTimer);
  // Running toasts are transient status updates — auto-dismiss faster.
  const ttl = type === 'running' ? 8000 : 15000;
  _notifyToastTimer = setTimeout(dismissNotifyToast, ttl);
}

function dismissNotifyToast() {
  if (notifyToast) notifyToast.style.display = 'none';
  if (_notifyToastTimer) { clearTimeout(_notifyToastTimer); _notifyToastTimer = null; }
}

if (notifyToast) {
  notifyToast.addEventListener('click', dismissNotifyToast);
}

// When page becomes visible, stop any ongoing voice and dismiss toast
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    dismissNotifyToast();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }
});

function playDing(type) {
  // Short pleasant chime via WebAudio — used when the chat tab is visible so
  // the user gets an audible cue without a full voice announcement.
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    // completed: rising two-tone (C6 → G6); waiting: gentle single tone (E5)
    const freqs = type === 'completed' ? [1046.5, 1567.98] : [659.25];
    const t0 = ctx.currentTime;
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, t0 + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + i * 0.12 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.12 + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + i * 0.12);
      osc.stop(t0 + i * 0.12 + 0.3);
    });
    setTimeout(() => { try { ctx.close(); } catch (_) {} }, (freqs.length * 120 + 400));
  } catch (_) {}
}

function speakNotify(text, type) {
  if (!_notifyEnabled) return;

  const now = Date.now();
  if (type === 'completed') {
    if (now - _notifyLastCompleted < NOTIFY_COOLDOWN) return;
    _notifyLastCompleted = now;
  } else {
    if (now - _notifyLastAction < NOTIFY_COOLDOWN) return;
    _notifyLastAction = now;
  }

  // When the chat tab is visible the user is already looking at it, so just
  // play a short "ding" instead of a full voice announcement.
  if (document.visibilityState === 'visible') {
    playDing(type);
    return;
  }

  showNotifyToast(text, type);

  if (typeof showLocalTaskNotification === 'function') {
    const sid = _sessionName || sessionId || 'chat';
    showLocalTaskNotification({
      sessionId: sid,
      type: type === 'waiting' ? 'waiting' : 'completed',
      title: type === 'waiting' ? `MultiCC #${sid}: 等待操作` : `MultiCC #${sid}: 完成`,
      body: text,
      url: location.pathname + location.search,
    });
  }

  if (window.speechSynthesis) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1.1;
    utterance.volume = 0.8;
    window.speechSynthesis.speak(utterance);
  }
}

/* ── Dynamic title animation during streaming ── */
let _titleTimer = null;
let _titleDots = 0;

function startTitleAnimation() {
  if (_titleTimer) return;
  _titleDots = 0;
  _titleTimer = setInterval(() => {
    _titleDots = (_titleDots % 3) + 1;
    document.title = _baseTitle + ' ' + '.'.repeat(_titleDots);
  }, 500);
}

function stopTitleAnimation() {
  if (_titleTimer) { clearInterval(_titleTimer); _titleTimer = null; }
  document.title = _baseTitle;
}

/* ── Voice Input ── */
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recordingStream = null;

function showMicToast(text) {
  micToast.textContent = text;
  micToast.classList.add('show');
}
function hideMicToast() {
  micToast.classList.remove('show');
}

function startRecording() {
  if (_hasNativeBridge) {
    window.MultiCCBridge.startRecording();
    isRecording = true;
    micBtn.classList.add('recording');
    showMicToast('Recording...');
    return;
  }

  audioChunks = [];
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';

  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    recordingStream = stream;
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      if (recordingStream) { recordingStream.getTracks().forEach(t => t.stop()); recordingStream = null; }
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      audioChunks = [];
      if (blob.size > 0) uploadAudioForSTT(blob);
    };
    mediaRecorder.start();
    isRecording = true;
    micBtn.classList.add('recording');
    showMicToast('Recording... tap mic to stop');
  }).catch(err => {
    showMicToast('Mic error: ' + err.message);
    setTimeout(hideMicToast, 3000);
  });
}

function stopRecording() {
  if (_hasNativeBridge && isRecording) {
    showMicToast('Processing...');
    try { window.MultiCCBridge.stopRecording(); } catch (_) {}
    isRecording = false;
    micBtn.classList.remove('recording');
    return;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  isRecording = false;
  micBtn.classList.remove('recording');
  hideMicToast();
}

async function uploadAudioForSTT(blob) {
  micBtn.classList.add('processing');
  showMicToast('Transcribing...');
  try {
    const fd = new FormData();
    fd.append('file', blob, 'recording.webm');
    const res = await fetch(withToken('/api/voice/stt'), { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    hideMicToast();
    if (data.text?.trim()) {
      showVoicePanel(data.text.trim());
    } else {
      showMicToast('No speech detected');
      setTimeout(hideMicToast, 2000);
    }
  } catch (err) {
    showMicToast('STT failed: ' + err.message);
    setTimeout(hideMicToast, 3000);
  } finally {
    micBtn.classList.remove('processing');
  }
}

// Native bridge callbacks
window.__multiccRecStarted = () => {};
window.__multiccRecReady = async () => {
  isRecording = false;
  micBtn.classList.remove('recording');
  micBtn.classList.add('processing');
  showMicToast('Transcribing...');
  try {
    const audioRes = await fetch('/__recording');
    const audioBlob = await audioRes.blob();
    await uploadAudioForSTT(audioBlob);
  } catch (e) {
    showMicToast('Error: ' + e.message);
    setTimeout(hideMicToast, 3000);
    micBtn.classList.remove('processing');
  }
};
window.__multiccRecError = (msg) => {
  isRecording = false;
  micBtn.classList.remove('recording', 'processing');
  showMicToast('Record error: ' + msg);
  setTimeout(hideMicToast, 3000);
};

if (!_hasNativeBridge && (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices)) {
  micBtn.disabled = true;
  micBtn.title = 'Recording not supported (needs HTTPS)';
} else {
  micBtn.onclick = () => { isRecording ? stopRecording() : startRecording(); };
}

/* ── Voice Panel ── */
const voicePanel   = document.getElementById('voice-panel');
const vpRaw        = document.getElementById('vp-raw');
const vpRefined    = document.getElementById('vp-refined');
const vpStatus     = document.getElementById('vp-status');
const vpCancel     = document.getElementById('vp-cancel');
const vpUseRaw     = document.getElementById('vp-use-raw');
const vpUseRefined = document.getElementById('vp-use-refined');
let _vpRefinedFinal = '';

function showVoicePanel(rawText) {
  vpRaw.value = rawText;
  vpRefined.value = '';
  vpRefined.placeholder = 'Processing...';
  vpStatus.textContent = '';
  _vpRefinedFinal = '';
  voicePanel.classList.add('open');
  fetchRefined(rawText);
}

function closeVoicePanel() { voicePanel.classList.remove('open'); }

function useVoiceText(text) {
  inputEl.value = text;
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  inputEl.focus();
  closeVoicePanel();
}

vpCancel.onclick = closeVoicePanel;
vpUseRaw.onclick = () => useVoiceText(vpRaw.value);
vpUseRefined.onclick = () => useVoiceText(_vpRefinedFinal || vpRefined.value || vpRaw.value);

async function fetchRefined(raw) {
  vpStatus.textContent = 'processing (AuxQueue)...';
  const t0 = Date.now();
  try {
    const res = await fetch(withToken('/api/voice/refine'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    const data = await res.json();
    const clientMs = Date.now() - t0;
    if (data.ok && data.text) {
      vpRefined.value = data.text;
      _vpRefinedFinal = data.text;
      vpStatus.textContent = `done (${(data.ms / 1000).toFixed(1)}s server, ${(clientMs / 1000).toFixed(1)}s total)`;
    } else {
      vpRefined.value = data.text || '';
      _vpRefinedFinal = vpRefined.value;
      vpStatus.textContent = data.ok ? 'done' : `error: ${data.text || 'unknown'}`;
    }
  } catch (e) {
    vpStatus.textContent = 'error';
    console.error('[voice] refine error:', e);
  }
}

/* ── CWD Change Modal ── */
const cwdModal    = document.getElementById('cwd-modal');
const cwdInput    = document.getElementById('cwd-input');
const cwdError    = document.getElementById('cwd-error');
const cwdConfirm  = document.getElementById('cwd-modal-confirm');
const cwdCancel   = document.getElementById('cwd-modal-cancel');

document.getElementById('cwd-change').onclick = () => {
  cwdInput.value = _cwd;
  cwdError.style.display = 'none';
  cwdModal.classList.add('open');
  cwdInput.focus();
  cwdInput.select();
};

cwdCancel.onclick = () => cwdModal.classList.remove('open');
cwdModal.onclick = (e) => { if (e.target === cwdModal) cwdModal.classList.remove('open'); };
cwdInput.onkeydown = (e) => {
  if (e.key === 'Enter') cwdConfirm.click();
  if (e.key === 'Escape') cwdCancel.click();
};

cwdConfirm.onclick = () => {
  const newCwd = cwdInput.value.trim();
  if (!newCwd) { cwdError.textContent = 'Path required'; cwdError.style.display = 'block'; return; }
  _cwd = newCwd;
  updateCwdDisplay(newCwd);
  cwdModal.classList.remove('open');
  // Reconnect with new cwd
  if (ws) ws.close();
  sessionId = null; // fresh session for new dir
  connect();
};

/* ── Goal mode: AI precheck before sending ──
   The 🎯 button opens a modal; "预检" asks the aux-AI whether the task is
   goal-ready (clear objective, clear done-criteria, bounded, executable). The
   user accepts/edits the rewritten version, then it's wrapped in a short
   goal-mode instruction and sent through the normal send() path. */
const goalModal       = document.getElementById('goal-modal');
const goalBtn         = document.getElementById('goal-btn');
const goalTaskEl      = document.getElementById('goal-task');
const goalResultEl    = document.getElementById('goal-result');
const goalVerdictEl   = document.getElementById('goal-verdict');
const goalDetailEl    = document.getElementById('goal-detail');
const goalRevisedEl   = document.getElementById('goal-revised');
const goalErrorEl     = document.getElementById('goal-error');
const goalPrecheckBtn = document.getElementById('goal-precheck');
const goalSendBtn     = document.getElementById('goal-send');
const goalSendRawBtn  = document.getElementById('goal-send-raw');
const goalCancelBtn   = document.getElementById('goal-cancel');
const goalMaxRoundsEl = document.getElementById('goal-max-rounds');
const goalMaxBudgetEl = document.getElementById('goal-max-budget');

function openGoalModal() {
  goalTaskEl.value = inputEl.value.trim();
  goalResultEl.style.display = 'none';
  goalErrorEl.style.display = 'none';
  goalVerdictEl.className = '';
  goalDetailEl.innerHTML = '';
  goalRevisedEl.value = '';
  goalSendBtn.style.display = 'none';
  goalSendRawBtn.style.display = 'none';
  goalPrecheckBtn.style.display = '';
  goalPrecheckBtn.disabled = false;
  goalPrecheckBtn.textContent = '预检';
  loadGoalDims();   // default the checkboxes to the global config
  goalModal.classList.add('open');
  goalTaskEl.focus();
}
function closeGoalModal() { goalModal.classList.remove('open'); }

// Default the per-send dimension checkboxes to the saved global config.
async function loadGoalDims() {
  const boxes = document.querySelectorAll('#goal-dims input[data-dim]');
  // Execution limits are per-send only (no global config): seed with the hard
  // client default each time (200 rounds / no budget cap). Blank or 0 = unlimited.
  if (goalMaxRoundsEl) goalMaxRoundsEl.value = '200';
  if (goalMaxBudgetEl) goalMaxBudgetEl.value = '';
  try {
    const res = await fetch(withToken('/api/settings/goal'));
    const d = await res.json();
    const dims = d.dimensions || {};
    boxes.forEach(cb => { cb.checked = dims[cb.dataset.dim] !== false; });
  } catch (_) {
    boxes.forEach(cb => { cb.checked = true; });
  }
}
function collectGoalDims() {
  const dims = {};
  document.querySelectorAll('#goal-dims input[data-dim]').forEach(cb => { dims[cb.dataset.dim] = cb.checked; });
  return dims;
}
// Per-send limit overrides; blank → server falls back to the global config.
function collectGoalLimits() {
  const limits = {};
  if (goalMaxRoundsEl && goalMaxRoundsEl.value.trim() !== '') limits.maxRounds = parseInt(goalMaxRoundsEl.value, 10);
  if (goalMaxBudgetEl && goalMaxBudgetEl.value.trim() !== '') limits.maxBudget = parseInt(goalMaxBudgetEl.value, 10);
  return limits;
}

function goalList(title, items) {
  if (!items || !items.length) return '';
  return '<div class="goal-sec-title">' + title + '</div><ul class="goal-list">' +
    items.map(x => '<li>' + escHtml(x) + '</li>').join('') + '</ul>';
}

function renderGoalVerdict(d) {
  const ok = d.verdict === 'ok';
  goalVerdictEl.className = ok ? 'ok' : 'warn';
  goalVerdictEl.textContent = (ok ? '✅ 符合 Goal 模式' : '⚠️ 建议先完善') +
    '（符合度 ' + (d.score != null ? d.score : '-') + '/100）';
  let html = '';
  html += goalList('待完善', d.issues);
  html += goalList('需澄清', d.questions);
  html += goalList('建议完成标准', d.criteria);
  if (d.raw) html += '<div class="goal-sec-title">辅助 AI 原始输出</div>' +
    '<div style="font-size:11px;color:#8b949e;white-space:pre-wrap">' + escHtml(String(d.raw).slice(0, 800)) + '</div>';
  goalDetailEl.innerHTML = html;
  goalRevisedEl.value = d.revised || goalTaskEl.value.trim();
  goalResultEl.style.display = 'block';
  goalSendBtn.textContent = ok ? '以 Goal 模式发送' : '确认并以 Goal 模式发送';
  goalSendBtn.style.display = '';
  goalSendRawBtn.style.display = '';
}

// Wrap the final task in a short goal-mode framing, then reuse send().
function goalWrap(task) {
  return '请以 Goal 模式执行以下任务：目标驱动、自主规划并一步步执行到完成；' +
    '遇到不明确处用合理默认推进并说明假设；完成后自检并验证结果是否达到完成标准。\n\n' + task;
}
function sendGoal(task) {
  const t = (task || '').trim();
  if (!t) return;
  const limits = collectGoalLimits();
  closeGoalModal();
  inputEl.value = goalWrap(t);
  inputEl.style.height = 'auto';
  send({ goal: true, goalLimits: limits });
}

goalBtn?.addEventListener('click', openGoalModal);
if (goalCancelBtn) goalCancelBtn.onclick = closeGoalModal;
if (goalModal) goalModal.onclick = (e) => { if (e.target === goalModal) closeGoalModal(); };
if (goalSendBtn) goalSendBtn.onclick = () => sendGoal(goalRevisedEl.value || goalTaskEl.value);
if (goalSendRawBtn) goalSendRawBtn.onclick = () => sendGoal(goalTaskEl.value);
if (goalTaskEl) goalTaskEl.onkeydown = (e) => {
  if (e.key === 'Escape') closeGoalModal();
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); goalPrecheckBtn.click(); }
};
if (goalPrecheckBtn) goalPrecheckBtn.onclick = async () => {
  const task = goalTaskEl.value.trim();
  if (!task) { goalErrorEl.textContent = '请先填写任务'; goalErrorEl.style.display = 'block'; return; }
  goalErrorEl.style.display = 'none';
  goalPrecheckBtn.disabled = true;
  goalPrecheckBtn.textContent = '预检中…';
  try {
    const resp = await fetch(withToken('/api/goal/precheck'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, dimensions: collectGoalDims() }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || '预检失败');
    renderGoalVerdict(data);
  } catch (e) {
    goalErrorEl.textContent = '预检失败：' + e.message + '（可直接「用原文发送」）';
    goalErrorEl.style.display = 'block';
    goalSendRawBtn.style.display = '';   // let the user skip precheck and send anyway
  } finally {
    goalPrecheckBtn.disabled = false;
    goalPrecheckBtn.textContent = '重新预检';
  }
};

/* ── visualViewport fix ── */
if (_isMobile && window.visualViewport) {
  const fixH = () => { document.body.style.height = window.visualViewport.height + 'px'; };
  window.visualViewport.addEventListener('resize', fixH);
  fixH();
}

function ensureWsAlive() {
  const dead = !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;
  if (!dead) { updateUI(); return; }
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  _reconnectAttempt = 0;
  connect();
}

function forceReconnect(reason) {
  dbg('ws', `force reconnect — ${reason}`);
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  _reconnectAttempt = 0;
  const old = ws;
  if (old && old.readyState !== WebSocket.CLOSED) {
    old.onclose = null;
    old.onerror = null;
    old.onmessage = null;
    try { old.close(1000, 'client reconnect'); } catch (_) {}
  }
  ws = null;
  connect();
}

/* ── Reconnect when tab becomes visible again ── */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    _hiddenAt = Date.now();
    return;
  }
  if (document.visibilityState === 'visible') {
    const hiddenMs = _hiddenAt ? Date.now() - _hiddenAt : 0;
    _hiddenAt = 0;
    if (hiddenMs > 10000) forceReconnect(`visible after ${Math.round(hiddenMs / 1000)}s hidden`);
    else ensureWsAlive();
  }
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) forceReconnect('pageshow from bfcache');
  else ensureWsAlive();
});
window.addEventListener('focus', ensureWsAlive);
// Network restored (mobile data/wifi flap) — reconnect immediately.
window.addEventListener('online', () => forceReconnect('network online'));

// Fallback heartbeat: some Android WebViews never fire visibilitychange/focus when
// the whole app backgrounds, so the resume hooks above don't run and a dead socket
// is never noticed. A plain interval resumes ticking when the app comes back and
// catches a closed socket within a few seconds — no reliance on visibility events.
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    ensureWsAlive();
  }
}, 5000);

/* ── Manual reconnect control (header ↻) ── */
(function initReconnectBtn() {
  const btn = document.getElementById('reconnect-btn');
  if (!btn) return;
  // Tap → force reconnect; long-press (600ms) → hard page reload as a last resort.
  let lpTimer = null, longFired = false;
  const startLP = () => { longFired = false; lpTimer = setTimeout(() => { longFired = true; location.reload(); }, 600); };
  const cancelLP = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  btn.addEventListener('click', () => { if (!longFired) forceReconnect('manual button'); });
  btn.addEventListener('mousedown', startLP);
  btn.addEventListener('touchstart', startLP, { passive: true });
  ['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach(ev => btn.addEventListener(ev, cancelLP));
})();
// The status pill is always a reconnect affordance too (not only after a drop).
if (statusEl) statusEl.onclick = () => forceReconnect('status click');

/* ── Debug panel wiring ── */
(function initDebugPanel() {
  const btn = document.getElementById('dbg-btn');
  if (btn) btn.addEventListener('click', () => {
    _dbgPanel.classList.toggle('open');
    if (_dbgPanel.classList.contains('open')) {
      dbgState();
      _dbgLogEl.scrollTop = _dbgLogEl.scrollHeight;
    }
  });
  const closeBtn = document.getElementById('dbg-close');
  if (closeBtn) closeBtn.addEventListener('click', () => _dbgPanel.classList.remove('open'));
  const clearBtn = document.getElementById('dbg-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    _dbgEntries = [];
    _dbgLogEl.innerHTML = '';
    dbg('state', 'debug log cleared');
  });
  const copyBtn = document.getElementById('dbg-copy');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    const text = _dbgEntries.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = 'Copied';
    } catch (_) {
      copyBtn.textContent = 'Failed';
    }
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  });
  dbgState();
})();

/* ── Start ── */
dbg('state', 'page loaded — 开始连接');
connect();

/* ════════════════════════════════════════════════════════════════════════════
 * S2S 语音对话模式 (Speech-to-Speech, 豆包式交互)
 * ════════════════════════════════════════════════════════════════════════════ */
(function initS2S() {
  const s2sBtn = document.getElementById('s2s-btn');
  const s2sPanel = document.getElementById('s2s-panel');
  const s2sStateBadge = document.getElementById('s2s-state-badge');
  const s2sTranscript = document.getElementById('s2s-transcript');
  const s2sBreakdown = document.getElementById('s2s-breakdown');
  const s2sVolumeFill = document.getElementById('s2s-volume-fill');
  const s2sStopBtn = document.getElementById('s2s-stop-btn');
  if (!s2sBtn) return;

  let s2sSession = null;
  let s2sActive = false;

  const STATE_LABELS = {
    IDLE: 'IDLE',
    LISTENING: '聆听中',
    CONFIRMING: '确认中',
    EXECUTING: '执行中',
    REPORTING: '汇报中',
  };

  function updateS2SPanel(state) {
    s2sStateBadge.textContent = STATE_LABELS[state] || state;
    s2sStateBadge.className = '';
    if (state === 'LISTENING') s2sStateBadge.classList.add('listening');
    else if (state === 'CONFIRMING') s2sStateBadge.classList.add('confirming');
    else if (state === 'EXECUTING') s2sStateBadge.classList.add('executing');
    else if (state === 'REPORTING') s2sStateBadge.classList.add('reporting');

    if (state === 'LISTENING' && s2sSession && !s2sSession.currentBreakdown) {
      s2sTranscript.innerHTML = '<span class="partial">🎤 请说出你的需求…</span>';
    } else if (state === 'LISTENING' && s2sSession && s2sSession.currentBreakdown) {
      s2sTranscript.innerHTML = '<span class="partial">🎤 请确认或修改…</span>';
    }
  }

  function renderBreakdown(bd) {
    if (!bd) { s2sBreakdown.innerHTML = ''; return; }
    let html = '';
    if (bd.summary) {
      html += `<div class="bd-summary">${escapeHtml(bd.summary)}</div>`;
    }
    if (bd.items && bd.items.length) {
      bd.items.forEach((item, i) => {
        html += `<div class="bd-item"><span class="bd-item-num">${i + 1}.</span><span>${escapeHtml(item)}</span></div>`;
      });
    }
    if (bd.questions && bd.questions.length) {
      bd.questions.forEach(q => {
        html += `<div class="bd-question">❓ ${escapeHtml(q)}</div>`;
      });
    }
    s2sBreakdown.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function startS2S() {
    if (s2sActive) return;
    s2sActive = true;
    s2sBtn.classList.add('active');
    s2sPanel.classList.add('open');
    s2sBreakdown.innerHTML = '';
    s2sTranscript.innerHTML = '<span class="partial">正在启动语音…</span>';

    // Determine ASR provider from voice settings
    let asrProvider = 'auto';
    let ttsProvider = 'edge';
    try {
      const res = await fetch(withToken('/api/settings/voice'));
      const config = await res.json();
      if (config.asr?.provider) asrProvider = config.asr.provider;
      if (config.tts?.provider) ttsProvider = config.tts.provider;
    } catch (_) {}

    const wsUrl = location.origin.replace(/^http/, 'ws');
    s2sSession = new S2SSession({
      wsUrl,
      asrProvider,
      ttsProvider,
      onStateChange: (state) => updateS2SPanel(state),
      onText: (text, isFinal) => {
        s2sTranscript.innerHTML = `<span class="partial">${escapeHtml(text)}</span>`;
      },
      onBreakdown: (bd) => renderBreakdown(bd),
      onAiText: (text) => {
        s2sTranscript.innerHTML = escapeHtml(text);
      },
      onVolume: (level) => {
        // level is RMS amplitude (~0.02-0.15 for speech). Scale into a
        // responsive 0-100% bar with a gentle curve so quiet speech still moves.
        const pct = Math.min(100, Math.round(Math.sqrt(level) * 220));
        s2sVolumeFill.style.width = pct + '%';
      },
      onVadDebug: (info) => {
        const dbg = document.getElementById('s2s-vad-debug');
        if (!dbg) return;
        const f = (n) => (n || 0).toFixed(4);
        dbg.textContent =
          `rms ${f(info.rms)} | 说话阈 ${f(info.speechLvl)} | 静音阈 ${f(info.silenceLvl)}\n` +
          `底噪 ${f(info.noiseFloor)} | ${info.calibrated ? '已校准' : '校准中…'} | ${info.isSpeaking ? '🎙说话中' : '静默'}`;
      },
      onAsrStatus: (status) => {
        if (status === 'recording') {
          s2sStateBadge.textContent = '录音中';
        } else if (status === 'transcribing') {
          s2sStateBadge.textContent = '识别中';
        } else if (status === 'idle' && s2sSession && s2sSession.state === 'LISTENING') {
          s2sStateBadge.textContent = '聆听中';
        }
      },
      onLog: (msg) => {
        console.log('[S2S]', msg);
      },
      onError: (msg) => {
        console.error('[S2S] Error:', msg);
        s2sTranscript.innerHTML = `<span style="color:#f85149;">错误: ${escapeHtml(msg)}</span>`;
      },
    });

    await s2sSession.start();
    updateS2SPanel('LISTENING');
  }

  function stopS2S() {
    if (!s2sActive) return;
    s2sActive = false;
    s2sBtn.classList.remove('active');
    s2sPanel.classList.remove('open');
    if (s2sSession) {
      s2sSession.stop();
      s2sSession = null;
    }
    s2sVolumeFill.style.width = '0%';
    s2sBreakdown.innerHTML = '';
    s2sTranscript.innerHTML = '语音对话已结束';
    setTimeout(() => {
      if (!s2sActive) s2sTranscript.innerHTML = '点击右上角耳机按钮开启语音对话…';
    }, 2000);
  }

  s2sBtn.addEventListener('click', () => {
    if (s2sActive) stopS2S();
    else startS2S();
  });

  s2sStopBtn.addEventListener('click', stopS2S);
})();
/* ════════════════════════════════════════════════════════════════════════════
 * S2S 语音对话模式 — 结束
 * ════════════════════════════════════════════════════════════════════════════ */
