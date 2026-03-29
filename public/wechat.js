'use strict';

const _urlToken = new URLSearchParams(location.search).get('token');
function tokenQS(prefix) { return _urlToken ? `${prefix}token=${_urlToken}` : ''; }

let evtSource = null;
let isRunning = false;
let loginPollTimer = null;

/* ── Helpers ── */
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── UI State ── */
function setRunning(running) {
  isRunning = running;
  const hdr = document.getElementById('hdr-status');
  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  if (running) {
    hdr.textContent = 'Running';
    hdr.className = 'hdr-status on';
    btnStart.disabled = true;
    btnStop.disabled = false;
  } else {
    hdr.textContent = 'Stopped';
    hdr.className = 'hdr-status off';
    btnStart.disabled = false;
    btnStop.disabled = true;
  }
}

function setLoginStatus(text, cls) {
  const el = document.getElementById('login-status');
  el.textContent = text;
  el.className = cls || '';
}

function showLoggedIn(loggedIn) {
  const btnQR = document.getElementById('btn-get-qr');
  const btnLogout = document.getElementById('btn-logout');
  const qrImg = document.getElementById('qr-img');
  if (loggedIn) {
    btnQR.style.display = 'none';
    btnLogout.style.display = '';
    qrImg.style.display = 'none';
    setLoginStatus('已登录微信', 'login-ok');
  } else {
    btnQR.style.display = '';
    btnLogout.style.display = 'none';
    setLoginStatus('', '');
  }
}

function showStatus(text, isError) {
  const el = document.getElementById('cfg-status');
  el.textContent = text;
  el.className = 'cfg-status ' + (isError ? 'err' : 'ok');
  setTimeout(() => { el.textContent = ''; }, 4000);
}

/* ── QR Login ── */
async function getQRCode() {
  setLoginStatus('获取二维码中...', 'login-wait');
  try {
    const res = await fetch('/api/wechat/qrcode' + tokenQS('?'));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const qrImg = document.getElementById('qr-img');
    if (data.image) {
      qrImg.src = data.image.startsWith('data:') ? data.image : `data:image/png;base64,${data.image}`;
      qrImg.style.display = 'block';
    }
    setLoginStatus('请用微信扫描二维码', 'login-wait');

    // Start polling login status
    stopLoginPoll();
    loginPollTimer = setInterval(pollLoginStatus, 2000);
  } catch (e) {
    setLoginStatus(`获取失败: ${e.message}`, 'login-err');
  }
}

async function pollLoginStatus() {
  try {
    const res = await fetch('/api/wechat/login-status' + tokenQS('?'));
    const data = await res.json();
    if (data.status === 'confirmed') {
      stopLoginPoll();
      showLoggedIn(true);
      showStatus('登录成功');
    } else if (data.status === 'expired' || data.status === 'error') {
      stopLoginPoll();
      setLoginStatus(data.error || '二维码已过期，请重新获取', 'login-err');
      document.getElementById('qr-img').style.display = 'none';
    }
  } catch (_) { /* network error, keep trying */ }
}

function stopLoginPoll() {
  if (loginPollTimer) { clearInterval(loginPollTimer); loginPollTimer = null; }
}

async function logout() {
  try {
    await fetch('/api/wechat/logout' + tokenQS('?'), { method: 'POST' });
    showLoggedIn(false);
    setRunning(false);
    disconnectSSE();
    showStatus('已退出登录');
  } catch (e) {
    showStatus(`退出失败: ${e.message}`, true);
  }
}

/* ── Config ── */
async function loadConfig() {
  try {
    const res = await fetch('/api/wechat/config' + tokenQS('?'));
    const cfg = await res.json();
    document.getElementById('cfg-idle').value = cfg.outputIdle || 5000;
    document.getElementById('cfg-session').dataset.pending = cfg.defaultSession || '';
    showLoggedIn(!!cfg.loggedIn);
  } catch (_) {}
}

async function loadSessions() {
  try {
    const res = await fetch('/api/sessions' + tokenQS('?'));
    const sessions = await res.json();
    const sel = document.getElementById('cfg-session');
    const pending = sel.dataset.pending || sel.value;
    sel.innerHTML = '<option value="">-- 选择会话 --</option>';
    for (const s of sessions) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.id} — ${s.cwd || '?'}${s.active ? '' : ' (inactive)'}`;
      if (s.id === pending) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.dataset.pending = '';
  } catch (_) {}
}

async function saveConfig() {
  const body = {
    defaultSession: document.getElementById('cfg-session').value,
    outputIdle: Number(document.getElementById('cfg-idle').value) || 5000,
  };
  try {
    const res = await fetch('/api/wechat/config' + tokenQS('?'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showStatus('配置已保存');
  } catch (e) {
    showStatus(`保存失败: ${e.message}`, true);
  }
}

/* ── Bridge Control ── */
async function startBridge() {
  const body = {
    defaultSession: document.getElementById('cfg-session').value,
    outputIdle: Number(document.getElementById('cfg-idle').value) || 5000,
  };
  try {
    const res = await fetch('/api/wechat/start' + tokenQS('?'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    setRunning(true);
    connectSSE();
    showStatus('桥接已启动');
  } catch (e) {
    showStatus(`启动失败: ${e.message}`, true);
  }
}

async function stopBridge() {
  try {
    await fetch('/api/wechat/stop' + tokenQS('?'), { method: 'POST' });
    setRunning(false);
    disconnectSSE();
    showStatus('桥接已停止');
  } catch (e) {
    showStatus(`停止失败: ${e.message}`, true);
  }
}

/* ── SSE Log Stream ── */
function connectSSE() {
  disconnectSSE();
  evtSource = new EventSource('/api/wechat/events' + tokenQS('?'));
  evtSource.onmessage = (e) => {
    try { appendLog(JSON.parse(e.data)); } catch (_) {}
  };
  evtSource.onerror = () => {
    disconnectSSE();
    if (isRunning) setTimeout(connectSSE, 3000);
  };
}

function disconnectSSE() {
  if (evtSource) { evtSource.close(); evtSource = null; }
}

const PREFIXES = { in: 'WeChat >', out: 'Claude <', system: 'SYS', error: 'ERR' };

function appendLog(entry) {
  const chatLog = document.getElementById('chat-log');
  const empty = chatLog.querySelector('.log-empty');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.className = `log-entry type-${entry.type}`;
  const d = new Date(entry.ts);
  const time = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
  const prefix = PREFIXES[entry.type] || '';
  div.innerHTML = `<span class="log-time">${time}</span><span class="log-prefix">${prefix}</span> ${escapeHtml(entry.text || '')}`;
  chatLog.appendChild(div);

  while (chatLog.children.length > 500) chatLog.removeChild(chatLog.firstChild);
  chatLog.scrollTop = chatLog.scrollHeight;
}

/* ── Manual Send ── */
async function sendMsg() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  const target = document.getElementById('send-target').value;
  try {
    const res = await fetch('/api/wechat/send' + tokenQS('?'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, target }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showStatus(data.error || `发送失败: HTTP ${res.status}`, true);
    }
  } catch (e) {
    showStatus(`发送失败: ${e.message}`, true);
  }
}

document.getElementById('msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendMsg(); }
});

/* ── Mobile Toggle ── */
function toggleConfig() {
  document.getElementById('config-panel').classList.toggle('open');
}

/* ── Check Status on Load ── */
async function checkStatus() {
  try {
    const res = await fetch('/api/wechat/status' + tokenQS('?'));
    const data = await res.json();
    showLoggedIn(data.loggedIn);
    if (data.running) {
      setRunning(true);
      connectSSE();
      const logRes = await fetch('/api/wechat/log' + tokenQS('?'));
      const entries = await logRes.json();
      for (const e of entries) appendLog(e);
    }
  } catch (_) {}
}

/* ── Init ── */
loadConfig().then(() => loadSessions());
checkStatus();
