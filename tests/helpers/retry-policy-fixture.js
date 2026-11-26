'use strict';

// Deterministic ports and input only; both sides run their own retry policy.
function exercise(api, input) {
  const events = [];
  const attempt = input.attempt;
  const deps = { now() { events.push('clock'); return 1000; }, random() { events.push('random'); return 0.75; },
    jitterMs: 20, limits: { apiError: 2 }, delays: { freshStart: 5, codexDisconnect: 10, interruptedResume: 40, apiError: 30 } };
  const decision = api.decideRetry({ event: input.event, cli: input.cli,
    attempts: { apiError: attempt, freshStart: attempt, codexDisconnect: attempt, interruptedResume: attempt },
    hasOutput: input.event === 'codex-stream-disconnect', hasNativeSession: true,
    killReason: input.blocked ? 'shutdown' : '', userStopped: input.blocked, isRetry: input.blocked,
    error: { httpStatus: 503, source: 'claude_result', provider: 'claude', message: 'temporary fixture error' },
    context: { source: 'claude_result', provider: 'claude', phase: 'before_first_token', decisionId: 'retry-fixture' },
  }, deps);
  return { decision, events, frozen: Object.isFrozen(decision) };
}
module.exports = { exercise };
