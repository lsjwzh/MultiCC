'use strict';

/**
 * WeChat iLink Bridge for WebCC
 *
 * Directly connects to Tencent's official iLink Bot API (ilinkai.weixin.qq.com)
 * to relay messages between WeChat and WebCC Claude Code sessions.
 *
 * No external MCP server required — pure HTTP long-polling.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const router = express.Router();

// ── Config ──
const CONFIG_FILE = path.join(__dirname, 'wechat-config.json');
const ILINK_LOGIN_URL = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '1.0.2';

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {
    return { defaultSession: '', outputIdle: 5000, botToken: '', baseUrl: '' };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ── State ──
let _sessions = null;          // server.js sessions Map
let _persistedSessions = null;
let _tmuxWriteInput = null;    // server.js tmuxWriteInput function
let _config = loadConfig();
let _client = null;            // ILinkClient instance
let _running = false;
let _pollAbort = null;         // AbortController for current long-poll

// Per-user context_token cache: from_user_id → { contextToken, userId }
const _contextTokens = new Map();
// Per-user session binding: from_user_id → sessionId
const _routeMap = new Map();

// Output buffering (session output → WeChat)
let _outputBufs = new Map();   // sessionId → { buf, timer, userId }
const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z~]|\][^\x07]*(?:\x07|\x1b\\)|[()][AB012]|.)/g;

// Echo suppression
const _sentHashes = new Map(); // hash → expiry timestamp
const ECHO_TTL = 60000;

// Message log
let _messageLog = [];
const MAX_LOG = 300;
const _sseClients = new Set();

// Login state
let _loginQrcode = null;       // current QR code ID (for polling)
let _loginQrImg = null;        // base64 image data
let _loginTime = null;         // when bot_token was obtained

// ── ILinkClient ──

class ILinkClient {
  constructor(botToken, baseUrl) {
    this.botToken = botToken;
    this.baseUrl = baseUrl || ILINK_LOGIN_URL;
    this.cursor = '';
  }

  _makeHeaders() {
    // Random uint32 → decimal string → base64
    const uin = crypto.randomBytes(4).readUInt32BE(0).toString();
    const uinB64 = Buffer.from(uin).toString('base64');
    return {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Authorization': `Bearer ${this.botToken}`,
      'X-WECHAT-UIN': uinB64,
    };
  }

  // ── Login ──

  static async getQRCode() {
    const res = await fetch(`${ILINK_LOGIN_URL}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`QR code request failed: ${res.status}`);
    return res.json();
    // Expected: { qrcode: "...", qrcode_img_content: "base64..." }
  }

  static async pollLoginStatus(qrcode) {
    const res = await fetch(`${ILINK_LOGIN_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
      signal: AbortSignal.timeout(40000),
    });
    if (!res.ok) throw new Error(`Login poll failed: ${res.status}`);
    return res.json();
    // On success: { status: "confirmed", bot_token: "...", baseurl: "..." }
  }

  // ── Messages ──

  async getUpdates(abortSignal) {
    const res = await fetch(`${this.baseUrl}/ilink/bot/getupdates`, {
      method: 'POST',
      headers: this._makeHeaders(),
      body: JSON.stringify({
        get_updates_buf: this.cursor,
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      signal: abortSignal || AbortSignal.timeout(45000), // 35s server hold + margin
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`getUpdates ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    if (data.get_updates_buf) this.cursor = data.get_updates_buf;
    return { msgs: data.msgs || [], cursor: data.get_updates_buf || '' };
  }

  async sendMessage(toUserId, text, contextToken) {
    const clientId = `webcc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: [
          { type: 1, text_item: { text } },
        ],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    };
    const res = await fetch(`${this.baseUrl}/ilink/bot/sendmessage`, {
      method: 'POST',
      headers: this._makeHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`sendMessage ${res.status}: ${errText.slice(0, 200)}`);
    }
    return res.json();
  }

  async sendTyping(contextToken) {
    try {
      await fetch(`${this.baseUrl}/ilink/bot/sendtyping`, {
        method: 'POST',
        headers: this._makeHeaders(),
        body: JSON.stringify({
          context_token: contextToken,
          base_info: { channel_version: CHANNEL_VERSION },
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (_) { /* best-effort */ }
  }

  get isLoggedIn() {
    return !!this.botToken;
  }
}

// ── Echo Suppression ──

function _hashText(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function _addEchoHash(text) {
  const hash = _hashText(text);
  if (hash) _sentHashes.set(hash, Date.now() + ECHO_TTL);
}

function _isEcho(text) {
  const hash = _hashText(text);
  if (!hash) return true; // empty
  const now = Date.now();
  // Clean expired
  for (const [k, v] of _sentHashes) {
    if (v < now) _sentHashes.delete(k);
  }
  // Check both directions (substring match)
  for (const [k] of _sentHashes) {
    if (k.includes(hash) || hash.includes(k)) return true;
  }
  return false;
}

// ── Message Extraction ──

function _extractText(msg) {
  if (!msg || !msg.item_list) return '';
  for (const item of msg.item_list) {
    if (item.type === 1 && item.text_item) return item.text_item.text || '';
  }
  return '';
}

// ── Logging ──

function _log(type, text) {
  const entry = { type, text, ts: new Date().toISOString() };
  _messageLog.push(entry);
  if (_messageLog.length > MAX_LOG) _messageLog = _messageLog.slice(-MAX_LOG);
  // Push to SSE clients
  const data = JSON.stringify(entry);
  for (const res of _sseClients) {
    try { res.write(`data: ${data}\n\n`); } catch (_) { _sseClients.delete(res); }
  }
}

// ── Session Write (fixed: uses tmuxWriteInput) ──

function _writeToSession(sessionId, text) {
  if (!_sessions || !_tmuxWriteInput) {
    _log('error', 'Bridge not initialized');
    return;
  }
  const session = _sessions.get(sessionId);
  if (!session) {
    _log('error', `Session "${sessionId}" not found`);
    return;
  }
  try {
    _tmuxWriteInput(sessionId, text + '\r');
    session.lastActivity = new Date();
    _log('in', `[→ ${sessionId}] ${text}`);
  } catch (e) {
    _log('error', `Write to session failed: ${e.message}`);
  }
}

// ── Session Output → WeChat ──

function _stripAnsi(str) {
  return str.replace(ANSI_RE, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function onSessionOutput(sessionId, data) {
  if (!_running || !_client) return;

  // Find which WeChat user is bound to this session
  let targetUserId = null;
  for (const [userId, sid] of _routeMap) {
    if (sid === sessionId) { targetUserId = userId; break; }
  }
  // Also check if it's the default session
  if (!targetUserId && sessionId === _config.defaultSession) {
    // Send to the most recently active user
    if (_contextTokens.size > 0) {
      targetUserId = [..._contextTokens.keys()][_contextTokens.size - 1];
    }
  }
  if (!targetUserId) return;

  const text = _stripAnsi(data).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.trim()) return;

  // Buffer output with debounce
  let buf = _outputBufs.get(sessionId);
  if (!buf) {
    buf = { text: '', timer: null, userId: targetUserId };
    _outputBufs.set(sessionId, buf);
  }
  buf.text += text;
  buf.userId = targetUserId;

  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => _flushOutput(sessionId), _config.outputIdle || 5000);
}

async function _flushOutput(sessionId) {
  const buf = _outputBufs.get(sessionId);
  if (!buf || !buf.text.trim()) { _outputBufs.delete(sessionId); return; }

  const text = buf.text;
  const userId = buf.userId;
  _outputBufs.delete(sessionId);

  // Split into chunks ≤ 3800 chars at newline boundaries
  const chunks = [];
  let remaining = text;
  while (remaining.length > 3800) {
    let cut = remaining.lastIndexOf('\n', 3800);
    if (cut <= 0) cut = 3800;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.trim()) chunks.push(remaining);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = i === 0 ? chunks[i] : `(续${i + 1}) ${chunks[i]}`;
    await _sendToWeChat(userId, chunk);
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
  }
}

async function _sendToWeChat(userId, text) {
  const ctx = _contextTokens.get(userId);
  if (!ctx) {
    _log('error', `No context_token for user ${userId.slice(0, 20)}..., cannot reply`);
    return;
  }
  try {
    _addEchoHash(text);
    await _client.sendMessage(userId, text, ctx.contextToken);
    _log('out', text.length > 200 ? text.slice(0, 200) + '...' : text);
  } catch (e) {
    _log('error', `Send to WeChat failed: ${e.message}`);
  }
}

// ── Command System ──

async function _handleCommand(text, msg) {
  const userId = msg.from_user_id;
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  let reply = '';
  switch (cmd) {
    case '/help':
      reply = [
        '📋 可用命令:',
        '/status — 查看桥接状态',
        '/sessions — 列出所有 WebCC 会话',
        '/bind <id> — 绑定到指定会话',
        '/unbind — 解除绑定（回到默认会话）',
        '/send <id> <text> — 向指定会话发送一条命令',
        '/help — 显示此帮助',
      ].join('\n');
      break;

    case '/status': {
      const boundSession = _routeMap.get(userId) || _config.defaultSession || '(none)';
      const uptime = _loginTime ? Math.floor((Date.now() - _loginTime) / 60000) + ' min' : 'N/A';
      reply = [
        `🔗 状态: ${_running ? '运行中' : '已停止'}`,
        `📱 登录: ${_client?.isLoggedIn ? '已登录' : '未登录'} (${uptime})`,
        `📌 当前会话: ${boundSession}`,
        `👥 活跃连接: ${_contextTokens.size} 用户`,
      ].join('\n');
      break;
    }

    case '/sessions': {
      if (!_persistedSessions || _persistedSessions.size === 0) {
        reply = '没有活跃的 WebCC 会话';
        break;
      }
      const lines = ['📂 WebCC 会话:'];
      for (const [id, p] of _persistedSessions) {
        const active = _sessions && _sessions.has(id);
        const bound = _routeMap.get(userId) === id ? ' ← 当前' : '';
        lines.push(`  ${active ? '🟢' : '⚫'} ${id} — ${p.cwd || '?'}${bound}`);
      }
      reply = lines.join('\n');
      break;
    }

    case '/bind': {
      const targetId = parts[1];
      if (!targetId) { reply = '用法: /bind <session-id>'; break; }
      if (!_persistedSessions || !_persistedSessions.has(targetId)) {
        reply = `会话 "${targetId}" 不存在。使用 /sessions 查看可用会话。`;
        break;
      }
      _routeMap.set(userId, targetId);
      reply = `✅ 已绑定到会话: ${targetId}`;
      _log('system', `User bound to session ${targetId}`);
      break;
    }

    case '/unbind':
      _routeMap.delete(userId);
      reply = `✅ 已解除绑定，消息将发送到默认会话: ${_config.defaultSession || '(none)'}`;
      break;

    case '/send': {
      const targetId = parts[1];
      const message = parts.slice(2).join(' ');
      if (!targetId || !message) { reply = '用法: /send <session-id> <text>'; break; }
      if (!_sessions || !_sessions.has(targetId)) {
        reply = `会话 "${targetId}" 不活跃`;
        break;
      }
      _writeToSession(targetId, message);
      reply = `✅ 已发送到 ${targetId}`;
      break;
    }

    default:
      reply = `未知命令: ${cmd}，输入 /help 查看帮助`;
  }

  if (reply) {
    await _sendToWeChat(userId, reply);
  }
}

// ── Poll Loop ──

async function _pollLoop() {
  while (_running && _client) {
    try {
      _pollAbort = new AbortController();
      const result = await _client.getUpdates(_pollAbort.signal);

      for (const msg of result.msgs) {
        const userId = msg.from_user_id;
        const text = _extractText(msg);

        // Cache context_token
        if (msg.context_token) {
          _contextTokens.set(userId, { contextToken: msg.context_token, userId });
        }

        if (!text.trim()) continue;
        if (_isEcho(text)) continue;

        _log('in', `[WeChat] ${text.length > 200 ? text.slice(0, 200) + '...' : text}`);

        // Command handling
        if (text.startsWith('/')) {
          await _handleCommand(text, msg);
          continue;
        }

        // Route to session
        const sessionId = _routeMap.get(userId) || _config.defaultSession;
        if (!sessionId) {
          await _sendToWeChat(userId, '⚠ 未绑定会话。使用 /sessions 查看可用会话，/bind <id> 绑定。');
          continue;
        }

        // Send typing indicator
        if (msg.context_token) {
          _client.sendTyping(msg.context_token).catch(() => {});
        }

        _writeToSession(sessionId, text);
      }
    } catch (e) {
      if (e.name === 'AbortError') continue; // expected on stop
      _log('error', `Poll error: ${e.message}`);
      // Brief pause before retrying
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ── Public API ──

async function startBridge() {
  if (_running) throw new Error('Bridge is already running');
  if (!_config.botToken) throw new Error('Not logged in. Please scan QR code first.');
  if (!_config.defaultSession) throw new Error('No default session configured');

  _client = new ILinkClient(_config.botToken, _config.baseUrl);
  _running = true;
  _log('system', `Bridge started (session: ${_config.defaultSession})`);
  _pollLoop(); // fire-and-forget
}

function stopBridge() {
  _running = false;
  if (_pollAbort) { _pollAbort.abort(); _pollAbort = null; }
  // Flush all pending output
  for (const [sid] of _outputBufs) {
    const buf = _outputBufs.get(sid);
    if (buf && buf.timer) clearTimeout(buf.timer);
  }
  _outputBufs.clear();
  _client = null;
  _log('system', 'Bridge stopped');
}

function init(sessionsMap, persistedSessionsMap, tmuxWriteInputFn) {
  _sessions = sessionsMap;
  _persistedSessions = persistedSessionsMap;
  _tmuxWriteInput = tmuxWriteInputFn;
}

// ── REST API Routes ──

// Get QR code for login
router.get('/qrcode', async (req, res) => {
  try {
    const data = await ILinkClient.getQRCode();
    _loginQrcode = data.qrcode;
    _loginQrImg = data.qrcode_img_content || null;
    res.json({ qrcode: data.qrcode, image: _loginQrImg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Poll login status
router.get('/login-status', async (req, res) => {
  if (!_loginQrcode) return res.json({ status: 'no_qrcode' });
  try {
    const data = await ILinkClient.pollLoginStatus(_loginQrcode);
    if (data.status === 'confirmed' && data.bot_token) {
      _config.botToken = data.bot_token;
      _config.baseUrl = data.baseurl || ILINK_LOGIN_URL;
      _loginTime = Date.now();
      saveConfig(_config);
      _loginQrcode = null;
      _loginQrImg = null;
      _log('system', 'WeChat login successful');
      res.json({ status: 'confirmed' });
    } else {
      res.json({ status: data.status || 'waiting' });
    }
  } catch (e) {
    res.json({ status: 'error', error: e.message });
  }
});

// Bridge status
router.get('/status', (req, res) => {
  res.json({
    running: _running,
    loggedIn: !!_config.botToken,
    defaultSession: _config.defaultSession,
    loginTime: _loginTime ? new Date(_loginTime).toISOString() : null,
    activeUsers: _contextTokens.size,
    bindings: Object.fromEntries(_routeMap),
  });
});

// Config
router.get('/config', (req, res) => {
  res.json({
    defaultSession: _config.defaultSession || '',
    outputIdle: _config.outputIdle || 5000,
    loggedIn: !!_config.botToken,
  });
});

router.post('/config', (req, res) => {
  const { defaultSession, outputIdle } = req.body;
  if (defaultSession !== undefined) _config.defaultSession = defaultSession;
  if (outputIdle !== undefined) _config.outputIdle = Number(outputIdle) || 5000;
  saveConfig(_config);
  res.json({ ok: true });
});

// Start / Stop
router.post('/start', async (req, res) => {
  try {
    if (req.body.defaultSession) _config.defaultSession = req.body.defaultSession;
    if (req.body.outputIdle) _config.outputIdle = Number(req.body.outputIdle) || 5000;
    saveConfig(_config);
    await startBridge();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/stop', (req, res) => {
  stopBridge();
  res.json({ ok: true });
});

// Manual send
router.post('/send', async (req, res) => {
  const { text, target, sessionId } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  if (target === 'wechat') {
    // Find a user to send to (first available)
    const userId = [..._contextTokens.keys()][0];
    if (!userId) return res.status(400).json({ error: 'No WeChat user available' });
    await _sendToWeChat(userId, text);
  } else {
    const sid = sessionId || _config.defaultSession;
    if (!sid) return res.status(400).json({ error: 'No session specified' });
    _writeToSession(sid, text);
  }
  res.json({ ok: true });
});

// Message log
router.get('/log', (req, res) => {
  const since = req.query.since ? Number(req.query.since) : 0;
  const filtered = since ? _messageLog.filter(e => new Date(e.ts).getTime() > since) : _messageLog;
  res.json(filtered);
});

// SSE events
router.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  _sseClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) { /* */ }
  }, 5000);

  req.on('close', () => {
    clearInterval(heartbeat);
    _sseClients.delete(res);
  });
});

// Logout (clear token)
router.post('/logout', (req, res) => {
  if (_running) stopBridge();
  _config.botToken = '';
  _config.baseUrl = '';
  _loginTime = null;
  saveConfig(_config);
  _contextTokens.clear();
  _routeMap.clear();
  _log('system', 'Logged out');
  res.json({ ok: true });
});

module.exports = { router, init, onSessionOutput, loadConfig, startBridge, stopBridge };
