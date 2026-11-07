'use strict';

// Chat turn request: normalization, admission planning and the spawn proof
// boundary. Every rule below lives in `native/core/src/turn_request.rs`; this
// file only projects the fields the kernel needs, re-throws the structured
// error as the original `TurnRequestError`, restores the reference-carrying
// fields (`identity` / `origin` / `route.route`) and freezes the result graph.

const { assertProviderBinding } = require('../providers/binding');
const { CAPABILITIES, transportOf } = require('../cli/cli-capability');
const { getNative } = require('../native/runtime');

// No Node fallback: these kernels are Rust-only.
const native = getNative();
const CATALOG = JSON.parse(native.turnRequestCatalog());

const REQUEST_KIND = CATALOG.requestKind;
const FORBIDDEN_FIELDS = new Set(CATALOG.forbiddenFields);
const PROVIDER_ROUTE_EVIDENCE_KEYS = new Set(CATALOG.providerRouteEvidenceKeys);

// Transport is a column of the canonical CLI capability table, so the resident
// set is derived here rather than listed again inside the kernel.
const RESIDENT_CLIS = Object.freeze(
  Object.keys(CAPABILITIES).filter(cli => transportOf(cli) === 'claude-stream'),
);

class TurnRequestError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'TurnRequestError';
    this.code = code;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function call(op, payload) {
  // Direct value transport keeps `undefined`, `NaN`, the infinities and `-0`
  // that `JSON.stringify`/`JSON.parse` would fold into null or 0.
  const out = native.turnRequestRequestValue(op, payload);
  if (!out.ok) throw new TurnRequestError(out.error.code, out.error.message);
  return out.value;
}

function assertNormalized(request) {
  if (!request || request.kind !== REQUEST_KIND) {
    throw new TurnRequestError('invalid_request', 'normalizeTurnRequest must be called first');
  }
}

function normalizeTurnRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TurnRequestError('invalid_request', 'turn request must be an object');
  }
  // Own-property presence, so `{ apiKey: undefined }` is rejected too.
  for (const field of FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      throw new TurnRequestError('secret_field_forbidden', `${field} must not enter the turn core`);
    }
  }
  return deepFreeze(call('normalize', {
    input: {
      sessionId: input.sessionId,
      text: input.text,
      cli: input.cli,
      turnCount: input.turnCount,
      hasNativeSession: input.hasNativeSession,
      originDispatchId: input.originDispatchId,
      originTrigger: input.originTrigger,
      originContinue: input.originContinue,
      deliveryId: input.deliveryId,
      clientMsgId: input.clientMsgId,
      requestId: input.requestId,
      taskId: input.taskId,
      taskStart: input.taskStart,
      taskSource: input.taskSource,
      taskText: input.taskText,
      goalLimits: input.goalLimits,
      bgTaskIds: input.bgTaskIds,
      bgToolUseIds: input.bgToolUseIds,
    },
    residentClis: RESIDENT_CLIS,
  }));
}

function requestRef(request) {
  return { kind: request.kind, sessionId: request.sessionId, requestId: request.requestId };
}

// This is the provider-runner boundary, not the public admission queue. A busy
// runner must never be interrupted by a second request: all public ingress is
// required to persist through the session scheduler first.
function planTurnAdmission(request, facts = {}) {
  assertNormalized(request);
  const out = call('admission', {
    request: requestRef(request),
    facts: {
      duplicateSeen: facts.duplicateSeen,
      duplicatePersisted: facts.duplicatePersisted,
      shuttingDown: facts.shuttingDown,
      sessionExists: facts.sessionExists,
      runningTurn: facts.runningTurn,
      backgroundWorkActive: facts.backgroundWorkActive,
    },
  });
  if (out.decision === 'prepare') {
    // The effect carries the live identity/origin references, not copies.
    out.effects[0].identity = request.identity;
    out.effects[0].origin = request.origin;
  }
  return deepFreeze(out);
}

function createDurableMessageProof(request, evidence = {}) {
  assertNormalized(request);
  return deepFreeze(call('messageProof', {
    request: requestRef(request),
    evidence: { persisted: evidence.persisted },
  }));
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
  // `assertProviderBinding` is a Symbol-brand check the kernel cannot perform.
  try { binding = assertProviderBinding(evidence.binding); } catch (_) {
    throw new TurnRequestError('invalid_provider_route', 'concrete provider route binding is required');
  }
  return deepFreeze(call('routeProof', {
    request: {
      kind: request.kind,
      sessionId: request.sessionId,
      cli: request.cli,
      transport: request.execution.transport,
    },
    evidence: {
      resolved: evidence.resolved,
      providerName: evidence.providerName,
      protocol: evidence.protocol,
      runtimeEpoch: evidence.runtimeEpoch,
      turnId: evidence.turnId,
      decisionId: evidence.decisionId,
      routeAttemptId: evidence.routeAttemptId,
      routeGeneration: evidence.routeGeneration,
      attemptNo: evidence.attemptNo,
      providerRevision: evidence.providerRevision,
    },
    binding: {
      sessionId: binding.sessionId,
      cli: binding.cli,
      providerId: binding.providerId,
      model: binding.model,
      roleKind: binding.roleKind,
      routeName: binding.routeName,
    },
  }));
}

function evaluateSpawnGuard(request, proofs = {}) {
  assertNormalized(request);
  const message = proofs.message;
  const route = proofs.route;
  const runtime = proofs.runtime;
  const out = call('spawnGuard', {
    request: {
      kind: request.kind,
      sessionId: request.sessionId,
      cli: request.cli,
      transport: request.execution.transport,
      historyIntent: request.execution.historyIntent,
    },
    message: message ? {
      kind: message.kind,
      sessionId: message.sessionId,
      durable: message.durable,
    } : undefined,
    route: route ? {
      kind: route.kind,
      sessionId: route.sessionId,
      cli: route.cli,
      transport: route.transport,
      resolved: route.resolved,
      turnId: route.turnId,
      route: route.route,
    } : undefined,
    runtime: runtime ? {
      kind: runtime.kind,
      sessionId: runtime.sessionId,
      claimed: runtime.claimed,
      turnId: runtime.turnId,
    } : undefined,
    // `Object.isFrozen` cannot cross the boundary; the check runs here.
    routeFrozen: !!(route && route.route && Object.isFrozen(route.route)),
  });
  if (out.ok) out.effect.route = route.route;
  return deepFreeze(out);
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
