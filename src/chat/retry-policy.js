'use strict';

const { decideApiErrorPolicy } = require('./api-error-policy');
const { getNative } = require('../native/runtime');

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
  // Rust decides the branch and cap. Host-injected clocks, randomness and the
  // API error classifier remain here until the turn lifecycle moves to Rust.
  const plan = getNative().retryPolicyValue({
    event, cli,
    attempts: { freshStart: attempts.freshStart, codexDisconnect: attempts.codexDisconnect,
      interruptedResume: attempts.interruptedResume },
    limits: { freshStart: limits.freshStart, codexDisconnect: limits.codexDisconnect,
      interruptedResume: limits.interruptedResume },
    killReason: !!input.killReason, userStopped: input.userStopped === true, hasExplicitWait: input.hasExplicitWait === true,
    hasOutput: !!input.hasOutput, resultSaved: !!input.resultSaved, hasNativeSession: !!input.hasNativeSession,
    adapterError: !!input.adapterError, guardedHandoff: !!input.guardedHandoff, isRetry: input.isRetry === true,
  });
  if (!plan.delayKey) return Object.freeze(plan);
  return schedule(plan.action, plan.classification, plan.attempt, delays[plan.delayKey], deps, { cap: plan.cap });
}

module.exports = { DEFAULT_LIMITS, DEFAULT_DELAYS, decideRetry };
