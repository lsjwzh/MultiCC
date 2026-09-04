'use strict';

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
  const runId = clean(source.runId || source.taskRunId);
  const leaseEpoch = source.leaseEpoch == null ? null : Number(source.leaseEpoch);
  return Object.freeze({
    id: clean(source.id) || null,
    ...(runId ? { runId, leaseEpoch } : {}),
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
      || (cli === 'codex' ? 'openai-responses' : cli === 'claude' ? 'anthropic-messages' : cli),
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
  return {
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
    resultDurable: false,
    resultRunnerId: null,
    postTurnClaimed: false,
  };
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
  return runner;
}

function ownsCurrentRunner(currentTurn, currentRunner, turn, runner) {
  return !!(
    currentTurn === turn
    && currentRunner === runner
    && turn && runner
    && runner.turnId === turn.turnId
  );
}

function assignKillReason(runner, reason) {
  if (!runner) return false;
  runner.killReason = clean(reason) || null;
  return !!runner.killReason;
}

// A durable final result is only ever written for a non-error result
// (persistFinalAssistantResult skips api-failure envelopes), so once a turn
// has one, a clean close proves any error flagged mid-stream was recovered
// from. codex surfaces its own housekeeping failures (model-list refresh,
// skill loading) as stream error items and then finishes the turn normally;
// without this veto the sticky flags classify a succeeded turn as an API
// error at close. Returns true when flags were actually cleared.
function clearErrorFlagsForSucceededTurn(turn, runner, cs, facts = {}) {
  if (!turn || !runner || turn.resultDurable !== true) return false;
  if (facts.killReason) return false;
  if (facts.code !== undefined && facts.code !== null && facts.code !== 0) return false;
  const hadErrorFlags = !!(runner.sawApiError || runner.apiErrorRaw || runner.adapterError);
  runner.sawApiError = false;
  runner.apiErrorRaw = null;
  runner.adapterError = null;
  if (cs) {
    cs._sawApiError = false;
    cs._adapterError = null;
  }
  return hadErrorFlags;
}

function recordResultEvent(turn, runner, facts = {}) {
  if (!turn || !runner || runner.turnId !== turn.turnId || facts.current !== true) {
    return Object.freeze({ ok: false, code: 'stale_runner', resultDurable: !!(turn && turn.resultDurable) });
  }
  runner.resultEvent = true;
  // Durability is monotonic for one turn. A failed later duplicate append must
  // never erase an earlier committed final result.
  if (facts.persisted === true) {
    turn.resultDurable = true;
    turn.resultRunnerId = runner.runnerId;
  }
  return Object.freeze({
    ok: facts.persisted === true,
    code: facts.persisted === true ? null : 'result_not_durable',
    resultDurable: turn.resultDurable,
  });
}

function recordCloseResult(turn, runner, facts = {}) {
  if (!turn || !runner || runner.turnId !== turn.turnId || facts.current !== true) {
    return Object.freeze({ ok: false, code: 'stale_runner', resultDurable: !!(turn && turn.resultDurable) });
  }
  if (facts.final === true && facts.persisted === true) {
    turn.resultDurable = true;
    turn.resultRunnerId = runner.runnerId;
  }
  return Object.freeze({
    ok: facts.final === true && facts.persisted === true,
    code: facts.final !== true ? 'not_final_result'
      : facts.persisted !== true ? 'result_not_durable' : null,
    resultDurable: turn.resultDurable,
  });
}

function recordPartialCheckpoint(turn, runner, facts = {}) {
  if (!turn || !runner || runner.turnId !== turn.turnId || facts.current !== true) {
    return Object.freeze({ ok: false, code: 'stale_runner' });
  }
  const checkpointKey = clean(facts.checkpointKey);
  if (facts.persisted !== true || !checkpointKey) {
    return Object.freeze({ ok: false, code: 'checkpoint_not_durable' });
  }
  runner.partialCheckpointKey = checkpointKey;
  return Object.freeze({ ok: true, code: null, checkpointKey });
}

function hasMatchingPartialCheckpoint(runner, checkpointKey) {
  return !!(runner && runner.partialCheckpointKey && runner.partialCheckpointKey === clean(checkpointKey));
}

function claimDurableUsage(runner, facts = {}) {
  if (!runner) return Object.freeze({ ok: false, code: 'runner_required' });
  if (facts.resultDurable !== true) return Object.freeze({ ok: false, code: 'result_not_durable' });
  if (runner.usageRecorded === true) return Object.freeze({ ok: false, code: 'usage_already_recorded' });
  runner.usageRecorded = true;
  return Object.freeze({ ok: true, code: null });
}

function evaluatePostTurn(turn, runner, facts = {}) {
  if (!ownsCurrentRunner(facts.currentTurn, facts.currentRunner, turn, runner)) {
    return Object.freeze({ ok: false, code: 'stale_runner' });
  }
  if (!turn.resultDurable) return Object.freeze({ ok: false, code: 'result_not_durable' });
  if (turn.resultRunnerId !== runner.runnerId) {
    return Object.freeze({ ok: false, code: 'result_owned_by_other_runner' });
  }
  if (runner.killReason || facts.interrupted === true) {
    return Object.freeze({ ok: false, code: 'turn_interrupted' });
  }
  if (facts.apiError === true) return Object.freeze({ ok: false, code: 'api_error_retry_pending' });
  if (runner.retryPlanned || facts.retryPlanned === true) {
    return Object.freeze({ ok: false, code: 'retry_pending' });
  }
  if (facts.handoffResumeFailure === true) {
    return Object.freeze({ ok: false, code: 'handoff_resume_failed' });
  }
  if (turn.postTurnClaimed) return Object.freeze({ ok: false, code: 'post_turn_already_claimed' });
  return Object.freeze({ ok: true, code: null });
}

function claimPostTurn(turn, runner, facts = {}) {
  const decision = evaluatePostTurn(turn, runner, facts);
  if (!decision.ok) return decision;
  turn.postTurnClaimed = true;
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
  evaluatePostTurn,
  claimPostTurn,
};
