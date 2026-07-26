'use strict';

// Experimental, standalone TUI -> Chat projection.
//
// The Codex TUI remains the only execution owner. This sidecar reads Codex's
// native rollout JSONL and projects semantic events into a small chat UI. The
// tmux pane is sampled only as a diagnostic fallback and is never treated as
// canonical history.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { WebSocketServer } = require('ws');

const args = parseArgs(process.argv.slice(2));
const port = positiveInt(args.port, 3317);
const host = String(args.host || '127.0.0.1');
const workspace = path.resolve(String(args.cwd || path.join(os.tmpdir(), 'multicc-tui-chat-poc-workspace')));
const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const rolloutRoot = path.join(codexHome, 'sessions');
const tuiSession = safeTmuxName(String(args.tmux || 'multicc-exp-tui-chat'));
const startedAt = Date.now();
const clients = new Set();
const eventLedger = [];
const seenEventIds = new Set();

let rolloutFile = null;
let rolloutOffset = 0;
let rolloutRemainder = '';
let currentTurnId = null;
let currentStatus = 'starting';
let rawPane = '';
let closed = false;

fs.mkdirSync(workspace, { recursive: true });
ensureTui();

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self' ws: wss:",
      'x-content-type-options': 'nosniff',
    });
    res.end(renderPage());
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(snapshot()));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  clients.add(ws);
  send(ws, { type: 'snapshot', ...snapshot(), events: eventLedger });
  ws.on('message', raw => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.type === 'send') {
      const text = String(message.text || '').trim();
      if (!text) return;
      injectPrompt(text, error => {
        if (error) send(ws, { type: 'notice', level: 'error', message: `发送失败：${publicError(error)}` });
        else send(ws, { type: 'notice', level: 'info', message: '消息已交给 TUI；Chat 等待原生事件确认。' });
      });
    } else if (message.type === 'interrupt') {
      runTmux(['send-keys', '-t', tuiSession, 'C-c'], error => {
        send(ws, {
          type: 'notice',
          level: error ? 'error' : 'info',
          message: error ? `中断失败：${publicError(error)}` : '已向 TUI 发送 Ctrl-C。',
        });
      });
    }
  });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

server.listen(port, host, () => {
  console.log(`[tui-chat-poc] open http://${host}:${port}`);
  console.log(`[tui-chat-poc] workspace=${workspace}`);
  console.log(`[tui-chat-poc] tmux=${tuiSession}`);
});

const rolloutTimer = setInterval(pollRollout, 250);
const paneTimer = setInterval(samplePane, 1000);
rolloutTimer.unref();
paneTimer.unref();
pollRollout();
samplePane();

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    parsed[key] = value;
  }
  return parsed;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function safeTmuxName(value) {
  const safe = value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80);
  if (!safe) throw new Error('Invalid tmux session name');
  return safe;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function ensureTui() {
  if (tmuxExists()) return;
  const command = [
    shellQuote(resolveCommand('codex')),
    '--no-alt-screen',
    '--ask-for-approval', 'never',
    '--sandbox', 'workspace-write',
    '--cd', shellQuote(workspace),
  ].join(' ');
  execFileSync('tmux', [
    'new-session', '-d',
    '-s', tuiSession,
    '-x', '120',
    '-y', '40',
    '-c', workspace,
    command,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
}

function resolveCommand(command) {
  return execFileSync('sh', ['-lc', `command -v ${command}`], { encoding: 'utf8' }).trim();
}

function tmuxExists() {
  try {
    execFileSync('tmux', ['has-session', '-t', tuiSession], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runTmux(argv, callback) {
  execFile('tmux', argv, { encoding: 'utf8', timeout: 5000 }, callback);
}

function injectPrompt(text, callback) {
  runTmux(['set-buffer', '--', text], error => {
    if (error) return callback(error);
    runTmux(['paste-buffer', '-d', '-t', tuiSession], error2 => {
      if (error2) return callback(error2);
      // Codex enables bracketed paste. If Enter lands in the same event-loop
      // slice as paste-buffer, Ratatui can leave the text in the editor without
      // submitting it. A small boundary makes injection match human typing.
      setTimeout(() => runTmux(['send-keys', '-t', tuiSession, 'Enter'], callback), 150);
    });
  });
}

function pollRollout() {
  if (closed) return;
  if (!rolloutFile) {
    rolloutFile = findRollout();
    if (!rolloutFile) return;
    broadcast({ type: 'session', session: snapshot().session });
  }
  fs.stat(rolloutFile, (statError, stat) => {
    if (statError || stat.size <= rolloutOffset) return;
    const length = stat.size - rolloutOffset;
    const buffer = Buffer.alloc(length);
    fs.open(rolloutFile, 'r', (openError, fd) => {
      if (openError) return;
      fs.read(fd, buffer, 0, length, rolloutOffset, (readError, bytesRead) => {
        fs.close(fd, () => {});
        if (readError || !bytesRead) return;
        rolloutOffset += bytesRead;
        consumeJsonl(buffer.subarray(0, bytesRead).toString('utf8'));
      });
    });
  });
}

function findRollout() {
  if (!fs.existsSync(rolloutRoot)) return null;
  const candidates = [];
  walkFiles(rolloutRoot, file => {
    if (!file.endsWith('.jsonl')) return;
    try {
      const stat = fs.statSync(file);
      candidates.push({
        file,
        mtimeMs: stat.mtimeMs,
        fresh: stat.mtimeMs >= startedAt - 10000,
      });
    } catch {}
  });
  // Prefer files created/updated for this launch, but allow the newest exact-cwd
  // match after a sidecar restart. The experiment uses a dedicated workspace,
  // so an exact realpath match is a stable native-session identity.
  candidates.sort((a, b) => Number(b.fresh) - Number(a.fresh) || b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates) {
    try {
      const meta = JSON.parse(readFirstLine(candidate.file));
      if (meta.type !== 'session_meta' || !samePath(meta.payload?.cwd, workspace)) continue;
      return candidate.file;
    } catch {}
  }
  return null;
}

function readFirstLine(file) {
  const fd = fs.openSync(file, 'r');
  const chunks = [];
  const chunkSize = 64 * 1024;
  const maxBytes = 4 * 1024 * 1024;
  let position = 0;
  try {
    while (position < maxBytes) {
      const buffer = Buffer.alloc(Math.min(chunkSize, maxBytes - position));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      chunks.push(newline >= 0 ? chunk.subarray(0, newline) : chunk);
      position += newline >= 0 ? newline : bytesRead;
      if (newline >= 0) return Buffer.concat(chunks).toString('utf8');
    }
  } finally {
    fs.closeSync(fd);
  }
  throw new Error('rollout session_meta line is missing or too large');
}

function walkFiles(directory, visitor) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(fullPath, visitor);
    else if (entry.isFile()) visitor(fullPath);
  }
}

function samePath(left, right) {
  try { return fs.realpathSync(left) === fs.realpathSync(right); } catch { return path.resolve(left || '') === path.resolve(right || ''); }
}

function consumeJsonl(chunk) {
  const lines = (rolloutRemainder + chunk).split('\n');
  rolloutRemainder = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    for (const event of projectRecord(record)) appendEvent(event);
  }
}

function projectRecord(record) {
  const payload = record && record.payload;
  if (!payload || typeof payload !== 'object') {
    if (record?.type === 'session_meta') return [{ kind: 'session_meta', at: record.timestamp, sessionId: record.payload?.id || null }];
    return [];
  }
  const subtype = payload.type;
  const at = record.timestamp || new Date().toISOString();
  if (record.type === 'session_meta') {
    return [{ kind: 'session_meta', at, sessionId: payload.id || payload.session_id || null }];
  }
  if (record.type === 'event_msg') {
    if (subtype === 'task_started') {
      currentTurnId = payload.turn_id || currentTurnId;
      currentStatus = 'running';
      return [{ kind: 'turn_start', at, turnId: currentTurnId }];
    }
    if (subtype === 'user_message') {
      return [{ kind: 'user', at, turnId: currentTurnId, text: String(payload.message || '') }];
    }
    if (subtype === 'agent_message') {
      return [{
        kind: 'assistant',
        at,
        turnId: currentTurnId,
        phase: payload.phase || null,
        text: String(payload.message || ''),
      }];
    }
    if (subtype === 'task_complete') {
      currentStatus = 'idle';
      const turnId = payload.turn_id || currentTurnId;
      currentTurnId = null;
      return [{ kind: 'turn_complete', at, turnId, durationMs: payload.duration_ms || null }];
    }
    if (subtype === 'turn_aborted' || subtype === 'stream_error' || subtype === 'error') {
      currentStatus = 'error';
      return [{ kind: 'error', at, turnId: currentTurnId, text: String(payload.message || subtype) }];
    }
    return [];
  }
  if (record.type === 'response_item') {
    if (subtype === 'custom_tool_call' || subtype === 'function_call' || subtype === 'local_shell_call') {
      return [{
        kind: 'tool_start',
        at,
        turnId: currentTurnId,
        callId: payload.call_id || payload.id || null,
        name: payload.name || subtype,
        input: safeToolInput(payload.input ?? payload.arguments),
      }];
    }
    if (subtype === 'custom_tool_call_output' || subtype === 'function_call_output' || subtype === 'local_shell_call_output') {
      return [{
        kind: 'tool_result',
        at,
        turnId: currentTurnId,
        callId: payload.call_id || payload.id || null,
        text: safeToolOutput(payload.output),
      }];
    }
  }
  return [];
}

function safeToolInput(value) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return truncate(redact(text), 8000);
}

function safeToolOutput(value) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return truncate(redact(text), 12000);
}

function redact(text) {
  return String(text)
    .replace(/(authorization|api[-_]?key|token|cookie|secret)(\\s*[:=]\\s*)([^\\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/Bearer\\s+[A-Za-z0-9._~+\\/-]+/gi, 'Bearer [REDACTED]');
}

function truncate(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n…[truncated]` : text;
}

function appendEvent(event) {
  const id = [
    event.at || '',
    event.kind || '',
    event.turnId || '',
    event.callId || '',
    event.phase || '',
    event.text || '',
  ].join('|');
  if (seenEventIds.has(id)) return;
  seenEventIds.add(id);
  const landed = { ...event, id };
  eventLedger.push(landed);
  if (eventLedger.length > 1000) {
    const removed = eventLedger.shift();
    seenEventIds.delete(removed.id);
  }
  broadcast({ type: 'event', event: landed, status: currentStatus });
}

function samplePane() {
  if (closed || !tmuxExists()) return;
  runTmux(['capture-pane', '-t', tuiSession, '-p', '-S', '-80'], (error, stdout) => {
    if (error) return;
    const next = stripAnsi(String(stdout || '')).slice(-16000);
    if (next === rawPane) return;
    rawPane = next;
    broadcast({ type: 'pane', pane: rawPane });
  });
}

function stripAnsi(value) {
  return value
    .replace(/\\x1B\\][^\\x07]*(?:\\x07|\\x1B\\\\)/g, '')
    .replace(/[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*)?\\u0007)|(?:(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))/g, '');
}

function snapshot() {
  let nativeSessionId = null;
  for (const event of eventLedger) {
    if (event.kind === 'session_meta' && event.sessionId) nativeSessionId = event.sessionId;
  }
  return {
    ok: true,
    status: currentStatus,
    session: {
      tmux: tuiSession,
      workspace,
      rolloutFile: rolloutFile ? path.basename(rolloutFile) : null,
      nativeSessionId,
    },
    eventCount: eventLedger.length,
    pane: rawPane,
  };
}

function send(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(payload)); } catch {}
}

function broadcast(payload) {
  for (const ws of clients) send(ws, payload);
}

function publicError(error) {
  return String(error?.message || error || 'unknown error').split('\n')[0].slice(0, 300);
}

function shutdown() {
  if (closed) return;
  closed = true;
  clearInterval(rolloutTimer);
  clearInterval(paneTimer);
  for (const ws of clients) {
    try { ws.close(); } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function renderPage() {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>TUI → Chat 实验会话</title>
  <style>
    :root { color-scheme: dark; --bg:#111318; --panel:#191c23; --line:#303540; --text:#eef1f6; --muted:#9aa3b2; --accent:#7aa2ff; --tool:#202838; --bad:#ff7b72; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:14px/1.55 system-ui,-apple-system,sans-serif; }
    main { width:min(980px,100%); min-height:100vh; margin:auto; display:grid; grid-template-rows:auto 1fr auto; }
    header { position:sticky; top:0; z-index:2; padding:12px 16px; border-bottom:1px solid var(--line); background:rgba(17,19,24,.94); backdrop-filter:blur(12px); }
    .head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    h1 { margin:0; font-size:16px; }
    .badge { border:1px solid var(--line); border-radius:999px; padding:2px 9px; color:var(--muted); }
    .badge.running { color:#ffd866; border-color:#725f27; } .badge.idle { color:#8bd49c; border-color:#315c3a; } .badge.error { color:var(--bad); border-color:#733732; }
    .meta { margin-top:5px; color:var(--muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #feed { padding:20px 14px 180px; overflow:auto; }
    .event { max-width:82%; margin:10px 0; padding:10px 12px; border:1px solid var(--line); border-radius:14px; background:var(--panel); white-space:pre-wrap; overflow-wrap:anywhere; }
    .event.user { margin-left:auto; background:#20355d; border-color:#34578e; }
    .event.assistant { margin-right:auto; }
    .event.tool_start,.event.tool_result { max-width:92%; background:var(--tool); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .event.error { color:#ffd2cf; border-color:#733732; }
    .label { display:flex; gap:8px; align-items:center; color:var(--muted); font:11px system-ui,sans-serif; margin-bottom:5px; }
    .body { margin:0; }
    .turn { color:var(--muted); text-align:center; margin:14px; font-size:12px; }
    footer { position:fixed; bottom:0; left:0; right:0; background:linear-gradient(transparent,var(--bg) 24%); padding:32px 12px 12px; }
    .composer { width:min(952px,calc(100% - 24px)); margin:auto; border:1px solid var(--line); border-radius:15px; background:var(--panel); padding:9px; box-shadow:0 12px 40px #0008; }
    textarea { width:100%; min-height:58px; max-height:180px; resize:vertical; border:0; outline:0; color:var(--text); background:transparent; font:inherit; }
    .actions { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    button { color:var(--text); background:#2b303a; border:1px solid #414754; border-radius:9px; padding:7px 12px; cursor:pointer; }
    button.primary { background:#345fbd; border-color:#4e78d5; }
    details { margin-top:8px; color:var(--muted); }
    #pane { max-height:260px; overflow:auto; padding:10px; border:1px solid var(--line); background:#0a0c10; white-space:pre-wrap; font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; color:#c4cad4; }
    #notice { min-height:20px; color:var(--muted); font-size:12px; }
  </style>
</head>
<body>
<main>
  <header>
    <div class="head"><h1>TUI → Chat 实验会话</h1><span id="status" class="badge">连接中</span><span class="badge">Codex TUI 为唯一执行者</span></div>
    <div id="meta" class="meta"></div>
    <details><summary>原始 TUI 诊断画面（非历史事实源）</summary><pre id="pane"></pre></details>
  </header>
  <section id="feed"></section>
  <footer>
    <div class="composer">
      <textarea id="input" placeholder="输入内容后发送给真实 Codex TUI。Enter 发送，Shift+Enter 换行。"></textarea>
      <div class="actions"><span id="notice"></span><span><button id="interrupt">中断</button> <button id="send" class="primary">发送到 TUI</button></span></div>
    </div>
  </footer>
</main>
<script>
(() => {
  const feed = document.getElementById('feed');
  const status = document.getElementById('status');
  const meta = document.getElementById('meta');
  const pane = document.getElementById('pane');
  const input = document.getElementById('input');
  const notice = document.getElementById('notice');
  const rendered = new Set();
  let ws;

  function connect() {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(scheme + '//' + location.host);
    ws.onopen = () => setNotice('已连接旁路事件流。');
    ws.onclose = () => { setNotice('连接断开，正在重连…'); setTimeout(connect, 1000); };
    ws.onmessage = message => {
      const data = JSON.parse(message.data);
      if (data.type === 'snapshot') {
        updateStatus(data.status);
        updateSession(data.session);
        pane.textContent = data.pane || '';
        for (const event of data.events || []) renderEvent(event);
      } else if (data.type === 'event') {
        updateStatus(data.status);
        renderEvent(data.event);
      } else if (data.type === 'pane') {
        pane.textContent = data.pane || '';
      } else if (data.type === 'session') {
        updateSession(data.session);
      } else if (data.type === 'notice') {
        setNotice(data.message, data.level === 'error');
      }
    };
  }

  function renderEvent(event) {
    if (!event || rendered.has(event.id)) return;
    rendered.add(event.id);
    if (event.kind === 'session_meta') return;
    const el = document.createElement('article');
    if (event.kind === 'turn_start' || event.kind === 'turn_complete') {
      el.className = 'turn';
      el.textContent = event.kind === 'turn_start' ? '— TUI 开始执行 —' : '— TUI 执行完成 —';
    } else {
      el.className = 'event ' + event.kind;
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = labelFor(event);
      const body = document.createElement('pre');
      body.className = 'body';
      body.textContent = bodyFor(event);
      el.append(label, body);
    }
    feed.appendChild(el);
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  function labelFor(event) {
    const labels = { user:'用户', assistant:'Codex', tool_start:'Tool 调用', tool_result:'Tool 结果', error:'错误' };
    const detail = event.name ? ' · ' + event.name : event.phase ? ' · ' + event.phase : '';
    return (labels[event.kind] || event.kind) + detail;
  }

  function bodyFor(event) {
    if (event.kind === 'tool_start') return event.input || '(无参数)';
    return event.text || '';
  }

  function updateStatus(value) {
    status.textContent = value || 'unknown';
    status.className = 'badge ' + (value || '');
  }

  function updateSession(session) {
    if (!session) return;
    meta.textContent = 'tmux: ' + session.tmux + ' · workspace: ' + session.workspace + (session.nativeSessionId ? ' · native: ' + session.nativeSessionId : '');
  }

  function setNotice(text, error) {
    notice.textContent = text || '';
    notice.style.color = error ? 'var(--bad)' : '';
  }

  function submit() {
    const text = input.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type:'send', text }));
    input.value = '';
    setNotice('已写入 TUI，等待原生事件落盘…');
  }

  document.getElementById('send').onclick = submit;
  document.getElementById('interrupt').onclick = () => ws?.send(JSON.stringify({ type:'interrupt' }));
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });
  connect();
})();
</script>
</body>
</html>`;
}
