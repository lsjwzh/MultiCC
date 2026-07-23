'use strict';

const REQUEST_KIND = 'chat-turn-request.v1';
const MAX_ID_LENGTH = 128;
const FORBIDDEN_FIELDS = new Set([
  'cliSessionId', 'nativeSessionId', 'sessionSecret', 'secret',
  'token', 'apiKey', 'accessToken', 'providerToken',
]);
const RETRY_REASONS = new Set([
  'empty-exit', 'session-id-conflict', 'resume-target-missing',
  'transport-disconnect', 'api-error', 'interrupted', 'manual',
]);
const TASK_SOURCES = new Set(['task-board', 'commander', 'router-tool']);

class TurnRequestError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'TurnRequestError';
    this.code = code;
  }
}

function cleanId(value, field, required = false) {
  const text = value == null ? '' : String(value).trim().slice(0, MAX_ID_LENGTH);
  if (required && !text) throw new TurnRequestError('invalid_request', `${field} is required`);
  return text || null;
}

function normalizeStringList(value, field) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TurnRequestError('invalid_request', `${field} must be an array`);
  return Object.freeze([...new Set(value.map(item => cleanId(item, field)).filter(Boolean))]);
}

function normalizeRetry(value) {
  if (value == null || value === false) return null;
  const source = value === true ? {} : value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TurnRequestError('invalid_retry', 'retry must be boolean or an object');
  }
  const attempt = source.attempt == null ? 1 : Number(source.attempt);
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TurnRequestError('invalid_retry', 'retry.attempt must be a positive integer');
  }
  const reason = source.reason == null ? 'manual' : String(source.reason).trim();
  if (!RETRY_REASONS.has(reason)) {
    throw new TurnRequestError('invalid_retry', `unsupported retry reason: ${reason}`);
  }
  const strategy = source.strategy == null ? 'resume' : String(source.strategy).trim();
  if (strategy !== 'resume' && strategy !== 'fresh') {
    throw new TurnRequestError('invalid_retry', 'retry.strategy must be resume or fresh');
  }
  return Object.freeze({ attempt, reason, strategy });
}

function normalizeGoalLimits(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TurnRequestError('invalid_request', 'goalLimits must be an object');
  }
  const maxRounds = value.maxRounds == null ? null : Number(value.maxRounds);
  if (maxRounds != null && (!Number.isInteger(maxRounds) || maxRounds < 0)) {
    throw new TurnRequestError('invalid_request', 'goalLimits.maxRounds must be a non-negative integer');
  }
  const maxBudget = value.maxBudget == null ? null : String(value.maxBudget).trim().slice(0, 64) || null;
  return Object.freeze({ maxRounds, maxBudget });
}

function normalizeTaskContext(input) {
  const taskId = cleanId(input.taskId, 'taskId');
  const start = input.taskStart === true;
  const source = cleanId(input.taskSource, 'taskSource');
  if (start && !taskId) {
    throw new TurnRequestError('invalid_task', 'taskStart requires taskId');
  }
  if (start && !TASK_SOURCES.has(source)) {
    throw new TurnRequestError('invalid_task', 'taskStart requires a trusted task source');
  }
  if (source && !TASK_SOURCES.has(source)) {
    throw new TurnRequestError('invalid_task', `unsupported task source: ${source}`);
  }
  const rawText = input.taskText == null ? '' : String(input.taskText).trim();
  if (rawText && !start) {
    throw new TurnRequestError('invalid_task', 'taskText is only valid on a task start');
  }
  return Object.freeze({
    id: taskId,
    start,
    source: source || null,
    text: start ? rawText : '',
  });
}

function normalizeTurnRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TurnRequestError('invalid_request', 'turn request must be an object');
  }
  for (const field of FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      throw new TurnRequestError('secret_field_forbidden', `${field} must not enter the turn core`);
    }
  }

  const sessionId = cleanId(input.sessionId, 'sessionId', true);
  const text = String(input.text == null ? '' : input.text).trim();
  if (!text) throw new TurnRequestError('empty_text', 'turn text is required');
  const cli = cleanId(input.cli || 'claude', 'cli', true).toLowerCase();
  const transport = cli === 'claude' ? 'claude-stream' : 'cli-process';
  const turnCount = input.turnCount == null ? 0 : Number(input.turnCount);
  if (!Number.isInteger(turnCount) || turnCount < 0) {
    throw new TurnRequestError('invalid_request', 'turnCount must be a non-negative integer');
  }
  const hasNativeSession = input.hasNativeSession === true;

  if (input.forceFirstTurn != null && typeof input.forceFirstTurn !== 'boolean') {
    throw new TurnRequestError('invalid_history_intent', 'forceFirstTurn must be boolean');
  }
  if (input.resume != null && typeof input.resume !== 'boolean') {
    throw new TurnRequestError('invalid_history_intent', 'resume must be boolean');
  }
  if (typeof input.forceFirstTurn === 'boolean' && typeof input.resume === 'boolean'
      && input.resume !== !input.forceFirstTurn) {
    throw new TurnRequestError('invalid_history_intent', 'forceFirstTurn and resume contradict each other');
  }

  let isFirstTurn;
  if (typeof input.forceFirstTurn === 'boolean') isFirstTurn = input.forceFirstTurn;
  else if (typeof input.resume === 'boolean') isFirstTurn = !input.resume;
  else isFirstTurn = turnCount === 0 || !hasNativeSession;
  const resume = !isFirstTurn;
  if (resume && !hasNativeSession) {
    throw new TurnRequestError('resume_without_native_session', 'resume requires proof that a native session exists');
  }

  const retry = normalizeRetry(input.retry);
  if (retry && retry.strategy === 'fresh' && !isFirstTurn) {
    throw new TurnRequestError('invalid_retry', 'fresh retry must force a first turn');
  }
  if (retry && retry.strategy === 'resume' && isFirstTurn) {
    throw new TurnRequestError('invalid_retry', 'resume retry cannot be a first turn');
  }

  const originDispatchId = cleanId(input.originDispatchId, 'originDispatchId');
  const originTrigger = input.originTrigger === true;
  const originContinue = input.originContinue === true;
  // Dispatch/trigger describe durable lineage: who owns the eventual result.
  // Continue describes only why this particular runner was launched. A retry
  // or interruption-resume must be able to retain its dispatch/trigger lineage
  // while also being a continuation. Keeping them orthogonal prevents a retry
  // from silently turning into a normal user turn and consuming the wrong
  // post-turn route.
  if (originDispatchId && originTrigger) {
    throw new TurnRequestError('invalid_origin', 'dispatch and trigger origins are mutually exclusive');
  }
  const originKind = originDispatchId ? 'dispatch'
    : originTrigger ? 'trigger' : 'user';

  const deliveryId = cleanId(input.deliveryId, 'deliveryId');
  const clientMsgId = cleanId(input.clientMsgId, 'clientMsgId') || deliveryId;
  const requestId = cleanId(input.requestId, 'requestId') || clientMsgId || deliveryId;

  return Object.freeze({
    kind: REQUEST_KIND,
    sessionId,
    requestId,
    text,
    cli,
    execution: Object.freeze({
      transport,
      historyIntent: isFirstTurn ? 'first' : 'resume',
      isFirstTurn,
      resume,
      forceFirstTurn: typeof input.forceFirstTurn === 'boolean' ? input.forceFirstTurn : null,
    }),
    retry,
    origin: Object.freeze({ kind: originKind, operationId: originDispatchId }),
    launch: Object.freeze({ reason: originContinue ? 'continue' : 'request' }),
    identity: Object.freeze({ clientMsgId, deliveryId }),
    task: normalizeTaskContext(input),
    goalLimits: normalizeGoalLimits(input.goalLimits),
    background: Object.freeze({
      taskIds: normalizeStringList(input.bgTaskIds, 'bgTaskIds'),
      toolUseIds: normalizeStringList(input.bgToolUseIds, 'bgToolUseIds'),
    }),
  });
}

function assertNormalized(request) {
  if (!request || request.kind !== REQUEST_KIND) {
    throw new TurnRequestError('invalid_request', 'normalizeTurnRequest must be called first');
  }
}

// Characterises the existing ordering: duplicate proof is consulted before an
// interrupt effect can be emitted. Persistence is then requested before spawn;
// evaluateSpawnGuard below refuses spawn without durable proof.
function planTurnAdmission(request, facts = {}) {
  assertNormalized(request);
  const trace = ['duplicate-check'];
  if (facts.duplicateSeen === true) {
    return Object.freeze({
      decision: 'duplicate',
      accepted: facts.duplicatePersisted === true,
      trace: Object.freeze(trace),
      effects: Object.freeze([]),
    });
  }
  trace.push('shutdown-check', 'session-check', 'network-check');
  if (facts.shuttingDown === true) {
    return Object.freeze({ decision: 'reject', reason: 'shutdown', trace: Object.freeze(trace), effects: Object.freeze([]) });
  }
  if (facts.sessionExists === false) {
    return Object.freeze({ decision: 'reject', reason: 'session-missing', trace: Object.freeze(trace), effects: Object.freeze([]) });
  }
  if (request.launch.reason === 'continue' && facts.networkUnhealthy === true) {
    return Object.freeze({
      decision: 'hold', reason: 'network-unhealthy', trace: Object.freeze(trace),
      effects: Object.freeze([{ type: 'hold-turn', sessionId: request.sessionId, text: request.text }]),
    });
  }
  const effects = [];
  if (facts.runningTurn === true) {
    effects.push(Object.freeze({ type: 'interrupt-running-turn', sessionId: request.sessionId, reason: 'new-user-message' }));
  }
  effects.push(Object.freeze({
    type: 'persist-user-message',
    sessionId: request.sessionId,
    requestId: request.requestId,
    identity: request.identity,
    origin: request.origin,
  }));
  trace.push('interrupt-plan', 'persistence-plan');
  return Object.freeze({ decision: 'prepare', trace: Object.freeze(trace), effects: Object.freeze(effects) });
}

function createDurableMessageProof(request, evidence = {}) {
  assertNormalized(request);
  return Object.freeze({
    kind: 'durable-user-message',
    sessionId: request.sessionId,
    requestId: request.requestId,
    durable: evidence.persisted === true,
  });
}

function createProviderRouteProof(request, evidence = {}) {
  assertNormalized(request);
  return Object.freeze({
    kind: 'provider-route',
    sessionId: request.sessionId,
    cli: request.cli,
    transport: request.execution.transport,
    resolved: evidence.resolved === true,
  });
}

function evaluateSpawnGuard(request, proofs = {}) {
  assertNormalized(request);
  const missing = [];
  const message = proofs.message;
  const route = proofs.route;
  const runtime = proofs.runtime;
  if (!message || message.kind !== 'durable-user-message' || message.sessionId !== request.sessionId || message.durable !== true) {
    missing.push('durable-user-message');
  }
  if (!route || route.kind !== 'provider-route' || route.sessionId !== request.sessionId
      || route.cli !== request.cli || route.transport !== request.execution.transport || route.resolved !== true) {
    missing.push('provider-route');
  }
  if (!runtime || runtime.kind !== 'runtime-claim' || runtime.sessionId !== request.sessionId || runtime.claimed !== true) {
    missing.push('runtime-claim');
  }
  if (missing.length) {
    return Object.freeze({ ok: false, code: 'spawn_proof_missing', missing: Object.freeze(missing) });
  }
  return Object.freeze({
    ok: true,
    effect: Object.freeze({
      type: 'spawn-turn',
      sessionId: request.sessionId,
      turnId: runtime.turnId,
      cli: request.cli,
      transport: request.execution.transport,
      historyIntent: request.execution.historyIntent,
    }),
  });
}

module.exports = {
  REQUEST_KIND,
  TurnRequestError,
  normalizeTurnRequest,
  planTurnAdmission,
  createDurableMessageProof,
  createProviderRouteProof,
  evaluateSpawnGuard,
};
