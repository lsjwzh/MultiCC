'use strict';
// WeChat iLink IM bridge — thin adapter atop plugins/bridges/gateway-core.
//
// The WeChat gateway differs from Feishu/Discord/Slack/Telegram in two ways
// that must NOT be swept into the core (each is genuinely WeChat-specific):
//
//   1. Login flow. WeChat iLink issues a QR code that MultiCC must render, then
//      polls for confirmation and stashes the returned bot_token. We keep the
//      QR routes (/qrcode, /login-status, /logout) here verbatim.
//
//   2. Session memory prompt. WeChat's gateway maintains a snapshot of other
//      chat sessions so the Gateway prompt can reason about routing. That
//      concern is bound to persistedSessions/chatSessions but is otherwise not
//      shared with the other four bridges — it stays here.
//
// Everything else (echo, log, chat WS, gateway lifecycle, dispatch strip, chunk)
// comes from gateway-core so the five bridges share one code path.

const express = require('express');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const WebSocket = require('ws');
const { bridgeConfigFile, bridgeHistoryFile, saveBridgeConfig } = require('./secure-config');
const {
  createEchoStore, createLogStore, createGatewayLifecycle, createChatWsClient, chunkOutbound,
  deps: { fs },
} = require('./gateway-core');

const router = express.Router();

const CONFIG_FILE = bridgeConfigFile('wechat-config.json', path.join(__dirname, 'wechat-config.json'));
const ILINK_LOGIN_URL = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '1.0.2';

const GATEWAY_SESSION_ID = '__gateway__';
const GATEWAY_CWD = path.join(os.homedir(), '.multicc', 'gateway');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (_) { return { outputIdle: 5000, botToken: '', baseUrl: '' }; }
}
function saveConfig(cfg) { saveBridgeConfig(CONFIG_FILE, cfg); }

let _persistedSessions = null;
let _chatSessions = null;
let _savePersistedSessions = null;
let _chatBroadcast = null;
let _port = 3000;

let _config = loadConfig();
let _client = null;
let _running = false;
let _pollAbort = null;

let _currentUserId = null;
let _currentContextToken = null;
const _sessionMemory = new Map();

let _loginQrcode = null;
let _loginQrImg = null;
let _loginTime = null;

let _log = null;
let _logStore = null;
let _echo = null;
let _gateway = null;
let _chatWs = null;

// ── ILink HTTP client (WeChat-specific) ──────────────────────────────
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

function _extractText(msg) {
  if (!msg || !msg.item_list) return '';
  for (const item of msg.item_list) {
    if (item.type === 1 && item.text_item) return item.text_item.text || '';
  }
  return '';
}

// ── Session memory (WeChat-specific gateway prompt context) ──────────
// The other bridges don't build a routable-sessions snapshot; only WeChat's
// existing spec exposes /sessions in the /help output, so we keep it here.
function _sessionCwd(p) { return p?.worktreePath || p?.cwd || ''; }
function _sessionTitle(p) { return p?.label || p?.id || ''; }
function _aliasTokens(p, prev) {
  const raw = [
    p?.id, p?.label, p?.cli, p?.kind,
    _sessionCwd(p).split(/[\\/]/).filter(Boolean).slice(-2).join(' '),
    ...(prev?.aliases || []),
  ].filter(Boolean).join(' ');
  const tokens = new Set();
  for (const part of raw.split(/[\s,，/\\:_\-#]+/).map(s => s.trim()).filter(Boolean)) tokens.add(part.toLowerCase());
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

// ── Outbound (WeChat-specific) ───────────────────────────────────────
async function _sendWeChatText(text) {
  if (!_currentUserId || !_currentContextToken || !_client) {
    _log('system', `Reply ready but no WeChat user attached: ${String(text).slice(0, 80)}…`);
    return;
  }
  const bodies = chunkOutbound(text, { max: 3800 });
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i];
    _echo.add(body);
    await _client.sendMessage(_currentUserId, body, _currentContextToken);
    _log('out', body.length > 200 ? body.slice(0, 200) + '…' : body);
    if (i < bodies.length - 1) await new Promise(r => setTimeout(r, 500));
  }
}

// ── Command handler ──────────────────────────────────────────────────
async function _handleCommand(text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const rec = _gateway.get();

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
    case '/reset': _gateway.resetHistory(); reply = '✅ 已清空对话历史'; break;
    default: reply = `未知命令: ${cmd}，输入 /help 查看帮助`;
  }
  if (reply && _currentUserId && _currentContextToken) {
    try { await _sendWeChatText(reply); }
    catch (e) { _log('error', `Reply send failed: ${e.message}`); }
  }
}

// ── WeChat inbound long-poll loop ────────────────────────────────────
async function _pollLoop() {
  while (_running && _client) {
    try {
      _pollAbort = new AbortController();
      const { msgs } = await _client.getUpdates(_pollAbort.signal);

      for (const msg of msgs) {
        const userId = msg.from_user_id;
        const text = _extractText(msg);

        if (msg.context_token) {
          _currentUserId = userId;
          _currentContextToken = msg.context_token;
        }

        if (!text.trim()) continue;
        if (_echo.isEcho(text)) continue;

        _log('in', `[WeChat] ${text.length > 200 ? text.slice(0, 200) + '…' : text}`);

        if (text.startsWith('/')) { await _handleCommand(text); continue; }

        if (!_gateway.get()) {
          if (msg.context_token) {
            await _client.sendMessage(userId, '⚠ Gateway 未创建。请在 MultiCC 管理页面创建 WeChat Gateway。', msg.context_token).catch(() => {});
          }
          continue;
        }

        if (msg.context_token) _client.sendTyping(msg.context_token).catch(() => {});
        if (!_chatWs.isOpen()) _chatWs.connect();
        await _chatWs.ensureOpen(2000);
        _chatWs.sendUserMessage(text);
      }
    } catch (e) {
      if (e.name === 'AbortError') continue;
      _log('error', `Poll error: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ── Public bridge lifecycle ──────────────────────────────────────────
async function startBridge() {
  if (_running) throw new Error('Bridge is already running');
  if (!_config.botToken) throw new Error('Not logged in. Please scan QR code first.');
  if (!_gateway.get()) throw new Error('Gateway not created. Create it in the management page first.');

  _client = new ILinkClient(_config.botToken, _config.baseUrl);
  _running = true;
  _log('system', 'Bridge started');
  _chatWs.connect();
  _pollLoop();
}

function stopBridge() {
  _running = false;
  if (_pollAbort) { _pollAbort.abort(); _pollAbort = null; }
  _chatWs.disconnect();
  _client = null;
  _log('system', 'Bridge stopped');
}

function init({ persistedSessions, chatSessions, savePersistedSessions, chatBroadcast, port }) {
  _persistedSessions = persistedSessions;
  _chatSessions = chatSessions;
  _savePersistedSessions = savePersistedSessions;
  _chatBroadcast = chatBroadcast;
  _port = port || 3000;

  _logStore = createLogStore({ max: 300 });
  _log = (type, text) => _logStore.push(type, text);
  _echo = createEchoStore({ ttlMs: 60_000 });

  const wsCtl = { disconnect: () => {}, reconnectIfRunning: () => {} };
  // WeChat's legacy log lines omit the "WeChat " prefix on gateway lifecycle
  // events (they read "Gateway created", "Gateway destroyed", etc). We keep
  // that verbatim by wrapping the log fn to rewrite the platform prefix that
  // gateway-core injects. The rest of the platform-agnostic messages go
  // through untouched.
  const platformPrefixedLog = _log;
  const wechatLog = (type, text) => {
    if (typeof text === 'string' && text.startsWith('WeChat gateway ')) {
      platformPrefixedLog(type, text.replace(/^WeChat gateway /, 'Gateway '));
    } else {
      platformPrefixedLog(type, text);
    }
  };
  _gateway = createGatewayLifecycle({
    sessionId: GATEWAY_SESSION_ID,
    cwd: GATEWAY_CWD,
    label: 'WeChat Gateway',
    platformLabel: 'WeChat',
    persistedSessions: _persistedSessions,
    chatSessions: _chatSessions,
    savePersistedSessions: _savePersistedSessions,
    bridgeHistoryFile,
    chatWsCtl: wsCtl,
    log: wechatLog,
  });
  _chatWs = createChatWsClient({
    port: _port,
    sessionId: GATEWAY_SESSION_ID,
    getGateway: () => _gateway.get(),
    isRunning: () => _running,
    log: _log,
    onTurn: (t) => _sendWeChatText(t),
    // WeChat's legacy line was "Connected to gateway chat session" (no
    // platform prefix). gateway-core builds "Connected to <hostLabel> gateway
    // chat session" — passing empty then falling back to sessionId would say
    // "Connected to __gateway__ …", which reads as debug noise. Empty string
    // isn't accepted (it falls back to sessionId), so we override the whole
    // message via a wrapper log.
    hostLabel: 'WeChat',
  });
  wsCtl.disconnect = () => _chatWs.disconnect();
  wsCtl.reconnectIfRunning = () => _chatWs.reconnectIfRunning();
}

// ── REST API ─────────────────────────────────────────────────────────
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
  const rec = _gateway.get();
  res.json({
    running: _running,
    loggedIn: !!_config.botToken,
    loginTime: _loginTime ? new Date(_loginTime).toISOString() : null,
    gateway: rec ? { id: rec.id, cli: rec.cli, cliSessionId: rec.cliSessionId || null } : null,
    chatConnected: _chatWs.isOpen(),
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
router.get('/gateway', (req, res) => res.json(_gateway.get() || null));

router.put('/gateway', (req, res) => {
  const cli = (req.body.cli || '').trim();
  try {
    const rec = _gateway.get() ? _gateway.switchCli(cli) : _gateway.create(cli);
    res.json(rec);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/gateway', (req, res) => {
  try { _gateway.destroy(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/gateway/reset', (req, res) => {
  try { _gateway.resetHistory(); res.json({ ok: true }); }
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

router.post('/send', async (req, res) => {
  const { text, target } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  if (target === 'wechat') {
    if (!_currentUserId || !_currentContextToken) return res.status(400).json({ error: 'No WeChat user attached' });
    try {
      _echo.add(text);
      await _client.sendMessage(_currentUserId, text, _currentContextToken);
      _log('out', text);
    } catch (e) { return res.status(500).json({ error: e.message }); }
  } else {
    if (!_gateway.get()) return res.status(400).json({ error: 'Gateway not created' });
    if (!_chatWs.isOpen()) _chatWs.connect();
    await _chatWs.ensureOpen(2000);
    if (!_chatWs.sendUserMessage(text)) return res.status(500).json({ error: 'Gateway not connected' });
    _log('in', `[manual] ${text}`);
  }
  res.json({ ok: true });
});

router.get('/log', (req, res) => {
  const since = req.query.since ? Number(req.query.since) : 0;
  res.json(_logStore.filterSince(since));
});

router.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  _logStore.addClient(res);
  const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch (_) {} }, 5000);
  req.on('close', () => { clearInterval(heartbeat); _logStore.removeClient(res); });
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
