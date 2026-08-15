'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  classifyProcessExit,
  planTurnFinalization,
  resolveTurnFinalization,
} = require('../src/chat/finalize-plan');

function base(overrides = {}) {
  return {
    current: true,
    runnerKind: 'process',
    cli: 'codex',
    code: 0,
    signal: null,
    hasOutput: true,
    resultEvent: true,
    resultDurable: false,
    ...overrides,
  };
}

function types(resolved) {
  return resolved.effects.map(effect => effect.type);
}

test('process exit classification preserves kill, signal, recovery and empty distinctions', () => {
  assert.equal(classifyProcessExit({ signal: 'SIGTERM', killReason: 'user_cancel' }), 'killed');
  assert.equal(classifyProcessExit({ signal: 'SIGTERM' }), 'signaled');
  assert.equal(classifyProcessExit({ code: 1, hasOutput: true }), 'nonzero_exit');
  assert.equal(classifyProcessExit({ code: 1, hasOutput: true, recoveredTransport: true }), 'normal');
  assert.equal(classifyProcessExit({ code: 0, hasOutput: false, resultDurable: false }), 'empty_exit');
  assert.equal(classifyProcessExit({ code: 0, hasOutput: false, resultDurable: true }), 'normal');
});

test('stale runner is a deterministic no-op with no cleanup or post-turn effects', () => {
  const plan = planTurnFinalization(base({ current: false }));
  assert.equal(plan.action, 'noop');
  assert.equal(plan.code, 'stale_runner');
  assert.deepEqual(plan.effects, []);
});

test('Codex disconnect continues before cleanup and remains capped at two', () => {
  const first = planTurnFinalization(base({
    pendingStreamError: 'response.completed disconnected',
    nativeSession: true,
    codexDisconnectAttempt: 1,
    resultEvent: false,
  }), { retry: { now: () => 10 } });
  assert.equal(first.action, 'continue-codex');
  assert.equal(first.retry.attempt, 2);
  assert.deepEqual(types(first), [
    'mark-retry-planned', 'reset-codex-disconnect-state', 'set-streaming',
    'set-status', 'spawn-codex-continuation',
  ]);
  const capped = planTurnFinalization(base({
    pendingStreamError: 'disconnect', nativeSession: true,
    codexDisconnectAttempt: 2, resultEvent: false,
  }));
  assert.equal(capped.action, 'finalize');
  assert.equal(capped.facts.recoveredTransport, true);
});

test('process empty exit gets one fresh retry but adapter, explicit kill and retry do not', () => {
  const fresh = planTurnFinalization(base({ hasOutput: false, resultEvent: false }));
  assert.equal(fresh.action, 'retry-fresh');
  assert.deepEqual(types(fresh), [
    'reset-native-session', 'persist-native-session-reset', 'reset-chat-turn-count',
    'set-streaming', 'clear-stream-replay', 'reset-transport-error',
    'mark-retry-planned', 'spawn-fresh-retry',
  ]);
  assert.equal(planTurnFinalization(base({
    hasOutput: false, resultEvent: false, adapterError: true,
  })).action, 'finalize');
  assert.equal(planTurnFinalization(base({
    hasOutput: false, resultEvent: false, killReason: 'user_cancel',
  })).action, 'finalize');
  const exhausted = planTurnFinalization(base({
    hasOutput: false, resultEvent: false, isRetry: true,
  }));
  assert.equal(exhausted.action, 'finalize');
  assert.equal(types(resolveTurnFinalization(exhausted)).includes('report-empty-retry-failure'), true);
});

test('central API policy decision runs before legacy empty-exit retry', () => {
  const retryDecision = {
    action: 'retry',
    attempt: 1,
    delayMs: 7000,
    retryAt: 8000,
    error: { category: 'rate_limit', maxAttempts: 2 },
  };
  const plan = planTurnFinalization(base({
    hasOutput: false,
    resultEvent: false,
    apiError: true,
    apiErrorDecision: retryDecision,
  }));
  assert.equal(plan.action, 'retry-api');
  assert.equal(plan.retry, retryDecision);
  assert.deepEqual(types(plan), [
    'mark-retry-planned',
    'set-streaming',
    'set-status',
    'schedule-api-retry',
  ]);
  const failFast = planTurnFinalization(base({
    hasOutput: false,
    resultEvent: false,
    apiError: true,
    apiErrorDecision: {
      action: 'fail_fast',
      reason: 'authentication_permission_not_retryable',
      error: { category: 'authentication_permission', maxAttempts: 0 },
    },
  }));
  assert.equal(failFast.action, 'finalize');
});

test('close-time adapter state blocks retry without changing runner-owned classification facts', () => {
  const plan = planTurnFinalization(base({
    hasOutput: false,
    resultEvent: false,
    retryBlockedByAdapterError: true,
    adapterError: false,
  }));
  assert.equal(plan.action, 'finalize');
  assert.equal(plan.facts.retryBlockedByAdapterError, true);
  assert.equal(plan.facts.adapterError, false);
});

test('reused cross-CLI target fails closed and never falls through to fresh retry', () => {
  const plan = planTurnFinalization(base({
    hasOutput: false,
    resultEvent: false,
    handoff: { status: 'pending', reusedTarget: true, toCli: 'codex' },
  }));
  assert.equal(plan.action, 'finalize');
  assert.equal(plan.facts.guardedHandoffResumeFailure, true);
  const resolved = resolveTurnFinalization(plan);
  assert.equal(types(resolved).includes('spawn-fresh-retry'), false);
  assert.equal(types(resolved).includes('report-handoff-resume-failure'), true);
  assert.equal(resolved.effects.at(-1).type, 'run-post-turn');
  assert.equal(resolved.effects.at(-1).handoffResumeFailure, true);
});

test('process finality preserves result-event and clean first-attempt fallback semantics', () => {
  assert.equal(planTurnFinalization(base()).append.final, true);
  assert.equal(planTurnFinalization(base({ resultEvent: false, isRetry: false })).append.final, true);
  assert.equal(planTurnFinalization(base({ resultEvent: false, isRetry: true })).append.final, false);
  assert.equal(planTurnFinalization(base({ apiError: true })).append.final, false);
  assert.equal(planTurnFinalization(base({ adapterError: true })).append.final, false);
  assert.equal(planTurnFinalization(base({ killReason: 'shutdown' })).append.final, false);
});

test('matching durable partial suppresses a duplicate close append', () => {
  const plan = planTurnFinalization(base({ resultEvent: false, sameDurablePartial: true }));
  assert.equal(plan.append.required, false);
  assert.equal(types(resolveTurnFinalization(plan)).includes('append-assistant-result'), false);
});

test('process effects preserve durability, classification, stream_end and post-turn order', () => {
  const plan = planTurnFinalization(base());
  const resolved = resolveTurnFinalization(plan, { appendPersisted: true, resultDurable: true });
  const order = types(resolved);
  const at = type => order.indexOf(type);
  assert.ok(at('clear-incremental-save') < at('append-assistant-result'));
  assert.ok(at('append-assistant-result') < at('commit-usage'));
  assert.ok(at('commit-usage') < at('capture-final-text'));
  assert.ok(at('capture-final-text') < at('reset-turn-output'));
  assert.ok(at('reset-turn-output') < at('complete-session-turn'));
  assert.ok(at('complete-session-turn') < at('classify-turn-end'));
  assert.ok(at('reset-turn-output') < at('classify-turn-end'));
  assert.ok(at('classify-turn-end') < at('stream-end'));
  assert.ok(at('stream-end') < at('run-post-turn'));
  assert.equal(resolved.effects.at(-1).guard, 'current-runner-and-durable-final-result');
});

test('result persistence failure is visible and cannot satisfy post-turn durability guard', () => {
  const resolved = resolveTurnFinalization(planTurnFinalization(base()), {
    appendPersisted: false,
    resultDurable: false,
  });
  assert.equal(resolved.code, 'result_not_durable');
  assert.equal(types(resolved).includes('report-result-persistence-failure'), true);
  assert.equal(types(resolved).filter(type => type === 'report-result-persistence-failure').length, 1);
  assert.equal(resolved.effects.at(-1).guard, 'current-runner-and-durable-final-result');
});

test('recovered Codex disconnect emits a synthetic result only after durable append proof', () => {
  const plan = planTurnFinalization(base({
    pendingStreamError: 'disconnect', nativeSession: false,
  }));
  assert.equal(types(resolveTurnFinalization(plan, { resultDurable: false })).includes('emit-synthetic-result'), false);
  assert.equal(types(resolveTurnFinalization(plan, { resultDurable: true })).includes('emit-synthetic-result'), true);
});

test('stream finality requires result event and places timer cleanup after append', () => {
  const plan = planTurnFinalization(base({ runnerKind: 'stream', cli: 'claude' }));
  assert.equal(plan.append.final, true);
  const withoutResult = planTurnFinalization(base({
    runnerKind: 'stream', cli: 'claude', resultEvent: false,
  }));
  assert.equal(withoutResult.append.final, false);
  assert.equal(planTurnFinalization(base({
    runnerKind: 'stream', cli: 'claude', adapterError: true,
  })).append.final, true, 'stream adapter errors retain the existing result-event finality rule');
  const resolved = resolveTurnFinalization(plan, { appendPersisted: true, resultDurable: true });
  const order = types(resolved);
  assert.ok(order.indexOf('cancel-classify') < order.indexOf('append-assistant-result'));
  assert.ok(order.indexOf('append-assistant-result') < order.indexOf('clear-incremental-save'));
});

test('clean stream completion resets interruption, classifies, emits outcome then stream_end', () => {
  const resolved = resolveTurnFinalization(planTurnFinalization(base({
    runnerKind: 'stream', cli: 'claude', resultDurable: true,
  })), { resultDurable: true });
  const order = types(resolved);
  assert.ok(order.indexOf('reset-interrupted-resume') < order.indexOf('classify-turn-end'));
  assert.ok(order.indexOf('reset-interrupted-resume') < order.indexOf('complete-session-turn'));
  assert.ok(order.indexOf('complete-session-turn') < order.indexOf('classify-turn-end'));
  assert.ok(order.indexOf('classify-turn-end') < order.indexOf('emit-turn-outcome'));
  assert.ok(order.indexOf('emit-turn-outcome') < order.indexOf('stream-end'));
  assert.ok(order.indexOf('stream-end') < order.indexOf('run-post-turn'));
  assert.equal(resolved.effects.at(-1).interrupted, false);
});

test('API stream classification wins; explicit kills never auto-resume', () => {
  const api = resolveTurnFinalization(planTurnFinalization(base({
    runnerKind: 'stream', cli: 'claude', resultEvent: false,
    resultDurable: false, apiError: true,
  })));
  assert.equal(types(api).includes('try-resume-interrupted'), false);
  assert.equal(api.effects.find(entry => entry.type === 'classify-turn-end').classification,
    'api-error', 'the boundary names the outcome so classify need not infer it');
  assert.deepEqual(api.effects.find(entry => entry.type === 'freeze-interrupted'),
    { type: 'freeze-interrupted', reason: 'error' });

  const killed = resolveTurnFinalization(planTurnFinalization(base({
    runnerKind: 'stream', cli: 'claude', resultEvent: false,
    resultDurable: false, killReason: 'session_delete',
  })));
  assert.equal(types(killed).includes('try-resume-interrupted'), false);
  assert.equal(killed.effects.find(e => e.type === 'set-status').reason, 'explicit-kill');
});

test('process API, adapter and nonzero failures freeze instead of advancing FIFO', () => {
  for (const [override, classification] of [
    [{ apiError: true }, 'api-error'],
    [{ adapterError: true }, 'interrupted'],
    [{ code: 1 }, 'interrupted'],
    [{ signal: 'SIGPIPE' }, 'interrupted'],
  ]) {
    const resolved = resolveTurnFinalization(planTurnFinalization(base(override)), {
      appendPersisted: true,
      resultDurable: true,
    });
    assert.equal(types(resolved).includes('complete-session-turn'), false);
    assert.equal(resolved.effects.find(entry => entry.type === 'classify-turn-end').classification,
      classification);
    assert.deepEqual(resolved.effects.find(entry => entry.type === 'freeze-interrupted'),
      { type: 'freeze-interrupted', reason: 'error' });
  }
});

test('clean process completion names the structured succeeded boundary', () => {
  const resolved = resolveTurnFinalization(planTurnFinalization(base()), {
    appendPersisted: true,
    resultDurable: true,
  });
  assert.equal(resolved.effects.find(entry => entry.type === 'classify-turn-end').classification,
    'succeeded');
});

test('unknown stream interruption freezes instead of automatically resuming', () => {
  const resolved = resolveTurnFinalization(planTurnFinalization(base({
    runnerKind: 'stream', cli: 'claude', resultEvent: false,
    resultDurable: false, hasOutput: false,
  })));
  assert.equal(types(resolved).includes('try-resume-interrupted'), false);
  assert.deepEqual(
    resolved.effects.find(entry => entry.type === 'freeze-interrupted'),
    { type: 'freeze-interrupted', reason: 'unknown_interruption' },
  );
  assert.equal(resolved.effects.at(-1).interrupted, true);
});

test('stream handoff resume failure preserves target and suppresses unknown interruption recovery', () => {
  const plan = planTurnFinalization(base({
    runnerKind: 'stream', cli: 'claude', resultEvent: false,
    resultDurable: false, hasOutput: false,
    handoff: { status: 'pending', reusedTarget: true, toCli: 'claude' },
  }));
  const resolved = resolveTurnFinalization(plan);
  assert.equal(plan.facts.guardedHandoffResumeFailure, true);
  assert.equal(types(resolved).includes('try-resume-interrupted'), false);
  assert.equal(types(resolved).includes('report-handoff-resume-failure'), true);
  assert.equal(resolved.effects.at(-1).handoffResumeFailure, true);
});

test('finalize planner remains pure and exported from chat index', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'finalize-plan.js'), 'utf8');
  assert.equal(/require\(['"](?:fs|child_process|express|ws)['"]\)/.test(source), false);
  const chat = require('../src/chat');
  assert.equal(chat.planTurnFinalization, planTurnFinalization);
  assert.equal(chat.resolveTurnFinalization, resolveTurnFinalization);
});
