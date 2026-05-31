// Open the project's memo (multicc.memo.md) in a new tab/window.
function openMemo() {
  const u = new URLSearchParams(location.search);
  const sid = (typeof currentSessionId !== 'undefined' && currentSessionId) || u.get('id') || u.get('session');
  if (!sid) return;
  const token = u.get('token');
  const tokenParam = token ? '&token=' + encodeURIComponent(token) : '';
  window.open('/memo.html?sessionId=' + encodeURIComponent(sid) + tokenParam, '_blank');
}

'use strict';

/* ── Terminal setup ── */
const _isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || window.innerWidth <= 768;

/* ── Mobile layout fix: use fixed px instead of vh, track visualViewport ── */
const _initialHeight = window.innerHeight;  // capture once, before keyboard

function fixMobileLayout() {
  if (!_isMobile) return;
  // Terminal = 1/3 of the initial screen height (fixed px, immune to keyboard)
  const termWrap = document.getElementById('terminal-wrap');
  if (termWrap) termWrap.style.height = Math.floor(_initialHeight / 3) + 'px';

  // Body height = visual viewport (shrinks when keyboard opens → no black gap)
  const vh = window.visualViewport?.height ?? window.innerHeight;
  document.body.style.height = vh + 'px';
}

fixMobileLayout();
if (_isMobile && window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    const vh = window.visualViewport.height;
    document.body.style.height = vh + 'px';
  });
}

const term = new Terminal({
  cursorBlink: true,
  allowProposedApi: true,
  scrollback: _isMobile ? 1000 : 5000,
  fontFamily: '"Cascadia Code", "Fira Code", "Jetbrains Mono", Consolas, "Courier New", monospace',
  fontSize: 14,
  lineHeight: 1.25,
  theme: {
    background:          '#0d1117',
    foreground:          '#c9d1d9',
    cursor:              '#f78166',
    cursorAccent:        '#0d1117',
    selectionBackground: '#264f78',
    black:   '#484f58', red:     '#ff7b72', green:   '#3fb950', yellow:  '#d29922',
    blue:    '#58a6ff', magenta: '#bc8cff', cyan:    '#39c5cf', white:   '#b1bac4',
    brightBlack:   '#6e7681', brightRed:     '#ffa198', brightGreen:   '#56d364',
    brightYellow:  '#e3b341', brightBlue:    '#79c0ff', brightMagenta: '#d2a8ff',
    brightCyan:    '#56d4dd', brightWhite:   '#f0f6fc',
  },
});

const fitAddon     = new FitAddon.FitAddon();
const webLinksAddon = new WebLinksAddon.WebLinksAddon();

term.loadAddon(fitAddon);
term.loadAddon(webLinksAddon);
term.open(document.getElementById('terminal'));
fitAddon.fit();

/* ── Status helpers ── */
const dot          = document.getElementById('status-dot');
const label        = document.getElementById('status-label');
const reconnBtn    = document.getElementById('reconnect-btn');
const sessionLabel = document.getElementById('session-label');

function setStatus(state, text) {
  dot.className    = state;
  label.textContent = text;
  reconnBtn.style.display = state === 'disconnected' ? 'block' : 'none';
}

/** Check if terminal is scrolled to (near) bottom */
function isAtBottom() {
  const buf = term.buffer.active;
  return buf.viewportY >= buf.baseY - 2;
}

/* ── Session ID ── */
let currentSessionId = new URLSearchParams(location.search).get('id') || '';
const _urlToken = new URLSearchParams(location.search).get('token') || '';

/** Append token param to a URL string (handles both ? and & correctly) */
function withToken(url) {
  if (!_urlToken) return url;
  return url + (url.includes('?') ? '&' : '?') + `token=${encodeURIComponent(_urlToken)}`;
}

/* ── Dynamic favicon + title from session ID ── */
const _TAB_COLORS = ['#58a6ff','#f78166','#3fb950','#d29922','#bc8cff','#f97583','#79c0ff','#56d364'];
function _hashColor(s) {
  let h = 0; for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i) * 31) | 0;
  return _TAB_COLORS[Math.abs(h) % _TAB_COLORS.length];
}
function updateTabIdentity(id) {
  if (!id) return;
  document.title = `${id} — MultiCC`;
  const letter = id.charAt(0).toUpperCase();
  const color = _hashColor(id);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#161b22"/><text x="32" y="45" text-anchor="middle" font-family="system-ui,sans-serif" font-size="38" font-weight="700" fill="${color}">${letter}</text></svg>`;
  let link = document.querySelector('link[rel="icon"]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
  link.type = 'image/svg+xml';
  link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function updateSessionLabel(id) {
  if (!sessionLabel) return;
  sessionLabel.textContent = `#${id}`;
  sessionLabel.title = `Session ID: ${id} — click to copy URL`;
}

if (currentSessionId) { updateSessionLabel(currentSessionId); updateTabIdentity(currentSessionId); }

if (sessionLabel) {
  sessionLabel.addEventListener('click', () => {
    navigator.clipboard.writeText(location.href).then(() => {
      const prev = sessionLabel.textContent;
      sessionLabel.textContent = 'Copied!';
      setTimeout(() => { sessionLabel.textContent = prev; }, 1500);
    });
  });
}

/* ── Voice Notifications (task complete / waiting for action) ── */
const notifyBtn = document.getElementById('notify-btn');
const notifyToast = document.getElementById('notify-toast');
let _notifyEnabled = localStorage.getItem('multicc_notify') !== 'off';
let _notifyState = 'idle';       // idle | active | waiting
let _notifyOutputChars = 0;
let _notifyIdleTimer = null;
let _notifyLastCompleted = 0;
let _notifyLastAction = 0;
let _notifyConnectedAt = 0;
let _notifyRecentText = '';
let _notifyToastTimer = null;

const NOTIFY_COOLDOWN = 8000;     // min ms between same-type notifications
const NOTIFY_IDLE_MS = 6000;      // idle duration to trigger "completed"
const NOTIFY_MIN_CHARS = 80;      // min output chars before idle = "completed"

// "等待操作" — Claude 需要用户做选择或确认（选 1/2/3、Y/n、Allow/Deny）
const NOTIFY_WAITING_PATTERNS = [
  // Y/n confirmation
  /\[Y\/n\]/,
  /\[y\/N\]/,
  /\(y\/n\)/i,
  /\(yes\/no\)/i,
  /Yes\s*\/\s*No/i,
  // Claude Code tool approval
  /Allow\s*(once|always)/i,
  /Approve\??/i,
  /Deny/i,
  /Do you want to proceed/i,
  /Do you want to/i,
  /Press Enter/i,
  // Numbered choices (e.g. "1. xxx  2. xxx" or "1) xxx")
  /^\s*[1-9]\.\s+\S/m,
  /^\s*[1-9]\)\s+\S/m,
];

// "任务已完成" — Claude 输出停止，回到空闲提示符
const NOTIFY_COMPLETED_PATTERNS = [
  /[❯>]\s*$/,        // idle prompt
  /\$\s*$/,           // shell prompt
];

const NOTIFY_ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z~]|\][^\x07]*(?:\x07|\x1b\\)|[()][AB012]|.)/g;

function notifyStripAnsi(str) {
  return str.replace(NOTIFY_ANSI_RE, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function updateNotifyBtn() {
  if (!notifyBtn) return;
  if (_notifyEnabled) {
    notifyBtn.style.background = '#1f6feb';
    notifyBtn.style.borderColor = '#58a6ff';
    notifyBtn.style.color = '#fff';
    notifyBtn.title = '语音通知 (已开启)';
  } else {
    notifyBtn.style.background = '#21262d';
    notifyBtn.style.borderColor = '#30363d';
    notifyBtn.style.color = '#c9d1d9';
    notifyBtn.title = '语音通知 (已关闭)';
  }
}
updateNotifyBtn();

if (notifyBtn) {
  notifyBtn.addEventListener('click', () => {
    _notifyEnabled = !_notifyEnabled;
    localStorage.setItem('multicc_notify', _notifyEnabled ? 'on' : 'off');
    updateNotifyBtn();
  });
}

function showNotifyToast(text, type) {
  if (!notifyToast) return;
  // Set toast text (keep close button)
  notifyToast.childNodes[0].nodeType === 3
    ? (notifyToast.firstChild.textContent = text)
    : notifyToast.insertBefore(document.createTextNode(text), notifyToast.firstChild);
  // Update: set text content before the close button
  const closeBtn = notifyToast.querySelector('.toast-close');
  notifyToast.textContent = '';
  notifyToast.appendChild(document.createTextNode(text + ' '));
  notifyToast.appendChild(closeBtn);
  notifyToast.className = type;
  notifyToast.style.display = 'block';
  // Auto-hide after 15s
  if (_notifyToastTimer) clearTimeout(_notifyToastTimer);
  _notifyToastTimer = setTimeout(dismissNotifyToast, 15000);
}

function dismissNotifyToast() {
  if (notifyToast) notifyToast.style.display = 'none';
  if (_notifyToastTimer) { clearTimeout(_notifyToastTimer); _notifyToastTimer = null; }
  // Dismissing toast does NOT stop voice repeating
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

function speakNotify(text, type) {
  if (!_notifyEnabled) return;
  const now = Date.now();
  // Skip within first 5s of connection (replay buffer)
  if (now - _notifyConnectedAt < 5000) return;
  // Page is in foreground — user can see the terminal, no need to notify
  if (document.visibilityState === 'visible') return;

  if (type === 'completed') {
    if (now - _notifyLastCompleted < NOTIFY_COOLDOWN) return;
    _notifyLastCompleted = now;
  } else {
    if (now - _notifyLastAction < NOTIFY_COOLDOWN) return;
    _notifyLastAction = now;
  }

  // Show visual toast + play voice
  showNotifyToast(text, type);

  if (window.speechSynthesis) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1.1;
    utterance.volume = 0.8;
    window.speechSynthesis.speak(utterance);
  }
}

function notifyOnOutput(rawData) {
  if (!_notifyEnabled) return;

  const text = notifyStripAnsi(rawData);
  const printable = text.replace(/\s+/g, '');

  // Accumulate stripped text for final idle check
  _notifyRecentText += text;
  if (_notifyRecentText.length > 3000) {
    _notifyRecentText = _notifyRecentText.slice(-2000);
  }

  if (printable.length > 0) {
    _notifyOutputChars += printable.length;
    if (_notifyState === 'idle') _notifyState = 'active';
  }

  // Check for waiting-for-action patterns (needs user selection mid-task)
  if (_notifyState === 'active') {
    for (const pat of NOTIFY_WAITING_PATTERNS) {
      if (pat.test(text)) {
        _notifyState = 'waiting';
        speakNotify('正在等待您的操作', 'action');
        break;
      }
    }
  }

  // Reset idle timer — if output stops for NOTIFY_IDLE_MS, classify the notification
  if (_notifyIdleTimer) clearTimeout(_notifyIdleTimer);
  _notifyIdleTimer = setTimeout(() => {
    if (_notifyState === 'active' && _notifyOutputChars >= NOTIFY_MIN_CHARS) {
      const tail = _notifyRecentText.slice(-2000);
      // Check if it's a waiting-for-action (selection/confirmation prompt)
      let isWaiting = false;
      for (const pat of NOTIFY_WAITING_PATTERNS) {
        if (pat.test(tail)) { isWaiting = true; break; }
      }
      if (isWaiting) {
        speakNotify('正在等待您的操作', 'action');
      } else {
        // Output stopped — task completed (idle prompt or just no more output)
        speakNotify('任务已完成', 'completed');
      }
    }
    _notifyState = 'idle';
    _notifyOutputChars = 0;
    _notifyRecentText = '';
  }, NOTIFY_IDLE_MS);
}

function notifyOnInput(data) {
  // Reset on Enter key (user submitting input/response)
  if (data.includes('\r') || data.includes('\n')) {
    _notifyState = 'idle';
    _notifyOutputChars = 0;
    _notifyRecentText = '';
    dismissNotifyToast();
    if (_notifyIdleTimer) {
      clearTimeout(_notifyIdleTimer);
      _notifyIdleTimer = null;
    }
  }
}

/* ── WebSocket / PTY bridge (with auto-reconnect) ── */
let ws = null;
let _wsGen = 0;               // generation counter — stale onclose handlers become no-ops
let _reconnectTimer = null;
let _reconnectAttempt = 0;
let _sessionExited = false;

function scheduleReconnect() {
  if (_sessionExited || _reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, _reconnectAttempt), 30000);
  _reconnectAttempt++;
  setStatus('connecting', `${Math.ceil(delay / 1000)}s 后重连…`);
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    connect();
  }, delay);
}

let _initialCwd = '';   // set by directory picker for new sessions
let _initialId  = '';   // custom session ID from directory picker

function connect() {
  // Cancel any pending reconnect
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }

  if (ws && ws.readyState === WebSocket.OPEN) ws.close();

  const gen = ++_wsGen;
  _sessionExited = false;

  setStatus('connecting', 'Connecting…');

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const urlToken = new URLSearchParams(location.search).get('token');
  const tokenParam = urlToken ? `&token=${urlToken}` : '';
  const cwdParam = _initialCwd ? `&cwd=${encodeURIComponent(_initialCwd)}` : '';
  const idParam  = _initialId  ? `&newid=${encodeURIComponent(_initialId)}` : '';
  const wsUrl = currentSessionId
    ? `${proto}//${location.host}/?id=${currentSessionId}${tokenParam}`
    : `${proto}//${location.host}/?_=1${tokenParam}${cwdParam}${idParam}`;
  _initialCwd = '';  // only used once
  _initialId  = '';
  ws = new WebSocket(wsUrl);

  // ── Write batching: merge rapid output into single rAF-paced term.write() calls ──
  let _writeBuf = '';
  let _writeRaf = null;

  // ── Redraw blanking: hide terminal during TUI redraw, show when stable ──
  let _redrawTimer = null;
  let _redrawing = false;
  const _termWrap = document.getElementById('terminal-wrap');

  function startRedrawBlank() {
    _redrawing = true;
    _termWrap.style.visibility = 'hidden';
    // Show a simple loading indicator
    if (!document.getElementById('__redraw-mask')) {
      const mask = document.createElement('div');
      mask.id = '__redraw-mask';
      mask.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
        'background:#0d1117;color:#8b949e;font-size:14px;z-index:100;';
      mask.textContent = '正在恢复会话…';
      _termWrap.parentElement.style.position = 'relative';
      _termWrap.parentElement.appendChild(mask);
    }
  }

  function endRedrawBlank() {
    _redrawing = false;
    _termWrap.style.visibility = '';
    const mask = document.getElementById('__redraw-mask');
    if (mask) mask.remove();
    term.scrollToBottom();
    // Auto-focus mobile input to bring up keyboard
    if (_isMobile) {
      const mi = document.getElementById('mobile-input');
      if (mi) mi.focus();
    }
  }

  function resetRedrawTimer() {
    clearTimeout(_redrawTimer);
    // Wait for output to be quiet for 500ms before showing terminal
    _redrawTimer = setTimeout(() => { if (_redrawing) endRedrawBlank(); }, 500);
  }

  ws.onopen = () => {
    setStatus('connected', 'Connected');
    // Clear stale content before resize — the TUI redraw will repaint correctly
    term.clear();
    startRedrawBlank();
    // Reset last-sent dimensions so reconnect always triggers a resize message,
    // even if the terminal size hasn't changed since the previous connection.
    // This is required for the server's toggle-resize trick to force a TUI redraw.
    _lastSentCols = 0;
    _lastSentRows = 0;
    sendResize();
    // Safety: show terminal after 8s max even if output hasn't stopped
    setTimeout(() => { if (_redrawing) endRedrawBlank(); }, 8000);
    _notifyConnectedAt = Date.now();
    _reconnectAttempt = 0;
  };

  ws.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'session_id') {
        currentSessionId = msg.id;
        updateSessionLabel(msg.id);
        updateTabIdentity(msg.id);
        // Badge: indicate which CLI is running (Claude orange / Codex green)
        if (msg.cli) {
          const logo = document.querySelector('#header .logo');
          if (logo) logo.title = `CLI: ${msg.cli}`;
          let cliBadge = document.getElementById('cli-badge');
          if (!cliBadge) {
            cliBadge = document.createElement('span');
            cliBadge.id = 'cli-badge';
            cliBadge.style.cssText = 'font-size:10px;padding:2px 8px;border-radius:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-left:6px;';
            const label = document.getElementById('status-label');
            if (label && label.parentNode) label.parentNode.insertBefore(cliBadge, label.nextSibling);
          }
          cliBadge.textContent = msg.cli;
          if (msg.cli === 'codex') {
            cliBadge.style.background = '#2ea04320';
            cliBadge.style.color = '#a5d6a7';
            cliBadge.style.border = '1px solid #2ea04340';
          } else {
            cliBadge.style.background = '#f7816620';
            cliBadge.style.color = '#f78166';
            cliBadge.style.border = '1px solid #f7816640';
          }
        }
        const _urlParams = new URLSearchParams(location.search);
        _urlParams.set('id', msg.id);
        const newUrl = `${location.pathname}?${_urlParams.toString()}`;
        if (location.search !== `?${_urlParams.toString()}`) {
          history.replaceState(null, '', newUrl);
        }
      } else if (msg.type === 'output' || msg.type === 'error') {
        if (_redrawing) resetRedrawTimer();
        // Batch writes: accumulate data and flush via rAF to avoid flooding xterm.js
        _writeBuf += msg.data;
        if (!_writeRaf) {
          _writeRaf = requestAnimationFrame(() => {
            _writeRaf = null;
            const chunk = _writeBuf;
            _writeBuf = '';
            const wasAtBottom = isAtBottom();
            term.write(chunk, () => { if (wasAtBottom) term.scrollToBottom(); });
          });
        }
        notifyOnOutput(msg.data);
      } else if (msg.type === 'exit') {
        term.write(msg.data);
        _sessionExited = true;
        setStatus('disconnected', 'Session ended');
      } else if (msg.type === 'restart') {
        term.clear();
        term.write(`\x1b[33m[正在重启 Claude 命令…]\x1b[0m\r\n`);
        _wsGen++;          // invalidate onclose so it won't auto-reconnect
        _reconnectAttempt = 0;
        ws.close();
        setTimeout(() => connect(), 300);  // new session already ready on server
      } else if (msg.type === 'relocate') {
        term.clear();
        term.write(`\x1b[33m[正在切换到: ${msg.cwd}]\x1b[0m\r\n`);
        filesBrowsePath = null; // reset so panel loads new cwd on next open/refresh
        _wsGen++;  // invalidate current onclose handler to prevent auto-reconnect
        ws.close();
        setTimeout(() => {
          connect();
          if (filesPanelOpen) setTimeout(() => loadFiles(null), 1000);
        }, 800);
      } else if (msg.type === 'file_saved') {
        onFileSaved(msg);
      }
    } catch (e) {
      console.error('Parse error:', e);
    }
  };

  ws.onclose = () => {
    if (gen !== _wsGen) return;    // stale — connect() or relocate already called
    if (_sessionExited) {
      setStatus('disconnected', 'Session ended');
    } else {
      setStatus('disconnected', 'Disconnected');
      scheduleReconnect();
    }
  };

  ws.onerror = () => {};  // onclose fires after onerror, reconnect handled there
}

// Immediately reconnect when page returns to foreground (mobile app switch)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (_sessionExited) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    // Connection is alive — force a resize to trigger tmux TUI redraw so the
    // user can see the current process state (waiting for input, completed, etc.)
    _lastSentCols = 0;
    _lastSentRows = 0;
    sendResize();
    return;
  }
  // Page came back to foreground with a dead connection — reconnect immediately
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  _reconnectAttempt = 0;
  connect();
});

/* ── Restart session ── */
const restartBtn = document.getElementById('restart-btn');
if (restartBtn) {
  restartBtn.addEventListener('click', () => {
    if (!currentSessionId) return;
    // Double-click guard: disable button during restart
    restartBtn.disabled = true;
    setTimeout(() => { restartBtn.disabled = false; }, 3000);
    fetch(withToken(`/api/sessions/${currentSessionId}/restart`), { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          term.write(`\r\n\x1b[31m[Restart failed: ${data.error}]\x1b[0m\r\n`);
        }
        // Server sends 'restart' message via WebSocket, handled below
      })
      .catch(err => {
        term.write(`\r\n\x1b[31m[Restart failed: ${err.message}]\x1b[0m\r\n`);
      });
  });
}

const mergeBtn = document.getElementById('merge-btn');
if (mergeBtn) {
  mergeBtn.addEventListener('click', async () => {
    if (!currentSessionId) return;
    if (!confirm('把此会话 worktree 的改动合并回基分支？\n未提交的改动会先自动提交。')) return;
    mergeBtn.disabled = true;
    term.write('\r\n\x1b[36m[正在合并 worktree...]\x1b[0m\r\n');
    try {
      const res = await fetch(withToken(`/api/sessions/${currentSessionId}/merge`), { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        term.write(data.merged
          ? `\x1b[32m[✓ 已合并 ${data.commits} 个提交回基分支]\x1b[0m\r\n`
          : `\x1b[32m[✓ ${data.message || '没有新提交需要合并'}]\x1b[0m\r\n`);
      } else if (res.status === 409) {
        term.write(`\x1b[31m[⚠️ 合并冲突，已 abort。冲突文件: ${(data.conflicts || []).join(', ')}]\x1b[0m\r\n`);
      } else {
        term.write(`\x1b[31m[合并失败: ${data.error || res.status}]\x1b[0m\r\n`);
      }
    } catch (err) {
      term.write(`\x1b[31m[合并请求失败: ${err.message}]\x1b[0m\r\n`);
    } finally {
      mergeBtn.disabled = false;
    }
  });
}

function sendResize() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}

/* ── Input: terminal → server ── */
term.onData((data) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data }));
  }
  notifyOnInput(data);
});

/* ── Resize handling (mobile-aware) ── */
// Track last sent cols/rows to avoid no-op resizes
let _lastSentCols = 0;
let _lastSentRows = 0;
let _resizeTimer = null;

// On mobile, detect keyboard open/close via height change.
// Only send resize to server when width changes (orientation) or height changes significantly.
let _lastViewportWidth = window.innerWidth;
let _lastViewportHeight = window.innerHeight;

function handleResize() {
  fitAddon.fit();

  const cols = term.cols;
  const rows = term.rows;

  // Skip if dimensions haven't actually changed
  if (cols === _lastSentCols && rows === _lastSentRows) return;

  if (_isMobile) {
    const widthChanged = Math.abs(window.innerWidth - _lastViewportWidth) > 10;
    const heightDelta = window.innerHeight - _lastViewportHeight;

    // Keyboard open/close: width stays same, height shrinks/grows significantly
    // In this case, do NOT resize the tmux pane — just refit the local terminal
    if (!widthChanged && Math.abs(heightDelta) > 100) {
      // Keyboard event — skip tmux resize to avoid TUI redraw / jump
      _lastViewportHeight = window.innerHeight;
      return;
    }

    _lastViewportWidth = window.innerWidth;
    _lastViewportHeight = window.innerHeight;
  }

  _lastSentCols = cols;
  _lastSentRows = rows;
  sendResize();
}

const resizeObs = new ResizeObserver(() => {
  if (_resizeTimer) clearTimeout(_resizeTimer);
  // Debounce: 80ms on desktop, 300ms on mobile
  _resizeTimer = setTimeout(handleResize, _isMobile ? 300 : 80);
});
resizeObs.observe(document.getElementById('terminal-wrap'));

term.onResize(() => {
  // Only forward if dimensions genuinely changed (fitAddon already called)
  if (term.cols !== _lastSentCols || term.rows !== _lastSentRows) {
    _lastSentCols = term.cols;
    _lastSentRows = term.rows;
    sendResize();
  }
});

/* ── Start (moved to end of file, after all const declarations) ── */
// see bottom of file

/* ── Voice Input (Whisper STT via MediaRecorder) ── */
const micBtn    = document.getElementById('mic-btn');
const micStatus = document.getElementById('mic-status');
let mediaRecorder   = null;
let audioChunks     = [];
let isRecording     = false;
let recordingStream = null;

// Voice panel elements
const voicePanel   = document.getElementById('voice-panel');
const vpRaw        = document.getElementById('vp-raw');
const vpRefined    = document.getElementById('vp-refined');
const vpStatus     = document.getElementById('vp-status');
const vpUseRaw     = document.getElementById('vp-use-raw');
const vpUseRefined = document.getElementById('vp-use-refined');
const vpCancel     = document.getElementById('vp-cancel');

let _vpRefinedFinal = '';  // tracks last fully-streamed AI text

function closeVoicePanel() {
  voicePanel.classList.remove('open');
}

function sendVoiceText(text, raw, refined) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data: text }));
  }
  // Save feedback (server ignores if userFinal === refined)
  fetch(withToken(`/api/voice/feedback`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw, refined, userFinal: text }),
  }).catch(() => {});
  closeVoicePanel();
}

async function fetchRefined(raw) {
  console.log('[voice-client] fetchRefined called, raw length:', raw.length);
  vpStatus.textContent = '处理中…';
  vpRefined.value = '';
  vpRefined.placeholder = 'AI 处理中…';
  _vpRefinedFinal = '';
  const timingInfo = {};
  const vpTimingEl = document.getElementById('vp-timing');
  if (vpTimingEl) vpTimingEl.textContent = '';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.warn('[voice-client] AbortController timeout fired (75s)');
    controller.abort();
  }, 75000);
  try {
    const fetchStart = Date.now();
    console.log('[voice-client] Sending POST /api/voice/refine ...');
    const res = await fetch(withToken(`/api/voice/refine`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
      signal: controller.signal,
    });
    console.log('[voice-client] Response received, status:', res.status, 'ok:', res.ok);
    console.log('[voice-client] Response headers:', [...res.headers.entries()].map(([k,v]) => `${k}: ${v}`).join(', '));
    if (!res.body) {
      console.error('[voice-client] res.body is null/undefined! Cannot stream.');
      vpStatus.textContent = '⚠ 浏览器不支持流式读取';
      vpRefined.placeholder = '（处理失败，可手动输入）';
      return;
    }
    const reader = res.body.getReader();
    console.log('[voice-client] Got ReadableStream reader');
    const decoder = new TextDecoder();
    let buf = '';
    let streamDone = false;
    let chunkCount = 0;
    let totalBytes = 0;
    while (!streamDone) {
      const { done, value } = await reader.read();
      console.log(`[voice-client] reader.read() => done=${done}, value length=${value ? value.length : 0}`);
      if (done) {
        console.log('[voice-client] Stream ended (done=true). Total chunks:', chunkCount, 'Total bytes:', totalBytes);
        break;
      }
      chunkCount++;
      totalBytes += value.length;
      const decoded = decoder.decode(value, { stream: true });
      console.log(`[voice-client] Chunk #${chunkCount} decoded (${decoded.length} chars):`, JSON.stringify(decoded.slice(0, 200)));
      buf += decoded;
      const lines = buf.split('\n');
      buf = lines.pop();  // keep incomplete line
      console.log(`[voice-client] Split into ${lines.length} complete lines, remaining buf: ${JSON.stringify(buf.slice(0, 100))}`);
      for (const line of lines) {
        if (!line.startsWith('data: ')) {
          if (line.trim()) console.log('[voice-client] Skipping non-data line:', JSON.stringify(line));
          continue;
        }
        const payload = line.slice(6).trim();
        console.log('[voice-client] SSE payload:', JSON.stringify(payload.slice(0, 200)));
        if (payload === '[DONE]') {
          console.log('[voice-client] Received [DONE] signal');
          streamDone = true;
          break;
        }
        try {
          const parsed = JSON.parse(payload);
          if (parsed.timing) {
            console.log(`[voice-client] Timing event: ${parsed.timing} = ${parsed.ms}ms`);
            timingInfo[parsed.timing] = parsed.ms;
          } else {
            console.log('[voice-client] Parsed JSON text:', JSON.stringify(parsed.text?.slice(0, 100)));
            vpRefined.value += parsed.text;
            _vpRefinedFinal = vpRefined.value;
          }
        } catch (parseErr) {
          console.error('[voice-client] JSON parse error for payload:', JSON.stringify(payload), parseErr);
        }
      }
    }
    // Calculate frontend total time
    timingInfo.frontend_total = Date.now() - fetchStart;
    console.log('[voice-client] Stream processing complete. vpRefined.value:', JSON.stringify(vpRefined.value.slice(0, 200)));
    console.log('[voice-client] Timing info:', timingInfo);
    if (vpRefined.value.trim()) {
      vpStatus.textContent = '✓ 完成';
    } else {
      vpStatus.textContent = '⚠ AI 未返回结果';
      console.warn('[voice-client] AI returned empty result after processing');
    }
    vpRefined.placeholder = '（AI 处理完毕，可手动编辑）';
    // Display timing info
    if (vpTimingEl) {
      const labels = [];
      if (timingInfo.queue != null) labels.push(`排队 ${(timingInfo.queue / 1000).toFixed(1)}s`);
      if (timingInfo.first_token != null) labels.push(`首字节 ${(timingInfo.first_token / 1000).toFixed(1)}s`);
      if (timingInfo.ai_process != null) labels.push(`AI处理 ${(timingInfo.ai_process / 1000).toFixed(1)}s`);
      if (timingInfo.frontend_total != null) labels.push(`总耗时 ${(timingInfo.frontend_total / 1000).toFixed(1)}s`);
      vpTimingEl.textContent = labels.join(' | ');
    }
  } catch (e) {
    console.error('[voice-client] fetchRefined error:', e.name, e.message, e);
    if (e.name === 'AbortError') {
      vpStatus.textContent = '⚠ 超时';
    } else {
      vpStatus.textContent = '⚠ 失败';
    }
    vpRefined.placeholder = '（处理失败，可手动输入）';
  } finally {
    clearTimeout(timeoutId);
    console.log('[voice-client] fetchRefined finished. Final status:', vpStatus.textContent);
  }
}

function showVoicePanel(rawText) {
  vpRaw.value = rawText;
  vpRefined.value = '';
  vpRefined.placeholder = '点击「AI 重排」按钮处理';
  vpStatus.textContent = '';
  _vpRefinedFinal = '';
  voicePanel.classList.add('open');
  // No longer auto-refine — user clicks the button when ready
}

vpUseRaw.addEventListener('click', () => {
  sendVoiceText(vpRaw.value, vpRaw.value, _vpRefinedFinal);
});

vpUseRefined.addEventListener('click', () => {
  // If AI hasn't been run yet, trigger it first
  if (!vpRefined.value.trim() && vpRaw.value.trim()) {
    fetchRefined(vpRaw.value);
    return;
  }
  sendVoiceText(vpRefined.value, vpRaw.value, _vpRefinedFinal);
});

vpCancel.addEventListener('click', closeVoicePanel);

voicePanel.addEventListener('click', (e) => {
  if (e.target === voicePanel) closeVoicePanel();
});

// ── Native bridge callbacks (Android WebView) ──
const _hasNativeBridge = !!(window.MultiCCBridge && window.MultiCCBridge.isAvailable());

let _bridgeRecTimeout = null;

// Called when Java confirms recording started
window.__multiccRecStarted = () => {
  console.log('[voice-bridge] recording started on native side');
};

// Called when recording file is ready — fetch it via localhost URL
window.__multiccRecReady = async () => {
  clearTimeout(_bridgeRecTimeout);
  isRecording = false;
  micBtn.classList.remove('active');
  micStatus.textContent = '识别中…';
  try {
    const resp = await fetch('http://localhost/__recording');
    const blob = await resp.blob();
    if (blob.size > 0) {
      uploadAudioForSTT(blob);
    } else {
      micStatus.textContent = '录音为空';
      setTimeout(() => { micStatus.textContent = ''; }, 3000);
    }
  } catch (e) {
    console.error('[voice-bridge] fetch recording error:', e);
    micStatus.textContent = `获取录音失败: ${e.message}`;
    setTimeout(() => { micStatus.textContent = ''; }, 4000);
  }
};

window.__multiccRecError = (msg) => {
  clearTimeout(_bridgeRecTimeout);
  isRecording = false;
  micBtn.classList.remove('active');
  micStatus.textContent = `录音错误: ${msg}`;
  console.error('[voice-bridge] error:', msg);
  setTimeout(() => { micStatus.textContent = ''; }, 4000);
};

function startRecording() {
  if (_hasNativeBridge) {
    window.MultiCCBridge.startRecording();
    isRecording = true;
    micBtn.classList.add('active');
    micStatus.textContent = '正在录音…';
    return;
  }

  // Browser recording via getUserMedia
  audioChunks = [];
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';

  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    recordingStream = stream;
    const options = mimeType ? { mimeType } : {};
    mediaRecorder = new MediaRecorder(stream, options);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      if (recordingStream) {
        recordingStream.getTracks().forEach(t => t.stop());
        recordingStream = null;
      }
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      audioChunks = [];
      if (blob.size > 0) {
        uploadAudioForSTT(blob);
      }
    };

    mediaRecorder.start();
    isRecording = true;
    micBtn.classList.add('active');
    micStatus.textContent = '正在录音…';
  }).catch(err => {
    console.error('[voice] getUserMedia error:', err);
    micStatus.textContent = `麦克风错误: ${err.message}`;
    setTimeout(() => { micStatus.textContent = ''; }, 3000);
  });
}

function stopRecording() {
  if (_hasNativeBridge && isRecording) {
    micStatus.textContent = '处理中…';
    // Timeout: if Java callback never fires, reset state
    _bridgeRecTimeout = setTimeout(() => {
      if (isRecording) {
        isRecording = false;
        micBtn.classList.remove('active');
        micStatus.textContent = '录音超时，请重试';
        setTimeout(() => { micStatus.textContent = ''; }, 3000);
      }
    }, 15000);
    try { window.MultiCCBridge.stopRecording(); } catch (e) {
      clearTimeout(_bridgeRecTimeout);
      isRecording = false;
      micBtn.classList.remove('active');
      micStatus.textContent = `停止失败: ${e.message}`;
      setTimeout(() => { micStatus.textContent = ''; }, 3000);
    }
    return;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  isRecording = false;
  micBtn.classList.remove('active');
  micStatus.textContent = '';
}

async function uploadAudioForSTT(blob) {
  micBtn.classList.add('processing');
  micStatus.textContent = '识别中…';
  try {
    const formData = new FormData();
    formData.append('file', blob, 'recording.webm');
    const res = await fetch(withToken(`/api/voice/stt`), { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    micStatus.textContent = '';
    if (data.text && data.text.trim()) {
      showVoicePanel(data.text.trim());
    } else {
      micStatus.textContent = '未识别到语音';
      setTimeout(() => { micStatus.textContent = ''; }, 3000);
    }
  } catch (err) {
    console.error('[voice] STT upload error:', err);
    micStatus.textContent = `识别失败: ${err.message}`;
    setTimeout(() => { micStatus.textContent = ''; }, 4000);
  } finally {
    micBtn.classList.remove('processing');
  }
}

/* ── Streaming voice (real-time ASR: 边说边出字) ── */
let _asrCfg = null;          // d.asr from /api/settings/voice
let _voiceLang = 'zh';
let _voiceStream = null;
let _streamingActive = false;

fetch(withToken('/api/settings/voice'))
  .then(r => r.json())
  .then(d => { _asrCfg = d.asr || null; _voiceLang = d.whisperLanguage || 'zh'; })
  .catch(() => {});

function streamingAvailable() {
  const s = _asrCfg && _asrCfg.status;
  return !!(s && (s.openai?.ready || s.volcano?.ready || s.funasr?.ready));
}

function startStreamingVoice() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = withToken(`${proto}//${location.host}/ws/voice`);
  showVoicePanel('');
  vpRaw.placeholder = '聆听中…';
  vpStatus.textContent = '● 聆听中';
  micBtn.classList.add('active');
  _streamingActive = true;
  isRecording = true;
  const reset = () => { _streamingActive = false; isRecording = false; micBtn.classList.remove('active'); };
  _voiceStream = new VoiceStream({
    wsUrl,
    provider: 'auto',
    lang: _voiceLang,
    onText: (full) => { vpRaw.value = full; },
    onDone: (finalText) => {
      vpStatus.textContent = (finalText || vpRaw.value).trim() ? '✓ 识别完成' : '未识别到语音';
      reset();
    },
    onError: (msg) => { vpStatus.textContent = '⚠ ' + msg; reset(); },
  });
  _voiceStream.start().catch(err => {
    vpStatus.textContent = '⚠ ' + (err.message || '启动失败');
    reset();
  });
}

function stopStreamingVoice() {
  vpStatus.textContent = '识别中…';
  micBtn.classList.remove('active');
  if (_voiceStream) _voiceStream.stop();
}

const _canLegacyRecord = _hasNativeBridge || (typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices);
const _canStream = !!(navigator.mediaDevices && window.AudioWorkletNode && window.VoiceStream && !_hasNativeBridge);

if (!_canLegacyRecord && !_canStream) {
  micBtn.disabled = true;
  micBtn.title = '此浏览器不支持录音（需要 HTTPS 或 localhost）';
} else {
  micBtn.onclick = () => {
    // Real-time streaming when a provider is configured; otherwise legacy upload.
    if (_canStream && streamingAvailable()) {
      if (_streamingActive) stopStreamingVoice();
      else startStreamingVoice();
      return;
    }
    if (isRecording) stopRecording();
    else startRecording();
  };
}

/* ── File Attachment ── */
const attachBtn  = document.getElementById('attach-btn');
const fileInput  = document.getElementById('file-input');
const attachArea = document.getElementById('attachments');

// tempId → chip element
const pendingChips = new Map();

attachBtn.onclick = () => fileInput.click();

fileInput.onchange = () => {
  const file = fileInput.files[0];
  if (!file) return;
  fileInput.value = '';
  uploadFile(file);
};

function onFileSaved({ tempId, path: filePath, name }) {
  const chip = pendingChips.get(tempId);
  if (chip) {
    chip.dataset.path = filePath;
    chip.classList.remove('pending');
    chip.title = `点击插入路径：${filePath}`;
    pendingChips.delete(tempId);
  }
  // On mobile, also insert path into the input field so it's visible and ready to send
  if (_isMobile && filePath) {
    const mi = document.getElementById('mobile-input');
    if (mi) {
      mi.value = (mi.value ? mi.value + ' ' : '') + filePath;
      mi.focus();
    }
  }
}

function createChip(name, thumbUrl, filePath) {
  const chip = document.createElement('div');
  chip.className = 'attach-chip';
  if (filePath) { chip.dataset.path = filePath; chip.title = `点击插入路径：${filePath}`; }

  if (thumbUrl) {
    const img = document.createElement('img');
    img.src = thumbUrl;
    chip.appendChild(img);
  } else {
    const icon = document.createElement('span');
    icon.style.cssText = 'font-size:16px;width:22px;height:22px;display:flex;align-items:center;justify-content:center;flex-shrink:0;';
    icon.textContent = getFileIcon(name);
    chip.appendChild(icon);
  }

  const span = document.createElement('span');
  span.className   = 'chip-name';
  span.textContent = name;

  const rm = document.createElement('span');
  rm.className   = 'chip-remove';
  rm.textContent = '×';
  rm.title       = '移除';
  rm.onclick = (e) => { e.stopPropagation(); chip.remove(); };

  chip.append(span, rm);

  // Click body → type path into terminal
  chip.onclick = (e) => {
    if (e.target === rm) return;
    if (!chip.dataset.path) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: chip.dataset.path }));
    }
    term.focus();
  };

  attachArea.appendChild(chip);
  return chip;
}

/* visualViewport handler at top of file (fixMobileLayout) */

/* ── Mobile: tap terminal area to focus input bar ── */
document.getElementById('terminal-wrap').addEventListener('click', () => {
  const mobileInput = document.getElementById('mobile-input');
  if (mobileInput && getComputedStyle(document.getElementById('mobile-bar')).display !== 'none') {
    mobileInput.focus();
  }
}, { passive: true });

/* ── Mobile Input Bar ── */
const mobileInput = document.getElementById('mobile-input');
const mobileSend  = document.getElementById('mobile-send');

function sendToTerminal(text) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data: text }));
  }
}

// Special key buttons
document.getElementById('mobile-keys').addEventListener('click', (e) => {
  const btn = e.target.closest('.mkey');
  if (!btn) return;
  sendToTerminal(btn.dataset.seq);
  // Brief visual feedback without stealing keyboard focus from input
});

// Collect attached file paths and clear chips
function collectAttachments() {
  const chips = attachArea.querySelectorAll('.attach-chip[data-path]');
  const paths = [];
  chips.forEach(chip => {
    if (chip.dataset.path) paths.push(chip.dataset.path);
    chip.remove();
  });
  return paths;
}

function mobileSendAll() {
  let text = mobileInput.value;
  const paths = collectAttachments();
  if (paths.length) {
    text = (text ? text + ' ' : '') + paths.join(' ');
  }
  // Always send — empty text = bare Enter (confirms selections, default options, etc.)
  mobileInput.value = '';
  sendToTerminal(text + '\r');
  mobileInput.focus();
}

// Send button
mobileSend.addEventListener('click', mobileSendAll);

// Enter key on mobile input → send
mobileInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    mobileSendAll();
  }
});

/* ── Relocate Directory Dialog ── */
const saveCwdBtn       = document.getElementById('save-cwd-btn');
const relocateModal    = document.getElementById('relocate-modal');
const relocateCurrent  = document.getElementById('relocate-current');
const relocateInput    = document.getElementById('relocate-input');
const relocateCancel   = document.getElementById('relocate-cancel');
const relocateConfirm  = document.getElementById('relocate-confirm');
const relocateError    = document.getElementById('relocate-error');

async function openRelocateDialog() {
  if (!currentSessionId) return;
  relocateError.style.display = 'none';
  relocateCurrent.textContent = '获取中…';
  relocateInput.value = '';
  relocateModal.style.display = 'flex';
  try {
    const res = await fetch(withToken(`/api/sessions/${currentSessionId}`));
    const s = await res.json();
    const cwd = s.cwd || '';
    relocateCurrent.textContent = cwd || '(未知)';
    relocateInput.value = cwd;
  } catch (_) {
    relocateCurrent.textContent = '(获取失败)';
  }
  relocateInput.focus();
  relocateInput.select();
}

saveCwdBtn.addEventListener('click', openRelocateDialog);

relocateCancel.addEventListener('click', () => {
  relocateModal.style.display = 'none';
});

relocateModal.addEventListener('click', (e) => {
  if (e.target === relocateModal) relocateModal.style.display = 'none';
});

relocateInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') relocateConfirm.click();
  if (e.key === 'Escape') relocateCancel.click();
});

relocateConfirm.addEventListener('click', async () => {
  const newCwd = relocateInput.value.trim();
  if (!newCwd) {
    relocateError.textContent = '请输入目录路径';
    relocateError.style.display = 'block';
    return;
  }
  relocateConfirm.disabled = true;
  relocateConfirm.textContent = '切换中…';
  relocateError.style.display = 'none';
  try {
    const res = await fetch(withToken(`/api/sessions/${currentSessionId}/relocate`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: newCwd }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '切换失败');
    relocateModal.style.display = 'none';
    // Server sends a 'relocate' WS message which triggers clear + reconnect
  } catch (e) {
    relocateError.textContent = e.message;
    relocateError.style.display = 'block';
  } finally {
    relocateConfirm.disabled = false;
    relocateConfirm.textContent = '切换目录';
  }
});

/* ── File Browser Panel ── */
const filesPanel      = document.getElementById('files-panel');
const filesList       = document.getElementById('files-list');
const filesPanelPath  = document.getElementById('files-panel-path');
const filesError      = document.getElementById('files-error');
const filesBtn        = document.getElementById('files-btn');
const filesRefreshBtn = document.getElementById('files-refresh-btn');
const filesCloseBtn   = document.getElementById('files-close-btn');

let filesBrowsePath = null;   // current directory shown in panel
let filesPanelOpen  = false;

// File types that browsers can display inline
const INLINE_EXTS = new Set([
  'jpg','jpeg','png','gif','webp','svg','bmp','ico',
  'pdf',
  'txt','md','log','json','yaml','yml','toml','ini','conf',
  'js','ts','jsx','tsx','mjs','cjs',
  'html','htm','xml','css','scss','less',
  'sh','bash','zsh','fish','py','rb','go','rs','java','c','cpp','h','cs',
  'mp4','webm',
  'mp3','wav','ogg','flac',
]);

function fileExt(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function formatSize(bytes) {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function loadFiles(dirPath) {
  filesError.style.display = 'none';
  filesList.innerHTML = '<div style="padding:16px 12px; font-size:12px; color:#6e7681;">加载中…</div>';

  const params = new URLSearchParams();
  if (dirPath) {
    params.set('path', dirPath);
  } else if (currentSessionId) {
    params.set('session', currentSessionId);
  }

  try {
    const res  = await fetch(withToken(`/api/files?${params}`));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '加载失败');

    filesBrowsePath = data.path;
    filesPanelPath.textContent = data.path;
    renderFiles(data);
  } catch (e) {
    filesError.textContent = e.message;
    filesError.style.display = 'block';
    filesList.innerHTML = '';
  }
}

function renderFiles({ path: dir, parent, files }) {
  filesList.innerHTML = '';

  // ".." entry
  if (parent) {
    const item = makeFileItem('..', true, null, null, () => loadFiles(parent));
    item.classList.add('is-up');
    filesList.appendChild(item);
  }

  if (files.length === 0) {
    filesList.innerHTML += '<div style="padding:16px 12px; font-size:12px; color:#6e7681;">目录为空</div>';
    return;
  }

  for (const f of files) {
    const onDirClick = f.isDir ? () => loadFiles(f.path) : null;
    filesList.appendChild(makeFileItem(f.name, f.isDir, f.path, f.size, onDirClick));
  }
}

function makeFileItem(name, isDir, fullPath, size, onDirClick) {
  const item = document.createElement('div');
  item.className = 'file-item' + (isDir ? ' is-dir' : '');

  const icon = document.createElement('span');
  icon.className = 'fi-icon';
  icon.textContent = isDir ? '📁' : getFileIcon(name);

  const nameEl = document.createElement('span');
  nameEl.className = 'fi-name';
  nameEl.textContent = name;
  if (onDirClick) nameEl.addEventListener('click', onDirClick);

  item.append(icon, nameEl);

  if (!isDir && fullPath) {
    const sizeEl = document.createElement('span');
    sizeEl.className = 'fi-size';
    sizeEl.textContent = formatSize(size);

    const actions = document.createElement('div');
    actions.className = 'fi-actions';

    const downloadBtn = document.createElement('a');
    downloadBtn.className = 'fi-action-btn';
    downloadBtn.title = '下载';
    downloadBtn.textContent = '↓';
    downloadBtn.href = withToken(`/api/download?path=${encodeURIComponent(fullPath)}`);
    downloadBtn.download = name;

    actions.appendChild(downloadBtn);

    if (INLINE_EXTS.has(fileExt(name))) {
      const viewBtn = document.createElement('a');
      viewBtn.className = 'fi-action-btn';
      viewBtn.title = '在浏览器中打开';
      viewBtn.textContent = '👁';
      viewBtn.href = withToken(`/api/download?path=${encodeURIComponent(fullPath)}&inline=1`);
      viewBtn.target = '_blank';
      viewBtn.rel = 'noopener';
      actions.appendChild(viewBtn);
    }

    item.append(sizeEl, actions);
  }

  return item;
}

function getFileIcon(name) {
  const ext = fileExt(name);
  const imgExts = new Set(['jpg','jpeg','png','gif','webp','svg','bmp','ico']);
  const videoExts = new Set(['mp4','webm','mov','avi']);
  const audioExts = new Set(['mp3','wav','ogg','flac','m4a']);
  const codeExts = new Set(['js','ts','jsx','tsx','py','go','rs','java','c','cpp','h','cs','sh','bash','rb','php']);
  const docExts = new Set(['pdf','doc','docx']);
  const archiveExts = new Set(['zip','tar','gz','7z','rar','bz2']);
  if (imgExts.has(ext)) return '🖼️';
  if (videoExts.has(ext)) return '🎬';
  if (audioExts.has(ext)) return '🎵';
  if (ext === 'pdf') return '📕';
  if (codeExts.has(ext)) return '📝';
  if (docExts.has(ext)) return '📄';
  if (archiveExts.has(ext)) return '📦';
  if (ext === 'json' || ext === 'yaml' || ext === 'yml') return '📋';
  return '📄';
}

function openFilesPanel() {
  filesPanelOpen = true;
  filesPanel.classList.add('open');
  filesBtn.style.background = '#1f6feb';
  filesBtn.style.borderColor = '#58a6ff';
  loadFiles(filesBrowsePath);
}

function closeFilesPanel() {
  filesPanelOpen = false;
  filesPanel.classList.remove('open');
  filesBtn.style.background = '';
  filesBtn.style.borderColor = '';
}

filesBtn.addEventListener('click', () => {
  if (filesPanelOpen) closeFilesPanel(); else openFilesPanel();
});

filesRefreshBtn.addEventListener('click', () => loadFiles(filesBrowsePath));
filesCloseBtn.addEventListener('click', closeFilesPanel);

/* ── Drag-and-drop files onto the toolbar ── */
document.getElementById('input-toolbar').addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

document.getElementById('input-toolbar').addEventListener('drop', (e) => {
  e.preventDefault();
  for (const file of e.dataTransfer.files) {
    uploadFile(file);
  }
});

/* ── Paste from clipboard (images + files) ── */
document.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === 'file') {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) uploadFile(file);
      return;
    }
  }
});

/* ── Shared file upload helper ── */
const MAX_UPLOAD_SIZE = 25 * 1024 * 1024; // 25 MB

function uploadFile(file) {
  if (file.size > MAX_UPLOAD_SIZE) {
    alert(`文件过大：${(file.size / 1024 / 1024).toFixed(1)} MB，上限 25 MB`);
    return;
  }
  const reader = new FileReader();
  const isImage = file.type.startsWith('image/');
  reader.onload = (ev) => {
    const dataUrl = ev.target.result;
    const base64  = dataUrl.split(',')[1];
    const tempId  = `up_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const name    = file.name || `upload_${Date.now()}`;
    const chip = createChip(name, isImage ? dataUrl : null, null);
    chip.classList.add('pending');
    pendingChips.set(tempId, chip);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'upload', tempId, name, mime: file.type, data: base64 }));
    }
  };
  reader.readAsDataURL(file);
}

/* ── Initial Directory Picker (for new sessions) ── */
const initCwdModal   = document.getElementById('init-cwd-modal');
const initCwdInput   = document.getElementById('init-cwd-input');
const initCwdBrowser = document.getElementById('init-cwd-browser');
const initCwdError   = document.getElementById('init-cwd-error');
const initCwdConfirm = document.getElementById('init-cwd-confirm');
const initCwdSkip    = document.getElementById('init-cwd-skip');

const initSessionId  = document.getElementById('init-session-id');
let _initBrowsePath  = '';  // current browse path in the picker
let _initAllDirs     = []; // full directory list for filtering
let _initParent      = ''; // parent path for ".." entry

function showInitCwdPicker() {
  setStatus('disconnected', '请选择工作目录');
  if (!initCwdModal) { console.error('[multicc] init-cwd-modal not found'); connect(); return; }
  // Show modal FIRST, before anything that might throw
  initCwdModal.style.display = 'flex';
  try {
    if (initCwdInput) { initCwdInput.value = '~'; initCwdInput.focus(); initCwdInput.select(); }
    if (initCwdError) initCwdError.style.display = 'none';
    loadInitDirs('~');
  } catch (e) {
    console.error('[multicc] showInitCwdPicker error:', e);
  }
}

async function loadInitDirs(dirPath, updateInput = true) {
  try {
    const res = await fetch(withToken(`/api/files?path=${encodeURIComponent(dirPath)}`));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '加载失败');
    _initBrowsePath = data.path;
    _initParent = data.parent || '';
    _initAllDirs = data.files.filter(f => f.isDir);
    if (updateInput) initCwdInput.value = data.path;
    renderInitDirs(_initAllDirs);
  } catch (e) {
    initCwdBrowser.innerHTML = `<div style="padding:12px;font-size:12px;color:#f85149;">${e.message}</div>`;
  }
}

function renderInitDirs(dirs) {
  let html = '';
  if (_initParent) {
    html += `<div class="file-item is-up" data-path="${_initParent}" style="cursor:pointer;padding:5px 12px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #21262d;">
      <span style="font-size:14px;width:18px;text-align:center;">📁</span>
      <span style="font-size:12px;color:#8b949e;flex:1;">..</span>
    </div>`;
  }
  for (const d of dirs) {
    html += `<div class="file-item" data-path="${d.path}" style="cursor:pointer;padding:5px 12px;display:flex;align-items:center;gap:8px;">
      <span style="font-size:14px;width:18px;text-align:center;">📁</span>
      <span style="font-size:12px;color:#79c0ff;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${d.name}</span>
    </div>`;
  }
  if (!dirs.length && !_initParent) html = '<div style="padding:12px;font-size:12px;color:#8b949e;">无匹配目录</div>';
  initCwdBrowser.innerHTML = html;
  initCwdBrowser.querySelectorAll('.file-item').forEach(el => {
    el.addEventListener('click', () => loadInitDirs(el.dataset.path));
    el.addEventListener('mouseenter', () => { el.style.background = '#21262d'; });
    el.addEventListener('mouseleave', () => { el.style.background = ''; });
  });
}

initCwdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const val = initCwdInput.value.trim();
    if (val) loadInitDirs(val);
  }
});

initCwdInput.addEventListener('input', () => {
  const val = initCwdInput.value;
  // If user typed a path separator at the end, navigate into that directory
  if (val.endsWith('/')) {
    loadInitDirs(val, false);
    return;
  }
  // Extract the typed portion after the last /
  const lastSlash = val.lastIndexOf('/');
  const basePath = val.slice(0, lastSlash + 1);
  const filter = val.slice(lastSlash + 1).toLowerCase();

  // If user changed the base path (not just filtering), load that directory
  if (basePath && basePath !== _initBrowsePath && basePath !== _initBrowsePath + '/') {
    loadInitDirs(basePath, false);
    return;
  }
  // Filter current directory listing by typed text
  if (!filter) {
    renderInitDirs(_initAllDirs);
  } else {
    renderInitDirs(_initAllDirs.filter(d => d.name.toLowerCase().includes(filter)));
  }
});

initCwdConfirm.addEventListener('click', () => {
  const cwd = initCwdInput.value.trim() || '~';
  _initialCwd = cwd;
  _initialId = (initSessionId && initSessionId.value.trim()) || '';
  initCwdModal.style.display = 'none';
  connect();
});

initCwdSkip.addEventListener('click', () => {
  initCwdModal.style.display = 'none';
  connect();
});

/* ── Start ── */
// If this is a new session (no id in URL), show directory picker first
if (currentSessionId) {
  connect();
} else {
  showInitCwdPicker();
}
