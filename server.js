'use strict';

const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const pty = require('node-pty');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');

const app = express();

const certPath = path.join(__dirname, 'cert.pem');
const keyPath = path.join(__dirname, 'key.pem');
const useHttps = fs.existsSync(certPath) && fs.existsSync(keyPath);
const PORT = process.env.PORT || (useHttps ? 3443 : 3000);

let server;
if (useHttps) {
  const sslOptions = {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
  server = https.createServer(sslOptions, app);
  // HTTP → HTTPS redirect
  const httpApp = express();
  httpApp.use((req, res) => {
    res.redirect(301, `https://${req.hostname}:${PORT}${req.url}`);
  });
  http.createServer(httpApp).listen(3000, () => {
    console.log(`  HTTP redirect running on http://localhost:3000\n`);
  });
} else {
  server = http.createServer(app);
}

const wss = new WebSocket.Server({ server });
const isWindows = process.platform === 'win32';

// Resolve the full path of the claude executable at startup
function resolveClaude() {
  if (process.env.CLAUDE_CMD) return process.env.CLAUDE_CMD;
  try {
    const result = execSync(isWindows ? 'where claude' : 'which claude', { encoding: 'utf8' });
    // 'where' may return multiple lines; take the first .exe on Windows
    const lines = result.trim().split(/\r?\n/);
    const exe = isWindows ? lines.find(l => l.endsWith('.exe')) || lines[0] : lines[0];
    return exe.trim();
  } catch (_) {
    return isWindows ? 'claude.exe' : 'claude';
  }
}

const CLAUDE_CMD = resolveClaude();
const CLAUDE_ARGS = process.env.CLAUDE_ARGS ? process.env.CLAUDE_ARGS.split(' ') : [];
console.log(`[webcc] Using claude: ${CLAUDE_CMD}`);

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
  const data = [...persistedSessions.values()].map(({ id, cwd, createdAt }) => ({ id, cwd, createdAt }));
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[webcc] Failed to save sessions.json:', e.message);
  }
}

const persistedSessions = loadPersistedSessions();

// ── Session management ──
// { id, ptyProcess, buffer: string[], clients: Set<ws>, createdAt, lastActivity, cwd }
const sessions = new Map();

function generateId() {
  let id = '';
  while (id.length < 8) id += Math.random().toString(36).slice(2);
  return id.slice(0, 8);
}

function createSession(id, cwd) {
  cwd = cwd || os.homedir();
  const ptyProcess = pty.spawn(CLAUDE_CMD, CLAUDE_ARGS, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });

  const persisted = persistedSessions.get(id);
  const session = {
    id,
    ptyProcess,
    buffer: [],
    clients: new Set(),
    createdAt: persisted ? new Date(persisted.createdAt) : new Date(),
    lastActivity: new Date(),
    cwd,
  };

  // Save to persistence
  persistedSessions.set(id, { id, cwd, createdAt: session.createdAt });
  savePersistedSessions();

  ptyProcess.onData((data) => {
    session.buffer.push(data);
    if (session.buffer.length > 500) session.buffer.shift();
    session.lastActivity = new Date();
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'output', data }));
      }
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`[webcc] Session ${id} exited (code ${exitCode})`);
    const exitMsg = `\r\n\x1b[33m[Claude Code process exited (code ${exitCode})]\x1b[0m\r\n`;
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'exit', data: exitMsg }));
      }
    }
    sessions.delete(id);
    // Keep in persistedSessions so it can be restored on reconnect
  });

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

app.delete('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session && !persistedSessions.has(req.params.id)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (session) {
    try { session.ptyProcess.kill(); } catch (_) {}
    sessions.delete(req.params.id);
  }
  persistedSessions.delete(req.params.id);
  savePersistedSessions();
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ── WebSocket connections ──
wss.on('connection', (ws, req) => {
  const urlObj = new URL(req.url, 'http://localhost');
  let sessionId = urlObj.searchParams.get('id') || '';
  let session;

  if (sessionId && sessions.has(sessionId)) {
    session = sessions.get(sessionId);
    console.log(`[webcc] Client attached to session ${sessionId} (${session.clients.size + 1} total)`);
  } else {
    if (!sessionId) sessionId = generateId();
    const persisted = persistedSessions.get(sessionId);
    const cwd = persisted ? persisted.cwd : os.homedir();
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

  // Tell client its session ID
  ws.send(JSON.stringify({ type: 'session_id', id: sessionId }));

  // Replay buffered output to reconnecting client
  if (session.buffer.length > 0) {
    ws.send(JSON.stringify({ type: 'output', data: session.buffer.join('') }));
  }

  // WebSocket messages → PTY input / resize
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input') {
        session.ptyProcess.write(msg.data);
        session.lastActivity = new Date();
      } else if (msg.type === 'resize') {
        session.ptyProcess.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
      } else if (msg.type === 'upload') {
        const { tempId, name, mime, data } = msg;
        const ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 8);
        const safeName = `webcc_${Date.now()}.${ext}`;
        const tmpPath = path.join(os.tmpdir(), safeName);
        fs.writeFileSync(tmpPath, Buffer.from(data, 'base64'));
        console.log(`[webcc] Saved upload: ${tmpPath}`);
        ws.send(JSON.stringify({ type: 'file_saved', tempId, path: tmpPath, name }));
      }
    } catch (e) {
      console.error('[webcc] Bad message:', e.message);
    }
  });

  ws.on('close', () => {
    session.clients.delete(ws);
    console.log(`[webcc] Client left session ${sessionId} (${session.clients.size} remaining)`);
  });

  ws.on('error', (err) => {
    console.error('[webcc] WebSocket error:', err.message);
    session.clients.delete(ws);
  });
});

server.listen(PORT, () => {
  const proto = useHttps ? 'https' : 'http';
  console.log(`\n  WebCC is running at ${proto}://localhost:${PORT}\n`);
  console.log(`  Sessions persist until manually closed or server restarts.\n`);
  console.log(`  Manage sessions at ${proto}://localhost:${PORT}/manage\n`);
  if (useHttps) {
    console.log(`  Note: First visit will show a security warning (self-signed cert).\n`);
    console.log(`  Click "Advanced" → "Proceed to localhost" to continue.\n`);
  }
});
