'use strict';

// ── Realtime Voice Output (TTS) Integration ──────────────────────────────────
// Provides streaming text-to-speech for AI responses
let _voiceOutputEnabled = false;
let _voiceOutputProvider = 'edge';
let _voiceOutputInstance = null;
let _ttsTextBuffer = '';
let _ttsEnabled = localStorage.getItem('voiceOutputEnabled') === 'true';

// Initialize voice output from settings
// ── 首次强制设密码门槛(绑 0.0.0.0 + 无 ACCESS_TOKEN 时,本机首次进必须设密码)──
async function enforceFirstRunPassword() {
  try {
    const r = await fetch('/api/settings/access-token');
    const d = await r.json();
    if (d.hasToken || !d.canEdit) return; // 已设密码 / 非本机(非本机进不来,无需门槛)
    showFirstRunPasswordGate();
  } catch (_) {}
}
function showFirstRunPasswordGate() {
  if (document.getElementById('firstrun-pw-gate')) return;
  const ov = document.createElement('div');
  ov.id = 'firstrun-pw-gate';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:999999;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif';
  ov.innerHTML = `<div style="background:#1c1c1e;border-radius:14px;padding:28px;max-width:380px;width:90%;color:#eee;box-shadow:0 8px 40px rgba(0,0,0,.6)">
    <h3 style="margin:0 0 8px;font-size:17px">首次使用 — 请设置访问密码</h3>
    <p style="font-size:13px;color:#999;margin:0 0 16px;line-height:1.5">本服务已对 Tailscale / 局域网开放,必须先设置访问密码。设置后,手机等外部设备凭此密码登录。</p>
    <input id="fr-pw1" type="password" placeholder="设置密码(至少 6 位)" style="width:100%;box-sizing:border-box;padding:10px 12px;margin-bottom:8px;border-radius:8px;border:1px solid #333;background:#2a2a2e;color:#eee;font-size:14px" />
    <input id="fr-pw2" type="password" placeholder="再次输入确认" style="width:100%;box-sizing:border-box;padding:10px 12px;margin-bottom:8px;border-radius:8px;border:1px solid #333;background:#2a2a2e;color:#eee;font-size:14px" />
    <div id="fr-msg" style="font-size:12px;color:#ff8a80;margin:4px 0 10px;min-height:16px"></div>
    <button id="fr-save" style="width:100%;padding:11px;border:none;border-radius:8px;background:#0a84ff;color:#fff;font-size:14px;font-weight:600;cursor:pointer">设置并开始使用</button>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => e.stopPropagation()); // 点遮罩不关闭 = 强制
  const save = async () => {
    const p1 = document.getElementById('fr-pw1').value;
    const p2 = document.getElementById('fr-pw2').value;
    const msg = document.getElementById('fr-msg');
    if (p1.length < 6) { msg.textContent = '密码至少 6 位'; return; }
    if (p1 !== p2) { msg.textContent = '两次输入不一致'; return; }
    msg.textContent = '正在设置…';
    try {
      const r = await fetch('/api/settings/access-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: p1 }) });
      const d = await r.json();
      if (!r.ok || d.error) { msg.textContent = '错误: ' + (d.error || ('HTTP ' + r.status)); return; }
      ov.remove(); // 设密码成功,解除门槛
    } catch (e) { msg.textContent = '错误: ' + e.message; }
  };
  document.getElementById('fr-save').addEventListener('click', save);
  document.getElementById('fr-pw2').addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
  document.getElementById('fr-pw1').focus();
}
document.addEventListener('DOMContentLoaded', enforceFirstRunPassword);

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

  const rawWsUrl = `ws${location.protocol.slice(4)}//${location.host}/ws/tts`;
  let wsUrl;
  try { wsUrl = await window.multiccWsUrl(rawWsUrl); }
  catch (_) { return; }

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
let _cwd = _params.get('cwd') || '';
const _sessionName = _params.get('session') || '';  // dashboard session name
const _hasNativeBridge = typeof window.MultiCCBridge !== 'undefined' && !!window.MultiCCBridge;
function tt(key, params) { return (window.t || ((k) => k))(key, params); }

function withToken(url) {
  return url;
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
const HEADER_MORE_IDS = [
  'lang-btn', 'notify-btn', 's2s-btn', 'dbg-btn', 'model-btn', 'role-btn',
  'memory-btn', 'auto-commit-btn', 'share-btn', 'clear-ctx-wrap', 'memo-btn',
];

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

// Shared Memo protocol/controller; this file keeps only the Chat-specific UI adapter.
const chatMemoClient = window.MultiCCMemo.createClient({ api: window.MultiCCApi });
const chatMemoController = window.MultiCCMemo.createController({
  client: chatMemoClient,
  document,
  requireDirectory: false,
  closeOnEscape: true,
  ui: {
    showModal: modal => modal && modal.classList.add('open'),
    hideModal: modal => modal && modal.classList.remove('open'),
    showPicker: picker => picker && picker.classList.add('open'),
    hidePicker: picker => picker && picker.classList.remove('open'),
    buttonClass: 'hdr-btn',
    buttonStyle: 'width:100%;justify-content:space-between;text-align:left;',
    previewLength: 200,
  },
});
let _memoDirId = '';

async function openMemo() {
  const modal = document.getElementById('memo-modal');
  if (!modal) return;
  if (modal.classList.contains('open')) { closeMemo(); return; }
  try {
    _memoDirId = await chatMemoClient.resolveDirectoryId({
      dirId: _memoDirId,
      sessionId: _sessionName,
    });
    if (!_memoDirId) {
      const status = document.getElementById('memo-status');
      if (status) status.textContent = '无法确定FleetID，会话可能没有归属Fleet';
      modal.classList.add('open');
      return;
    }
    await chatMemoController.openMemo(_memoDirId);
  } catch (error) {
    const status = document.getElementById('memo-status');
    if (status) status.textContent = `加载失败：${chatMemoClient.errorMessage(error)}`;
    modal.classList.add('open');
  }
}

function closeMemo() { chatMemoController.closeMemoModal(); }
function loadMemo() {
  return _memoDirId ? chatMemoController.openMemo(_memoDirId) : Promise.resolve(false);
}
const saveMemo = chatMemoController.memoSave;
const memoCurrentLineText = chatMemoController.memoCurrentLineText;
const memoOpenPicker = chatMemoController.memoSendCurrentLine;
const memoPickerClose = chatMemoController.memoPickerClose;
const memoConfirmSend = chatMemoController.memoConfirmSend;

Object.assign(window, {
  openMemo,
  closeMemo,
  loadMemo,
  saveMemo,
  memoCurrentLineText,
  memoOpenPicker,
  memoPickerClose,
  memoConfirmSend,
});

// Chat owns only button/backdrop wiring; protocol, rendering and keyboard behavior are shared.
document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('memo-modal');
  if (!modal) return;
  modal.addEventListener('click', event => { if (event.target === modal) closeMemo(); });
  document.getElementById('memo-close-btn')?.addEventListener('click', closeMemo);
  document.getElementById('memo-save-btn')?.addEventListener('click', saveMemo);
  document.getElementById('memo-send-btn')?.addEventListener('click', memoOpenPicker);
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
const cliBtn = document.getElementById('cli-btn');
const CLI_META = {
  claude: { label: 'Claude', color: '#f78166' },
  codex: { label: 'Codex', color: '#2ea043' },
  opencode: { label: 'OpenCode', color: '#388bfd' },
  zcode: { label: 'ZCode', color: '#a371f7' },
};

function applyCliUi(cli) {
  const next = CLI_META[cli] ? cli : 'claude';
  const meta = CLI_META[next];
  currentCli = next;
  _sessionCli = next;
  const badge = document.querySelector('.badge');
  if (badge) {
    badge.textContent = `${meta.label} · Chat`;
    badge.style.background = meta.color;
  }
  if (cliBtn) {
    cliBtn.textContent = `CLI: ${meta.label}`;
    cliBtn.style.borderColor = meta.color;
    cliBtn.title = `当前 ${meta.label}；点击切换 CLI（通过结构化 checkpoint 交接上下文）`;
  }
  document.title = `MultiCC Chat · ${meta.label}`;
}
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
// Pure state/usage planning lives outside the DOM host. The initial WS page is
// accepted once; older pages are fetched by the host from the returned cursor.
const chatHistoryStore = window.MultiCCChatHistoryStore.createHistoryStore();
const chatHistoryView = window.MultiCCChatHistoryView.createHistoryView({
  document,
  messagesEl,
  safeMarkdown: window.MultiCCSafeMarkdown,
  fixupLocalImages,
  highlightCodeBlocks,
  buildUsageLine,
  buildTimingLine,
  attachDeleteButton,
  attachForkButton,
  warn: (...args) => console.warn(...args),
});
let _loadingOlderSentinel = null; // DOM node inserted at top while loading, also scroll anchor
let _wasConnected = false;       // true once we've successfully opened at least one WS
let _disconnectBannerEl = null;  // in-chat sticky banner while disconnected
let _isDisconnected = false;
let _isRestarting = false;       // true while a user-triggered server restart is in progress
let _restartAt = 0;              // Date.now() when restart was hit — grace gate so we don't reconnect to the dying old server
let _disconnectEpisodeId = 0;
let _lastReconnectNoticeEpisode = 0;
let _lastInitInfoLine = '';
const chatTransport = window.MultiCCChatTransport.createTransport({
  window,
  document,
  buildUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`${proto}//${location.host}/ws/chat`);
    if (_cwd) url.searchParams.set('cwd', _cwd);
    if (_sessionName) url.searchParams.set('session', _sessionName);
    if (sessionId) url.searchParams.set('resume', sessionId);
    return url.toString();
  },
  onSocket(socket) { ws = socket; },
  onConnecting({ debugUrl }) {
    statusEl.textContent = 'Connecting...';
    statusEl.className = '';
    dbg('ws', `connect() → ${debugUrl}`);
  },
  onOpen() {
    // During a restart the OLD server stays reachable until the detached
    // child's kill -INT lands (~2s + drain). If we reconnect within the grace
    // window we've hit the old instance — drop it and keep retrying so we don't
    // flash a false "restarted" then immediately disconnect again.
    if (_isRestarting && Date.now() - _restartAt < 6000) {
      return false;
    }
    statusEl.textContent = 'Connected';
    statusEl.className = 'connected';
    statusEl.onclick = () => forceReconnect('status click');
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
    if (_isRestarting) { _isRestarting = false; addSystemMsg('✓ 服务已重启，连接已恢复'); }
    _wasConnected = true;
    // Show thinking while we wait for server's init message (which tells us real streaming state)
    if (isStreaming) showThinking();
    updateUI();
    return true;
  },
  onMessage({ data }) {
    try {
      handleEvent(JSON.parse(data));
    } catch (e) {
      console.warn('Bad message:', data, e);
    }
  },
  onClose({ event: e, seconds: secs }) {
    dbg('ws', `onclose — code=${e.code} (isStreaming=${isStreaming})`);
    if (_wasConnected && !_isDisconnected) {
      _isDisconnected = true;
      _disconnectEpisodeId++;
    }
    // Running background-task rows can't get their monitor_done on a dead socket —
    // demote them so the danmaku panel doesn't hang with a stuck spinner.
    if (typeof danmakuOnDisconnect === 'function') danmakuOnDisconnect();
    // Don't reset isStreaming here — server may still be running.
    // UI stays in streaming state so user sees "reconnecting" rather than a broken state.
    updateUI();
    statusEl.textContent = _isRestarting ? '重启中…' : `Reconnecting in ${secs}s...`;
    statusEl.className = 'error';
    statusEl.onclick = () => chatTransport.retryNow();
    // Sticky in-chat banner so the reconnect state is visible without scrolling up.
    if (_wasConnected) showDisconnectBanner(secs);
    return true;
  },
  onForceReconnect(reason) { dbg('ws', `force reconnect — ${reason}`); },
  onTicketError() {
    statusEl.textContent = '连接授权失败，正在重试…';
    statusEl.className = 'error';
    dbg('ws', 'ticket exchange failed — retry scheduled');
  },
  onEnsureAlive() { updateUI(); },
});

// Compatibility wrappers remain global for the native WebView and diagnostic
// snippets; socket ownership and retry state live exclusively in the transport.
function connect() { return chatTransport.connect(); }

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
        if (msg.cli) applyCliUi(msg.cli);
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
        if (msg.cliStates) _sessionCliStates = msg.cliStates;
        if (msg.cliAvailability) _cliAvailability = msg.cliAvailability;
        if (msg.agent !== undefined) _sessionAgent = msg.agent || '';
        _pendingCliHandoff = msg.pendingCliHandoff || null;
        // effectiveModel/model refresh unconditionally on reconnect, exactly like
        // provider/effort above — otherwise a server-side alias-map change leaves
        // the AI-config button showing the NEW provider paired with the OLD model.
        if (msg.effectiveModel !== undefined) {
          _sessionEffectiveModel = msg.effectiveModel || '';
          if (msg.model !== undefined) _sessionModel = msg.model || '';
        }
        if (msg.effort !== undefined || msg.providerName || msg.effectiveModel !== undefined || msg.providerId !== undefined || msg.agent !== undefined) {
          updateEffortBtn();
          updateModelBtn();
        }
        // Sync streaming state with server on (re)connect
        if (msg.is_streaming && _pendingCancel) {
          // User cancelled while disconnected — now that we're back, send it
          _pendingCancel = false;
          chatTransport.send({ type: 'cancel' });
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

    case 'cli_switched':
      applyCliSwitchState(msg);
      addSystemMsg(`⇄ CLI 已从 ${CLI_META[msg.fromCli]?.label || msg.fromCli} 切换到 ${CLI_META[msg.cli]?.label || msg.cli}；下一条消息会携带结构化上下文交接${msg.reusedTarget ? '并恢复该 CLI 原会话' : ''}`);
      loadSessionModel();
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

    case 'monitor_started': {
      // Background task (Monitor / run_in_background Bash) just started. Show it
      // live in the danmaku panel (see pushDanmaku) instead of a chat bubble, so
      // these ephemeral status lines don't consume chat scroll space. The task's
      // full result still arrives later via the bg-completion nudge.
      // Skip foreground (sync) Bash — the server flags those background:false
      // since their result returns via tool_result, not as a 后台任务 notice.
      // (`!== false` so an unflagged/legacy payload still shows.)
      if (msg.background === false) break;
      pushDanmaku('start', msg.description || msg.command || '后台任务', msg.task_id);
      break;
    }

    case 'monitor_done': {
      // Background task finished — resolve its danmaku row in place (spinner →
      // ✓/✗, paired by task_id). The real result is ALSO injected as a
      // continuation turn (~1.5s later via the coalescer); this is just the live
      // signal that closes the "task vanished into a void" gap.
      if (msg.background === false) break;
      const desc = msg.summary || msg.description || '后台任务';
      const kind = (msg.status === 'error' || msg.status === 'failed') ? 'fail' : 'done';
      pushDanmaku(kind, desc, msg.task_id);
      break;
    }

    case 'background_tasks':
      // Periodic background-task list refresh from the CLI. No UI action needed
      // right now (the per-task start/done events above are the useful signal);
      // explicitly handled so it is NOT silently dropped.
      break;

    case 'chat_msg_meta': {
      // Server saved a message and assigned its history id — tag the newest
      // bubble of that role (if it isn't tagged yet) so its delete button
      // goes live without waiting for a reload.
      if (msg.id && msg.role) {
        chatHistoryView.tagLatestMessage(msg.role, msg.id);
      }
      break;
    }

    case 'chat_msg_deleted': {
      // Broadcast from the server after a successful delete (from any client).
      if (msg.id) removeHistoryMessageById(msg.id);
      break;
    }

    case 'chat_history': {
      const historyPlan = chatHistoryStore.acceptHistory(msg, chatHistoryView.visibleIds());
      applyHistoryPlan(historyPlan);
      break;
    }

    case 'chat_history_reset': {
      // A clear/keep operation may originate from another browser or app.
      // Invalidate every older-page request first, then rebuild from the
      // durable newest page broadcast by the server. The initiating client
      // follows the same path so its optimistic DOM cannot drift.
      resetHistoryPagination();
      chatHistoryView.clearMessages();
      const historyPlan = chatHistoryStore.acceptHistory({
        messages: Array.isArray(msg.messages) ? msg.messages : [],
        hasMore: msg.hasMore === true,
      }, []);
      applyHistoryPlan(historyPlan);
      if ((Number(msg.keep) || 0) > 0) {
        if ((Number(msg.removedCount) || 0) > 0) {
          addSystemMsg(tt('contextKept', {
            removed: Number(msg.removedCount) || 0,
            kept: Number(msg.retainedCount) || 0,
          }));
        } else {
          addSystemMsg(tt('contextResetKept'));
        }
      } else {
        addSystemMsg(tt('contextCleared'));
      }
      break;
    }

    case 'task_state':
      // aux classify result: what the assistant thinks this session's goal/phase/state
      // is. Render into the classify bar under the header.
      // classifyState is the D/C/W/B/E/P letter — drives the dominant tint.
      renderAuxClassify(msg.goal, msg.phase, msg.classifyState);
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
      // classifyState (D/C/W/B/E/P) is the primary driver; msg.state is fallback.
      const cls = msg.classifyState || null;
      if (msg.state === 'running' || cls === 'P' || cls === 'C') {
        // In-progress summary: show a toast (even when tab is visible) but
        // don't play a sound — it's a status update, not an alert.
        showNotifyToast(msg.message || '任务进行中', 'running');
      } else {
        // Terminal verdict — use classifyState to pick voice/ding text
        const disp = _classifyDisp(cls);
        if (disp.voice) {
          speakNotify(disp.voice, disp.ding);
        } else {
          // Fallback: no classifyState → use old msg.state logic
          const waiting = msg.state === 'waiting';
          speakNotify(waiting ? '等待操作' : '任务已完成', waiting ? 'waiting' : 'completed');
        }
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
        const card = chatHistoryView.createToolCard(evt.content_block.name, evt.content_block.id);
        currentToolCards.set(evt.index, {
          card, inputJson: '', name: evt.content_block.name, id: evt.content_block.id
        });
        chatHistoryView.appendToolCard(currentMsgEl.querySelector('.msg-content'), card);
      }
      break;

    case 'content_block_delta':
      if (evt.delta?.type === 'text_delta' && evt.delta.text) {
        currentTextContent += evt.delta.text;
        renderCurrentText();
        maybeScrollToBottom();
      } else if (evt.delta?.type === 'input_json_delta' && evt.delta.partial_json) {
        const tc = currentToolCards.get(evt.index);
        if (tc) {
          tc.inputJson += evt.delta.partial_json;
          chatHistoryView.updateToolInput(tc);
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
        chatHistoryView.addToolResult(tc, text, r.is_error);
        break;
      }
    }
  }
  maybeScrollToBottom();

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
      maybeScrollToBottom();
    } else if (currentCli === 'codex' && block.type === 'tool_use' && block.id) {
      if (!currentMsgEl) currentMsgEl = createAssistantBubble();
      let tc = findCurrentToolCardById(block.id);
      if (!tc) {
        const card = chatHistoryView.createToolCard(block.name || 'Tool', block.id);
        tc = {
          card,
          inputJson: block.input ? JSON.stringify(block.input) : '',
          name: block.name || 'Tool',
          id: block.id,
        };
        currentToolCards.set(`id:${block.id}`, tc);
        chatHistoryView.appendToolCard(currentMsgEl.querySelector('.msg-content'), card);
      } else if (block.input) {
        tc.inputJson = JSON.stringify(block.input);
      }
      chatHistoryView.updateToolInput(tc);
      maybeScrollToBottom();
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
  // A turn just ended. Re-arm the unread counter so the NEXT turn (or next
  // discrete new message) can bump the "N new" pill again while the user is
  // pinned away reading history. Also nudge the view once more so the final
  // rendered bubble is visible when the user is following along.
  rearmUnread();
  maybeScrollToBottom();
}

/* ── Rendering ── */
function createAssistantBubble() {
  const div = chatHistoryView.createAssistantBubble(true);
  maybeScrollToBottom();
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
  const fs = v => v > 1e6 ? (v / 1e6).toFixed(2) + 'M' : v > 1e3 ? (v / 1e3).toFixed(1) + 'k' : v.toLocaleString('en-US');

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
      tip += `省主模型 ≈ ${n(sb.t)}（子任务代劳）\n`;
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
    if (sb) {
      html += `<span class="u-saved" title="子任务替主模型处理的 token 量（四桶总额，未走主模型）">↺省主 ${fs(sb.t)}</span>`;
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
    okBtn.className = 'btn btn-green'; okBtn.textContent = opts.okText || tt('acknowledge');
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
  btn.title = tt('msgDeleteAction');
  btn.innerHTML = '&#10005;';
  btn.onclick = async (e) => {
    e.stopPropagation();
    const go = await _chatConfirm(tt('msgDeleteConfirm'), { danger: true, okText: tt('delete') });
    if (!go) return;
    try {
      const r = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/messages/${encodeURIComponent(msgEl.dataset.msgId)}`), { method: 'DELETE' });
      if (r.ok) {
        removeHistoryMessageById(msgEl.dataset.msgId); // broadcast removal is idempotent
      } else {
        const err = await r.json().catch(() => null);
        _chatAlert(tt('msgDeleteFailed', { error: ((err && err.error) || r.status) }), { danger: true });
      }
    } catch (err) {
      _chatAlert(tt('msgDeleteFailed', { error: err.message }), { danger: true });
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
  btn.title = tt('msgForkAction');
  btn.innerHTML = '&#9741;';   // ⧉ branch symbol
  btn.onclick = async (e) => {
    e.stopPropagation();
    const go = await _chatConfirm(tt('msgForkConfirm'), { okText: tt('msgForkTitle') });
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
      _chatAlert(tt('msgForkFailed', { error: err.message }), { danger: true });
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  };
  msgEl.appendChild(btn);
}

// ── AI assistant classify bar ──
// ── Unified classify display maps (mirrors server.js CLASSIFY_DISPLAY) ──────
// Keyed by classify-state LETTER (D/C/W/B/E/P) — single source of truth for
// all frontend display: bar badge, voice, ding, toast.
const _CLASSIFY_DISPLAY = {
  D: { label: tt('classifyDone'), barTint: 'completed', voice: tt('voiceTaskCompleted'), ding: 'completed' },
  C: { label: tt('classifyContinuing'), barTint: 'running', voice: null, ding: null },
  W: { label: tt('classifyWaitingUser'), barTint: 'waiting', voice: tt('voiceWaitingAction'), ding: 'waiting' },
  B: { label: tt('classifyWaitingBackground'), barTint: 'waiting', voice: tt('voiceWaitingBackground'), ding: 'waiting' },
  E: { label: tt('classifyApiError'), barTint: 'error', voice: tt('voiceApiInterrupted'), ding: 'error' },
  P: { label: tt('classifyProcessing'), barTint: 'running', voice: null, ding: null },
};
function _classifyDisp(cls) { return _CLASSIFY_DISPLAY[cls] || _CLASSIFY_DISPLAY['W']; }

const _PHASE_LABELS = {
  planning: tt('phasePlanning'), implementing: tt('phaseImplementing'), verifying: tt('phaseVerifying'),
  wrapping: tt('phaseWrapping'), done: tt('phaseDone'),
};
function _phaseLabel(ph) { return _PHASE_LABELS[ph] || ''; }

// Renders what aux thinks this session's goal/phase/state is into #aux-classify-bar.
// classifyState (D/C/W/B/E/P) drives the dominant tint; phase is secondary.
// Hidden entirely when there's no goal.
function renderAuxClassify(goal, phase, classifyState) {
  const bar = document.getElementById('aux-classify-bar');
  if (!bar) return;
  const g = (goal || '').trim();
  if (!g) { bar.classList.remove('show'); return; }
  const goalEl = document.getElementById('ac-goal');
  const phaseEl = document.getElementById('ac-phase');
  const stateEl = document.getElementById('ac-state');
  if (goalEl) { goalEl.textContent = g; goalEl.title = g; }
  // Phase badge (secondary, rightmost) — show only when phase is meaningful
  const ph = (phase || '').toLowerCase();
  if (phaseEl) {
    phaseEl.textContent = _phaseLabel(ph) || '';
    phaseEl.style.display = _phaseLabel(ph) ? '' : 'none';
  }
  // State badge (primary, left of phase) — driven by classifyState letter
  const cls = classifyState || 'P';
  const disp = _classifyDisp(cls);
  bar.classList.remove('lc-running', 'lc-completed', 'lc-waiting', 'lc-interrupted',
    'st-running', 'st-completed', 'st-waiting', 'st-error');
  if (stateEl) {
    stateEl.textContent = disp.label;
    stateEl.style.display = '';
  }
  bar.classList.add('st-' + disp.barTint);
  bar.classList.add('show');
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
  return chatHistoryView.renderCurrentText(currentMsgEl, currentTextContent, {
    final,
    streaming: isStreaming,
  });
}

function highlightCodeBlocks(root) {
  const highlighter = window.hljs;
  if (!highlighter || typeof highlighter.highlightElement !== 'function') return;
  root.querySelectorAll('pre code').forEach(block => {
    try { highlighter.highlightElement(block); } catch (_) {}
  });
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
  forceScrollToBottom();
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
  maybeScrollToBottom();
}

function addSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg system-msg';
  div.textContent = text;
  messagesEl.appendChild(div);
  maybeScrollToBottom();
}

/* ── Background-task danmaku panel ──
 * Live "bullet-comment" feed for Monitor / run_in_background task start & done
 * notices. Replaces the old addSystemMsg chat bubbles so these ephemeral status
 * lines stop consuming chat scroll space. Newest row slides in at the top; a
 * start row shows a spinner and resolves in-place to ✓/✗ when the matching
 * monitor_done lands (paired by task_id). The panel is display:none when empty,
 * auto-hides 5s after every row goes terminal, and collapses to a count pill.
 * All text goes through textContent — task descriptions are agent-authored and
 * must never be treated as HTML. */
const DANMAKU_MAX_ROWS = 8;
const DANMAKU_AUTOHIDE_MS = 5000;
// Watchdog: a 'start' row that never gets a matching monitor_done (server crash,
// WS disconnect, or a genuinely hung task) would otherwise keep _danmakuHasRunning
// true forever and pin the panel on screen with a stuck spinner. After this idle
// it is demoted to a muted 'stale' state so the panel can auto-hide. Long enough
// not to prematurely resolve normal multi-minute background tasks.
const DANMAKU_STALE_MS = 180000; // 3 min
let _danmakuCollapsed = false;
let _danmakuHideTimer = null;
let _danmakuFadeTimer = null;
let _danmakuInited = false;
const _danmakuRows = new Map(); // key(task_id) -> { el, txtEl, icEl, state, staleTimer }

function _dmEls() {
  return {
    panel: document.getElementById('danmaku-panel'),
    head:  document.getElementById('danmaku-head'),
    body:  document.getElementById('danmaku-body'),
    title: document.getElementById('danmaku-title'),
    count: document.getElementById('danmaku-count'),
    dot:   document.getElementById('danmaku-dot'),
    btn:   document.getElementById('danmaku-collapse-btn'),
  };
}

function initDanmakuPanel() {
  if (_danmakuInited) return;
  const e = _dmEls();
  if (!e.panel) return;
  _danmakuInited = true;
  e.btn.addEventListener('click', (ev) => { ev.stopPropagation(); toggleDanmakuCollapse(); });
  // Tapping anywhere on the collapsed pill re-expands it.
  e.head.addEventListener('click', () => { if (_danmakuCollapsed) toggleDanmakuCollapse(); });
}

function _danmakuHasRunning() {
  for (const r of _danmakuRows.values()) if (r.state === 'start') return true;
  return false;
}

function _danmakuRefreshMeta() {
  const e = _dmEls();
  if (!e.panel) return;
  e.dot.className = _danmakuHasRunning() ? 'dm-dot-running' : 'dm-dot-idle';
  e.count.textContent = (_danmakuCollapsed || !_danmakuRows.size) ? '' : String(_danmakuRows.size);
  e.title.textContent = _danmakuCollapsed ? `${_danmakuRows.size} 后台任务` : '后台任务';
}

function _danmakuShow() {
  const e = _dmEls();
  if (!e.panel) return;
  clearTimeout(_danmakuFadeTimer);
  e.panel.style.display = 'flex';
  e.panel.style.opacity = '1';
}

function _danmakuScheduleHide() {
  clearTimeout(_danmakuHideTimer);
  _danmakuHideTimer = null;
  if (_danmakuCollapsed) return;      // pinned open as a pill until user expands
  if (_danmakuHasRunning()) return;   // keep visible while any task is still running
  _danmakuHideTimer = setTimeout(() => {
    const e = _dmEls();
    if (!e.panel) return;
    e.panel.style.opacity = '0';
    _danmakuFadeTimer = setTimeout(() => {
      e.panel.style.display = 'none';
      for (const r of _danmakuRows.values()) clearTimeout(r.staleTimer); // no leaked watchdogs
      _danmakuRows.clear();           // fresh slate for the next burst
      if (e.body) e.body.textContent = '';
      _danmakuRefreshMeta();
    }, 320);
  }, DANMAKU_AUTOHIDE_MS);
}

function _danmakuSetRowState(row, state) {
  // Any transition disarms the previous watchdog; a fresh 'start' re-arms it.
  clearTimeout(row.staleTimer);
  row.staleTimer = null;
  row.state = state;
  row.el.className = 'dm-row dm-' + state;
  row.icEl.className = 'dm-ic';
  if (state === 'start') {
    row.icEl.textContent = '';
    const sp = document.createElement('span');
    sp.className = 'dm-spin';
    row.icEl.appendChild(sp);
    row.staleTimer = setTimeout(() => {
      if (row.state !== 'start') return;        // resolved in the meantime
      _danmakuSetRowState(row, 'stale');         // stop blocking auto-hide
      _danmakuRefreshMeta();
      _danmakuScheduleHide();
    }, DANMAKU_STALE_MS);
  } else if (state === 'stale') {
    row.icEl.textContent = '·';                  // muted: outcome unknown (never reported)
  } else {
    row.icEl.textContent = state === 'fail' ? '✗' : '✓'; // ✗ / ✓
  }
}

// Called when the WebSocket drops: a running task's monitor_done can never arrive
// on the dead socket, so demote every 'start' row to 'stale' now instead of waiting
// out the full watchdog. Lets the panel auto-hide promptly on disconnect.
function danmakuOnDisconnect() {
  if (!_danmakuRows.size) return;
  let changed = false;
  for (const r of _danmakuRows.values()) {
    if (r.state === 'start') { _danmakuSetRowState(r, 'stale'); changed = true; }
  }
  if (changed) { _danmakuRefreshMeta(); _danmakuScheduleHide(); }
}

// kind: 'start' | 'done' | 'fail'; desc: task text; taskId: server msg.task_id (pairing key)
function pushDanmaku(kind, desc, taskId) {
  initDanmakuPanel();
  const e = _dmEls();
  if (!e.panel) return;
  const text = (desc && String(desc).trim()) || '后台任务';
  const key = taskId ? 't:' + taskId : 'd:' + text;   // fall back to desc when no id

  const existing = _danmakuRows.get(key);
  if (existing) {
    if (kind === 'start') { _danmakuShow(); return; }  // duplicate start → ignore
    _danmakuSetRowState(existing, kind);               // done/fail resolves the row in place
    existing.txtEl.textContent = text;
    _danmakuRefreshMeta();
    _danmakuShow();
    _danmakuScheduleHide();
    return;
  }

  // New row — evict the oldest first if we are at the cap.
  if (_danmakuRows.size >= DANMAKU_MAX_ROWS) {
    const oldestKey = _danmakuRows.keys().next().value;
    const oldest = _danmakuRows.get(oldestKey);
    if (oldest) {
      clearTimeout(oldest.staleTimer);
      if (oldest.el.parentNode) oldest.el.parentNode.removeChild(oldest.el);
    }
    _danmakuRows.delete(oldestKey);
  }

  const row = document.createElement('div');
  const ic = document.createElement('span');
  const txt = document.createElement('span');
  txt.className = 'dm-txt';
  txt.textContent = text;
  row.appendChild(ic);
  row.appendChild(txt);
  const rec = { el: row, txtEl: txt, icEl: ic, state: kind };
  _danmakuSetRowState(rec, kind);
  e.body.prepend(row);                 // newest at the top → live-feed feel
  _danmakuRows.set(key, rec);

  _danmakuShow();
  _danmakuRefreshMeta();
  _danmakuScheduleHide();
}

function toggleDanmakuCollapse() {
  const e = _dmEls();
  if (!e.panel) return;
  _danmakuCollapsed = !_danmakuCollapsed;
  e.panel.classList.toggle('dm-collapsed', _danmakuCollapsed);
  e.btn.textContent = _danmakuCollapsed ? '▸' : '▾'; // ▸ / ▾
  _danmakuRefreshMeta();
  if (_danmakuCollapsed) {
    clearTimeout(_danmakuHideTimer);   // stay visible as a pill
    _danmakuShow();
  } else {
    _danmakuScheduleHide();
  }
}

function showDisconnectBanner(secs) {
  if (_isRestarting) return;  // during a restart we show a dedicated status, not the disconnect banner
  if (!_disconnectBannerEl) {
    _disconnectBannerEl = document.createElement('div');
    _disconnectBannerEl.className = 'msg system-msg disconnect-banner';
    _disconnectBannerEl.onclick = () => chatTransport.retryNow();
    messagesEl.appendChild(_disconnectBannerEl);
  }
  _disconnectBannerEl.textContent = `⚠️ 连接断开，${secs}s 后自动重连（点此立即重试）`;
  maybeScrollToBottom();
}

function removeHistoryMessageById(id) {
  const element = chatHistoryView.findById(id);
  const nextOldest = chatHistoryStore.snapshot().oldestMessageId === id
    ? chatHistoryView.nextVisibleId(id)
    : null;
  if (element) {
    if (currentMsgEl === element) {
      currentMsgEl = null;
      currentTextContent = '';
      currentToolCards = new Map();
    }
    chatHistoryView.removeById(id);
  }
  chatHistoryStore.deleteMessage(id, nextOldest);
}

function resetHistoryPagination() {
  chatHistoryStore.reset();
  messagesEl.querySelector('.history-start-hint')?.remove();
  if (_loadingOlderSentinel?.parentNode) _loadingOlderSentinel.remove();
}

/* ── Apply initial/reconnect history without duplicating persisted DOM ── */
function applyHistoryPlan(plan) {
  const viewPlan = chatHistoryView.applyPlan(plan, {
    currentElement: currentMsgEl,
    lastUserElement: _lastUserBubble,
  });
  currentMsgEl = viewPlan.currentElement;
  _lastUserBubble = viewPlan.lastUserElement;

  // A reconnect refreshes authoritative totals even when they are zero. When
  // no aggregate is provided, only the initial page may reconstruct totals;
  // a partial reconnect page must not reduce an already accumulated session.
  if (plan.hasAuthoritativeUsage || plan.mode === 'initial') {
    _sessionTokens = { ...plan.sessionTokens };
  }
  _usedTokens = plan.usedTokens;
  updateContextBar();

  if (viewPlan.streamingTail) {
    const tail = viewPlan.streamingTail;
    if (tail.element) {
      isStreaming = true;
      currentMsgEl = tail.element;
      currentTextContent = tail.content;
      currentToolCards = tail.toolCards;
      hideThinking();
      startTitleAnimation();
      updateUI();
    }
  } else {
    isStreaming = false;
    currentMsgEl = null;
    currentTextContent = '';
    currentToolCards = new Map();
    hideThinking();
    stopTitleAnimation();
    updateUI();
  }

  forceScrollToBottom();
  setTimeout(forceScrollToBottom, 300);
  setTimeout(() => autofillHistory(4), 0);
}

/* ── Thinking bubble ── */
let thinkingEl = null;

function showThinking() {
  if (thinkingEl) { dbg('think', 'showThinking() — 已在显示，忽略'); return; }
  thinkingEl = document.createElement('div');
  thinkingEl.className = 'thinking-bubble';
  thinkingEl.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div> Thinking...';
  messagesEl.appendChild(thinkingEl);
  maybeScrollToBottom();
  dbg('think', 'showThinking() — 气泡已显示');
}

function hideThinking() {
  if (thinkingEl) {
    thinkingEl.remove();
    thinkingEl = null;
    dbg('think', 'hideThinking() — 气泡已移除');
  }
}

/* ── Composer compatibility surface ──
 * Message sending, attachments, keyboard/touch bindings and voice input are
 * owned by chat-composer.js. These wrappers preserve the classic globals used
 * by Goal mode, the native WebView bridge and older diagnostic snippets. */
let chatComposer = null;
function newClientMsgId() { return window.MultiCCChatComposer.defaultClientMessageId(); }
function send(opts = {}) { return chatComposer?.send(opts); }
function cancelStreaming() { return chatComposer?.cancelStreaming(); }
function updateAttachArea() { return chatComposer?.updateAttachArea(); }
function uploadFile(file) { return chatComposer?.uploadFile(file); }
function openLightbox(src, name) { return chatComposer?.openLightbox(src, name); }
function closeLightbox() { return chatComposer?.closeLightbox(); }
function startRecording() { return chatComposer?.startRecording(); }
function stopRecording() { return chatComposer?.stopRecording(); }
function uploadAudioForSTT(blob) { return chatComposer?.uploadAudioForSTT(blob); }
function startStreamingVoice() { return chatComposer?.startStreamingVoice(); }
function commitStreamingVoice() { return chatComposer?.commitStreamingVoice(); }
function cancelStreamingVoice() { return chatComposer?.cancelStreamingVoice(); }
function showVoicePanel(raw) { return chatComposer?.showVoicePanel(raw); }
function closeVoicePanel() { return chatComposer?.closeVoicePanel(); }
function useVoiceText(text) { return chatComposer?.useVoiceText(text); }
function fetchRefined(raw) { return chatComposer?.fetchRefined(raw); }

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

/* ── Scroll state machine ──
 * The chat auto-follows the latest message ONLY when the user is already at
 * the bottom. The moment the user scrolls up to read history, auto-follow
 * stops (userPinnedAway=true) so the view stays put while new tokens stream
 * in. A floating "↓ N new" pill then appears; clicking it (or scrolling back
 * to the bottom) resumes auto-follow. This stops the view from being yanked
 * to the bottom on every streaming token while the user is reading history. */
const SCROLL_BOTTOM_THRESHOLD = 48;  // px from bottom counts as "at bottom"
let _userPinnedAway = false;         // user scrolled up, don't auto-follow
let _unreadCount = 0;                // new messages accumulated while pinned away
let _newMsgPillEl = null;

function isAtBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < SCROLL_BOTTOM_THRESHOLD;
}

function scrollToBottom() {
  requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
}

// Always scroll to bottom AND reset the pinned-away state (used after the
// user's own actions: sending a message, first load / reconnect). Sets a brief
// settling window so the scroll events fired DURING this programmatic scroll
// don't get misread as the user scrolling away (which would falsely arm the
// unread pill on initial load / reconnect stream replay).
let _scrollSettlingUntil = 0;
function forceScrollToBottom() {
  _userPinnedAway = false;
  _unreadCount = 0;
  hideNewMsgPill();
  _scrollSettlingUntil = Date.now() + 250;
  scrollToBottom();
}

// Auto-follow only if already at the bottom. Otherwise stay put and bump the
// unread counter so the pill reflects new messages waiting. Used by every
// passive content event (streaming tokens, tool results, system msgs, ...).
function maybeScrollToBottom() {
  if (!_userPinnedAway && isAtBottom()) {
    scrollToBottom();
  } else {
    // Don't bump unread on every streaming frame - only count it once per
    // "pinned-away episode" via _streamUnreadArmed, re-armed when the turn
    // ends or the pill is dismissed. See bumpUnread().
    bumpUnread();
  }
}

let _streamUnreadArmed = true;  // armed at turn start; one bump per turn while away
function bumpUnread() {
  if (Date.now() < _scrollSettlingUntil) return;  // ignore noise during programmatic scroll-to-bottom
  if (!_userPinnedAway) return;
  if (!_streamUnreadArmed) return;
  _streamUnreadArmed = false;
  _unreadCount++;
  showNewMsgPill();
}
// Re-arm so the next assistant turn (or next discrete new message) can bump again.
function rearmUnread() { _streamUnreadArmed = true; }

function showNewMsgPill() {
  if (!_newMsgPillEl) {
    _newMsgPillEl = document.createElement('button');
    _newMsgPillEl.id = 'new-msg-pill';
    _newMsgPillEl.className = 'new-msg-pill';
    _newMsgPillEl.innerHTML = '<span class="new-msg-pill-text">↓ 新消息</span>';
    _newMsgPillEl.onclick = () => { forceScrollToBottom(); };
    // Insert into the #messages container (pill is position:absolute within it)
    messagesEl.appendChild(_newMsgPillEl);
  }
  _newMsgPillEl.querySelector('.new-msg-pill-text').textContent =
    _unreadCount > 0 ? `↓ ${_unreadCount} 条新消息` : '↓ 新消息';
  _newMsgPillEl.classList.add('show');
}

function hideNewMsgPill() {
  if (_newMsgPillEl) _newMsgPillEl.classList.remove('show');
}

// Track the user's scroll position to drive userPinnedAway.
messagesEl.addEventListener('scroll', () => {
  // Ignore scroll events fired while we're programmatically scrolling to the
  // bottom (initial load / reconnect / after user sends) - they'd otherwise
  // mark the user as "pinned away" mid-scroll and arm the unread pill.
  if (Date.now() < _scrollSettlingUntil) return;
  if (isAtBottom()) {
    // User scrolled back to the bottom -> resume auto-follow, clear unread.
    _userPinnedAway = false;
    _unreadCount = 0;
    hideNewMsgPill();
  } else {
    _userPinnedAway = true;
  }
}, { passive: true });

/* ── Lazy history: fetch older messages when the user scrolls to the top ── */
const HISTORY_LOAD_THRESHOLD = 80;  // px from top triggers a fetch

function _renderHistoryPageBefore(messages) {
  return chatHistoryView.prependMessages(messages);
}

async function loadOlderHistory() {
  const request = chatHistoryStore.beginOlder();
  if (!request) return 0;
  // Show a loading hint at the very top.
  if (!_loadingOlderSentinel) {
    _loadingOlderSentinel = document.createElement('div');
    _loadingOlderSentinel.className = 'msg system-msg history-loading-hint';
    _loadingOlderSentinel.textContent = '… 加载更早的消息';
  }
  if (!_loadingOlderSentinel.parentNode) {
    messagesEl.insertBefore(_loadingOlderSentinel, messagesEl.firstElementChild);
  }
  try {
    const url = withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/history?before=${encodeURIComponent(request.before)}&limit=${request.limit}`);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    // Validate generation/request identity before touching DOM. A response
    // that raced a reconnect, clear or cursor deletion is discarded.
    const pagePlan = chatHistoryStore.completeOlder(request, d);
    if (pagePlan.stale) return 0;
    return _renderHistoryPageBefore(pagePlan.messages);
  } catch (e) {
    chatHistoryStore.rejectOlder(request);
    dbg('history', `loadOlderHistory failed: ${e.message}`);
    // Don't mark exhausted on a transient error - let the user retry by scrolling.
    return 0;
  } finally {
    if (_loadingOlderSentinel && _loadingOlderSentinel.parentNode) {
      _loadingOlderSentinel.remove();
    }
    if (chatHistoryStore.snapshot().exhausted && !messagesEl.querySelector('.history-start-hint')) {
      const hint = document.createElement('div');
      hint.className = 'msg system-msg history-start-hint';
      hint.textContent = '— 已是最早消息 —';
      messagesEl.insertBefore(hint, messagesEl.firstElementChild);
    }
  }
}

async function autofillHistory(maxPages = 4) {
  const startingGeneration = chatHistoryStore.snapshot().generation;
  for (let page = 0; page < maxPages; page += 1) {
    const state = chatHistoryStore.snapshot();
    if (state.generation !== startingGeneration || state.exhausted || !state.hasMore) return;
    if (messagesEl.scrollHeight > messagesEl.clientHeight + HISTORY_LOAD_THRESHOLD) return;
    const inserted = await loadOlderHistory();
    if (!inserted) return;
  }
}

messagesEl.addEventListener('scroll', () => {
  if (messagesEl.scrollTop <= HISTORY_LOAD_THRESHOLD) {
    loadOlderHistory();
  }
}, { passive: true });


function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '...' : s;
}

function mergeStatusText(st) {
  if (!st || (!st.mergeReady && !(st.dirty || st.ahead > 0))) return tt('worktreeClean');
  // Dirty/ahead exist but merge is blocked — show why.
  if (!st.mergeReady && !st.baseCheckedOut) {
    return tt('mergeBlockedBranch', { base: st.baseBranch || 'main' });
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
    title.textContent = tt('mergeTitle');
    title.style.cssText = 'padding:14px 16px;border-bottom:1px solid #20242b;font-size:15px;font-weight:700;color:#f2f4f7;';
    const body = document.createElement('div');
    body.textContent = message;
    body.style.cssText = 'padding:16px;white-space:pre-wrap;font-size:13px;line-height:1.55;color:#c9d1d9;';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid #20242b;';
    const cancel = document.createElement('button');
    cancel.textContent = tt('cancel');
    cancel.style.cssText = 'border:1px solid #30363d;background:#161b22;color:#c9d1d9;border-radius:7px;padding:7px 13px;font-weight:700;cursor:pointer;';
    const ok = document.createElement('button');
    ok.textContent = tt('merge');
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
    input.placeholder = tt('sessionAliasHint');
    body.append(input);
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid #20242b;';
    const cancel = document.createElement('button');
    cancel.textContent = tt('cancel');
    cancel.style.cssText = 'border:1px solid #30363d;background:#161b22;color:#c9d1d9;border-radius:7px;padding:7px 13px;font-weight:700;cursor:pointer;';
    const ok = document.createElement('button');
    ok.textContent = tt('save');
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
  if (!_sessionName) { addSystemMsg(tt('sessionIdMissing')); return; }
  let current = _sessionName;
  try {
    const r = await fetch(withToken('/api/sessions'));
    const arr = (await r.json()) || [];
    const list = Array.isArray(arr) ? arr : (arr.sessions || []);
    const s = list.find(x => x.id === _sessionName);
    if (s && s.label) current = s.label;
  } catch (_) {}
  const next = await promptInPage(tt('renameSessionTitle'), current);
  if (next === null) return;
  if (next.length > 80) { addSystemMsg(tt('nameTooLong', { n: 80 })); return; }
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: next }),
    });
    const data = await res.json();
    if (!res.ok) { addSystemMsg(tt('renameSessionFailed', { error: data.error || `HTTP ${res.status}` })); return; }
    addSystemMsg(next ? `${tt('renameSessionSaved')}: ${next}` : tt('sessionNameReset'));
    await loadSessionIdentity();
  } catch (e) {
    addSystemMsg(tt('renameSessionFailed', { error: e.message }));
  }
}

async function requestMerge() {
  if (!_sessionName) { addSystemMsg(tt('sessionIdMissing')); return; }
  const prompt = _mergeReady
    ? tt('mergeWorktreeConfirmReady')
    : tt('mergeWorktreeConfirm');
  if (!await confirmInPage(prompt)) return;
  addSystemMsg(tt('mergingWorktree'));
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/merge`), { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      addSystemMsg(data.merged
        ? `✓ 已合并 ${data.commits} 个提交回基分支${data.committed ? '（含本次自动提交）' : ''}${data.syncedBack ? '，并已自动把基分支同步回本 worktree' : ''}`
        : tt('mergedNothing', { msg: data.message || tt('worktreeClean') }));
      applyMergeStatus({ mergeReady: false, dirty: false, ahead: 0 });
      // Auto-sync may have changed the behind count — re-fetch real state.
      refreshMergeStatus();
    } else if (res.status === 409) {
      addSystemMsg(tt('mergeConflict', { files: (data.conflicts || []).join(', ') }));
    } else {
      addSystemMsg(tt('mergeFailed', { error: data.error || `HTTP ${res.status}` }));
    }
  } catch (e) {
    addSystemMsg(tt('mergeRequestFailed', { error: e.message }));
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

/* ── Cross-CLI switch (one logical chat, independent native sessions) ── */
function showCliSwitchPicker(current, states, availability) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;width:460px;max-width:94vw;color:#c9d1d9;box-shadow:0 18px 60px rgba(0,0,0,.45);';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:17px;font-weight:700;margin-bottom:8px;';
    title.textContent = '切换 CLI';
    const desc = document.createElement('div');
    desc.style.cssText = 'font-size:12px;color:#8b949e;line-height:1.65;margin-bottom:14px;';
    desc.textContent = '切换后，目标 CLI 会接着当前任务继续工作。每个 CLI 的原对话都会单独保留。';
    const select = document.createElement('select');
    select.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:7px;color:#c9d1d9;font-size:14px;padding:9px 10px;outline:none;margin-bottom:10px;';
    for (const [value, meta] of Object.entries(CLI_META)) {
      const state = states && states[value];
      const installed = availability?.[value]?.available !== false;
      const opt = document.createElement('option');
      opt.value = value;
      opt.disabled = !installed && value !== current;
      opt.textContent = `${meta.label}${value === current ? '（当前）' : ''}${installed ? (state?.hasNativeSession ? ' · 继续上次对话' : ' · 开始新对话') : ' · 未安装'}`;
      select.appendChild(opt);
    }
    select.value = current;
    const targetInfo = document.createElement('div');
    targetInfo.style.cssText = 'min-height:34px;font-size:12px;color:#8b949e;line-height:1.5;margin-bottom:8px;';
    const resetRow = document.createElement('label');
    resetRow.style.cssText = 'display:flex;align-items:flex-start;gap:8px;font-size:12px;color:#c9d1d9;background:#0d1117;border:1px solid #30363d;border-radius:7px;padding:9px;margin-bottom:14px;cursor:pointer;';
    const reset = document.createElement('input');
    reset.type = 'checkbox';
    reset.style.marginTop = '2px';
    const resetText = document.createElement('span');
    resetText.textContent = '重新开始目标 CLI（仅在切换后无法继续时勾选，当前任务信息会保留）';
    resetRow.append(reset, resetText);
    const updateInfo = () => {
      const state = states && states[select.value];
      targetInfo.textContent = state?.hasNativeSession
        ? `将继续 ${CLI_META[select.value].label} 上次的对话，并带上切换后新增的内容。`
        : `将打开新的 ${CLI_META[select.value].label} 对话，并带上当前任务信息。`;
    };
    select.onchange = updateInfo;
    updateInfo();
    const warning = document.createElement('div');
    warning.style.cssText = 'font-size:12px;color:#d29922;line-height:1.55;margin-bottom:14px;';
    warning.textContent = '请在当前回复结束后切换。如果无法继续，请勾选上面的“重新开始”后再试。';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.style.cssText = 'background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:7px 15px;cursor:pointer;';
    const ok = document.createElement('button');
    ok.textContent = '确认切换';
    ok.style.cssText = 'background:#238636;border:1px solid #2ea043;border-radius:6px;color:#fff;font-size:13px;padding:7px 15px;cursor:pointer;';
    row.append(cancel, ok);
    box.append(title, desc, select, targetInfo, resetRow, warning, row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const close = (value) => { overlay.remove(); resolve(value); };
    cancel.onclick = () => close(null);
    ok.onclick = () => close({ cli: select.value, fresh: reset.checked });
    overlay.onclick = (event) => { if (event.target === overlay) close(null); };
  });
}

cliBtn?.addEventListener('click', async () => {
  if (!_sessionName) return;
  await loadSessionModel();
  const picked = await showCliSwitchPicker(_sessionCli, _sessionCliStates, _cliAvailability);
  if (!picked || (picked.cli === _sessionCli && !picked.fresh)) return;
  cliBtn.disabled = true;
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/switch-cli`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(picked),
    });
    const data = await res.json();
    if (!res.ok) {
      addSystemMsg('CLI 切换失败：' + (data.error || `HTTP ${res.status}`));
      return;
    }
    _sessionCliStates = data.cliStates || _sessionCliStates;
    _cliAvailability = data.cliAvailability || _cliAvailability;
    applyCliSwitchState(data);
    await loadSessionModel();
  } catch (error) {
    addSystemMsg('CLI 切换失败：' + error.message);
  } finally {
    cliBtn.disabled = false;
  }
});

/* ── Per-session model switch ── */
const modelBtn = document.getElementById('model-btn');
// CLAUDE_MODEL_OPTIONS + modelShortName live in shared/models.js (loaded before chat.js).
let _sessionModel = '';        // raw per-session override (null/'' = follow default)
let _sessionEffectiveModel = ''; // model actually used at spawn time (for display)
const effortBtn = document.getElementById('effort-btn');
let _sessionEffort = '';
let _sessionEffectiveEffort = '';

function chatAiConfigState() {
  return {
    cli: _sessionCli,
    providers: _providerList,
    defaults: _providerDefaults,
    providerDisplayName: _sessionProviderDisplayName,
    claudeModelOptions: CLAUDE_MODEL_OPTIONS,
    translate: tt,
    modelShortName,
    aliasTiersFromMap,
    formatAliasTierLabel,
    document,
  };
}

// Global compatibility delegates: callers keep the historic chat.js function
// names while policy and picker DOM live in chat-ai-config.js.
function defaultEffortForCurrentCli() {
  return window.MultiCCChatAiConfig.defaultEffort(_sessionCli);
}

function effortOptionsForCurrentCli() {
  return window.MultiCCChatAiConfig.effortOptions(_sessionCli);
}

function effortLabelForCurrentCli() {
  return window.MultiCCChatAiConfig.effortLabel(_sessionCli);
}

function effortShortName(effort) {
  return window.MultiCCChatAiConfig.effortShortName(_sessionCli, effort);
}

function providerModelOptions(providerId) {
  return window.MultiCCChatAiConfig.providerModelOptions(providerId, chatAiConfigState());
}

function providerAliasMap(providerId) {
  return window.MultiCCChatAiConfig.providerAliasMap(providerId, chatAiConfigState());
}

function providerAliasTiers(providerId) {
  return window.MultiCCChatAiConfig.providerAliasTiers(providerId, chatAiConfigState());
}

function normalizeModelForProvider(providerId, model) {
  return window.MultiCCChatAiConfig.normalizeModel(providerId, model, chatAiConfigState());
}

function buildModelChoices(providerId) {
  return window.MultiCCChatAiConfig.buildModelChoices(providerId, chatAiConfigState());
}

function stripModelSuffixUi(model) {
  return window.MultiCCChatAiConfig.stripModelSuffix(model);
}

function defaultModelChoiceForProvider(providerId) {
  return window.MultiCCChatAiConfig.defaultModelChoice(providerId, chatAiConfigState());
}

function modelChoiceLabel(value, providerId) {
  return window.MultiCCChatAiConfig.modelChoiceLabel(value, providerId, chatAiConfigState());
}

function modelDisplayName(model, providerId) {
  return window.MultiCCChatAiConfig.modelDisplayName(model, providerId, chatAiConfigState());
}

function showEffortPicker(current) {
  return window.MultiCCChatAiConfig.showEffortPicker(current, {
    cli: _sessionCli,
    document,
  });
}

function showAIConfigPicker(config) {
  return window.MultiCCChatAiConfig.showAIConfigPicker(config, chatAiConfigState());
}

function updateModelBtn() {
  if (!modelBtn) return;
  const shown = _sessionEffectiveModel || _sessionModel;
  const provider = (_sessionProvider ? providerShortName(_sessionProvider) : '')
    || _sessionProviderDisplayName
    || tt('default');
  const model = shown ? modelDisplayName(shown, _sessionProvider) : tt('default');
  const effort = effortShortName(_sessionEffectiveEffort || _sessionEffort);
  const agent = (_sessionCli === 'claude' || _sessionCli === 'opencode') && _sessionAgent
    ? `Agent ${_sessionAgent}`
    : '';
  modelBtn.textContent = `🧠 ${[provider, model, effort, agent].filter(Boolean).join(' | ')}`;
  modelBtn.style.display = '';
}

function updateEffortBtn() {
  if (!effortBtn) return;
  effortBtn.style.display = 'none';
  updateModelBtn();
}

async function loadSessionModel() {
  if (!_sessionName) return;
  try {
    const info = await window.MultiCCChatAiConfig.loadSession(_sessionName);
    // Role prompt applies to every cli; load it first, then the claude-only model.
    _sessionRole = info.rolePrompt || '';
    updateRoleBtn();
    _sessionMemory = memoryToText(info.memory);
    updateMemoryBtn();
    // Provider switch applies to every cli (claude & codex both have providers).
    applyCliUi(info.cli || 'claude');
    _sessionCliStates = info.cliStates || {};
    _cliAvailability = info.cliAvailability || _cliAvailability;
    _pendingCliHandoff = info.pendingCliHandoff || null;
    _sessionProvider = info.provider || '';
    _sessionProviderDisplayName = '';
    _sessionSubagent = info.subagent || null;
    _sessionAgent = info.agent || '';
    updateSubagentPill();
    if (_sessionProvider) await ensureProviderList(_sessionCli === 'codex' ? 'codex' : 'claude');
    updateProviderBtn();
    _sessionModel = info.model || '';
    _sessionEffectiveModel = info.effectiveModel || info.model || '';
    _sessionEffort = info.effort || '';
    _sessionEffectiveEffort = info.effectiveEffort || _sessionEffort || defaultEffortForCurrentCli();
    updateModelBtn();
    updateEffortBtn();
    _sessionAutoCommit = !!info.autoCommit;
    updateAutoCommitBtn();
    _sessionAutoDispatch = !!info.autoDispatch;
    updateAutoDispatchCheck();
  } catch (_) {}
}

modelBtn?.addEventListener('click', async () => {
  // 每次打开前重新拉取一次会话配置，避免重连/加载未完成时弹窗显示默认值。
  await loadSessionModel();
  await ensureProviderList(_sessionCli === 'codex' ? 'codex' : 'claude', { loading: true });
  const picked = await showAIConfigPicker({
    provider: _sessionProvider,
    model: _sessionModel,
    effort: _sessionEffectiveEffort || _sessionEffort || defaultEffortForCurrentCli(),
    subagent: _sessionSubagent,
    agent: _sessionAgent,
  });
  if (picked === null) return;
  try {
    const data = await window.MultiCCChatAiConfig.saveSession(_sessionName, {
      provider: picked.provider,
      model: picked.model,
      effort: picked.effort,
      ...((_sessionCli === 'claude' || _sessionCli === 'opencode') ? { agent: picked.agent } : {}),
      ...((_sessionCli === 'claude' || _sessionCli === 'codex') ? { subagent: picked.subagent } : {}),
    });
    _sessionProvider = data.provider || '';
    _sessionSubagent = data.subagent || null;
    _sessionAgent = data.agent || '';
    updateSubagentPill();
    _sessionModel = data.model || '';
    _sessionEffectiveModel = data.effectiveModel || data.model || '';
    _sessionEffort = data.effort || '';
    _sessionEffectiveEffort = data.effectiveEffort || _sessionEffort || defaultEffortForCurrentCli();
    updateModelBtn();
    const _savedModel = _sessionEffectiveModel || _sessionModel;
    const savedParts = [providerShortName(_sessionProvider), _savedModel ? modelDisplayName(_savedModel, _sessionProvider) : tt('default'), effortShortName(_sessionEffectiveEffort)];
    if ((_sessionCli === 'claude' || _sessionCli === 'opencode') && _sessionAgent) savedParts.push(`Agent ${_sessionAgent}`);
    addSystemMsg(`✓ AI 配置已保存：${savedParts.filter(Boolean).join(' | ')}，下一轮对话生效`);
  } catch (e) {
    addSystemMsg('AI 配置保存失败：' + e.message);
  }
});

effortBtn?.addEventListener('click', async () => {
  const picked = await showEffortPicker(_sessionEffectiveEffort || _sessionEffort || defaultEffortForCurrentCli());
  if (picked === null) return;
  try {
    const data = await window.MultiCCChatAiConfig.saveSession(_sessionName, { effort: picked });
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
let _sessionAgent = '';          // Claude/OpenCode native --agent name; blank = CLI default agent
let _sessionProviderDisplayName = '';  // 实际生效 provider 的显示名（init 兜底；_sessionProvider 为空或 _providerList 未加载时用）
let _sessionCli = 'claude';
let _sessionCliStates = {};
let _cliAvailability = {};
let _pendingCliHandoff = null;
let _providerList = [];           // [{id,appType,name,baseUrl,model,isOfficial}] - 最近一次拉取结果
let _providerDefaults = { claude: null, codex: null };

// Replace the source CLI's AI settings as soon as a switch succeeds. The
// follow-up GET remains as reconciliation, but the header must not keep showing
// the old provider while that request is pending (or if it fails).
function applyCliSwitchState(info) {
  if (!info) return;
  if (info.cli) applyCliUi(info.cli);
  _providerList = [];
  _sessionProviderDisplayName = '';
  if (info.provider !== undefined) _sessionProvider = info.provider || '';
  if (info.providerName !== undefined) _sessionProviderDisplayName = info.providerName || '';
  if (info.model !== undefined) _sessionModel = info.model || '';
  if (info.effectiveModel !== undefined) _sessionEffectiveModel = info.effectiveModel || info.model || '';
  if (info.effort !== undefined) _sessionEffort = info.effort || '';
  if (info.effectiveEffort !== undefined) {
    _sessionEffectiveEffort = info.effectiveEffort || _sessionEffort || defaultEffortForCurrentCli();
  }
  if (info.agent !== undefined) _sessionAgent = info.agent || '';
  if (info.subagent !== undefined) _sessionSubagent = info.subagent || null;
  updateSubagentPill();
  updateModelBtn();
}

function effectiveProviderIdForChoices(providerId) {
  return window.MultiCCChatAiConfig.effectiveProviderId(providerId, chatAiConfigState());
}

function providerShortName(id) {
  return window.MultiCCChatAiConfig.providerShortName(id, chatAiConfigState());
}

function updateProviderBtn() {
  if (!providerBtn) return;
  providerBtn.style.display = 'none';
  updateModelBtn();
}

function showLoadingOverlay(text) {
  return window.MultiCCChatAiConfig.showLoadingOverlay(text, { document });
}

async function ensureProviderList(appType, opts) {
  const closeLoading = opts && opts.loading ? showLoadingOverlay('加载 Provider 列表…') : null;
  try {
    const loaded = await window.MultiCCChatAiConfig.loadProviderList(appType);
    _providerList = Array.from(loaded.providers || []);
    _providerDefaults = loaded.defaults || _providerDefaults;
    return _providerList;
  } catch (_) {
    return [];
  } finally {
    if (closeLoading) closeLoading();
  }
}

function showProviderPicker(current, list) {
  return window.MultiCCChatAiConfig.showProviderPicker(current, list, {
    document,
    translate: tt,
  });
}

providerBtn?.addEventListener('click', async () => {
  const list = await ensureProviderList(_sessionCli === 'codex' ? 'codex' : 'claude', { loading: true });
  const picked = await showProviderPicker(_sessionProvider, list);
  if (picked === null) return;
  try {
    const data = await window.MultiCCChatAiConfig.saveSession(_sessionName, { provider: picked.value });
    _sessionProvider = data.provider || '';
    _sessionModel = data.model || '';
    _sessionEffectiveModel = data.effectiveModel || data.model || '';
    _sessionEffort = data.effort || '';
    _sessionEffectiveEffort = data.effectiveEffort || _sessionEffort || defaultEffortForCurrentCli();
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
    ? tt('rolePromptSet')
    : tt('editRolePrompt');
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
    msg.textContent = tt('rolePrompt');
    box.appendChild(msg);

    // Preset-role picker — mirrors the app's role library; featured pinned first.
    const presetRow = document.createElement('div');
    presetRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';
    const presetLabel = document.createElement('span');
    presetLabel.textContent = tt('rolePresets');
    presetLabel.style.cssText = 'font-size:12px;color:#8b949e;white-space:nowrap;';
    const presetSel = document.createElement('select');
    presetSel.style.cssText = 'flex:1;min-width:0;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:7px 10px;outline:none;';
    const ph = document.createElement('option');
    ph.value = ''; ph.textContent = tt('rolePresets');
    presetSel.appendChild(ph);
    presetRow.appendChild(presetLabel);
    presetRow.appendChild(presetSel);
    box.appendChild(presetRow);
    fetchAgentPresetIndex().then((idx) => {
      if (!idx) { ph.textContent = tt('rolePresetsFailed'); return; }
      ph.textContent = tt('rolePresets');
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
      else addSystemMsg(tt('rolePresetsFailed'));
    });

    const ta = document.createElement('textarea');
    ta.value = current || '';
    ta.placeholder = tt('rolePlaceholder');
    ta.rows = 8;
    ta.style.cssText = 'width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;line-height:1.5;padding:10px;outline:none;resize:vertical;margin-bottom:6px;font-family:inherit;';
    box.appendChild(ta);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;color:#8b949e;margin-bottom:12px;';
    hint.textContent = tt('rolePromptDesc');
    box.appendChild(hint);

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

    const close = (result) => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(result); };
    const accept = () => {
      if (ta.value.length > 8000) { addSystemMsg(tt('roleTooLong', { n: 8000 })); return; }
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
    if (!res.ok) { addSystemMsg(tt('rolePromptFailed', { error: data.error || `HTTP ${res.status}` })); return; }
    _sessionRole = data.rolePrompt || '';
    updateRoleBtn();
    addSystemMsg(_sessionRole
      ? tt('rolePromptUpdated')
      : tt('rolePromptSaved'));
  } catch (e) {
    addSystemMsg(tt('rolePromptFailed', { error: e.message }));
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
  memoryBtn.title = '会话记忆库：私有（仅本会话）＋公共（项目共享）。原生 CLI 会话启动时形成快照，写入会立即持久化。点击查看/编辑';
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
  } catch (e) { addSystemMsg(tt('memSaveFailed') + ': ' + e.message); return; }

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
  title.textContent = tt('memTitle');
  const msg = document.createElement('div');
  msg.style.cssText = 'color:#8b949e;font-size:12px;line-height:1.5;';
  msg.textContent = tt('memIntro');

  const tabs = document.createElement('div');
  tabs.style.cssText = 'display:flex;gap:6px;';
  const tabOwn = document.createElement('button');
  const tabShared = document.createElement('button');
  const tabStyle = (a) => `background:${a?'#1f6feb':'#21262d'};border:1px solid ${a?'#388bfd':'#30363d'};border-radius:6px;color:${a?'#fff':'#c9d1d9'};font-size:12px;padding:5px 12px;cursor:pointer;`;
  tabOwn.textContent = tt('memScopeOwn');
  tabShared.textContent = tt('memScopeShared');

  const fileRow = document.createElement('div');
  fileRow.style.cssText = 'display:flex;gap:6px;align-items:center;';
  const sel = document.createElement('select');
  sel.style.cssText = 'flex:1;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:12px;padding:5px;';
  const newBtn = document.createElement('button');
  newBtn.textContent = `＋${tt('create')}`;
  newBtn.style.cssText = 'background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:12px;padding:5px 10px;cursor:pointer;';
  const delBtn = document.createElement('button');
  delBtn.textContent = `🗑${tt('delete')}`;
  delBtn.style.cssText = 'background:#21262d;border:1px solid #30363d;border-radius:6px;color:#f85149;font-size:12px;padding:5px 10px;cursor:pointer;';

  const ta = document.createElement('textarea');
  ta.style.cssText = 'width:100%;flex:1;min-height:240px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;font-family:ui-monospace,monospace;padding:10px;resize:vertical;';
  const pathHint = document.createElement('div');
  pathHint.style.cssText = 'color:#6e7681;font-size:11px;word-break:break-all;';

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = tt('close');
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
    let n = (prompt(tt('memNewFileTitle'), '') || '').trim();
    if (!n) return;
    if (!/\.md$/i.test(n)) n += '.md';
    if (!/^[\w.\- 一-龥]+\.md$/i.test(n)) { addSystemMsg(tt('memNameInvalid')); return; }
    commit();
    if (!(n in model[scope].files)) model[scope].files[n] = '';
    curName = n; renderFiles();
  };
  delBtn.onclick = async () => {
    if (!curName) return;
    if (!confirm(tt('memDeleteConfirm', { scope: scope === 'own' ? tt('memScopeOwn') : tt('memScopeShared'), name: curName }))) return;
    try {
      const r = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/memory`), {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, name: curName }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); addSystemMsg(tt('memDeleteFailed') + ': ' + (d.error || ('HTTP ' + r.status))); return; }
    } catch (e) { addSystemMsg(tt('memDeleteFailed') + ': ' + e.message); return; }
    delete model[scope].files[curName];
    curName = Object.keys(model[scope].files).sort()[0] || '';
    renderFiles();
    addSystemMsg(tt('memDeleted'));
  };
  saveBtn.onclick = async () => {
    commit();
    if (!curName) { addSystemMsg(tt('memNoSelection')); return; }
    try {
      const r = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/memory`), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, name: curName, content: model[scope].files[curName] }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { addSystemMsg(tt('memSaveFailed') + ': ' + (d.error || ('HTTP ' + r.status))); return; }
      addSystemMsg(tt('memSaved', { scope: scope === 'own' ? tt('memScopeOwn') : tt('memScopeShared'), name: curName }));
      updateMemoryBtn();
    } catch (e) { addSystemMsg(tt('memSaveFailed') + ': ' + e.message); }
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
  const supported = _sessionCli === 'claude' || _sessionCli === 'codex';
  if (subagentPill) subagentPill.style.display = supported ? '' : 'none';
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
    ? `📎 ${tt('shareMessages')} · ${s.messageCount || 0}`
    : (s.access === 'operate' ? tt('shareOperate') : tt('shareViewOnly'));
  const exp = s.expiresAt ? `，到期 ${new Date(s.expiresAt).toLocaleString()}` : '';
  return `<div class="share-row" data-token="${s.token}" style="border:1px solid #30363d;border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:12px;">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;"><b style="color:#79c0ff;">${lvl}</b><span style="color:#8b949e;">${exp}</span></div>
    <div style="display:flex;gap:6px;align-items:center;"><input readonly value="${s.url}" style="flex:1;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:11px;padding:5px 7px;font-family:var(--mono,monospace);"><button data-copy="${s.url}" style="background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:12px;padding:5px 10px;cursor:pointer;">${tt('copy')}</button><button data-del="${s.token}" style="background:#2d1418;border:1px solid #5c2228;border-radius:6px;color:#f85149;font-size:12px;padding:5px 10px;cursor:pointer;">${tt('revoke')}</button></div>
  </div>`;
}

async function openShareDialog() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
  const box = document.createElement('div');
  box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:560px;max-width:94vw;max-height:90vh;overflow:auto;color:#c9d1d9;';
  box.innerHTML = `
    <div style="font-size:15px;font-weight:600;margin-bottom:4px;">${tt('shareSession')}</div>
    <div style="font-size:12px;color:#8b949e;line-height:1.6;margin-bottom:10px;">${tt('shareDesc')} <b style="color:#f0883e;">${tt('shareOperateWarn')}</b></div>
    <div style="margin-bottom:12px;"><button id="sh-msgmode" style="background:#1b2330;border:1px solid #2d3a4f;border-radius:6px;color:#79c0ff;font-size:12px;padding:6px 10px;cursor:pointer;">✂️ ${tt('shareSelectedMessages')}</button></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
      <select id="sh-access" style="background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:7px 9px;">
        <option value="view">${tt('shareViewOnly')}</option>
        <option value="operate">${tt('shareOperate')}</option>
      </select>
      <input id="sh-pw" placeholder="${tt('sharePassword')}" style="flex:1;min-width:160px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:7px 9px;">
      <select id="sh-exp" style="background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:7px 9px;">
        <option value="0">${tt('neverExpires')}</option><option value="1">${tt('oneHour')}</option><option value="24">${tt('oneDay')}</option><option value="168">${tt('sevenDays')}</option>
      </select>
      <button id="sh-create" style="background:#238636;border:1px solid #2ea043;border-radius:6px;color:#fff;font-size:13px;padding:7px 14px;cursor:pointer;">${tt('shareGenerate')}</button>
    </div>
    <div id="sh-msg" style="font-size:12px;min-height:16px;margin-bottom:8px;"></div>
    <div style="font-size:12px;color:#8b949e;margin-bottom:6px;">${tt('existingShares')}</div>
    <div id="sh-list"><div style="color:#8b949e;font-size:12px;">${tt('loading')}</div></div>
    <div style="display:flex;justify-content:flex-end;margin-top:12px;"><button id="sh-close" style="background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:6px 14px;cursor:pointer;">${tt('close')}</button></div>`;
  overlay.appendChild(box); document.body.appendChild(overlay);
  const close = () => overlay.remove();
  box.querySelector('#sh-close').onclick = close;
  box.querySelector('#sh-msgmode').onclick = () => { close(); openMessagePicker(); };
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  const msg = box.querySelector('#sh-msg');
  const listEl = box.querySelector('#sh-list');

  async function refresh() {
    try { const d = await shareApi('GET', '/shares'); listEl.innerHTML = d.shares.length ? d.shares.map(shareRow).join('') : `<div style="color:#8b949e;font-size:12px;">${tt('none')}</div>`; }
    catch (e) { listEl.innerHTML = `<div style="color:#f85149;font-size:12px;">${e.message}</div>`; }
  }
  // Use event delegation on listEl so bind() is never needed — handlers survive
  // any innerHTML replacement, and data-* attrs always read the live DOM.
  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.hasAttribute('data-copy')) {
      navigator.clipboard?.writeText(btn.dataset.copy);
      btn.textContent = tt('shareCopied');
      setTimeout(() => { if (btn.isConnected) btn.textContent = tt('copy'); }, 1200);
    } else if (btn.hasAttribute('data-del')) {
      if (!confirm(tt('revokeShareConfirm'))) return;
      const token = btn.dataset.del;
      if (!token) return;
      btn.disabled = true;
      btn.textContent = tt('revoking');
      shareApi('DELETE', '/share/' + encodeURIComponent(token))
        .then(() => refresh())
        .catch(e => alert(e.message))
        .finally(() => { if (btn.isConnected) { btn.disabled = false; btn.textContent = tt('revoke'); } });
    }
  });
  box.querySelector('#sh-create').onclick = async () => {
    const access = box.querySelector('#sh-access').value;
    const password = box.querySelector('#sh-pw').value.trim();
    const hrs = parseInt(box.querySelector('#sh-exp').value, 10);
    if (access === 'operate' && !password) { msg.textContent = tt('sharePasswordRequired'); msg.style.color = '#f85149'; return; }
    const body = { access };
    if (password) body.password = password;
    if (hrs > 0) body.expiresAt = Date.now() + hrs * 3600 * 1000;
    try {
      const d = await shareApi('POST', '/share', body);
      msg.style.color = '#3fb950'; msg.textContent = tt('generatedLink', { url: d.url });
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
    <div style="font-size:15px;font-weight:600;margin-bottom:4px;">${tt('shareSelectedMessages')}</div>
    <div style="font-size:12px;color:#8b949e;margin-bottom:10px;">${tt('shareSelectedMessagesHint')}</div>
    <div id="mp-list" style="flex:1;overflow:auto;border:1px solid #30363d;border-radius:8px;padding:6px;margin-bottom:10px;min-height:120px;">${tt('loading')}</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">
      <label style="font-size:12px;color:#8b949e;display:flex;gap:4px;align-items:center;cursor:pointer;"><input type="checkbox" id="mp-all"> ${tt('selectAll')}</label>
      <span id="mp-count" style="font-size:12px;color:#8b949e;">${tt('selectedCount', { n: 0 })}</span>
      <input id="mp-pw" placeholder="${tt('publicIfEmpty')}" style="flex:1;min-width:140px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:7px 9px;">
      <select id="mp-exp" style="background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:7px 9px;">
        <option value="0">${tt('neverExpires')}</option><option value="24">${tt('oneDay')}</option><option value="168">${tt('sevenDays')}</option></select>
    </div>
    <div id="mp-msg" style="font-size:12px;min-height:16px;margin-bottom:8px;"></div>
    <div style="display:flex;justify-content:flex-end;gap:8px;">
      <button id="mp-cancel" style="background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:6px 14px;cursor:pointer;">${tt('close')}</button>
      <button id="mp-go" style="background:#238636;border:1px solid #2ea043;border-radius:6px;color:#fff;font-size:13px;padding:6px 14px;cursor:pointer;">${tt('shareGenerate')}</button>
    </div>`;
  overlay.appendChild(box); document.body.appendChild(overlay);
  const close = () => overlay.remove();
  box.querySelector('#mp-cancel').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  const listEl = box.querySelector('#mp-list'), countEl = box.querySelector('#mp-count'), msgEl = box.querySelector('#mp-msg');
  const updateCount = () => { countEl.textContent = tt('selectedCount', { n: listEl.querySelectorAll('input[type=checkbox]:checked').length }); };

  let msgs = [];
  try {
    const r = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/history`));
    const d = await r.json(); msgs = d.messages || [];
  } catch (e) { listEl.textContent = '加载失败：' + e.message; return; }
  if (!msgs.length) { listEl.textContent = tt('noMessages'); return; }
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
    if (!indices.length) { msgEl.style.color = '#f85149'; msgEl.textContent = tt('selectAtLeastOneMessage'); return; }
    const password = box.querySelector('#mp-pw').value.trim();
    const hrs = parseInt(box.querySelector('#mp-exp').value, 10);
    const body = { indices }; if (password) body.password = password; if (hrs > 0) body.expiresAt = Date.now() + hrs * 3600 * 1000;
    try {
      const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/share-messages`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json(); if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      navigator.clipboard?.writeText(d.url);
      msgEl.style.color = '#3fb950'; msgEl.textContent = tt('generatedAndCopied', { url: d.url });
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
  resetHistoryPagination();
  if (keepN > 0) {
    const msgs = [...messagesEl.querySelectorAll('.msg:not(.system-msg)')];
    const remove = msgs.slice(0, Math.max(0, msgs.length - keepN));
    remove.forEach(el => el.remove());
    if (remove.length) addSystemMsg(tt('contextKept', { removed: remove.length, kept: keepN }));
    else addSystemMsg(tt('contextResetKept'));
  } else {
    chatHistoryView.clearMessages();
    addSystemMsg(tt('contextCleared'));
  }
  if (ws?.readyState === WebSocket.OPEN) {
    chatTransport.send({ type: 'clear_history', keep: keepN });
  }
  closeClearMenu();
}
clearCtxMenu.querySelector('[data-action="clear-all"]').addEventListener('click', () => doClear(0));
clearCtxMenu.querySelector('[data-action="clear-keep"]').addEventListener('click', () => {
  const n = parseInt(document.getElementById('clear-keep-n').value, 10);
  doClear(Math.max(1, n || 5));
});

/* ── Voice Notifications (task complete / waiting for action) ── */
const notifyBtn   = document.getElementById('notify-btn');
const notifyToast = document.getElementById('notify-toast');
const _chatNotifications = window.MultiCCChatNotifications.createNotificationController({
  window,
  document,
  notifyBtn,
  notifyToast,
  getSessionId: () => _sessionName || sessionId || '',
  getTaskNotifyEnabled: (id) => typeof getTaskNotifyEnabled === 'function' ? getTaskNotifyEnabled(id) : true,
  setTaskNotifyEnabled: (id, enabled) => {
    if (typeof setTaskNotifyEnabled === 'function') setTaskNotifyEnabled(id, enabled);
  },
  getPushInfo: () => typeof getPushInfo === 'function' ? getPushInfo() : null,
  isPushSubscribed: () => typeof isPushSubscribed === 'function' && isPushSubscribed(),
  ensurePushSubscribed: () => typeof ensurePushSubscribed === 'function' ? ensurePushSubscribed() : true,
  unsubscribePush: () => typeof unsubscribePush === 'function' ? unsubscribePush() : undefined,
  showLocalTaskNotification: (payload) => {
    if (typeof showLocalTaskNotification === 'function') showLocalTaskNotification(payload);
  },
});

// Compatibility names used by event handling above and older inline callers.
function updateNotifyBtn() { return _chatNotifications.updateButton(); }
function refreshNotifyPreference() { return _chatNotifications.refreshPreference(); }
function showNotifyToast(text, type) { return _chatNotifications.showToast(text, type); }
function dismissNotifyToast() { return _chatNotifications.dismissToast(); }
function playDing(type) { return _chatNotifications.playDing(type); }
function speakNotify(text, type) { return _chatNotifications.speak(text, type); }

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

/* ── Message composer / attachment / voice host adapter ── */
chatComposer = window.MultiCCChatComposer.createComposer({
  window,
  document,
  navigator,
  location,
  fetch: window.fetch.bind(window),
  withToken,
  hasNativeBridge: _hasNativeBridge,
  webSocketOpen: WebSocket.OPEN,
  elements: {
    input: inputEl,
    sendButton: sendBtn,
    cancelButton: cancelBtn,
    attachArea,
    attachButton: attachBtn,
    fileInput,
    micButton: micBtn,
    micToast,
  },
  isSocketOpen: () => !!ws && ws.readyState === WebSocket.OPEN,
  transportSend: payload => chatTransport.send(payload),
  retryTransport: () => chatTransport.retryNow(),
  addSystemMessage: addSystemMsg,
  addUserMessage: addUserMsg,
  resetHistory: () => {
    resetHistoryPagination();
    chatHistoryView.clearMessages();
  },
  goalWrap,
  debug: dbg,
  updateUi: updateUI,
  getIsStreaming: () => isStreaming,
  hasOpenTurn: () => isStreaming || !!currentMsgEl,
  finishOpenTurn: () => {
    hideThinking();
    isStreaming = false;
    finishStreaming();
    updateUI();
  },
  setPendingCancel: value => { _pendingCancel = value; },
  onTurnStarted: () => {
    _turnStartMs = Date.now();
    _roleTokens = { main: null, sub: null, subByProvider: [] };
    _liveStreamUsage = null;
    isStreaming = true;
    showThinking();
    startTitleAnimation();
    dismissNotifyToast();
    updateUI();
  },
  finishCancelledTurn: () => {
    hideThinking();
    isStreaming = false;
    finishStreaming();
    stopTitleAnimation();
    addSystemMsg('Cancelled');
    updateUI();
  },
});
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
  sessionId = null; // fresh session for new dir
  forceReconnect('cwd changed');
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
  return chatTransport.ensureAlive();
}

function forceReconnect(reason) {
  chatTransport.forceReconnect(reason);
}

/* ── Reconnect when tab becomes visible again ── */
chatTransport.startLifecycle();

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
