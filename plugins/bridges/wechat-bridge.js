'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { bridgeConfigFile, saveBridgeConfig } = require('./secure-config');

const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z~]|\][^\x07]*(?:\x07|\x1b\\)|[()][AB012]|.)/g;
function stripAnsi(str) {
  return str.replace(ANSI_RE, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

// ── Minimal MCP Streamable-HTTP Client ──

class McpClient {
  constructor(url) {
    this.url = url;
    this.sessionId = null;
    this._id = 0;
  }

  async request(method, params) {
    const body = { jsonrpc: '2.0', id: ++this._id, method, params: params || {} };
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      clearTimeout(timeout);
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;

      const ct = (res.headers.get('content-type') || '');
      if (ct.includes('text/event-stream')) {
        const text = await res.text();
        for (const line of text.split('\n')) {
          if (line.startsWith('data: ')) {
            try { return JSON.parse(line.slice(6)); } catch (_) {}
          }
        }
        return null;
      }
      return res.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async notify(method, params) {
    const body = { jsonrpc: '2.0', method };
    if (params) body.params = params;
    const headers = { 'Content-Type': 'application/json' };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    try { await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body) }); } catch (_) {}
  }

  async initialize() {
    const res = await this.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'multicc-wechat-bridge', version: '1.0.0' },
    });
    await this.notify('notifications/initialized');
    return res;
  }

  async callTool(name, args) {
    const res = await this.request('tools/call', { name, arguments: args });
    if (res?.result?.content) {
      const tc = res.result.content.find(c => c.type === 'text');
      return tc?.text || '';
    }
    if (res?.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return '';
  }
}

// ── WeChat Bridge ──

const CONFIG_FILE = bridgeConfigFile('wechat-config.json', path.join(__dirname, 'wechat-config.json'));

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {}
  return { mcpUrl: 'http://localhost:8000/mcp', chatName: '', sessionId: '', pollInterval: 3000, outputIdle: 5000 };
}

function saveConfig(cfg) {
  try { saveBridgeConfig(CONFIG_FILE, cfg); } catch (_) {}
}

// Bridge state (module-level singleton)
let _sessions = null;         // reference to server's sessions Map
let _persistedSessions = null;

let _config = loadConfig();
let _mcp = null;              // McpClient instance
let _running = false;
let _pollTimer = null;
let _lastSnapshot = '';
let _sentHashes = new Map();  // hash -> expiry timestamp
let _outputBuf = '';
let _outputTimer = null;
let _messageLog = [];
const MAX_LOG = 300;
let _sseClients = new Set();

function _log(type, text) {
  const entry = { type, text: String(text).slice(0, 2000), ts: new Date().toISOString() };
  _messageLog.push(entry);
  if (_messageLog.length > MAX_LOG) _messageLog = _messageLog.slice(-MAX_LOG);
  for (const res of _sseClients) {
    try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch (_) { _sseClients.delete(res); }
  }
  console.log(`[multicc/wechat] [${type}] ${String(text).slice(0, 200)}`);
}

function _hashMsg(text) {
  // Simple hash for echo detection
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function _isEcho(line) {
  const now = Date.now();
  const h = _hashMsg(line);
  for (const [hash, expiry] of _sentHashes) {
    if (now > expiry) { _sentHashes.delete(hash); continue; }
    if (h.includes(hash) || hash.includes(h)) return true;
  }
  return false;
}

// ── Polling ──

async function _pollOnce() {
  try {
    const text = await _mcp.callTool('fetch_messages_by_chat', { chat_name: _config.chatName });
    if (!text) return;

    if (!_lastSnapshot) {
      _lastSnapshot = text;
      _log('system', `消息基线已获取 (${text.length} 字符)`);
      return;
    }

    if (text === _lastSnapshot) return;

    // Diff: find new content
    let newPart = '';
    if (text.startsWith(_lastSnapshot)) {
      newPart = text.slice(_lastSnapshot.length);
    } else {
      // Line-based diff
      const prevSet = new Set(_lastSnapshot.split('\n').map(l => l.trim()).filter(Boolean));
      const currLines = text.split('\n').map(l => l.trim()).filter(Boolean);
      newPart = currLines.filter(l => !prevSet.has(l)).join('\n');
    }
    _lastSnapshot = text;

    if (!newPart.trim()) return;

    const lines = newPart.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (_isEcho(line)) continue;
      _log('in', line);
      _handleIncoming(line);
    }
  } catch (err) {
    _log('error', `轮询出错: ${err.message}`);
  }
}

function _startPoll() {
  if (!_running) return;
  _pollOnce().finally(() => {
    if (_running) _pollTimer = setTimeout(_startPoll, _config.pollInterval || 3000);
  });
}

// ── Incoming message handling ──

function _handleIncoming(msg) {
  // Special commands
  if (msg.startsWith('/')) {
    _handleCommand(msg);
    return;
  }

  // Forward to PTY
  const session = _sessions?.get(_config.sessionId);
  if (!session) {
    _log('error', `会话 "${_config.sessionId}" 不存在或未激活`);
    return;
  }
  session.ptyProcess.write(msg + '\r');
  session.lastActivity = new Date();
}

async function _handleCommand(cmd) {
  const parts = cmd.split(/\s+/);
  const verb = parts[0].toLowerCase();
  let reply = '';

  switch (verb) {
    case '/status':
      reply = `桥接状态: ${_running ? '运行中' : '已停止'}\n会话: ${_config.sessionId}\n聊天: ${_config.chatName}`;
      break;
    case '/sessions': {
      if (!_sessions) { reply = '无会话数据'; break; }
      const list = [...(_persistedSessions || new Map()).values()];
      reply = list.length === 0 ? '无活跃会话'
        : list.map(s => `${s.id} — ${s.cwd}`).join('\n');
      break;
    }
    case '/bind': {
      const id = parts[1];
      if (!id) { reply = '用法: /bind <session_id>'; break; }
      _config.sessionId = id;
      saveConfig(_config);
      reply = `已绑定会话: ${id}`;
      _log('system', reply);
      break;
    }
    case '/help':
      reply = '可用命令:\n/status — 查看桥接状态\n/sessions — 列出所有会话\n/bind <id> — 绑定到指定会话\n/help — 显示帮助';
      break;
    default:
      reply = `未知命令: ${verb}\n输入 /help 查看帮助`;
  }

  if (reply) {
    try { await _sendToWeChat(reply); } catch (e) { _log('error', `命令回复发送失败: ${e.message}`); }
  }
}

// ── PTY output → WeChat ──

function onSessionOutput(sessionId, data) {
  if (!_running || sessionId !== _config.sessionId) return;

  const stripped = stripAnsi(data).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!stripped.trim()) return;

  _outputBuf += stripped;
  if (_outputTimer) clearTimeout(_outputTimer);
  _outputTimer = setTimeout(_flushOutput, _config.outputIdle || 5000);
}

async function _flushOutput() {
  const text = _outputBuf.trim();
  _outputBuf = '';
  if (!text || !_running) return;

  // Chunk if too long
  const MAX_LEN = 3800;
  const chunks = [];
  let remaining = text;
  while (remaining.length > MAX_LEN) {
    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitAt < MAX_LEN * 0.5) splitAt = MAX_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }
  if (remaining) chunks.push(remaining);

  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : '';
    try {
      await _sendToWeChat(prefix + chunks[i]);
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      _log('error', `发送回复失败: ${err.message}`);
      break;
    }
  }
}

async function _sendToWeChat(text) {
  // Track for echo filtering (expire after 60s)
  const hash = _hashMsg(text);
  _sentHashes.set(hash, Date.now() + 60000);

  await _mcp.callTool('reply_to_messages_by_chat', {
    chat_identifier: _config.chatName,
    message: text,
  });
  _log('out', text);
}

// ── Public API ──

async function startBridge(config) {
  if (_running) await stopBridge();

  if (config) {
    Object.assign(_config, config);
    saveConfig(_config);
  }

  if (!_config.mcpUrl) throw new Error('WeChat-MCP URL 未配置');
  if (!_config.chatName) throw new Error('聊天对象未配置');
  if (!_config.sessionId) throw new Error('绑定会话未配置');

  _mcp = new McpClient(_config.mcpUrl);
  _lastSnapshot = '';
  _sentHashes.clear();
  _outputBuf = '';

  try {
    await _mcp.initialize();
    _log('system', `已连接 WeChat-MCP: ${_config.mcpUrl}`);
  } catch (err) {
    _log('error', `连接 WeChat-MCP 失败: ${err.message}`);
    throw err;
  }

  _log('system', `监听聊天: "${_config.chatName}", 绑定会话: ${_config.sessionId}`);
  _running = true;
  _startPoll();
}

async function stopBridge() {
  _running = false;
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
  if (_outputTimer) { clearTimeout(_outputTimer); _outputTimer = null; }
  _mcp = null;
  _log('system', '桥接已停止');
}

// ── Express Router ──

const router = express.Router();
router.use(express.json());

router.get('/status', (req, res) => {
  res.json({
    running: _running,
    mcpUrl: _config.mcpUrl || '',
    chatName: _config.chatName || '',
    sessionId: _config.sessionId || '',
  });
});

router.get('/config', (req, res) => {
  res.json(_config);
});

router.post('/config', (req, res) => {
  const allowed = ['mcpUrl', 'chatName', 'sessionId', 'pollInterval', 'outputIdle'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) _config[key] = req.body[key];
  }
  saveConfig(_config);
  res.json({ ok: true, config: _config });
});

router.post('/start', async (req, res) => {
  try {
    await startBridge(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/stop', async (req, res) => {
  await stopBridge();
  res.json({ ok: true });
});

router.post('/send', async (req, res) => {
  const { text, target } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  if (target === 'pty') {
    // Send to PTY
    const session = _sessions?.get(_config.sessionId);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    session.ptyProcess.write(text + '\r');
    _log('in', `[手动] ${text}`);
  } else {
    // Send to WeChat
    if (!_running) return res.status(400).json({ error: '桥接未运行' });
    try {
      await _sendToWeChat(text);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  res.json({ ok: true });
});

router.get('/log', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const filtered = since ? _messageLog.filter(e => new Date(e.ts).getTime() > since) : _messageLog;
  res.json(filtered);
});

router.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  if (res.socket) res.socket.setNoDelay(true);

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) { cleanup(); }
  }, 5000);

  _sseClients.add(res);

  function cleanup() {
    clearInterval(heartbeat);
    _sseClients.delete(res);
  }
  req.on('close', cleanup);
});

// ── Module init ──

function init(sessionsMap, persistedSessionsMap) {
  _sessions = sessionsMap;
  _persistedSessions = persistedSessionsMap;
  console.log('[multicc/wechat] Bridge module initialized');
}

module.exports = { router, init, onSessionOutput, loadConfig, startBridge, stopBridge };
