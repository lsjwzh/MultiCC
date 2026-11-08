'use strict';

const { getNative } = require('../native/runtime');

// The host keeps object identity; Rust owns the turn's durable/claim state.
// Non-primitive values are retained by identity for compatibility with callers
// that mutate these historically public fields.
const turnStates = new WeakMap();
const runnerStates = new WeakMap();
const legacyAppendStates = new WeakMap();

function resultAppendState(turn) {
  const state = turnStates.get(turn);
  if (state) return state;
  let legacy = legacyAppendStates.get(turn);
  if (!legacy) {
    legacy = { native: new (getNative().RustChatTurnLifecycle)() };
    legacyAppendStates.set(turn, legacy);
  }
  return legacy;
}

function reserveResultAppend(turn) { return resultAppendState(turn).native.beginResultAppend(); }
function releaseResultAppend(turn) { resultAppendState(turn).native.endResultAppend(); }
function recordConfirmedResult(turn, runner, runnerId) {
  const state = resultAppendState(turn);
  if (!state.native.recordConfirmedResult(isOpaque(runnerId) ? null : runnerId)) return false;
  state.receiptRunner = runner;
  state.receiptOpaque = isOpaque(runnerId);
  state.receiptOwner = state.receiptOpaque ? runnerId : undefined;
  return true;
}
function confirmedResult(turn) {
  const state = resultAppendState(turn);
  if (!state.native.hasConfirmedResult()) return null;
  return { runner: state.receiptRunner,
    runnerId: state.receiptOpaque ? state.receiptOwner : state.native.confirmedResultOwner() };
}

function runnerState(runner) {
  let state = runnerStates.get(runner);
  if (!state) {
    state = { native: new (getNative().RustChatRunnerLifecycle)(), setter: null, opaque: false, value: undefined };
    runnerStates.set(runner, state);
  }
  return state;
}

function reserveUsageWrite(runner) { return runnerState(runner).native.beginUsage(); }
function releaseUsageWrite(runner) { runnerState(runner).native.endUsage(); }

function isOpaque(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function'
    || typeof value === 'symbol' || typeof value === 'bigint');
}

function attachTurnState(turn) {
  const native = new (getNative().RustChatTurnLifecycle)();
  const opaque = new Map();
  let claimSetter;
  const fields = {
    resultDurable: ['resultDurable', 'setResultDurable'],
    resultRunnerId: ['resultRunnerId', 'setResultRunnerId'],
    postTurnClaimed: ['postTurnClaimed', 'setPostTurnClaimed'],
  };
  for (const [key, [get, set]] of Object.entries(fields)) {
    const setter = value => {
      // Data properties on a frozen legacy turn were not writable.
      if (Object.isFrozen(turn)) throw new TypeError(`Cannot assign to read only property '${key}'`);
      if (isOpaque(value)) {
        native[set](key === 'resultRunnerId' ? null : !!value);
        opaque.set(key, value);
      } else {
        native[set](value);
        opaque.delete(key);
      }
    };
    if (key === 'postTurnClaimed') claimSetter = setter;
    Object.defineProperty(turn, key, {
      enumerable: true, configurable: true,
      get() { return opaque.has(key) ? opaque.get(key) : native[get](); },
      set: setter,
    });
  }
  turnStates.set(turn, { native, opaque, claimSetter });
}

function clean(value) { return value == null ? '' : String(value).trim(); }

function freezeLineage(lineage) {
  const source = lineage && typeof lineage === 'object' ? lineage : {};
  const kind = source.kind === 'dispatch' || source.kind === 'trigger' ? source.kind : 'user';
  return Object.freeze({
    kind,
    operationId: kind === 'dispatch' ? clean(source.operationId) || null : null,
  });
}

function freezeTask(task) {
  const source = task && typeof task === 'object' ? task : {};
  return Object.freeze({
    id: clean(source.id) || null,
    start: source.start === true,
    source: clean(source.source) || null,
  });
}

function freezeUsageAttribution(input) {
  const source = input && typeof input === 'object' ? input : {};
  const cli = clean(source.cli).toLowerCase();
  const providerId = clean(source.providerId) || '_default_';
  const roleKind = clean(source.roleKind).toLowerCase() || 'main';
  const decisionId = clean(source.decisionId);
  const routeAttemptId = clean(source.routeAttemptId);
  const routeGeneration = source.routeGeneration == null ? null : Number(source.routeGeneration);
  const attemptNo = source.attemptNo == null ? null : Number(source.attemptNo);
  const runtimeEpoch = clean(source.runtimeEpoch);
  const providerRevision = clean(source.providerRevision);
  const hasAttemptIdentity = !!(decisionId || routeAttemptId
    || routeGeneration != null || attemptNo != null || runtimeEpoch || providerRevision);
  if (hasAttemptIdentity && (!decisionId || !routeAttemptId
      || !runtimeEpoch || !providerRevision
      || !Number.isSafeInteger(routeGeneration) || routeGeneration < 1
      || !Number.isSafeInteger(attemptNo) || attemptNo < 1)) {
    throw new TypeError('complete provider attempt attribution is required');
  }
  return Object.freeze({
    providerId,
    providerName: clean(source.providerName) || providerId,
    cli,
    protocol: clean(source.protocol).toLowerCase()
      || (cli === 'codex' || cli === 'codex-exp' ? 'openai-responses' : cli === 'claude' || cli === 'claude-exp' ? 'anthropic-messages' : cli),
    model: clean(source.model),
    roleKind,
    routeName: clean(source.routeName).toLowerCase() || roleKind,
    ...(hasAttemptIdentity ? {
      runtimeEpoch, decisionId, routeAttemptId, routeGeneration, attemptNo, providerRevision,
    } : {}),
  });
}

function bindTurnUsageAttribution(turn, input) {
  if (!turn || !turn.turnId) throw new TypeError('turn lifecycle is required');
  const next = freezeUsageAttribution(input);
  if (turn.usageAttribution) {
    const same = Object.keys(next).every(key => turn.usageAttribution[key] === next[key]);
    if (!same) throw new TypeError('turn usage attribution is already frozen');
    return turn.usageAttribution;
  }
  turn.usageAttribution = next;
  return next;
}

// Admission may mint a provisional task only after the normalized request has
// passed idempotency and scheduler guards. Bind that identity exactly once to
// the turn lifecycle so provider tools, usage, finalization and retries all see
// the same immutable snapshot instead of consulting the mutable session state.
function bindTurnTask(turn, input) {
  if (!turn || !turn.turnId) throw new TypeError('turn lifecycle is required');
  const next = freezeTask(input);
  if (turn.task?.id) {
    if (next.id && turn.task.id !== next.id) {
      throw new TypeError('turn task identity is already frozen');
    }
    return turn.task;
  }
  turn.task = next;
  return next;
}

function bindRunnerUsageAttribution(runner, input) {
  if (!runner || !runner.runnerId) throw new TypeError('runner ownership is required');
  const next = freezeUsageAttribution(input);
  if (!next.routeAttemptId) throw new TypeError('runner provider attempt attribution is required');
  if (runner.usageAttribution && runner.usageAttribution.routeAttemptId) {
    const same = Object.keys(next).every(key => runner.usageAttribution[key] === next[key]);
    if (!same) throw new TypeError('runner usage attribution is already frozen');
    return runner.usageAttribution;
  }
  runner.usageAttribution = next;
  return next;
}

function createTurnLifecycle(request, input = {}) {
  if (!request || !request.sessionId || !request.origin || !request.launch) {
    throw new TypeError('normalized turn request is required');
  }
  const turnId = clean(input.turnId);
  if (!turnId) throw new TypeError('turnId is required');
  const turn = {
    turnId,
    // The caller's own id for this request (a WS clientMsgId for a live voice
    // turn). Post-turn effects carry it so an out-of-band terminal frame can be
    // correlated back to the exact request that produced it.
    requestId: clean(request.requestId),
    sessionId: request.sessionId,
    userText: clean(request.text),
    lineage: freezeLineage(request.origin),
    task: freezeTask(request.task),
    launchReason: request.launch.reason === 'continue' ? 'continue' : 'request',
  };
  attachTurnState(turn);
  return turn;
}

function createRunnerOwnership(turn, input = {}) {
  if (!turn || !turn.turnId) throw new TypeError('turn lifecycle is required');
  const runnerId = clean(input.runnerId);
  if (!runnerId) throw new TypeError('runnerId is required');
  const runner = {
    runnerId,
    turnId: turn.turnId,
    kind: clean(input.kind) || 'process',
    sequence: input.sequence == null ? null : Number(input.sequence),
    killReason: null,
    retryPlanned: false,
    resultEvent: false,
    ...(input.completion ? { completion: input.completion } : {}),
    partialCheckpointKey: null,
    ...(input.usageAttribution
      ? { usageAttribution: freezeUsageAttribution(input.usageAttribution) }
      : turn.usageAttribution ? { usageAttribution: turn.usageAttribution } : {}),
  };
  if (input.providerAttempt) {
    if (!Object.isFrozen(input.providerAttempt)
        || input.providerAttempt.turnId !== turn.turnId
        || !clean(input.providerAttempt.routeAttemptId)) {
      throw new TypeError('frozen provider attempt ownership is required');
    }
    const routeProof = input.routeProof;
    const route = routeProof && routeProof.route;
    const attribution = runner.usageAttribution;
    const fields = [
      'runtimeEpoch', 'decisionId', 'routeAttemptId', 'routeGeneration', 'attemptNo',
      'providerId', 'providerName', 'protocol', 'model', 'providerRevision',
    ];
    if (!routeProof || !Object.isFrozen(routeProof) || !Object.isFrozen(route)
        || routeProof.kind !== 'provider-route' || routeProof.resolved !== true
        || routeProof.sessionId !== turn.sessionId || routeProof.turnId !== turn.turnId
        || routeProof.cli !== attribution.cli
        || input.providerAttempt.cli !== attribution.cli
        || input.providerAttempt.sessionId !== turn.sessionId
        || fields.some(field => route[field] !== input.providerAttempt[field]
          || attribution[field] !== input.providerAttempt[field])) {
      throw new TypeError('runner provider attempt, route proof, and attribution must match');
    }
    Object.defineProperty(runner, 'providerAttempt', {
      value: input.providerAttempt, enumerable: true, writable: false, configurable: false,
    });
    Object.defineProperty(runner, 'providerRouteProof', {
      value: routeProof, enumerable: true, writable: false, configurable: false,
    });
  } else if (input.routeProof) {
    throw new TypeError('route proof requires provider attempt ownership');
  }
  runnerState(runner);
  return runner;
}

function ownsCurrentRunner(currentTurn, currentRunner, turn, runner) {
  return getNative().chatOwnsCurrentRunner(currentTurn, currentRunner, turn, runner);
}

function assignKillReason(runner, reason) {
  return getNative().chatAssignKillReason(runner, reason);
}

function clearErrorFlagsForSucceededTurn(turn, runner, cs, facts = {}) {
  return getNative().chatClearSucceededErrors(turn, runner, cs, facts);
}

function recordResultEvent(turn, runner, facts = {}) {
  return getNative().chatRecordResultEvent(turn, runner, facts);
}

function recordCloseResult(turn, runner, facts = {}) {
  return getNative().chatRecordCloseResult(turn, runner, facts);
}

function recordPartialCheckpoint(turn, runner, facts = {}) {
  return getNative().chatRecordPartialCheckpoint(turn, runner, facts);
}

function hasMatchingPartialCheckpoint(runner, checkpointKey) {
  return getNative().chatHasPartialCheckpoint(runner, checkpointKey);
}

function claimDurableUsage(runner, facts = {}) {
  if (!runner) return Object.freeze({ ok: false, code: 'runner_required' });
  if (facts.resultDurable !== true) return Object.freeze({ ok: false, code: 'result_not_durable' });
  if (runner.usageRecorded === true) return Object.freeze({ ok: false, code: 'usage_already_recorded' });
  const state = runnerStates.get(runner);
  let descriptor = state && Object.getOwnPropertyDescriptor(runner, 'usageRecorded');
  if (state && !descriptor && !('usageRecorded' in runner)) {
    const setter = value => {
      if (Object.isFrozen(runner)) throw new TypeError("Cannot assign to read only property 'usageRecorded'");
      state.native.setUsageRecorded(value === true);
      state.opaque = value !== true && value !== false;
      state.value = value;
    };
    Object.defineProperty(runner, 'usageRecorded', {
      enumerable: true, configurable: true,
      get() { return state.opaque ? state.value : state.native.usageRecorded(); },
      set: setter,
    });
    state.native.setUsageRecorded(false);
    state.opaque = false;
    state.setter = setter;
    descriptor = Object.getOwnPropertyDescriptor(runner, 'usageRecorded');
  }
  if (state && descriptor?.set === state.setter && !Object.isFrozen(runner)) {
    if (!state.native.claimUsage()) return Object.freeze({ ok: false, code: 'usage_already_recorded' });
    state.opaque = false;
  } else runner.usageRecorded = true;
  return Object.freeze({ ok: true, code: null });
}

function evaluatePostTurn(turn, runner, facts = {}) {
  const code = getNative().evaluateChatPostTurn(turn, runner, facts);
  return Object.freeze({ ok: !code, code: code || null });
}

function claimPostTurn(turn, runner, facts = {}) {
  const decision = evaluatePostTurn(turn, runner, facts);
  if (!decision.ok) return decision;
  const state = turnStates.get(turn);
  const descriptor = state && Object.getOwnPropertyDescriptor(turn, 'postTurnClaimed');
  if (state && descriptor?.set === state.claimSetter && !Object.isFrozen(turn)) {
    if (!state.native.claimPostTurn()) return Object.freeze({ ok: false, code: 'post_turn_already_claimed' });
    state.opaque.delete('postTurnClaimed');
  } else turn.postTurnClaimed = true;
  return Object.freeze({ ok: true, code: null, lineage: turn.lineage });
}

module.exports = {
  freezeLineage,
  freezeTask,
  freezeUsageAttribution,
  bindTurnTask,
  bindTurnUsageAttribution,
  bindRunnerUsageAttribution,
  createTurnLifecycle,
  createRunnerOwnership,
  ownsCurrentRunner,
  assignKillReason,
  clearErrorFlagsForSucceededTurn,
  recordResultEvent,
  recordCloseResult,
  recordPartialCheckpoint,
  hasMatchingPartialCheckpoint,
  claimDurableUsage,
  reserveResultAppend,
  releaseResultAppend,
  recordConfirmedResult,
  confirmedResult,
  reserveUsageWrite,
  releaseUsageWrite,
  evaluatePostTurn,
  claimPostTurn,
};
