'use strict';

// Disable browser scroll restoration — we always want to scroll to latest message
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

/* ── Config ── */
const _params = new URLSearchParams(location.search);
const _token = _params.get('token') || '';
let _cwd = _params.get('cwd') || '';
const _sessionName = _params.get('session') || '';  // dashboard session name
const _hasNativeBridge = typeof window.MultiCCBridge !== 'undefined' && !!window.MultiCCBridge;

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
function updateTabIdentity(id) {
  if (!id) return;
  _baseTitle = `${id} — MultiCC Chat`;
  document.title = _baseTitle;
  const letter = id.charAt(0).toUpperCase();
  const color = _hashColor(id);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#161b22"/><text x="32" y="45" text-anchor="middle" font-family="system-ui,sans-serif" font-size="38" font-weight="700" fill="${color}">${letter}</text></svg>`;
  let link = document.querySelector('link[rel="icon"]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
  link.type = 'image/svg+xml';
  link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}
if (_sessionName) updateTabIdentity(_sessionName);

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

/* ── State ── */
let ws = null;
let sessionId = null;

// Open the project's memo (multicc.memo.md) in a new tab/window.
function openMemo() {
  const u = new URLSearchParams(location.search);
  const sid = (typeof _sessionName !== 'undefined' && _sessionName) || u.get('id') || u.get('session');
  if (!sid) return;
  const token = u.get('token');
  const tokenParam = token ? '&token=' + encodeURIComponent(token) : '';
  window.open('/memo.html?sessionId=' + encodeURIComponent(sid) + tokenParam, '_blank');
}
let isStreaming = false;
let _pendingCancel = false; // cancel requested while WS was disconnected

// Context window tracking
let _contextWindow = 1000000;
let _usedTokens = 0;
let _costText = '';  // latest cost summary string, kept separate from the context readout

let currentMsgEl = null;
let currentTextContent = '';
let currentToolCards = new Map();
let activeContentType = null;
let activeContentIndex = -1;
let currentCli = 'claude';
let _mergeReady = false;
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
      addSystemMsg('✓ 已重新连接');
    }
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
        if (parts.length) addSystemMsg(parts.join(' | '));
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
      } else if (msg.subtype === 'agent_notes' && Array.isArray(msg.notes)) {
        addAgentNotes(msg.notes);
      } else if (msg.message) {
        addSystemMsg(msg.message);
      }
      break;

    case 'session_id':
      if (msg.id) { sessionId = msg.id; if (!_sessionName) updateTabIdentity(msg.id); }
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
      finishStreaming();
      stopTitleAnimation();
      // No notification here: a `result` only means the stream paused, which
      // happens between turns of a multi-step agent run too. The server's
      // aux-AI debounces the pause and sends a `notify` verdict — that's the
      // single judge (see 'notify' case).
      if (msg.total_cost_usd) {
        _costText = `$${msg.total_cost_usd.toFixed(4)} | ${msg.duration_ms}ms | ${msg.num_turns} turn(s)`;
      }
      updateContextBar(msg.usage, msg.modelUsage);
      updateUI();
      break;

    case 'chat_history':
      if (!_historyLoaded) {
        _historyLoaded = true;
        replayHistory(msg.messages);
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
      // Server-side aux-AI verdict that the turn finished / is waiting. This is
      // the single source of truth for completion notifications — we no longer
      // guess from `result` (which also fires between turns of an agent run).
      const waiting = msg.state === 'waiting';
      speakNotify(waiting ? '等待操作' : '任务已完成', waiting ? 'waiting' : 'completed');
      break;
    }

    case 'error':
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
      // Always start a fresh bubble at the end of the conversation.
      // Reusing a stale `currentMsgEl` (e.g. left over from an error or
      // a previous turn) puts streaming content into the wrong spot and
      // can place tool cards above the user message that triggered them.
      finishStreaming();
      currentMsgEl = createAssistantBubble();
      startTitleAnimation();
      updateUI();
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
        currentMsgEl.querySelector('.msg-content').appendChild(card);
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
      if (evt.usage) updateContextBar(evt.usage);
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
  for (const block of message.content) {
    if (block.type === 'text' && block.text) {
      if (!currentMsgEl) currentMsgEl = createAssistantBubble();
      if (currentCli === 'codex') {
        currentTextContent += block.text;
      } else if (!currentTextContent) {
        currentTextContent = block.text;
      }
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
        currentMsgEl.querySelector('.msg-content').appendChild(card);
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

function renderCurrentText(final = false) {
  if (!currentMsgEl) return;
  const contentEl = currentMsgEl.querySelector('.msg-content');
  if (!contentEl) return;

  const toolEls = contentEl.querySelectorAll('.tool-card');
  let html = '';
  if (currentTextContent.trim()) {
    html = renderMarkdown(currentTextContent);
  }

  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  contentEl.innerHTML = '';
  while (tmp.firstChild) contentEl.appendChild(tmp.firstChild);
  fixupLocalImages(contentEl);
  toolEls.forEach(el => contentEl.appendChild(el));

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

function addUserMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg user';
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
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
function replayHistory(messages) {
  if (!messages || !messages.length) return;
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    try {
    if (m.role === 'user') {
      addUserMsg(m.content);
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

      // Render tool calls as collapsed cards
      if (m.tools?.length) {
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
          contentEl.appendChild(card);
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

      div.appendChild(contentEl);
      messagesEl.appendChild(div);
    }
    } catch (err) {
      console.warn('[multicc] replayHistory: skipped message', mi, err.message);
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
function send() {
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
      addSystemMsg('Commands: /clear — clear chat history | /compact — ask Claude to compact context | /cost — show cost summary');
      inputEl.value = '';
      inputEl.style.height = 'auto';
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
    dbg('state', `send() — WS ▶ user_message (${text.length} chars)`);
    try {
      ws.send(JSON.stringify({ type: 'user_message', text }));
      _pendingCancel = false;
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
  // Calculate used tokens
  if (usage) {
    const input = usage.input_tokens || 0;
    const output = usage.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheCreate = usage.cache_creation_input_tokens || 0;
    _usedTokens = input + output + cacheRead + cacheCreate;
  }
  if (_usedTokens > 0) {
    const pct = Math.min(100, (_usedTokens / _contextWindow) * 100);
    const color = pct > 80 ? '#f85149' : pct > 50 ? '#d29922' : '#3fb950';
    const usedK = (_usedTokens / 1000).toFixed(1);
    const totalK = (_contextWindow / 1000).toFixed(0);
    // Rebuild from scratch each time — never read back costBar's own rendered
    // content, or the "Context: ..." readout concatenates onto itself forever.
    costBar.innerHTML =
      (_costText ? `<span style="margin-right:12px">${escHtml(_costText)}</span>` : '') +
      `<span style="color:${color}">Context: ${usedK}k / ${totalK}k (${pct.toFixed(1)}%)</span>` +
      `<span style="display:inline-block;width:80px;height:6px;background:#21262d;border-radius:3px;margin-left:6px;vertical-align:middle;">` +
        `<span style="display:block;width:${pct}%;height:100%;background:${color};border-radius:3px;"></span>` +
      `</span>`;
  }
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
sendBtn.addEventListener('click', send);
sendBtn.addEventListener('touchend', (e) => { e.preventDefault(); send(); });

// Cancel button
cancelBtn.addEventListener('click', cancelStreaming);
cancelBtn.addEventListener('touchend', (e) => { e.preventDefault(); cancelStreaming(); });

function mergeStatusText(st) {
  if (!st || !st.mergeReady) return '当前 worktree 没有需要合并的内容。';
  const bits = [];
  if (st.dirty) bits.push('有未提交改动');
  if ((st.ahead || 0) > 0) bits.push(`${st.ahead} 个提交领先`);
  return `当前 worktree ${bits.join('，')}，可以合并回 ${st.baseBranch || '基分支'}。`;
}

function applyMergeStatus(st) {
  _mergeReady = !!(st && st.mergeReady);
  if (mergeBtn) {
    mergeBtn.classList.toggle('merge-ready', _mergeReady);
    mergeBtn.title = _mergeReady ? mergeStatusText(st) : '把此会话 worktree 合并回基分支';
  }
  if (mergeHint) {
    mergeHint.classList.toggle('show', _mergeReady);
    const text = mergeHint.querySelector('.merge-hint-text');
    if (text) text.textContent = mergeStatusText(st);
  }
  applyBehindStatus(st);
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
        ? `⎇ ${branch} · 落后 ${base} ${behind} 个提交`
        : `⎇ ${branch}`;
      bar.innerHTML = '';
      const span = document.createElement('span');
      span.className = 'worktree-label';
      span.textContent = label;
      bar.appendChild(span);
      if (behind > 0) {
        const btn = document.createElement('button');
        btn.id = 'worktree-sync-btn';
        btn.textContent = '同步';
        btn.onclick = syncWorktree;
        bar.appendChild(btn);
      }
    } else {
      bar.classList.remove('show', 'behind');
      bar.innerHTML = '';
    }
  }
  if (behind > _lastWarnedBehind) {
    addSystemMsg(`⚠ 当前 worktree（${branch}）已落后 ${base} ${behind} 个提交，点顶部「同步」按钮可直接合并。`);
  }
  _lastWarnedBehind = behind;
}

// One-click sync: pull the base branch into this session's worktree.
async function syncWorktree() {
  if (!_sessionName) { addSystemMsg('无 session id，无法同步'); return; }
  const btn = document.getElementById('worktree-sync-btn');
  if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/sync`), { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      addSystemMsg(data.merged
        ? `✓ 已从 ${data.baseBranch || 'base'} 同步 ${data.commits} 个提交${data.committed ? '（已自动提交未保存改动）' : ''}`
        : (data.message || '已是最新'));
      refreshMergeStatus();
    } else if (res.status === 409 && data.conflicts) {
      addSystemMsg(`✗ 同步存在冲突，已自动 abort，worktree 未改动：\n${data.conflicts.join(', ')}\n请在终端手动合并。`);
    } else {
      addSystemMsg(`✗ 同步失败：${data.error || res.status}`);
    }
  } catch (e) {
    addSystemMsg(`✗ 同步请求失败：${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '同步'; }
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
async function requestMerge() {
  if (!_sessionName) { addSystemMsg('无 session id，无法合并 worktree'); return; }
  const prompt = _mergeReady
    ? '当前 worktree 有可合并内容。\n合并前会自动提交未提交改动，是否继续？'
    : '把此会话 worktree 的改动合并回基分支？\n未提交的改动会先自动提交。';
  if (!confirm(prompt)) return;
  addSystemMsg('正在合并 worktree...');
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/merge`), { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      addSystemMsg(data.merged
        ? `✓ 已合并 ${data.commits} 个提交回基分支${data.committed ? '（含本次自动提交）' : ''}`
        : `✓ ${data.message || '没有新提交需要合并'}`);
      applyMergeStatus({ mergeReady: false, dirty: false, ahead: 0 });
    } else if (res.status === 409) {
      addSystemMsg('⚠️ 合并冲突，已 abort，基分支未改动。冲突文件：' + (data.conflicts || []).join(', '));
      addSystemMsg('请打开一个该目录的终端会话手动解决冲突。');
    } else {
      addSystemMsg('合并失败：' + (data.error || `HTTP ${res.status}`));
    }
  } catch (e) {
    addSystemMsg('合并请求失败：' + e.message);
  }
}

mergeBtn?.addEventListener('click', requestMerge);
mergeHintBtn?.addEventListener('click', requestMerge);

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

/* ── Per-session model switch (claude only) ── */
const modelBtn = document.getElementById('model-btn');
const CLAUDE_MODEL_OPTIONS = [
  { value: '', label: '默认（跟随 Claude 设置）' },
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'claude-fable-5[1m]', label: 'Fable 5 (1M context)' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: '__custom__', label: '自定义…' },
];
let _sessionModel = '';

function modelShortName(model) {
  const opt = CLAUDE_MODEL_OPTIONS.find(o => o.value === model);
  return opt ? opt.label : model;
}

function updateModelBtn() {
  if (!modelBtn) return;
  modelBtn.textContent = `🧠 ${_sessionModel ? modelShortName(_sessionModel) : '默认'}`;
  modelBtn.style.display = '';
}

// WebView-safe picker (native select/confirm are unreliable in Android WebViews).
function showModelPicker(current) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:380px;max-width:94vw;';
    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:14px;color:#c9d1d9;line-height:1.6;margin-bottom:12px;';
    msg.textContent = '切换该会话使用的模型（下一轮对话生效）';
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
    const syncCustom = () => { custom.style.display = select.value === '__custom__' ? '' : 'none'; };
    syncCustom();
    select.onchange = () => { syncCustom(); if (select.value === '__custom__') custom.focus(); };

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

    const close = (result) => { overlay.remove(); resolve(result); };
    ok.onclick = () => close(select.value === '__custom__' ? custom.value.trim() : select.value);
    cancel.onclick = () => close(null);
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
    if ((info.cli || 'claude') !== 'claude') return; // codex has no model switch
    _sessionModel = info.model || '';
    updateModelBtn();
  } catch (_) {}
}

modelBtn?.addEventListener('click', async () => {
  const picked = await showModelPicker(_sessionModel);
  if (picked === null) return;
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: picked }),
    });
    const data = await res.json();
    if (!res.ok) { addSystemMsg('模型切换失败：' + (data.error || `HTTP ${res.status}`)); return; }
    _sessionModel = data.model || '';
    updateModelBtn();
    addSystemMsg(`✓ 模型已切换为 ${_sessionModel ? modelShortName(_sessionModel) : '默认（跟随 Claude 设置）'}，下一轮对话生效`);
  } catch (e) {
    addSystemMsg('模型切换失败：' + e.message);
  }
});

/* ── Per-session role prompt (all CLIs) ── */
const roleBtn = document.getElementById('role-btn');
let _sessionRole = '';

function updateRoleBtn() {
  if (!roleBtn) return;
  const set = !!(_sessionRole && _sessionRole.trim());
  roleBtn.textContent = set ? '🎭 角色✓' : '🎭 角色';
  roleBtn.title = set
    ? '该会话已设角色提示词，点击修改（下一轮对话生效）'
    : '设置该会话的角色提示词（下一轮对话生效）';
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

    const ta = document.createElement('textarea');
    ta.value = current || '';
    ta.placeholder = '例如：你是开发保姆，被触发时用 multicc-trigger skill 检查 git 改动并提醒提交和测试，不要擅自改代码。';
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
      : '✓ 已清除会话角色（继承目录默认），下一轮对话生效');
  } catch (e) {
    addSystemMsg('角色保存失败：' + e.message);
  }
});

updateRoleBtn();
loadSessionModel();

/* ── Clear context button ── */
document.getElementById('clear-ctx-btn').addEventListener('click', () => {
  if (isStreaming) cancelStreaming();
  messagesEl.innerHTML = '';
  addSystemMsg('Chat cleared');
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'clear_history' }));
  }
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
let _notifyEnabled = localStorage.getItem('multicc_notify') !== 'off';
let _notifyLastCompleted = 0;
let _notifyLastAction = 0;
let _notifyToastTimer = null;

const NOTIFY_COOLDOWN = 8000;

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
  const closeBtn = notifyToast.querySelector('.toast-close');
  notifyToast.textContent = '';
  notifyToast.appendChild(document.createTextNode(text + ' '));
  notifyToast.appendChild(closeBtn);
  notifyToast.className = type;
  notifyToast.style.display = 'block';
  if (_notifyToastTimer) clearTimeout(_notifyToastTimer);
  _notifyToastTimer = setTimeout(dismissNotifyToast, 15000);
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

function speakNotify(text, type) {
  if (!_notifyEnabled) return;
  if (document.visibilityState === 'visible') return;

  const now = Date.now();
  if (type === 'completed') {
    if (now - _notifyLastCompleted < NOTIFY_COOLDOWN) return;
    _notifyLastCompleted = now;
  } else {
    if (now - _notifyLastAction < NOTIFY_COOLDOWN) return;
    _notifyLastAction = now;
  }

  showNotifyToast(text, type);

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
