'use strict';

const crypto = require('node:crypto');
const {
  ownsCurrentRunner,
  assignKillReason,
  recordResultEvent,
  recordCloseResult,
  recordPartialCheckpoint,
  hasMatchingPartialCheckpoint,
  claimDurableUsage,
  evaluatePostTurn,
  claimPostTurn,
} = require('./turn-lifecycle');
const {
  routePostTurn,
  acknowledgeDeliveredEffect,
} = require('./post-turn-router');

const CHAT_HOST_PORTS = Object.freeze({
  history: Object.freeze(['appendFinal']),
  usage: Object.freeze(['commit']),
  effects: Object.freeze([]),
});

function clean(value) { return value == null ? '' : String(value).trim(); }

function assertChatHostPorts(ports) {
  if (!ports || typeof ports !== 'object') throw new TypeError('chat host ports are required');
  for (const [name, methods] of Object.entries(CHAT_HOST_PORTS)) {
    const port = ports[name];
    if (name === 'effects' && port == null) continue;
    if (!port || typeof port !== 'object') throw new TypeError(`chat host port missing: ${name}`);
    for (const method of methods) {
      if (typeof port[method] !== 'function') throw new TypeError(`chat host port missing: ${name}.${method}`);
    }
  }
  if (ports.usage.afterCommit != null && typeof ports.usage.afterCommit !== 'function') {
    throw new TypeError('chat host port invalid: usage.afterCommit');
  }
  if (ports.usage.commitTaskRun != null && typeof ports.usage.commitTaskRun !== 'function') {
    throw new TypeError('chat host port invalid: usage.commitTaskRun');
  }
  if (ports.effects && ports.effects.deliver != null && typeof ports.effects.deliver !== 'function') {
    throw new TypeError('chat host port invalid: effects.deliver');
  }
  return ports;
}

function succeeded(value) {
  return value === true || !!(value && typeof value === 'object' && value.ok === true);
}

function isCurrentTurnRunner(host, turn, runner) {
  return ownsCurrentRunner(
    host && (host.currentTurn || host._activeTurn),
    host && (host.currentRunner || host._activeRunner),
    turn,
    runner,
  );
}

function assistantCheckpointKey(output = {}) {
  const text = output.text != null ? output.text : output.currentAssistantText;
  const tools = output.tools != null ? output.tools : output.currentToolCalls;
  const cost = output.cost != null ? output.cost : output.currentCost;
  return crypto.createHash('sha256').update(JSON.stringify({
    text: text || '',
    tools: Array.isArray(tools) ? tools : [],
    cost: cost == null ? null : cost,
  })).digest('hex');
}

function decideRunnerFinality(runner, facts = {}) {
  if (!runner) return Object.freeze({ final: false, code: 'runner_required' });
  if (runner.killReason || facts.killReason) {
    return Object.freeze({ final: false, code: 'explicit_lifecycle_stop' });
  }
  if (runner.retryPlanned || facts.retryPlanned === true) {
    return Object.freeze({ final: false, code: 'retry_pending' });
  }
  if (facts.apiError === true) return Object.freeze({ final: false, code: 'api_error' });
  if (facts.adapterError === true) return Object.freeze({ final: false, code: 'adapter_error' });

  // A persistent Claude stream is final only after its result event. Process
  // runners retain the legacy clean-exit fallback, but never on a retry. This
  // distinction is deliberately explicit so an adapter cannot accidentally
  // promote a truncated stream to a final answer.
  if (runner.kind === 'stream') {
    return Object.freeze({
      final: runner.resultEvent === true,
      code: runner.resultEvent === true ? null : 'stream_result_event_required',
    });
  }
  const final = runner.resultEvent === true || (facts.normalExit === true && facts.isRetry !== true);
  return Object.freeze({
    final,
    code: final ? null : facts.isRetry === true ? 'retry_result_event_required' : 'clean_exit_required',
  });
}

function makeAppendResult(input = {}) {
  return Object.freeze({
    attempted: input.attempted === true,
    persisted: input.persisted === true,
    durable: input.durable === true,
    partial: input.partial === true,
    code: input.code || null,
    error: input.error || null,
  });
}

function makeUsageResult(input = {}) {
  return Object.freeze({
    attempted: input.attempted === true,
    committed: input.committed === true,
    code: input.code || null,
    error: input.error || null,
    observerError: input.observerError || null,
  });
}

function taskRunIdentity(turn) {
  const task = turn && turn.task && typeof turn.task === 'object' ? turn.task : {};
  const lineage = turn && turn.lineage && typeof turn.lineage === 'object' ? turn.lineage : {};
  const taskRunId = clean(
      task.taskRunId || task.runId || (turn && turn.taskRunId)
      || lineage.taskRunId || lineage.runId,
    ) || null;
  const leaseEpoch = Number(task.leaseEpoch ?? (turn && turn.leaseEpoch) ?? lineage.leaseEpoch);
  return Object.freeze({
    taskRunId,
    taskId: clean(task.taskId || task.id || lineage.taskId) || null,
    leaseEpoch: taskRunId && Number.isSafeInteger(leaseEpoch) && leaseEpoch > 0
      ? leaseEpoch
      : null,
  });
}

function snapshotObject(value) {
  return Object.freeze(value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value }
    : {});
}

function createChatHostCoordinator(rawPorts, options = {}) {
  const ports = assertChatHostPorts(rawPorts);
  const nextReservationId = typeof options.nextReservationId === 'function'
    ? options.nextReservationId
    : (() => {
      let sequence = 0;
      return () => `post_turn_${++sequence}`;
    })();

  function isCurrent(input) {
    return isCurrentTurnRunner({
      currentTurn: input.currentTurn,
      currentRunner: input.currentRunner,
    }, input.turn, input.runner);
  }

  function appendResult(input = {}) {
    const { turn, runner } = input;
    if (!isCurrent(input)) return makeAppendResult({ code: 'stale_runner' });
    if (!turn || !runner) return makeAppendResult({ code: 'runner_required' });
    if (turn.resultDurable) {
      return makeAppendResult({ persisted: true, durable: true, code: 'already_durable' });
    }

    const boundary = input.boundary === 'result' ? 'result' : 'close';
    if (boundary === 'result') runner.resultEvent = true;
    const finality = boundary === 'result'
      ? Object.freeze({ final: true, code: null })
      : decideRunnerFinality(runner, input.facts);
    const checkpointKey = clean(input.checkpointKey);
    if (!finality.final && checkpointKey && hasMatchingPartialCheckpoint(runner, checkpointKey)) {
      return makeAppendResult({ persisted: true, partial: true, code: 'partial_already_durable' });
    }
    if (!input.message) {
      if (boundary === 'result') recordResultEvent(turn, runner, { current: true, persisted: false });
      return makeAppendResult({ code: 'message_required', partial: !finality.final });
    }

    let persisted = false;
    let appendError = null;
    try {
      persisted = succeeded(ports.history.appendFinal(Object.freeze({
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        runnerId: runner.runnerId,
        runnerKind: runner.kind,
        boundary,
        final: finality.final,
        partial: !finality.final,
        checkpointKey: checkpointKey || null,
        message: input.message,
      })));
    } catch (error) {
      appendError = error && error.message ? String(error.message) : 'append failed';
    }

    const proof = boundary === 'result'
      ? recordResultEvent(turn, runner, { current: true, persisted })
      : recordCloseResult(turn, runner, { current: true, persisted, final: finality.final });
    if (persisted && !finality.final && checkpointKey) {
      recordPartialCheckpoint(turn, runner, { current: true, persisted: true, checkpointKey });
    }
    return makeAppendResult({
      attempted: true,
      persisted,
      durable: proof.resultDurable === true,
      partial: !finality.final,
      code: appendError ? 'append_failed' : proof.code,
      error: appendError,
    });
  }

  function commitUsage(input = {}) {
    const { turn, runner } = input;
    if (!isCurrent(input)) return makeUsageResult({ code: 'stale_runner' });
    if (!turn || !runner || turn.resultDurable !== true) {
      return makeUsageResult({ code: 'result_not_durable' });
    }
    if (turn.resultRunnerId !== runner.runnerId) {
      return makeUsageResult({ code: 'result_owned_by_other_runner' });
    }
    if (runner.usageRecorded === true) return makeUsageResult({ committed: true, code: 'usage_already_recorded' });

    const identity = taskRunIdentity(turn);
    const initialContext = Object.freeze({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      runnerId: runner.runnerId,
      idempotencyKey: `usage:${turn.turnId}:${runner.runnerId}`,
      taskRunId: identity.taskRunId,
      taskId: identity.taskId,
      leaseEpoch: identity.leaseEpoch,
      task: snapshotObject(turn.task),
      lineage: snapshotObject(turn.lineage),
      attribution: snapshotObject(input.attribution),
      usage: snapshotObject(input.usage),
    });
    const context = runner.usageCommitContext || initialContext;
    const taskRunRequired = !!(context.taskRunId && ports.usage.commitTaskRun);

    if (runner.legacyUsageRecorded !== true) {
      let committed = false;
      let commitError = null;
      try {
        committed = succeeded(ports.usage.commit(Object.freeze({
          sessionId: context.sessionId,
          turnId: context.turnId,
          runnerId: context.runnerId,
          idempotencyKey: context.idempotencyKey,
          attribution: context.attribution,
          usage: context.usage,
        })));
      } catch (error) {
        commitError = error && error.message ? String(error.message) : 'usage commit failed';
      }
      if (!committed) {
        return makeUsageResult({ attempted: true, code: 'usage_commit_failed', error: commitError });
      }
      // The legacy aggregate is not intrinsically idempotent. Retain the
      // exact snapshot after it succeeds so a TaskRun-ledger retry cannot add
      // the legacy usage a second time or drift attribution mid-finalization.
      runner.legacyUsageRecorded = true;
      runner.usageCommitContext = context;
    }

    if (taskRunRequired && runner.taskRunUsageRecorded !== true) {
      let taskRunCommitted = false;
      let taskRunError = null;
      try {
        taskRunCommitted = succeeded(ports.usage.commitTaskRun(Object.freeze({
          sessionId: context.sessionId,
          turnId: context.turnId,
          runnerId: context.runnerId,
          idempotencyKey: context.idempotencyKey,
          taskRunId: context.taskRunId,
          taskId: context.taskId,
          leaseEpoch: context.leaseEpoch,
          task: context.task,
          lineage: context.lineage,
          attribution: context.attribution,
          usage: context.usage,
        })));
      } catch (error) {
        taskRunError = error && error.message ? String(error.message) : 'task-run usage commit failed';
      }
      if (!taskRunCommitted) {
        return makeUsageResult({
          attempted: true,
          code: 'task_run_usage_commit_failed',
          error: taskRunError,
        });
      }
      runner.taskRunUsageRecorded = true;
    }

    const claim = claimDurableUsage(runner, { resultDurable: true });
    if (!claim.ok) return makeUsageResult({ attempted: true, committed: true, code: claim.code });

    let observerError = null;
    if (ports.usage.afterCommit) {
      try {
        ports.usage.afterCommit(Object.freeze({
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          runnerId: runner.runnerId,
          attribution: context.attribution,
        }));
      } catch (error) {
        observerError = error && error.message ? String(error.message) : 'usage observer failed';
      }
    }
    return makeUsageResult({ attempted: true, committed: true, observerError });
  }

  function finalize(input = {}) {
    if (!isCurrent(input)) {
      return Object.freeze({ ok: false, code: 'stale_runner', append: makeAppendResult({ code: 'stale_runner' }), usage: makeUsageResult({ code: 'stale_runner' }) });
    }
    const { runner } = input;
    if (input.facts && input.facts.killReason) assignKillReason(runner, input.facts.killReason);
    if (input.facts && input.facts.retryPlanned === true) runner.retryPlanned = true;
    const append = appendResult(input);
    const usage = commitUsage({
      ...input,
      usage: input.usage,
    });
    const decision = evaluatePostTurn(input.turn, runner, {
      currentTurn: input.currentTurn,
      currentRunner: input.currentRunner,
      interrupted: !!(input.facts && input.facts.interrupted),
      apiError: !!(input.facts && input.facts.apiError),
      retryPlanned: !!(input.facts && input.facts.retryPlanned),
      handoffResumeFailure: !!(input.facts && input.facts.handoffResumeFailure),
    });
    const usageDecision = decision.ok && taskRunIdentity(input.turn).taskRunId
      && ports.usage.commitTaskRun && runner.taskRunUsageRecorded !== true
      ? Object.freeze({ ok: false, code: 'task_run_usage_not_durable' })
      : decision;
    return Object.freeze({
      ok: append.durable === true && usageDecision.ok === true,
      code: append.durable !== true ? append.code || usageDecision.code : usageDecision.code,
      append,
      usage,
      postTurn: usageDecision,
      lineage: input.turn.lineage,
    });
  }

  function reservePostTurn(input = {}) {
    const { turn, runner } = input;
    const decision = evaluatePostTurn(turn, runner, {
      currentTurn: input.currentTurn,
      currentRunner: input.currentRunner,
      interrupted: input.interrupted === true,
      apiError: input.apiError === true,
      retryPlanned: input.retryPlanned === true,
      handoffResumeFailure: input.handoffResumeFailure === true,
    });
    if (!decision.ok) return Object.freeze({ ok: false, code: decision.code, effects: Object.freeze([]) });
    if (taskRunIdentity(turn).taskRunId && ports.usage.commitTaskRun
        && runner.taskRunUsageRecorded !== true) {
      return Object.freeze({ ok: false, code: 'task_run_usage_not_durable', effects: Object.freeze([]) });
    }
    if (turn.postTurnReservation) {
      return Object.freeze({ ok: false, code: 'post_turn_in_flight', effects: Object.freeze([]) });
    }
    const reservationId = clean(nextReservationId()) || `post_turn_${turn.turnId}_${runner.runnerId}`;
    turn.postTurnReservation = Object.freeze({ reservationId, runnerId: runner.runnerId });
    const routed = routePostTurn({
      turnId: turn.turnId,
      requestId: turn.requestId,
      sessionId: turn.sessionId,
      sessionType: input.sessionType,
      finalText: input.finalText,
      receipts: input.receipts,
      handoff: input.handoff,
      handoffResumeFailure: input.handoffResumeFailure,
      originDispatchId: turn.lineage.kind === 'dispatch' ? turn.lineage.operationId : null,
    });
    return Object.freeze({
      ok: true,
      code: null,
      reservationId,
      route: routed.route,
      effects: routed.effects,
      turnId: turn.turnId,
      runnerId: runner.runnerId,
    });
  }

  // Production-compatible synchronous boundary. It consumes only the
  // in-memory once claim and returns deterministic effect descriptions; it
  // deliberately does not call the effect port or manufacture delivery
  // receipts. The host remains responsible for its current best-effort
  // handoff/bus adapters while delivery-bound effects keep their proof flag.
  function claimPostTurnPlan(input = {}) {
    const { turn, runner } = input;
    const decision = evaluatePostTurn(turn, runner, {
      currentTurn: input.currentTurn,
      currentRunner: input.currentRunner,
      interrupted: input.interrupted === true,
      apiError: input.apiError === true,
      retryPlanned: input.retryPlanned === true,
      handoffResumeFailure: input.handoffResumeFailure === true,
    });
    if (!decision.ok) {
      return Object.freeze({ ok: false, code: decision.code, route: null, effects: Object.freeze([]) });
    }
    if (taskRunIdentity(turn).taskRunId && ports.usage.commitTaskRun
        && runner.taskRunUsageRecorded !== true) {
      return Object.freeze({
        ok: false,
        code: 'task_run_usage_not_durable',
        route: null,
        effects: Object.freeze([]),
      });
    }
    const claim = claimPostTurn(turn, runner, {
      currentTurn: input.currentTurn,
      currentRunner: input.currentRunner,
      interrupted: input.interrupted === true,
      apiError: input.apiError === true,
      retryPlanned: input.retryPlanned === true,
      handoffResumeFailure: input.handoffResumeFailure === true,
    });
    if (!claim.ok) {
      return Object.freeze({ ok: false, code: claim.code, route: null, effects: Object.freeze([]) });
    }
    const routed = routePostTurn({
      turnId: turn.turnId,
      requestId: turn.requestId,
      sessionId: turn.sessionId,
      sessionType: input.sessionType,
      finalText: input.finalText,
      receipts: input.receipts,
      originDispatchId: turn.lineage.kind === 'dispatch' ? turn.lineage.operationId : null,
    });
    const effects = [
      Object.freeze({
        type: 'consume-cli-handoff',
        effectId: `consume-cli-handoff:${turn.turnId}`,
        bestEffort: true,
        requiresDeliveryProof: false,
        sessionId: turn.sessionId,
      }),
      Object.freeze({
        type: 'turn-complete',
        effectId: `turn-complete:${turn.turnId}`,
        bestEffort: true,
        requiresDeliveryProof: false,
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        lineage: turn.lineage,
        resultDurable: true,
      }),
      ...routed.effects,
    ];
    return Object.freeze({
      ok: true,
      code: null,
      route: routed.route,
      effects: Object.freeze(effects),
      lineage: claim.lineage,
      deliveryProven: false,
    });
  }

  function releaseReservation(turn, plan) {
    if (turn && turn.postTurnReservation
        && turn.postTurnReservation.reservationId === plan.reservationId) {
      turn.postTurnReservation = null;
    }
  }

  async function deliverPostTurn(plan, input = {}) {
    const { turn, runner } = input;
    const reservation = turn && turn.postTurnReservation;
    if (!plan || plan.ok !== true || !reservation
        || reservation.reservationId !== plan.reservationId
        || reservation.runnerId !== (runner && runner.runnerId)) {
      return Object.freeze({ ok: false, code: 'invalid_post_turn_reservation', receipts: Object.freeze([]) });
    }
    if (!isCurrent(input)) {
      releaseReservation(turn, plan);
      return Object.freeze({ ok: false, code: 'stale_runner', receipts: Object.freeze([]) });
    }
    if (!ports.effects || typeof ports.effects.deliver !== 'function') {
      releaseReservation(turn, plan);
      return Object.freeze({ ok: false, code: 'effects_port_missing', receipts: Object.freeze([]) });
    }

    const receipts = [];
    for (const effect of plan.effects) {
      let delivered;
      try {
        delivered = await ports.effects.deliver(effect, Object.freeze({
          reservationId: plan.reservationId,
          turnId: turn.turnId,
          runnerId: runner.runnerId,
        }));
      } catch (error) {
        releaseReservation(turn, plan);
        return Object.freeze({
          ok: false,
          code: 'effect_delivery_failed',
          effectId: effect.effectId,
          error: error && error.message ? String(error.message) : 'effect delivery failed',
          receipts: Object.freeze(receipts),
        });
      }
      if (effect.requiresDeliveryProof === true) {
        const ack = acknowledgeDeliveredEffect(effect, delivered);
        if (!ack.ok) {
          releaseReservation(turn, plan);
          return Object.freeze({
            ok: false,
            code: ack.code,
            effectId: effect.effectId,
            receipts: Object.freeze(receipts),
          });
        }
        receipts.push(ack.receipt);
      } else if (!succeeded(delivered)) {
        releaseReservation(turn, plan);
        return Object.freeze({
          ok: false,
          code: 'effect_delivery_failed',
          effectId: effect.effectId,
          receipts: Object.freeze(receipts),
        });
      }
    }

    if (!isCurrent(input)) {
      releaseReservation(turn, plan);
      return Object.freeze({ ok: false, code: 'stale_runner', receipts: Object.freeze(receipts) });
    }
    releaseReservation(turn, plan);
    const claim = claimPostTurn(turn, runner, {
      currentTurn: input.currentTurn,
      currentRunner: input.currentRunner,
    });
    if (!claim.ok) {
      return Object.freeze({ ok: false, code: claim.code, receipts: Object.freeze(receipts) });
    }
    return Object.freeze({
      ok: true,
      code: null,
      route: plan.route,
      receipts: Object.freeze(receipts),
      lineage: claim.lineage,
    });
  }

  function abortPostTurn(plan, turn) {
    if (!plan || !turn || !turn.postTurnReservation
        || turn.postTurnReservation.reservationId !== plan.reservationId) return false;
    turn.postTurnReservation = null;
    return true;
  }

  return Object.freeze({
    isCurrentTurnRunner: (host, turn, runner) => isCurrentTurnRunner(host, turn, runner),
    assistantCheckpointKey,
    appendResult,
    appendFinal: appendResult,
    commitUsage,
    finalize,
    claimPostTurnPlan,
    reservePostTurn,
    deliverPostTurn,
    abortPostTurn,
  });
}

module.exports = {
  CHAT_HOST_PORTS,
  assertChatHostPorts,
  isCurrentTurnRunner,
  assistantCheckpointKey,
  decideRunnerFinality,
  createChatHostCoordinator,
};
