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
const DEFAULT_ROUTER_CONFIG = {
  enabled: true,
  appendFooter: true,
  autoSwitchOnRoute: true,
  confidenceThreshold: 0.62,
  baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  model: process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001',
  apiKey: process.env.OPENROUTER_API_KEY || '',
};

// ── Config ──

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    cfg.router = { ...DEFAULT_ROUTER_CONFIG, ...(cfg.router || {}) };
    return cfg;
  } catch (_) {
    return { outputIdle: 5000, botToken: '', baseUrl: '', router: { ...DEFAULT_ROUTER_CONFIG } };
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

// Multi-session routing state. The dedicated __gateway__ chat remains the
// fallback/misc agent; specific routed tasks go to their own chat sessions.
let _currentSessionId = '';
const _sessionMemory = new Map();
const _lastRoutes = new Map();
const _routedWs = new Map();      // sessionId -> WebSocket
const _routedTurns = new Map();   // sessionId -> { text, inProgress }

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

// ── Multi-session router memory ──

function _routerConfig() {
  _config.router = { ...DEFAULT_ROUTER_CONFIG, ...(_config.router || {}) };
  return _config.router;
}

function _publicRouterConfig() {
  const r = _routerConfig();
  return {
    enabled: !!r.enabled,
    appendFooter: !!r.appendFooter,
    autoSwitchOnRoute: !!r.autoSwitchOnRoute,
    confidenceThreshold: Number(r.confidenceThreshold) || DEFAULT_ROUTER_CONFIG.confidenceThreshold,
    baseUrl: r.baseUrl || DEFAULT_ROUTER_CONFIG.baseUrl,
    model: r.model || DEFAULT_ROUTER_CONFIG.model,
    apiKey: r.apiKey ? `${r.apiKey.slice(0, 8)}****${r.apiKey.slice(-4)}` : '',
    hasKey: !!r.apiKey,
  };
}

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

function _findSessionByAlias(raw) {
  const key = String(raw || '').trim().replace(/^#/, '').toLowerCase();
  if (!key) return null;
  if (_persistedSessions?.has(key)) return key;
  for (const mem of _memorySnapshot()) {
    if (mem.id.toLowerCase() === key || mem.id.toLowerCase().startsWith(key)) return mem.id;
    if ((mem.label || '').toLowerCase() === key) return mem.id;
    if ((mem.aliases || []).some(a => a === key || a.startsWith(key))) return mem.id;
  }
  return null;
}

function _scoreSessionForText(mem, text) {
  const lower = text.toLowerCase();
  let score = 0;
  if (lower.includes(mem.id.toLowerCase())) score += 5;
  if (mem.label && lower.includes(mem.label.toLowerCase())) score += 4;
  for (const a of mem.aliases || []) {
    if (a.length >= 2 && lower.includes(a)) score += Math.min(3, Math.max(1, a.length / 4));
  }
  const recent = `${mem.lastInput || ''}\n${mem.lastOutput || ''}`.toLowerCase();
  for (const token of lower.split(/[\s,，。！？!?:：;；#]+/).filter(t => t.length >= 2)) {
    if (recent.includes(token)) score += 0.6;
  }
  if (mem.status === 'waiting' && /^(可以|好|行|确认|继续|按|不用|不要|是|否|yes|no)\b/i.test(text.trim())) score += 2.5;
  return score;
}

function _heuristicRoute(text) {
  const direct = text.match(/^#?([A-Za-z0-9][\w.-]{1,64})\s+(.+)/);
  if (direct) {
    const sid = _findSessionByAlias(direct[1]);
    if (sid) return { action: 'route_to_session', sessionId: sid, confidence: 0.95, text: direct[2], reason: 'message prefix matched session alias' };
  }
  const scored = _memorySnapshot()
    .filter(m => m.routable)
    .map(mem => ({ mem, score: _scoreSessionForText(mem, text) }))
    .sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score <= 0) return null;
  const confidence = Math.min(0.9, scored[0].score / 6);
  return { action: 'route_to_session', sessionId: scored[0].mem.id, confidence, reason: `matched memory tokens (${scored[0].score.toFixed(1)})` };
}

async function _llmRoute(text) {
  const cfg = _routerConfig();
  if (!cfg.enabled || !cfg.apiKey) return null;
  const sessions = _memorySnapshot(20).map(m => ({
    id: m.id, label: m.label, cli: m.cli, kind: m.kind, cwd: m.cwd,
    routable: m.routable, status: m.status, aliases: m.aliases,
    lastInput: (m.lastInput || '').slice(-300),
    lastOutput: (m.lastOutput || '').slice(-500),
  }));
  const prompt = [
    'You are a gateway router for a WeChat chat controlling multiple coding sessions.',
    'Return only compact JSON. Choose one action: route_to_session, switch_default, gateway_answer, ask_clarify.',
    'Only route_to_session to routable chat sessions. Use gateway_answer for meta/status/help/general gateway tasks.',
    'Use ask_clarify when ambiguous. Never invent a session id.',
    'Schema: {"action":"route_to_session","sessionId":"...","confidence":0.0,"reason":"...","answer":"optional","question":"optional"}',
    '',
    `Current session: ${_currentSessionId || ''}`,
    `Sessions: ${JSON.stringify(sessions)}`,
    `User message: ${JSON.stringify(text)}`,
  ].join('\n');

  try {
    const res = await fetch(`${String(cfg.baseUrl || '').replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], temperature: 0 }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`router LLM ${res.status}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const json = content.match(/\{[\s\S]*\}/)?.[0] || content;
    const parsed = JSON.parse(json);
    if (parsed.sessionId) {
      const mem = _refreshSessionMemory(parsed.sessionId);
      if (!mem || !mem.routable) parsed.action = 'ask_clarify';
    }
    return parsed;
  } catch (e) {
    _log('error', `Gateway router failed: ${e.message}`);
    return null;
  }
}

async function _decideRoute(text) {
  const cfg = _routerConfig();
  if (!cfg.enabled) return { action: 'gateway_answer', confidence: 1, reason: 'router disabled' };

  const switchMatch = text.match(/^(?:\/use|\/bind|切到|切换到)\s+#?(.+)$/i);
  if (switchMatch) {
    const sid = _findSessionByAlias(switchMatch[1]);
    if (sid) return { action: 'switch_default', sessionId: sid, confidence: 1, reason: 'manual switch' };
  }

  const heuristic = _heuristicRoute(text);
  const llm = await _llmRoute(text);
  const chosen = llm || heuristic;
  if (chosen?.action === 'route_to_session' && chosen.confidence < cfg.confidenceThreshold) {
    return { ...chosen, action: 'ask_clarify' };
  }
  if (chosen) return chosen;
  if (_currentSessionId) return { action: 'route_to_session', sessionId: _currentSessionId, confidence: 0.25, reason: 'fallback to current session' };
  return { action: 'gateway_answer', confidence: 0.4, reason: 'no matching session' };
}

function _rememberRoute(decision) {
  _lastRoutes.set(_currentUserId || 'default', { ...decision, ts: Date.now() });
  if (decision.sessionId) {
    const mem = _refreshSessionMemory(decision.sessionId);
    if (mem) {
      mem.lastRouteReason = decision.reason || '';
      mem.updatedAt = Date.now();
    }
  }
}

function _formatFooter(sessionId, handledByGateway = false) {
  if (!_routerConfig().appendFooter) return '';
  const target = sessionId ? _sessionLabel(sessionId) : (handledByGateway ? 'Gateway' : '(none)');
  const cur = _currentSessionId ? _sessionLabel(_currentSessionId) : '(none)';
  return `\n\n-- 本次: ${target}\n-- 当前: ${cur}`;
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

async function _askClarify(decision) {
  const sessions = _memorySnapshot(6).filter(m => m.routable);
  const lines = [decision?.question || '这条消息不确定应该发给哪个 session。'];
  sessions.forEach((m, idx) => lines.push(`${idx + 1}. ${m.id}${m.label && m.label !== m.id ? ` / ${m.label}` : ''} — ${m.status}`));
  lines.push('请回复 /use <id> 切换，或用 #session 消息 直接发送。');
  await _sendWeChatText(lines.join('\n') + _formatFooter(null, true));
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

function _disconnectRoutedWs() {
  for (const ws of _routedWs.values()) {
    try { ws.close(); } catch (_) {}
  }
  _routedWs.clear();
  _routedTurns.clear();
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

function _connectRoutedWs(sessionId) {
  const existing = _routedWs.get(sessionId);
  if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return existing;
  const p = _persistedSessions?.get(sessionId);
  if (!p || p.kind !== 'chat' || p.type === 'gateway') return null;
  const url = `ws://127.0.0.1:${_port}/ws/chat?session=${encodeURIComponent(sessionId)}`;
  const ws = new WebSocket(url);
  _routedWs.set(sessionId, ws);
  _routedTurns.set(sessionId, { text: '', inProgress: false });

  ws.on('open', () => _log('system', `Connected to routed chat session ${sessionId}`));
  ws.on('message', (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch (_) { return; }
    _handleRoutedChatEvent(sessionId, evt);
  });
  ws.on('close', () => {
    if (_routedWs.get(sessionId) === ws) _routedWs.delete(sessionId);
  });
  ws.on('error', (e) => _log('error', `Routed chat WS ${sessionId}: ${e.message}`));
  return ws;
}

async function _sendToRoutedSession(sessionId, text) {
  let ws = _connectRoutedWs(sessionId);
  if (!ws) return false;
  if (ws.readyState === WebSocket.CONNECTING) {
    await new Promise(r => {
      const t = setTimeout(r, 2000);
      ws.once('open', () => { clearTimeout(t); r(); });
    });
  }
  if (ws.readyState !== WebSocket.OPEN) return false;
  const turn = _routedTurns.get(sessionId) || { text: '', inProgress: false };
  turn.text = '';
  turn.inProgress = true;
  _routedTurns.set(sessionId, turn);
  ws.send(JSON.stringify({ type: 'user_message', text }));
  const mem = _refreshSessionMemory(sessionId);
  if (mem) {
    mem.lastInput = text;
    mem.status = 'thinking';
    mem.updatedAt = Date.now();
  }
  return true;
}

function _handleRoutedChatEvent(sessionId, evt) {
  const turn = _routedTurns.get(sessionId) || { text: '', inProgress: false };
  if (evt.type === 'assistant' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'text' && block.text) turn.text += block.text;
    }
    _routedTurns.set(sessionId, turn);
    return;
  }
  if (evt.type === 'result') {
    const text = (turn.text || '').trim();
    turn.text = '';
    turn.inProgress = false;
    _routedTurns.set(sessionId, turn);
    const mem = _refreshSessionMemory(sessionId);
    if (mem && text) {
      mem.lastOutput = `${mem.lastOutput || ''}\n${text}`.slice(-1600);
      mem.status = /(\?|？|确认|是否|请选择|waiting|需要你|请回复)/i.test(text) ? 'waiting' : 'idle';
      mem.updatedAt = Date.now();
    }
    if (text) {
      _sendWeChatText(text + _formatFooter(sessionId)).catch(e => {
        _log('error', `Send routed reply failed: ${e.message}`);
      });
    }
    return;
  }
  if (evt.type === 'error') {
    turn.inProgress = false;
    _routedTurns.set(sessionId, turn);
    _log('error', `Routed ${sessionId}: ${evt.error || 'unknown error'}`);
  }
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
  try { await _sendWeChatText(text + _formatFooter(null, true)); }
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
        '/sessions — 列出可路由 chat session',
        '/use <id> — 手动切换当前 session',
        '/where — 查看当前 session',
        '/why — 查看上一条路由原因',
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
        `📌 当前: ${_currentSessionId ? _sessionLabel(_currentSessionId) : '(none)'}`,
      ].join('\n');
      break;
    }
    case '/sessions': {
      const lines = ['📂 可路由 chat session:'];
      for (const mem of _memorySnapshot().filter(m => m.routable)) {
        const mark = mem.id === _currentSessionId ? ' ← 当前' : '';
        lines.push(`  ${mem.id}${mem.label && mem.label !== mem.id ? ` / ${mem.label}` : ''} — ${mem.status}${mark}`);
      }
      reply = lines.length === 1 ? '没有可路由的 chat session' : lines.join('\n');
      break;
    }
    case '/use':
    case '/bind': {
      const target = parts[1];
      if (!target) { reply = '用法: /use <session-id-or-alias>'; break; }
      const sid = _findSessionByAlias(target);
      const mem = sid ? _refreshSessionMemory(sid) : null;
      if (!mem || !mem.routable) {
        reply = `会话 "${target}" 不存在或不是 chat session。使用 /sessions 查看可用会话。`;
        break;
      }
      _currentSessionId = sid;
      reply = `✅ 当前会话: ${_sessionLabel(sid)}`;
      break;
    }
    case '/where':
      reply = _currentSessionId ? `当前会话: ${_sessionLabel(_currentSessionId)}` : '当前没有绑定具体 session';
      break;
    case '/why': {
      const last = _lastRoutes.get(_currentUserId || 'default');
      reply = last
        ? `上一条路由: ${last.action}${last.sessionId ? ` → ${_sessionLabel(last.sessionId)}` : ''}\n置信度: ${last.confidence ?? 'N/A'}\n原因: ${last.reason || '(none)'}`
        : '还没有路由记录';
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
    try { await _sendWeChatText(reply + _formatFooter(null, true)); }
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
        const decision = await _decideRoute(text);
        _rememberRoute(decision);

        if (decision.action === 'ask_clarify') {
          await _askClarify(decision);
          continue;
        }

        if (decision.action === 'gateway_answer' && decision.answer) {
          await _sendWeChatText(decision.answer + _formatFooter(null, true));
          continue;
        }

        if (decision.action === 'switch_default') {
          _currentSessionId = decision.sessionId;
          await _sendWeChatText(`✅ 当前会话: ${_sessionLabel(decision.sessionId)}${_formatFooter(decision.sessionId)}`);
          continue;
        }

        if (decision.action === 'route_to_session' && decision.sessionId) {
          if (_routerConfig().autoSwitchOnRoute) _currentSessionId = decision.sessionId;
          const routedText = decision.text || text;
          const ok = await _sendToRoutedSession(decision.sessionId, routedText);
          if (ok) {
            await _sendWeChatText(`→ ${_sessionLabel(decision.sessionId)} 已发送${_formatFooter(decision.sessionId)}`);
            continue;
          }
          await _sendWeChatText(`⚠ 无法发送到 ${_sessionLabel(decision.sessionId)}，已转交 Gateway。${_formatFooter(null, true)}`);
        }

        // Fallback/misc path: keep main's dedicated gateway chat behavior.
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
    router: { enabled: !!_routerConfig().enabled, currentSessionId: _currentSessionId || null, memoryCount: _memorySnapshot().length },
    chatConnected: !!(_chatWs && _chatWs.readyState === WebSocket.OPEN),
    currentUser: _currentUserId ? { hasToken: !!_currentContextToken } : null,
  });
});

// Config (idle timeout etc)
router.get('/config', (req, res) => {
  res.json({
    outputIdle: _config.outputIdle || 5000,
    loggedIn: !!_config.botToken,
    router: _publicRouterConfig(),
  });
});

router.post('/config', (req, res) => {
  const { outputIdle, router: routerConfig } = req.body;
  if (outputIdle !== undefined) _config.outputIdle = Number(outputIdle) || 5000;
  if (routerConfig && typeof routerConfig === 'object') {
    const current = _routerConfig();
    for (const key of ['enabled', 'appendFooter', 'autoSwitchOnRoute']) {
      if (routerConfig[key] !== undefined) current[key] = !!routerConfig[key];
    }
    if (routerConfig.confidenceThreshold !== undefined) {
      const n = Number(routerConfig.confidenceThreshold);
      if (!Number.isNaN(n)) current.confidenceThreshold = Math.max(0.1, Math.min(0.95, n));
    }
    if (routerConfig.baseUrl !== undefined) current.baseUrl = String(routerConfig.baseUrl || '').trim();
    if (routerConfig.model !== undefined) current.model = String(routerConfig.model || '').trim();
    if (routerConfig.apiKey !== undefined && !String(routerConfig.apiKey).includes('****')) {
      current.apiKey = String(routerConfig.apiKey || '').trim();
    }
    _config.router = current;
  }
  saveConfig(_config);
  res.json({ ok: true });
});

router.get('/gateway/memory', (req, res) => {
  res.json({
    router: _publicRouterConfig(),
    currentSessionId: _currentSessionId || null,
    sessions: _memorySnapshot().map(m => ({
      id: m.id,
      label: m.label,
      cli: m.cli,
      kind: m.kind,
      cwd: m.cwd,
      active: m.active,
      routable: m.routable,
      status: m.status,
      aliases: m.aliases,
      lastInput: m.lastInput,
      lastOutput: m.lastOutput,
      lastRouteReason: m.lastRouteReason,
      updatedAt: m.updatedAt,
    })),
  });
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
    if (req.body?.router && typeof req.body.router === 'object') _config.router = { ..._routerConfig(), ...req.body.router };
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
  _currentSessionId = '';
  _disconnectRoutedWs();
  _log('system', 'Logged out');
  res.json({ ok: true });
});

module.exports = { router, init, loadConfig, startBridge, stopBridge };
