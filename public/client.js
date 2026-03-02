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
        filesBrowsePath = null; // reset so panel loads new cwd on next open/refresh
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
  fetch('/api/voice/feedback', {
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
    const res = await fetch('/api/voice/refine', {
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
  vpStatus.textContent = '';
  voicePanel.classList.add('open');
  fetchRefined(rawText);
}

vpUseRaw.addEventListener('click', () => {
  sendVoiceText(vpRaw.value, vpRaw.value, _vpRefinedFinal);
});

vpUseRefined.addEventListener('click', () => {
  sendVoiceText(vpRefined.value, vpRaw.value, _vpRefinedFinal);
});

vpCancel.addEventListener('click', closeVoicePanel);

voicePanel.addEventListener('click', (e) => {
  if (e.target === voicePanel) closeVoicePanel();
});

function startRecording() {
  audioChunks = [];
  // Prefer webm/opus, fallback to whatever the browser supports
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
      // Release microphone
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
    const res = await fetch('/api/voice/stt', { method: 'POST', body: formData });
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

if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices) {
  micBtn.disabled = true;
  micBtn.title = '此浏览器不支持录音（需要 HTTPS 或 localhost）';
} else {
  micBtn.onclick = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
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
    const res  = await fetch(`/api/files?${params}`);
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
    downloadBtn.href = `/api/download?path=${encodeURIComponent(fullPath)}`;
    downloadBtn.download = name;

    actions.appendChild(downloadBtn);

    if (INLINE_EXTS.has(fileExt(name))) {
      const viewBtn = document.createElement('a');
      viewBtn.className = 'fi-action-btn';
      viewBtn.title = '在浏览器中打开';
      viewBtn.textContent = '👁';
      viewBtn.href = `/api/download?path=${encodeURIComponent(fullPath)}&inline=1`;
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
