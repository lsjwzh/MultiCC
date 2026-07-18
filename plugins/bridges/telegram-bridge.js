'use strict';

/**
 * Telegram Bridge for MultiCC — Gateway model.
 *
 * Mirrors the Feishu bridge (feishu-bridge.js) but speaks Telegram's Bot API
 * via node-telegram-bot-api:
 *   - Inbound: long-polling (new TelegramBot({polling:true})) receives `message`
 *     events. No public webhook URL needed, works behind NAT.
 *   - Outbound: bot.sendMessage() sends text replies.
 *
 * Architecture is identical to Feishu/WeChat gateways: the bridge connects to
 * one designated "gateway" chat session as an ordinary /ws/chat WebSocket client
 * on 127.0.0.1, submits every inbound Telegram message as a user_message, and
 * forwards each completed assistant turn back to Telegram. Telegram uses its own
 * gateway session id (`__telegram_gateway__`).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { bridgeConfigFile, saveBridgeConfig } = require('./secure-config');

// node-telegram-bot-api is loaded lazily so the rest of MultiCC keeps working
// even when the dependency has not been installed yet.
let TelegramBot = null;
function loadTelegram() {
  if (TelegramBot) return TelegramBot;
  try {
    TelegramBot = require('node-telegram-bot-api');
  } catch (e) {
    throw new Error('node-telegram-bot-api 未安装，请先 npm install node-telegram-bot-api');
  }
  return TelegramBot;
}

const router = express.Router();

const CONFIG_FILE = bridgeConfigFile('telegram-config.json', path.join(__dirname, 'telegram-config.json'));
const GATEWAY_SESSION_ID = '__telegram_gateway__';
const GATEWAY_CWD = path.join(require('os').homedir(), '.multicc', 'telegram-gateway');

// ── Config ──
// { botToken }
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (_) { return { botToken: '' }; }
}
function saveConfig(cfg) { saveBridgeConfig(CONFIG_FILE, cfg); }

// ── Injected deps ──
let _persistedSessions = null;
let _chatSessions = null;
let _savePersistedSessions = null;
let _chatBroadcast = null;
let _port = 3000;

let _config = loadConfig();
let _running = false;

// Telegram SDK handles
let _bot = null;             // TelegramBot instance

// Most recent Telegram chat we talked to (singleton model, mirrors feishu bridge).
let _currentChatId = null;

// Internal chat WS connection (bridge ↔ chat session)
let _chatWs = null;
let _chatWsReconnectTimer = null;
let _currentAssistantText = '';
let _turnInProgress = false;

// Echo suppression
const _sentHashes = new Map();
const ECHO_TTL = 60000;

// Log buffer
let _messageLog = [];
const MAX_LOG = 300;
const _sseClients = new Set();

let _startTime = null;

// ── Echo suppression ──
function _hashText(t) { return String(t).replace(/\s+/g, ' ').trim().slice(0, 200); }
function _addEchoHash(t) { const h = _hashText(t); if (h) _sentHashes.set(h, Date.now() + ECHO_TTL); }
function _isEcho(t) {
  const h = _hashText(t);
  if (!h) return true;
  const now = Date.now();
  for (const [k, v] of _sentHashes) if (v < now) _sentHashes.delete(k);
  for (const [k] of _sentHashes) {
    if (k === h) return true;
    const shorter = h.length <= k.length ? h : k;
    if (shorter.length >= 12 && (k.includes(h) || h.includes(k))) return true;
  }
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

// ── Outbound: send text to Telegram ──
async function _sendTelegramText(text) {
  if (!_currentChatId || !_bot) {
    _log('system', `Reply ready but no Telegram chat attached: ${String(text).slice(0, 80)}…`);
    return;
  }
  // Telegram single message cap is 4096; chunk conservatively at ~3800.
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
    try {
      await _bot.sendMessage(_currentChatId, body);
    } catch (e) {
      _log('error', `Telegram send failed: ${e.message}`);
      break;
    }
    _log('out', body.length > 200 ? body.slice(0, 200) + '…' : body);
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 400));
  }
}

// ── Gateway session management ──
function _getGateway() { return _persistedSessions?.get(GATEWAY_SESSION_ID) || null; }

function _createGateway(cli) {
  if (_getGateway()) throw new Error('Telegram gateway already exists');
  if (!['claude', 'codex'].includes(cli)) throw new Error('cli must be claude or codex');
  try { fs.mkdirSync(GATEWAY_CWD, { recursive: true }); } catch (_) {}
  const rec = {
    id: GATEWAY_SESSION_ID,
    type: 'gateway',
    kind: 'chat',
    cli,
    cliSessionId: null,
    label: 'Telegram Gateway',
    cwd: GATEWAY_CWD,
    createdAt: new Date().toISOString(),
  };
  _persistedSessions.set(GATEWAY_SESSION_ID, rec);
  _savePersistedSessions();
  _log('system', `Telegram gateway created (cli=${cli})`);
  return rec;
}

function _switchGatewayCli(cli) {
  const rec = _getGateway();
  if (!rec) throw new Error('Telegram gateway does not exist');
  if (!['claude', 'codex'].includes(cli)) throw new Error('cli must be claude or codex');
  if (rec.cli === cli) return rec;
  rec.cli = cli;
  rec.cliSessionId = null;
  _savePersistedSessions();
  const cs = _chatSessions.get(GATEWAY_SESSION_ID);
  if (cs) {
    if (cs.claudeProc) { try { cs.claudeProc.kill('SIGTERM'); } catch (_) {} cs.claudeProc = null; }
    cs.cli = cli;
    cs.chatTurnCount = 0;
  }
  _disconnectChatWs();
  if (_running) _connectChatWs();
  _log('system', `Telegram gateway cli switched to ${cli}`);
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
  _log('system', 'Telegram gateway destroyed');
}

function _resetGatewayHistory() {
  const rec = _getGateway();
  if (!rec) return;
  const histFile = path.join(__dirname, 'chat_history', GATEWAY_SESSION_ID + '.json');
  try { fs.unlinkSync(histFile); } catch (_) {}
  rec.cliSessionId = (rec.cli === 'claude') ? require('crypto').randomUUID() : null;
  _savePersistedSessions();
  const cs = _chatSessions.get(GATEWAY_SESSION_ID);
  if (cs) {
    if (cs.claudeProc) { try { cs.claudeProc.kill('SIGTERM'); } catch (_) {} cs.claudeProc = null; }
    cs.chatTurnCount = 0;
  }
  _disconnectChatWs();
  if (_running) _connectChatWs();
  _log('system', 'Telegram gateway history cleared');
}

// ── Internal chat WS (bridge → /ws/chat) ──
function _connectChatWs() {
  if (_chatWs) return;
  if (!_getGateway()) return;
  const url = `ws://127.0.0.1:${_port}/ws/chat?session=${encodeURIComponent(GATEWAY_SESSION_ID)}`;
  const ws = new WebSocket(url);
  _chatWs = ws;
  ws.on('open', () => _log('system', 'Connected to Telegram gateway chat session'));
  ws.on('message', (raw) => {
    let evt; try { evt = JSON.parse(raw.toString()); } catch (_) { return; }
    _handleChatEvent(evt);
  });
  ws.on('close', () => {
    _chatWs = null;
    if (_running && _getGateway()) {
      clearTimeout(_chatWsReconnectTimer);
      _chatWsReconnectTimer = setTimeout(_connectChatWs, 1500);
    }
  });
  ws.on('error', (e) => _log('error', `Chat WS error: ${e.message}`));
}

function _disconnectChatWs() {
  clearTimeout(_chatWsReconnectTimer);
  _chatWsReconnectTimer = null;
  if (_chatWs) { try { _chatWs.close(); } catch (_) {} _chatWs = null; }
  _currentAssistantText = '';
  _turnInProgress = false;
}

function _sendUserMessage(text) {
  if (!_chatWs || _chatWs.readyState !== WebSocket.OPEN) {
    _log('error', 'Telegram gateway chat not connected — cannot deliver message');
    return false;
  }
  _currentAssistantText = '';
  _turnInProgress = true;
  _chatWs.send(JSON.stringify({ type: 'user_message', text }));
  return true;
}

function _handleChatEvent(evt) {
  if (evt.type === 'assistant' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'text' && block.text) _currentAssistantText += block.text;
    }
    return;
  }
  if (evt.type === 'result') { _flushAssistantTurn(); return; }
  if (evt.type === 'system' && evt.subtype === 'init') return;
  if (evt.type === 'error') {
    _log('error', `Telegram gateway: ${evt.error || 'unknown error'}`);
    _turnInProgress = false;
  }
}

function _stripDispatchMarkers(text) {
  return String(text || '')
    .replace(/<<dispatch\s+target="[^"]+"\s*>[\s\S]*?<\/dispatch>>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function _flushAssistantTurn() {
  const text = _stripDispatchMarkers(_currentAssistantText);
  _currentAssistantText = '';
  _turnInProgress = false;
  if (!text) return;
  try { await _sendTelegramText(text); }
  catch (e) { _log('error', `Send to Telegram failed: ${e.message}`); }
}

// ── Inbound: on Telegram message ──
async function _onTelegramMessage(msg) {
  try {
    // Skip non-text messages
    if (!msg.text) return;

    const text = String(msg.text || '').trim();
    // Track most-recent chat for replies (singleton model)
    if (msg.chat && msg.chat.id) { _currentChatId = msg.chat.id; }

    if (!text) return;
    if (_isEcho(text)) return;

    _log('in', `[Telegram] ${text.length > 200 ? text.slice(0, 200) + '…' : text}`);

    if (text.startsWith('/')) { await _handleCommand(text); return; }

    if (!_getGateway()) {
      await _sendTelegramText('⚠ Telegram Gateway 未创建。请在 MultiCC 管理页面创建 Telegram Gateway。');
      return;
    }

    if (!_chatWs || _chatWs.readyState !== WebSocket.OPEN) _connectChatWs();
    if (_chatWs && _chatWs.readyState === WebSocket.CONNECTING) {
      await new Promise(r => {
        const t = setTimeout(r, 2000);
        _chatWs.once('open', () => { clearTimeout(t); r(); });
      });
    }
    _sendUserMessage(text);
  } catch (e) {
    _log('error', `Inbound handling error: ${e.message}`);
  }
}

// ── Command system ──
async function _handleCommand(text) {
  const cmd = text.trim().split(/\s+/)[0].toLowerCase();
  const rec = _getGateway();
  let reply = '';
  switch (cmd) {
    case '/help':
      reply = ['📋 可用命令:', '/status — 网关状态', '/reset — 清空对话历史', '/help — 显示帮助'].join('\n');
      break;
    case '/status': {
      const uptime = _startTime ? Math.floor((Date.now() - _startTime) / 60000) + ' min' : 'N/A';
      reply = [
        `🔗 桥接: ${_running ? '运行中' : '已停止'}`,
        `🤖 Bot: ${_config.botToken ? '已配置' : '未配置'} (${uptime})`,
        `🔌 Gateway: ${rec ? rec.cli : '未创建'}`,
        `📡 Polling: ${_bot ? '运行中' : '未启动'}`,
      ].join('\n');
      break;
    }
    case '/reset':
      _resetGatewayHistory();
      reply = '✅ 已清空对话历史';
      break;
    default:
      reply = `未知命令: ${cmd}，输入 /help 查看帮助`;
  }
  if (reply) { try { await _sendTelegramText(reply); } catch (e) { _log('error', e.message); } }
}

// ── Bridge lifecycle ──
async function startBridge() {
  if (_running) throw new Error('Bridge is already running');
  if (!_config.botToken) throw new Error('未配置 Telegram Bot Token');
  if (!_getGateway()) throw new Error('Telegram gateway 未创建，请先在管理页面创建。');

  const TB = loadTelegram();
  _bot = new TB(_config.botToken, { polling: true });

  _bot.on('message', async (msg) => { await _onTelegramMessage(msg); });

  _bot.on('polling_error', (err) => {
    _log('error', `Telegram polling error: ${err.message || err}`);
  });

  _running = true;
  _startTime = Date.now();
  _connectChatWs();
  _log('system', 'Telegram bridge started (long-polling)');
}

function stopBridge() {
  _running = false;
  if (_bot) { try { _bot.stopPolling(); } catch (_) {} _bot = null; }
  _disconnectChatWs();
  _log('system', 'Telegram bridge stopped');
}

function init({ persistedSessions, chatSessions, savePersistedSessions, chatBroadcast, port }) {
  _persistedSessions = persistedSessions;
  _chatSessions = chatSessions;
  _savePersistedSessions = savePersistedSessions;
  _chatBroadcast = chatBroadcast;
  _port = port || 3000;
}

// ── REST API ──
router.get('/status', (req, res) => {
  const rec = _getGateway();
  res.json({
    running: _running,
    configured: !!_config.botToken,
    startTime: _startTime ? new Date(_startTime).toISOString() : null,
    gateway: rec ? { id: rec.id, cli: rec.cli, cliSessionId: rec.cliSessionId || null } : null,
    polling: !!_bot,
    chatConnected: !!(_chatWs && _chatWs.readyState === WebSocket.OPEN),
    currentChat: _currentChatId ? { chatId: _currentChatId } : null,
  });
});

router.get('/config', (req, res) => {
  // GET never returns the raw token — only whether it's configured
  res.json({ configured: !!(_config.botToken) });
});

router.post('/config', (req, res) => {
  const { botToken } = req.body || {};
  if (botToken !== undefined) _config.botToken = String(botToken).trim();
  saveConfig(_config);
  res.json({ ok: true });
});

// Gateway lifecycle
router.get('/gateway', (req, res) => res.json(_getGateway() || null));
router.put('/gateway', (req, res) => {
  const cli = (req.body.cli || '').trim();
  try {
    const rec = _getGateway() ? _switchGatewayCli(cli) : _createGateway(cli);
    res.json(rec);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/gateway', (req, res) => {
  try { _destroyGateway(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/gateway/reset', (req, res) => {
  try { _resetGatewayHistory(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/start', async (req, res) => {
  try { await startBridge(); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/stop', (req, res) => { stopBridge(); res.json({ ok: true }); });

// Manual send (testing helper)
router.post('/send', async (req, res) => {
  const { text, target, chatId } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  if (target === 'telegram') {
    if (chatId) _currentChatId = Number(chatId) || chatId;
    if (!_currentChatId) return res.status(400).json({ error: 'No Telegram chat attached (provide chatId)' });
    if (!_bot) return res.status(400).json({ error: 'Bridge not started' });
    try { _addEchoHash(text); await _sendTelegramText(text); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  } else {
    if (!_getGateway()) return res.status(400).json({ error: 'Gateway not created' });
    if (!_chatWs || _chatWs.readyState !== WebSocket.OPEN) _connectChatWs();
    if (_chatWs && _chatWs.readyState === WebSocket.CONNECTING) {
      await new Promise(r => { const t = setTimeout(r, 2000); _chatWs.once('open', () => { clearTimeout(t); r(); }); });
    }
    if (!_sendUserMessage(text)) return res.status(500).json({ error: 'Gateway not connected' });
    _log('in', `[manual] ${text}`);
  }
  res.json({ ok: true });
});

router.get('/log', (req, res) => {
  const since = req.query.since ? Number(req.query.since) : 0;
  res.json(since ? _messageLog.filter(e => new Date(e.ts).getTime() > since) : _messageLog);
});

router.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  _sseClients.add(res);
  const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch (_) {} }, 5000);
  req.on('close', () => { clearInterval(heartbeat); _sseClients.delete(res); });
});

module.exports = { router, init, loadConfig, startBridge, stopBridge };
