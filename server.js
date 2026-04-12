'use strict';

// Load .env file (lightweight, no dependencies)
const _envPath = require('path').join(__dirname, '.env');
try {
  require('fs').readFileSync(_envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
} catch (_) { /* .env not found, skip */ }

const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { StringDecoder } = require('string_decoder');
const { execSync, execFileSync, spawn } = require('child_process');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const wechatBridge = require('./wechat-ilink');
const webpush = require('web-push');

const crypto = require('crypto');
const app = express();

// ── Access token authentication (cookie-based login) ──
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;

// Signed cookie: no server-side storage needed, survives restarts
function signToken(data) {
  return crypto.createHmac('sha256', ACCESS_TOKEN).update(data).digest('hex');
}

function generateAuthCookie() {
  const payload = Date.now().toString(36);
  return payload + '.' + signToken(payload);
}

function verifyAuthCookie(cookie) {
  if (!cookie || !cookie.includes('.')) return false;
  const [payload, sig] = cookie.split('.');
  return sig === signToken(payload);
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=').trim();
  }
  return cookies;
}

function isExternalProxy(req) {
  // Reverse proxy (Tailscale, ngrok, etc.) connects from localhost but serves external users
  const host = (req.headers.host || '').split(':')[0];
  return host.endsWith('.ts.net') || host.endsWith('.ngrok.io') || host.endsWith('.ngrok-free.app');
}

function isAuthenticated(req) {
  if (!ACCESS_TOKEN) return true;
  // Localhost allowed — unless it's a reverse proxy forwarding external traffic
  const ip = req.ip || req.connection.remoteAddress;
  if ((ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') && !isExternalProxy(req)) return true;
  // Cookie auth (HMAC-signed, survives server restart)
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.webcc_auth && verifyAuthCookie(cookies.webcc_auth)) return true;
  // Query param / header (backwards compat for API / WebSocket)
  const token = req.query.token || req.headers['x-access-token'];
  if (token === ACCESS_TOKEN) return true;
  return false;
}

if (ACCESS_TOKEN) {
  // Login page & handler
  app.get('/login', (req, res) => {
    const error = req.query.error ? '<p style="color:#f85149;margin-bottom:16px;">密码错误</p>' : '';
    const redirect = req.query.redirect || '/';
    res.type('html').send(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WebCC — Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',system-ui,sans-serif;
    display:flex;align-items:center;justify-content:center;height:100vh}
  .box{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;
    width:340px;text-align:center}
  .box h1{font-size:20px;margin-bottom:8px;color:#f0f6fc}
  .box .logo{font-size:24px;font-weight:700;color:#f78166;margin-bottom:24px}
  .box .logo span{color:#79c0ff}
  input[type=password]{width:100%;padding:10px 14px;border-radius:6px;border:1px solid #30363d;
    background:#0d1117;color:#c9d1d9;font-size:14px;margin-bottom:16px;outline:none}
  input[type=password]:focus{border-color:#58a6ff}
  button{width:100%;padding:10px;border-radius:6px;border:none;background:#238636;
    color:#fff;font-size:14px;font-weight:600;cursor:pointer}
  button:hover{background:#2ea043}
</style></head><body>
<div class="box">
  <div class="logo">Web<span>CC</span></div>
  ${error}
  <form method="POST" action="/login">
    <input type="hidden" name="redirect" value="${redirect.replace(/"/g, '&quot;')}">
    <input type="password" name="password" placeholder="输入访问密码" autofocus>
    <button type="submit">登录</button>
  </form>
</div></body></html>`);
  });

  app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    const redirect = req.body.redirect || '/';
    if (req.body.password === ACCESS_TOKEN) {
      const authCookie = generateAuthCookie();
      res.setHeader('Set-Cookie',
        `webcc_auth=${authCookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`);
      res.redirect(redirect);
    } else {
      res.redirect(`/login?error=1&redirect=${encodeURIComponent(redirect)}`);
    }
  });

  app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'webcc_auth=; Path=/; HttpOnly; Max-Age=0');
    res.redirect('/login');
  });

  // Auth middleware
  app.use((req, res, next) => {
    // Allow login page, static assets
    if (req.path === '/login' || req.path === '/logout') return next();
    if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|json)$/i.test(req.path)) return next();
    if (isAuthenticated(req)) return next();
    // Redirect HTML requests to login, reject API calls with 403
    if (req.headers.accept?.includes('text/html') || (!req.path.startsWith('/api/') && req.method === 'GET')) {
      res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
    } else {
      res.status(403).json({ error: 'Forbidden: not authenticated' });
    }
  });
}

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

const wss = new WebSocket.Server({ server });
const isWindows = process.platform === 'win32';

// Resolve the full path of the claude executable at startup
function resolveClaude() {
  if (process.env.CLAUDE_CMD) {
    console.log(`[webcc] CLAUDE_CMD override: ${process.env.CLAUDE_CMD}`);
    return process.env.CLAUDE_CMD;
  }

  const extraPaths = [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.local', 'share', 'claude', 'bin'),
    path.join(os.homedir(), '.npm-global', 'bin'),
    path.join(os.homedir(), '.npm', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
  ];
  const sep = isWindows ? ';' : ':';
  const augmentedPath = [...new Set([...extraPaths, ...(process.env.PATH || '').split(sep)])].join(sep);
  process.env.PATH = augmentedPath;

  if (!isWindows) {
    // Try login shell first — it sources ~/.zshrc / ~/.bashrc and sees the real PATH
    const shells = ['/bin/zsh', '/bin/bash'];
    for (const sh of shells) {
      if (!fs.existsSync(sh)) continue;
      try {
        const result = execSync(`${sh} -l -c 'which claude 2>/dev/null'`, {
          encoding: 'utf8',
          timeout: 5000,
        });
        const found = result.trim().split(/\r?\n/)[0].trim();
        if (found && fs.existsSync(found)) {
          console.log(`[webcc] Found claude via ${sh}: ${found}`);
          return found;
        }
      } catch (_) {}
    }
  }

  // Try which/where with augmented PATH
  try {
    const result = execSync(isWindows ? 'where claude' : 'which claude', {
      encoding: 'utf8',
      env: { ...process.env, PATH: augmentedPath },
      timeout: 5000,
    });
    const lines = result.trim().split(/\r?\n/);
    const exe = isWindows ? lines.find(l => l.endsWith('.exe')) || lines[0] : lines[0];
    const found = exe.trim();
    if (found) {
      console.log(`[webcc] Found claude via which: ${found}`);
      return found;
    }
  } catch (_) {}

  // Direct file existence check
  for (const dir of extraPaths) {
    const candidate = path.join(dir, isWindows ? 'claude.exe' : 'claude');
    if (fs.existsSync(candidate)) {
      console.log(`[webcc] Found claude via direct check: ${candidate}`);
      return candidate;
    }
  }

  console.warn('[webcc] WARNING: Could not locate claude binary, falling back to "claude"');
  return isWindows ? 'claude.exe' : 'claude';
}

const CLAUDE_CMD = resolveClaude();
const CLAUDE_ARGS = process.env.CLAUDE_ARGS ? process.env.CLAUDE_ARGS.split(' ') : [];
console.log(`[webcc] Using claude: ${CLAUDE_CMD}`);

// ── tmux helpers ──
const TMUX_PREFIX = 'webcc-';
const TMUX_FIFO_DIR = path.join(os.tmpdir(), 'webcc-fifos');
try { fs.mkdirSync(TMUX_FIFO_DIR, { recursive: true }); } catch (_) {}

function tmuxSessionName(id) { return `${TMUX_PREFIX}${id}`; }

function tmuxHasSession(id) {
  try {
    execSync(`tmux has-session -t ${tmuxSessionName(id)} 2>/dev/null`);
    return true;
  } catch { return false; }
}

function tmuxCreateSession(id, cwd, cols, rows, claudeSessionId) {
  const name = tmuxSessionName(id);
  let cmd = `${CLAUDE_CMD}${CLAUDE_ARGS.length ? ' ' + CLAUDE_ARGS.join(' ') : ''}`;
  // Bind to a stable Claude session UUID so chat mode can --resume the same conversation
  if (claudeSessionId) cmd += ` --session-id ${claudeSessionId}`;
  // set-option remain-on-exit off so the session disappears when claude exits
  execSync(
    `tmux new-session -d -s "${name}" -x ${cols} -y ${rows} -c "${cwd}" "${cmd}"`,
    { env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } }
  );
}

function tmuxResize(id, cols, rows) {
  try {
    execSync(`tmux resize-window -t "${tmuxSessionName(id)}" -x ${cols} -y ${rows} 2>/dev/null`);
  } catch (_) {}
}

function tmuxKillSession(id) {
  try { execSync(`tmux kill-session -t "${tmuxSessionName(id)}" 2>/dev/null`); } catch (_) {}
}

function tmuxCapturePane(id) {
  try {
    return execSync(`tmux capture-pane -t "${tmuxSessionName(id)}" -p -S -500 2>/dev/null`, { encoding: 'utf8' });
  } catch { return ''; }
}

function tmuxPaneTty(id) {
  return execSync(`tmux display-message -t "${tmuxSessionName(id)}" -p "#{pane_tty}"`, { encoding: 'utf8' }).trim();
}

function tmuxPaneCwd(id) {
  try {
    return execSync(`tmux display-message -t "${tmuxSessionName(id)}" -p "#{pane_current_path}"`, { encoding: 'utf8' }).trim();
  } catch { return os.homedir(); }
}

function tmuxWriteInput(id, data) {
  if (!data) return;
  try {
    execFileSync('tmux', ['send-keys', '-t', tmuxSessionName(id), '-l', '--', data]);
  } catch (e) {
    console.error('[webcc] tmuxWriteInput error:', e.message);
  }
}

function fifoPathForSession(id) {
  return path.join(TMUX_FIFO_DIR, `${id}.fifo`);
}

function startOutputCapture(id) {
  const fifoPath = fifoPathForSession(id);
  // Clean up any stale FIFO
  try { fs.unlinkSync(fifoPath); } catch (_) {}
  execSync(`mkfifo "${fifoPath}"`);

  // Tell tmux to pipe pane output into our FIFO (no -o: always replace existing pipe)
  execSync(`tmux pipe-pane -t "${tmuxSessionName(id)}" "cat > '${fifoPath}'"`);

  // Open FIFO with O_RDWR | O_NONBLOCK, wrap in net.Socket:
  // - O_RDWR prevents spurious EOF (always has a potential writer)
  // - O_NONBLOCK is required for net.Socket's event-driven I/O (kqueue/epoll)
  // - net.Socket handles EAGAIN correctly (unlike fs.createReadStream which dies on EAGAIN)
  const fd = fs.openSync(fifoPath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  const stream = new net.Socket({ fd, readable: true, writable: false });
  return { stream, fifoPath };
}

function stopOutputCapture(session) {
  if (session.outputStream) {
    try { session.outputStream.destroy(); } catch (_) {}
    session.outputStream = null;
  }
  if (session.fifoPath) {
    // Stop tmux pipe-pane
    try { execSync(`tmux pipe-pane -t "${tmuxSessionName(session.id)}" 2>/dev/null`); } catch (_) {}
    try { fs.unlinkSync(session.fifoPath); } catch (_) {}
    session.fifoPath = null;
  }
}

// Recover existing tmux sessions on startup (survives server restart)
function recoverTmuxSessions() {
  try {
    const output = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf8' });
    for (const name of output.trim().split('\n')) {
      if (!name || !name.startsWith(TMUX_PREFIX)) continue;
      const id = name.slice(TMUX_PREFIX.length);
      if (sessions.has(id)) continue;
      const cwd = tmuxPaneCwd(id);
      console.log(`[webcc] Recovering tmux session: ${id} (${cwd})`);
      try {
        createSession(id, cwd);
      } catch (err) {
        console.error(`[webcc] Failed to recover session ${id}:`, err.message);
      }
    }
  } catch (_) {
    // tmux server not running — nothing to recover
  }
}

// ── Session persistence ──
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

function loadPersistedSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const map = new Map();
      for (const s of data) map.set(s.id, s);
      console.log(`[webcc] Loaded ${map.size} persisted session(s)`);
      return map;
    }
  } catch (e) {
    console.error('[webcc] Failed to load sessions.json:', e.message);
  }
  return new Map();
}

function savePersistedSessions() {
  const data = [...persistedSessions.values()].map(({ id, cwd, createdAt, claudeSessionId }) => ({ id, cwd, createdAt, claudeSessionId }));
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[webcc] Failed to save sessions.json:', e.message);
  }
}

const persistedSessions = loadPersistedSessions();

// ── Session management ──
// { id, tmuxName, ttyPath, outputStream, fifoPath, buffer: string[], clients: Set<ws>, createdAt, lastActivity, cwd, exitCheckTimer }
const sessions = new Map();

function generateId() {
  let id = '';
  while (id.length < 8) id += Math.random().toString(36).slice(2);
  return id.slice(0, 8);
}

function resolveCwd(current, arg) {
  if (!arg || arg === '~') return os.homedir();
  if (arg.startsWith('~/') || arg.startsWith('~\\')) return path.join(os.homedir(), arg.slice(2));
  return path.resolve(current, arg);
}

function createSession(id, cwd) {
  // Fall back to homedir if the persisted cwd no longer exists
  if (!cwd || !fs.existsSync(cwd)) {
    if (cwd) console.warn(`[webcc] cwd "${cwd}" not found, falling back to home dir`);
    cwd = os.homedir();
  }

  // Get or create a stable Claude session UUID for this webcc session
  const persisted = persistedSessions.get(id);
  const claudeSessionId = persisted?.claudeSessionId || crypto.randomUUID();

  // Create tmux session if it doesn't already exist (it may survive server restarts)
  let isRecovery = false;
  if (!tmuxHasSession(id)) {
    console.log(`[webcc] Creating tmux session: ${tmuxSessionName(id)} in ${cwd} (claude session: ${claudeSessionId})`);
    tmuxCreateSession(id, cwd, 80, 24, claudeSessionId);
  } else {
    console.log(`[webcc] Attaching to existing tmux session: ${tmuxSessionName(id)}`);
    isRecovery = true;
  }

  // Get the tty device path for direct input writes
  const ttyPath = tmuxPaneTty(id);

  // Start output capture via pipe-pane → FIFO
  const { stream, fifoPath } = startOutputCapture(id);

  // Pre-fill buffer with current terminal content for recovered sessions
  const initialBuffer = [];
  if (isRecovery) {
    const captured = tmuxCapturePane(id);
    if (captured) initialBuffer.push(captured);
  }

  const session = {
    id,
    claudeSessionId,
    tmuxName: tmuxSessionName(id),
    ttyPath,
    outputStream: stream,
    fifoPath,
    buffer: initialBuffer,
    clients: new Set(),
    primaryClient: null,   // the client that controls resize (first to resize)
    resizeOwner: null,     // locked resize ownership — only this ws can resize tmux
    createdAt: persisted ? new Date(persisted.createdAt) : new Date(),
    lastActivity: new Date(),
    cwd,
    exitCheckTimer: null,
  };

  // Save to persistence (includes claudeSessionId for chat mode --resume)
  persistedSessions.set(id, { id, cwd, createdAt: session.createdAt, claudeSessionId });
  savePersistedSessions();

  // Output stream → broadcast to all WebSocket clients
  const utf8Decoder = new StringDecoder('utf8');
  stream.on('data', (data) => {
    const str = utf8Decoder.write(data);
    if (!str) return; // partial UTF-8 character buffered, wait for more bytes
    session.buffer.push(str);
    if (session.buffer.length > 500) session.buffer.shift();
    session.lastActivity = new Date();
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'output', data: str }));
      }
    }
    // Forward to WeChat bridge if active for this session
    wechatBridge.onSessionOutput(id, str);
    // Server-side push notification detection
    pushOnOutput(id, str);
  });

  // Detect session exit or stream failure
  const onStreamEnd = (err) => {
    if (sessions.get(id) !== session) return;
    setTimeout(() => {
      if (sessions.get(id) !== session) return;
      if (!tmuxHasSession(id)) {
        console.log(`[webcc] Session ${id} exited (tmux session gone)`);
        cleanupPushMonitor(id);
        const exitMsg = `\r\n\x1b[33m[Claude Code process exited]\x1b[0m\r\n`;
        for (const client of session.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'exit', data: exitMsg }));
          }
        }
        stopOutputCapture(session);
        sessions.delete(id);
      } else {
        // Tmux session still alive but stream died — restart output capture
        console.log(`[webcc] Stream died for ${id}, restarting output capture...`);
        stopOutputCapture(session);
        try {
          const { stream: newStream, fifoPath: newFifo } = startOutputCapture(id);
          session.outputStream = newStream;
          session.fifoPath = newFifo;
          const newDecoder = new StringDecoder('utf8');
          newStream.on('data', (data) => {
            const str = newDecoder.write(data);
            if (!str) return;
            session.buffer.push(str);
            if (session.buffer.length > 500) session.buffer.shift();
            session.lastActivity = new Date();
            for (const client of session.clients) {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'output', data: str }));
              }
            }
            wechatBridge.onSessionOutput(id, str);
            pushOnOutput(id, str);
          });
          newStream.on('end', onStreamEnd);
          newStream.on('error', onStreamEnd);
        } catch (e) {
          console.error(`[webcc] Failed to restart output capture for ${id}:`, e.message);
        }
      }
    }, 500);
  };
  stream.on('end', onStreamEnd);
  stream.on('error', onStreamEnd);

  // Periodic check: tmux session may exit without FIFO closing cleanly
  session.exitCheckTimer = setInterval(() => {
    if (sessions.get(id) !== session) {
      clearInterval(session.exitCheckTimer);
      return;
    }
    if (!tmuxHasSession(id)) {
      clearInterval(session.exitCheckTimer);
      onStreamEnd();
    }
  }, 3000);

  sessions.set(id, session);
  return session;
}

// ── REST API ──
app.use(express.json());

app.get('/api/sessions', (req, res) => {
  const list = [...persistedSessions.values()].map(p => {
    const active = sessions.get(p.id);
    return active
      ? { id: active.id, cwd: active.cwd, createdAt: active.createdAt, lastActivity: active.lastActivity, clients: active.clients.size, active: true }
      : { id: p.id, cwd: p.cwd, createdAt: p.createdAt, lastActivity: null, clients: 0, active: false };
  });
  res.json(list);
});

app.get('/api/sessions/:id', (req, res) => {
  const id = req.params.id;
  const active = sessions.get(id);
  const persisted = persistedSessions.get(id);
  if (!active && !persisted) return res.status(404).json({ error: 'Session not found' });
  if (active) {
    res.json({ id: active.id, cwd: active.cwd, createdAt: active.createdAt, lastActivity: active.lastActivity, clients: active.clients.size, active: true });
  } else {
    res.json({ id: persisted.id, cwd: persisted.cwd, createdAt: persisted.createdAt, lastActivity: null, clients: 0, active: false });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session && !persistedSessions.has(req.params.id)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (session) {
    tmuxKillSession(session.id);
    sessions.delete(req.params.id);
  }
  persistedSessions.delete(req.params.id);
  savePersistedSessions();
  res.json({ ok: true });
});

app.post('/api/sessions/:id/relocate', (req, res) => {
  const id = req.params.id;
  const rawCwd = (req.body.cwd || '').trim();
  if (!rawCwd) return res.status(400).json({ error: 'cwd required' });

  const rawCurrentCwd = (sessions.get(id) || persistedSessions.get(id))?.cwd;
  const currentCwd = (rawCurrentCwd && fs.existsSync(rawCurrentCwd)) ? rawCurrentCwd : os.homedir();
  const resolvedCwd = resolveCwd(currentCwd, rawCwd);

  if (!fs.existsSync(resolvedCwd)) {
    return res.status(400).json({ error: `目录不存在: ${resolvedCwd}` });
  }

  const oldSession = sessions.get(id);

  // Notify clients before killing so they can clear & prepare to reconnect
  if (oldSession) {
    for (const client of oldSession.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'relocate', cwd: resolvedCwd }));
      }
    }
  }

  // Remove from map first so the onExit guard skips the stale exit
  sessions.delete(id);
  if (oldSession) {
    tmuxKillSession(oldSession.id);
  }

  // Persist new cwd
  const p = persistedSessions.get(id);
  if (p) {
    p.cwd = resolvedCwd;
  } else {
    persistedSessions.set(id, { id, cwd: resolvedCwd, createdAt: new Date(), claudeSessionId: crypto.randomUUID() });
  }
  savePersistedSessions();

  // Start fresh claude in the new directory
  try {
    createSession(id, resolvedCwd);
    console.log(`[webcc] Session ${id} relocated → ${resolvedCwd}`);
    res.json({ ok: true, cwd: resolvedCwd });
  } catch (err) {
    console.error('[webcc] Relocate failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Restart session (kill tmux + respawn claude in same cwd) ──
app.post('/api/sessions/:id/restart', (req, res) => {
  const id = req.params.id;
  const oldSession = sessions.get(id);
  const persisted = persistedSessions.get(id);
  if (!oldSession && !persisted) return res.status(404).json({ error: 'Session not found' });

  const cwd = oldSession?.cwd || persisted?.cwd || os.homedir();

  // Collect clients before teardown (they'll reconnect to the new session)
  const oldClients = oldSession ? [...oldSession.clients] : [];

  // Tear down old session
  sessions.delete(id);
  if (oldSession) {
    stopOutputCapture(oldSession);
    if (oldSession.exitCheckTimer) clearInterval(oldSession.exitCheckTimer);
    cleanupPushMonitor(id);
    oldSession.clients.clear();
  }
  tmuxKillSession(id);

  // Clear old claudeSessionId so createSession generates a fresh one (new conversation)
  if (persisted) {
    delete persisted.claudeSessionId;
    persistedSessions.set(id, persisted);
    savePersistedSessions();
  }

  // Start fresh claude in the same directory
  try {
    createSession(id, cwd);
    console.log(`[webcc] Session ${id} restarted in ${cwd}`);

    // NOW notify old clients to reconnect (new session is ready)
    for (const client of oldClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'restart' }));
      }
    }

    res.json({ ok: true, cwd });
  } catch (err) {
    console.error('[webcc] Restart failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── File Browser API ──
app.get('/api/files', (req, res) => {
  let dirPath = (req.query.path || '').trim();
  const sessionId = (req.query.session || '').trim();

  if (!dirPath && sessionId) {
    const active = sessions.get(sessionId);
    const persisted = persistedSessions.get(sessionId);
    dirPath = active?.cwd || persisted?.cwd || os.homedir();
  } else if (!dirPath) {
    dirPath = os.homedir();
  }

  if (dirPath === '~') dirPath = os.homedir();
  else if (dirPath.startsWith('~/') || dirPath.startsWith('~\\')) {
    dirPath = path.join(os.homedir(), dirPath.slice(2));
  }
  dirPath = path.resolve(dirPath);

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files = entries
      .map(e => {
        const fullPath = path.join(dirPath, e.name);
        const isDir = e.isDirectory();
        let size = null;
        if (!isDir) {
          try { size = fs.statSync(fullPath).size; } catch (_) {}
        }
        return { name: e.name, isDir, path: fullPath, size };
      })
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    const parent = dirPath !== path.parse(dirPath).root ? path.dirname(dirPath) : null;
    res.json({ path: dirPath, parent, files });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/download', (req, res) => {
  const filePath = (req.query.path || '').trim();
  const inline = req.query.inline === '1';
  if (!filePath) return res.status(400).json({ error: 'path required' });
  const resolved = path.resolve(filePath);
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return res.status(400).json({ error: '不能下载目录' });
    if (inline) {
      res.sendFile(resolved);
    } else {
      res.download(resolved);
    }
  } catch (e) {
    res.status(404).json({ error: '文件不存在' });
  }
});

// ── Voice Refine Worker (global, starts with server) ──
const VOICE_EXAMPLES_FILE = path.join(__dirname, 'voice_examples.json');
const WHISPER_VOCAB_FILE = path.join(__dirname, 'whisper_vocab.json');

function loadVoiceExamples() {
  try {
    if (fs.existsSync(VOICE_EXAMPLES_FILE)) {
      const data = JSON.parse(fs.readFileSync(VOICE_EXAMPLES_FILE, 'utf8'));
      return Array.isArray(data) ? data.slice(-5) : [];
    }
  } catch (_) {}
  return [];
}

function appendVoiceExample(entry) {
  let data = [];
  try {
    if (fs.existsSync(VOICE_EXAMPLES_FILE)) {
      data = JSON.parse(fs.readFileSync(VOICE_EXAMPLES_FILE, 'utf8'));
      if (!Array.isArray(data)) data = [];
    }
  } catch (_) {}
  data.push(entry);
  if (data.length > 50) data = data.slice(-50);
  try {
    fs.writeFileSync(VOICE_EXAMPLES_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[webcc] Failed to write voice_examples.json:', e.message);
  }
}

// ── Whisper vocabulary (user-corrected terms) ──
function loadWhisperVocab() {
  try {
    if (fs.existsSync(WHISPER_VOCAB_FILE)) {
      const data = JSON.parse(fs.readFileSync(WHISPER_VOCAB_FILE, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (_) {}
  return [];
}

function saveWhisperVocab(vocab) {
  try {
    fs.writeFileSync(WHISPER_VOCAB_FILE, JSON.stringify(vocab, null, 2));
  } catch (e) {
    console.error('[webcc] Failed to write whisper_vocab.json:', e.message);
  }
}

/**
 * Extract correction terms by diffing raw STT output against user's final edit.
 * Segments text into tokens, finds words the user replaced/added.
 * Returns an array of { wrong, correct } pairs.
 */
function extractCorrections(raw, userFinal) {
  if (!raw || !userFinal || raw === userFinal) return [];

  // Tokenize: split into Chinese chars / English words / mixed tokens
  const tokenize = s => s.match(/[a-zA-Z][a-zA-Z0-9_./-]*/g) || [];

  const rawTokens = new Set(tokenize(raw).map(t => t.toLowerCase()));
  const finalTokens = tokenize(userFinal);

  const corrections = [];
  for (const token of finalTokens) {
    // Token appears in userFinal but NOT in raw → user corrected something to this
    if (token.length > 1 && !rawTokens.has(token.toLowerCase())) {
      corrections.push(token);
    }
  }
  return corrections;
}

/**
 * Merge new correction terms into whisper_vocab.json (deduplicated).
 * Each entry: { term, count, lastSeen }
 */
function mergeWhisperVocab(newTerms) {
  if (!newTerms || newTerms.length === 0) return;
  const vocab = loadWhisperVocab();
  const termMap = new Map(vocab.map(v => [v.term.toLowerCase(), v]));

  for (const term of newTerms) {
    const key = term.toLowerCase();
    if (termMap.has(key)) {
      const existing = termMap.get(key);
      existing.count = (existing.count || 1) + 1;
      existing.lastSeen = new Date().toISOString();
      // Keep the casing from the latest correction
      existing.term = term;
    } else {
      termMap.set(key, { term, count: 1, lastSeen: new Date().toISOString() });
    }
  }

  // Sort by count desc, keep top 100
  const sorted = [...termMap.values()].sort((a, b) => b.count - a.count).slice(0, 100);
  saveWhisperVocab(sorted);
  console.log(`[webcc/stt] Whisper vocab updated: ${sorted.length} terms, added: ${newTerms.join(', ')}`);
}

// ── Backfill: seed whisper_vocab.json from existing voice_examples on first run ──
(function backfillWhisperVocab() {
  try {
    if (fs.existsSync(WHISPER_VOCAB_FILE)) return; // already initialized
    if (!fs.existsSync(VOICE_EXAMPLES_FILE)) return;
    const examples = JSON.parse(fs.readFileSync(VOICE_EXAMPLES_FILE, 'utf8'));
    if (!Array.isArray(examples)) return;
    const allTerms = [];
    for (const ex of examples) {
      const corrections = extractCorrections(ex.raw, ex.userFinal);
      allTerms.push(...corrections);
    }
    if (allTerms.length > 0) {
      mergeWhisperVocab(allTerms);
      console.log(`[webcc/stt] Backfilled whisper_vocab.json from ${examples.length} voice examples`);
    }
  } catch (e) {
    console.error('[webcc/stt] Backfill error:', e.message);
  }
})();

// ── OpenRouter API configuration for voice refinement ──
let OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
let OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001';
let OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

// ── Whisper STT configuration ──
let WHISPER_API_KEY = process.env.WHISPER_API_KEY || '';
let WHISPER_BASE_URL = process.env.WHISPER_BASE_URL || 'https://openrouter.ai/api/v1';
let WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-large-v3-turbo';
let WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || 'zh';
let WHISPER_PROMPT = process.env.WHISPER_PROMPT || '';

/**
 * Build a prompt for Whisper STT to improve recognition of technical terms.
 * Sources (in order):
 *   1. WHISPER_PROMPT — user-configured static terms (from settings / .env)
 *   2. whisper_vocab.json — auto-accumulated from user corrections (feedback)
 * Whisper prompt limit is ~224 tokens, so we keep it concise.
 */
function buildWhisperPrompt() {
  const parts = [];

  // 1. User-configured static prompt (highest priority)
  if (WHISPER_PROMPT) parts.push(WHISPER_PROMPT.trim());

  // 2. Load accumulated vocabulary from user corrections
  try {
    const vocab = loadWhisperVocab();
    if (vocab.length > 0) {
      // Already sorted by count desc in mergeWhisperVocab; take top 40
      const terms = vocab.slice(0, 40).map(v => v.term);
      parts.push(terms.join(', '));
    }
  } catch (_) {}

  const prompt = parts.join('. ');
  // Whisper prompt is limited to ~224 tokens; truncate to ~500 chars as safety margin
  return prompt.length > 500 ? prompt.slice(0, 500) : prompt;
}

/**
 * Call OpenRouter API with streaming for voice refinement.
 * Replaces the old CLI spawn approach for much lower latency.
 * Supports concurrent requests (no sequential queue needed).
 */
async function callVoiceAPI(prompt, { reqId, onStart, onFirstToken, onChunk, onDone, onError }) {
  if (typeof onStart === 'function') onStart();

  if (!OPENROUTER_API_KEY) {
    onError('OPENROUTER_API_KEY 环境变量未设置');
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 60000);

  try {
    const apiStart = Date.now();
    console.log(`[webcc/voice][${reqId}] Sending request to OpenRouter (model: ${OPENROUTER_MODEL})`);
    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenRouter API ${response.status}: ${errText.slice(0, 200)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstTokenSent = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              if (!firstTokenSent) {
                firstTokenSent = true;
                if (typeof onFirstToken === 'function') onFirstToken(Date.now() - apiStart);
              }
              onChunk(content);
            }
          } catch (_) { /* skip non-JSON lines */ }
        }
      }
    } finally {
      reader.releaseLock();
    }

    clearTimeout(timeout);
    onDone();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      onChunk('[超时：AI处理超过60秒，已中止]');
      onDone();
    } else {
      onError(err.message);
    }
  }
}

console.log(`[webcc/voice] Voice API initialized (OpenRouter, model: ${OPENROUTER_MODEL})`);

// ── File upload for chat mode ──
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const ext = path.extname(req.file.originalname).replace(/[^a-z0-9.]/gi, '').slice(0, 12) || 'bin';
  const safeName = `webcc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext.startsWith('.') ? ext : '.' + ext}`;
  const tmpPath = path.join(os.tmpdir(), safeName);
  fs.writeFileSync(tmpPath, req.file.buffer);
  console.log(`[webcc] Uploaded: ${tmpPath} (${req.file.originalname})`);
  res.json({ path: tmpPath, name: req.file.originalname });
});

app.post('/api/voice/refine', (req, res) => {
  const reqId = `vr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const raw = (req.body.raw || '').trim();
  console.log(`[webcc/voice][${reqId}] POST /api/voice/refine received, raw length: ${raw.length}, raw: ${JSON.stringify(raw.slice(0, 100))}`);

  if (!raw) {
    console.log(`[webcc/voice][${reqId}] Empty raw, sending immediate [DONE]`);
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  const examples = loadVoiceExamples();
  let examplesStr = '';
  if (examples.length > 0) {
    examplesStr = '\n\n历史优化案例（供参考）：\n' + examples.map((ex, i) =>
      `[案例${i + 1}] 原始：${ex.raw}\n优化后：${ex.userFinal}`
    ).join('\n');
  }

  const prompt = `你是程序员语音输入助手。原始语音识别文字可能口语化、夹杂中英文。
任务：
1. 保留所有英文技术词汇/命令/API名（React, useState, git commit等）
2. 将口语转为专业简洁的程序员描述
3. 整理成清晰可操作的需求
4. 忠实原意，不臆造功能${examplesStr}

原始语音：${raw}
直接输出优化后的文本，不要任何解释或前缀。`;

  console.log(`[webcc/voice][${reqId}] Prompt length: ${prompt.length} chars`);
  console.log(`[webcc/voice][${reqId}] Setting SSE response headers...`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');  // disable proxy buffering
  res.flushHeaders();
  console.log(`[webcc/voice][${reqId}] SSE headers flushed`);
  // Disable Nagle's algorithm so small SSE chunks are sent immediately (important for TLS/HTTPS)
  if (res.socket) {
    res.socket.setNoDelay(true);
    console.log(`[webcc/voice][${reqId}] Socket NoDelay set`);
  }

  // Send SSE comment heartbeats every 5s to prevent browser/proxy idle disconnects
  const heartbeat = setInterval(() => {
    if (!clientDisconnected) {
      try { res.write(': heartbeat\n\n'); } catch (_) {}
    }
  }, 5000);

  let clientDisconnected = false;
  res.on('close', () => {
    clientDisconnected = true;
    clearInterval(heartbeat);
    console.log(`[webcc/voice][${reqId}] Client disconnected (res close event)`);
  });

  // Helper: write SSE event and force flush (important for TLS/HTTPS)
  function sseWrite(chunk) {
    if (clientDisconnected) {
      console.warn(`[webcc/voice][${reqId}] sseWrite skipped (client disconnected), chunk: ${JSON.stringify(chunk.slice(0, 100))}`);
      return;
    }
    try {
      const writeResult = res.write(chunk);
      console.log(`[webcc/voice][${reqId}] res.write returned: ${writeResult}, chunk: ${JSON.stringify(chunk.slice(0, 120))}`);
      // Force flush the underlying socket for TLS connections
      if (res.socket && typeof res.socket.uncork === 'function') {
        res.socket.cork();
        res.socket.uncork();
      }
    } catch (writeErr) {
      console.error(`[webcc/voice][${reqId}] sseWrite error:`, writeErr.message);
    }
  }

  const t0 = Date.now();
  console.log(`[webcc/voice][${reqId}] Calling OpenRouter API (model: ${OPENROUTER_MODEL})`);

  callVoiceAPI(prompt, {
    reqId,
    onStart() {
      console.log(`[webcc/voice][${reqId}] API request started`);
      sseWrite(`data: ${JSON.stringify({ timing: 'queue', ms: 0 })}\n\n`);
    },
    onFirstToken(ms) {
      console.log(`[webcc/voice][${reqId}] First token: ${ms}ms`);
      sseWrite(`data: ${JSON.stringify({ timing: 'first_token', ms })}\n\n`);
    },
    onChunk(text) {
      sseWrite(`data: ${JSON.stringify({ text })}\n\n`);
    },
    onDone() {
      clearInterval(heartbeat);
      const totalMs = Date.now() - t0;
      console.log(`[webcc/voice][${reqId}] Done, total: ${totalMs}ms, clientDisconnected=${clientDisconnected}`);
      if (!clientDisconnected) {
        try {
          sseWrite(`data: ${JSON.stringify({ timing: 'ai_process', ms: totalMs })}\n\n`);
          sseWrite(`data: ${JSON.stringify({ timing: 'total', ms: totalMs })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } catch (endErr) {
          console.error(`[webcc/voice][${reqId}] Error ending response:`, endErr.message);
        }
      }
    },
    onError(msg) {
      clearInterval(heartbeat);
      console.error(`[webcc/voice][${reqId}] Error: ${msg}`);
      if (!clientDisconnected) {
        try {
          res.write(`data: ${JSON.stringify({ text: `[错误: ${msg}]` })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } catch (_) {}
      }
    },
  });
});

app.post('/api/voice/feedback', (req, res) => {
  const { raw, refined, userFinal } = req.body;
  if (raw && refined !== undefined && userFinal !== undefined && userFinal !== refined) {
    appendVoiceExample({ raw, refined, userFinal, ts: new Date().toISOString() });

    // Extract user corrections and merge into Whisper vocabulary
    // Compare against raw (STT output) — these are the words Whisper got wrong
    const corrections = extractCorrections(raw, userFinal);
    if (corrections.length > 0) {
      mergeWhisperVocab(corrections);
    }
  }
  res.json({ ok: true });
});

// ── Whisper vocabulary management ──
app.get('/api/voice/vocab', (req, res) => {
  res.json(loadWhisperVocab());
});

app.delete('/api/voice/vocab/:term', (req, res) => {
  const target = req.params.term.toLowerCase();
  const vocab = loadWhisperVocab().filter(v => v.term.toLowerCase() !== target);
  saveWhisperVocab(vocab);
  res.json({ ok: true, remaining: vocab.length });
});

// ── Whisper STT endpoint ──
app.post('/api/voice/stt', upload.single('file'), async (req, res) => {
  const reqId = `stt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  console.log(`[webcc/stt][${reqId}] POST /api/voice/stt received`);

  if (!req.file) {
    return res.status(400).json({ error: '未收到音频文件' });
  }

  const apiKey = WHISPER_API_KEY || OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'WHISPER_API_KEY 或 OPENROUTER_API_KEY 未设置' });
  }

  console.log(`[webcc/stt][${reqId}] File: ${req.file.originalname}, size: ${req.file.size}, mime: ${req.file.mimetype}`);
  console.log(`[webcc/stt][${reqId}] Forwarding to ${WHISPER_BASE_URL}/audio/transcriptions (model: ${WHISPER_MODEL})`);

  const t0 = Date.now();
  try {
    const formData = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' });
    formData.append('file', blob, req.file.originalname || 'audio.webm');
    formData.append('model', WHISPER_MODEL);

    // Add language hint to skip auto-detection
    if (WHISPER_LANGUAGE) {
      formData.append('language', WHISPER_LANGUAGE);
    }

    // Add prompt to guide vocabulary and style recognition
    const whisperPrompt = buildWhisperPrompt();
    if (whisperPrompt) {
      formData.append('prompt', whisperPrompt);
      console.log(`[webcc/stt][${reqId}] Whisper prompt (${whisperPrompt.length} chars): ${whisperPrompt.slice(0, 120)}...`);
    }

    const response = await fetch(`${WHISPER_BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[webcc/stt][${reqId}] Whisper API error ${response.status}: ${errText.slice(0, 300)}`);
      return res.status(502).json({ error: `Whisper API ${response.status}: ${errText.slice(0, 200)}` });
    }

    const result = await response.json();
    const durationMs = Date.now() - t0;
    console.log(`[webcc/stt][${reqId}] Success in ${durationMs}ms, text length: ${(result.text || '').length}`);
    res.json({ text: result.text || '', duration_ms: durationMs });
  } catch (err) {
    const durationMs = Date.now() - t0;
    console.error(`[webcc/stt][${reqId}] Error after ${durationMs}ms:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Voice settings API ──
const ENV_PATH = path.join(__dirname, '.env');

function readEnvFile() {
  const vars = {};
  try {
    fs.readFileSync(ENV_PATH, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
      if (m) vars[m[1]] = m[2];
    });
  } catch (_) {}
  return vars;
}

function writeEnvFile(updates) {
  let lines = [];
  try { lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n'); } catch (_) {}
  const written = new Set();
  lines = lines.map(line => {
    const m = line.match(/^\s*([^#=]+?)\s*=/);
    if (m && updates.hasOwnProperty(m[1])) {
      written.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  }).filter(l => l.trim() !== '');
  for (const [k, v] of Object.entries(updates)) {
    if (!written.has(k)) lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n');
}

app.get('/api/settings/voice', (req, res) => {
  const env = readEnvFile();
  const key = env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || '';
  const wsKey = env.WHISPER_API_KEY || process.env.WHISPER_API_KEY || '';
  res.json({
    baseUrl: env.OPENROUTER_BASE_URL || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: key ? key.slice(0, 8) + '****' + key.slice(-4) : '',
    model: env.OPENROUTER_MODEL || process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001',
    hasKey: !!key,
    whisperBaseUrl: env.WHISPER_BASE_URL || process.env.WHISPER_BASE_URL || 'https://openrouter.ai/api/v1',
    whisperApiKey: wsKey ? wsKey.slice(0, 8) + '****' + wsKey.slice(-4) : '',
    whisperModel: env.WHISPER_MODEL || process.env.WHISPER_MODEL || 'whisper-large-v3-turbo',
    hasWhisperKey: !!wsKey,
    whisperLanguage: env.WHISPER_LANGUAGE || process.env.WHISPER_LANGUAGE || 'zh',
    whisperPrompt: env.WHISPER_PROMPT || process.env.WHISPER_PROMPT || '',
  });
});

app.post('/api/settings/voice', (req, res) => {
  const { baseUrl, apiKey, model, whisperBaseUrl, whisperApiKey, whisperModel, whisperLanguage, whisperPrompt } = req.body;
  const updates = {};
  if (baseUrl !== undefined) updates.OPENROUTER_BASE_URL = baseUrl;
  if (apiKey !== undefined && !apiKey.includes('****')) updates.OPENROUTER_API_KEY = apiKey;
  if (model !== undefined) updates.OPENROUTER_MODEL = model;
  if (whisperBaseUrl !== undefined) updates.WHISPER_BASE_URL = whisperBaseUrl;
  if (whisperApiKey !== undefined && !whisperApiKey.includes('****')) updates.WHISPER_API_KEY = whisperApiKey;
  if (whisperModel !== undefined) updates.WHISPER_MODEL = whisperModel;
  if (whisperLanguage !== undefined) updates.WHISPER_LANGUAGE = whisperLanguage;
  if (whisperPrompt !== undefined) updates.WHISPER_PROMPT = whisperPrompt;
  writeEnvFile(updates);
  // Update in-memory env + module-level constants
  for (const [k, v] of Object.entries(updates)) process.env[k] = v;
  if (updates.OPENROUTER_API_KEY) OPENROUTER_API_KEY = updates.OPENROUTER_API_KEY;
  if (updates.OPENROUTER_MODEL) OPENROUTER_MODEL = updates.OPENROUTER_MODEL;
  if (updates.OPENROUTER_BASE_URL) OPENROUTER_BASE_URL = updates.OPENROUTER_BASE_URL;
  if (updates.WHISPER_API_KEY) WHISPER_API_KEY = updates.WHISPER_API_KEY;
  if (updates.WHISPER_MODEL) WHISPER_MODEL = updates.WHISPER_MODEL;
  if (updates.WHISPER_BASE_URL) WHISPER_BASE_URL = updates.WHISPER_BASE_URL;
  if (updates.WHISPER_LANGUAGE) WHISPER_LANGUAGE = updates.WHISPER_LANGUAGE;
  if (updates.WHISPER_PROMPT !== undefined) WHISPER_PROMPT = updates.WHISPER_PROMPT;
  console.log(`[webcc/voice] Settings updated: model=${OPENROUTER_MODEL}, baseUrl=${OPENROUTER_BASE_URL}, key=${OPENROUTER_API_KEY ? 'set' : 'empty'}`);
  console.log(`[webcc/stt] Settings updated: model=${WHISPER_MODEL}, baseUrl=${WHISPER_BASE_URL}, key=${WHISPER_API_KEY ? 'set' : 'empty'}`);
  res.json({ ok: true });
});

// SSE test endpoint (for debugging voice streaming issues)
app.get('/api/voice/test-sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  if (res.socket) res.socket.setNoDelay(true);

  let i = 0;
  const iv = setInterval(() => {
    res.write(`data: ${JSON.stringify({ text: `SSE test chunk ${++i}` })}\n\n`);
    if (i >= 3) {
      clearInterval(iv);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }, 500);
  req.on('close', () => clearInterval(iv));
});

// ── Web Push (PWA notifications) ──
const PUSH_SUBS_FILE = path.join(__dirname, 'push_subscriptions.json');

// VAPID key management: auto-generate and persist in .env
function ensureVapidKeys() {
  let pubKey = process.env.VAPID_PUBLIC_KEY;
  let privKey = process.env.VAPID_PRIVATE_KEY;
  if (pubKey && privKey) return { pubKey, privKey };

  console.log('[webcc/push] Generating VAPID keys...');
  const keys = webpush.generateVAPIDKeys();
  pubKey = keys.publicKey;
  privKey = keys.privateKey;

  // Persist to .env
  const updates = { VAPID_PUBLIC_KEY: pubKey, VAPID_PRIVATE_KEY: privKey };
  writeEnvFile(updates);
  process.env.VAPID_PUBLIC_KEY = pubKey;
  process.env.VAPID_PRIVATE_KEY = privKey;
  console.log('[webcc/push] VAPID keys generated and saved to .env');
  return { pubKey, privKey };
}

const vapidKeys = ensureVapidKeys();
webpush.setVapidDetails('mailto:webcc@localhost', vapidKeys.pubKey, vapidKeys.privKey);

// Push subscription store
let pushSubscriptions = new Map(); // endpoint -> PushSubscription JSON

// Push health tracking
const pushHealthStats = new Map(); // endpoint -> { successCount, failCount, lastSuccessTime, lastFailTime, lastFailReason, consecutiveFails }
const pushGlobalStats = { totalSent: 0, totalSuccess: 0, totalFail: 0, lastPushTime: 0, lastPushType: '', lastPushSessionId: '' };

function getPushHealthEntry(endpoint) {
  if (!pushHealthStats.has(endpoint)) {
    pushHealthStats.set(endpoint, { successCount: 0, failCount: 0, lastSuccessTime: 0, lastFailTime: 0, lastFailReason: '', consecutiveFails: 0 });
  }
  return pushHealthStats.get(endpoint);
}

// Bark / Webhook backup notification channels
let BARK_URL = process.env.BARK_URL || '';
let WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const barkHealth = { lastSendTime: 0, lastSuccess: true, lastError: '' };
const webhookHealth = { lastSendTime: 0, lastSuccess: true, lastError: '' };

function loadPushSubscriptions() {
  try {
    if (fs.existsSync(PUSH_SUBS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, 'utf8'));
      pushSubscriptions = new Map(data.map(s => [s.endpoint, s]));
      console.log(`[webcc/push] Loaded ${pushSubscriptions.size} push subscription(s)`);
    }
  } catch (_) {}
}

function savePushSubscriptions() {
  try {
    fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify([...pushSubscriptions.values()], null, 2));
  } catch (e) {
    console.error('[webcc/push] Failed to save subscriptions:', e.message);
  }
}

loadPushSubscriptions();

// ── Server Info (LAN IP for QR code) ──
app.get('/api/server-info', (req, res) => {
  const nets = os.networkInterfaces();
  let ip = '127.0.0.1';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ip = net.address;
        break;
      }
    }
    if (ip !== '127.0.0.1') break;
  }
  const url = `http://${ip}:${PORT}`;
  res.json({ ip, port: PORT, proto: 'http', url, token: ACCESS_TOKEN || '' });
});

// Push API endpoints
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: vapidKeys.pubKey });
});

app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  pushSubscriptions.set(sub.endpoint, sub);
  savePushSubscriptions();
  console.log(`[webcc/push] New subscription (${pushSubscriptions.size} total)`);
  res.json({ ok: true });
});

app.delete('/api/push/subscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint && pushSubscriptions.has(endpoint)) {
    pushSubscriptions.delete(endpoint);
    savePushSubscriptions();
  }
  res.json({ ok: true });
});

// Validate if a subscription is registered server-side
app.post('/api/push/validate', (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  res.json({ known: pushSubscriptions.has(endpoint) });
});

// Push health status
app.get('/api/push/health', (req, res) => {
  const subs = [];
  for (const [endpoint] of pushSubscriptions) {
    const h = pushHealthStats.get(endpoint) || { successCount: 0, failCount: 0, lastSuccessTime: 0, lastFailTime: 0, lastFailReason: '', consecutiveFails: 0 };
    subs.push({
      endpointShort: endpoint.length > 50 ? endpoint.slice(0, 35) + '...' + endpoint.slice(-12) : endpoint,
      ...h,
    });
  }
  res.json({
    subscriptions: subs,
    subscriptionCount: pushSubscriptions.size,
    global: pushGlobalStats,
    bark: { configured: !!BARK_URL, ...barkHealth },
    webhook: { configured: !!WEBHOOK_URL, ...webhookHealth },
  });
});

// Test push notification
app.post('/api/push/test', async (req, res) => {
  const payload = {
    title: 'WebCC Test',
    body: `Push test at ${new Date().toLocaleTimeString()}`,
    type: 'test',
    tag: 'webcc-test',
    url: '/manage',
  };
  await sendPushToAll(payload);
  sendBarkNotification(payload.title, payload.body, payload.url);
  sendWebhookNotification(payload);
  res.json({ ok: true, subscribers: pushSubscriptions.size });
});

// Test Bark only
app.post('/api/push/test-bark', (req, res) => {
  if (!BARK_URL) return res.status(400).json({ error: 'Bark URL not configured' });
  sendBarkNotification('WebCC Test', `Bark test at ${new Date().toLocaleTimeString()}`, '/manage');
  res.json({ ok: true });
});

// Test Webhook only
app.post('/api/push/test-webhook', (req, res) => {
  if (!WEBHOOK_URL) return res.status(400).json({ error: 'Webhook URL not configured' });
  sendWebhookNotification({ title: 'WebCC Test', body: `Webhook test at ${new Date().toLocaleTimeString()}`, type: 'test' });
  res.json({ ok: true });
});

// Notification settings (Bark / Webhook)
app.get('/api/settings/notify', (req, res) => {
  res.json({
    barkUrl: BARK_URL ? BARK_URL.replace(/\/[^/]{8,}$/, '/****') : '',
    hasBark: !!BARK_URL,
    webhookUrl: WEBHOOK_URL || '',
    hasWebhook: !!WEBHOOK_URL,
  });
});

app.post('/api/settings/notify', (req, res) => {
  const { barkUrl, webhookUrl } = req.body || {};
  const updates = {};
  if (typeof barkUrl === 'string') { BARK_URL = barkUrl; updates.BARK_URL = barkUrl; }
  if (typeof webhookUrl === 'string') { WEBHOOK_URL = webhookUrl; updates.WEBHOOK_URL = webhookUrl; }
  if (Object.keys(updates).length > 0) writeEnvFile(updates);
  res.json({ ok: true });
});

// Send push notification to all subscribers (async, properly handles stale cleanup)
async function sendPushToAll(payload) {
  if (pushSubscriptions.size === 0) return;
  const payloadStr = JSON.stringify(payload);
  const entries = [...pushSubscriptions.entries()];
  const results = await Promise.allSettled(
    entries.map(([endpoint, sub]) =>
      webpush.sendNotification(sub, payloadStr).then(
        () => ({ endpoint, ok: true }),
        err => ({ endpoint, ok: false, statusCode: err.statusCode, message: err.message })
      )
    )
  );

  const stale = [];
  for (const r of results) {
    const v = r.status === 'fulfilled' ? r.value : { endpoint: '', ok: false, message: 'settled-rejected' };
    const h = getPushHealthEntry(v.endpoint);
    pushGlobalStats.totalSent++;
    if (v.ok) {
      h.successCount++;
      h.lastSuccessTime = Date.now();
      h.consecutiveFails = 0;
      pushGlobalStats.totalSuccess++;
    } else {
      h.failCount++;
      h.lastFailTime = Date.now();
      h.lastFailReason = v.message || `HTTP ${v.statusCode}`;
      h.consecutiveFails++;
      pushGlobalStats.totalFail++;
      if (v.statusCode === 404 || v.statusCode === 410) stale.push(v.endpoint);
      console.error(`[webcc/push] Send failed for ${v.endpoint.slice(0, 40)}... (${v.statusCode || v.message})`);
    }
  }

  if (stale.length > 0) {
    for (const ep of stale) {
      pushSubscriptions.delete(ep);
      pushHealthStats.delete(ep);
    }
    savePushSubscriptions();
    console.log(`[webcc/push] Cleaned ${stale.length} expired subscription(s)`);
  }
}

// Bark push notification (iOS backup)
function sendBarkNotification(title, body, url) {
  if (!BARK_URL) return;
  const barkUrl = `${BARK_URL.replace(/\/$/, '')}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?url=${encodeURIComponent(url || '')}&group=webcc`;
  barkHealth.lastSendTime = Date.now();
  const mod = barkUrl.startsWith('https') ? https : http;
  mod.get(barkUrl, res => {
    barkHealth.lastSuccess = res.statusCode >= 200 && res.statusCode < 300;
    if (!barkHealth.lastSuccess) barkHealth.lastError = `HTTP ${res.statusCode}`;
    else barkHealth.lastError = '';
    res.resume();
  }).on('error', err => {
    barkHealth.lastSuccess = false;
    barkHealth.lastError = err.message;
    console.error('[webcc/push] Bark send failed:', err.message);
  });
}

// Generic webhook notification
function sendWebhookNotification(payload) {
  if (!WEBHOOK_URL) return;
  webhookHealth.lastSendTime = Date.now();
  const data = JSON.stringify(payload);
  const parsed = new URL(WEBHOOK_URL);
  const mod = parsed.protocol === 'https:' ? https : http;
  const req = mod.request(parsed, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
    webhookHealth.lastSuccess = res.statusCode >= 200 && res.statusCode < 300;
    if (!webhookHealth.lastSuccess) webhookHealth.lastError = `HTTP ${res.statusCode}`;
    else webhookHealth.lastError = '';
    res.resume();
  });
  req.on('error', err => {
    webhookHealth.lastSuccess = false;
    webhookHealth.lastError = err.message;
    console.error('[webcc/push] Webhook send failed:', err.message);
  });
  req.end(data);
}

// ── Server-side notification detection (for push notifications) ──
const PUSH_ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z~]|\][^\x07]*(?:\x07|\x1b\\)|[()][AB012]|.)/g;
// "等待操作" — 需要用户做选择或确认（选 1/2/3、Y/n、Allow/Deny）
const PUSH_WAITING_PATTERNS = [
  /\[Y\/n\]/, /\[y\/N\]/, /\(y\/n\)/i, /\(yes\/no\)/i,
  /Yes\s*\/\s*No/i,
  /Allow\s*(once|always)/i, /Approve\??/i, /Deny/i,
  /Do you want to proceed/i, /Do you want to/i, /Press Enter/i,
  /^\s*[1-9]\.\s+\S/m, /^\s*[1-9]\)\s+\S/m,
];
const PUSH_IDLE_MS = 6000;
const PUSH_MIN_CHARS = 80;
const PUSH_COOLDOWN = 8000;

// Per-session server-side monitor state
const pushMonitors = new Map();

function pushStripAnsi(str) {
  return str.replace(PUSH_ANSI_RE, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function pushMatchesWaiting(text) {
  for (const pat of PUSH_WAITING_PATTERNS) {
    if (pat.test(text)) return true;
  }
  return false;
}

function initPushMonitor(sessionId) {
  if (pushMonitors.has(sessionId)) return pushMonitors.get(sessionId);
  const mon = {
    state: 'idle',
    chars: 0,
    recentText: '',
    idleTimer: null,
    lastPushTime: 0,
  };
  pushMonitors.set(sessionId, mon);
  return mon;
}

function cleanupPushMonitor(sessionId) {
  const mon = pushMonitors.get(sessionId);
  if (mon) {
    if (mon.idleTimer) clearTimeout(mon.idleTimer);
    pushMonitors.delete(sessionId);
  }
}

/**
 * Called from ptyProcess.onData to detect notification patterns server-side.
 * Triggers web push when a session completes or waits for user action.
 */
function pushOnOutput(sessionId, rawData) {
  if (pushSubscriptions.size === 0 && !BARK_URL && !WEBHOOK_URL) return; // no channels configured

  const mon = initPushMonitor(sessionId);
  const text = pushStripAnsi(rawData);
  const printable = text.replace(/\s+/g, '');

  mon.recentText += text;
  if (mon.recentText.length > 3000) mon.recentText = mon.recentText.slice(-2000);

  if (printable.length > 0) {
    mon.chars += printable.length;
    if (mon.state === 'idle') mon.state = 'active';
  }

  // Immediate pattern check
  if (mon.state === 'active' && pushMatchesWaiting(text)) {
    mon.state = 'waiting';
    triggerPush(sessionId, 'waiting', '等待操作');
  }

  // Idle timer
  if (mon.idleTimer) clearTimeout(mon.idleTimer);
  mon.idleTimer = setTimeout(() => {
    if (mon.state === 'active' && mon.chars >= PUSH_MIN_CHARS) {
      const tail = mon.recentText.slice(-2000);
      if (pushMatchesWaiting(tail)) {
        triggerPush(sessionId, 'waiting', '等待操作');
      } else {
        triggerPush(sessionId, 'completed', '任务已完成');
      }
    }
    mon.state = 'idle';
    mon.chars = 0;
    mon.recentText = '';
  }, PUSH_IDLE_MS);
}

function pushOnInput(sessionId) {
  const mon = pushMonitors.get(sessionId);
  if (!mon) return;
  mon.state = 'idle';
  mon.chars = 0;
  mon.recentText = '';
  if (mon.idleTimer) {
    clearTimeout(mon.idleTimer);
    mon.idleTimer = null;
  }
}

function triggerPush(sessionId, type, message) {
  const mon = pushMonitors.get(sessionId);
  if (!mon) return;

  const now = Date.now();
  if (now - mon.lastPushTime < PUSH_COOLDOWN) return; // cooldown
  mon.lastPushTime = now;

  const session = sessions.get(sessionId);
  const cwd = session ? session.cwd : '';
  const shortCwd = cwd.length > 30 ? '...' + cwd.slice(-27) : cwd;

  const payload = {
    title: type === 'waiting' ? `WebCC #${sessionId}: 等待操作` : `WebCC #${sessionId}: 完成`,
    body: `${message}\n${shortCwd}`,
    sessionId,
    type,
    tag: `webcc-${sessionId}`,
    url: `/manage`,
  };

  pushGlobalStats.lastPushTime = now;
  pushGlobalStats.lastPushType = type;
  pushGlobalStats.lastPushSessionId = sessionId;

  // Send to all channels in parallel
  sendPushToAll(payload);
  sendBarkNotification(payload.title, `${message} ${shortCwd}`, payload.url);
  sendWebhookNotification(payload);

  console.log(`[webcc/push] Sent ${type} notification for session ${sessionId}`);
}

// ── WeChat Bridge ──
wechatBridge.init(sessions, persistedSessions, tmuxWriteInput);
app.use('/api/wechat', wechatBridge.router);

// Root → manage page (unless ?id= is specified, which means a terminal session)
app.get('/', (req, res, next) => {
  if (req.query.id || req.query.newid || req.query.cwd) return next(); // terminal session
  res.redirect('/manage');
});

// APK info endpoint — returns file modification time
app.get('/api/apk-info', (req, res) => {
  const apkPath = path.join(__dirname, 'public', 'webcc.apk');
  try {
    const stat = fs.statSync(apkPath);
    res.json({ exists: true, mtime: stat.mtime.toISOString(), size: stat.size });
  } catch {
    res.json({ exists: false });
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.apk')) {
      res.set('Content-Type', 'application/vnd.android.package-archive');
      res.set('Content-Disposition', 'attachment; filename="webcc.apk"');
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
    }
  },
}));

// ── Chat mode: message history ──
const CHAT_HISTORY_DIR = path.join(__dirname, 'chat_history');
try { fs.mkdirSync(CHAT_HISTORY_DIR, { recursive: true }); } catch (_) {}
const MAX_CHAT_MESSAGES = 50;  // keep last N messages per session

// In-memory cache: sessionName → [ { role, content, ts, cost?, tools? } ]
const chatHistories = new Map();

function chatHistoryPath(sessionName) {
  const safe = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_') || '_default';
  return path.join(CHAT_HISTORY_DIR, `${safe}.json`);
}

function loadChatHistory(sessionName) {
  if (chatHistories.has(sessionName)) return chatHistories.get(sessionName);
  try {
    const data = JSON.parse(fs.readFileSync(chatHistoryPath(sessionName), 'utf8'));
    chatHistories.set(sessionName, data);
    return data;
  } catch (_) {
    const arr = [];
    chatHistories.set(sessionName, arr);
    return arr;
  }
}

function saveChatHistory(sessionName) {
  const history = chatHistories.get(sessionName);
  if (!history) return;
  try {
    fs.writeFileSync(chatHistoryPath(sessionName), JSON.stringify(history, null, 2));
  } catch (e) {
    console.error(`[webcc/chat] Failed to save history for ${sessionName}:`, e.message);
  }
}

function appendChatMessage(sessionName, msg) {
  const history = loadChatHistory(sessionName);
  history.push(msg);
  while (history.length > MAX_CHAT_MESSAGES) history.shift();
  saveChatHistory(sessionName);
}

// ── Chat sessions: session-level state for multi-client broadcast ──
// Keyed by sessionName, holds { claudeProc, lineBuf, clients, chatTurnCount,
//   chatClaudeSessionId, cwd, currentAssistantText, currentToolCalls, currentCost,
//   streamEvents }
const chatSessions = new Map();

function chatBroadcast(sessionName, payload) {
  const cs = chatSessions.get(sessionName);
  if (!cs) return;
  const json = JSON.stringify(payload);
  for (const client of cs.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(json); } catch (_) {}
    }
  }
}

// ── Chat mode: stream-json WebSocket ──
function handleChatWs(ws, req, urlObj) {
  const sessionName = urlObj.searchParams.get('session') || '_default';
  const sessionData = sessions.get(sessionName) || persistedSessions.get(sessionName);
  let cwd = urlObj.searchParams.get('cwd') || '';
  if (!cwd && sessionData?.cwd) cwd = sessionData.cwd;
  if (!cwd) cwd = os.homedir();

  // Get or create session-level state
  let cs = chatSessions.get(sessionName);
  if (!cs) {
    // Get or create a stable Claude session UUID for chat resume
    // Use a SEPARATE field (chatClaudeSessionId) so terminal restarts don't nuke chat context
    const existing = persistedSessions.get(sessionName);
    let chatClaudeSessionId = existing?.chatClaudeSessionId;
    if (!chatClaudeSessionId) {
      chatClaudeSessionId = crypto.randomUUID();
      if (existing) {
        existing.chatClaudeSessionId = chatClaudeSessionId;
      } else {
        persistedSessions.set(sessionName, { id: sessionName, cwd, createdAt: new Date(), chatClaudeSessionId });
      }
      savePersistedSessions();
    }

    const history = loadChatHistory(sessionName);
    cs = {
      clients: new Set(),
      claudeProc: null,
      lineBuf: '',
      chatClaudeSessionId,
      chatTurnCount: history.filter(m => m.role === 'assistant').length,
      cwd,
      currentAssistantText: '',
      currentToolCalls: [],
      currentCost: null,
      isStreaming: false,
      // Replay buffer: stream events from current turn, for reconnecting clients
      streamReplay: [],
    };
    chatSessions.set(sessionName, cs);
  }

  cs.clients.add(ws);

  ws.send(JSON.stringify({
    type: 'system', subtype: 'init',
    cwd: cs.cwd, session: sessionName, session_id: sessionName,
    is_streaming: cs.isStreaming,
  }));

  // Replay saved history + in-progress assistant response (if any)
  const history = loadChatHistory(sessionName);
  const replayMessages = [...history];
  // Append unsaved in-progress response so reconnecting clients see current state
  if (cs.currentAssistantText || cs.currentToolCalls.length) {
    replayMessages.push({
      role: 'assistant',
      content: cs.currentAssistantText,
      tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
      ts: Date.now(),
      streaming: cs.isStreaming || false,
    });
  }
  if (replayMessages.length > 0) {
    ws.send(JSON.stringify({ type: 'chat_history', messages: replayMessages }));
  }

  // If a stream is in progress, replay buffered events so reconnected client catches up
  if (cs.isStreaming && cs.streamReplay.length > 0) {
    for (const evt of cs.streamReplay) {
      try { ws.send(JSON.stringify(evt)); } catch (_) {}
    }
  }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'cancel') {
        if (cs.claudeProc) {
          console.log('[webcc/chat] Cancel requested, killing claude process');
          try { cs.claudeProc.kill('SIGTERM'); } catch (_) {}
          cs.claudeProc = null;
          cs.lineBuf = '';
          cs.isStreaming = false;
          cs.streamReplay = [];
        }
        // Save partial response if any
        if (cs.currentAssistantText || cs.currentToolCalls.length) {
          appendChatMessage(sessionName, {
            role: 'assistant', content: cs.currentAssistantText,
            tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
            ts: Date.now(), cancelled: true,
          });
          cs.currentAssistantText = '';
          cs.currentToolCalls = [];
        }
        return;
      }

      if (msg.type === 'clear_history') {
        const h = chatHistories.get(sessionName);
        if (h) h.length = 0;
        saveChatHistory(sessionName);
        // Reset Claude session so next turn starts fresh
        cs.chatClaudeSessionId = crypto.randomUUID();
        cs.chatTurnCount = 0;
        const existing = persistedSessions.get(sessionName);
        if (existing) existing.chatClaudeSessionId = cs.chatClaudeSessionId;
        savePersistedSessions();
        console.log(`[webcc/chat] Cleared history and reset Claude session for ${sessionName}`);
        return;
      }

      if (msg.type === 'user_message' && msg.text) {
        // Kill previous process if still running
        if (cs.claudeProc) {
          try { cs.claudeProc.kill('SIGTERM'); } catch (_) {}
          cs.claudeProc = null;
          cs.lineBuf = '';
          cs.isStreaming = false;
          cs.streamReplay = [];
          // Save partial assistant response before starting new turn
          if (cs.currentAssistantText || cs.currentToolCalls.length) {
            appendChatMessage(sessionName, {
              role: 'assistant', content: cs.currentAssistantText,
              tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
              ts: Date.now(), cancelled: true,
            });
            cs.chatTurnCount++;
          }
        }

        // Save user message to history
        appendChatMessage(sessionName, {
          role: 'user', content: msg.text, ts: Date.now(),
        });

        // Reset accumulators
        cs.currentAssistantText = '';
        cs.currentToolCalls = [];
        cs.currentCost = null;
        cs.isStreaming = true;
        cs.streamReplay = [];
        cs._resultSaved = false;

        const args = [
          '-p',
          '--output-format', 'stream-json',
          '--verbose',
          '--include-partial-messages',
          '--dangerously-skip-permissions',
        ];

        // Resume strategy: first turn starts a named session, subsequent turns resume it
        if (cs.chatTurnCount > 0) {
          args.push('--resume', cs.chatClaudeSessionId);
        } else {
          args.push('--session-id', cs.chatClaudeSessionId);
        }

        args.push(msg.text);

        console.log(`[webcc/chat] Spawning (turn ${cs.chatTurnCount}): ${CLAUDE_CMD} ${args.join(' ').slice(0, 200)}...`);

        const spawnChat = (spawnArgs, isRetry) => {
          const proc = spawn(CLAUDE_CMD, spawnArgs, {
            cwd: cs.cwd,
            env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          let stderrBuf = '';

          proc.stdout.on('data', (chunk) => {
            cs.lineBuf += chunk.toString();
            const lines = cs.lineBuf.split('\n');
            cs.lineBuf = lines.pop();
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const evt = JSON.parse(line);

                // Accumulate for history
                if (evt.type === 'assistant' && evt.message?.content) {
                  for (const block of evt.message.content) {
                    if (block.type === 'text') cs.currentAssistantText += block.text;
                    if (block.type === 'tool_use') {
                      cs.currentToolCalls.push({
                        name: block.name,
                        input: block.input,
                        id: block.id,
                      });
                    }
                  }
                }
                if (evt.type === 'user' && evt.message?.content) {
                  for (const r of (Array.isArray(evt.message.content) ? evt.message.content : [evt.message.content])) {
                    if (r.type === 'tool_result') {
                      const tc = cs.currentToolCalls.find(t => t.id === r.tool_use_id);
                      if (tc) {
                        tc.result = typeof r.content === 'string' ? r.content :
                          Array.isArray(r.content) ? r.content.map(c => c.text || '').join('') :
                          JSON.stringify(r.content);
                        tc.is_error = r.is_error || false;
                        if (tc.result && tc.result.length > 1000) {
                          tc.result = tc.result.slice(0, 1000) + '...';
                        }
                      }
                    }
                  }
                }
                if (evt.type === 'result') {
                  cs.currentCost = evt.total_cost_usd || null;
                  // Save assistant response immediately on result (don't wait for proc close)
                  if (cs.currentAssistantText || cs.currentToolCalls.length) {
                    appendChatMessage(sessionName, {
                      role: 'assistant', content: cs.currentAssistantText,
                      tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
                      cost: cs.currentCost, ts: Date.now(),
                    });
                    cs.chatTurnCount++;
                    cs._resultSaved = true;  // flag so proc.close doesn't double-save
                  }
                }

                // Drop Claude CLI's own `system init` event — the server already
                // sent its own `system init` on WS connect. Forwarding Claude's
                // init (which has no `is_streaming` field) causes the client to
                // spuriously fire the "completed while disconnected" warning and
                // to insert extra "Session: …" dividers into the chat.
                if (evt.type === 'system' && evt.subtype === 'init') {
                  continue;
                }

                // Buffer for reconnect replay (keep last 500 events to avoid unbounded growth)
                cs.streamReplay.push(evt);
                if (cs.streamReplay.length > 500) cs.streamReplay.shift();

                // Broadcast to all connected clients
                chatBroadcast(sessionName, evt);
              } catch (_) {}
            }
          });

          proc.stderr.on('data', (chunk) => {
            stderrBuf += chunk.toString();
            console.error(`[webcc/chat] stderr: ${chunk.toString().slice(0, 200)}`);
          });

          proc.on('close', (code) => {
            if (cs.lineBuf.trim()) {
              try {
                const evt = JSON.parse(cs.lineBuf);
                if (evt.type === 'result') cs.currentCost = evt.total_cost_usd || null;
                cs.streamReplay.push(evt);
                chatBroadcast(sessionName, evt);
              } catch (_) {}
            }
            cs.lineBuf = '';
            cs.isStreaming = false;
            cs.streamReplay = [];

            // If resume failed (non-zero exit, no assistant output), retry without resume
            if (code !== 0 && !isRetry && !cs.currentAssistantText && cs.chatTurnCount > 0) {
              console.warn(`[webcc/chat] --resume failed (code ${code}), falling back to standalone. stderr: ${stderrBuf.slice(0, 300)}`);
              cs.chatClaudeSessionId = crypto.randomUUID();
              cs.chatTurnCount = 0;
              cs.isStreaming = true;
              cs.streamReplay = [];
              const existing = persistedSessions.get(sessionName);
              if (existing) existing.chatClaudeSessionId = cs.chatClaudeSessionId;
              savePersistedSessions();

              const fallbackArgs = [
                '-p', '--output-format', 'stream-json', '--verbose',
                '--include-partial-messages', '--dangerously-skip-permissions',
                '--session-id', cs.chatClaudeSessionId,
                msg.text,
              ];
              chatBroadcast(sessionName, { type: 'system', subtype: 'warning', message: 'Resume failed, starting fresh session' });
              cs.claudeProc = spawnChat(fallbackArgs, true);
              return;
            }

            cs.claudeProc = null;

            // Save assistant response to history (skip if already saved on 'result' event)
            if (!cs._resultSaved && (cs.currentAssistantText || cs.currentToolCalls.length)) {
              appendChatMessage(sessionName, {
                role: 'assistant', content: cs.currentAssistantText,
                tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
                cost: cs.currentCost, ts: Date.now(),
              });
              cs.chatTurnCount++;
            }
            cs.currentAssistantText = '';
            cs.currentToolCalls = [];
            cs._resultSaved = false;

            console.log(`[webcc/chat] claude exited with code ${code}`);
          });

          return proc;
        };

        cs.claudeProc = spawnChat(args, false);
      }
    } catch (e) {
      console.error('[webcc/chat] Bad message:', e.message);
    }
  });

  ws.on('close', () => {
    cs.clients.delete(ws);
    // Do NOT kill claudeProc on disconnect — it may still be streaming to other clients
    // or the user may reconnect (lock screen, tab switch, etc.)
    // Process is only killed on explicit cancel or new user_message
  });
}

// ── WebSocket connections ──
wss.on('connection', (ws, req) => {
  const urlObj = new URL(req.url, 'http://localhost');

  // Auth check for WebSocket (cookie, token param, or localhost)
  if (ACCESS_TOKEN) {
    const ip = req.socket.remoteAddress;
    const isLocal = (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') && !isExternalProxy(req);
    const cookies = parseCookies(req.headers.cookie);
    const hasCookie = cookies.webcc_auth && verifyAuthCookie(cookies.webcc_auth);
    const hasToken = urlObj.searchParams.get('token') === ACCESS_TOKEN;
    if (!isLocal && !hasCookie && !hasToken) {
      ws.close(4003, 'Forbidden');
      return;
    }
  }

  // Route to chat handler if path matches
  if (urlObj.pathname === '/ws/chat') {
    return handleChatWs(ws, req, urlObj);
  }

  let sessionId = urlObj.searchParams.get('id') || '';
  let session;

  if (sessionId && sessions.has(sessionId)) {
    session = sessions.get(sessionId);
    console.log(`[webcc] Client attached to session ${sessionId} (${session.clients.size + 1} total)`);
  } else {
    const customId = urlObj.searchParams.get('newid');
    if (!sessionId) sessionId = customId ? customId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) : generateId();
    const persisted = persistedSessions.get(sessionId);
    const requestedCwd = urlObj.searchParams.get('cwd');
    const cwd = requestedCwd ? resolveCwd(os.homedir(), requestedCwd)
              : persisted    ? persisted.cwd
              :                os.homedir();
    if (persisted) {
      console.log(`[webcc] Restoring session ${sessionId} (cwd: ${cwd})`);
    } else {
      console.log(`[webcc] Creating session ${sessionId}`);
    }
    try {
      session = createSession(sessionId, cwd);
    } catch (err) {
      const msg = `Failed to launch Claude Code: ${err.message}\r\n` +
        `Make sure "claude" is installed and available in PATH.\r\n` +
        `You can also set the CLAUDE_CMD environment variable.\r\n`;
      ws.send(JSON.stringify({ type: 'error', data: msg }));
      ws.close();
      return;
    }
  }

  session.clients.add(ws);

  // Keep-alive tracking (server pings periodically)
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Tell client its session ID
  ws.send(JSON.stringify({ type: 'session_id', id: sessionId }));

  // Don't replay buffered output — the toggle-resize trick below forces a full TUI
  // redraw at the client's actual dimensions, which is the only way to get correct layout.

  // WebSocket messages → PTY input / resize
  // Resize ownership: only the "primary" client (most recent input sender) controls resize.
  // This prevents multi-window resize wars (e.g. desktop + mobile).
  let inputBuf = '';
  let firstResize = true;
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input') {
        // Track cd commands to keep session.cwd up to date
        for (const ch of msg.data) {
          if (ch === '\r' || ch === '\n') {
            const line = inputBuf.trim();
            // Strip ANSI/VT escape sequences (e.g. bracketed-paste \x1b[200~…\x1b[201~)
            const cleanLine = line.replace(/\x1b(?:\[[0-9;?]*[A-Za-z~]|.)/g, '');
            const cdMatch = cleanLine.match(/^cd(?:\s+(.+))?$/);
            if (cdMatch) {
              const arg = (cdMatch[1] || '').trim().replace(/^["']|["']$/g, '');
              const newCwd = resolveCwd(session.cwd, arg);
              session.cwd = newCwd;
              const p = persistedSessions.get(session.id);
              if (p) {
                p.cwd = newCwd;
                savePersistedSessions();
              }
              console.log(`[webcc] Session ${session.id} cwd → ${newCwd}`);
            }
            inputBuf = '';
          } else if (ch === '\x03' || ch === '\x15') {
            // Ctrl+C or Ctrl+U clears the line
            inputBuf = '';
          } else if (ch === '\x7f' || ch === '\b') {
            inputBuf = inputBuf.slice(0, -1);
          } else if (ch >= ' ') {
            inputBuf += ch;
          }
        }
        // Mark this client as primary (it's actively typing → it controls resize)
        session.primaryClient = ws;
        tmuxWriteInput(session.id, msg.data);
        session.lastActivity = new Date();
        // Reset push monitor on user input (Enter key)
        if (msg.data.includes('\r') || msg.data.includes('\n')) {
          pushOnInput(session.id);
        }
      } else if (msg.type === 'resize') {
        const cols = Math.max(1, msg.cols);
        const rows = Math.max(1, msg.rows);

        // Resize ownership: first client to resize "owns" the terminal dimensions.
        // Other clients are ignored until the owner disconnects.
        // This prevents two windows (e.g. desktop + mobile) from fighting over size.
        if (!session.resizeOwner || session.resizeOwner === ws) {
          session.resizeOwner = ws;

          if (firstResize) {
            firstResize = false;
            if (session.clients.size <= 1) {
              tmuxResize(session.id, cols + 1, rows);
            }
          }
          tmuxResize(session.id, cols, rows);
        }
        // else: non-owner client — silently ignore resize
      } else if (msg.type === 'upload') {
        const { tempId, name, mime, data } = msg;
        const origExt = (name && path.extname(name).replace(/^\./, '')) || '';
        const ext = origExt.replace(/[^a-z0-9]/gi, '').slice(0, 10)
          || (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8);
        const safeName = `webcc_${Date.now()}.${ext}`;
        const tmpPath = path.join(os.tmpdir(), safeName);
        fs.writeFileSync(tmpPath, Buffer.from(data, 'base64'));
        console.log(`[webcc] Saved upload: ${tmpPath}`);
        ws.send(JSON.stringify({ type: 'file_saved', tempId, path: tmpPath, name }));
      }
    } catch (e) {
      console.error('[webcc] Bad message:', e.message, e.stack);
    }
  });

  ws.on('close', () => {
    session.clients.delete(ws);
    if (session.primaryClient === ws) session.primaryClient = null;
    if (session.resizeOwner === ws) session.resizeOwner = null;
    console.log(`[webcc] Client left session ${sessionId} (${session.clients.size} remaining)`);
  });

  ws.on('error', (err) => {
    console.error('[webcc] WebSocket error:', err.message);
    session.clients.delete(ws);
    if (session.primaryClient === ws) session.primaryClient = null;
    if (session.resizeOwner === ws) session.resizeOwner = null;
  });
});

// WebSocket keep-alive: ping clients every 30s, terminate unresponsive ones
const wsPingInterval = setInterval(() => {
  wss.clients.forEach(client => {
    if (client.isAlive === false) return client.terminate();
    client.isAlive = false;
    client.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(wsPingInterval));

// Recover existing tmux sessions on startup
recoverTmuxSessions();

server.listen(PORT, () => {
  console.log(`\n  WebCC is running at http://localhost:${PORT}\n`);
  console.log(`  Manage sessions at http://localhost:${PORT}/manage\n`);
  console.log(`  Use Tailscale / ngrok for HTTPS access from external devices.\n`);
});
