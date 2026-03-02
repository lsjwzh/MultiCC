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
const pty = require('node-pty');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

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

function resolveCwd(current, arg) {
  if (!arg || arg === '~') return os.homedir();
  if (arg.startsWith('~/') || arg.startsWith('~\\')) return path.join(os.homedir(), arg.slice(2));
  return path.resolve(current, arg);
}

function createSession(id, cwd) {
  // Fall back to homedir if the persisted cwd no longer exists (e.g. Windows paths on macOS)
  if (!cwd || !fs.existsSync(cwd)) {
    if (cwd) console.warn(`[webcc] cwd "${cwd}" not found, falling back to home dir`);
    cwd = os.homedir();
  }
  console.log(`[webcc] Spawning: ${CLAUDE_CMD} ${CLAUDE_ARGS.join(' ')} in ${cwd}`);
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
    // Guard against stale exits (e.g. after relocate killed the old PTY)
    if (sessions.get(id) !== session) return;
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
    try { session.ptyProcess.kill(); } catch (_) {}
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
    try { oldSession.ptyProcess.kill(); } catch (_) {}
  }

  // Persist new cwd
  const p = persistedSessions.get(id);
  if (p) {
    p.cwd = resolvedCwd;
  } else {
    persistedSessions.set(id, { id, cwd: resolvedCwd, createdAt: new Date() });
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
  let inputBuf = '';
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
