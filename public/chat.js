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
const _providerCatalog = window.MultiCCProviderCatalog;
let _cwd = _params.get('cwd') || '';
const _sessionName = _params.get('session') || '';  // dashboard session name
const _taskId = _params.get('task') || '';          // task virtual session (M2)
const TASK_MODE = !!_taskId;
// Task mode: the same host renders a task from the ledger + the dir
// workspace stream (chat-task-mode.js). One body class gates session-only
// chrome; behaviour is gated at the install points below.
if (TASK_MODE) document.body.classList.add('task-mode');
const _targetMessageId = window.MultiCCChatMessageFocus.readTargetMessageId(location.search);
const _hasNativeBridge = typeof window.MultiCCBridge !== 'undefined' && !!window.MultiCCBridge;
function tt(key, params) { return (window.t || ((k) => k))(key, params); }

// Identity shim: URL-token auth is gone (cookie/session auth replaced it), but this
// stays a live cross-module seam - chat-diff resolves window.withToken at call time,
// composer/queue/recovery/task-mode take it as an injected port. Do not inline it away.
function withToken(url) { return url; }

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

// Session identity + header rename live in chat-session-features.js (M2 split,
// session-only); task mode keeps the task title from its adapter instead.
if (!TASK_MODE) installSessionIdentityFeatures();

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
    if (img.dataset.imgFixed) return; // idempotent: a repeat pass must never re-bind click/error
    img.dataset.imgFixed = '1';
    const raw = img.getAttribute('src') || '';
    img.addEventListener('load', () => chatScrollController?.handleLayoutChange(), { once: true });
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
let chatScrollController = null;
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
const headerMoreController = window.MultiCCChatLiveUi.bindHeaderMoreMenu({
  window,
  document,
  button: document.getElementById('header-more-btn'),
  menu: document.getElementById('header-more-menu'),
  wrap: document.getElementById('header-more-wrap'),
  ids: [
    'lang-btn', 'notify-btn', 's2s-btn', 'dbg-btn', 'model-btn', 'role-btn',
    'memory-btn', 'auto-commit-btn', 'share-btn', 'restart-spawn-btn',
    'clear-ctx-wrap', 'memo-btn',
  ],
});
function syncHeaderMoreMenu() { return headerMoreController.sync(); }
function openHeaderMoreModal() { return headerMoreController.open(); }
function closeHeaderMoreModal() { return headerMoreController.close(); }

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
// Raw usage block of the latest assistant turn. Kept raw (not pre-summed) so
// chat-token-readout.js can tell a single-request block from a CLI that sums
// every request in the turn — see the module header for why that matters.
let _turnUsage = null;
// Usage of the newest single API request (stream_event message_start). Unlike a
// turn total it cannot double-count a cached prefix, so it is the exact context.
let _requestUsage = null;
let _turnMeta = null;  // { durationText, turns } — shown in the detail panel, never priced
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
  qoder: { label: 'Qoder CN', color: '#ff8a3d' },
  kimi: { label: 'Kimi Code', color: '#13c2c2' },
};

function applyCliUi(cli) {
  const next = CLI_META[cli] ? cli : 'claude';
  const meta = CLI_META[next];
  currentCli = next; window.MultiCCChatRateLimit?.setCli(next);
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
  // OpenCode: kick off background refresh of the local opencode CLI's model
  // list so the AI-config picker dropdown is populated by the next open.
  // loadOpenCodeModels() caches 1 day in localStorage (see shared/models.js).
  if (next === 'opencode' && window.MultiCCChatAiConfig && typeof window.MultiCCChatAiConfig.refreshOpenCodeModels === 'function') {
    // No rebuild hook: the 1-day localStorage cache this fills is read the next
    // time the AI-config picker opens. (The old callback opened a stray no-arg
    // showProviderPicker() overlay once the fetch landed.)
    window.MultiCCChatAiConfig.refreshOpenCodeModels();
  }
  // Qoder CN: same warm-up. No rebuild callback — qoder has no provider picker
  // to re-render, and the built-in tiers stay usable until the fetch lands.
  if (next === 'qoder' && window.MultiCCChatAiConfig && typeof window.MultiCCChatAiConfig.refreshQoderModels === 'function') {
    window.MultiCCChatAiConfig.refreshQoderModels();
  }
  // Claude: warm the CLI-bundle model list (/api/claude/models, 1-day cache in
  // shared/models.js). No rebuild callback — the static table stays usable
  // until the fetch lands, then the next picker open reads the cache.
  if (next === 'claude' && window.MultiCCChatAiConfig && typeof window.MultiCCChatAiConfig.refreshClaudeModels === 'function') {
    window.MultiCCChatAiConfig.refreshClaudeModels();
  }
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
  const thinking = !!chatLiveUi.getThinkingElement();
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
  // Task mode renders read-only ledger history: no per-message delete/fork.
  attachDeleteButton: TASK_MODE ? () => {} : attachDeleteButton,
  attachForkButton: TASK_MODE ? () => {} : attachForkButton,
  warn: (...args) => console.warn(...args),
});
const chatMessageFocus = window.MultiCCChatMessageFocus.createMessageFocusController({
  targetId: _targetMessageId,
  findById: id => chatHistoryView.findById(id),
  async fetchAround(messageId) {
    const url = withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/history?around=${encodeURIComponent(messageId)}&limit=31`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  },
  mergeMessages(messages, page) {
    const inserted = chatHistoryView.prependMessages(messages);
    // The around window becomes the pagination anchor. Existing newer DOM is
    // intentionally retained, while subsequent "older" loads continue before
    // this window instead of using the former latest-page cursor.
    chatHistoryStore.reset();
    chatHistoryStore.acceptHistory({ messages, hasMore: !!page.hasMore }, chatHistoryView.visibleIds());
    return inserted;
  },
  onError: error => dbg('history', `message focus failed: ${error.message}`),
});
let _loadingOlderSentinel = null; // DOM node inserted at top while loading, also scroll anchor
let _wasConnected = false;       // true once we've successfully opened at least one WS
let _isDisconnected = false;
let _isRestarting = false;       // true while a user-triggered server restart is in progress
let _restartAt = 0;              // Date.now() when restart was hit — grace gate so we don't reconnect to the dying old server
let _disconnectEpisodeId = 0;
let _lastReconnectNoticeEpisode = 0;
let _lastInitInfoLine = '';
const chatLiveUi = window.MultiCCChatLiveUi.createLiveUi({
  window,
  document,
  messagesEl,
  translate: tt,
  maybeScrollToBottom,
  retryTransport: () => chatTransport.retryNow(),
  isRestarting: () => _isRestarting,
  getBaseTitle: () => _baseTitle,
  debug: dbg,
  onMarkTurnSucceeded: markTurnSucceeded,
  onCancelTask: cancelTaskFromBar,
});
let chatEventController = null;
let _eventGeneration = 0;
let taskMode = null; // M2 · task-mode adapter instance (chat.html?task=<id>)
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
    _eventGeneration = chatEventController?.beginGeneration() || 0;
    if (chatLiveUi.clearDisconnectBanner()) {
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
      handleEvent(JSON.parse(data), _eventGeneration);
    } catch (e) {
      console.warn('Bad message:', data, e);
    }
  },
  onClose({ event: e, seconds: secs }) {
    chatEventController?.invalidateGeneration(); chatEventController?.dropStaleUserInput?.();
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

function connect() { return chatTransport.connect(); }

// One send entry for both host modes (M2): session mode goes through the
// chat WS transport; task mode POSTs through the task adapter.
function hostTransportSend(payload) {
  if (TASK_MODE) return taskMode ? taskMode.transportSend(payload) : true;
  return chatTransport.send(payload);
}

function isRecoverableCodexReconnectErrorText(text) {
  return window.MultiCCChatEventController.isRecoverableCodexReconnectErrorText(text);
}

function handleEvent(message, generation) {
  return chatEventController?.handleEvent(message, generation);
}
function handleStreamEvent(event, generation) {
  return chatEventController?.handleStreamEvent(event, generation);
}
function handleToolResult(message) { return chatEventController?.handleToolResult(message); }
function finalizeAssistantMsg(message) { return chatEventController?.finalizeAssistantMsg(message); }
function finishStreaming() { return chatEventController?.finishStreaming(); }
function createAssistantBubble() {
  const bubble = chatHistoryView.createAssistantBubble(true);
  maybeScrollToBottom();
  return bubble;
}

function accumulateLiveUsage(usage, bucket) { return chatLiveUi.accumulateLiveUsage(usage, bucket); }
function buildUsageLine(usage, roleBreakdown) { return chatLiveUi.buildUsageLine(usage, roleBreakdown); }
function fmtDuration(ms) { return chatLiveUi.fmtDuration(ms); }
function buildTimingLine(message) { return chatLiveUi.buildTimingLine(message); }

// ── Per-message delete ──
// Hover "×" on a bubble whose server-side history id is known. Deleting
// removes the entry from chat_history (display history only — the CLI's own
// conversation context is not rewritten). The button lives on the outer .msg
// element so renderCurrentText()'s .msg-content rebuilds can't wipe it.

// ── In-page dialog helpers (replaces native confirm/alert which browsers
// often suppress inside iframes) ──
function _chatConfirm(message, options = {}) { return chatLiveUi.confirm(message, options); }
function _chatAlert(message, options = {}) { return chatLiveUi.alert(message, options); }

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
function _classifyDisp(classifyState) { return chatLiveUi.classifyDisplay(classifyState); }
function renderAuxClassify(goal, phase, classifyState, code) {
  return chatLiveUi.renderAuxClassify(goal, phase, classifyState, code);
}

// Manual turn verdict from the classify bar. This changes only the turn outcome
// to D/succeeded; it never marks the TaskBoard lifecycle complete.
async function markTurnSucceeded() {
  if (!_sessionName) { addSystemMsg('无 session id，无法标记执行成功'); return; }
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/mark-task-done`), { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      addSystemMsg(data.alreadySucceeded || data.alreadyDone
        ? '✓ 本轮已是执行成功状态'
        : '✓ 已手动标记本轮执行成功');
    } else {
      addSystemMsg(`⚠️ 标记执行成功失败：${data.note || data.error || res.status}`);
    }
  } catch (e) {
    addSystemMsg(`⚠️ 标记执行成功异常：${e && e.message ? e.message : e}`);
  } finally {
    const b = document.getElementById('ac-mark-done');
    if (b) b.disabled = false;
  }
}
function cancelTaskFromBar() {
  if (!cancelStreaming()) addSystemMsg('正在取消…');  // cancelStreaming() already says it when a turn is live
}
function attachUsageLine(bubbleEl, usage, roleBreakdown) {
  return chatLiveUi.attachUsageLine(bubbleEl, usage, roleBreakdown);
}

// Streaming deltas re-render the FULL accumulated markdown (no incremental
// path in the view layer), so one render per text_delta is O(n^2) over a long
// reply. Coalesce non-final renders on a short timer; the FINAL render
// (result/stream_end teardown) always runs synchronously so the turn never
// ends on a throttled, stale bubble.
const STREAM_RENDER_COALESCE_MS = 50;
let _pendingStreamRender = null;
function renderCurrentTextNow(final) {
  return chatHistoryView.renderCurrentText(currentMsgEl, currentTextContent, { final, streaming: isStreaming });
}
function renderCurrentText(final = false) {
  if (final) {
    if (_pendingStreamRender != null) { clearTimeout(_pendingStreamRender); _pendingStreamRender = null; }
    return renderCurrentTextNow(true);
  }
  if (_pendingStreamRender == null) {
    _pendingStreamRender = setTimeout(() => {
      _pendingStreamRender = null;
      renderCurrentTextNow(false);
    }, STREAM_RENDER_COALESCE_MS);
  }
  return null;
}

function highlightCodeBlocks(root) {
  const highlighter = window.hljs;
  if (!highlighter || typeof highlighter.highlightElement !== 'function') return;
  root.querySelectorAll('pre code').forEach(block => {
    try { highlighter.highlightElement(block); } catch (_) {}
  });
}

let _lastUserBubble = null;  // the most recent user message bubble (holds the per-turn auto-commit checkbox)
function addUserMsg(text, clientMsgId) {
  const div = document.createElement('div');
  div.className = 'msg user';
  div.textContent = text;
  if (clientMsgId) div.dataset.clientMsgId = clientMsgId;
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
 * monitor_done lands (paired by task_id). The draggable #danmaku-fab is the
 * persistent compact entry (badge = running count, drag snaps to the nearest
 * screen edge); the panel itself only exists expanded, anchored to the fab,
 * and the whole dock auto-hides 5s after every row goes terminal.
 * All text goes through textContent — task descriptions are agent-authored and
 * must never be treated as HTML. */
function danmakuOnDisconnect() { return chatLiveUi.danmakuOnDisconnect(); }
function pushDanmaku(kind, description, taskId) { return chatLiveUi.pushDanmaku(kind, description, taskId); }
function toggleDanmakuCollapse() { return chatLiveUi.toggleDanmakuCollapse(); }

function showDisconnectBanner(seconds) { return chatLiveUi.showDisconnectBanner(seconds); }

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
    currentText: currentTextContent || chatEventState.lastFinishedText,
  });
  currentMsgEl = viewPlan.currentElement;
  _lastUserBubble = viewPlan.lastUserElement;

  // A reconnect refreshes authoritative totals even when they are zero. When
  // no aggregate is provided, only the initial page may reconstruct totals;
  // a partial reconnect page must not reduce an already accumulated session.
  if (plan.hasAuthoritativeUsage || plan.mode === 'initial') {
    _sessionTokens = { ...plan.sessionTokens };
  }
  _turnUsage = plan.lastTurnUsage;
  // History carries no per-request block; keeping a stale one would present
  // another turn's measurement as this one's.
  _requestUsage = null;
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

  if (chatMessageFocus.shouldHoldBottom()) {
    chatMessageFocus.ensureFocused().then(found => {
      if (found) return;
      forceScrollToBottom();
      setTimeout(() => autofillHistory(4), 0);
    });
    return;
  }
  forceScrollToBottom();
  setTimeout(() => autofillHistory(4), 0);
}
/* ── Thinking bubble ── */
function showThinking() { return chatLiveUi.showThinking(); }
function hideThinking() { return chatLiveUi.hideThinking(); }
/* ── Composer compatibility surface ──
 * Message sending, attachments, keyboard/touch bindings and voice input are
 * owned by chat-composer.js. These wrappers preserve the classic globals used
 * by Goal mode, the native WebView bridge and older diagnostic snippets. */
let chatComposer = null;
const pendingUserInputController = window.MultiCCChatUserInputCard.createController({ document, isConnected: () => !!ws && ws.readyState === WebSocket.OPEN, submitAnswer: answer => { inputEl.value = answer; return chatComposer?.send() === true; } });
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
  pendingUserInputController.setConnected();
}
// The bar shows context and only context; the provider's token windows, the
// session's cumulative billing and the turn's timing move into the panel this
// readout opens. See chat-usage-readout.js for why money is not among them.
const usageReadout = window.MultiCCChatUsageReadout?.createUsageReadout({
  bar: costBar, panel: document.getElementById('usage-detail-pop'), document,
});
function noteRequestUsage(usage) {
  // One request's own report: the only context figure that needs no heuristic.
  if (usage) _requestUsage = usage;
  updateContextBar();
}
function updateContextBar(usage, modelUsage) {
  if (modelUsage) {
    for (const key of Object.keys(modelUsage)) {
      if (modelUsage[key].contextWindow) _contextWindow = modelUsage[key].contextWindow;
    }
  }
  if (usage) _turnUsage = usage;
  // Runs inside the history render on connect, so a missing readout module must
  // degrade the bar rather than abort the whole page.
  usageReadout?.render({
    requestUsage: _requestUsage,
    turnUsage: _turnUsage,
    contextWindow: _contextWindow,
    sessionTokens: _sessionTokens,
    providerWindows: _providerTokenWindows,
    providerLabel: _providerName || _providerId || 'Provider',
    turnMeta: _turnMeta,
    formatTokens: _providerCatalog.formatCompactTokens,
    formatWindow: _providerCatalog.formatUsageWindow,
  });
}

/* ── Mobile-safe scroll controller ── */
chatScrollController = window.MultiCCChatScrollController.createScrollController({
  window,
  document,
  messagesEl,
  translate: tt,
});

function isAtBottom() { return chatScrollController.isAtBottom(); }
function scrollToBottom() { return chatScrollController.scrollToBottom(); }
function forceScrollToBottom() { return chatScrollController.forceToBottom(); }
function maybeScrollToBottom() { return chatScrollController.maybeFollow(); }
function bumpUnread() { return chatScrollController.bumpUnread(); }
function rearmUnread() { return chatScrollController.rearmUnread(); }

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
    const url = withToken(TASK_MODE && taskMode
      ? taskMode.historyPageUrl({ before: request.before, limit: request.limit })
      : `/api/sessions/${encodeURIComponent(_sessionName)}/history?before=${encodeURIComponent(request.before)}&limit=${request.limit}`);
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

/* ── Liveness pill: is this session working / idle / stalled right now ── */
let _livenessTimer = null;
async function refreshLiveness() {
  if (!_sessionName || document.hidden) return;
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/liveness`));
    if (!res.ok) { chatLiveUi.renderLiveness(null); return; }
    chatLiveUi.renderLiveness(await res.json());
  } catch (_) { /* transient — keep the last shown state */ }
}
function startLivenessPolling() {
  refreshLiveness();
  if (_livenessTimer) clearInterval(_livenessTimer);
  // 4s cadence: responsive enough to catch a stall, light enough for one session.
  _livenessTimer = setInterval(refreshLiveness, 4000);
}

/* ── Merge worktree button ── */
function confirmInPage(message) {
  return chatLiveUi.confirm(message, {
    title: tt('mergeTitle'), okText: tt('merge'), cancelText: tt('cancel'), enterConfirms: true,
  });
}
function promptInPage(title, defaultValue) {
  return chatLiveUi.prompt(title, defaultValue, {
    placeholder: tt('sessionAliasHint'), okText: tt('save'), cancelText: tt('cancel'), maxLength: 80,
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

/* ── Auto-commit after a successful turn ── */
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
/* The list/detail UI lives in chat-diff.js (window.chatDiffViewer). These
 * wrappers keep the legacy call sites (merge-hint button, Esc handling)
 * working without duplication. */
function showDiff() {
  if (!_sessionName) { addSystemMsg('无 session id，无法查看 diff'); return; }
  if (window.chatDiffViewer) window.chatDiffViewer.open(_sessionName);
}

function closeDiffModal() {
  if (window.chatDiffViewer) window.chatDiffViewer.close();
}

document.getElementById('merge-hint-diff-btn')?.addEventListener('click', showDiff);

// Task mode has no session worktree/merge state or slot liveness of its own
// (M3 reworks the worktree half); skip the session-scoped pollers.
if (!TASK_MODE) {
  startMergeStatusPolling();
  startLivenessPolling();
}

/* ── Cross-CLI switch (one logical chat, independent native sessions) ── */
function showCliSwitchPicker(current, states, availability) {
  return chatLiveUi.showCliSwitchPicker(current, states, availability, CLI_META, {
    fetchSpecs: async () => {
      try {
        const res = await fetch(withToken('/api/cli/install-specs'));
        const data = await res.json();
        return (data && data.ok && data.specs) ? data.specs : (data && data.specs) || {};
      } catch (_) { return {}; }
    },
    installCli: async cli => {
      try {
        const res = await fetch(withToken(`/api/cli/${encodeURIComponent(cli)}/install`), { method: 'POST' });
        const data = await res.json();
        // 200 已安装: 直接当完成
        if (res.ok && data && data.alreadyInstalled) {
          return { alreadyInstalled: true, availability: data.availability };
        }
        // 202 新任务 / 409 已有 running 任务: 都返回 jobId 由弹窗接管轮询
        if ((res.status === 202 || res.status === 409) && data && data.jobId) {
          return { jobId: data.jobId };
        }
        return { error: (data && data.error) || `安装请求失败 (HTTP ${res.status})` };
      } catch (e) { return { error: (e && e.message) || '安装请求失败' }; }
    },
    pollInstall: async jobId => {
      try {
        const res = await fetch(withToken(`/api/cli/install-status/${encodeURIComponent(jobId)}`));
        const data = await res.json();
        // 200 -> {ok,job,availability}; 404 -> {ok:false,error}; 透传给弹窗判定终态
        return data || { ok: false, job: null };
      } catch (_) { return { ok: false, job: null, transient: true }; }
    },
    onAvailabilityChange: cli => { _cliAvailability[cli] = { available: true }; },
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
      body: JSON.stringify({ ...picked, force: true }),
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
  const provider = _sessionCli === 'qoder'
    ? 'Qoder CN'
    : ((_sessionProvider ? providerShortName(_sessionProvider) : '')
      || _sessionProviderDisplayName
      || (_sessionCli === 'zcode' ? 'ZCode 原生' : tt('default')));
  const model = shown ? modelDisplayName(shown, _sessionProvider) : tt('default');
  const effort = effortShortName(_sessionEffectiveEffort || _sessionEffort);
  const agent = (_sessionCli === 'claude' || _sessionCli === 'opencode' || _sessionCli === 'qoder') && _sessionAgent
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
  let info;
  try { info = await window.MultiCCChatAiConfig.loadSession(_sessionName); }
  catch (e) { dbg('model', `loadSessionModel fetch failed: ${e && e.message ? e.message : e}`); return; }
  // The old single catch (_) {} wrapped everything below: one throwing UI
  // update silently skipped the rest, leaving the pills stale with no hint
  // why. UI updates are isolated individually; assignments cannot throw.
  const safe = async (label, fn) => {
    try { await fn(); } catch (e) { dbg('model', `loadSessionModel ${label} failed: ${e && e.message ? e.message : e}`); }
  };
  _sessionRole = info.rolePrompt || '';
  safe('role-btn', updateRoleBtn);
  _sessionMemory = memoryToText(info.memory);
  safe('memory-btn', updateMemoryBtn);
  safe('cli-ui', () => applyCliUi(info.cli || 'claude'));
  _sessionCliStates = info.cliStates || {}; _cliAvailability = info.cliAvailability || _cliAvailability;
  _pendingCliHandoff = info.pendingCliHandoff || null;
  _sessionProvider = info.provider || '';
  _sessionProviderDisplayName = '';
  _sessionSubagent = info.subagent || null;
  _sessionAgent = info.agent || '';
  safe('subagent-pill', updateSubagentPill);
  await safe('provider-list', async () => { if (_sessionProvider && _sessionCli !== 'qoder') await ensureProviderList(_sessionCli); });
  safe('provider-btn', updateProviderBtn);
  _sessionModel = info.model || ''; _sessionEffectiveModel = info.effectiveModel || info.model || '';
  _sessionEffort = info.effort || ''; _sessionEffectiveEffort = info.effectiveEffort || _sessionEffort || defaultEffortForCurrentCli();
  safe('model-btn', updateModelBtn); safe('effort-btn', updateEffortBtn);
  _sessionAutoCommit = !!info.autoCommit;
  safe('auto-commit-btn', updateAutoCommitBtn);
  void window.MultiCCChatAiConfig.maybePromptZcodeSetup({
    cli: _sessionCli, provider: _sessionProvider, sessionId: _sessionName, loadProviders: () => ensureProviderList('zcode'),
    onProvider: () => modelBtn?.click(), onSettings: () => window.open('/manage.html?view=provider', '_blank', 'noopener'),
  });
}

modelBtn?.addEventListener('click', async () => {
  // 每次打开前重新拉取一次会话配置，避免重连/加载未完成时弹窗显示默认值。
  await loadSessionModel();
  if (_sessionCli !== 'qoder') {
    await ensureProviderList(_sessionCli, { loading: true });
  }
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
      ...((_sessionCli === 'claude' || _sessionCli === 'opencode' || _sessionCli === 'qoder') ? { agent: picked.agent } : {}),
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
    // The quota bars key off the active provider's baseUrl, which only reaches
    // them through updateProviderBtn(). This is the live provider-switch path
    // (the standalone provider button is hidden), so without this call the bar
    // kept showing the OLD provider until the next loadSessionModel().
    updateProviderBtn(); // also calls updateModelBtn()
    const _savedModel = _sessionEffectiveModel || _sessionModel;
    const savedParts = [providerShortName(_sessionProvider), _savedModel ? modelDisplayName(_savedModel, _sessionProvider) : tt('default'), effortShortName(_sessionEffectiveEffort)];
    if ((_sessionCli === 'claude' || _sessionCli === 'opencode' || _sessionCli === 'qoder') && _sessionAgent) savedParts.push(`Agent ${_sessionAgent}`);
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
  window.MultiCCChatRateLimit?.setProviderBaseUrl?.((_providerList.find((x) => x && x.id === _sessionProvider) || {}).baseUrl || '');
  updateModelBtn();
}

function showLoadingOverlay(text) {
  return window.MultiCCChatAiConfig.showLoadingOverlay(text, { document });
}

async function ensureProviderList(cli, opts) {
  const closeLoading = opts && opts.loading ? showLoadingOverlay('加载 Provider 列表…') : null;
  try {
    const loaded = await window.MultiCCChatAiConfig.loadProviderList(cli);
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
  const list = await ensureProviderList(_sessionCli, { loading: true });
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
  newBtn.onclick = async () => {
    // In-page dialog, not native prompt(): WebViews suppress the native one.
    let n = ((await chatLiveUi.prompt(tt('memNewFileTitle'), '', {
      okText: tt('save'), cancelText: tt('cancel'),
    })) || '').trim();
    if (!n) return;
    if (!/\.md$/i.test(n)) n += '.md';
    if (!/^[\w.\- 一-龥]+\.md$/i.test(n)) { addSystemMsg(tt('memNameInvalid')); return; }
    commit();
    if (!(n in model[scope].files)) model[scope].files[n] = '';
    curName = n; renderFiles();
  };
  delBtn.onclick = async () => {
    if (!curName) return;
    if (!(await chatLiveUi.confirm(tt('memDeleteConfirm', { scope: scope === 'own' ? tt('memScopeOwn') : tt('memScopeShared'), name: curName }), { danger: true }))) return;
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

/* ── Per-session auto-commit (auto commit & merge after a successful turn) ── */
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
    addSystemMsg(_sessionAutoCommit ? '✓ 已开启「本轮执行成功后自动提交合并」，每轮执行成功后将自动 commit 并合并回基分支' : '✓ 已关闭「本轮执行成功后自动提交合并」');
  } catch (e) {
    addSystemMsg('保存失败：' + e.message);
  }
});

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
  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.hasAttribute('data-copy')) {
      navigator.clipboard?.writeText(btn.dataset.copy);
      btn.textContent = tt('shareCopied');
      setTimeout(() => { if (btn.isConnected) btn.textContent = tt('copy'); }, 1200);
    } else if (btn.hasAttribute('data-del')) {
      // In-page dialog, not native confirm/alert: WebViews suppress both.
      if (!(await chatLiveUi.confirm(tt('revokeShareConfirm'), { danger: true }))) return;
      const token = btn.dataset.del;
      if (!token) return;
      btn.disabled = true;
      btn.textContent = tt('revoking');
      shareApi('DELETE', '/share/' + encodeURIComponent(token))
        .then(() => refresh())
        .catch(e => chatLiveUi.alert(e.message))
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

const chatEventState = {};
chatEventState.pendingUserInputRequestId = null;
const eventStateBindings = {
  sessionId: [() => sessionId, value => { sessionId = value; }],
  pendingCancel: [() => _pendingCancel, value => { _pendingCancel = value; }],
  isStreaming: [() => isStreaming, value => { isStreaming = value; }],
  sessionEffort: [() => _sessionEffort, value => { _sessionEffort = value; }],
  sessionEffectiveEffort: [() => _sessionEffectiveEffort, value => { _sessionEffectiveEffort = value; }],
  sessionProvider: [() => _sessionProvider, value => { _sessionProvider = value; }],
  sessionProviderDisplayName: [() => _sessionProviderDisplayName, value => { _sessionProviderDisplayName = value; }],
  sessionCliStates: [() => _sessionCliStates, value => { _sessionCliStates = value; }],
  cliAvailability: [() => _cliAvailability, value => { _cliAvailability = value; }],
  sessionAgent: [() => _sessionAgent, value => { _sessionAgent = value; }],
  pendingCliHandoff: [() => _pendingCliHandoff, value => { _pendingCliHandoff = value; }],
  sessionEffectiveModel: [() => _sessionEffectiveModel, value => { _sessionEffectiveModel = value; }],
  sessionModel: [() => _sessionModel, value => { _sessionModel = value; }],
  providerId: [() => _providerId, value => { _providerId = value; }],
  providerName: [() => _providerName, value => { _providerName = value; }],
  providerTokenWindows: [() => _providerTokenWindows, value => { _providerTokenWindows = value; }],
  roleTokens: [() => _roleTokens, value => { _roleTokens = value; }],
  currentMsgEl: [() => currentMsgEl, value => { currentMsgEl = value; }],
  currentTextContent: [() => currentTextContent, value => { currentTextContent = value; }],
  currentToolCards: [() => currentToolCards, value => { currentToolCards = value; }],
  activeContentType: [() => activeContentType, value => { activeContentType = value; }],
  activeContentIndex: [() => activeContentIndex, value => { activeContentIndex = value; }],
  currentCli: [() => currentCli, value => { currentCli = value; }],
  liveStreamUsage: [() => _liveStreamUsage, value => { _liveStreamUsage = value; }],
  turnStartMs: [() => _turnStartMs, value => { _turnStartMs = value; }],
  turnMeta: [() => _turnMeta, value => { _turnMeta = value; }],
  sessionTokens: [() => _sessionTokens, value => { _sessionTokens = value; }],
  lastUserBubble: [() => _lastUserBubble, value => { _lastUserBubble = value; }],
  lastInitInfoLine: [() => _lastInitInfoLine, value => { _lastInitInfoLine = value; }],
};
for (const [name, binding] of Object.entries(eventStateBindings)) {
  Object.defineProperty(chatEventState, name, { enumerable: true, get: binding[0], set: binding[1] });
}
const cancelQueuedSessionEntry = window.MultiCCChatSessionQueue.createCancelHandler(
  { fetch: window.fetch.bind(window), withToken, getSessionName: () => _sessionName, notify: showNotifyToast },
);
const insertQueuedSessionEntry = window.MultiCCChatSessionQueue.createInsertHandler(
  { fetch: window.fetch.bind(window), withToken, getSessionName: () => _sessionName, notify: showNotifyToast },
);
window.MultiCCChatSessionQueue.configure({
  onCancel: cancelQueuedSessionEntry,
  onInsert: insertQueuedSessionEntry,
});
chatEventController = window.MultiCCChatEventController.createEventController({
  state: chatEventState,
  liveUi: chatLiveUi,
  historyStore: chatHistoryStore,
  historyView: chatHistoryView,
  host: {
    debug: dbg,
    warn: (...args) => console.warn(...args),
    translate: tt,
    getSessionName: () => _sessionName,
    refreshNotifyPreference,
    updateTabIdentity,
    updateCwdDisplay,
    applyCliUi,
    addSystemMsg,
    addAgentNotes,
    updateEffortBtn,
    updateModelBtn,
    transportSend: hostTransportSend,
    startTitleAnimation,
    stopTitleAnimation,
    updateUI,
    loadSessionModel,
    applyCliSwitchState,
    cliMeta: CLI_META,
    updateContextBar,
    noteRequestUsage,
    autoCommitIfNeeded,
    resetHistoryPagination,
    applyHistoryPlan,
    removeHistoryMessageById,
    showNotifyToast,
    speakNotify,
    maybeScrollToBottom,
    renderCurrentText,
    renderSessionQueue: window.MultiCCChatSessionQueue.render,
    renderPendingUserInput: message => pendingUserInputController.render(message),
    rearmUnread,
  },
});
// Session-identity chrome (role prompt, provider/model) has no task-mode
// equivalent: the routing recorded on the task is what ran.
if (!TASK_MODE) {
  updateRoleBtn();
  loadSessionModel();
}
/* ── Clear / rotate native context controls ── */
window.MultiCCChatContextControls.create({
  document, window, translate: tt,
  getIsStreaming: () => isStreaming,
  cancelStreaming, resetHistoryPagination, messagesEl, addSystemMsg,
  clearMessages: () => chatHistoryView.clearMessages(),
  isConnected: () => ws?.readyState === WebSocket.OPEN,
  send: hostTransportSend,
  showNotifyToast,
  getSessionId: () => _sessionName || sessionId || '',
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
function startTitleAnimation() { return chatLiveUi.startTitleAnimation(); }
function stopTitleAnimation() { return chatLiveUi.stopTitleAnimation(); }

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
  transportSend: hostTransportSend,
  retryTransport: () => chatTransport.retryNow(),
  addSystemMessage: addSystemMsg,
  // Deliberately inert: the user bubble appears only on the server's
  // queued=false confirmation (chat-event-controller session_queue), never
  // optimistically on send. The old stagedUserBubbles map stored every sent
  // message forever with no reader (M6); staging now just discards.
  stageUserMessage: () => {},
  addUserMessage: addUserMsg,
  resetHistory: () => {
    resetHistoryPagination();
    chatHistoryView.clearMessages();
  },
  goalWrap,
  debug: dbg,
  updateUi: updateUI,
  getIsStreaming: () => isStreaming,
  getUserInputRequestId: () => chatEventState.pendingUserInputRequestId,
  consumeUserInputRequestId: requestId => {
    if (chatEventState.pendingUserInputRequestId === requestId) {
      chatEventState.pendingUserInputRequestId = null;
      pendingUserInputController.clear(requestId);
    }
  },
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
    addSystemMsg('正在取消…');
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
/* _isMobile lives in client.js (a separate script scope, const-locked); define it
   locally here too so this top-level block doesn't throw a ReferenceError that
   would abort the rest of chat.js — including the auto connect() call. */
const _isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || window.innerWidth <= 768;
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
// Task mode owns its dir-workspace reconnect loop; the chat transport's
// lifecycle must not open a session WS behind it.
if (!TASK_MODE) chatTransport.startLifecycle();

/* ── Recovery service: ↻ reconnect / long-press reload / ♻️ restart CLI spawn ── */
const _chatRecovery = window.MultiCCChatRecoveryService.create({
  document, window, translate: tt,
  forceReconnect, statusEl,
  reload: () => location.reload(),
  getSessionName: () => _sessionName,
  addSystemMsg, withToken,
  confirm: (message, opts) => chatLiveUi.confirm(message, opts),
  closeMoreMenu: () => closeHeaderMoreModal(),
});

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
// Task-mode host adapters (bootTaskMode/renderRunSeparator/updateTaskIdentity)
// live in chat-task-boot.js to keep this host inside the line budget.
dbg('state', TASK_MODE ? 'page loaded — task 模式启动' : 'page loaded — 开始连接');
if (TASK_MODE) bootTaskMode();
else connect();

/* ════════════════════════════════════════════════════════════════════════════
 * 实时语音通话 — 全局 Qwen 语音网关
 *
 * 这个按钮不再在页面内跑一套 S2S 状态机，而是向 Host 申请一张 launch 票据、
 * 打开全局语音网关。带上 sourceSessionId 就意味着「在当前这个会话里说话」，
 * Host 会把这类通话固定投给当前 source session；只有 Dashboard 发起的全局
 * 通话才由 worker-only Router 选择项目和普通 Worker，前端不参与决定。
 * 输入框里的普通麦克风听写完全不走这里，保持原样。
 * ════════════════════════════════════════════════════════════════════════════ */
(function initVoiceCall() {
  const btn = document.getElementById('s2s-btn');
  if (!btn) return;

  let pending = false;

  btn.addEventListener('click', async () => {
    if (pending) return;
    // Optional chaining + explicit fallback: a missing module must never throw
    // here, or the ReferenceError would take the rest of chat.js down with it.
    const client = window.MultiCCVoiceLaunch;
    if (!client || typeof client.launch !== 'function') {
      addSystemMsg('语音模块未加载，请刷新页面后重试');
      return;
    }
    if (!_sessionName) { addSystemMsg('无 session id，无法启动语音'); return; }
    pending = true;
    btn.classList.add('active');
    try {
      const result = await client.launch({ sourceSessionId: _sessionName, withToken });
      if (!result.ok) addSystemMsg('语音：' + (result.message || result.code));
      else addSystemMsg('已打开实时语音（当前会话：' + (result.launch.display || _sessionName) + '）');
    } catch (e) {
      addSystemMsg('语音启动异常：' + (e && e.message ? e.message : e));
    } finally {
      pending = false;
      btn.classList.remove('active');
    }
  });
})();
/* ════════════════════════════════════════════════════════════════════════════
 * 实时语音通话 — 结束
 * ════════════════════════════════════════════════════════════════════════════ */

