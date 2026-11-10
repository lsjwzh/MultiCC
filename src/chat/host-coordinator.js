'use strict';

const crypto = require('node:crypto');
const { getNative } = require('../native/runtime');
const {
  ownsCurrentRunner,
  assignKillReason,
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
  return Object.freeze(getNative().decideChatRunnerFinality(runner, facts));
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

  async function appendResult(input = {}) {
    const { turn, runner } = input;
    if (!isCurrent(input)) return makeAppendResult({ code: 'stale_runner' });
    if (!turn || !runner) return makeAppendResult({ code: 'runner_required' });
    const saved = confirmedResult(turn);
    if (saved && (saved.runner !== runner || saved.runnerId !== runner.runnerId)) {
      return makeAppendResult({ code: 'result_owned_by_other_runner' });
    }
    if (turn.resultDurable) {
      if (turn.resultRunnerId !== runner.runnerId) return makeAppendResult({ code: 'result_owned_by_other_runner' });
      return makeAppendResult({ persisted: true, durable: true, code: 'already_durable' });
    }

    if (!reserveResultAppend(turn)) return makeAppendResult({ code: 'result_append_in_flight' });
    try {
      const boundary = input.boundary === 'result' ? 'result' : 'close';
      if (boundary === 'result') runner.resultEvent = true;
      if (saved) {
        if (!isCurrent(input)) return makeAppendResult({ code: 'stale_runner' });
        const proof = recordCloseResult(turn, runner, { current: true, persisted: true, final: true });
        return makeAppendResult({ persisted: true, durable: proof.resultDurable === true, code: 'already_durable' });
      }
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

      if (!isCurrent(input)) return makeAppendResult({ code: 'stale_runner' });

      let persisted = false;
      let appendError = null;
      let appendInput;
      try {
        appendInput = Object.freeze({
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          runnerId: runner.runnerId,
          runnerKind: runner.kind,
          boundary,
          final: finality.final,
          partial: !finality.final,
          checkpointKey: checkpointKey || null,
          message: input.message,
        });
        persisted = succeeded(await ports.history.appendFinal(appendInput));
      } catch (error) {
        appendError = error && error.message ? String(error.message) : 'append failed';
      }

      if (persisted && finality.final && !recordConfirmedResult(turn, runner, appendInput.runnerId)) {
        return makeAppendResult({ attempted: true, persisted: true, code: 'result_receipt_conflict' });
      }

      // The append can synchronously replace the active runner. Preserve the
      // persisted fact while refusing to promote an obsolete result to the
      // current turn or run effects for it.
      if (!isCurrent(input)) {
        return makeAppendResult({ attempted: true, persisted, partial: !finality.final, code: 'stale_runner' });
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
    } finally {
      releaseResultAppend(turn);
    }
  }

  function commitUsage(input = {}) {
    const { turn, runner } = input;
    // `identityOnly` is only used by the two-phase final-answer commit: Rust
    // already decided the answer landed and passes the producing turn/runner.
    // That identity may no longer own the session, but its tokens were spent;
    // commit idempotently by (turnId, runnerId) and never touch the replacement.
    const identityOnly = input.identityOnly === true;
    const current = () => identityOnly || isCurrent(input);
    if (!current()) return makeUsageResult({ code: 'stale_runner' });
    if (!turn || !runner) return makeUsageResult({ code: 'result_not_durable' });
    if (identityOnly) {
      // Rust only calls this after the append reported the row landed
      // (`durable || persisted`) and it passes the producing pair. A write that
      // completed after the turn was replaced never ran the current-only
      // `recordResultEvent`, so `turn.resultDurable` is still unset; requiring
      // it here would silently drop the spent tokens. Pairing the runner with
      // the reason's own turn is the identity proof, and the idempotency key
      // plus `runner.usageRecorded` keep a retry from paying twice.
      if (!runner.turnId || runner.turnId !== turn.turnId) {
        return makeUsageResult({ code: 'result_owned_by_other_runner' });
      }
    } else {
      if (turn.resultDurable !== true) return makeUsageResult({ code: 'result_not_durable' });
      if (turn.resultRunnerId !== runner.runnerId) {
        return makeUsageResult({ code: 'result_owned_by_other_runner' });
      }
    }
    if (runner.usageRecorded === true) return makeUsageResult({ committed: true, code: 'usage_already_recorded' });

    if (!reserveUsageWrite(runner)) return makeUsageResult({ code: 'usage_in_flight' });
    try {
      const initialContext = Object.freeze({
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        runnerId: runner.runnerId,
        idempotencyKey: `usage:${turn.turnId}:${runner.runnerId}`,
        attribution: snapshotObject(input.attribution),
        usage: snapshotObject(input.usage),
      });
      const context = runner.usageCommitContext || initialContext;

      if (!current()) return makeUsageResult({ code: 'stale_runner' });

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
        // The legacy aggregate is not intrinsically idempotent. Retain the exact
        // snapshot that was committed so a retry cannot add the usage a second
        // time or drift attribution mid-finalization.
        runner.legacyUsageRecorded = true;
        runner.usageCommitContext = context;
      }

      if (!current()) return makeUsageResult({ attempted: true, committed: true, code: 'stale_runner' });

      const claim = claimDurableUsage(runner, { resultDurable: true });
      if (!claim.ok) return makeUsageResult({ attempted: true, committed: true, code: claim.code });

      if (!current()) return makeUsageResult({ attempted: true, committed: true, code: 'stale_runner' });

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
      if (!current()) return makeUsageResult({ attempted: true, committed: true, code: 'stale_runner', observerError });
      return makeUsageResult({ attempted: true, committed: true, observerError });
    } finally {
      releaseUsageWrite(runner);
    }
  }

  async function finalize(input = {}) {
    if (!isCurrent(input)) {
      return Object.freeze({ ok: false, code: 'stale_runner', append: makeAppendResult({ code: 'stale_runner' }), usage: makeUsageResult({ code: 'stale_runner' }) });
    }
    const { runner } = input;
    if (input.facts && input.facts.killReason) assignKillReason(runner, input.facts.killReason);
    if (input.facts && input.facts.retryPlanned === true) runner.retryPlanned = true;
    const append = await appendResult(input);
    const usage = commitUsage({
      ...input,
      get currentTurn() { return input.currentTurn; },
      get currentRunner() { return input.currentRunner; },
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
    return Object.freeze({
      ok: append.durable === true && decision.ok === true,
      code: append.durable !== true ? append.code || decision.code : decision.code,
      append,
      usage,
      postTurn: decision,
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
