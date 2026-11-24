'use strict';

// Event rule schema: validation, normalization and filter matching. Pure.
// A rule = which events (`on`) + optional `filter` + one `action`, optionally
// followed by a chain (`then`) of further actions the engine runs in order.
// The same shape is used for session-level triggers (type:'event') and for
// global rules; only the storage differs.
//
// The schema lives in native/core/src/events.rs. Rule bodies are JSON-origin
// (HTTP bodies, persisted rule files). This bridge keeps only what cannot
// cross FFI: the injected id/clock factories and the host's channel-target
// check. Webhook URLs are syntax-checked there (WHATWG parse); private and
// loopback targets are rejected at send time in actions.js.

const { getNative } = require('../native/runtime');

const native = getNative();
const CATALOG = JSON.parse(native.eventsCatalog());
const request = (op, input) => JSON.parse(native.eventsRequest(op, JSON.stringify(input)));

const ACTION_KINDS = Object.freeze(CATALOG.actionKinds);
const MIN_INJECT_COOLDOWN_MS = CATALOG.minInjectCooldownMs;
const MAX_CHAIN_STEPS = CATALOG.maxChainSteps; // follow-up steps after the first action

function validateWebhookUrl(raw) {
  return request('validateWebhookUrl', { raw });
}

function validateAction(raw) {
  return request('validateAction', { raw });
}

// The channel actions of a rule (main action and chain steps).
function channelActions(rule) {
  const slim = rule && typeof rule === 'object' ? { action: rule.action, then: rule.then } : null;
  return request('channelActions', { rule: slim });
}

// Save-time check of every channel action: `check(plugin, target)` answers an
// error string or null (src/plugins/channel-registry.js checkTarget).
function channelProblem(rule, check) {
  for (const action of channelActions(rule)) {
    const problem = check(action.plugin, action.target);
    if (problem) return problem;
  }
  return null;
}

// body: raw request/object. Returns { rule } or { error }. The id and the
// creation time come from the injected factories, in that order, and only
// for a rule that passed validation.
function validateEventRule(body = {}, { idFactory, nowIso, scope = 'global' } = {}) {
  const out = request('validateEventRule', { body, scope });
  if (!out.rule) return { error: out.error };
  const { rule } = out;
  if (out.needsId) rule.id = idFactory();
  if (out.needsCreatedAt) rule.createdAt = nowIso();
  return { rule };
}

// Only the fields the filter reads cross the bridge; a missing rule or event
// still fails exactly where the old property reads did.
const scalar = value => (value === null || ['string', 'number', 'boolean'].includes(typeof value) ? value
  : value === undefined ? undefined : {});

function matchesFilter(rule, event) {
  const data = event == null ? event : event.data;
  return request('matchesFilter', {
    rule: rule == null ? rule : { filter: rule.filter },
    event: event == null ? event : {
      sessionId: scalar(event.sessionId),
      dirId: scalar(event.dirId),
      data: data == null ? data : { goalState: scalar(data.goalState), cancelled: Boolean(data.cancelled) },
    },
  });
}

module.exports = { ACTION_KINDS, MIN_INJECT_COOLDOWN_MS, MAX_CHAIN_STEPS, validateEventRule, validateAction, validateWebhookUrl, matchesFilter, channelActions, channelProblem };
