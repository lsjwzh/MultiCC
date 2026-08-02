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
  return Object.freeze({
    id: clean(source.id) || null,
    start: source.start === true,
    source: clean(source.source) || null,
  });
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
  return {
    runnerId,
    turnId: turn.turnId,
    kind: clean(input.kind) || 'process',
    sequence: input.sequence == null ? null : Number(input.sequence),
    killReason: null,
    retryPlanned: false,
    resultEvent: false,
    partialCheckpointKey: null,
  };
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
  createTurnLifecycle,
  createRunnerOwnership,
  ownsCurrentRunner,
  assignKillReason,
  recordResultEvent,
  recordCloseResult,
  recordPartialCheckpoint,
  hasMatchingPartialCheckpoint,
  claimDurableUsage,
  evaluatePostTurn,
  claimPostTurn,
};
