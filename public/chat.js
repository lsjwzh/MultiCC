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

/* ── State ── */
let ws = null;
let sessionId = null;
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
          // Task finished while we were disconnected
          isStreaming = false;
          hideThinking();
          finishStreaming();
          stopTitleAnimation();
          speakNotify('任务已完成', 'completed');
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
      speakNotify('任务已完成', 'completed');
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
      // Safety net: server confirms process exited — ensure cancel button is hidden
      if (isStreaming) {
        isStreaming = false;
        finishStreaming();
        stopTitleAnimation();
        speakNotify('任务已完成', 'completed');
        updateUI();
      }
      break;

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
    renderCurrentText(true);
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
  let html = currentTextContent.trim() ? marked.parse(currentTextContent) : '';

  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  contentEl.innerHTML = '';
  while (tmp.firstChild) contentEl.appendChild(tmp.firstChild);
  toolEls.forEach(el => contentEl.appendChild(el));

  if (!final && isStreaming) {
    contentEl.classList.add('streaming-dot');
  } else {
    contentEl.classList.remove('streaming-dot');
  }

  if (final) {
    contentEl.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
  }
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
        contentEl.innerHTML = marked.parse(m.content);
        if (typeof hljs !== 'undefined') {
          contentEl.querySelectorAll('pre code').forEach(block => {
            try { hljs.highlightElement(block); } catch (_) {}
          });
        }
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
    ws.send(JSON.stringify({ type: 'user_message', text }));
    _pendingCancel = false;
    isStreaming = true;
    showThinking();
    startTitleAnimation();
    dismissNotifyToast();
    updateUI();
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

/* ── Merge worktree button ── */
document.getElementById('merge-btn').addEventListener('click', async () => {
  if (!_sessionName) { addSystemMsg('无 session id，无法合并 worktree'); return; }
  if (!confirm('把此会话 worktree 的改动合并回基分支？\n未提交的改动会先自动提交。')) return;
  addSystemMsg('正在合并 worktree...');
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(_sessionName)}/merge`), { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      addSystemMsg(data.merged
        ? `✓ 已合并 ${data.commits} 个提交回基分支${data.committed ? '（含本次自动提交）' : ''}`
        : `✓ ${data.message || '没有新提交需要合并'}`);
    } else if (res.status === 409) {
      addSystemMsg('⚠️ 合并冲突，已 abort，基分支未改动。冲突文件：' + (data.conflicts || []).join(', '));
      addSystemMsg('请打开一个该目录的终端会话手动解决冲突。');
    } else {
      addSystemMsg('合并失败：' + (data.error || `HTTP ${res.status}`));
    }
  } catch (e) {
    addSystemMsg('合并请求失败：' + e.message);
  }
});

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

/* ── Reconnect when tab becomes visible again ── */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const dead = !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;
    if (dead) {
      if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
      _reconnectAttempt = 0;
      connect();
    }
  }
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
dbg('state', 'page loaded — 开始连接');
connect();
