'use strict';

// Disable browser scroll restoration — we always want to scroll to latest message
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

/* ── Config ── */
const _params = new URLSearchParams(location.search);
const _token = _params.get('token') || '';
let _cwd = _params.get('cwd') || '';
const _sessionName = _params.get('session') || '';  // dashboard session name
const _hasNativeBridge = typeof window.WebCCBridge !== 'undefined' && !!window.WebCCBridge;

function withToken(url) {
  if (!_token) return url;
  return url + (url.includes('?') ? '&' : '?') + `token=${encodeURIComponent(_token)}`;
}

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

// Context window tracking
let _contextWindow = 1000000;
let _usedTokens = 0;

let currentMsgEl = null;
let currentTextContent = '';
let currentToolCards = new Map();
let activeContentType = null;
let activeContentIndex = -1;

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

  ws.onopen = () => {
    statusEl.textContent = 'Connected';
    statusEl.className = 'connected';
    _reconnectAttempt = 0;
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

  ws.onclose = () => {
    // Don't reset isStreaming here — server may still be running.
    // UI stays in streaming state so user sees "reconnecting" rather than a broken state.
    updateUI();
    // Auto-reconnect with exponential backoff (1s, 2s, 4s, 8s, max 15s)
    const delay = Math.min(1000 * Math.pow(2, _reconnectAttempt), 15000);
    _reconnectAttempt++;
    statusEl.textContent = `Reconnecting in ${Math.round(delay/1000)}s...`;
    statusEl.className = 'error';
    statusEl.onclick = () => { _reconnectAttempt = 0; connect(); };
    _reconnectTimer = setTimeout(connect, delay);
  };

  ws.onerror = () => {};
}

/* ── Event handler ── */
function handleEvent(msg) {
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        // Only the SERVER's init carries `is_streaming`. Claude CLI's own
        // stream-json init has the same shape but no `is_streaming`, and
        // must NOT be treated as a (re)connect init — otherwise it would
        // fire the "completed while disconnected" warning every single turn.
        if (!('is_streaming' in msg)) break;

        sessionId = msg.session_id || msg.session || sessionId;
        if (msg.cwd) updateCwdDisplay(msg.cwd);
        const parts = [];
        if (sessionId) parts.push(`Session: ${sessionId.slice(0, 8)}...`);
        if (msg.model) parts.push(msg.model);
        if (parts.length) addSystemMsg(parts.join(' | '));
        // Sync streaming state with server on (re)connect
        if (msg.is_streaming && !isStreaming) {
          isStreaming = true;
          showThinking();
          updateUI();
        } else if (!msg.is_streaming && isStreaming) {
          // Task finished while we were disconnected
          isStreaming = false;
          hideThinking();
          finishStreaming();
          addSystemMsg('⚠️ Response completed while disconnected. Check history above.');
          updateUI();
        }
      } else if (msg.message) {
        addSystemMsg(msg.message);
      }
      break;

    case 'session_id':
      if (msg.id) sessionId = msg.id;
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
      if (msg.total_cost_usd) {
        costBar.textContent = `$${msg.total_cost_usd.toFixed(4)} | ${msg.duration_ms}ms | ${msg.num_turns} turn(s)`;
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

    case 'error':
      addSystemMsg(`Error: ${msg.error || JSON.stringify(msg)}`);
      isStreaming = false;
      finishStreaming();
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

function finalizeAssistantMsg(message) {
  if (!message?.content) return;
  for (const block of message.content) {
    if (block.type === 'text' && block.text && !currentTextContent) {
      currentTextContent = block.text;
      if (!currentMsgEl) currentMsgEl = createAssistantBubble();
      renderCurrentText();
    }
  }
}

function finishStreaming() {
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

function addSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg system-msg';
  div.textContent = text;
  messagesEl.appendChild(div);
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
      console.warn('[webcc] replayHistory: skipped message', mi, err.message);
    }
  }
  scrollToBottom();
  setTimeout(scrollToBottom, 300);
}

/* ── Thinking bubble ── */
let thinkingEl = null;

function showThinking() {
  if (thinkingEl) return;
  thinkingEl = document.createElement('div');
  thinkingEl.className = 'thinking-bubble';
  thinkingEl.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div> Thinking...';
  messagesEl.appendChild(thinkingEl);
  scrollToBottom();
}

function hideThinking() {
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
}

/* ── Send ── */
function send() {
  let text = inputEl.value.trim();
  if (!text) return;

  // If streaming, finalize current response before sending new message
  // (handles yes/no prompts and mid-stream replies)
  if (isStreaming) {
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
    ws.send(JSON.stringify({ type: 'user_message', text }));
    isStreaming = true;
    showThinking();
    updateUI();
  }
}

/* ── Cancel ── */
function cancelStreaming() {
  if (!isStreaming) return;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'cancel' }));
  }
  hideThinking();
  isStreaming = false;
  finishStreaming();
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
    costBar.innerHTML =
      `<span style="margin-right:12px">${costBar.textContent ? costBar.textContent : ''}</span>` +
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
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
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
  const chip = document.createElement('div');
  chip.className = 'attach-chip';
  chip.innerHTML = `<span class="chip-name">${escHtml(fileName)}</span><span class="chip-remove">&times;</span>`;
  chip.style.opacity = '0.5';
  chip.querySelector('.chip-remove').onclick = () => { chip.remove(); updateAttachArea(); };
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
    chip.querySelector('.chip-name').textContent = `Failed: ${fileName}`;
    chip.style.borderColor = '#f85149';
    chip.style.opacity = '1';
    setTimeout(() => { chip.remove(); updateAttachArea(); }, 3000);
  }
}

function guessPastedFileName(file) {
  const ext = file.type === 'image/jpeg'
    ? 'jpg'
    : (file.type || '').split('/')[1] || 'bin';
  return `pasted-file.${ext}`;
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
    window.WebCCBridge.startRecording();
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
    try { window.WebCCBridge.stopRecording(); } catch (_) {}
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
window.__webccRecStarted = () => {};
window.__webccRecReady = async () => {
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
window.__webccRecError = (msg) => {
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
  vpStatus.textContent = 'processing...';
  try {
    const res = await fetch(withToken('/api/voice/refine'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    if (!res.body) { vpStatus.textContent = 'no stream'; return; }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') { vpStatus.textContent = 'done'; return; }
        try {
          const p = JSON.parse(payload);
          if (p.text) { vpRefined.value += p.text; _vpRefinedFinal = vpRefined.value; }
        } catch (_) {}
      }
    }
    vpStatus.textContent = 'done';
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

/* ── Start ── */
connect();
