'use strict';

/**
 * WeChat iLink Bridge for MultiCC — Gateway model.
 *
 * The bridge talks to one designated "gateway" chat session (kind='chat',
 * type='gateway', singleton). All incoming WeChat messages are submitted as
 * user_messages to that chat session; every assistant turn is forwarded back
 * to WeChat. There is no per-user routing or multi-session dispatch.
 *
 * Implementation: the bridge connects to /ws/chat?session=__gateway__ as an
 * ordinary WebSocket client on 127.0.0.1, reusing the chat machinery instead
 * of re-implementing it.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const router = express.Router();

const CONFIG_FILE = path.join(__dirname, 'wechat-config.json');
const ILINK_LOGIN_URL = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '1.0.2';

const GATEWAY_SESSION_ID = '__gateway__';
const GATEWAY_CWD = path.join(require('os').homedir(), '.multicc', 'gateway');

// ── Config ──

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {
    return { outputIdle: 5000, botToken: '', baseUrl: '' };
  }
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }

// ── Injected deps ──
let _persistedSessions = null;
let _chatSessions = null;
let _savePersistedSessions = null;
let _chatBroadcast = null;
let _port = 3000;

let _config = loadConfig();
let _client = null;            // ILinkClient
let _running = false;
let _pollAbort = null;

// Most recent WeChat user (we only support one user, but cache their id+token).
let _currentUserId = null;
let _currentContextToken = null;

// Internal chat WS connection (bridge ↔ chat session)
let _chatWs = null;
let _chatWsReconnectTimer = null;
let _currentAssistantText = '';
let _outputTimer = null;       // post-turn flush debounce
let _turnInProgress = false;

// Session context surfaced to the Gateway prompt. We do not auto-dispatch
// WeChat messages to other sessions here; Gateway owns that decision in-chat.
const _sessionMemory = new Map();

// Echo suppression
const _sentHashes = new Map();
const ECHO_TTL = 60000;

// Log buffer (UI surfaces it via /events SSE + /log polling)
let _messageLog = [];
const MAX_LOG = 300;
const _sseClients = new Set();

let _loginQrcode = null;
let _loginQrImg = null;
let _loginTime = null;

// ── ILink HTTP client ──

class ILinkClient {
  constructor(botToken, baseUrl) {
    this.botToken = botToken;
    this.baseUrl = baseUrl || ILINK_LOGIN_URL;
    this.cursor = '';
  }

  _makeHeaders() {
    const uin = crypto.randomBytes(4).readUInt32BE(0).toString();
    const uinB64 = Buffer.from(uin).toString('base64');
    return {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Authorization': `Bearer ${this.botToken}`,
      'X-WECHAT-UIN': uinB64,
    };
  }

  static async getQRCode() {
    const res = await fetch(`${ILINK_LOGIN_URL}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`QR code request failed: ${res.status}`);
    return res.json();
  }

  static async pollLoginStatus(qrcode) {
    const res = await fetch(`${ILINK_LOGIN_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
      signal: AbortSignal.timeout(40000),
    });
    if (!res.ok) throw new Error(`Login poll failed: ${res.status}`);
    return res.json();
  }

  async getUpdates(abortSignal) {
    const res = await fetch(`${this.baseUrl}/ilink/bot/getupdates`, {
      method: 'POST',
      headers: this._makeHeaders(),
      body: JSON.stringify({
        get_updates_buf: this.cursor,
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      signal: abortSignal || AbortSignal.timeout(45000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`getUpdates ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    if (data.get_updates_buf) this.cursor = data.get_updates_buf;
    return { msgs: data.msgs || [] };
  }

  async sendMessage(toUserId, text, contextToken) {
    const clientId = `multicc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const body = {
      msg: {
        from_user_id: '', to_user_id: toUserId, client_id: clientId,
        message_type: 2, message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    };
    const res = await fetch(`${this.baseUrl}/ilink/bot/sendmessage`, {
      method: 'POST', headers: this._makeHeaders(), body: JSON.stringify(body),
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
        method: 'POST', headers: this._makeHeaders(),
        body: JSON.stringify({ context_token: contextToken, base_info: { channel_version: CHANNEL_VERSION } }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (_) { /* best-effort */ }
  }

  get isLoggedIn() { return !!this.botToken; }
}

// ── Echo suppression ──

function _hashText(t) { return t.replace(/\s+/g, ' ').trim().slice(0, 200); }
function _addEchoHash(t) { const h = _hashText(t); if (h) _sentHashes.set(h, Date.now() + ECHO_TTL); }
function _isEcho(t) {
  const h = _hashText(t);
  if (!h) return true;
  const now = Date.now();
  for (const [k, v] of _sentHashes) if (v < now) _sentHashes.delete(k);
  for (const [k] of _sentHashes) if (k.includes(h) || h.includes(k)) return true;
  return false;
}

// ── Logging ──

function _log(type, text) {
  const entry = { type, text, ts: new Date().toISOString() };
  _messageLog.push(entry);
  if (_messageLog.length > MAX_LOG) _messageLog = _messageLog.slice(-MAX_LOG);
  const data = JSON.stringify(entry);
  for (const res of _sseClients) {
    try { res.write(`data: ${data}\n\n`); } catch (_) { _sseClients.delete(res); }
  }
}

function _extractText(msg) {
  if (!msg || !msg.item_list) return '';
  for (const item of msg.item_list) {
    if (item.type === 1 && item.text_item) return item.text_item.text || '';
  }
  return '';
}

// ── Gateway prompt context ──

function _sessionCwd(p) {
  return p?.worktreePath || p?.cwd || '';
}

function _sessionTitle(p) {
  return p?.label || p?.id || '';
}

function _aliasTokens(p, prev) {
  const raw = [
    p?.id,
    p?.label,
    p?.cli,
    p?.kind,
    _sessionCwd(p).split(/[\\/]/).filter(Boolean).slice(-2).join(' '),
    ...(prev?.aliases || []),
  ].filter(Boolean).join(' ');
  const tokens = new Set();
  for (const part of raw.split(/[\s,，/\\:_\-#]+/).map(s => s.trim()).filter(Boolean)) {
    tokens.add(part.toLowerCase());
  }
  if (p?.id) tokens.add(String(p.id).slice(0, 8).toLowerCase());
  return [...tokens].slice(0, 32);
}

function _refreshSessionMemory(sessionId) {
  const p = _persistedSessions?.get(sessionId);
  if (!p || p.type === 'aux' || p.type === 'gateway') return null;
  const prev = _sessionMemory.get(sessionId) || {};
  const chat = _chatSessions?.get(sessionId);
  const mem = {
    id: sessionId,
    label: _sessionTitle(p),
    cli: p.cli || 'claude',
    kind: p.kind || 'terminal',
    cwd: _sessionCwd(p),
    active: !!chat,
    routable: (p.kind || 'terminal') === 'chat',
    status: prev.status || (chat?.isStreaming ? 'thinking' : 'idle'),
    aliases: _aliasTokens(p, prev),
    lastInput: prev.lastInput || '',
    lastOutput: prev.lastOutput || '',
    lastRouteReason: prev.lastRouteReason || '',
    updatedAt: Date.now(),
  };
  _sessionMemory.set(sessionId, mem);
  return mem;
}

function _memorySnapshot(limit = 30) {
  if (_persistedSessions) {
    for (const [id, p] of _persistedSessions) {
      if (p.type !== 'aux' && p.type !== 'gateway') _refreshSessionMemory(id);
    }
  }
  return [..._sessionMemory.values()]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, limit);
}

function _sessionLabel(sessionId) {
  const mem = _refreshSessionMemory(sessionId);
  if (!mem) return sessionId || '(none)';
  return `#${mem.id}${mem.label && mem.label !== mem.id ? ` ${mem.label}` : ''}`;
}

async function _sendWeChatText(text) {
  if (!_currentUserId || !_currentContextToken || !_client) {
    _log('system', `Reply ready but no WeChat user attached: ${String(text).slice(0, 80)}…`);
    return;
  }
  const chunks = [];
  let remaining = String(text || '');
  while (remaining.length > 3800) {
    let cut = remaining.lastIndexOf('\n', 3800);
    if (cut <= 0) cut = 3800;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.trim()) chunks.push(remaining);
  for (let i = 0; i < chunks.length; i++) {
    const body = i === 0 ? chunks[i] : `(续${i + 1}) ${chunks[i]}`;
    _addEchoHash(body);
    await _client.sendMessage(_currentUserId, body, _currentContextToken);
    _log('out', body.length > 200 ? body.slice(0, 200) + '…' : body);
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
  }
}

// ── Gateway session management ──

function _getGateway() {
  return _persistedSessions?.get(GATEWAY_SESSION_ID) || null;
}

function _createGateway(cli) {
  if (_getGateway()) throw new Error('Gateway already exists');
  if (!['claude', 'codex'].includes(cli)) throw new Error('cli must be claude or codex');
  try { fs.mkdirSync(GATEWAY_CWD, { recursive: true }); } catch (_) {}
  const rec = {
    id: GATEWAY_SESSION_ID,
    type: 'gateway',
    kind: 'chat',
    cli,
    cliSessionId: null,
    label: 'WeChat Gateway',
    cwd: GATEWAY_CWD,
    createdAt: new Date().toISOString(),
  };
  _persistedSessions.set(GATEWAY_SESSION_ID, rec);
  _savePersistedSessions();
  _log('system', `Gateway created (cli=${cli})`);
  return rec;
}

function _switchGatewayCli(cli) {
  const rec = _getGateway();
  if (!rec) throw new Error('Gateway does not exist');
  if (!['claude', 'codex'].includes(cli)) throw new Error('cli must be claude or codex');
  if (rec.cli === cli) return rec;
  rec.cli = cli;
  rec.cliSessionId = null;   // fresh conversation
  _savePersistedSessions();
  // Kill any running chat process so next turn re-spawns with new cli
  const cs = _chatSessions.get(GATEWAY_SESSION_ID);
  if (cs) {
    if (cs.claudeProc) { try { cs.claudeProc.kill('SIGTERM'); } catch (_) {} cs.claudeProc = null; }
    cs.cli = cli;
    cs.chatTurnCount = 0;
  }
  // Bounce internal WS so it re-inits state
  _disconnectChatWs();
  if (_running) _connectChatWs();
  _log('system', `Gateway cli switched to ${cli}`);
  return rec;
}

function _destroyGateway() {
  const rec = _getGateway();
  if (!rec) return;
  _disconnectChatWs();
  const cs = _chatSessions.get(GATEWAY_SESSION_ID);
  if (cs?.claudeProc) { try { cs.claudeProc.kill('SIGTERM'); } catch (_) {} }
  _chatSessions.delete(GATEWAY_SESSION_ID);
  _persistedSessions.delete(GATEWAY_SESSION_ID);
  _savePersistedSessions();
  _log('system', 'Gateway destroyed');
}

function _resetGatewayHistory() {
  const rec = _getGateway();
  if (!rec) return;
  const histFile = path.join(__dirname, 'chat_history', GATEWAY_SESSION_ID + '.json');
  try { fs.unlinkSync(histFile); } catch (_) {}
  rec.cliSessionId = (rec.cli === 'claude') ? crypto.randomUUID() : null;
  _savePersistedSessions();
  const cs = _chatSessions.get(GATEWAY_SESSION_ID);
  if (cs) {
    if (cs.claudeProc) { try { cs.claudeProc.kill('SIGTERM'); } catch (_) {} cs.claudeProc = null; }
    cs.chatTurnCount = 0;
  }
  _disconnectChatWs();
  if (_running) _connectChatWs();
  _log('system', 'Gateway history cleared');
}

// ── Internal chat WS (bridge → /ws/chat) ──

function _connectChatWs() {
  if (_chatWs) return;
  if (!_getGateway()) return;
  const url = `ws://127.0.0.1:${_port}/ws/chat?session=${encodeURIComponent(GATEWAY_SESSION_ID)}`;
  const ws = new WebSocket(url);
  _chatWs = ws;

  ws.on('open', () => {
    _log('system', 'Connected to gateway chat session');
  });

  ws.on('message', (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch (_) { return; }
    _handleChatEvent(evt);
  });

  ws.on('close', () => {
    _chatWs = null;
    if (_running && _getGateway()) {
      // brief backoff
      clearTimeout(_chatWsReconnectTimer);
      _chatWsReconnectTimer = setTimeout(_connectChatWs, 1500);
    }
  });

  ws.on('error', (e) => {
    _log('error', `Chat WS error: ${e.message}`);
  });
}

function _disconnectChatWs() {
  clearTimeout(_chatWsReconnectTimer);
  _chatWsReconnectTimer = null;
  if (_chatWs) {
    try { _chatWs.close(); } catch (_) {}
    _chatWs = null;
  }
  _currentAssistantText = '';
  _turnInProgress = false;
  clearTimeout(_outputTimer);
}

function _sendUserMessage(text) {
  if (!_chatWs || _chatWs.readyState !== WebSocket.OPEN) {
    _log('error', 'Gateway chat not connected — cannot deliver message');
    return false;
  }
  _currentAssistantText = '';
  _turnInProgress = true;
  _chatWs.send(JSON.stringify({ type: 'user_message', text }));
  return true;
}

function _handleChatEvent(evt) {
  // Mirror the assistant-text/result accumulation that the chat UI does, but
  // forward only completed turns (or the final flush) to WeChat as plain text.
  if (evt.type === 'assistant' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'text' && block.text) {
        _currentAssistantText += block.text;
      }
      // tool_use blocks deliberately ignored — too noisy for a chat channel
    }
    return;
  }
  if (evt.type === 'result') {
    _flushAssistantTurn();
    return;
  }
  if (evt.type === 'system' && evt.subtype === 'init') {
    // chat session ready
    return;
  }
  if (evt.type === 'error') {
    _log('error', `Gateway: ${evt.error || 'unknown error'}`);
    _turnInProgress = false;
  }
}

async function _flushAssistantTurn() {
  const text = _currentAssistantText.trim();
  _currentAssistantText = '';
  _turnInProgress = false;
  if (!text) return;
  try { await _sendWeChatText(text); }
  catch (e) { _log('error', `Send to WeChat failed: ${e.message}`); }
}

// ── Command system (slimmed) ──

async function _handleCommand(text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const rec = _getGateway();

  let reply = '';
  switch (cmd) {
    case '/help':
      reply = [
        '📋 可用命令:',
        '/status — 网关状态',
        '/sessions — 列出 Gateway 可见的 chat session',
        '/reset — 清空当前对话历史',
        '/help — 显示此帮助',
      ].join('\n');
      break;
    case '/status': {
      const uptime = _loginTime ? Math.floor((Date.now() - _loginTime) / 60000) + ' min' : 'N/A';
      reply = [
        `🔗 桥接: ${_running ? '运行中' : '已停止'}`,
        `📱 登录: ${_client?.isLoggedIn ? '已登录' : '未登录'} (${uptime})`,
        `🤖 Gateway: ${rec ? `${rec.cli}` : '未创建'}`,
        `📂 可见 chat sessions: ${_memorySnapshot().filter(m => m.routable).length}`,
      ].join('\n');
      break;
    }
    case '/sessions': {
      const lines = ['📂 Gateway 可见 chat session:'];
      for (const mem of _memorySnapshot().filter(m => m.routable)) {
        lines.push(`  ${mem.id}${mem.label && mem.label !== mem.id ? ` / ${mem.label}` : ''} — ${mem.status}`);
      }
      reply = lines.length === 1 ? '没有可见的 chat session' : lines.join('\n');
      break;
    }
    case '/reset':
      _resetGatewayHistory();
      reply = '✅ 已清空对话历史';
      break;
    default:
      reply = `未知命令: ${cmd}，输入 /help 查看帮助`;
  }
  if (reply && _currentUserId && _currentContextToken) {
    try { await _sendWeChatText(reply); }
    catch (e) { _log('error', `Reply send failed: ${e.message}`); }
  }
}

// ── WeChat long-poll loop ──

async function _pollLoop() {
  while (_running && _client) {
    try {
      _pollAbort = new AbortController();
      const { msgs } = await _client.getUpdates(_pollAbort.signal);

      for (const msg of msgs) {
        const userId = msg.from_user_id;
        const text = _extractText(msg);

        // Track most-recent user (singleton model)
        if (msg.context_token) {
          _currentUserId = userId;
          _currentContextToken = msg.context_token;
        }

        if (!text.trim()) continue;
        if (_isEcho(text)) continue;

        _log('in', `[WeChat] ${text.length > 200 ? text.slice(0, 200) + '…' : text}`);

        if (text.startsWith('/')) {
          await _handleCommand(text);
          continue;
        }

        if (!_getGateway()) {
          if (msg.context_token) {
            await _client.sendMessage(userId, '⚠ Gateway 未创建。请在 MultiCC 管理页面创建 WeChat Gateway。', msg.context_token).catch(() => {});
          }
          continue;
        }

        if (msg.context_token) _client.sendTyping(msg.context_token).catch(() => {});
        if (!_chatWs || _chatWs.readyState !== WebSocket.OPEN) _connectChatWs();
        if (_chatWs && _chatWs.readyState === WebSocket.CONNECTING) {
          await new Promise(r => {
            const t = setTimeout(r, 2000);
            _chatWs.once('open', () => { clearTimeout(t); r(); });
          });
        }
        _sendUserMessage(text);
      }
    } catch (e) {
      if (e.name === 'AbortError') continue;
      _log('error', `Poll error: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ── Public API ──

async function startBridge() {
  if (_running) throw new Error('Bridge is already running');
  if (!_config.botToken) throw new Error('Not logged in. Please scan QR code first.');
  if (!_getGateway()) throw new Error('Gateway not created. Create it in the management page first.');

  _client = new ILinkClient(_config.botToken, _config.baseUrl);
  _running = true;
  _log('system', 'Bridge started');
  _connectChatWs();
  _pollLoop();
}

function stopBridge() {
  _running = false;
  if (_pollAbort) { _pollAbort.abort(); _pollAbort = null; }
  _disconnectChatWs();
  _disconnectRoutedWs();
  _client = null;
  _log('system', 'Bridge stopped');
}

function init({ persistedSessions, chatSessions, savePersistedSessions, chatBroadcast, port }) {
  _persistedSessions = persistedSessions;
  _chatSessions = chatSessions;
  _savePersistedSessions = savePersistedSessions;
  _chatBroadcast = chatBroadcast;
  _port = port || 3000;
}

// ── REST API ──

// Login QR
router.get('/qrcode', async (req, res) => {
  try {
    const data = await ILinkClient.getQRCode();
    _loginQrcode = data.qrcode;
    _loginQrImg = data.qrcode_img_content || null;
    res.json({ qrcode: data.qrcode, image: _loginQrImg });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
  } catch (e) { res.json({ status: 'error', error: e.message }); }
});

// Status
router.get('/status', (req, res) => {
  const rec = _getGateway();
  res.json({
    running: _running,
    loggedIn: !!_config.botToken,
    loginTime: _loginTime ? new Date(_loginTime).toISOString() : null,
    gateway: rec ? { id: rec.id, cli: rec.cli, cliSessionId: rec.cliSessionId || null } : null,
    chatConnected: !!(_chatWs && _chatWs.readyState === WebSocket.OPEN),
    currentUser: _currentUserId ? { hasToken: !!_currentContextToken } : null,
  });
});

// Config (idle timeout etc)
router.get('/config', (req, res) => {
  res.json({
    outputIdle: _config.outputIdle || 5000,
    loggedIn: !!_config.botToken,
  });
});

router.post('/config', (req, res) => {
  const { outputIdle } = req.body;
  if (outputIdle !== undefined) _config.outputIdle = Number(outputIdle) || 5000;
  saveConfig(_config);
  res.json({ ok: true });
});

// Gateway lifecycle
router.get('/gateway', (req, res) => {
  const rec = _getGateway();
  res.json(rec || null);
});

router.put('/gateway', (req, res) => {
  const cli = (req.body.cli || '').trim();
  try {
    const existing = _getGateway();
    const rec = existing ? _switchGatewayCli(cli) : _createGateway(cli);
    res.json(rec);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/gateway', (req, res) => {
  try { _destroyGateway(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/gateway/reset', (req, res) => {
  try { _resetGatewayHistory(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Start / stop
router.post('/start', async (req, res) => {
  try {
    if (req.body && req.body.outputIdle) {
      _config.outputIdle = Number(req.body.outputIdle) || 5000;
    }
    saveConfig(_config);
    await startBridge();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/stop', (req, res) => { stopBridge(); res.json({ ok: true }); });

// Manual send (testing helper)
router.post('/send', async (req, res) => {
  const { text, target } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  if (target === 'wechat') {
    if (!_currentUserId || !_currentContextToken) return res.status(400).json({ error: 'No WeChat user attached' });
    try {
      _addEchoHash(text);
      await _client.sendMessage(_currentUserId, text, _currentContextToken);
      _log('out', text);
    } catch (e) { return res.status(500).json({ error: e.message }); }
  } else {
    if (!_getGateway()) return res.status(400).json({ error: 'Gateway not created' });
    if (!_chatWs || _chatWs.readyState !== WebSocket.OPEN) _connectChatWs();
    if (_chatWs && _chatWs.readyState === WebSocket.CONNECTING) {
      await new Promise(r => {
        const t = setTimeout(r, 2000);
        _chatWs.once('open', () => { clearTimeout(t); r(); });
      });
    }
    if (!_sendUserMessage(text)) return res.status(500).json({ error: 'Gateway not connected' });
    _log('in', `[manual] ${text}`);
  }
  res.json({ ok: true });
});

// Log
router.get('/log', (req, res) => {
  const since = req.query.since ? Number(req.query.since) : 0;
  const filtered = since ? _messageLog.filter(e => new Date(e.ts).getTime() > since) : _messageLog;
  res.json(filtered);
});

// SSE
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

router.post('/logout', (req, res) => {
  if (_running) stopBridge();
  _config.botToken = '';
  _config.baseUrl = '';
  _loginTime = null;
  saveConfig(_config);
  _currentUserId = null;
  _currentContextToken = null;
  _log('system', 'Logged out');
  res.json({ ok: true });
});

module.exports = { router, init, loadConfig, startBridge, stopBridge };
