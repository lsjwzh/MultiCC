'use strict';

// Turn state is a projection of structured runtime facts. Aux is deliberately
// absent from this module: naming/grouping may degrade when the model is down,
// but the scheduler must still receive one deterministic P/D/W/B/E verdict.

const ABNORMAL_BOUNDARIES = new Set([
  'api-error',
  'interrupted',
  'unknown-interruption',
  'result-not-durable',
  'handoff-resume-failed',
]);

function resolveTurnState(input = {}) {
  const liveness = input.liveness && typeof input.liveness === 'object'
    ? input.liveness : { state: 'unknown', reason: 'liveness_unavailable' };
  const boundary = String(input.boundary || 'unknown-interruption');

  // A live owned runner is always processing. Close-time candidates are held
  // until ownership is inactive, preventing a stale finalizer from ending a
  // replacement/retry turn.
  if (liveness.state === 'active') {
    return { state: 'P', evidence: liveness.reason || 'owned_runner_active' };
  }
  if (liveness.state === 'unknown') {
    return { state: 'P', evidence: liveness.reason || 'liveness_unknown' };
  }

  // Explicit tool evidence beats a clean process close: the turn ended, but it
  // ended by handing control to the user.
  if (input.pendingUserInput === true) {
    return { state: 'W', evidence: 'request_user_input' };
  }
  if (input.backgroundPending === true || boundary === 'background-pending') {
    return { state: 'B', evidence: 'background_pending' };
  }
  if (boundary === 'completed') {
    return {
      state: 'D',
      evidence: input.sessionType === 'gateway'
        ? 'gateway_turn_completed' : 'turn_completed',
    };
  }
  if (ABNORMAL_BOUNDARIES.has(boundary)) {
    return {
      state: 'E',
      evidence: boundary === 'api-error'
        ? 'api_error_policy' : boundary.replace(/-/g, '_'),
    };
  }

  // Unknown boundary values are abnormal, never success. This makes adding a
  // new adapter event fail closed until it is explicitly mapped above.
  return { state: 'E', evidence: 'unknown_turn_boundary' };
}

module.exports = { resolveTurnState, ABNORMAL_BOUNDARIES };
