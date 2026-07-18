'use strict';
// Telegram IM bridge — thin adapter atop plugins/bridges/gateway-core.
//
// Telegram-specific concerns kept here:
//   • telegram-client-adapter long-polling client bring-up,
//   • outbound bot.sendMessage() with ~3800-char chunking,
//   • config (botToken) + /config,
//   • /status shape (polling, currentChat).

const express = require('express');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const { bridgeConfigFile, bridgeHistoryFile, saveBridgeConfig } = require('./secure-config');
const { createTelegramClient } = require('./telegram-client-adapter');
const {
  createEchoStore, createLogStore, createGatewayLifecycle, createChatWsClient, chunkOutbound,
  deps: { fs },
} = require('./gateway-core');

const router = express.Router();

const CONFIG_FILE = bridgeConfigFile('telegram-config.json', path.join(__dirname, 'telegram-config.json'));
const GATEWAY_SESSION_ID = '__telegram_gateway__';
const GATEWAY_CWD = path.join(os.homedir(), '.multicc', 'telegram-gateway');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (_) { return { botToken: '' }; }
}
function saveConfig(cfg) { saveBridgeConfig(CONFIG_FILE, cfg); }

let _persistedSessions = null;
let _chatSessions = null;
let _savePersistedSessions = null;
let _chatBroadcast = null;
let _port = 3000;

let _config = loadConfig();
let _running = false;

let _bot = null;
let _currentChatId = null;
let _startTime = null;

let _log = null;
let _logStore = null;
let _echo = null;
let _gateway = null;
let _chatWs = null;

// ── Outbound ─────────────────────────────────────────────────────────
async function _sendTelegramText(text) {
  if (!_currentChatId || !_bot) {
    _log('system', `Reply ready but no Telegram chat attached: ${String(text).slice(0, 80)}…`);
    return;
  }
  const bodies = chunkOutbound(text, { max: 3800 });
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i];
    _echo.add(body);
    try { await _bot.sendMessage(_currentChatId, body); }
    catch (e) { _log('error', `Telegram send failed: ${e.message}`); break; }
    _log('out', body.length > 200 ? body.slice(0, 200) + '…' : body);
    if (i < bodies.length - 1) await new Promise(r => setTimeout(r, 400));
  }
}

// ── Inbound ──────────────────────────────────────────────────────────
async function _onTelegramMessage(msg) {
  try {
    if (!msg.text) return;
    const text = String(msg.text || '').trim();
    if (msg.chat && msg.chat.id) _currentChatId = msg.chat.id;

    if (!text) return;
    if (_echo.isEcho(text)) return;

    _log('in', `[Telegram] ${text.length > 200 ? text.slice(0, 200) + '…' : text}`);

    if (text.startsWith('/')) { await _handleCommand(text); return; }

    if (!_gateway.get()) {
      await _sendTelegramText('⚠ Telegram Gateway 未创建。请在 MultiCC 管理页面创建 Telegram Gateway。');
      return;
    }

    if (!_chatWs.isOpen()) _chatWs.connect();
    await _chatWs.ensureOpen(2000);
    _chatWs.sendUserMessage(text);
  } catch (e) { _log('error', `Inbound handling error: ${e.message}`); }
}

async function _handleCommand(text) {
  const cmd = text.trim().split(/\s+/)[0].toLowerCase();
  const rec = _gateway.get();
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
    case '/reset': _gateway.resetHistory(); reply = '✅ 已清空对话历史'; break;
    default: reply = `未知命令: ${cmd}，输入 /help 查看帮助`;
  }
  if (reply) { try { await _sendTelegramText(reply); } catch (e) { _log('error', e.message); } }
}

// ── Bridge lifecycle ─────────────────────────────────────────────────
async function startBridge() {
  if (_running) throw new Error('Bridge is already running');
  if (!_config.botToken) throw new Error('未配置 Telegram Bot Token');
  if (!_gateway.get()) throw new Error('Telegram gateway 未创建，请先在管理页面创建。');

  const client = createTelegramClient({ token: _config.botToken, transport: 'polling' });
  _bot = client;
  client.onMessage(async (msg) => { await _onTelegramMessage(msg); });
  client.onPollingError((err) => { _log('error', `Telegram polling error: ${err.message || err}`); });
  try {
    await client.start();
    _running = true;
    _startTime = Date.now();
    _chatWs.connect();
    _log('system', 'Telegram bridge started (long-polling)');
  } catch (error) {
    _bot = null;
    try { await client.stop(); } catch (_) {}
    throw error;
  }
}

async function stopBridge() {
  _running = false;
  const client = _bot;
  _bot = null;
  _chatWs.disconnect();
  if (client) {
    try { await client.stop(); }
    catch (error) { _log('error', `Telegram stop failed: ${error.message || error}`); }
  }
  _log('system', 'Telegram bridge stopped');
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
  _gateway = createGatewayLifecycle({
    sessionId: GATEWAY_SESSION_ID,
    cwd: GATEWAY_CWD,
    label: 'Telegram Gateway',
    platformLabel: 'Telegram',
    persistedSessions: _persistedSessions,
    chatSessions: _chatSessions,
    savePersistedSessions: _savePersistedSessions,
    bridgeHistoryFile,
    chatWsCtl: wsCtl,
    log: _log,
  });
  _chatWs = createChatWsClient({
    port: _port,
    sessionId: GATEWAY_SESSION_ID,
    getGateway: () => _gateway.get(),
    isRunning: () => _running,
    log: _log,
    onTurn: (t) => _sendTelegramText(t),
    hostLabel: 'Telegram',
  });
  wsCtl.disconnect = () => _chatWs.disconnect();
  wsCtl.reconnectIfRunning = () => _chatWs.reconnectIfRunning();
}

// ── REST API ─────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const rec = _gateway.get();
  res.json({
    running: _running,
    configured: !!_config.botToken,
    startTime: _startTime ? new Date(_startTime).toISOString() : null,
    gateway: rec ? { id: rec.id, cli: rec.cli, cliSessionId: rec.cliSessionId || null } : null,
    polling: !!_bot,
    chatConnected: _chatWs.isOpen(),
    currentChat: _currentChatId ? { chatId: _currentChatId } : null,
  });
});

router.get('/config', (req, res) => {
  res.json({ configured: !!(_config.botToken) });
});

router.post('/config', (req, res) => {
  const { botToken } = req.body || {};
  if (botToken !== undefined) _config.botToken = String(botToken).trim();
  saveConfig(_config);
  res.json({ ok: true });
});

router.get('/gateway', (req, res) => res.json(_gateway.get() || null));
router.put('/gateway', (req, res) => {
  const cli = (req.body.cli || '').trim();
  try {
    const rec = _gateway.get() ? _gateway.switchCli(cli) : _gateway.create(cli);
    res.json(rec);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/gateway', (req, res) => {
  try { _gateway.destroy(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/gateway/reset', (req, res) => {
  try { _gateway.resetHistory(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/start', async (req, res) => {
  try { await startBridge(); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/stop', async (req, res) => { await stopBridge(); res.json({ ok: true }); });

router.post('/send', async (req, res) => {
  const { text, target, chatId } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  if (target === 'telegram') {
    if (chatId) _currentChatId = Number(chatId) || chatId;
    if (!_currentChatId) return res.status(400).json({ error: 'No Telegram chat attached (provide chatId)' });
    if (!_bot) return res.status(400).json({ error: 'Bridge not started' });
    try { _echo.add(text); await _sendTelegramText(text); }
    catch (e) { return res.status(500).json({ error: e.message }); }
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

module.exports = { router, init, loadConfig, startBridge, stopBridge };
