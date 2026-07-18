'use strict';
// Feishu (Lark) IM bridge — thin adapter atop plugins/bridges/gateway-core.
//
// Everything that used to be duplicated across the five IM bridges — gateway
// session lifecycle, internal /ws/chat client, echo suppression, message log
// ring + SSE, dispatch-marker strip, common start/stop router glue — now
// lives in gateway-core. This file keeps only the Feishu-specific concerns:
//
//   • @larksuiteoapi/node-sdk lazy load + domain resolution,
//   • WSClient + Client bring-up on start, teardown on stop,
//   • inbound event → normalized text (Feishu message types: text, post),
//   • outbound Feishu.im.message.create with chunked bodies,
//   • config load/save (appId, appSecret, domain) and its /config route,
//   • /status shape (Feishu-specific fields: wsConnected, currentChat).
//
// Public module exports (router, init, loadConfig, startBridge, stopBridge)
// and every REST route are preserved verbatim — server.js and the manage UI
// see no wire change.

const express = require('express');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const { bridgeConfigFile, bridgeHistoryFile, saveBridgeConfig } = require('./secure-config');
const {
  stripDispatchMarkers,
  createEchoStore,
  createLogStore,
  createGatewayLifecycle,
  createChatWsClient,
  chunkOutbound,
  deps: { fs },
} = require('./gateway-core');

let Lark = null;
function loadLark() {
  if (Lark) return Lark;
  try { Lark = require('@larksuiteoapi/node-sdk'); }
  catch (e) { throw new Error('@larksuiteoapi/node-sdk 未安装，请先 `npm install @larksuiteoapi/node-sdk`'); }
  return Lark;
}

const router = express.Router();

const CONFIG_FILE = bridgeConfigFile('feishu-config.json', path.join(__dirname, 'feishu-config.json'));
const GATEWAY_SESSION_ID = '__feishu_gateway__';
const GATEWAY_CWD = path.join(os.homedir(), '.multicc', 'feishu-gateway');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (_) { return { appId: '', appSecret: '', domain: 'feishu' }; }
}
function saveConfig(cfg) { saveBridgeConfig(CONFIG_FILE, cfg); }

// Injected deps — set by init()
let _persistedSessions = null;
let _chatSessions = null;
let _savePersistedSessions = null;
let _chatBroadcast = null;
let _port = 3000;

let _config = loadConfig();
let _running = false;

// Feishu SDK handles
let _wsClient = null;         // Lark.WSClient  (inbound long connection)
let _apiClient = null;        // Lark.Client    (outbound API)
let _botOpenId = null;        // reserved for future auth-scoped checks

// Most-recent chat we replied to (singleton model — same as every other bridge)
let _currentChatId = null;
let _currentReceiveIdType = 'chat_id';

let _startTime = null;

// Core plumbing — populated in init() once deps are known.
let _log = null;
let _logStore = null;
let _echo = null;
let _gateway = null;
let _chatWs = null;

function _resolveDomain(domain) {
  const L = loadLark();
  if (domain === 'lark') return L.Domain.Lark;
  if (domain === 'feishu' || !domain) return L.Domain.Feishu;
  return String(domain).replace(/\/+$/, '');
}

// ── Outbound (Feishu-specific) ───────────────────────────────────────
async function _sendFeishuText(text) {
  if (!_currentChatId || !_apiClient) {
    _log('system', `Reply ready but no Feishu chat attached: ${String(text).slice(0, 80)}…`);
    return;
  }
  const bodies = chunkOutbound(text, { max: 3800 });
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i];
    _echo.add(body);
    await _apiClient.im.message.create({
      params: { receive_id_type: _currentReceiveIdType },
      data: {
        receive_id: _currentChatId,
        msg_type: 'text',
        content: JSON.stringify({ text: body }),
      },
    });
    _log('out', body.length > 200 ? body.slice(0, 200) + '…' : body);
    if (i < bodies.length - 1) await new Promise(r => setTimeout(r, 400));
  }
}

// ── Inbound normalisation (Feishu-specific) ──────────────────────────
function _extractText(message) {
  try {
    const content = JSON.parse(message.content || '{}');
    if (message.message_type === 'text') {
      return String(content.text || '').replace(/@_user_\d+/g, '').trim();
    }
    if (message.message_type === 'post') {
      let out = '';
      const zh = content.zh_cn || content.en_us || {};
      for (const line of (zh.content || [])) {
        for (const seg of line) if (seg.text) out += seg.text;
        out += '\n';
      }
      return out.trim();
    }
  } catch (_) {}
  return '';
}

async function _onFeishuMessage(data) {
  try {
    const message = data?.message || {};
    const text = _extractText(message);
    if (message.chat_id) { _currentChatId = message.chat_id; _currentReceiveIdType = 'chat_id'; }

    if (!text.trim()) return;
    if (_echo.isEcho(text)) return;

    _log('in', `[Feishu] ${text.length > 200 ? text.slice(0, 200) + '…' : text}`);

    if (text.startsWith('/')) { await _handleCommand(text); return; }

    if (!_gateway.get()) {
      await _sendFeishuText('⚠ Feishu Gateway 未创建。请在 MultiCC 管理页面创建 Feishu Gateway。');
      return;
    }

    if (!_chatWs.isOpen()) _chatWs.connect();
    await _chatWs.ensureOpen(2000);
    _chatWs.sendUserMessage(text);
  } catch (e) { _log('error', `Inbound handling error: ${e.message}`); }
}

// ── Command handler (Feishu-specific /status) ────────────────────────
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
        `📱 应用: ${_config.appId ? '已配置' : '未配置'} (${uptime})`,
        `🤖 Gateway: ${rec ? rec.cli : '未创建'}`,
        `🔌 长连接: ${_wsClient ? '已建立' : '未建立'}`,
      ].join('\n');
      break;
    }
    case '/reset': _gateway.resetHistory(); reply = '✅ 已清空对话历史'; break;
    default: reply = `未知命令: ${cmd}，输入 /help 查看帮助`;
  }
  if (reply) { try { await _sendFeishuText(reply); } catch (e) { _log('error', e.message); } }
}

// ── Bridge lifecycle ─────────────────────────────────────────────────
async function startBridge() {
  if (_running) throw new Error('Bridge is already running');
  if (!_config.appId || !_config.appSecret) throw new Error('未配置飞书应用凭证（appId/appSecret）');
  if (!_gateway.get()) throw new Error('Feishu gateway 未创建，请先在管理页面创建。');

  const L = loadLark();
  _apiClient = new L.Client({
    appId: _config.appId,
    appSecret: _config.appSecret,
    appType: L.AppType.SelfBuild,
    domain: _resolveDomain(_config.domain),
  });

  const eventDispatcher = new L.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => { await _onFeishuMessage(data); },
  });

  _wsClient = new L.WSClient({
    appId: _config.appId,
    appSecret: _config.appSecret,
    domain: _resolveDomain(_config.domain),
    loggerLevel: L.LoggerLevel.info,
  });

  _running = true;
  _startTime = Date.now();
  _chatWs.connect();
  _wsClient.start({ eventDispatcher });
  _log('system', 'Feishu bridge started (WebSocket long connection)');
}

function stopBridge() {
  _running = false;
  if (_wsClient) { try { (_wsClient.close || _wsClient.stop)?.call(_wsClient); } catch (_) {} _wsClient = null; }
  _chatWs.disconnect();
  _apiClient = null;
  _log('system', 'Feishu bridge stopped');
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

  // The two lifecycle-owning objects depend on each other (lifecycle disconnects
  // the chat WS on switch/reset; chat WS asks the lifecycle whether the gateway
  // still exists before reconnecting), so we assemble them in two passes.
  const wsCtl = { disconnect: () => {}, reconnectIfRunning: () => {} };
  _gateway = createGatewayLifecycle({
    sessionId: GATEWAY_SESSION_ID,
    cwd: GATEWAY_CWD,
    label: 'Feishu Gateway',
    platformLabel: 'Feishu',
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
    onTurn: (t) => _sendFeishuText(t),
    hostLabel: 'Feishu',
  });
  wsCtl.disconnect = () => _chatWs.disconnect();
  wsCtl.reconnectIfRunning = () => _chatWs.reconnectIfRunning();
}

// ── REST API ─────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const rec = _gateway.get();
  res.json({
    running: _running,
    configured: !!(_config.appId && _config.appSecret),
    domain: _config.domain || 'feishu',
    startTime: _startTime ? new Date(_startTime).toISOString() : null,
    gateway: rec ? { id: rec.id, cli: rec.cli, cliSessionId: rec.cliSessionId || null } : null,
    wsConnected: !!_wsClient,
    chatConnected: _chatWs.isOpen(),
    currentChat: _currentChatId ? { chatId: _currentChatId } : null,
  });
});

router.get('/config', (req, res) => {
  res.json({ appId: _config.appId || '', domain: _config.domain || 'feishu', configured: !!(_config.appId && _config.appSecret) });
});

router.post('/config', (req, res) => {
  const { appId, appSecret, domain } = req.body || {};
  if (appId !== undefined) _config.appId = String(appId).trim();
  if (appSecret !== undefined) _config.appSecret = String(appSecret).trim();
  if (domain !== undefined) _config.domain = String(domain).trim() || 'feishu';
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
router.post('/stop', (req, res) => { stopBridge(); res.json({ ok: true }); });

router.post('/send', async (req, res) => {
  const { text, target, chatId } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  if (target === 'feishu') {
    if (chatId) { _currentChatId = chatId; _currentReceiveIdType = 'chat_id'; }
    if (!_currentChatId) return res.status(400).json({ error: 'No Feishu chat attached (provide chatId)' });
    if (!_apiClient) return res.status(400).json({ error: 'Bridge not started' });
    try { _echo.add(text); await _sendFeishuText(text); }
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
