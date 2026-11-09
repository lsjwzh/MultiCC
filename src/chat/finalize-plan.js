'use strict';

const { getNative } = require('../native/runtime');

// The plan, its nested containers and every effect are frozen exactly like the
// former in-process planner, so consumers can keep relying on immutability.
function freezeEffects(effects) {
  for (const effect of effects) Object.freeze(effect);
  return Object.freeze(effects);
}

function freezePlan(plan) {
  if (plan.append) Object.freeze(plan.append);
  if (plan.facts) Object.freeze(plan.facts);
  if (plan.retry) Object.freeze(plan.retry);
  if (plan.result) Object.freeze(plan.result);
  if (plan.effects) freezeEffects(plan.effects);
  return Object.freeze(plan);
}

// The clock is a host port: Rust samples it only when a retry is scheduled.
function retryClock(deps) {
  const retry = deps && deps.retry;
  return retry && typeof retry.now === 'function' ? retry.now : Date.now;
}

function classifyProcessExit(input = {}) {
  return getNative().chatClassifyProcessExit(input);
}

function normalizeHandoff(input = {}) {
  return Object.freeze(getNative().chatNormalizeHandoff(input));
}

function isGuardedHandoffFailure(facts, handoff) {
  return getNative().chatIsGuardedHandoffFailure(facts, handoff);
}

function planTurnFinalization(input = {}, deps = {}) {
  return freezePlan(getNative().chatPlanTurnFinalization(input, deps, retryClock(deps)));
}

function planRetryBlockedFinalization(sourcePlan, overrides = {}) {
  return freezePlan(getNative().chatPlanRetryBlockedFinalization(sourcePlan, overrides));
}

function resolveTurnFinalization(plan, outcome = {}) {
  return freezePlan(getNative().chatResolveTurnFinalization(plan, outcome));
}

module.exports = {
  classifyProcessExit,
  isGuardedHandoffFailure,
  normalizeHandoff,
  planTurnFinalization,
  planRetryBlockedFinalization,
  resolveTurnFinalization,
};
