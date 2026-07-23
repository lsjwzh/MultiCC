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
  'request_user_input', 'route_task', 'dispatch_master', 'dispatch_slave',
]);
const MAX_MESSAGE_LENGTH = 256 * 1024;
const MAX_RESULT_LENGTH = 512 * 1024;
const MAX_QUESTION_LENGTH = 16 * 1024;
const MAX_REASON_LENGTH = 4 * 1024;
const MAX_OPTION_LENGTH = 512;
const MAX_OPTIONS = 12;
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
  tick = async () => {},
  now = Date.now,
  cryptoImpl = crypto,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  pollIntervalMs = 250,
  capabilityTtlMs = DEFAULT_CAPABILITY_TTL_MS,
  resolveContext = () => null,
  onAdmitted = async () => {},
  recordUserInput,
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

  const capabilities = new Map();

  function issueContext({
    sessionId,
    turnId = null,
    originDispatchId = null,
    userText = '',
    dynamic = false,
  } = {}) {
    const caller = records.get(sessionId);
    if (!caller) throw new RouterToolError('session_not_found', 'caller session not found', 404);
    const token = cryptoImpl.randomBytes(32).toString('base64url');
    capabilities.set(token, Object.freeze({
      sessionId: String(sessionId),
      turnId: turnId ? cleanId(turnId, 'turnId') : null,
      originDispatchId: originDispatchId ? cleanId(originDispatchId, 'originDispatchId') : null,
      userText: String(userText || '').slice(0, MAX_MESSAGE_LENGTH),
      dynamic: dynamic === true,
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
      originDispatchId: current.originDispatchId
        ? cleanId(current.originDispatchId, 'originDispatchId')
        : null,
      userText: String(current.userText || '').slice(0, MAX_MESSAGE_LENGTH),
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
    if (target.dirId !== caller.dirId) {
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
    const key = explicitKey == null || String(explicitKey).trim() === ''
      ? `router:${stableSuffix([tool, context.sessionId, context.turnId, targetId, message], cryptoImpl)}`
      : `router:${tool}:${cleanId(explicitKey, 'idempotency_key')}`;
    const suffix = stableSuffix([tool, context.sessionId, context.turnId, targetId, message, key], cryptoImpl);
    return {
      idempotencyKey: key,
      taskId: `tsk-router-${suffix}`,
    };
  }

  async function admit(context, tool, args, resultMode) {
    const { targetId } = targetFor(
      context, args.target_session_id, args.allow_terminal === true,
    );
    const message = cleanText(args.message, 'message', MAX_MESSAGE_LENGTH);
    const identity = admissionIdentity(
      context, tool, targetId, message, args.idempotency_key,
    );
    const result = await dispatchToSession(targetId, message, {
      ownerSessionId: context.sessionId,
      replyTo: resultMode === 'tool' ? context.sessionId : null,
      oneWay: resultMode !== 'tool',
      resultMode,
      requireIdle: false,
      idempotencyKey: identity.idempotencyKey,
      taskId: identity.taskId,
      taskStart: true,
      taskSource: 'router-tool',
      taskText: message,
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
        targetSessionId: targetId,
        taskId: identity.taskId,
        operationId: result.operationId,
        status: result.status || 'admitted',
        resultMode,
      });
    } catch (_) {}
    Promise.resolve(tick()).catch(() => {});
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

  async function dispatchMaster(context, args, signal) {
    const admitted = await admit(context, 'dispatch_master', args, 'tool');
    const timeoutMs = boundedTimeout(args.timeout_seconds);
    const operation = await waitForOperation(admitted.operationId, timeoutMs, signal);
    if (!operation) {
      return {
        ok: false,
        status: 'timed_out',
        operation_id: admitted.operationId,
        target_session_id: admitted.targetSessionId,
        execution_session_id: admitted.chatId || admitted.targetSessionId,
        task_id: admitted.taskId,
        retryable: true,
      };
    }
    return {
      ok: operation.status === 'completed',
      status: operation.status,
      operation_id: operation.id,
      target_session_id: operation.spec.targetId,
      execution_session_id: operation.spec.chatId,
      task_id: operation.spec.taskId || admitted.taskId,
      result: operation.result || null,
      duplicate: admitted.duplicate,
    };
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
    if (operation.spec.resultMode !== 'tool') {
      throw new RouterToolError('invalid_result_mode', 'origin dispatch does not accept a tool result', 409);
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

  async function execute(token, tool, args = {}, options = {}) {
    if (!TOOL_NAMES.has(tool)) {
      throw new RouterToolError('unknown_tool', 'unknown router tool', 404);
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new RouterToolError('invalid_arguments', 'tool arguments must be an object');
    }
    const context = contextFor(token);
    if (tool === 'request_user_input') return requestUserInput(context, args);
    if (tool === 'route_task') return routeTask(context, args);
    if (tool === 'dispatch_master') return dispatchMaster(context, args, options.signal);
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
