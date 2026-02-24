'use strict';

/* ── Terminal setup ── */
const term = new Terminal({
  cursorBlink: true,
  allowProposedApi: true,
  scrollback: 5000,
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

/* ── Session ID ── */
let currentSessionId = new URLSearchParams(location.search).get('id') || '';

function updateSessionLabel(id) {
  if (!sessionLabel) return;
  sessionLabel.textContent = `#${id}`;
  sessionLabel.title = `Session ID: ${id} — click to copy URL`;
}

if (currentSessionId) updateSessionLabel(currentSessionId);

if (sessionLabel) {
  sessionLabel.addEventListener('click', () => {
    navigator.clipboard.writeText(location.href).then(() => {
      const prev = sessionLabel.textContent;
      sessionLabel.textContent = 'Copied!';
      setTimeout(() => { sessionLabel.textContent = prev; }, 1500);
    });
  });
}

/* ── WebSocket / PTY bridge ── */
let ws = null;

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();

  setStatus('connecting', 'Connecting…');

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = currentSessionId
    ? `${proto}//${location.host}/?id=${currentSessionId}`
    : `${proto}//${location.host}/`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setStatus('connected', 'Connected');
    sendResize();
  };

  ws.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'session_id') {
        currentSessionId = msg.id;
        updateSessionLabel(msg.id);
        const newUrl = `${location.pathname}?id=${msg.id}`;
        if (location.search !== `?id=${msg.id}`) {
          history.replaceState(null, '', newUrl);
        }
      } else if (msg.type === 'output' || msg.type === 'error') {
        term.write(msg.data);
      } else if (msg.type === 'exit') {
        term.write(msg.data);
        setStatus('disconnected', 'Session ended');
      } else if (msg.type === 'relocate') {
        term.clear();
        term.write(`\x1b[33m[正在切换到: ${msg.cwd}]\x1b[0m\r\n`);
        ws.close();
        setTimeout(connect, 800);
      } else if (msg.type === 'file_saved') {
        onFileSaved(msg);
      }
    } catch (e) {
      console.error('Parse error:', e);
    }
  };

  ws.onclose = () => setStatus('disconnected', 'Disconnected');
  ws.onerror = ()  => setStatus('disconnected', 'Connection failed');
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
});

/* ── Resize handling ── */
const resizeObs = new ResizeObserver(() => {
  fitAddon.fit();
  sendResize();
});
resizeObs.observe(document.getElementById('terminal-wrap'));

term.onResize(() => sendResize());

/* ── Start ── */
connect();

/* ── Voice Input ── */
const micBtn    = document.getElementById('mic-btn');
const micStatus = document.getElementById('mic-status');
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition  = null;
let isListening  = false;

if (!SpeechRec) {
  micBtn.disabled = true;
  micBtn.title = '此浏览器不支持语音识别（建议使用 Chrome）';
} else {
  recognition = new SpeechRec();
  recognition.continuous    = false;
  recognition.interimResults = false;
  recognition.lang           = navigator.language || 'zh-CN';

  recognition.onresult = (e) => {
    const text = e.results[0][0].transcript;
    micStatus.textContent = `"${text}"`;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: text }));
    }
    setTimeout(() => { micStatus.textContent = ''; }, 3000);
  };

  recognition.onend = () => {
    isListening = false;
    micBtn.classList.remove('active');
    if (micStatus.textContent === '正在聆听…') micStatus.textContent = '';
  };

  recognition.onerror = (e) => {
    isListening = false;
    micBtn.classList.remove('active');
    micStatus.textContent = `错误: ${e.error}`;
    setTimeout(() => { micStatus.textContent = ''; }, 3000);
  };

  micBtn.onclick = () => {
    if (isListening) {
      recognition.stop();
    } else {
      recognition.start();
      isListening = true;
      micBtn.classList.add('active');
      micStatus.textContent = '正在聆听…';
    }
  };
}

/* ── Image Attachment ── */
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

  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    const base64  = dataUrl.split(',')[1];
    const tempId  = `up_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const chip = createChip(file.name, dataUrl, null);
    chip.classList.add('pending');
    pendingChips.set(tempId, chip);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'upload', tempId, name: file.name, mime: file.type, data: base64 }));
    }
  };
  reader.readAsDataURL(file);
};

function onFileSaved({ tempId, path: filePath, name }) {
  const chip = pendingChips.get(tempId);
  if (chip) {
    chip.dataset.path = filePath;
    chip.classList.remove('pending');
    chip.title = `点击插入路径：${filePath}`;
    pendingChips.delete(tempId);
  }
}

function createChip(name, dataUrl, filePath) {
  const chip = document.createElement('div');
  chip.className = 'attach-chip';
  if (filePath) { chip.dataset.path = filePath; chip.title = `点击插入路径：${filePath}`; }

  const img  = document.createElement('img');
  img.src    = dataUrl;

  const span = document.createElement('span');
  span.className   = 'chip-name';
  span.textContent = name;

  const rm = document.createElement('span');
  rm.className   = 'chip-remove';
  rm.textContent = '×';
  rm.title       = '移除';
  rm.onclick = (e) => { e.stopPropagation(); chip.remove(); };

  chip.append(img, span, rm);

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

/* ── Mobile: visualViewport resize (keyboard show/hide) ── */
if (window.visualViewport) {
  let rafPending = false;
  window.visualViewport.addEventListener('resize', () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      // Shrink body to visual viewport so keyboard doesn't overlap
      document.body.style.height = window.visualViewport.height + 'px';
      fitAddon.fit();
      sendResize();
    });
  });
}

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

// Send button
mobileSend.addEventListener('click', () => {
  const text = mobileInput.value;
  mobileInput.value = '';
  sendToTerminal(text + '\r');
});

// Enter key on mobile input → send
mobileInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const text = mobileInput.value;
    mobileInput.value = '';
    sendToTerminal(text + '\r');
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
    const res = await fetch(`/api/sessions/${currentSessionId}`);
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
    const res = await fetch(`/api/sessions/${currentSessionId}/relocate`, {
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

/* ── Drag-and-drop images onto the toolbar ── */
document.getElementById('input-toolbar').addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

document.getElementById('input-toolbar').addEventListener('drop', (e) => {
  e.preventDefault();
  const file = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    const dataUrl = ev.target.result;
    const base64  = dataUrl.split(',')[1];
    const tempId  = `up_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const chip = createChip(file.name, dataUrl, null);
    chip.classList.add('pending');
    pendingChips.set(tempId, chip);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'upload', tempId, name: file.name, mime: file.type, data: base64 }));
    }
  };
  reader.readAsDataURL(file);
});
