'use strict';
// Slack IM bridge — thin adapter atop plugins/bridges/gateway-core.
//
// Slack-specific concerns kept here:
//   • @slack/bolt Socket Mode App bring-up,
//   • bot user id detection (via auth.test) so we can drop self messages,
//   • rich_text-block flattening for inbound event text,
//   • outbound app.client.chat.postMessage with ~3500-char chunking,
//   • config (botToken, appToken) + /config,
//   • /status shape (socketConnected, currentChannel).

const express = require('express');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const { bridgeConfigFile, bridgeHistoryFile, saveBridgeConfig } = require('./secure-config');
const {
  createEchoStore, createLogStore, createGatewayLifecycle, createChatWsClient, chunkOutbound,
  deps: { fs },
} = require('./gateway-core');

let SlackBolt = null;
function loadSlack() {
  if (SlackBolt) return SlackBolt;
  try { SlackBolt = require('@slack/bolt'); }
  catch (e) { throw new Error('@slack/bolt 未安装，请先 npm install @slack/bolt'); }
  return SlackBolt;
}

const router = express.Router();

const CONFIG_FILE = bridgeConfigFile('slack-config.json', path.join(__dirname, 'slack-config.json'));
const GATEWAY_SESSION_ID = '__slack_gateway__';
const GATEWAY_CWD = path.join(os.homedir(), '.multicc', 'slack-gateway');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (_) { return { botToken: '', appToken: '' }; }
}
function saveConfig(cfg) { saveBridgeConfig(CONFIG_FILE, cfg); }

let _persistedSessions = null;
let _chatSessions = null;
let _savePersistedSessions = null;
let _chatBroadcast = null;
let _port = 3000;

let _config = loadConfig();
let _running = false;

let _app = null;
let _botUserId = null;
let _currentChannel = null;
let _startTime = null;

let _log = null;
let _logStore = null;
let _echo = null;
let _gateway = null;
let _chatWs = null;

// ── Outbound ─────────────────────────────────────────────────────────
async function _sendSlackText(text) {
  if (!_currentChannel || !_app) {
    _log('system', `Reply ready but no Slack channel attached: ${String(text).slice(0, 80)}…`);
    return;
  }
  const bodies = chunkOutbound(text, { max: 3500 });
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i];
    _echo.add(body);
    await _app.client.chat.postMessage({ channel: _currentChannel, text: body });
    _log('out', body.length > 200 ? body.slice(0, 200) + '…' : body);
    if (i < bodies.length - 1) await new Promise(r => setTimeout(r, 400));
  }
}

// ── Inbound normalisation (Slack rich_text blocks) ───────────────────
function _extractTextFromSlackBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return '';
  const parts = [];

  function renderInline(elements) {
    const out = [];
    for (const el of elements || []) {
      const type = el?.type || '';
      if (type === 'text') out.push(el.text || '');
      else if (type === 'link') out.push(el.text || el.url || '');
      else if (type === 'user') out.push(`<@${el.user_id || ''}>`);
      else if (type === 'channel') out.push(`<#${el.channel_id || ''}>`);
      else if (type === 'emoji') out.push(`:${el.name || ''}:`);
      else if (type === 'date') out.push(el.fallback || '');
      else if (el?.elements) out.push(renderInline(el.elements));
    }
    return out.join('');
  }

  function walk(elements, quoteDepth = 0, bullet = '') {
    for (const el of elements || []) {
      const type = el?.type || '';
      if (type === 'rich_text_section') {
        const line = renderInline(el.elements).trim();
        if (line) parts.push(`${quoteDepth ? '>'.repeat(quoteDepth) + ' ' : ''}${bullet}${line}`);
      } else if (type === 'rich_text_quote') {
        walk(el.elements, quoteDepth + 1, bullet);
      } else if (type === 'rich_text_list') {
        for (const [idx, item] of (el.elements || []).entries()) {
          walk([item], quoteDepth, el.style === 'ordered' ? `${idx + 1}. ` : '• ');
        }
      } else if (type === 'rich_text_preformatted') {
        const line = renderInline(el.elements).trim();
        if (line) parts.push('```\n' + line + '\n```');
      } else if (el?.elements) {
        walk(el.elements, quoteDepth, bullet);
      }
    }
  }

  for (const block of blocks) {
    if (block?.type === 'rich_text') walk(block.elements);
  }
  return parts.join('\n').trim();
}

function _extractText(event) {
  let text = String(event?.text || '').trim();
  const blocksText = _extractTextFromSlackBlocks(event?.blocks);
  if (blocksText && !text.includes(blocksText)) {
    text = (text + '\n' + blocksText).trim();
  }
  if (_botUserId) text = text.replace(new RegExp(`<@${_botUserId}>`, 'g'), '').trim();
  return text;
}

async function _onSlackMessage(event) {
  try {
    if (!event) return;
    if (event.bot_id) return;
    if (event.user && _botUserId && event.user === _botUserId) return;
    if (['bot_message', 'message_changed', 'message_deleted'].includes(event.subtype)) return;

    const text = _extractText(event);
    if (event.channel) _currentChannel = event.channel;

    if (!text.trim()) return;
    if (_echo.isEcho(text)) return;

    _log('in', `[Slack] ${text.length > 200 ? text.slice(0, 200) + '…' : text}`);

    if (text.startsWith('/')) { await _handleCommand(text); return; }

    if (!_gateway.get()) {
      await _sendSlackText('⚠ Slack Gateway 未创建。请在 MultiCC 管理页面创建 Slack Gateway。');
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
        `📱 应用: ${_config.botToken && _config.appToken ? '已配置' : '未配置'} (${uptime})`,
        `🤖 Gateway: ${rec ? rec.cli : '未创建'}`,
        `🔌 Socket Mode: ${_app ? '已建立' : '未建立'}`,
      ].join('\n');
      break;
    }
    case '/reset': _gateway.resetHistory(); reply = '✅ 已清空对话历史'; break;
    default: reply = `未知命令: ${cmd}，输入 /help 查看帮助`;
  }
  if (reply) { try { await _sendSlackText(reply); } catch (e) { _log('error', e.message); } }
}

// ── Bridge lifecycle ─────────────────────────────────────────────────
async function startBridge() {
  if (_running) throw new Error('Bridge is already running');
  if (!_config.botToken || !_config.appToken) throw new Error('未配置 Slack 应用凭证（botToken/appToken）');
  if (!_gateway.get()) throw new Error('Slack gateway 未创建，请先在管理页面创建。');

  const { App } = loadSlack();
  _app = new App({
    token: _config.botToken,
    appToken: _config.appToken,
    socketMode: true,
  });

  try {
    const auth = await _app.client.auth.test();
    _botUserId = auth.user_id || null;
  } catch (e) {
    _app = null;
    throw new Error(`Slack auth.test failed: ${e.message}`);
  }

  _app.event('message', async ({ event }) => { await _onSlackMessage(event); });

  _running = true;
  _startTime = Date.now();
  _chatWs.connect();
  try {
    await _app.start();
  } catch (e) {
    _running = false;
    _chatWs.disconnect();
    _app = null;
    _botUserId = null;
    throw e;
  }
  _log('system', 'Slack bridge started (Socket Mode)');
}

function stopBridge() {
  _running = false;
  if (_app) {
    try {
      const stopped = _app.stop?.();
      if (stopped && typeof stopped.catch === 'function') stopped.catch(e => _log('error', `Slack stop failed: ${e.message}`));
    } catch (_) {}
    _app = null;
  }
  _chatWs.disconnect();
  _botUserId = null;
  _log('system', 'Slack bridge stopped');
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
    label: 'Slack Gateway',
    platformLabel: 'Slack',
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
    onTurn: (t) => _sendSlackText(t),
    hostLabel: 'Slack',
  });
  wsCtl.disconnect = () => _chatWs.disconnect();
  wsCtl.reconnectIfRunning = () => _chatWs.reconnectIfRunning();
}

// ── REST API ─────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const rec = _gateway.get();
  res.json({
    running: _running,
    configured: !!(_config.botToken && _config.appToken),
    startTime: _startTime ? new Date(_startTime).toISOString() : null,
    gateway: rec ? { id: rec.id, cli: rec.cli, cliSessionId: rec.cliSessionId || null } : null,
    socketConnected: !!_app,
    chatConnected: _chatWs.isOpen(),
    currentChannel: _currentChannel ? { channel: _currentChannel } : null,
  });
});

router.get('/config', (req, res) => {
  res.json({
    configured: !!(_config.botToken && _config.appToken),
    botTokenConfigured: !!_config.botToken,
    appTokenConfigured: !!_config.appToken,
  });
});

router.post('/config', (req, res) => {
  const { botToken, appToken } = req.body || {};
  if (botToken !== undefined) _config.botToken = String(botToken).trim();
  if (appToken !== undefined) _config.appToken = String(appToken).trim();
  saveConfig(_config);
  res.json({ ok: true, configured: !!(_config.botToken && _config.appToken) });
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
  const { text, target, channel, chatId } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  if (target === 'slack') {
    if (channel || chatId) _currentChannel = channel || chatId;
    if (!_currentChannel) return res.status(400).json({ error: 'No Slack channel attached (provide channel)' });
    if (!_app) return res.status(400).json({ error: 'Bridge not started' });
    try { _echo.add(text); await _sendSlackText(text); }
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
