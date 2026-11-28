'use strict';

const crypto = require('crypto');
const secretAudit = require('./native/binding').secretAudit;
// The terminal-target rules live in Rust (`native/addon/src/terminal_target.rs`);
// only the live record map stays in Node and is passed in as a port.
const { getNative } = require('./native/binding');

const TERMINAL_OPERATION_STATES = new Set([
  'completed', 'failed', 'interrupted', 'cancelled',
]);
const TOOL_NAMES = new Set([
  'wait_for_user_answer', 'request_user_input',
  'request_secret_input', 'list_secrets',
  'run_with_secrets', 'http_request_with_secret',
  'get_task_context',
  'generate_image',
  'wait_for_external_result', 'get_external_wait', 'cancel_external_wait',
  'route_task', 'dispatch_master', 'dispatch_slave', 'dispatch_cancel',
  'dispatch_status', 'detached_result', 'list_machines',
]);
const MAX_MESSAGE_LENGTH = 256 * 1024;
const MAX_RESULT_LENGTH = 512 * 1024;
const MAX_QUESTION_LENGTH = 16 * 1024;
const MAX_REASON_LENGTH = 4 * 1024;
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
    if (['task_identity_mismatch', 'task_shell_route_required', 'idempotency_conflict',
      'OPERATION_CONFLICT', 'invalid_arguments', 'task_deleted', 'task_archived'].includes(code)) this.retryable = false;
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
  createTask,
  operations,
  completeDispatch,
  now = Date.now,
  cryptoImpl = crypto,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  pollIntervalMs = 250,
  capabilityTtlMs = DEFAULT_CAPABILITY_TTL_MS,
  resolveContext = () => null,
  getTaskContext = async () => null,
  onAdmitted = async () => {},
  recordUserInput,
  listSecrets = () => [],
  // Host-side executor that resolves vault values itself; this runtime only
  // ever forwards entry names and receives already-redacted results.
  secretTools = null,
  registerExternalWait,
  getExternalWait,
  listExternalWaits,
  cancelExternalWait,
  subscribeDispatchProgress = () => () => {},
  detachedResult,
  schedulerStatus = async () => null,
  cancelQueuedEntry = null,
  cancelActiveTurnFn = null,
  onDispatchCancelled = () => {},
  imageBridge = null,
  dataRoot = null,
  crossMachineBridge = null,
} = {}) {
  if (!records || typeof records.get !== 'function') {
    throw new TypeError('[router-tool-runtime] records map is required');
  }
  if (typeof dispatchToSession !== 'function') {
    throw new TypeError('[router-tool-runtime] dispatchToSession port is required');
  }
  if (!operations || typeof operations.get !== 'function'
      || typeof operations.list !== 'function') {
    throw new TypeError('[router-tool-runtime] operations get/list ports are required');
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

  const remoteWatches = new Map();
  const remoteProgressListeners = new Map();

  function getCrossMachine() {
    if (crossMachineBridge) return crossMachineBridge;
    const root = dataRoot ? String(dataRoot) : '';
    if (!root) return null;
    return {
      async listMachines() {
        const raw = await getNative().machineOperation(root, 'list', '{}');
        return JSON.parse(raw);
      },
      async requestJson(machineId, method, apiPath, body) {
        const raw = await getNative().crossMachineRequestJson(
          root,
          machineId,
          method,
          apiPath,
          body == null ? null : JSON.stringify(body),
        );
        return JSON.parse(raw);
      },
      watchStart(machineId, onEvent) {
        return getNative().crossMachineWatchStart(root, machineId, onEvent);
      },
      watchStop(watchId) {
        return getNative().crossMachineWatchStop(watchId);
      },
    };
  }

  function stopAllRemoteWatches() {
    const cm = getCrossMachine();
    for (const entry of remoteWatches.values()) {
      if (entry.stopTimer) clearTimeoutFn(entry.stopTimer);
      if (cm && entry.watchId != null) {
        try { cm.watchStop(entry.watchId); } catch (_) {}
      }
    }
    remoteWatches.clear();
    remoteProgressListeners.clear();
  }

  function clear() {
    capabilities.clear();
    stopAllRemoteWatches();
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
    if (getNative().dispatchIsTerminalGateway(records, target)) {
      const terminal = getNative().dispatchTerminalForRecord(records, target);
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
    if (target.kind !== 'chat' && !getNative().dispatchExplicitlyNamesTerminal(context.userText, target)) {
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
    return { idempotencyKey: key };
  }

  async function resolveAdmissionTarget(context, tool, args, message) {
    const hasTarget = args.target_session_id != null;
    const hasNew = args.new_task != null;
    if (hasTarget === hasNew) throw new RouterToolError('invalid_arguments', 'Provide exactly one of target_session_id or new_task');
    if (hasTarget) {
      const { targetId } = targetFor(context, args.target_session_id, args.allow_terminal === true);
      return { targetId, identity: admissionIdentity(context, tool, targetId, message, args.idempotency_key) };
    }
    if (args.allow_terminal === true || typeof args.new_task !== 'object' || Array.isArray(args.new_task)) {
      throw new RouterToolError('invalid_arguments', 'new_task must be a chat task configuration');
    }
    const input = args.new_task;
    rejectUnknownArguments(input, new Set(['title', 'cli', 'model', 'provider', 'effort']));
    const title = cleanText(input.title, 'new_task.title', 120);
    const config = { title };
    for (const key of ['cli', 'model', 'provider', 'effort']) {
      if (input[key] != null) config[key] = cleanText(input[key], `new_task.${key}`, 256);
    }
    const identity = admissionIdentity(context, tool, JSON.stringify(config), message, args.idempotency_key);
    if (typeof createTask !== 'function') throw new RouterToolError('task_creation_unavailable', 'canonical task creation is unavailable', 503);
    const created = await canonicalCall(() => createTask({ ...config, dirId: records.get(context.sessionId).dirId,
      clientMsgId: `router_${stableSuffix([context.sessionId, tool, identity.idempotencyKey], cryptoImpl)}` }));
    if (!created?.ok) throw new RouterToolError(created?.code || 'task_creation_failed', created?.error || 'task creation failed', 409);
    const { targetId } = targetFor(context, created.sessionId);
    return { targetId, identity };
  }
  async function canonicalCall(run) {
    try { return await run(); } catch (error) {
      if ([400, 403, 404, 409, 429].includes(error?.status)) {
        throw new RouterToolError(error.code || 'dispatch_rejected', error.code || 'dispatch_rejected', error.status);
      }
      throw error;
    }
  }

  // The receipt address travels WITH the task: the operation id is printed in
  // the task text itself, so the worker can receipt by id from any turn -
  // including after an interruption/continuation split, when the turn that
  // carried the dispatch lineage is long gone. dispatch_slave resolves the
  // operation purely by this id (plus an addressed-to-you check), never by
  // "which turn am I in".
  function slaveCallbackInstruction(operationId) {
    return [
      '',
      '---',
      '[Receipt required] When this task is done, you must call the dispatch_slave tool to return the result:',
      `dispatch_slave({operation_id:"${operationId}", result:"<summary of conclusion / changes / evidence / risks>", status:"completed"})`,
      'Use status:"failed" on failure. Without a receipt the master never receives the result: as soon as the dispatched turn ends, the system marks the operation failed automatically;',
      'you can still submit a late receipt any time with the operation_id above and the system corrects the record. The operation_id is stable across turns',
      'and remains valid no matter how many times the task is interrupted or continued.',
      'This is an async receipt: do not poll, read, or wait on the master session.',
    ].join('\n');
  }

  const SYNC_DISPATCH_INSTRUCTION = [
    '',
    '---',
    '[Sync relay] The host is streaming the reasoning/thinking this turn emits explicitly, plus safe dialogue progress, straight back to the dispatcher.',
    'Just complete the task normally and give your final answer; no receipt tool call is needed.',
  ].join('\n');

  // A short attribution line prepended to every router-tool dispatch. Without it
  // the recipient sees the task but not who sent it, and neither the task board
  // nor the chat history records the caller — the exact traceability gap that
  // made "who dispatched this to me?" unanswerable from the artifacts.
  function senderAttribution(caller, sessionId, tool) {
    const label = (caller && (caller.label || caller.name)) || sessionId || 'unknown';
    const verb = tool === 'dispatch_master' ? 'Dispatched (two-way) by' : 'Dispatched by';
    return `[${verb}: ${label} · ${sessionId}]\n\n`;
  }

  async function admit(context, tool, args, resultMode) {
    let message = cleanText(args.message, 'message', MAX_MESSAGE_LENGTH);
    const { targetId, identity } = await resolveAdmissionTarget(context, tool, args, message);
    // The operation id is derived from the admission identity, so a client
    // retry (same idempotency key) recomputes the SAME id and lands in the
    // idempotent early-return of admitDispatch, while any different content
    // or turn derives a different id. Appended after identity so dedup still
    // keys on the caller's own content only.
    let slaveOperationId;
    if (resultMode === 'async') {
      slaveOperationId = `op_${stableSuffix([
        'dispatch-slave', tool, context.sessionId, targetId, identity.idempotencyKey,
      ], cryptoImpl)}`;
      message += slaveCallbackInstruction(slaveOperationId);
    } else if (resultMode === 'sync') {
      message += SYNC_DISPATCH_INSTRUCTION;
    }
    // Attribute the sender so the recipient, the task board and the chat history
    // can all trace who dispatched this. Prepended AFTER admissionIdentity so
    // dedup still keys on the caller's own content, not on the attribution line.
    const delivered = senderAttribution(records.get(context.sessionId), context.sessionId, tool) + message;
    const result = await canonicalCall(() => dispatchToSession(targetId, delivered, {
      ownerSessionId: context.sessionId,
      replyTo: resultMode === 'sync' || resultMode === 'async' ? context.sessionId : null,
      oneWay: resultMode !== 'sync' && resultMode !== 'async',
      resultMode,
      requireIdle: false,
      idempotencyKey: identity.idempotencyKey,
      // Precomputed above so the id printed in the task text is the id the
      // store actually admits - the worker's receipt address can never drift.
      operationId: slaveOperationId,
    }));
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
        taskId: result.taskId || null,
        operationId: result.operationId,
        status: result.status || 'admitted',
        duplicate: result.duplicate === true,
        resultMode,
        taskStart: false,
        taskSource: 'task-shell',
        taskText: '',
      });
    } catch (_) {}
    return {
      ...result,
      targetSessionId: targetId,
      taskId: result.taskId || null,
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

  // Where did the task actually land? dispatchToSession reports the target's
  // scheduler disposition ('queued' with a FIFO position | 'started' |
  // 'unknown'), and every receipt must carry it truthfully: a master deciding
  // between "wait out the FIFO" and "cancel + re-route" needs exactly this.
  function queueFields(admitted) {
    const queue = admitted.queue && typeof admitted.queue === 'object'
      ? admitted.queue
      : { state: 'unknown' };
    return {
      queued: queue.state !== 'started',
      queue_state: queue.state,
      ...(queue.state === 'queued' && Number.isFinite(queue.position)
        ? { queue_position: queue.position, queue_length: queue.length } : {}),
      ...(queue.state === 'queued' ? {
        instruction: 'The task sits in the target FIFO. To re-route it elsewhere, call dispatch_cancel with this operation_id first (a queued task is removed silently, the worker never sees it), then route to the new target — re-dispatching without cancelling runs the task twice. To keep waiting, do nothing.',
      } : {}),
    };
  }

  function releaseRemoteWatchOp(machineId, operationId) {
    const entry = remoteWatches.get(machineId);
    if (!entry) return;
    entry.ops.delete(operationId);
    if (entry.ops.size > 0 || entry.stopTimer) return;
    entry.stopTimer = setTimeoutFn(() => {
      entry.stopTimer = null;
      if (entry.ops.size > 0) return;
      remoteWatches.delete(machineId);
      const cm = getCrossMachine();
      if (cm && entry.watchId != null) {
        try { cm.watchStop(entry.watchId); } catch (_) {}
      }
    }, 15_000);
    if (entry.stopTimer && typeof entry.stopTimer.unref === 'function') entry.stopTimer.unref();
  }

  async function settleRemoteReceipt(machineId, payload) {
    if (!payload || typeof payload !== 'object') return;
    const opId = typeof payload.operationId === 'string' ? payload.operationId.trim() : '';
    if (!opId) return;
    const operation = await operations.get(opId);
    if (!operation || operation.kind !== 'dispatch' || operation.spec?.remoteMachineId !== machineId) {
      return;
    }
    const status = String(payload.status || 'failed');
    if (!TERMINAL_OPERATION_STATES.has(status)) return;
    const rawResult = payload.result && typeof payload.result === 'object' ? payload.result : {};
    const resultPayload = {
      ...rawResult,
      status,
      sessionName: operation.spec?.chatId || operation.spec?.targetId || opId,
      ...(payload.lastError && !rawResult.error ? { error: String(payload.lastError) } : {}),
    };
    const isAlreadyTerminal = TERMINAL_OPERATION_STATES.has(operation.status);
    const shouldResettle = payload.resettle === true || isAlreadyTerminal;
    try {
      await completeDispatch(
        opId,
        resultPayload,
        shouldResettle ? { resettle: true } : undefined,
      );
    } catch (err) {
      if (err?.code !== 'OPERATION_CONFLICT') throw err;
    }
    releaseRemoteWatchOp(machineId, opId);
    const cm = getCrossMachine();
    if (cm) {
      const settle = Math.max(1, Number(payload.settle || 1) || 1);
      cm.requestJson(machineId, 'POST', '/api/cross-machine/receipts/ack', {
        operationId: opId,
        settle,
      }).catch(() => {});
    }
  }

  function handleRemoteEvent(machineId, rawJson) {
    let parsed;
    try {
      parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
    } catch (_) { return true; }
    if (!parsed || typeof parsed !== 'object') return true;
    if (parsed.event === 'progress') {
      const opId = parsed.data?.operationId;
      const listeners = opId ? remoteProgressListeners.get(opId) : null;
      if (listeners) {
        for (const fn of listeners) {
          try { fn(parsed.data.progress); } catch (_) {}
        }
      }
      return true;
    }
    if (parsed.event === 'receipt') {
      settleRemoteReceipt(machineId, parsed.data).catch(() => {});
    }
    return true;
  }

  function ensureRemoteWatch(machineId, operationId) {
    const cm = getCrossMachine();
    if (!cm || !machineId) return;
    let entry = remoteWatches.get(machineId);
    if (!entry) {
      const watchId = cm.watchStart(machineId, (first, second) => {
        if (first instanceof Error) return true;
        const raw = second !== undefined ? second : first;
        return handleRemoteEvent(machineId, raw);
      });
      entry = { watchId, ops: new Set(), stopTimer: null };
      remoteWatches.set(machineId, entry);
    } else if (entry.stopTimer) {
      clearTimeoutFn(entry.stopTimer);
      entry.stopTimer = null;
    }
    if (operationId) entry.ops.add(operationId);
  }

  function recoverRemoteDispatch(operation) {
    const machineId = operation?.spec?.remoteMachineId;
    if (!machineId || !operation?.id) return;
    ensureRemoteWatch(machineId, operation.id);
    const cm = getCrossMachine();
    if (!cm) return;
    cm.requestJson(
      machineId,
      'GET',
      `/api/cross-machine/dispatches/${encodeURIComponent(operation.id)}`,
      null,
    ).then(res => {
      if (res?.status === 200 && res?.data?.dispatch?.terminal) {
        return settleRemoteReceipt(machineId, res.data.dispatch);
      }
    }).catch(() => {});
  }

  async function listMachines(context, args) {
    rejectUnknownArguments(args, new Set(['machine_id']));
    const cm = getCrossMachine();
    if (!cm) {
      throw new RouterToolError('machines_unavailable', 'multi-machine runtime is not configured on this host', 503);
    }
    const rawMachineId = args.machine_id == null ? '' : String(args.machine_id).trim();
    if (!rawMachineId) {
      const res = await cm.listMachines();
      if (!res || res.status >= 400) {
        throw new RouterToolError(res?.data?.code || 'machines_list_failed', res?.data?.error || 'failed to list machines', res?.status || 500);
      }
      return {
        ok: true,
        self: res.data?.self || null,
        machines: Array.isArray(res.data?.machines) ? res.data.machines : [],
      };
    }
    const machineId = cleanId(rawMachineId, 'machine_id');
    const res = await cm.requestJson(machineId, 'GET', '/api/cross-machine/targets', null);
    if (!res || res.status >= 400) {
      throw new RouterToolError(
        res?.data?.code || 'remote_targets_failed',
        res?.data?.error || `failed to list targets on machine ${machineId}`,
        res?.status || 502,
      );
    }
    return {
      ok: true,
      machine_id: res.peer?.id || machineId,
      machine_name: res.peer?.name || machineId,
      directories: Array.isArray(res.data?.directories) ? res.data.directories : [],
      sessions: Array.isArray(res.data?.sessions) ? res.data.sessions : [],
    };
  }

  async function admitRemote(context, tool, args, resultMode) {
    const cm = getCrossMachine();
    if (!cm) {
      throw new RouterToolError('machines_unavailable', 'multi-machine dispatch is not configured on this host', 503);
    }
    const machineId = cleanId(args.machine_id, 'machine_id');
    const message = cleanText(args.message, 'message', MAX_MESSAGE_LENGTH);
    const hasTarget = args.target_session_id !== undefined;
    const hasNewTask = args.new_task !== undefined;
    if (hasTarget === hasNewTask) {
      throw new RouterToolError('invalid_arguments', 'pass either target_session_id or new_task (not both)');
    }
    let targetSessionId = null;
    let newTask = null;
    let targetKey = '';
    if (hasTarget) {
      targetSessionId = cleanId(args.target_session_id, 'target_session_id');
      targetKey = `${machineId}:${targetSessionId}`;
    } else {
      if (!args.new_task || typeof args.new_task !== 'object' || Array.isArray(args.new_task)) {
        throw new RouterToolError('invalid_arguments', 'new_task must be an object');
      }
      rejectUnknownArguments(args.new_task, new Set(['title', 'dir_id', 'cli', 'model', 'provider', 'effort']));
      const title = cleanText(args.new_task.title, 'new_task.title', 120);
      const dirId = args.new_task.dir_id != null ? cleanId(args.new_task.dir_id, 'new_task.dir_id') : undefined;
      newTask = {
        title,
        ...(dirId ? { dirId } : {}),
        ...(args.new_task.cli ? { cli: cleanText(args.new_task.cli, 'new_task.cli', 256) } : {}),
        ...(args.new_task.model ? { model: cleanText(args.new_task.model, 'new_task.model', 256) } : {}),
        ...(args.new_task.provider ? { provider: cleanText(args.new_task.provider, 'new_task.provider', 256) } : {}),
        ...(args.new_task.effort ? { effort: cleanText(args.new_task.effort, 'new_task.effort', 256) } : {}),
      };
      targetKey = `${machineId}:new_task:${dirId || ''}:${title}`;
    }
    const identity = admissionIdentity(context, tool, targetKey, message, args.idempotency_key);
    const operationId = `op_${stableSuffix([
      'dispatch-remote', tool, context.sessionId, machineId, targetKey, identity.idempotencyKey,
    ], cryptoImpl)}`;
    const caller = records.get(context.sessionId);
    const masterLabel = (caller && (caller.label || caller.name)) || context.sessionId || 'master';
    const remoteRes = await cm.requestJson(machineId, 'POST', '/api/cross-machine/dispatches', {
      operationId,
      idempotencyKey: identity.idempotencyKey,
      mode: resultMode,
      ...(targetSessionId ? { targetSessionId } : {}),
      ...(newTask ? { newTask } : {}),
      allowTerminal: args.allow_terminal === true,
      message,
      masterSessionId: context.sessionId,
      masterLabel,
    });
    if (!remoteRes || remoteRes.status >= 400 || remoteRes.data?.ok !== true) {
      throw new RouterToolError(
        remoteRes?.data?.code || 'remote_dispatch_failed',
        remoteRes?.data?.error || `remote dispatch to ${machineId} failed`,
        remoteRes?.status || 502,
      );
    }
    const remoteData = remoteRes.data;
    const remoteMachineName = remoteRes.peer?.name || machineId;
    const remoteTargetId = remoteData.targetSessionId || targetSessionId || remoteData.executionSessionId;
    const remoteExecId = remoteData.executionSessionId || remoteTargetId;
    const localAdmitted = await operations.admitDispatch({
      ownerSessionId: context.sessionId,
      resultSessionId: context.sessionId,
      idempotencyKey: identity.idempotencyKey,
      operationId,
      spec: {
        targetId: remoteTargetId,
        targetLabel: remoteData.targetLabel || '',
        chatId: remoteExecId,
        message,
        replyTo: resultMode === 'sync' || resultMode === 'async' ? context.sessionId : null,
        gateway: false,
        oneWay: resultMode === 'none',
        resultMode,
        taskId: remoteData.taskId || null,
        remoteMachineId: machineId,
        remoteMachineName,
        remoteOperationId: remoteData.operationId || operationId,
      },
    });
    if (resultMode === 'async' || resultMode === 'sync') {
      ensureRemoteWatch(machineId, localAdmitted.id);
    }
    return {
      ok: true,
      operationId: localAdmitted.id,
      remoteOperationId: remoteData.operationId || localAdmitted.id,
      remoteMachineId: machineId,
      remoteMachineName,
      status: remoteData.status || localAdmitted.status || 'admitted',
      targetSessionId: remoteTargetId,
      chatId: remoteExecId,
      taskId: remoteData.taskId || null,
      duplicate: localAdmitted.idempotent === true || remoteData.duplicate === true,
      queue: remoteData.queue || null,
      idempotencyKey: identity.idempotencyKey,
    };
  }

  async function resolveSelfMachineId() {
    const cm = getCrossMachine();
    if (!cm) return '';
    try {
      const res = await cm.listMachines();
      return res?.data?.self?.id || '';
    } catch (_) { return ''; }
  }

  async function shouldDispatchRemote(args) {
    if (args.machine_id == null) return false;
    const mid = String(args.machine_id).trim();
    if (!mid) return false;
    const selfId = await resolveSelfMachineId();
    return !selfId || mid !== selfId;
  }

  async function routeTask(context, args) {
    rejectUnknownArguments(args, new Set(['machine_id', 'target_session_id', 'new_task', 'message', 'idempotency_key', 'allow_terminal']));
    const isRemote = await shouldDispatchRemote(args);
    const admitted = isRemote
      ? await admitRemote(context, 'route_task', args, 'none')
      : await admit(context, 'route_task', args, 'none');
    return {
      ok: true,
      status: admitted.status,
      operation_id: admitted.operationId,
      ...(admitted.remoteMachineId ? {
        machine_id: admitted.remoteMachineId,
        machine_name: admitted.remoteMachineName,
        remote_operation_id: admitted.remoteOperationId,
      } : {}),
      target_session_id: admitted.targetSessionId,
      execution_session_id: admitted.chatId || admitted.targetSessionId,
      task_id: admitted.taskId,
      duplicate: admitted.duplicate,
      ...queueFields(admitted),
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

  async function dispatchOperationSummary(operation) {
    const remoteMachineId = operation.spec?.remoteMachineId || '';
    const chatId = operation.spec?.chatId || operation.spec?.targetId || null;
    const entryId = operation.requestOutboxId || `operation:${operation.id}:request`;
    let currentOp = operation;
    let queueState = TERMINAL_OPERATION_STATES.has(currentOp.status)
      ? 'terminal' : 'unknown';
    let queuePosition = null;
    if (remoteMachineId && queueState !== 'terminal') {
      const cm = getCrossMachine();
      if (cm) {
        try {
          const res = await cm.requestJson(
            remoteMachineId,
            'GET',
            `/api/cross-machine/dispatches/${encodeURIComponent(currentOp.id)}`,
            null,
          );
          const remote = res?.status === 200 ? res?.data?.dispatch : null;
          if (remote) {
            queueState = remote.queueState || queueState;
            if (Number.isFinite(remote.queuePosition)) queuePosition = remote.queuePosition;
            if (remote.terminal) {
              await settleRemoteReceipt(remoteMachineId, remote);
              currentOp = (await operations.get(currentOp.id)) || currentOp;
              queueState = 'terminal';
            }
          }
        } catch (_) { /* durable local record remains authoritative when peer is unreachable */ }
      }
    } else if (queueState !== 'terminal' && chatId) {
      try {
        const schedule = await schedulerStatus(chatId);
        const queued = (schedule?.queued || []).find(item => item.entryId === entryId);
        if (queued) {
          queueState = 'queued';
          queuePosition = Number.isFinite(queued.position) ? queued.position : null;
        } else if (schedule?.active
            && (schedule.active.entryId === entryId
              || schedule.active.deliveryId === entryId)) {
          queueState = 'started';
        } else if (currentOp.status === 'running') {
          queueState = 'running';
        }
      } catch (_) { /* the durable operation remains authoritative */ }
    }
    const result = currentOp.result && typeof currentOp.result === 'object'
      ? currentOp.result : {};
    const resultText = String(result.text || result.error || currentOp.lastError || '').trim();
    return {
      operation_id: currentOp.id,
      status: currentOp.status,
      terminal: TERMINAL_OPERATION_STATES.has(currentOp.status),
      ...(remoteMachineId ? {
        machine_id: remoteMachineId,
        machine_name: currentOp.spec?.remoteMachineName || remoteMachineId,
        remote_operation_id: currentOp.spec?.remoteOperationId || currentOp.id,
      } : {}),
      target_session_id: currentOp.spec?.targetId || null,
      execution_session_id: chatId,
      task_id: currentOp.spec?.taskId || null,
      mode: currentOp.spec?.resultMode || (currentOp.spec?.oneWay ? 'one_way' : null),
      queue_state: queueState,
      ...(queuePosition == null ? {} : { queue_position: queuePosition }),
      created_at: currentOp.createdAt || null,
      started_at: currentOp.startedAt || null,
      completed_at: currentOp.completedAt || null,
      updated_at: currentOp.updatedAt || null,
      ...(resultText ? { result: resultText } : {}),
    };
  }

  async function dispatchStatus(context, args) {
    rejectUnknownArguments(args, new Set([
      'operation_id', 'target_session_id', 'active_only', 'limit',
    ]));
    const rawOperationId = args.operation_id == null
      ? '' : String(args.operation_id).trim();
    const targetId = args.target_session_id == null
      ? '' : cleanId(args.target_session_id, 'target_session_id');
    const activeOnly = args.active_only !== false;
    const limit = args.limit == null ? 20 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RouterToolError('invalid_arguments', 'limit must be an integer from 1 through 100');
    }

    if (rawOperationId) {
      const operationId = cleanId(rawOperationId, 'operation_id');
      const operation = await operations.get(operationId);
      if (!operation || operation.kind !== 'dispatch'
          || operation.ownerSessionId !== context.sessionId) {
        throw new RouterToolError(
          'dispatch_not_found',
          `dispatch ${operationId} was not found for this session`,
          404,
        );
      }
      return {
        ok: true,
        dispatch: await dispatchOperationSummary(operation),
        instruction: TERMINAL_OPERATION_STATES.has(operation.status)
          ? 'This dispatch is terminal. Re-routing is safe only if the user still wants another execution.'
          : 'This dispatch is still live. Do not re-dispatch the same task; wait, or call dispatch_cancel with this operation_id before re-routing.',
      };
    }

    const statuses = activeOnly
      ? ['admitted', 'queued', 'running', 'pending'] : undefined;
    const useReferences = typeof operations.listReferences === 'function';
    const query = {
      kind: 'dispatch', ownerSessionId: context.sessionId, statuses,
    };
    let owned = await (useReferences
      ? operations.listReferences(query) : operations.list(query));
    if (targetId) owned = owned.filter(operation => operation.spec?.targetId === targetId);
    owned = owned.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .slice(0, limit);
    const dispatches = [];
    for (const reference of owned) {
      // Materialize only the bounded response, not every historical result.
      const operation = useReferences ? await operations.get(reference.id) : reference;
      if (!operation || operation.kind !== 'dispatch'
          || operation.ownerSessionId !== context.sessionId) continue;
      dispatches.push(await dispatchOperationSummary(operation));
    }
    return {
      ok: true,
      active_only: activeOnly,
      target_session_id: targetId || null,
      dispatches,
      count: dispatches.length,
      instruction: dispatches.some(item => !item.terminal)
        ? 'One or more dispatches are still live. Do not infer completion from session active/streaming flags or repository state. Wait, or cancel the original operation before re-routing.'
        : 'No matching live dispatch owned by this session was found.',
    };
  }

  async function dispatchMaster(context, args, options = {}) {
    rejectUnknownArguments(args, new Set([
      'machine_id', 'target_session_id', 'new_task', 'message', 'idempotency_key', 'allow_terminal',
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
    if (mode === 'sync') boundedTimeout(args.timeout_seconds);
    const isRemote = await shouldDispatchRemote(args);
    let admitted;
    try {
      admitted = isRemote
        ? await admitRemote(context, 'dispatch_master', args, mode)
        : await admit(context, 'dispatch_master', args, mode);
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
    const remoteFields = admitted.remoteMachineId ? {
      machine_id: admitted.remoteMachineId,
      machine_name: admitted.remoteMachineName,
      remote_operation_id: admitted.remoteOperationId,
    } : {};
    if (mode === 'async') {
      return {
        ok: true,
        mode,
        admitted: true,
        status: admitted.status,
        operation_id: admitted.operationId,
        ...remoteFields,
        target_session_id: admitted.targetSessionId,
        execution_session_id: admitted.chatId || admitted.targetSessionId,
        task_id: admitted.taskId,
        duplicate: admitted.duplicate,
        ...queueFields(admitted),
        instruction: 'Do not poll, inspect, or wait on the worker. Continue only independent work, then end this turn naturally. MultiCC will inject the dispatch result as a new message and wake this session automatically.',
      };
    }

    const timeoutMs = boundedTimeout(args.timeout_seconds);
    let unsubscribe = () => {};
    try {
      const progressCb = typeof options.onProgress === 'function' ? options.onProgress : () => {};
      if (admitted.remoteMachineId) {
        let set = remoteProgressListeners.get(admitted.operationId);
        if (!set) { set = new Set(); remoteProgressListeners.set(admitted.operationId, set); }
        set.add(progressCb);
        unsubscribe = () => {
          set.delete(progressCb);
          if (set.size === 0) remoteProgressListeners.delete(admitted.operationId);
        };
      } else {
        unsubscribe = subscribeDispatchProgress({
          operationId: admitted.operationId,
          targetSessionId: admitted.targetSessionId,
          onProgress: progressCb,
        }) || (() => {});
      }
      const operation = await waitForOperation(admitted.operationId, timeoutMs, options.signal);
      if (!operation) {
        return {
          ok: false,
          mode,
          status: 'pending',
          timed_out: true,
          operation_id: admitted.operationId,
          ...remoteFields,
          target_session_id: admitted.targetSessionId,
          execution_session_id: admitted.chatId || admitted.targetSessionId,
          task_id: admitted.taskId,
          duplicate: admitted.duplicate,
          ...queueFields(admitted),
          instruction: 'The worker is still running. Retry dispatch_master with the same idempotency_key and mode="sync" to reattach without creating a duplicate operation.',
        };
      }
      return {
        ...dispatchResult(operation, admitted),
        ...remoteFields,
      };
    } finally {
      try { unsubscribe(); } catch (_) {}
    }
  }

  // Cancel a task this session previously queued via route_task /
  // dispatch_master — the missing half of re-routing. Without it, "send it to
  // someone else" always meant "send a SECOND copy". Three dispositions:
  //   queued      — still in the target's FIFO; removed silently, the worker
  //                 never sees it. This is the clean re-route.
  //   running     — already claimed and executing; needs cancel_running=true
  //                 and interrupts the target's turn (it ends as a cancel).
  //   untrackable — no queued or running trace remains (claim/finish race);
  //                 nothing will execute, so only the operation record settles.
  async function dispatchCancel(context, args) {
    rejectUnknownArguments(args, new Set(['operation_id', 'reason', 'cancel_running']));
    if (typeof cancelQueuedEntry !== 'function' || typeof operations.cancelDispatch !== 'function') {
      throw new RouterToolError('cancel_unavailable', 'dispatch cancellation is not available on this host', 503);
    }
    const operationId = cleanId(args.operation_id, 'operation_id');
    const reason = cleanOptionalText(args.reason, 'reason', 500) || 'cancelled by dispatcher';
    const operation = await operations.get(operationId);
    if (!operation) {
      throw new RouterToolError('operation_not_found', 'dispatch operation not found', 404);
    }
    if (operation.kind !== 'dispatch') {
      throw new RouterToolError('not_a_dispatch', 'operation is not a dispatch', 409);
    }
    // Ownership is the whole authorization model here: a session settles only
    // its own dispatches. Targets and bystanders cannot reach this record.
    if (operation.ownerSessionId !== context.sessionId) {
      throw new RouterToolError('forbidden', 'only the dispatching session can cancel its own dispatch', 403);
    }
    if (TERMINAL_OPERATION_STATES.has(operation.status)) {
      return {
        ok: true,
        operation_id: operationId,
        status: operation.status,
        already_terminal: true,
        note: 'the operation already reached a terminal state; nothing was cancelled',
      };
    }
    const remoteMachineId = operation.spec?.remoteMachineId || '';
    if (remoteMachineId) {
      const cm = getCrossMachine();
      if (!cm) {
        throw new RouterToolError('cancel_unavailable', 'cross-machine cancel is not configured', 503);
      }
      const remoteRes = await cm.requestJson(
        remoteMachineId,
        'POST',
        `/api/cross-machine/dispatches/${encodeURIComponent(operationId)}/cancel`,
        { reason, cancelRunning: args.cancel_running === true },
      );
      if (!remoteRes || remoteRes.status >= 400 || remoteRes.data?.ok !== true) {
        throw new RouterToolError(
          remoteRes?.data?.code || 'remote_cancel_failed',
          remoteRes?.data?.error || `failed to cancel remote dispatch ${operationId}`,
          remoteRes?.status || 502,
        );
      }
      releaseRemoteWatchOp(remoteMachineId, operationId);
      if (remoteRes.data.alreadyTerminal) {
        return {
          ok: true,
          operation_id: operationId,
          machine_id: remoteMachineId,
          status: remoteRes.data.status || operation.status,
          already_terminal: true,
          note: 'the remote task already reached a terminal state',
        };
      }
      const settled = await operations.cancelDispatch(operationId, {
        reason,
        disposition: remoteRes.data.disposition || 'remote',
      });
      return {
        ok: true,
        operation_id: operationId,
        machine_id: remoteMachineId,
        status: settled?.raced ? settled.status : 'cancelled',
        disposition: remoteRes.data.disposition || 'remote',
        note: 'cancelled on remote machine',
      };
    }
    const chatId = operation.spec?.chatId || operation.spec?.targetId;
    const entryId = operation.requestOutboxId || `operation:${operationId}:request`;
    const settle = async (disposition, note) => {
      const settled = await operations.cancelDispatch(operationId, { reason, disposition });
      if (settled && settled.raced) {
        return {
          ok: true,
          operation_id: operationId,
          status: settled.status,
          already_terminal: true,
          note: 'the task reached a terminal state while the cancel was in flight',
        };
      }
      try { onDispatchCancelled(operationId); } catch (_) {}
      return { ok: true, operation_id: operationId, status: 'cancelled', disposition, note };
    };

    const removed = await cancelQueuedEntry(chatId, entryId, { actor: context.sessionId, reason });
    if (removed.ok) {
      return settle('queued', 'removed from the target FIFO before delivery; the worker never sees it');
    }

    const schedule = await schedulerStatus(chatId);
    const active = schedule?.active || null;
    const isRunningThis = active !== null
      && (active.entryId === entryId || active.deliveryId === entryId);
    if (isRunningThis) {
      if (args.cancel_running !== true) {
        throw new RouterToolError(
          'already_running',
          'the task already left the FIFO and is running on the target; pass cancel_running=true to interrupt that turn',
          409,
        );
      }
      if (typeof cancelActiveTurnFn !== 'function') {
        throw new RouterToolError('cancel_unavailable', 'running-turn cancellation is not available on this host', 503);
      }
      await cancelActiveTurnFn(chatId, { source: 'dispatch_cancel', reason });
      return settle('running', 'the running turn was interrupted on the target');
    }

    return settle('untrackable', 'no queued or running trace of the task remained; only the operation record was settled');
  }

  async function dispatchSlave(context, args) {
    rejectUnknownArguments(args, new Set(['operation_id', 'result', 'status']));
    const rawOperationId = args.operation_id == null ? '' : String(args.operation_id).trim();
    const operationId = rawOperationId ? cleanId(rawOperationId, 'operation_id') : '';
    if (!operationId) {
      throw new RouterToolError(
        'invalid_arguments',
        'operation_id is required: it is printed in the dispatched task text ([Receipt required] dispatch_slave({operation_id:...})) and is returned to the dispatcher as operation_id',
        400,
      );
    }
    // Id-addressed, not turn-addressed: the worker may receipt from any turn
    // (the original dispatched turn, or a later continuation after an
    // interruption split). Ownership is still enforced - only the session the
    // dispatch was sent to may receipt for it.
    const operation = await operations.get(operationId);
    if (!operation || operation.kind !== 'dispatch') {
      throw new RouterToolError('operation_not_found', 'dispatch operation not found', 404);
    }
    if (operation.spec.chatId !== context.sessionId) {
      throw new RouterToolError(
        'dispatch_not_addressed_to_caller',
        'this dispatch was sent to another session',
        403,
      );
    }
    if (operation.spec.resultMode !== 'async' && operation.spec.resultMode !== 'tool') {
      throw new RouterToolError(
        'invalid_result_mode',
        'dispatch_slave is only accepted for an async dispatch',
        409,
      );
    }
    const status = args.status == null ? 'completed' : String(args.status);
    if (status !== 'completed' && status !== 'failed') {
      throw new RouterToolError('invalid_arguments', 'status must be completed or failed');
    }
    const text = cleanText(args.result, 'result', MAX_RESULT_LENGTH);
    if (TERMINAL_OPERATION_STATES.has(operation.status)) {
      const priorSource = operation.result && typeof operation.result === 'object'
        ? operation.result.source
        : null;
      if (priorSource !== 'missing_dispatch_slave') {
        // Genuinely settled (a previous receipt, or a cancellation). The
        // worker's copy is stale - tell it the truth instead of re-settling.
        return {
          ok: operation.status === 'completed',
          accepted: true,
          duplicate: true,
          status: operation.status,
          operation_id: operation.id,
        };
      }
      // Late correction: the dispatched turn ended before the worker
      // receipted, so the host auto-settled it as missing. The worker has now
      // shown up with the id from the task text - resettle with the real
      // result so the caller receives the corrected receipt.
      const corrected = await completeDispatch(operation.id, {
        status,
        sessionName: context.sessionId,
        text,
        ...(status === 'failed' ? { error: text } : {}),
        source: 'dispatch_slave',
      }, { resettle: true });
      if (!corrected || corrected.ok !== true) {
        throw new RouterToolError(
          corrected?.code || 'completion_rejected',
          'dispatch result could not be persisted',
          409,
        );
      }
      return {
        ok: status === 'completed',
        accepted: true,
        corrected: true,
        status,
        operation_id: operation.id,
      };
    }
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
    const { signal, error } = JSON.parse(getNative().sessionQuestionRequest('toolSignal', JSON.stringify({
      sessionId: context.sessionId, turnId: context.turnId, args,
    })));
    if (error) throw new RouterToolError(error.code, error.message, error.status);
    const requestId = signal.requestId;
    const recorded = await recordUserInput(signal);
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

  // ── Sensitive-value vault tools ──
  // The vault's cardinal rule: a secret VALUE never enters this runtime, never
  // becomes a tool result, and therefore never reaches an LLM transcript. The
  // client saves the typed value straight to POST /api/secrets; the only thing
  // that comes back to the model is a name-only confirmation message.
  async function requestSecretInput(context, args) {
    rejectUnknownArguments(args, new Set(['name', 'question', 'reason']));
    const name = String(args.name == null ? '' : args.name).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      throw new RouterToolError(
        'invalid_arguments',
        'name must be a valid env var identifier ([A-Za-z_][A-Za-z0-9_]*) and 1-64 characters',
      );
    }
    const question = cleanText(args.question, 'question', MAX_QUESTION_LENGTH);
    const reason = cleanOptionalText(args.reason, 'reason', MAX_REASON_LENGTH);
    const requestId = `usrq-${stableSuffix([
      context.sessionId, context.turnId, 'secret', name, question, reason,
    ], cryptoImpl)}`;
    const recorded = await recordUserInput({
      requestId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      question,
      reason,
      options: [],
      allowMultiple: false,
      inputType: 'secret',
      secretName: name,
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
      status: 'waiting_secret_input_recorded',
      request_id: requestId,
      secret_name: name,
      duplicate: recorded.duplicate === true,
      instruction: 'A secure local input dialog is now shown to the user. Tell the user the dialog is open and stop this turn without running more tools. The value they type is saved directly into the local MultiCC vault and is NEVER returned to you, logged, or sent through any LLM API; the next user message only confirms the entry name is stored.',
    };
  }

  function listSecretsForContext() {
    const list = typeof listSecrets === 'function' ? listSecrets() : [];
    if (!Array.isArray(list)) return { ok: true, secrets: [] };
    return {
      ok: true,
      // Metadata only — names and descriptions, never values.
      secrets: list.map(entry => ({
        name: String(entry.name || ''),
        description: String(entry.description || ''),
        updatedAt: entry.updatedAt || null,
      })).filter(entry => entry.name),
    };
  }

  async function runSecretTool(method, context, args, options) {
    if (!secretTools || typeof secretTools[method] !== 'function') {
      throw new RouterToolError('secret_tools_unavailable', 'secret tools are not configured on this host', 501);
    }
    try {
      return await secretTools[method](context, args, options);
    } catch (error) {
      if (error && error.secretToolError) {
        throw new RouterToolError(error.code, error.message, error.statusCode || 400);
      }
      throw error;
    }
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
        ...(context.taskId ? { taskId: context.taskId } : {}),
        ...(context.originDispatchId ? { originDispatchId: context.originDispatchId } : {}),
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

  async function generateImage(context, args, options) {
    rejectUnknownArguments(args, new Set(['prompt', 'reference_image_paths']));
    const prompt = cleanText(args.prompt, 'prompt', 16 * 1024);
    const referenceImagePaths = args.reference_image_paths == null ? [] : args.reference_image_paths;
    if (!Array.isArray(referenceImagePaths) || referenceImagePaths.length > 4
        || referenceImagePaths.some(value => typeof value !== 'string' || value.length > 1024)) {
      throw new RouterToolError('invalid_arguments', 'reference_image_paths is invalid');
    }
    const session = records.get(context.sessionId);
    if (!imageBridge?.isEligible?.(session)) {
      throw new RouterToolError('image_generation_unavailable', 'image generation is unavailable for this session', 409);
    }
    try {
      return await imageBridge.generate({
        context, session, prompt, referenceImagePaths, signal: options.signal,
      });
    } catch (error) {
      const code = typeof error?.code === 'string' && /^image_generation_|^tool_call_cancelled$/.test(error.code)
        ? error.code : 'image_generation_failed';
      const message = code === 'tool_call_cancelled'
        ? 'image generation was cancelled'
        : (code === 'image_generation_busy'
          ? 'image generation is busy; retry shortly'
          : (code === 'invalid_arguments' ? error.message : 'image generation could not be completed'));
      throw new RouterToolError(code, message, code === 'tool_call_cancelled' ? 499 : 409);
    }
  }

  async function executeImpl(token, tool, args = {}, options = {}) {
    if (!TOOL_NAMES.has(tool)) {
      throw new RouterToolError('unknown_tool', 'unknown router tool', 404);
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new RouterToolError('invalid_arguments', 'tool arguments must be an object');
    }
    const context = contextFor(token);
    if (tool === 'get_task_context') {
      rejectUnknownArguments(args, new Set(['task_id', 'before', 'message_id', 'offset', 'limit']));
      for (const key of ['task_id', 'before', 'message_id']) {
        if (args[key] !== undefined && (typeof args[key] !== 'string' || !/^[\w.:-]{1,400}$/.test(args[key]))) {
          throw new RouterToolError('invalid_arguments', `invalid ${key}`);
        }
      }
      if ((args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50))
          || (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0 || !args.message_id))) {
        throw new RouterToolError('invalid_arguments', 'invalid pagination');
      }
      const result = await getTaskContext(context, args);
      if (!result) throw new RouterToolError('task_context_unavailable', 'task context is unavailable', 404);
      return result;
    }
    if (tool === 'detached_result') {
      rejectUnknownArguments(args, new Set(['operation_id', 'acknowledge_version']));
      if (typeof args.operation_id !== 'string') throw new RouterToolError('invalid_arguments', 'operation_id must be a string');
      const operationId = cleanId(args.operation_id, 'operation_id');
      const version = args.acknowledge_version;
      if (version !== undefined && (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version))) {
        throw new RouterToolError('invalid_arguments', 'acknowledge_version must be the returned result_version');
      }
      const result = await detachedResult(context.sessionId, operationId, version);
      if (!result.ok) {
        throw new RouterToolError(result.code, result.code, result.code === 'detached_operation_not_found' ? 404 : 409);
      }
      return result;
    }
    if (tool === 'generate_image') return generateImage(context, args, options);
    if (tool === 'wait_for_user_answer' || tool === 'request_user_input') {
      return requestUserInput(context, args);
    }
    if (tool === 'request_secret_input') return requestSecretInput(context, args);
    if (tool === 'list_secrets') {
      rejectUnknownArguments(args, new Set());
      return listSecretsForContext(context);
    }
    if (tool === 'run_with_secrets') return runSecretTool('runWithSecrets', context, args, options);
    if (tool === 'http_request_with_secret') {
      return runSecretTool('httpRequestWithSecret', context, args, options);
    }
    if (tool === 'wait_for_external_result') {
      return waitForExternalResult(context, args);
    }
    if (tool === 'get_external_wait') return getExternalWaitStatus(context, args);
    if (tool === 'cancel_external_wait') {
      return cancelExternalWaitForContext(context, args);
    }
    if (tool === 'list_machines') return listMachines(context, args);
    if (tool === 'route_task') return routeTask(context, args);
    if (tool === 'dispatch_master') return dispatchMaster(context, args, options);
    if (tool === 'dispatch_status') return dispatchStatus(context, args);
    if (tool === 'dispatch_cancel') return dispatchCancel(context, args);
    return dispatchSlave(context, args);
  }

  async function execute(token, tool, args = {}, options = {}) {
    if (!['list_secrets', 'request_secret_input', 'run_with_secrets', 'http_request_with_secret'].includes(tool)) {
      return executeImpl(token, tool, args, options);
    }
    const context = contextFor(token);
    // Names only. Reuse the HTTP host adapter's placeholder collector;
    // no URL, command, question, body or header is journaled.
    const names = tool === 'run_with_secrets' ? args?.secrets
      : tool === 'http_request_with_secret' ? secretTools?.namesForHttp?.(args) || [] : [args?.name];
    return secretAudit.call(tool, { ...context, source: 'mcp' }, names,
      () => executeImpl(token, tool, args, options));
  }

  return Object.freeze({
    issueContext,
    capabilityExpiresAt: token => capabilities.get(token)?.expiresAt,
    revoke,
    clear,
    execute,
    contextFor,
    recoverRemoteDispatch,
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
