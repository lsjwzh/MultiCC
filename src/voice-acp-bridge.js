'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');
const { sanitizeVoiceSpeech } = require('./voice-speech');

const QWEN_INSTRUCTION_BLOCK = /<qwen_audio_agent_backend_instructions>[\s\S]*?<\/qwen_audio_agent_backend_instructions>\s*/gi;
const QWEN_REQUEST_ENVELOPE = /<qwen_audio_agent_request>([\s\S]*?)<\/qwen_audio_agent_request>/gi;

// A globally-routed voice turn has exactly one terminal authority: the Host's
// request-correlated `voice_admission` frame. Generic traffic on the shared
// Router socket is neither evidence nor safe speech content.
const ADMISSION_VERSION = 1;
const ADMISSION_OUTCOMES = new Set([
  'no_dispatch', 'admitted', 'rejected', 'failed', 'cancelled', 'unknown',
]);
const ADMISSION_TIMEOUT_MIN_MS = 15_000;
const ADMISSION_TIMEOUT_MAX_MS = 30_000;
const ADMISSION_TIMEOUT_DEFAULT_MS = 20_000;
const ADMISSION_UNCERTAIN = '这条任务的提交状态还没有确认，请稍后在 MultiCC 任务板上查看。';

function boundedAdmissionTimeout(value) {
  return Number.isFinite(value) && value > 0
    ? Math.min(Math.max(Math.floor(value), ADMISSION_TIMEOUT_MIN_MS), ADMISSION_TIMEOUT_MAX_MS)
    : ADMISSION_TIMEOUT_DEFAULT_MS;
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBaseUrl(value) {
  const url = new URL(clean(value) || 'http://127.0.0.1:3000');
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('MultiCC base URL must use http or https');
  if (url.username || url.password) throw new TypeError('MultiCC base URL must not contain credentials');
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('MultiCC base URL must not contain a path, query, or fragment');
  }
  const loopback = url.hostname === 'localhost'
    || url.hostname === '::1'
    || url.hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  return { url, loopback };
}

function validateTransportSecurity(baseUrl, accessToken) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized.loopback && !accessToken) {
    throw new Error('remote MultiCC ACP bridge requires MULTICC_ACCESS_TOKEN');
  }
  if (!normalized.loopback && normalized.url.protocol !== 'https:') {
    throw new Error('remote MultiCC ACP bridge requires HTTPS');
  }
  return normalized;
}

function promptParts(blocks) {
  const values = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type === 'text') values.push(String(block.text || ''));
    else if (block?.type === 'resource_link') {
      const uri = String(block.uri || '');
      const name = String(block.name || uri || 'resource');
      if (uri) values.push(`[${name}](${uri})`);
    }
  }
  const raw = values.join('\n');
  const envelopes = [...raw.matchAll(QWEN_REQUEST_ENVELOPE)];
  let launchId = '';
  if (envelopes.length === 1) {
    try {
      const envelope = JSON.parse(envelopes[0][1]);
      launchId = clean(envelope?.voice_session_id).slice(0, 200);
    } catch (_) {}
  }
  return {
    envelopeCount: envelopes.length,
    launchId,
    text: raw
      .replace(QWEN_REQUEST_ENVELOPE, '')
      .replace(QWEN_INSTRUCTION_BLOCK, '')
      .trim(),
  };
}

function textFromPrompt(blocks) {
  return promptParts(blocks).text;
}

// The Qwen web client carries `?session=<launch id>` from the page URL through
// to every ACP prompt as `voice_session_id`. That is how one machine-wide child
// serves many concurrent calls: the routing target is a property of the
// utterance, not of the process.
function launchIdFromPrompt(blocks) {
  return promptParts(blocks).launchId;
}

function stableQueueEntryId(sessionId, clientMsgId) {
  const suffix = crypto.createHash('sha256')
    .update(`${sessionId}\0key:${clientMsgId}`, 'utf8')
    .digest('hex')
    .slice(0, 40);
  return `session-work:${suffix}`;
}

function assistantDelta(previous, next, snapshot) {
  const prior = String(previous || '');
  const value = String(next || '');
  if (!snapshot) return { text: value, snapshot: prior + value };
  if (value.startsWith(prior)) return { text: value.slice(prior.length), snapshot: value };
  if (prior.startsWith(value)) return { text: '', snapshot: prior };
  return { text: value, snapshot: value };
}

function speakableFromBuffer(raw) {
  return sanitizeVoiceSpeech(raw);
}

// What the call actually says. The Host's structured text is preferred
// because the Host saw the whole turn; the buffer is the fallback, and a canned
// line is the last resort so a settled turn is never silent.
function admissionSpeech(outcome, admission, buffered, privateValues = []) {
  const options = { privateValues };
  const hosted = sanitizeVoiceSpeech(admission?.speechText, options);
  const spoken = hosted || sanitizeVoiceSpeech(buffered, options);
  if (outcome === 'unknown') {
    return ADMISSION_UNCERTAIN;
  }
  if (outcome === 'rejected' || outcome === 'failed') {
    // Never lead with the model's own prose here: it says the work is under way,
    // and nothing was admitted. The failure line is the whole answer.
    return sanitizeVoiceSpeech(admission?.error?.publicMessage, options)
      || '这条语音任务没有提交成功。';
  }
  if (outcome === 'admitted') return hosted || '任务已提交到 MultiCC；后续状态以任务板为准。';
  if (spoken) return spoken;
  return 'MultiCC 已处理这条语音请求。';
}

function toolKind(name) {
  const value = String(name || '').toLowerCase();
  if (/read|search|find|list|status/.test(value)) return 'read';
  if (/edit|write|patch|create/.test(value)) return 'edit';
  if (/delete|remove/.test(value)) return 'delete';
  if (/bash|shell|exec|command/.test(value)) return 'execute';
  return 'other';
}

function publicError(body, status) {
  const code = clean(body?.error || body?.code) || `http_${status}`;
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function headers(accessToken, json = false) {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(accessToken ? { 'x-access-token': accessToken } : {}),
  };
}

function boundedTimeout(value, fallback) {
  return Number.isFinite(value) && value > 0
    ? Math.min(Math.max(Math.floor(value), 10), 120_000)
    : fallback;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (_) {
    return {};
  }
}

function createVoiceAcpBridge({
  directoryId,
  baseUrl = 'http://127.0.0.1:3000',
  accessToken = '',
  fetchImpl = globalThis.fetch,
  WebSocketImpl = WebSocket,
  randomUUID = crypto.randomUUID,
  maxSessions = 32,
  requestTimeoutMs = 10_000,
  connectTimeoutMs = 10_000,
  admissionTimeoutMs = ADMISSION_TIMEOUT_DEFAULT_MS,
  // Injected only so the settle deadline is testable without waiting it out;
  // production always uses the real, bounded timer.
  admissionTimers = { setTimeout, clearTimeout },
  log = () => {},
} = {}) {
  const dirId = clean(directoryId);
  // Two modes share one bridge. Directory mode (legacy, one child per Fleet)
  // binds the routing target at startup. Launch mode (the global child) binds
  // nothing at startup and resolves a target per utterance from its launch id.
  const launchMode = !dirId;
  if (typeof fetchImpl !== 'function') throw new TypeError('MultiCC ACP bridge requires fetch');
  const security = validateTransportSecurity(baseUrl, accessToken);
  const root = security.url.toString().replace(/\/$/, '');
  const sessions = new Map();
  const sessionLimit = Number.isInteger(maxSessions) && maxSessions > 0
    ? Math.min(maxSessions, 256)
    : 32;
  const httpTimeout = boundedTimeout(requestTimeoutMs, 10_000);
  const socketTimeout = boundedTimeout(connectTimeoutMs, 10_000);
  const admissionTimeout = boundedAdmissionTimeout(admissionTimeoutMs);

  async function request(pathname, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), httpTimeout);
    timer.unref?.();
    try {
      const response = await fetchImpl(`${root}${pathname}`, {
        ...options,
        signal: controller.signal,
        headers: {
          ...headers(accessToken, options.body !== undefined),
          ...(options.headers || {}),
        },
      });
      const body = await readJson(response);
      if (!response.ok) throw publicError(body, response.status);
      return body;
    } catch (error) {
      if (error?.status) throw error;
      throw publicError({
        error: controller.signal.aborted ? 'multicc_request_timeout' : 'multicc_request_failed',
      }, controller.signal.aborted ? 504 : 503);
    } finally {
      clearTimeout(timer);
    }
  }

  async function gateway() {
    const body = await request(`/api/v1/directories/${encodeURIComponent(dirId)}/voice-gateway`);
    const value = body?.gateway;
    if (!value || value.directoryId !== dirId || value.enabled !== true) {
      throw publicError({ error: 'voice_gateway_unavailable' }, 409);
    }
    if (!value.binding?.ready || !clean(value.commanderSessionId)) {
      throw publicError({ error: value.binding?.code || 'commander_binding_invalid' }, 409);
    }
    return value;
  }

  // Resolved fresh for every utterance. The Host re-derives the target from live
  // records, so a replaced Commander or a deleted session takes effect on the
  // next thing the user says — and a forged or expired id simply fails.
  async function launchContext(launchId) {
    const id = clean(launchId);
    if (!id) throw publicError({ error: 'voice_launch_required' }, 400);
    const body = await request(`/api/v1/voice-gateway/launch/${encodeURIComponent(id)}`);
    const context = body?.context;
    if (!context || !clean(context.targetSessionId)) {
      throw publicError({ error: 'voice_launch_unresolved' }, 409);
    }
    return context;
  }

  async function wsTicket() {
    if (!accessToken) return '';
    const body = await request('/api/auth/ws-ticket', {
      method: 'POST',
      body: JSON.stringify({ path: '/ws/chat' }),
    });
    if (!clean(body.ticket)) throw new Error('MultiCC did not issue a WebSocket ticket');
    return body.ticket;
  }

  function chatUrl(commanderSessionId, ticket = '') {
    const url = new URL(root);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws/chat';
    url.search = '';
    url.searchParams.set('session', commanderSessionId);
    if (ticket) url.searchParams.set('ticket', ticket);
    return url.toString();
  }

  async function cancelQueued(commanderSessionId, clientMsgId) {
    const entryId = stableQueueEntryId(commanderSessionId, clientMsgId);
    try {
      return await request(`/api/sessions/${encodeURIComponent(commanderSessionId)}/queue/action`, {
        method: 'POST',
        body: JSON.stringify({
          action: 'cancel_queued',
          entryId,
          confirm: true,
          reason: 'voice ACP session cancelled before execution',
        }),
      });
    } catch (error) {
      if (error.status === 404 || error.status === 409) return { ok: false, code: error.code };
      throw error;
    }
  }

  class BridgeSession {
    constructor({ id, cwd, gatewayRecord = null }) {
      this.id = id;
      this.cwd = cwd;
      this.gatewayRecord = gatewayRecord;
      // Where this session's next turn will be delivered. In launch mode it is
      // null until the first utterance names a launch id.
      this.target = gatewayRecord
        ? { sessionId: gatewayRecord.commanderSessionId, key: gatewayRecord.id, scope: 'fleet' }
        : null;
      this.socket = null;
      this.openPromise = null;
      this.active = null;
      this.closed = false;
    }

    // Re-pointing the target must always drop the old socket: a turn opened for
    // one session must never continue against another.
    retarget(next) {
      if (this.target?.sessionId !== next.sessionId) this.closeSocket();
      this.target = next;
    }

    async refreshBinding() {
      const latest = await gateway();
      this.gatewayRecord = latest;
      this.retarget({ sessionId: latest.commanderSessionId, key: latest.id, scope: 'fleet' });
    }

    async refreshLaunchTarget(launchId) {
      const context = await launchContext(launchId);
      this.retarget({
        sessionId: context.targetSessionId,
        key: context.scope === 'chat' ? 'chat' : 'global',
        scope: context.scope,
        directoryId: context.directoryId || null,
        commanderSessionId: context.commanderSessionId || null,
        display: context.display || '',
      });
      return context;
    }

    closeSocket() {
      const socket = this.socket;
      this.socket = null;
      this.openPromise = null;
      if (socket && socket.readyState < WebSocketImpl.CLOSING) {
        try { socket.close(); } catch (_) {}
      }
    }

    async connect() {
      if (this.closed) throw new Error(`ACP session ${this.id} is closed`);
      if (this.socket?.readyState === WebSocketImpl.OPEN) return;
      if (this.openPromise) return this.openPromise;
      this.openPromise = (async () => {
        const ticket = await wsTicket();
        await new Promise((resolve, reject) => {
          const socket = new WebSocketImpl(chatUrl(this.target.sessionId, ticket));
          this.socket = socket;
          let settled = false;
          const fail = error => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(publicError({ error: 'commander_transport_connect_failed' }, 503));
            }
          };
          const timer = setTimeout(() => {
            fail(new Error('Commander WebSocket connect timeout'));
            try {
              if (typeof socket.terminate === 'function') socket.terminate();
              else socket.close();
            } catch (_) {}
          }, socketTimeout);
          timer.unref?.();
          socket.once('open', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          });
          socket.once('error', fail);
          socket.on('message', data => this.handleMessage(data));
          socket.on('close', () => {
            if (!settled) fail(new Error('Commander WebSocket closed during connect'));
            if (this.socket === socket) this.socket = null;
            const active = this.active;
            if (!active) return;
            if (active.cancelRequested) {
              this.finish(active, null, { stopReason: 'cancelled' });
            } else {
              // A lost socket cannot prove either delivery or non-delivery.
              this.settleUnknown(active, 'socket_close');
            }
          });
        });
      })().finally(() => {
        this.openPromise = null;
      });
      return this.openPromise;
    }

    notify(active, update) {
      active.notifyChain = active.notifyChain
        .then(() => active.notify(update))
        .catch(error => {
          log('voice_acp_notify_failed', { sessionId: this.id, error: error.message });
        });
      return active.notifyChain;
    }

    emitText(active, value, snapshot = false) {
      const delta = assistantDelta(active.assistantText, value, snapshot);
      // Every scope buffers the complete raw turn. TTS happens exactly once,
      // after the final sanitizer has seen all cross-chunk marker fragments.
      active.assistantText = delta.snapshot;
    }

    speak(active, text) {
      const value = String(text || '');
      if (!value) return;
      active.emittedText = true;
      this.notify(active, {
        sessionUpdate: 'agent_message_chunk',
        messageId: active.messageId,
        content: { type: 'text', text: value },
      });
    }

    armOverallTimeout(active) {
      if (active.settled || active.finished || active.settleTimer) return;
      const timer = admissionTimers.setTimeout(() => {
        active.settleTimer = null;
        if (active.settled || active.finished) return;
        log('voice_acp_overall_timeout', {
          sessionId: this.id,
          structured: active.structured,
        });
        this.settleUnknown(active, 'overall_timeout');
      }, admissionTimeout);
      timer?.unref?.();
      active.settleTimer = timer;
    }

    // requestId is the sole per-call correlation key. The shared Router's
    // generic frames and other calls' admissions are deliberately ignored.
    handleAdmission(active, message) {
      if (!active.structured || active.settled || active.finished) return;
      if (message.version !== ADMISSION_VERSION) return;
      if (clean(message.requestId) !== active.clientMsgId) return;
      if (active.admission) return;
      let outcome = ADMISSION_OUTCOMES.has(message.outcome) ? message.outcome : 'unknown';
      let error = message.error && typeof message.error === 'object' ? message.error : null;
      const operationId = outcome === 'admitted' ? clean(message.operationId) : '';
      if (outcome === 'admitted' && !operationId) {
        outcome = 'failed';
        error = {
          code: 'operation_id_missing',
          retryable: true,
          publicMessage: '任务提交结果不完整，请稍后重试。',
        };
      }
      active.admission = {
        outcome,
        operationId: outcome === 'admitted' ? operationId : '',
        duplicate: message.duplicate === true,
        queueStatus: clean(message.queueStatus),
        speechText: typeof message.speechText === 'string' ? message.speechText : '',
        error,
      };
      // The correlated Host frame is the terminal truth. No generic `result`
      // joins this decision or delays it.
      this.settle(active, outcome);
    }

    settle(active, outcome) {
      if (active.settled || active.finished) return;
      active.settled = true;
      if (active.settleTimer) {
        admissionTimers.clearTimeout(active.settleTimer);
        active.settleTimer = null;
      }
      // A cancelled call stops speaking; it does not announce a withdrawal.
      // Work already admitted keeps running, and saying otherwise would be a
      // false statement the user would act on.
      if (!active.cancelRequested) {
        this.speak(active, admissionSpeech(
          outcome,
          active.admission,
          active.structured ? '' : active.assistantText,
          active.privateValues,
        ));
      }
      this.finish(active, null, {
        stopReason: active.cancelRequested ? 'cancelled' : 'end_turn',
        ...(active.usage && active.usage.totalTokens ? { usage: active.usage } : {}),
      });
    }

    settleUnknown(active, reason) {
      if (active.settled || active.finished) return;
      log('voice_acp_unknown', { sessionId: this.id, reason });
      active.admission = { outcome: 'unknown' };
      this.settle(active, 'unknown');
    }

    emitToolUse(active, block) {
      const id = clean(block.id) || `tool_${randomUUID()}`;
      this.notify(active, {
        sessionUpdate: 'tool_call',
        toolCallId: id,
        title: clean(block.name) || 'MultiCC tool',
        name: clean(block.name) || null,
        kind: toolKind(block.name),
        status: 'in_progress',
      });
    }

    emitToolResult(active, block) {
      const id = clean(block.tool_use_id);
      if (!id) return;
      this.notify(active, {
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: block.is_error ? 'failed' : 'completed',
      });
    }

    async handleMessage(data) {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch (_) {
        return;
      }
      const active = this.active;
      if (!active) return;
      if (message.type === 'chat_msg_meta'
          && message.role === 'user'
          && message.clientMsgId === active.clientMsgId) {
        active.started = true;
        if (active.cancelRequested && this.socket?.readyState === WebSocketImpl.OPEN) {
          this.socket.send(JSON.stringify({ type: 'cancel', operationId: active.clientMsgId }));
        }
        return;
      }
      // Checked before the started guard: the outcome frame carries its own
      // requestId, which is a stricter correlation than the echoed user message,
      // and "either half may land first" has to hold for this half too.
      if (message.type === 'voice_admission') {
        this.handleAdmission(active, message);
        return;
      }
      if (!active.started) return;
      // The global Router is shared. Its generic assistant/tool/result/error
      // traffic has no request correlation and therefore cannot settle this
      // call or enter its speech buffer.
      if (active.structured) return;
      if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
        const snapshot = message.message.textSnapshot === true;
        for (const block of message.message.content) {
          if (block?.type === 'text') this.emitText(active, block.text || '', snapshot);
          else if (block?.type === 'tool_use') this.emitToolUse(active, block);
        }
        return;
      }
      if (message.type === 'user' && Array.isArray(message.message?.content)) {
        for (const block of message.message.content) {
          if (block?.type === 'tool_result') this.emitToolResult(active, block);
        }
        return;
      }
      if (message.type === 'error') {
        this.settleUnknown(active, 'commander_error');
        return;
      }
      if (message.type !== 'result') return;
      const usage = message.usage && typeof message.usage === 'object'
        ? {
            totalTokens: Number(message.usage.total_tokens || message.usage.totalTokens) || 0,
            inputTokens: Number(message.usage.input_tokens || message.usage.inputTokens) || 0,
            outputTokens: Number(message.usage.output_tokens || message.usage.outputTokens) || 0,
          }
        : null;
      const spoken = sanitizeVoiceSpeech(active.assistantText, {
        privateValues: active.privateValues,
      }) || 'MultiCC 已处理这条语音请求。';
      this.speak(active, spoken);
      this.finish(active, null, {
        stopReason: active.cancelRequested ? 'cancelled' : 'end_turn',
        ...(usage && usage.totalTokens ? { usage } : {}),
      });
    }

    finish(active, error = null, result = null) {
      if (this.active !== active || active.finished) return;
      active.finished = true;
      if (active.settleTimer) {
        admissionTimers.clearTimeout(active.settleTimer);
        active.settleTimer = null;
      }
      this.active = null;
      active.signal?.removeEventListener('abort', active.abortListener);
      active.notifyChain.finally(() => {
        if (error) active.reject(error);
        else active.resolve(result || { stopReason: 'end_turn' });
      });
    }

    async prompt(blocks, notify, signal) {
      if (this.active) {
        const error = new Error(`ACP session ${this.id} already has an active prompt`);
        error.code = 'session_busy';
        throw error;
      }
      const parts = promptParts(blocks);
      const text = parts.text;
      if (!text) {
        const error = new Error('ACP prompt contains no supported content');
        error.code = 'empty_prompt';
        throw error;
      }
      if (launchMode) await this.refreshLaunchTarget(parts.launchId);
      else await this.refreshBinding();
      await this.connect();
      const clientMsgId = `voice:${this.target.key}:${randomUUID()}`.slice(0, 128);
      const result = new Promise((resolve, reject) => {
        const active = {
          clientMsgId,
          messageId: `voice_msg_${randomUUID()}`,
          assistantText: '',
          emittedText: false,
          started: false,
          cancelRequested: false,
          finished: false,
          // Only global scope is Host-admission driven. Every scope is buffered.
          structured: this.target.scope === 'global',
          settled: false,
          usage: null,
          admission: null,
          settleTimer: null,
          privateValues: [
            this.cwd,
            this.target.sessionId,
            this.target.directoryId,
            this.target.commanderSessionId,
          ],
          notify,
          notifyChain: Promise.resolve(),
          signal,
          resolve,
          reject,
        };
        active.abortListener = () => this.cancel();
        signal?.addEventListener('abort', active.abortListener, { once: true });
        this.active = active;
        this.armOverallTimeout(active);
        try {
          this.socket.send(JSON.stringify({
            type: 'user_message',
            text,
            clientMsgId,
          }));
        } catch (_) {
          this.settleUnknown(active, 'send_failed');
        }
        if (signal?.aborted) this.cancel();
      });
      return result;
    }

    async cancel() {
      const active = this.active;
      if (!active || active.finished) return { ok: true, idle: true };
      active.cancelRequested = true;
      if (active.started) {
        if (this.socket?.readyState === WebSocketImpl.OPEN) {
          try {
            this.socket.send(JSON.stringify({ type: 'cancel', operationId: active.clientMsgId }));
          } catch (_) {}
        }
        this.finish(active, null, { stopReason: 'cancelled' });
        return { ok: true, active: true };
      }
      // Cancel against whatever this turn was actually delivered to, never a
      // stale startup binding — otherwise a cancel could hit another session.
      let result;
      try {
        result = await cancelQueued(this.target.sessionId, active.clientMsgId);
        return result;
      } catch (error) {
        log('voice_acp_cancel_failed', { sessionId: this.id, error: error.message });
        return { ok: false, code: error.code || 'cancel_failed' };
      } finally {
        this.finish(active, null, { stopReason: 'cancelled' });
      }
    }

    async close() {
      if (this.closed) return;
      this.closed = true;
      try {
        if (this.active) await this.cancel();
      } finally {
        if (this.active) this.finish(this.active, null, { stopReason: 'cancelled' });
        this.closeSocket();
      }
    }
  }

  async function createSession({ cwd } = {}) {
    if (sessions.size >= sessionLimit) {
      const error = new Error('ACP session limit reached');
      error.code = 'session_limit_reached';
      throw error;
    }
    const gatewayRecord = launchMode ? null : await gateway();
    const id = randomUUID();
    sessions.set(id, new BridgeSession({ id, cwd: clean(cwd), gatewayRecord }));
    return {
      sessionId: id,
      _meta: {
        multicc: launchMode
          // In launch mode there is nothing truthful to announce yet: the
          // routing target only exists once an utterance carries a launch id.
          ? { routing: 'voice-launch', taskAuthority: 'multicc-task-board' }
          : {
              directoryId: dirId,
              gatewayId: gatewayRecord.id,
              commanderSessionId: gatewayRecord.commanderSessionId,
              taskAuthority: 'multicc-task-board',
            },
      },
    };
  }

  async function resumeSession({ sessionId, cwd } = {}) {
    const id = clean(sessionId);
    if (!id) throw new TypeError('ACP resume requires sessionId');
    const previous = sessions.get(id);
    if (!previous && sessions.size >= sessionLimit) {
      const error = new Error('ACP session limit reached');
      error.code = 'session_limit_reached';
      throw error;
    }
    await previous?.close();
    const gatewayRecord = launchMode ? null : await gateway();
    sessions.set(id, new BridgeSession({ id, cwd: clean(cwd), gatewayRecord }));
    return {};
  }

  async function prompt({ sessionId, prompt: blocks } = {}, notify, signal) {
    const session = sessions.get(clean(sessionId));
    if (!session) {
      const error = new Error(`ACP session ${sessionId} not found`);
      error.code = 'session_not_found';
      throw error;
    }
    return session.prompt(blocks, notify, signal);
  }

  async function cancel({ sessionId } = {}) {
    const session = sessions.get(clean(sessionId));
    return session ? session.cancel() : { ok: true, idle: true };
  }

  async function closeSession({ sessionId } = {}) {
    const id = clean(sessionId);
    await sessions.get(id)?.close();
    sessions.delete(id);
    return {};
  }

  async function stop() {
    await Promise.all([...sessions.values()].map(session => session.close()));
    sessions.clear();
  }

  return Object.freeze({
    cancel,
    closeSession,
    createSession,
    prompt,
    resumeSession,
    stop,
    // deterministic tests and diagnostics
    gateway,
    sessionCount: () => sessions.size,
  });
}

module.exports = {
  ADMISSION_TIMEOUT_MAX_MS,
  ADMISSION_TIMEOUT_MIN_MS,
  QWEN_INSTRUCTION_BLOCK,
  admissionSpeech,
  assistantDelta,
  boundedAdmissionTimeout,
  boundedTimeout,
  createVoiceAcpBridge,
  normalizeBaseUrl,
  speakableFromBuffer,
  stableQueueEntryId,
  textFromPrompt,
  validateTransportSecurity,
};
