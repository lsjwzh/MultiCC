'use strict';

const crypto = require('crypto');
const {
  explicitlyNamesTerminal,
  isTerminalGateway,
  terminalForRecord,
} = require('./dispatch/terminal-target-policy');

const TERMINAL_OPERATION_STATES = new Set([
  'completed', 'failed', 'interrupted', 'cancelled',
]);
const TOOL_NAMES = new Set([
  'wait_for_user_answer', 'request_user_input',
  'wait_for_external_result', 'get_external_wait', 'cancel_external_wait',
  'route_task', 'dispatch_master', 'dispatch_slave',
]);
const MAX_MESSAGE_LENGTH = 256 * 1024;
const MAX_RESULT_LENGTH = 512 * 1024;
const MAX_QUESTION_LENGTH = 16 * 1024;
const MAX_REASON_LENGTH = 4 * 1024;
const MAX_OPTION_LENGTH = 512;
const MAX_OPTIONS = 12;
const MAX_PENDING_EXTERNAL_WAITS = 8;
const MAX_EXTERNAL_WAIT_SECONDS = 7 * 24 * 60 * 60;
const MIN_CALLBACK_TIMEOUT_SECONDS = 10;
const DEFAULT_CAPABILITY_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_MASTER_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_MASTER_TIMEOUT_MS = 6 * 60 * 60 * 1000;

class RouterToolError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'RouterToolError';
    this.code = code;
    this.statusCode = statusCode;
    this.safe = true;
  }
}

function cleanId(value, field) {
  const text = value == null ? '' : String(value).trim();
  if (!text || text.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(text)) {
    throw new RouterToolError('invalid_arguments', `${field} is invalid`);
  }
  return text;
}

// The caller's per-turn correlation key. Unlike an id it is never used to look
// anything up, so it is bounded and sanitized rather than rejected — a client
// message id must not be able to fail a router tool call.
function cleanCorrelationId(value) {
  return String(value == null ? '' : value).trim().slice(0, 256);
}

function cleanText(value, field, maxLength) {
  const text = value == null ? '' : String(value).trim();
  if (!text) throw new RouterToolError('invalid_arguments', `${field} is required`);
  if (text.length > maxLength) {
    throw new RouterToolError('payload_too_large', `${field} exceeds ${maxLength} characters`, 413);
  }
  return text;
}

function cleanOptionalText(value, field, maxLength) {
  if (value == null || String(value).trim() === '') return '';
  return cleanText(value, field, maxLength);
}

function cleanOptions(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new RouterToolError('invalid_arguments', 'options must be an array');
  }
  if (value.length > MAX_OPTIONS) {
    throw new RouterToolError('invalid_arguments', `options cannot exceed ${MAX_OPTIONS} items`);
  }
  const options = value.map(option => cleanText(option, 'option', MAX_OPTION_LENGTH));
  if (new Set(options).size !== options.length) {
    throw new RouterToolError('invalid_arguments', 'options must be unique');
  }
  return options;
}

function rejectUnknownArguments(args, allowed) {
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      throw new RouterToolError(
        'invalid_arguments',
        `${key} is not accepted by this tool`,
      );
    }
  }
}

function cleanBaseUrl(value) {
  const text = value == null ? '' : String(value).trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    if (!['http:', 'https:'].includes(parsed.protocol)
        || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return '';
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch (_) {
    return '';
  }
}

function boundedExternalSeconds(value, field, { minimum, required = false, fallback } = {}) {
  if (value == null || value === '') {
    if (required) throw new RouterToolError('invalid_arguments', `${field} is required`);
    return fallback;
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds)
      || seconds < minimum
      || seconds > MAX_EXTERNAL_WAIT_SECONDS) {
    throw new RouterToolError(
      'invalid_arguments',
      `${field} must be between ${minimum} and ${MAX_EXTERNAL_WAIT_SECONDS}`,
    );
  }
  return seconds;
}

function boundedTimeout(value) {
  if (value == null) return DEFAULT_MASTER_TIMEOUT_MS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new RouterToolError('invalid_arguments', 'timeout_seconds must be positive');
  }
  return Math.min(MAX_MASTER_TIMEOUT_MS, Math.max(1000, Math.round(seconds * 1000)));
}

function stableSuffix(parts, cryptoImpl = crypto) {
  return cryptoImpl.createHash('sha256')
    .update(parts.map(value => String(value == null ? '' : value)).join('\0'), 'utf8')
    .digest('hex')
    .slice(0, 24);
}

function sleep(ms, signal, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout) {
  if (signal?.aborted) {
    return Promise.reject(new RouterToolError('tool_call_cancelled', 'tool call was cancelled', 499));
  }
  return new Promise((resolve, reject) => {
    let onAbort = null;
    const finish = () => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeoutFn(finish, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    if (!signal) return;
    onAbort = () => {
      clearTimeoutFn(timer);
      reject(new RouterToolError('tool_call_cancelled', 'tool call was cancelled', 499));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function createRouterToolRuntime({
  records,
  dispatchToSession,
  operations,
  completeDispatch,
  now = Date.now,
  cryptoImpl = crypto,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  pollIntervalMs = 250,
  capabilityTtlMs = DEFAULT_CAPABILITY_TTL_MS,
  resolveContext = () => null,
  onAdmitted = async () => {},
  recordUserInput,
  registerExternalWait,
  getExternalWait,
  listExternalWaits,
  cancelExternalWait,
  subscribeDispatchProgress = () => () => {},
} = {}) {
  if (!records || typeof records.get !== 'function') {
    throw new TypeError('[router-tool-runtime] records map is required');
  }
  if (typeof dispatchToSession !== 'function') {
    throw new TypeError('[router-tool-runtime] dispatchToSession port is required');
  }
  if (!operations || typeof operations.get !== 'function') {
    throw new TypeError('[router-tool-runtime] operations port is required');
  }
  if (typeof completeDispatch !== 'function') {
    throw new TypeError('[router-tool-runtime] completeDispatch port is required');
  }
  if (typeof recordUserInput !== 'function') {
    throw new TypeError('[router-tool-runtime] recordUserInput port is required');
  }
  if (typeof registerExternalWait !== 'function'
      || typeof getExternalWait !== 'function'
      || typeof listExternalWaits !== 'function'
      || typeof cancelExternalWait !== 'function') {
    throw new TypeError('[router-tool-runtime] durable external wait ports are required');
  }
  if (typeof subscribeDispatchProgress !== 'function') {
    throw new TypeError('[router-tool-runtime] dispatch progress subscription port is required');
  }

  const capabilities = new Map();

  function issueContext({
    sessionId,
    turnId = null,
    requestId = '',
    originDispatchId = null,
    userText = '',
    taskId = null,
    taskStart = false,
    taskSource = null,
    dynamic = false,
    baseUrl = '',
  } = {}) {
    const caller = records.get(sessionId);
    if (!caller) throw new RouterToolError('session_not_found', 'caller session not found', 404);
    const token = cryptoImpl.randomBytes(32).toString('base64url');
    capabilities.set(token, Object.freeze({
      sessionId: String(sessionId),
      turnId: turnId ? cleanId(turnId, 'turnId') : null,
      requestId: cleanCorrelationId(requestId),
      originDispatchId: originDispatchId ? cleanId(originDispatchId, 'originDispatchId') : null,
      userText: String(userText || '').slice(0, MAX_MESSAGE_LENGTH),
      taskId: taskId ? cleanId(taskId, 'taskId') : null,
      taskStart: taskStart === true,
      taskSource: taskSource ? cleanId(taskSource, 'taskSource') : null,
      dynamic: dynamic === true,
      baseUrl: cleanBaseUrl(baseUrl),
      expiresAt: Number(now()) + capabilityTtlMs,
    }));
    return token;
  }

  function revoke(token) {
    if (token) capabilities.delete(String(token));
  }

  function clear() {
    capabilities.clear();
  }

  function contextFor(token) {
    const context = capabilities.get(String(token || ''));
    if (!context) {
      throw new RouterToolError('invalid_capability', 'router capability is invalid', 401);
    }
    if (context.expiresAt <= Number(now())) {
      capabilities.delete(String(token));
      throw new RouterToolError('expired_capability', 'router capability has expired', 401);
    }
    if (!records.get(context.sessionId)) {
      throw new RouterToolError('session_not_found', 'caller session no longer exists', 404);
    }
    if (!context.dynamic) return context;
    const current = resolveContext(context.sessionId);
    if (!current?.turnId) {
      throw new RouterToolError('turn_not_active', 'router tools require an active turn', 409);
    }
    return Object.freeze({
      ...context,
      turnId: cleanId(current.turnId, 'turnId'),
      requestId: cleanCorrelationId(current.requestId),
      originDispatchId: current.originDispatchId
        ? cleanId(current.originDispatchId, 'originDispatchId')
        : null,
      userText: String(current.userText || '').slice(0, MAX_MESSAGE_LENGTH),
      taskId: current.taskId ? cleanId(current.taskId, 'taskId') : null,
      taskStart: current.taskStart === true,
      taskSource: current.taskSource ? cleanId(current.taskSource, 'taskSource') : null,
    });
  }

  function targetFor(context, rawTarget, allowTerminal = false) {
    const targetId = cleanId(rawTarget, 'target_session_id');
    if (targetId === context.sessionId) {
      throw new RouterToolError('self_dispatch', 'cannot route a task to the caller session');
    }
    const caller = records.get(context.sessionId);
    const target = records.get(targetId);
    if (!target) throw new RouterToolError('target_not_found', 'target session not found', 404);
    if (target.dirId !== caller.dirId && caller.type !== 'gateway') {
      throw new RouterToolError('cross_directory', 'target session must be in the same directory');
    }
    if (target.type === 'aux' || target.type === 'gateway' || target.type === 'commander') {
      throw new RouterToolError('invalid_target', 'target must be a non-system worker session');
    }
    if (isTerminalGateway(records, target)) {
      const terminal = terminalForRecord(records, target);
      throw new RouterToolError(
        'terminal_gateway_not_direct_target',
        `select terminal session ${terminal.id} instead of its execution gateway`,
        409,
      );
    }
    if (target.kind !== 'chat' && allowTerminal !== true) {
      throw new RouterToolError(
        'terminal_target_requires_explicit_opt_in',
        'terminal targets require allow_terminal=true',
        409,
      );
    }
    if (target.kind !== 'chat' && !explicitlyNamesTerminal(context.userText, target)) {
      throw new RouterToolError(
        'terminal_target_not_explicitly_requested',
        'the originating user message must name the exact terminal session id or complete label',
        409,
      );
    }
    return { targetId, target };
  }

  function admissionIdentity(context, tool, targetId, message, explicitKey) {
    const hasExplicitKey = explicitKey != null && String(explicitKey).trim() !== '';
    const key = !hasExplicitKey
      ? `router:${stableSuffix([tool, context.sessionId, context.turnId, targetId, message], cryptoImpl)}`
      : `router:${tool}:${cleanId(explicitKey, 'idempotency_key')}`;
    // A task id is logical identity, not an execution attempt. A continuation
    // carries the canonical source task across Commander/router turns; an
    // explicit idempotency key must also survive a client retry that starts a
    // fresh turn. turnId/message remain operation identity only when neither
    // stronger boundary exists.
    const inheritedTaskId = context.taskId ? cleanId(context.taskId, 'taskId') : null;
    const suffix = stableSuffix(hasExplicitKey
      ? [tool, context.sessionId, targetId, key]
      : [tool, context.sessionId, context.turnId, targetId, message, key], cryptoImpl);
    return {
      idempotencyKey: key,
      taskId: inheritedTaskId || `tsk-router-${suffix}`,
      taskStart: inheritedTaskId ? context.taskStart === true : true,
      taskSource: context.taskSource || 'router-tool',
    };
  }

  const DISPATCH_SLAVE_CALLBACK_INSTRUCTION = [
    '',
    '---',
    '【回传要求】完成本任务后，你必须调用 dispatch_slave 工具回传结果：',
    'dispatch_slave({result:"<结论/改动/证据/风险摘要>", status:"completed"})；',
    '若失败用 status:"failed"。这是 async 回执；不要轮询、读取或等待 master 会话。',
  ].join('\n');

  const SYNC_DISPATCH_INSTRUCTION = [
    '',
    '---',
    '【同步回传】宿主正在把本轮模型明确输出的 reasoning/thinking 与可公开对话进度直接回传给派发方。',
    '正常完成任务并给出最终答复即可；无需调用任何回执工具。',
  ].join('\n');

  // A short attribution line prepended to every router-tool dispatch. Without it
  // the recipient sees the task but not who sent it, and neither the task board
  // nor the chat history records the caller — the exact traceability gap that
  // made "who dispatched this to me?" unanswerable from the artifacts.
  function senderAttribution(caller, sessionId, tool) {
    const label = (caller && (caller.label || caller.name)) || sessionId || 'unknown';
    const verb = tool === 'dispatch_master' ? '双向派发方' : '任务派发方';
    return `【${verb}：${label} · ${sessionId}】\n\n`;
  }

  async function admit(context, tool, args, resultMode) {
    const { targetId } = targetFor(
      context, args.target_session_id, args.allow_terminal === true,
    );
    let message = cleanText(args.message, 'message', MAX_MESSAGE_LENGTH);
    if (resultMode === 'async') {
      message += DISPATCH_SLAVE_CALLBACK_INSTRUCTION;
    } else if (resultMode === 'sync') {
      message += SYNC_DISPATCH_INSTRUCTION;
    }
    const identity = admissionIdentity(
      context, tool, targetId, message, args.idempotency_key,
    );
    // Attribute the sender so the recipient, the task board and the chat history
    // can all trace who dispatched this. Prepended AFTER admissionIdentity so
    // dedup still keys on the caller's own content, not on the attribution line.
    const delivered = senderAttribution(records.get(context.sessionId), context.sessionId, tool) + message;
    const result = await dispatchToSession(targetId, delivered, {
      ownerSessionId: context.sessionId,
      replyTo: resultMode === 'sync' || resultMode === 'async' ? context.sessionId : null,
      oneWay: resultMode !== 'sync' && resultMode !== 'async',
      resultMode,
      requireIdle: false,
      idempotencyKey: identity.idempotencyKey,
      taskId: identity.taskId,
      taskStart: identity.taskStart,
      taskSource: identity.taskSource,
      taskText: identity.taskStart ? delivered : undefined,
    });
    if (!result || result.ok !== true) {
      throw new RouterToolError(
        result?.code || 'dispatch_rejected',
        result?.error || 'dispatch was rejected',
        409,
      );
    }
    try {
      await onAdmitted({
        callerSessionId: context.sessionId,
        // The turn that actually made this call, captured here rather than read
        // back from live session state by the observer: by the time an observer
        // runs, the caller may already be on its next turn.
        callerTurnId: context.turnId || '',
        callerRequestId: context.requestId || '',
        targetSessionId: targetId,
        taskId: identity.taskId,
        operationId: result.operationId,
        status: result.status || 'admitted',
        duplicate: result.duplicate === true,
        resultMode,
        taskStart: identity.taskStart,
        taskSource: identity.taskSource,
        taskText: identity.taskStart ? message : '',
      });
    } catch (_) {}
    return {
      ...result,
      targetSessionId: targetId,
      taskId: identity.taskId,
      idempotencyKey: identity.idempotencyKey,
    };
  }

  async function waitForOperation(operationId, timeoutMs, signal) {
    const deadline = Number(now()) + timeoutMs;
    for (;;) {
      const operation = await operations.get(operationId);
      if (!operation) {
        throw new RouterToolError('operation_not_found', 'dispatch operation not found', 404);
      }
      if (TERMINAL_OPERATION_STATES.has(operation.status)) return operation;
      if (Number(now()) >= deadline) return null;
      await sleep(
        Math.min(pollIntervalMs, Math.max(1, deadline - Number(now()))),
        signal,
        setTimeoutFn,
        clearTimeoutFn,
      );
    }
  }

  async function routeTask(context, args) {
    const admitted = await admit(context, 'route_task', args, 'none');
    return {
      ok: true,
      status: admitted.status,
      operation_id: admitted.operationId,
      target_session_id: admitted.targetSessionId,
      execution_session_id: admitted.chatId || admitted.targetSessionId,
      task_id: admitted.taskId,
      duplicate: admitted.duplicate,
      queued: true,
    };
  }

  function dispatchResult(operation, admitted) {
    const result = operation?.result && typeof operation.result === 'object'
      ? operation.result : {};
    const status = operation?.status || 'failed';
    const text = String(result.text || result.error || operation?.lastError || '').trim();
    return {
      ok: status === 'completed',
      mode: 'sync',
      status,
      operation_id: operation.id,
      target_session_id: admitted.targetSessionId,
      execution_session_id: admitted.chatId || admitted.targetSessionId,
      task_id: admitted.taskId,
      duplicate: admitted.duplicate,
      queued: false,
      result: text,
      ...(status === 'completed' ? {} : { error: text || status }),
    };
  }

  async function dispatchMaster(context, args, options = {}) {
    rejectUnknownArguments(args, new Set([
      'target_session_id', 'message', 'idempotency_key', 'allow_terminal',
      'mode', 'timeout_seconds',
    ]));
    const mode = String(args.mode || '');
    if (mode !== 'sync' && mode !== 'async') {
      throw new RouterToolError('invalid_arguments', 'mode must be sync or async');
    }
    if (mode === 'async' && args.timeout_seconds != null) {
      throw new RouterToolError(
        'invalid_arguments',
        'timeout_seconds is only valid when mode is sync',
      );
    }
    let admitted;
    try {
      admitted = await admit(context, 'dispatch_master', args, mode);
    } catch (e) {
      const code = (e && e.code) || 'dispatch_rejected';
      if (code !== 'dispatch_rejected' && code !== 'target_busy') throw e;
      return {
        ok: false,
        fifo: true,
        status: 'rejected_possible_fifo',
        error: (e && (e.message || e.error)) || String(e),
        code,
        target_session_id: args.target_session_id,
        retryable: true,
      };
    }
    if (mode === 'async') {
      return {
        ok: true,
        mode,
        admitted: true,
        status: 'admitted',
        operation_id: admitted.operationId,
        target_session_id: admitted.targetSessionId,
        execution_session_id: admitted.chatId || admitted.targetSessionId,
        task_id: admitted.taskId,
        duplicate: admitted.duplicate,
        queued: true,
        instruction: 'Do not poll, inspect, or wait on the worker. Continue only independent work, then end this turn naturally. MultiCC will inject the dispatch result as a new message and wake this session automatically.',
      };
    }

    const timeoutMs = boundedTimeout(args.timeout_seconds);
    let unsubscribe = () => {};
    try {
      unsubscribe = subscribeDispatchProgress({
        operationId: admitted.operationId,
        targetSessionId: admitted.targetSessionId,
        onProgress: typeof options.onProgress === 'function' ? options.onProgress : () => {},
      }) || (() => {});
      const operation = await waitForOperation(admitted.operationId, timeoutMs, options.signal);
      if (!operation) {
        return {
          ok: false,
          mode,
          status: 'pending',
          timed_out: true,
          operation_id: admitted.operationId,
          target_session_id: admitted.targetSessionId,
          execution_session_id: admitted.chatId || admitted.targetSessionId,
          task_id: admitted.taskId,
          duplicate: admitted.duplicate,
          queued: true,
          instruction: 'The worker is still running. Retry dispatch_master with the same idempotency_key and mode="sync" to reattach without creating a duplicate operation.',
        };
      }
      return dispatchResult(operation, admitted);
    } finally {
      try { unsubscribe(); } catch (_) {}
    }
  }

  async function dispatchSlave(context, args) {
    if (!context.originDispatchId) {
      throw new RouterToolError(
        'dispatch_lineage_required',
        'dispatch_slave is only available inside a dispatched turn',
        403,
      );
    }
    const operation = await operations.get(context.originDispatchId);
    if (!operation || operation.kind !== 'dispatch') {
      throw new RouterToolError('operation_not_found', 'origin dispatch operation not found', 404);
    }
    if (operation.spec.chatId !== context.sessionId) {
      throw new RouterToolError('dispatch_lineage_mismatch', 'origin dispatch belongs to another session', 403);
    }
    if (operation.spec.resultMode !== 'async' && operation.spec.resultMode !== 'tool') {
      throw new RouterToolError(
        'invalid_result_mode',
        'dispatch_slave is only accepted for an async dispatch',
        409,
      );
    }
    if (TERMINAL_OPERATION_STATES.has(operation.status)) {
      return {
        ok: operation.status === 'completed',
        accepted: true,
        duplicate: true,
        status: operation.status,
        operation_id: operation.id,
      };
    }
    const status = args.status == null ? 'completed' : String(args.status);
    if (status !== 'completed' && status !== 'failed') {
      throw new RouterToolError('invalid_arguments', 'status must be completed or failed');
    }
    const text = cleanText(args.result, 'result', MAX_RESULT_LENGTH);
    const completed = await completeDispatch(operation.id, {
      status,
      sessionName: context.sessionId,
      text,
      ...(status === 'failed' ? { error: text } : {}),
      source: 'dispatch_slave',
    });
    if (!completed || completed.ok !== true) {
      throw new RouterToolError(
        completed?.code || 'completion_rejected',
        'dispatch result could not be persisted',
        409,
      );
    }
    return {
      ok: status === 'completed',
      accepted: true,
      duplicate: !!completed.idempotent,
      status,
      operation_id: operation.id,
    };
  }

  async function requestUserInput(context, args) {
    const question = cleanText(args.question, 'question', MAX_QUESTION_LENGTH);
    const reason = cleanOptionalText(args.reason, 'reason', MAX_REASON_LENGTH);
    const options = cleanOptions(args.options);
    const allowMultiple = args.allow_multiple === true;
    if (allowMultiple && options.length < 2) {
      throw new RouterToolError(
        'invalid_arguments',
        'allow_multiple requires at least two options',
      );
    }
    const requestId = `usrq-${stableSuffix([
      context.sessionId, context.turnId, question, reason,
      options.join('\0'), allowMultiple,
    ], cryptoImpl)}`;
    const recorded = await recordUserInput({
      requestId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      question,
      reason,
      options,
      allowMultiple,
    });
    if (!recorded || recorded.ok !== true) {
      throw new RouterToolError(
        recorded?.code || 'user_input_signal_rejected',
        recorded?.error || 'user input signal was rejected',
        recorded?.statusCode || 409,
      );
    }
    return {
      ok: true,
      status: 'waiting_reply_signal_recorded',
      request_id: requestId,
      duplicate: recorded.duplicate === true,
      instruction: 'Present the recorded question to the user as the final response and stop this turn.',
    };
  }

  function externalWaitSummary(wait) {
    const metadata = wait?.metadata && typeof wait.metadata === 'object'
      ? wait.metadata : {};
    return {
      wait_id: wait.id,
      mode: wait.mode,
      status: wait.status,
      reason: String(metadata.reason ?? wait.reason ?? ''),
      due_at: metadata.dueAt ?? wait.dueAt ?? null,
      created_at: wait.createdAt ?? null,
      resolved_at: wait.resolvedAt ?? null,
      cancelled_at: wait.cancelledAt ?? null,
    };
  }

  function assertOwnedExternalWait(context, wait, waitId) {
    if (!wait
        || wait.sessionId !== context.sessionId
        || !/^wait-router-[a-f0-9]{24}$/.test(String(wait.id || ''))
        || wait.metadata?.source !== 'router-mcp') {
      throw new RouterToolError(
        'external_wait_not_found',
        `external wait ${waitId} was not found for this session`,
        404,
      );
    }
    return wait;
  }

  async function ownedExternalWait(context, rawId) {
    const waitId = cleanId(rawId, 'wait_id');
    if (!/^wait-router-[a-f0-9]{24}$/.test(waitId)) {
      throw new RouterToolError(
        'external_wait_not_found',
        `external wait ${waitId} was not found for this session`,
        404,
      );
    }
    return assertOwnedExternalWait(
      context,
      await getExternalWait(waitId),
      waitId,
    );
  }

  function callbackUrlFor(context, registration) {
    if (registration.callbackUrl) return String(registration.callbackUrl);
    if (!context.baseUrl || !registration.token) return null;
    return `${context.baseUrl}/api/wait/${encodeURIComponent(registration.id)}/resolve`
      + `?token=${encodeURIComponent(registration.token)}`;
  }

  function normalizeExternalWait(context, args) {
    rejectUnknownArguments(args, new Set([
      'mode', 'reason', 'timeout_seconds', 'delay_seconds', 'idempotency_key',
    ]));
    const mode = String(args.mode || '');
    if (mode !== 'callback' && mode !== 'delay') {
      throw new RouterToolError(
        'invalid_arguments',
        'mode must be callback or delay',
      );
    }
    const reason = cleanText(args.reason, 'reason', MAX_REASON_LENGTH);
    const explicitKey = args.idempotency_key == null
      || String(args.idempotency_key).trim() === ''
      ? null
      : cleanId(args.idempotency_key, 'idempotency_key');
    let timeoutSec = null;
    let delaySec = null;
    if (mode === 'callback') {
      if (args.delay_seconds != null) {
        throw new RouterToolError(
          'invalid_arguments',
          'delay_seconds is valid only for delay mode',
        );
      }
      timeoutSec = boundedExternalSeconds(args.timeout_seconds, 'timeout_seconds', {
        minimum: MIN_CALLBACK_TIMEOUT_SECONDS,
        fallback: 1800,
      });
    } else {
      if (args.timeout_seconds != null) {
        throw new RouterToolError(
          'invalid_arguments',
          'timeout_seconds is valid only for callback mode',
        );
      }
      delaySec = boundedExternalSeconds(args.delay_seconds, 'delay_seconds', {
        minimum: 1,
        required: true,
      });
    }
    const registrationFingerprint = stableSuffix([
      mode, reason, timeoutSec, delaySec,
    ], cryptoImpl);
    const waitId = `wait-router-${stableSuffix(explicitKey
      ? ['external-wait', context.sessionId, explicitKey]
      : [
        'external-wait', context.sessionId, context.turnId, mode,
        registrationFingerprint,
      ], cryptoImpl)}`;
    return {
      mode,
      reason,
      explicitKey,
      timeoutSec,
      delaySec,
      registrationFingerprint,
      waitId,
    };
  }

  function duplicateExternalWait(context, existing, spec) {
    assertOwnedExternalWait(context, existing, spec.waitId);
    if (existing.mode !== spec.mode
        || (existing.metadata?.registrationFingerprint
            && existing.metadata.registrationFingerprint !== spec.registrationFingerprint)) {
      throw new RouterToolError(
        'idempotency_conflict',
        'idempotency_key is already bound to a different wait',
        409,
      );
    }
    return {
      ok: true,
      ...externalWaitSummary(existing),
      duplicate: true,
      ...(spec.mode === 'callback'
        ? {
          callback_url: null,
          callback_url_unavailable: true,
          instruction: 'This is an at-most-once replay. The callback capability is not rotated or re-exposed.',
        }
        : {
          instruction: existing.status === 'pending'
            ? 'The existing durable delay remains scheduled.'
            : `The existing durable delay is already ${existing.status}; no new wait was created.`,
        }),
    };
  }

  async function waitForExternalResult(context, args) {
    const spec = normalizeExternalWait(context, args);
    const existing = await getExternalWait(spec.waitId);
    if (existing) return duplicateExternalWait(context, existing, spec);

    const pending = await listExternalWaits(context.sessionId);
    const pendingRouterWaits = Array.isArray(pending)
      ? pending.filter(wait => String(wait?.id || '').startsWith('wait-router-'))
      : [];
    if (pendingRouterWaits.length >= MAX_PENDING_EXTERNAL_WAITS) {
      throw new RouterToolError(
        'external_wait_limit',
        `a session cannot have more than ${MAX_PENDING_EXTERNAL_WAITS} pending external waits`,
        409,
      );
    }

    let registered;
    try {
      registered = await registerExternalWait({
        id: spec.waitId,
        session: context.sessionId,
        mode: spec.mode,
        reason: spec.reason,
        source: 'router-mcp',
        registrationFingerprint: spec.registrationFingerprint,
        ...(spec.mode === 'callback'
          ? { timeoutSec: spec.timeoutSec }
          : { delaySec: spec.delaySec }),
      });
    } catch (error) {
      if (error?.code !== 'WAIT_ALREADY_EXISTS') throw error;
      const raced = await getExternalWait(spec.waitId);
      return duplicateExternalWait(context, raced, spec);
    }
    const summary = externalWaitSummary(registered);
    if (spec.mode === 'callback') {
      const callbackUrl = callbackUrlFor(context, registered);
      if (!callbackUrl) {
        await Promise.resolve(cancelExternalWait(spec.waitId)).catch(() => {});
        throw new RouterToolError(
          'callback_url_unavailable',
          'callback URL could not be created for this process capability',
          503,
        );
      }
      return {
        ok: true,
        ...summary,
        duplicate: false,
        callback_url: callbackUrl,
        callback_url_unavailable: false,
        instruction: 'Give this capability URL only to the external producer. End the turn after any remaining work; MultiCC will resume this session when the callback arrives.',
      };
    }
    return {
      ok: true,
      ...summary,
      due_at: registered.dueAt ?? summary.due_at,
      duplicate: false,
      instruction: 'The wake-up is durable. End the turn after any remaining work; MultiCC will resume this session when the delay expires.',
    };
  }

  async function getExternalWaitStatus(context, args) {
    rejectUnknownArguments(args, new Set(['wait_id']));
    const wait = await ownedExternalWait(context, args.wait_id);
    return { ok: true, ...externalWaitSummary(wait) };
  }

  async function cancelExternalWaitForContext(context, args) {
    rejectUnknownArguments(args, new Set(['wait_id']));
    const wait = await ownedExternalWait(context, args.wait_id);
    const result = await cancelExternalWait(wait.id);
    if (!result || result.ok !== true) {
      throw new RouterToolError(
        result?.code || 'external_wait_cancel_rejected',
        result?.status
          ? `external wait is ${result.status}`
          : 'external wait could not be cancelled',
        result?.code === 'not_found' ? 404 : 409,
      );
    }
    const current = await getExternalWait(wait.id);
    return {
      ok: true,
      ...(current ? externalWaitSummary(current) : {
        wait_id: wait.id,
        mode: wait.mode,
        status: 'cancelled',
      }),
      duplicate: result.idempotent === true,
    };
  }

  async function execute(token, tool, args = {}, options = {}) {
    if (!TOOL_NAMES.has(tool)) {
      throw new RouterToolError('unknown_tool', 'unknown router tool', 404);
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new RouterToolError('invalid_arguments', 'tool arguments must be an object');
    }
    const context = contextFor(token);
    if (tool === 'wait_for_user_answer' || tool === 'request_user_input') {
      return requestUserInput(context, args);
    }
    if (tool === 'wait_for_external_result') {
      return waitForExternalResult(context, args);
    }
    if (tool === 'get_external_wait') return getExternalWaitStatus(context, args);
    if (tool === 'cancel_external_wait') {
      return cancelExternalWaitForContext(context, args);
    }
    if (tool === 'route_task') return routeTask(context, args);
    if (tool === 'dispatch_master') return dispatchMaster(context, args, options);
    return dispatchSlave(context, args);
  }

  return Object.freeze({
    issueContext,
    revoke,
    clear,
    execute,
    contextFor,
  });
}

module.exports = {
  DEFAULT_CAPABILITY_TTL_MS,
  DEFAULT_MASTER_TIMEOUT_MS,
  MAX_MASTER_TIMEOUT_MS,
  RouterToolError,
  TERMINAL_OPERATION_STATES,
  createRouterToolRuntime,
};
