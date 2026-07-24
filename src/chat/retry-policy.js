'use strict';

const { decideApiErrorPolicy } = require('./api-error-policy');

const DEFAULT_LIMITS = Object.freeze({
  freshStart: 1,
  codexDisconnect: 2,
  interruptedResume: 10,
});
const DEFAULT_DELAYS = Object.freeze({
  freshStart: 0,
  codexDisconnect: 0,
  interruptedResume: 0,
  apiError: 0,
});

function count(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function schedule(action, classification, attempt, baseDelay, deps, extra = {}) {
  const now = typeof deps.now === 'function' ? Number(deps.now()) : Date.now();
  const random = typeof deps.random === 'function' ? deps.random : Math.random;
  const jitterMs = Math.max(0, Number(deps.jitterMs || 0));
  const sampled = jitterMs ? Number(random()) : 0;
  const unit = Number.isFinite(sampled) ? Math.max(0, Math.min(0.999999, sampled)) : 0;
  const jitter = jitterMs ? Math.floor(unit * jitterMs) : 0;
  const delayMs = Math.max(0, Number(baseDelay || 0)) + jitter;
  return Object.freeze({
    action,
    classification,
    attempt,
    delayMs,
    scheduledAt: now + delayMs,
    ...extra,
  });
}

function terminal(classification, reason, extra = {}) {
  return Object.freeze({ action: 'fail', classification, reason, cleanup: true, ...extra });
}

// Pure characterization of the retry branches currently split between
// runChatTurn, finalizeStreamingTurn and wait-injector.
function decideRetry(input = {}, deps = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(deps.limits || {}) };
  const delays = { ...DEFAULT_DELAYS, ...(deps.delays || {}) };
  const cli = String(input.cli || 'claude').toLowerCase();
  const event = String(input.event || 'completed');
  const attempts = input.attempts || {};

  if (event === 'provider-route-failed') {
    return terminal('provider-route', 'route-failed', { leaveRunning: false });
  }
  if (event === 'handoff-resume-failed') {
    return terminal('handoff-resume', 'fail-closed-no-fresh-retry', { preserveHandoff: true });
  }
  if (event === 'api-error') {
    const decision = decideApiErrorPolicy(input.error || {}, {
      ...(input.context || {}),
      attempt: count(attempts.apiError),
      maxAttempts: deps.limits && Object.prototype.hasOwnProperty.call(deps.limits, 'apiError')
        ? limits.apiError : undefined,
    }, deps);
    if (decision.action !== 'retry') {
      return terminal('api-error', decision.reason, { decision });
    }
    return schedule('retry-api', 'api-error', decision.attempt,
      decision.delayMs ?? delays.apiError, { ...deps, jitterMs: 0 }, {
        capped: true,
        cap: decision.error.maxAttempts,
        decision,
      });
  }
  if (event === 'interrupted') {
    if (input.killReason) return terminal('interrupted', 'explicit-lifecycle-stop');
    if (input.userStopped === true) return terminal('interrupted', 'user-stopped');
    if (input.hasExplicitWait === true) {
      return Object.freeze({ action: 'wait', classification: 'interrupted', reason: 'explicit-wait', cleanup: true });
    }
    const current = count(attempts.interruptedResume);
    if (current >= limits.interruptedResume) return terminal('interrupted', 'resume-cap-reached');
    return schedule('resume', 'interrupted', current + 1, delays.interruptedResume, deps, {
      cap: limits.interruptedResume,
    });
  }
  if (event === 'codex-stream-disconnect') {
    if (cli !== 'codex') return terminal('transport', 'codex-continuation-not-applicable');
    if (!input.hasOutput || input.resultSaved || input.killReason || !input.hasNativeSession) {
      return terminal('transport', 'continuation-preconditions-failed');
    }
    const current = count(attempts.codexDisconnect);
    if (current >= limits.codexDisconnect) return terminal('transport', 'codex-continuation-cap-reached');
    return schedule('resume', 'codex-stream-disconnect', current + 1, delays.codexDisconnect, deps, {
      cap: limits.codexDisconnect,
    });
  }
  if (event === 'empty-exit') {
    // Claude's production path is a persistent stream and uses interruption
    // recovery, while process CLIs get exactly one fresh-session fallback.
    if (cli === 'claude') return terminal('empty-exit', 'claude-stream-does-not-fresh-retry');
    if (input.adapterError) return terminal('empty-exit', 'provider-error');
    if (input.killReason) return terminal('empty-exit', 'turn-killed');
    if (input.guardedHandoff) return terminal('handoff-resume', 'fail-closed-no-fresh-retry', { preserveHandoff: true });
    const current = count(attempts.freshStart);
    if (current >= limits.freshStart || input.isRetry === true) return terminal('empty-exit', 'fresh-retry-exhausted');
    return schedule('retry-fresh', 'empty-exit', current + 1, delays.freshStart, deps, {
      cap: limits.freshStart,
    });
  }
  return Object.freeze({ action: 'finalize', classification: event, cleanup: true });
}

module.exports = { DEFAULT_LIMITS, DEFAULT_DELAYS, decideRetry };
