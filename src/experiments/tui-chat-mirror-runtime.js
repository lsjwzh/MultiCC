'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const tmux = require('../tmux');

const EXPERIMENT_MODE = 'tui-chat-mirror';
const EXPERIMENT_ENV = 'MULTICC_EXPERIMENT_TUI_CHAT';

function isEnabled(value = process.env[EXPERIMENT_ENV]) {
  return value === '1' || value === 'true';
}

function ownsSession(record) {
  return !!record && record.experimentalMode === EXPERIMENT_MODE;
}

function validateExperimentalSession({ enabled, cli, kind, experimentalMode }) {
  if (!experimentalMode) return { ok: true, mode: null };
  if (experimentalMode !== EXPERIMENT_MODE) {
    return { ok: false, error: 'unknown experimentalMode' };
  }
  if (!enabled) {
    return { ok: false, error: `${EXPERIMENT_ENV}=1 is required for ${EXPERIMENT_MODE}` };
  }
  if (cli !== 'codex' || kind !== 'chat') {
    return { ok: false, error: `${EXPERIMENT_MODE} requires cli=codex and kind=chat` };
  }
  return { ok: true, mode: EXPERIMENT_MODE };
}

function createTuiChatMirrorRuntime(options = {}) {
  const enabled = options.enabled === true;
  const records = options.records;
  const cwdForSession = options.cwdForSession;
  const providerFor = options.providerFor;
  const send = options.send;
  const setSessionStatus = options.setSessionStatus || (() => {});
  const saveBestEffort = options.saveBestEffort || (() => {});
  const logger = options.logger || console;
  const sessionsRoot = options.sessionsRoot
    || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const timers = options.timers || { setInterval, clearInterval, setTimeout };
  const tmuxApi = options.tmux || tmux;
  const controllers = new Map();

  if (!(records instanceof Map)) throw new TypeError('tui chat mirror records Map is required');
  if (typeof cwdForSession !== 'function') throw new TypeError('tui chat mirror cwdForSession is required');
  if (typeof providerFor !== 'function') throw new TypeError('tui chat mirror providerFor is required');
  if (typeof send !== 'function') throw new TypeError('tui chat mirror send is required');

  function owns(record) {
    return enabled && ownsSession(record);
  }

  async function controllerFor(sessionId) {
    const record = records.get(sessionId);
    if (!record || !owns(record)) return null;
    let controller = controllers.get(sessionId);
    if (controller) return controller;
    controller = createController({
      sessionId,
      record,
      cwd: cwdForSession(record),
      provider: providerFor(record),
      sessionsRoot,
      send,
      setSessionStatus,
      saveBestEffort,
      logger,
      timers,
      tmuxApi,
    });
    controllers.set(sessionId, controller);
    try {
      await controller.start();
      return controller;
    } catch (error) {
      controllers.delete(sessionId);
      throw error;
    }
  }

  async function admit(sessionId, text, options = {}) {
    const record = records.get(sessionId);
    if (!owns(record)) return null;
    const controller = await controllerFor(sessionId);
    return controller.admit(String(text || ''), options);
  }

  async function handleWs(ws, req, urlObj) {
    const sessionId = urlObj.searchParams.get('session') || '';
    const record = records.get(sessionId);
    if (!record || !ownsSession(record)) return false;
    if (!enabled) {
      send(ws, { type: 'error', error: `${EXPERIMENT_MODE} is disabled on this server` });
      ws.close();
      return true;
    }
    try {
      const controller = await controllerFor(sessionId);
      controller.attach(ws);
    } catch (error) {
      logger.error?.('tui_chat_mirror_attach_failed', {
        sessionId,
        error: publicError(error),
      });
      send(ws, { type: 'error', error: `实验 TUI 启动失败：${publicError(error)}` });
      ws.close();
    }
    return true;
  }

  function stop() {
    for (const controller of controllers.values()) controller.stop();
    controllers.clear();
  }

  return Object.freeze({
    enabled,
    mode: EXPERIMENT_MODE,
    owns,
    admit,
    handleWs,
    stop,
  });
}

function createController({
  sessionId,
  record,
  cwd,
  provider,
  sessionsRoot,
  send,
  setSessionStatus,
  saveBestEffort,
  logger,
  timers,
  tmuxApi,
}) {
  const runtimeId = `${sessionId}-tui-mirror`;
  const clients = new Set();
  const messages = [];
  const messageIds = new Set();
  const pendingAdmissions = [];
  const turns = new Map();
  const startedAt = Date.now();
  let currentTurnId = null;
  let rolloutFile = null;
  let rolloutOffset = 0;
  let rolloutRemainder = '';
  let pollTimer = null;
  let readinessTimer = null;
  let running = false;
  let ready = typeof tmuxApi.tmuxCapturePane !== 'function';
  let trustPending = false;
  let trustAnnounced = false;
  let injecting = false;
  let started = false;
  let stopped = false;
  let nativeSessionId = record.cliSessionId || null;
  const inputQueue = [];
  const trustRequestId = `tui-trust:${sessionId}`;

  async function start() {
    if (started) return;
    if (!cwd || !fs.existsSync(cwd)) throw new Error('experimental session workspace is unavailable');
    if (!await tmuxApi.tmuxHasSession(runtimeId)) {
      const command = terminalCommand(provider, record);
      await tmuxApi.tmuxCreateSession(runtimeId, cwd, 120, 40, command, {});
    }
    await discoverAndHydrate();
    pollTimer = timers.setInterval(poll, 250);
    readinessTimer = timers.setInterval(pollReadiness, 300);
    pollTimer.unref?.();
    readinessTimer.unref?.();
    pollReadiness();
    started = true;
  }

  async function pollReadiness() {
    if (stopped || ready || typeof tmuxApi.tmuxCapturePane !== 'function') return;
    let pane;
    try { pane = await tmuxApi.tmuxCapturePane(runtimeId); } catch { return; }
    const visible = String(pane || '').split('\n').slice(-45).join('\n');
    const interactivePrompt = /OpenAI Codex/.test(visible) && /(?:^|\n)›\s/.test(visible);
    // Inline/no-alt-screen mode intentionally preserves the old trust prompt in
    // scrollback. A live Codex banner plus composer prompt takes precedence.
    if (interactivePrompt || /\bReady\b/.test(visible) || rolloutFile) {
      markReady();
      return;
    }
    if (/Do you trust the contents of this directory\?/i.test(visible)) {
      trustPending = true;
      announceTrust();
      return;
    }
  }

  function markReady() {
    if (ready) return;
    ready = true;
    trustPending = false;
    broadcast({ type: 'system', message: '🧪 Codex TUI 已就绪，开始投递实验消息。' });
    flushInputQueue();
  }

  function announceTrust(target) {
    const payload = {
      type: 'user_input_required',
      requestId: trustRequestId,
      question: `实验 TUI 首次打开工作树，需要确认是否信任目录：${cwd}`,
      options: ['Yes, continue', 'No, quit'],
      allowMultiple: false,
    };
    if (target) send(target, payload);
    else if (!trustAnnounced) {
      trustAnnounced = true;
      broadcast(payload);
    }
  }

  async function discoverAndHydrate() {
    if (!rolloutFile) rolloutFile = findRolloutFile({ sessionsRoot, cwd, nativeSessionId, sinceMs: startedAt - 10000 });
    if (!rolloutFile) return;
    const content = fs.readFileSync(rolloutFile, 'utf8');
    const complete = content.endsWith('\n') ? content : content.slice(0, content.lastIndexOf('\n') + 1);
    rolloutRemainder = content.slice(complete.length);
    rolloutOffset = Buffer.byteLength(content);
    for (const line of complete.split('\n')) consumeLine(line, false);
  }

  function poll() {
    if (stopped) return;
    if (!rolloutFile) {
      rolloutFile = findRolloutFile({ sessionsRoot, cwd, nativeSessionId, sinceMs: startedAt - 10000 });
      if (!rolloutFile) return;
    }
    fs.stat(rolloutFile, (statError, stat) => {
      if (statError || stat.size <= rolloutOffset) return;
      const length = stat.size - rolloutOffset;
      const buffer = Buffer.alloc(length);
      fs.open(rolloutFile, 'r', (openError, fd) => {
        if (openError) return;
        fs.read(fd, buffer, 0, length, rolloutOffset, (readError, bytesRead) => {
          fs.close(fd, () => {});
          if (readError || !bytesRead) return;
          rolloutOffset += bytesRead;
          const lines = (rolloutRemainder + buffer.subarray(0, bytesRead).toString('utf8')).split('\n');
          rolloutRemainder = lines.pop() || '';
          for (const line of lines) consumeLine(line, true);
        });
      });
    });
  }

  function consumeLine(line, live) {
    if (!line.trim()) return;
    let raw;
    try { raw = JSON.parse(line); } catch { return; }
    const event = projectRecord(raw, currentTurnId);
    if (!event) return;
    if (event.kind === 'session_meta') {
      if (event.sessionId && !nativeSessionId) {
        nativeSessionId = event.sessionId;
        record.cliSessionId = nativeSessionId;
        saveBestEffort('experiment.tui-chat-native-session');
      }
      return;
    }
    if (event.kind === 'turn_start') {
      currentTurnId = event.turnId || `turn-${event.at}`;
      event.turnId = currentTurnId;
      running = true;
      turns.set(currentTurnId, { assistantText: '', tools: [] });
      setSessionStatus(sessionId, { status: 'running', currentFile: null });
      if (live) broadcast({ type: 'stream_event', event: { type: 'message_start', message: {} } });
      return;
    }
    event.turnId = event.turnId || currentTurnId;
    if (event.kind === 'user') {
      const pending = takePendingAdmission(event.text);
      addMessage({
        id: `tui-user-${event.id}`,
        role: 'user',
        content: event.text,
        clientMsgId: pending?.clientMsgId || `tui-${event.id}`,
        ts: Date.parse(event.at) || Date.now(),
      });
      if (live && !pending) {
        broadcast({
          type: 'session_queue',
          event: 'queued',
          queued: false,
          message: event.text,
          clientMsgId: `tui-${event.id}`,
          items: [],
          state: running ? 'running' : 'idle',
        });
      }
      return;
    }
    const turn = ensureTurn(event.turnId);
    if (event.kind === 'assistant') {
      turn.assistantText = appendText(turn.assistantText, event.text);
      upsertAssistantMessage(event.turnId, turn, !running);
      if (live) {
        broadcast({
          type: 'assistant',
          message: { textSnapshot: true, content: [{ type: 'text', text: turn.assistantText }] },
        });
      }
      return;
    }
    if (event.kind === 'tool_start') {
      const tool = {
        id: event.callId || `tool-${event.id}`,
        name: event.name || 'Tool',
        input: parseToolInput(event.input),
      };
      if (!turn.tools.some(item => item.id === tool.id)) turn.tools.push(tool);
      upsertAssistantMessage(event.turnId, turn, !running);
      if (live) {
        broadcast({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input }] },
        });
      }
      return;
    }
    if (event.kind === 'tool_result') {
      const tool = turn.tools.find(item => item.id === event.callId);
      if (tool) {
        tool.result = event.text;
        tool.is_error = event.isError === true;
      }
      upsertAssistantMessage(event.turnId, turn, !running);
      if (live) {
        broadcast({
          type: 'user',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: event.callId,
              content: event.text,
              is_error: event.isError === true,
            }],
          },
        });
      }
      return;
    }
    if (event.kind === 'turn_complete') {
      running = false;
      upsertAssistantMessage(event.turnId, turn, true);
      setSessionStatus(sessionId, { status: 'idle', currentFile: null });
      if (live) {
        broadcast({ type: 'result', durationMs: event.durationMs || null, usage: null });
        broadcast({ type: 'stream_end' });
      }
      currentTurnId = null;
      timers.setTimeout(flushInputQueue, 100);
      return;
    }
    if (event.kind === 'error') {
      running = false;
      setSessionStatus(sessionId, { status: 'error', currentFile: null });
      if (live) broadcast({ type: 'error', error: event.text || 'TUI experiment failed' });
    }
  }

  function ensureTurn(turnId) {
    const key = turnId || currentTurnId || 'unknown';
    let turn = turns.get(key);
    if (!turn) {
      turn = { assistantText: '', tools: [] };
      turns.set(key, turn);
    }
    return turn;
  }

  function addMessage(message) {
    if (!message.id || messageIds.has(message.id)) return;
    messageIds.add(message.id);
    messages.push(message);
  }

  function upsertAssistantMessage(turnId, turn, complete) {
    const id = `tui-assistant-${turnId || 'unknown'}`;
    let message = messages.find(item => item.id === id);
    if (!message) {
      message = { id, role: 'assistant', content: '', tools: [], ts: Date.now() };
      messages.push(message);
      messageIds.add(id);
    }
    message.content = turn.assistantText;
    message.tools = turn.tools.map(tool => ({ ...tool }));
    message.streaming = !complete;
  }

  function takePendingAdmission(text) {
    const exact = pendingAdmissions.findIndex(item => item.text === text);
    const index = exact >= 0 ? exact : (pendingAdmissions.length ? 0 : -1);
    return index >= 0 ? pendingAdmissions.splice(index, 1)[0] : null;
  }

  async function admit(text, options = {}) {
    const clean = String(text || '').trim();
    if (!clean) return { ok: false, code: 'empty_message' };
    const clientMsgId = typeof options.clientMsgId === 'string' && options.clientMsgId.trim()
      ? options.clientMsgId.trim()
      : `tui-${crypto.randomUUID()}`;
    pendingAdmissions.push({ text: clean, clientMsgId });
    inputQueue.push({ text: clean, clientMsgId });
    broadcast({
      type: 'session_queue',
      event: 'queued',
      queued: false,
      message: clean,
      clientMsgId,
      items: [],
      state: ready && !running ? 'idle' : 'starting',
    });
    flushInputQueue();
    return {
      ok: true,
      experimental: true,
      mode: EXPERIMENT_MODE,
      queued: !ready || running,
      clientMsgId,
    };
  }

  async function flushInputQueue() {
    if (!ready || trustPending || running || injecting || !inputQueue.length) return;
    injecting = true;
    const next = inputQueue.shift();
    try {
      await tmuxApi.tmuxWriteInput(runtimeId, next.text);
      await new Promise(resolve => timers.setTimeout(resolve, 150));
      await tmuxApi.tmuxWriteInput(runtimeId, '\r');
      running = true;
      setSessionStatus(sessionId, { status: 'running', currentFile: null });
    } catch (error) {
      broadcast({ type: 'error', error: `实验消息注入 TUI 失败：${publicError(error)}` });
    } finally {
      injecting = false;
    }
  }

  async function answerTrust(ws, message) {
    const text = String(message.text || '').trim();
    const approved = /^(?:1|y|yes|yes,\s*continue|确认|继续)$/i.test(text);
    const denied = /^(?:2|n|no|no,\s*quit|取消|退出)$/i.test(text);
    if (!approved && !denied) {
      announceTrust(ws);
      return;
    }
    if (message.clientMsgId) {
      broadcast({
        type: 'session_queue',
        event: 'queued',
        queued: false,
        message: text,
        clientMsgId: message.clientMsgId,
        items: [],
        state: 'starting',
      });
    }
    await tmuxApi.tmuxWriteInput(runtimeId, approved ? '1' : '2');
    await new Promise(resolve => timers.setTimeout(resolve, 100));
    await tmuxApi.tmuxWriteInput(runtimeId, '\r');
    trustPending = false;
    trustAnnounced = false;
    if (!approved) {
      broadcast({ type: 'error', error: '用户拒绝信任实验工作树，TUI 未启动。' });
    }
  }

  function attach(ws) {
    clients.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    send(ws, {
      type: 'system',
      subtype: 'init',
      cwd,
      session: sessionId,
      session_id: sessionId,
      cli: 'codex',
      is_streaming: running,
      model: record.model || null,
      effectiveModel: record.model || null,
      effort: record.effort || null,
      effectiveEffort: record.effort || null,
      experimentalMode: EXPERIMENT_MODE,
    });
    send(ws, {
      type: 'system',
      message: '🧪 实验会话：Codex TUI 是唯一执行者，Chat 由原生 rollout 事件旁路投影。',
    });
    if (messages.length) {
      send(ws, { type: 'chat_history', messages: messages.map(cloneMessage), hasMore: false });
    }
    if (trustPending) announceTrust(ws);
    ws.on('message', async raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'ping') return send(ws, { type: 'pong' });
        if (ws._sharePerm === 'view') return;
        if (message.type === 'typing') return;
        if (message.type === 'cancel') {
          await tmuxApi.tmuxWriteInput(runtimeId, '\x03');
          return;
        }
        if (message.type === 'clear_history') {
          send(ws, { type: 'system', message: '实验会话以原生 TUI rollout 为事实源，暂不支持从 Chat 清空历史。' });
          return;
        }
        if (message.type === 'user_message' && message.text) {
          if (message.userInputRequestId === trustRequestId) {
            await answerTrust(ws, message);
            return;
          }
          await admit(message.text, { clientMsgId: message.clientMsgId });
        }
      } catch (error) {
        send(ws, { type: 'error', error: `实验消息投递失败：${publicError(error)}` });
      }
    });
    const detach = () => clients.delete(ws);
    ws.on('close', detach);
    ws.on('error', detach);
  }

  function broadcast(payload) {
    for (const client of clients) send(client, payload);
  }

  function stop() {
    stopped = true;
    if (pollTimer) timers.clearInterval(pollTimer);
    if (readinessTimer) timers.clearInterval(readinessTimer);
    pollTimer = null;
    readinessTimer = null;
    clients.clear();
  }

  return Object.freeze({ start, admit, attach, stop });
}

function terminalCommand(provider, record) {
  const base = provider && typeof provider.buildTerminalCmd === 'function'
    ? String(provider.buildTerminalCmd({ ...record, cliSessionId: null }))
    : 'codex';
  const flags = '--no-alt-screen --ask-for-approval never --sandbox workspace-write';
  return `${base} ${flags}`;
}

function findRolloutFile({ sessionsRoot, cwd, nativeSessionId, sinceMs }) {
  if (!sessionsRoot || !fs.existsSync(sessionsRoot)) return null;
  const candidates = [];
  walkFiles(sessionsRoot, file => {
    if (!file.endsWith('.jsonl')) return;
    try {
      const stat = fs.statSync(file);
      candidates.push({ file, mtimeMs: stat.mtimeMs, fresh: stat.mtimeMs >= sinceMs });
    } catch {}
  });
  candidates.sort((a, b) => Number(b.fresh) - Number(a.fresh) || b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates) {
    try {
      const meta = JSON.parse(readFirstLine(candidate.file));
      if (meta.type !== 'session_meta') continue;
      const id = meta.payload?.id || meta.payload?.session_id;
      if (nativeSessionId && id === nativeSessionId) return candidate.file;
      if (!nativeSessionId && samePath(meta.payload?.cwd, cwd)) return candidate.file;
    } catch {}
  }
  return null;
}

function readFirstLine(file) {
  const fd = fs.openSync(file, 'r');
  const chunks = [];
  let position = 0;
  try {
    while (position < 4 * 1024 * 1024) {
      const buffer = Buffer.alloc(64 * 1024);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      chunks.push(newline >= 0 ? chunk.subarray(0, newline) : chunk);
      position += bytesRead;
      if (newline >= 0) return Buffer.concat(chunks).toString('utf8');
    }
  } finally {
    fs.closeSync(fd);
  }
  throw new Error('rollout session_meta line is missing or too large');
}

function walkFiles(directory, visitor) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(file, visitor);
    else if (entry.isFile()) visitor(file);
  }
}

function samePath(left, right) {
  try { return fs.realpathSync(left) === fs.realpathSync(right); }
  catch { return path.resolve(left || '') === path.resolve(right || ''); }
}

function projectRecord(record, currentTurnId) {
  const payload = record?.payload;
  const at = record?.timestamp || new Date().toISOString();
  if (record?.type === 'session_meta') {
    return eventId({ kind: 'session_meta', at, sessionId: payload?.id || payload?.session_id || null });
  }
  if (!payload || typeof payload !== 'object') return null;
  if (record.type === 'event_msg') {
    if (payload.type === 'task_started') {
      return eventId({ kind: 'turn_start', at, turnId: payload.turn_id || null });
    }
    if (payload.type === 'user_message') {
      return eventId({ kind: 'user', at, turnId: currentTurnId, text: String(payload.message || '') });
    }
    if (payload.type === 'agent_message') {
      return eventId({
        kind: 'assistant',
        at,
        turnId: currentTurnId,
        phase: payload.phase || null,
        text: String(payload.message || ''),
      });
    }
    if (payload.type === 'task_complete') {
      return eventId({
        kind: 'turn_complete',
        at,
        turnId: payload.turn_id || currentTurnId,
        durationMs: payload.duration_ms || null,
      });
    }
    if (['turn_aborted', 'stream_error', 'error'].includes(payload.type)) {
      return eventId({ kind: 'error', at, turnId: currentTurnId, text: String(payload.message || payload.type) });
    }
    return null;
  }
  if (record.type !== 'response_item') return null;
  if (['custom_tool_call', 'function_call', 'local_shell_call'].includes(payload.type)) {
    return eventId({
      kind: 'tool_start',
      at,
      turnId: currentTurnId,
      callId: payload.call_id || payload.id || null,
      name: payload.name || payload.type,
      input: safeText(payload.input ?? payload.arguments, 8000),
    });
  }
  if (['custom_tool_call_output', 'function_call_output', 'local_shell_call_output'].includes(payload.type)) {
    return eventId({
      kind: 'tool_result',
      at,
      turnId: currentTurnId,
      callId: payload.call_id || payload.id || null,
      text: safeText(payload.output, 12000),
    });
  }
  return null;
}

function eventId(event) {
  const seed = [
    event.at,
    event.kind,
    event.turnId || '',
    event.callId || '',
    event.phase || '',
    event.text || '',
  ].join('|');
  return { ...event, id: crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24) };
}

function safeText(value, max) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text
    .replace(/(authorization|api[-_]?key|token|cookie|secret)(\s*[:=]\s*)([^\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]')
    .slice(0, max);
}

function parseToolInput(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return { input: String(value) }; }
}

function appendText(current, next) {
  if (!next) return current || '';
  return current ? `${current}\n\n${next}` : next;
}

function cloneMessage(message) {
  return JSON.parse(JSON.stringify(message));
}

function publicError(error) {
  return String(error?.message || error || 'unknown error').split('\n')[0].slice(0, 300);
}

module.exports = {
  EXPERIMENT_ENV,
  EXPERIMENT_MODE,
  createTuiChatMirrorRuntime,
  findRolloutFile,
  isEnabled,
  ownsSession,
  projectRecord,
  readFirstLine,
  validateExperimentalSession,
};
