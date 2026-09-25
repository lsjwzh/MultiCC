'use strict';

// ZCode Protocol app-server（`zcode.cjs app-server`，引擎 0.16.x）↔ multicc 桥接件。
//
// 这里只放【纯逻辑】：协议常量、runtimeModel 构造、以及「一条 session/event 通知 →
// 若干条 opencode raw 事件」的映射状态机。进程/stdio/信号处理都在
// zcode-bridge.cjs，所以映射可以拿录制下来的通知直接单测
// （tests/test-zcode-app-server-mapping.js）。
//
// 协议要点（实测 0.16.5，见 bridge 头部注释）：
//   - stdio 上换行分隔 JSON，无 jsonrpc 字段（.strict() schema 会拒绝它）；
//   - 客户端 → 服务端用 {id, method, params}；服务端 → 客户端用 {id, method, params}
//     （必须回 {id, result|error}，例如 session/requestRuntimePreferences）；
//   - 流式事件走 session/subscribe（deliveryKind 必填）之后才推的
//     `session/event` 通知：{method:'session/event', params:{type, payload, seq, ...}}；
//   - 一轮结束信号是 turn.completed（payload.resultType = success | cancelled |
//     error_max_turns | error_max_budget | error_during_execution | error_max_tool_calls），
//     失败是 turn.failed（payload.error）。

// 引擎在 session/create 前后会向客户端要运行时偏好；这几个值让无人值守成立：
// 关掉记忆抽取、问题自动消解（不弹交互式提问）、上下文预算走 preflight。
const RUNTIME_PREFERENCES = Object.freeze({
  nativeSearchEnhancementsEnabled: true,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: 'preflight-v1',
});

// 无人值守：yolo 模式自动放行工具，不需要 permission 往返。
const DEFAULT_MODE = 'yolo';
// 订阅方式：web-remote-replayable 会带 seq，可以按 seq 过滤重放。
const DELIVERY_KIND = 'web-remote-replayable';
const PROTOCOL_CLIENT_ID = 'multicc-zcode-bridge';

const TERMINAL_ERROR_CODE = 'zcode_terminal_error';
const INVALID_SESSION_CODE = 'zcode_invalid_session_id';

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// usage 在 turn.completed 里是扁平的 inputTokens/outputTokens/cache*Tokens。
function tokensOfUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  return {
    input: toCount(u.inputTokens),
    output: toCount(u.outputTokens),
    cache: { read: toCount(u.cacheReadTokens), write: toCount(u.cacheWriteTokens) },
  };
}

// 刷新续轮用的 runtimeModel：全新 app-server 进程的 workspaceModelCatalogs 是空的，
// 此时 session/resume 会给该会话挂上 restoreWarning，紧随其后的 session/send 直接
// 抛 -32031（ZCODE_RUNTIME_MODEL_UNAVAILABLE，「历史任务使用的模型已不可用」）。
// 把厂商配置（~/.zcode/cli/config.json）里的 provider 原样喂回去即可解掉。
// 读不到/结构不认识 → 返回 null（bridge 就不传，让引擎按自己的配置走）。
function buildRuntimeModel(config, modelRef) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const raw = typeof config.model === 'string' && config.model.includes('/')
    ? config.model.split('/') : null;
  const providerId = (modelRef && modelRef.providerId) || (raw && raw[0]);
  const modelId = (modelRef && modelRef.modelId) || (raw && raw.slice(1).join('/'));
  if (!providerId || !modelId) return null;
  const provider = config.provider && typeof config.provider === 'object'
    ? config.provider[providerId] : null;
  if (!provider || typeof provider !== 'object') return null;
  const options = provider.options && typeof provider.options === 'object' ? provider.options : {};
  const declared = provider.models && typeof provider.models === 'object'
    ? Object.keys(provider.models).filter(Boolean) : [];
  const models = (declared.length ? declared : [modelId]).map(id => ({ modelId: id }));
  return {
    revision: `multicc-zcode-${modelId}`,
    generatedAt: Date.now(),
    model: { providerId, modelId },
    provider: {
      providerId,
      kind: provider.kind || 'anthropic',
      source: 'workspace',
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.apiKey ? { apiKey: { source: 'inline', value: options.apiKey } } : {}),
      models,
    },
  };
}

function toolCallIdOf(payload, fallback) {
  const id = payload && (payload.toolCallId || payload.callID);
  return typeof id === 'string' && id ? id : fallback;
}

// 工具输出：decodeEvent 自己会把非字符串 JSON.stringify，这里只保证「有值」，
// 否则 decode 判 completed 的条件（output !== undefined）不成立。
function toolOutput(value) {
  if (value === undefined || value === null) return '';
  return value;
}

function errorMessageOf(error) {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    if (typeof error.message === 'string' && error.message) return error.message;
    if (typeof error.type === 'string' && error.type) return error.type;
  }
  return '';
}

// 思考分片的节流：宿主把 thinking 当「快照」用（同一 id 覆盖卡片），所以每条都得
// 带累计全文，不能只发增量 —— 但每个 token 都发全文就是 O(n²) 的流量，按时间/长度
// 两个维度节流，收尾时再补一次全文。
const REASONING_MIN_INTERVAL_MS = 200;
const REASONING_MIN_GROWTH = 4_000;

// 一轮的映射状态机。sessionId 只是回填到每条事件的 sessionID 上（decodeEvent 靠它
// 认领原生会话身份）。返回 { map(params) -> {events, done} }。
//
// 关于 step：zcode.cjs 一个 assistant 消息 = 一个模型 step（可能含文本 + 工具调用）。
// multicc 的 step-completion 只在「最后一个 step 以 reason=stop 收尾、且该 step 内
// 没有工具事件」时才判 completed，所以这里在每次 assistant 消息切换时补发 step_start，
// 让工具后的收尾 step 干净；真的只剩工具事件时在收尾前再补一个 step_start。
//
// separateFirstText：常驻 hold 里的自唤醒轮接在同一条宿主回答后面，首段文字前补
// 一个 `\n\n`，否则会和上一轮的尾巴粘成一句。
function createZcodeTurnMapper({ sessionId, now = () => Date.now(), separateFirstText = false } = {}) {
  let turnSeen = false;   // 见过这一轮的 turn.started 才算「我们这一轮」
  let stepOpen = false;
  let stepHasTools = false;
  let currentMessageId = null;
  let emittedText = false;
  let separatorPending = !!separateFirstText;
  const toolNames = new Map();
  const toolInputs = new Map();
  const toolInputBuffers = new Map();
  const reasoningText = new Map();    // 思考 id → 累计全文
  const reasoningOpen = new Set();    // 还没发过 completed 的思考 id
  const reasoningEmit = new Map();    // 思考 id → { at, length }

  function stepStart(events) {
    stepOpen = true;
    stepHasTools = false;
    flushReasoning(events);
    events.push({ sessionID: sessionId, type: 'step_start', part: {} });
  }

  function reasoningId(payload) {
    return typeof payload.assistantMessageId === 'string' && payload.assistantMessageId
      ? payload.assistantMessageId
      : `${sessionId}_reasoning`;
  }

  // 收尾：把还开着的思考卡片关掉（否则宿主那张 Thinking 卡片永远停在 running）。
  function flushReasoning(events) {
    for (const id of [...reasoningOpen]) {
      const text = reasoningText.get(id) || '';
      reasoningOpen.delete(id);
      reasoningText.delete(id);
      reasoningEmit.delete(id);
      if (text) events.push({ sessionID: sessionId, type: 'reasoning', part: { id, text, completed: true } });
    }
  }

  function appendText(events, delta) {
    if (typeof delta !== 'string' || !delta) return;
    if (separatorPending) {
      separatorPending = false;
      events.push({ sessionID: sessionId, type: 'text', part: { text: '\n\n' } });
    }
    emittedText = true;
    events.push({ sessionID: sessionId, type: 'text', part: { text: delta } });
  }

  function markTools(events, id, name, input, status, output) {
    stepHasTools = true;
    if (id) {
      toolNames.set(id, name);
      if (input !== undefined) toolInputs.set(id, input);
    }
    events.push({
      sessionID: sessionId,
      type: 'tool_call',
      part: {
        callID: id,
        tool: name,
        state: {
          ...(input !== undefined ? { input } : {}),
          status,
          ...(output !== undefined ? { output: toolOutput(output) } : {}),
        },
      },
    });
  }

  function onModelStreaming(payload, events) {
    const mid = typeof payload.assistantMessageId === 'string' && payload.assistantMessageId
      ? payload.assistantMessageId : null;
    if (mid && mid !== currentMessageId) {
      // 第一条消息沿用 turn.started 已经开好的 step；之后每条消息都是新 step。
      if (currentMessageId !== null || !stepOpen) {
        stepStart(events);
        if (emittedText) separatorPending = true;
      }
      currentMessageId = mid;
    }
    const kind = payload.kind;
    if (kind === 'text_delta') {
      appendText(events, payload.delta);
      return;
    }
    if (kind === 'reasoning_delta') {
      if (typeof payload.delta === 'string' && payload.delta) {
        const id = reasoningId(payload);
        const text = `${reasoningText.get(id) || ''}${payload.delta}`;
        reasoningText.set(id, text);
        reasoningOpen.add(id);
        const last = reasoningEmit.get(id);
        const at = now();
        if (!last || at - last.at >= REASONING_MIN_INTERVAL_MS || text.length - last.length >= REASONING_MIN_GROWTH) {
          reasoningEmit.set(id, { at, length: text.length });
          events.push({ sessionID: sessionId, type: 'reasoning', part: { id, text } });
        }
      }
      return;
    }
    const id = toolCallIdOf(payload, null);
    if (kind === 'tool_input_start') {
      if (id) {
        toolNames.set(id, payload.toolName || toolNames.get(id) || 'tool');
        toolInputBuffers.set(id, '');
      }
      return;
    }
    if (kind === 'tool_input_delta') {
      if (!id) return;
      const next = `${toolInputBuffers.get(id) || ''}${typeof payload.delta === 'string' ? payload.delta : ''}`;
      toolInputBuffers.set(id, next);
      return;
    }
    if (kind === 'tool_call') {
      const name = payload.toolName || (id && toolNames.get(id)) || 'tool';
      let input = payload.input;
      if (input === undefined && id) {
        const buffered = toolInputBuffers.get(id);
        toolInputBuffers.delete(id);
        if (buffered) {
          try { input = JSON.parse(buffered); } catch (_) { input = buffered; }
        }
      }
      markTools(events, id, name, input === undefined ? {} : input, 'running', undefined);
    }
  }

  function onToolUpdated(payload, events) {
    const id = toolCallIdOf(payload, null);
    const name = payload.toolName || (id && toolNames.get(id)) || 'tool';
    if (payload.kind === 'result') {
      const result = payload.result && typeof payload.result === 'object' ? payload.result : {};
      markTools(events, id, name, toolInputs.has(id) ? toolInputs.get(id) : undefined,
        result.success === false ? 'error' : 'completed', result.content);
      return;
    }
    if (payload.kind === 'error') {
      markTools(events, id, name, toolInputs.has(id) ? toolInputs.get(id) : undefined,
        'error', errorMessageOf(payload.error));
    }
  }

  function onTurnCompleted(payload, events) {
    flushReasoning(events);
    const resultType = payload.resultType;
    if (resultType === 'success' || resultType === 'cancelled') {
      // 没有拿到任何流式分片时的兜底：整段响应补一次，避免空回答。
      if (!emittedText && typeof payload.response === 'string' && payload.response) {
        appendText(events, payload.response);
      }
      // 收尾 step 里还有工具事件（没有新的 assistant 消息）→ 补一个干净 step，
      // 否则 step-completion 会按 tool_step_requires_followup 判 unknown。
      if (resultType === 'success' && stepOpen && stepHasTools) stepStart(events);
      events.push({
        sessionID: sessionId,
        type: 'step_finish',
        part: {
          reason: resultType === 'success' ? 'stop' : 'cancelled',
          tokens: tokensOfUsage(payload.usage),
        },
      });
      return { done: resultType === 'success' ? 'success' : 'cancelled' };
    }
    const label = typeof resultType === 'string' && resultType ? resultType : 'error';
    events.push({
      sessionID: sessionId,
      type: 'error',
      error: { code: TERMINAL_ERROR_CODE, message: `ZCode ended: ${label}` },
    });
    return { done: 'failed' };
  }

  function onTurnFailed(payload, events) {
    flushReasoning(events);
    const detail = errorMessageOf(payload.error) || 'error';
    const code = payload.error && typeof payload.error === 'object' && payload.error.code
      ? ` (${payload.error.code})` : '';
    events.push({
      sessionID: sessionId,
      type: 'error',
      error: { code: TERMINAL_ERROR_CODE, message: `ZCode ended: ${detail}${code}` },
    });
    return { done: 'failed' };
  }

  return {
    // 一条 session/event 通知 → 要写到 stdout 的 JSONL 事件 + 这一轮是否结束。
    map(params) {
      const events = [];
      if (!params || typeof params !== 'object') return { events, done: null };
      const payload = params.payload && typeof params.payload === 'object' ? params.payload : {};
      switch (params.type) {
        case 'turn.started':
          turnSeen = true;
          stepStart(events);
          return { events, done: null };
        case 'model.streaming':
          onModelStreaming(payload, events);
          return { events, done: null };
        case 'tool.updated':
          onToolUpdated(payload, events);
          return { events, done: null };
        // 收尾事件只认「已经见过 turn.started」的那一轮：同一会话可能还挂着别的
        // 客户端（桌面 app）上一轮，它的 turn.completed 不能当我们这一轮结束。
        case 'turn.completed':
          if (!turnSeen) return { events, done: null };
          return { events, done: onTurnCompleted(payload, events).done };
        case 'turn.failed':
          if (!turnSeen) return { events, done: null };
          return { events, done: onTurnFailed(payload, events).done };
        default:
          return { events, done: null };
      }
    },
  };
}

// 常驻引擎的后台任务账本。信号来自 session.updated（payload 带 taskId/status/pid，
// 2026-09-26 真引擎实测：run_in_background 的 Bash 先报 running，完成后报 completed）。
// 只数「还在跑」的；终态一律移除。pid 探活是兜底：引擎漏报终态时别让 hold 白等到上限。
const RUNNING_TASK_STATES = new Set(['running', 'pending', 'queued', 'starting']);

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return !!(error && error.code === 'EPERM'); }
}

function createBackgroundTaskTracker({ isAlive = pidAlive } = {}) {
  const running = new Map();   // taskId → pid | null
  return {
    // 一条 session/event → 运行中任务数是否变化。
    observe(params) {
      if (!params || params.type !== 'session.updated') return false;
      const payload = params.payload;
      if (!payload || typeof payload.taskId !== 'string' || !payload.taskId) return false;
      if (typeof payload.status !== 'string') return false;
      const before = running.size;
      if (RUNNING_TASK_STATES.has(payload.status)) {
        const pid = Number.isInteger(payload.pid) && payload.pid > 0 ? payload.pid : running.get(payload.taskId) || null;
        running.set(payload.taskId, pid);
      } else {
        running.delete(payload.taskId);
      }
      return running.size !== before;
    },
    // 清掉进程已经不在的任务；返回数量是否变化。
    prune() {
      const before = running.size;
      for (const [id, pid] of [...running]) { if (pid && !isAlive(pid)) running.delete(id); }
      return running.size !== before;
    },
    get active() { return running.size; },
  };
}

module.exports = {
  RUNTIME_PREFERENCES,
  DEFAULT_MODE,
  DELIVERY_KIND,
  PROTOCOL_CLIENT_ID,
  TERMINAL_ERROR_CODE,
  INVALID_SESSION_CODE,
  tokensOfUsage,
  buildRuntimeModel,
  createZcodeTurnMapper,
  createBackgroundTaskTracker,
};
