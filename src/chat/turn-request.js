'use strict';

const { assertProviderBinding } = require('../provider-binding');

const REQUEST_KIND = 'chat-turn-request.v1';
const MAX_ID_LENGTH = 128;
const FORBIDDEN_FIELDS = new Set([
  'cliSessionId', 'nativeSessionId', 'sessionSecret', 'secret',
  'token', 'apiKey', 'accessToken', 'providerToken',
]);
const TASK_SOURCES = new Set(['task-board', 'commander', 'router-tool']);
const LEGACY_TASK_SOURCE_ALIASES = new Map([
  ['commander-route', 'commander'],
]);
const PROVIDER_ROUTE_EVIDENCE_KEYS = new Set([
  'resolved', 'binding', 'providerName', 'protocol', 'runtimeEpoch', 'turnId',
  'decisionId', 'routeAttemptId', 'routeGeneration', 'attemptNo', 'providerRevision',
]);

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
  const taskRunId = cleanId(input.taskRunId, 'taskRunId');
  const leaseEpoch = input.leaseEpoch == null ? null : Number(input.leaseEpoch);
  const start = input.taskStart === true;
  const rawSource = cleanId(input.taskSource, 'taskSource');
  const source = LEGACY_TASK_SOURCE_ALIASES.get(rawSource) || rawSource;
  if (start && !taskId) {
    throw new TurnRequestError('invalid_task', 'taskStart requires taskId');
  }
  if (taskRunId && !taskId) {
    throw new TurnRequestError('invalid_task', 'taskRunId requires taskId');
  }
  if (leaseEpoch != null && (!Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1)) {
    throw new TurnRequestError('invalid_task', 'leaseEpoch must be a positive integer');
  }
  if (leaseEpoch != null && !taskRunId) {
    throw new TurnRequestError('invalid_task', 'leaseEpoch requires taskRunId');
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
    ...(taskRunId ? { runId: taskRunId, leaseEpoch } : {}),
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

  // History intent is derived, never negotiated. A caller cannot ask for a
  // resume: resuming needs a live native session, and only the engine knows at
  // spawn time whether one still exists. Pinning it was how a dispatch whose
  // native session had been rotated away wedged in the FIFO forever.
  const isFirstTurn = turnCount === 0 || !hasNativeSession;

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
    }),
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

// This is the provider-runner boundary, not the public admission queue. A busy
// runner must never be interrupted by a second request: all public ingress is
// required to persist through the session scheduler first.
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
  if (facts.runningTurn === true) {
    return Object.freeze({
      decision: 'reject',
      reason: 'session-busy',
      trace: Object.freeze([...trace, 'busy-check']),
      effects: Object.freeze([]),
    });
  }
  if (facts.backgroundWorkActive === true) {
    return Object.freeze({
      decision: 'reject',
      reason: 'background-work-active',
      trace: Object.freeze([...trace, 'busy-check', 'background-check']),
      effects: Object.freeze([]),
    });
  }
  const effects = [];
  effects.push(Object.freeze({
    type: 'persist-user-message',
    sessionId: request.sessionId,
    requestId: request.requestId,
    identity: request.identity,
    origin: request.origin,
  }));
  trace.push('busy-check', 'background-check', 'persistence-plan');
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
  const unexpected = Object.keys(evidence).filter(key => !PROVIDER_ROUTE_EVIDENCE_KEYS.has(key));
  if (unexpected.length) {
    throw new TurnRequestError(
      'invalid_provider_route',
      `provider route evidence is too broad: ${unexpected.sort().join(', ')}`,
    );
  }
  let binding;
  try { binding = assertProviderBinding(evidence.binding); } catch (_) {
    throw new TurnRequestError('invalid_provider_route', 'concrete provider route binding is required');
  }
  const providerId = binding.providerId || '_default_';
  const text = (value, field) => {
    const normalized = value == null ? '' : String(value).trim();
    if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
      throw new TurnRequestError('invalid_provider_route', `${field} is invalid`);
    }
    return normalized;
  };
  const integer = (value, field) => {
    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized) || normalized < 1) {
      throw new TurnRequestError('invalid_provider_route', `${field} must be a positive integer`);
    }
    return normalized;
  };
  if (evidence.resolved !== true
      || binding.sessionId !== request.sessionId
      || binding.cli !== request.cli
      || binding.roleKind !== 'main'
      || binding.routeName !== 'main'
      || /^auto(?::|$)/i.test(providerId)) {
    throw new TurnRequestError('invalid_provider_route', 'concrete provider route identity is required');
  }
  const route = Object.freeze({
    runtimeEpoch: text(evidence.runtimeEpoch, 'runtimeEpoch'),
    decisionId: text(evidence.decisionId, 'decisionId'),
    routeAttemptId: text(evidence.routeAttemptId, 'routeAttemptId'),
    routeGeneration: integer(evidence.routeGeneration, 'routeGeneration'),
    attemptNo: integer(evidence.attemptNo, 'attemptNo'),
    providerId,
    providerName: text(evidence.providerName || providerId, 'providerName'),
    protocol: text(evidence.protocol, 'protocol'),
    model: text(binding.model, 'model'),
    providerRevision: text(evidence.providerRevision, 'providerRevision'),
  });
  return Object.freeze({
    kind: 'provider-route',
    sessionId: request.sessionId,
    cli: request.cli,
    transport: request.execution.transport,
    turnId: text(evidence.turnId, 'turnId'),
    resolved: true,
    route,
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
      || route.cli !== request.cli || route.transport !== request.execution.transport || route.resolved !== true
      || route.turnId !== (runtime && runtime.turnId)
      || !route.route || !Object.isFrozen(route.route)
      || !route.route.runtimeEpoch || !route.route.decisionId || !route.route.routeAttemptId
      || !route.route.providerId || !route.route.providerName || !route.route.protocol
      || !route.route.model || !route.route.providerRevision
      || !Number.isSafeInteger(route.route.routeGeneration) || route.route.routeGeneration < 1
      || !Number.isSafeInteger(route.route.attemptNo) || route.route.attemptNo < 1) {
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
      route: route.route,
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
