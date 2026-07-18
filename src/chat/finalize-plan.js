'use strict';

const { decideRetry } = require('./retry-policy');
const { decideRunnerFinality } = require('./host-coordinator');

const USER_STOP_REASONS = Object.freeze(new Set(['user_cancel', 'new_user_message']));

function effect(type, fields = {}) {
  return Object.freeze({ type, ...fields });
}

function freezePlan(plan) {
  if (plan.append) Object.freeze(plan.append);
  if (plan.facts) Object.freeze(plan.facts);
  if (plan.retry) Object.freeze(plan.retry);
  if (plan.effects) Object.freeze(plan.effects);
  return Object.freeze(plan);
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '' && value !== false;
}

function normalizeRunnerKind(value) {
  return value === 'stream' ? 'stream' : 'process';
}

function classifyProcessExit(input = {}) {
  const signal = input.signal == null ? '' : String(input.signal);
  const killReason = input.killReason == null ? '' : String(input.killReason);
  const code = input.code == null ? 0 : Number(input.code);
  if (signal) return killReason ? 'killed' : 'signaled';
  if (code !== 0 && input.recoveredTransport !== true) return 'nonzero_exit';
  if (input.resultDurable !== true && input.hasOutput !== true) return 'empty_exit';
  return 'normal';
}

function normalizeHandoff(input = {}) {
  const handoff = input.handoff && typeof input.handoff === 'object' ? input.handoff : {};
  return Object.freeze({
    pending: handoff.status === 'pending' || handoff.pending === true,
    reusedTarget: handoff.reusedTarget === true,
    toCli: handoff.toCli == null ? '' : String(handoff.toCli),
  });
}

function isGuardedHandoffFailure(facts, handoff) {
  if (!handoff.pending || !handoff.reusedTarget || handoff.toCli !== facts.cli) return false;
  if (facts.runnerKind === 'stream') {
    return !facts.resultDurable && !USER_STOP_REASONS.has(facts.killReason);
  }
  return !facts.isRetry && !facts.hasOutput && !facts.killReason && !facts.retryBlockedByAdapterError;
}

function retryEffects(action, retry, facts) {
  if (action === 'continue-codex') {
    return Object.freeze([
      effect('mark-retry-planned'),
      effect('reset-codex-disconnect-state'),
      effect('set-streaming', { value: true }),
      effect('set-status', { status: 'running' }),
      effect('spawn-codex-continuation', { attempt: retry.attempt, cap: retry.cap }),
    ]);
  }
  return Object.freeze([
    effect('reset-native-session', { cli: facts.cli }),
    effect('persist-native-session-reset', { bestEffort: true }),
    effect('reset-chat-turn-count'),
    effect('set-streaming', { value: true }),
    effect('clear-stream-replay'),
    effect('reset-transport-error'),
    effect('mark-retry-planned'),
    effect('spawn-fresh-retry', { attempt: retry.attempt, cap: retry.cap }),
  ]);
}

// First stage: decide whether the runner must continue/retry, and describe the
// durability boundary needed by a real finalization. No host state is mutated.
function planTurnFinalization(input = {}, deps = {}) {
  const runnerKind = normalizeRunnerKind(input.runnerKind);
  const cli = String(input.cli || (runnerKind === 'stream' ? 'claude' : 'codex')).toLowerCase();
  const killReason = input.killReason == null ? '' : String(input.killReason);
  const pendingStreamError = hasValue(input.pendingStreamError);
  const hasOutput = input.hasOutput === true;
  const recoveredTransport = input.recoveredTransport === true || (pendingStreamError && hasOutput);
  const facts = {
    runnerKind,
    cli,
    current: input.current === true,
    killReason,
    apiError: input.apiError === true,
    adapterError: input.adapterError === true && !recoveredTransport,
    retryPlanned: input.retryPlanned === true,
    resultEvent: input.resultEvent === true,
    resultDurable: input.resultDurable === true,
    hasOutput,
    sameDurablePartial: input.sameDurablePartial === true,
    isRetry: input.isRetry === true,
    recoveredTransport,
    pendingStreamError,
    nativeSession: input.nativeSession === true,
    auxUnhealthy: input.auxUnhealthy === true,
    signal: input.signal == null ? '' : String(input.signal),
    code: input.code == null ? 0 : Number(input.code),
  };
  // Some adapters surface a close-time error on the mutable host state before
  // an event can be attached to the runner. It must block native-session retry
  // and reused-target fallback without being promoted to a runner-owned error
  // for classification/post-turn semantics.
  facts.retryBlockedByAdapterError = input.retryBlockedByAdapterError === true || facts.adapterError;

  if (!facts.current) {
    return freezePlan({ action: 'noop', code: 'stale_runner', facts, effects: Object.freeze([]) });
  }

  facts.exitKind = runnerKind === 'process' ? classifyProcessExit({
    signal: facts.signal,
    code: facts.code,
    killReason,
    resultDurable: facts.resultDurable,
    hasOutput,
    recoveredTransport,
  }) : 'stream_end';
  const handoff = normalizeHandoff(input);
  const guardedHandoffResumeFailure = isGuardedHandoffFailure(facts, handoff);
  facts.guardedHandoffResumeFailure = guardedHandoffResumeFailure;

  if (runnerKind === 'process' && cli === 'codex' && pendingStreamError) {
    const retry = decideRetry({
      event: 'codex-stream-disconnect',
      cli,
      hasOutput,
      resultSaved: facts.resultDurable,
      killReason,
      hasNativeSession: facts.nativeSession,
      attempts: { codexDisconnect: Number(input.codexDisconnectAttempt || 0) },
    }, deps.retry || {});
    if (retry.action === 'resume') {
      return freezePlan({
        action: 'continue-codex', code: null, facts, retry,
        effects: retryEffects('continue-codex', retry, facts),
      });
    }
  }

  if (runnerKind === 'process' && !guardedHandoffResumeFailure && !facts.hasOutput
      && !facts.killReason && !facts.retryBlockedByAdapterError && !facts.isRetry) {
    const retry = decideRetry({
      event: 'empty-exit', cli, isRetry: facts.isRetry,
      adapterError: facts.retryBlockedByAdapterError, killReason,
      guardedHandoff: false,
      attempts: { freshStart: Number(input.freshStartAttempt || 0) },
    }, deps.retry || {});
    if (retry.action === 'retry-fresh') {
      return freezePlan({
        action: 'retry-fresh', code: null, facts, retry,
        effects: retryEffects('retry-fresh', retry, facts),
      });
    }
  }

  const finality = decideRunnerFinality({
    kind: runnerKind,
    resultEvent: facts.resultEvent,
    killReason: facts.killReason || null,
    retryPlanned: facts.retryPlanned,
  }, {
    killReason: facts.killReason || null,
    retryPlanned: facts.retryPlanned,
    apiError: facts.apiError,
    // The persistent Claude finalizer historically treats adapter failures as
    // stream interruption evidence, not as a separate finality veto. Process
    // runners do veto finality on adapter errors.
    adapterError: runnerKind === 'process' ? facts.adapterError : false,
    normalExit: facts.exitKind === 'normal',
    isRetry: facts.isRetry,
  });
  const appendRequired = !facts.resultDurable && facts.hasOutput
    && (facts.resultEvent || !facts.sameDurablePartial);
  const append = {
    required: appendRequired,
    boundary: 'close',
    final: appendRequired && finality.final === true,
    partial: appendRequired && finality.final !== true,
    checkpointRequired: appendRequired && finality.final !== true,
    requiredForPostTurn: true,
    finalityCode: finality.code || null,
  };

  return freezePlan({
    action: 'finalize',
    code: null,
    facts,
    append,
    effects: Object.freeze([]),
  });
}

function statusEffects(plan, durableAfterAppend) {
  const facts = plan.facts;
  if (facts.runnerKind === 'process') {
    if (facts.killReason) return [effect('set-status', { status: 'idle', reason: 'explicit-kill' })];
    if (durableAfterAppend || facts.apiError || facts.adapterError
        || facts.exitKind === 'nonzero_exit' || facts.exitKind === 'signaled') {
      const effects = [effect('classify-turn-end')];
      if (facts.auxUnhealthy) effects.push(effect('set-status', { status: 'idle', reason: 'aux-unhealthy' }));
      return effects;
    }
    return [effect('set-status', { status: 'idle', reason: facts.exitKind })];
  }

  if (facts.guardedHandoffResumeFailure) {
    return [
      effect('reset-interrupted-resume'),
      effect('set-status', { status: 'idle', reason: 'handoff-resume-failed' }),
      effect('report-handoff-resume-failure', { preserveHandoff: true }),
    ];
  }
  if (facts.apiError) return [effect('classify-turn-end', { classification: 'api-error' })];
  if (durableAfterAppend) {
    return [
      effect('reset-interrupted-resume'),
      effect('classify-turn-end', { classification: 'completed' }),
      effect('emit-turn-outcome', { status: 'completed', notifyState: 'completed' }),
    ];
  }
  if (facts.resultEvent) {
    return [
      effect('set-status', { status: 'idle', reason: 'result-not-durable' }),
      effect('report-result-persistence-failure'),
    ];
  }
  if (!facts.killReason) {
    return [effect('try-resume-interrupted', { fallbackStatus: 'idle', capped: true, waitGuarded: true })];
  }
  return [effect('set-status', { status: 'idle', reason: 'explicit-kill' })];
}

// Second stage: appendFinal has returned, so the host can resolve status and
// post-turn guards without inventing a durability proof. Effects are ordered in
// the same sequence as today's process and persistent-stream finalizers.
function resolveTurnFinalization(plan, outcome = {}) {
  if (!plan || plan.action !== 'finalize') {
    return freezePlan({
      action: plan && plan.action ? plan.action : 'noop',
      code: plan && plan.code ? plan.code : 'finalize_plan_required',
      facts: plan && plan.facts ? plan.facts : {},
      effects: plan && plan.effects ? plan.effects : Object.freeze([]),
    });
  }
  const facts = plan.facts;
  const durableAfterAppend = outcome.resultDurable === true || facts.resultDurable;
  const appendPersisted = outcome.appendPersisted === true;
  const effects = [];

  effects.push(effect('set-streaming', { value: false }));
  if (facts.runnerKind === 'stream') effects.push(effect('cancel-classify'));
  effects.push(effect('clear-stream-replay'));

  if (facts.runnerKind === 'process' && facts.isRetry && !facts.hasOutput) {
    effects.push(effect('report-empty-retry-failure'));
  }
  if (facts.runnerKind === 'process' && facts.guardedHandoffResumeFailure) {
    effects.push(effect('report-handoff-resume-failure', { preserveHandoff: true }));
  }
  if (facts.runnerKind === 'process') {
    effects.push(effect('clear-active-process'));
    effects.push(effect('clear-incremental-save'));
  }

  if (plan.append.required) {
    effects.push(effect('append-assistant-result', {
      boundary: plan.append.boundary,
      final: plan.append.final,
      partial: plan.append.partial,
      checkpointRequired: plan.append.checkpointRequired,
    }));
    effects.push(effect('commit-usage', { when: 'result-durable-after-append', exactlyOnce: true }));
    effects.push(effect('increment-chat-turn-count', { when: 'append-persisted' }));
  }

  if (facts.runnerKind === 'stream') effects.push(effect('clear-incremental-save'));
  if (facts.runnerKind === 'process' && facts.resultEvent && !durableAfterAppend) {
    effects.push(effect('report-result-persistence-failure'));
  }
  if (facts.runnerKind === 'process' && facts.recoveredTransport && durableAfterAppend) {
    effects.push(effect('emit-synthetic-result'));
  }

  effects.push(effect('capture-final-text'));
  effects.push(effect('reset-turn-output', {
    clearAdapterError: facts.runnerKind === 'process',
    clearTransportState: facts.runnerKind === 'process',
  }));
  effects.push(...statusEffects(plan, durableAfterAppend));
  effects.push(effect('stream-end'));

  const interrupted = facts.runnerKind === 'stream'
    ? !durableAfterAppend || !!facts.killReason
    : !!facts.killReason || facts.adapterError
      || (!facts.resultEvent && facts.exitKind !== 'normal');
  effects.push(effect('run-post-turn', {
    guard: 'current-runner-and-durable-final-result',
    interrupted,
    apiError: facts.apiError,
    retryPlanned: facts.retryPlanned,
    handoffResumeFailure: facts.guardedHandoffResumeFailure,
  }));

  return freezePlan({
    action: 'finalize',
    code: durableAfterAppend ? null : facts.resultEvent ? 'result_not_durable' : null,
    facts,
    append: plan.append,
    result: Object.freeze({ durableAfterAppend, appendPersisted }),
    effects: Object.freeze(effects),
  });
}

module.exports = {
  classifyProcessExit,
  isGuardedHandoffFailure,
  planTurnFinalization,
  resolveTurnFinalization,
};
