'use strict';

// Native bridge for unattended mode. Every rule (caps, verdict prompt, tolerant
// JSON parsing, stall/aux-failure policy, wall-clock deadline math, the
// rejected-delivery retry decision) lives in native/core/src/unattended.rs;
// this file only marshals JSON across napi.
// There is deliberately no JavaScript fallback — a missing addon must fail loudly
// the same way classify vocab does.

const { getNative } = require('../native/runtime');

// Mirrors MAX_DURATION_* in the Rust kernel; pinned by the route contract test.
// The old round budget is gone: supervision is bounded by wall clock only.
const LIMITS = Object.freeze({
  maxDurationMinutesDefault: 120,
  maxDurationMinutesMin: 5,
  maxDurationMinutesMax: 1440,
});

let cached = null;
function native() {
  if (!cached) cached = getNative();
  return cached;
}

function normalizeConfig(input) {
  return JSON.parse(native().unattendedNormalizeConfig(JSON.stringify(input || {})));
}

// Pure wall-clock math (native/core/src/unattended.rs).
function clampDuration(input) {
  return JSON.parse(native().unattendedClampDuration(JSON.stringify(input || {})));
}

function armDeadline(input) {
  return JSON.parse(native().unattendedArmDeadline(JSON.stringify(input || {})));
}

function deadlineExpired(input) {
  return JSON.parse(native().unattendedDeadlineExpired(JSON.stringify(input || {})));
}

function buildVerdictPrompt(input) {
  const out = JSON.parse(native().unattendedVerdictPrompt(JSON.stringify(input || {})));
  return out.prompt;
}

function parseVerdict(text) {
  return JSON.parse(native().unattendedParseVerdict(String(text == null ? '' : text)));
}

// Whether a rejected delivery keeps its outbox retry budget (`retryable`) —
// an active supervisor plus a fresh pre-handoff probe hands the retry to it.
// The rule (and its freshness window) lives in native/core/src/unattended.rs
// (`delivery_retry_decision`); the host only gathers the probe and the
// unattended status.
function deliveryRetryDecision(input) {
  return JSON.parse(native().unattendedDeliveryRetryDecision(JSON.stringify(input || {})));
}

function decide(input) {
  return JSON.parse(native().unattendedDecide(JSON.stringify(input || {})));
}

// Whether a persisted state may be ended/cleared. The rule lives in
// native/core/src/unattended.rs (`decide_clear`); the host only applies it.
function decideClear(input) {
  return JSON.parse(native().unattendedDecideClear(JSON.stringify(input || {})));
}

// The one marker every supervisor message carries. The literal lives in Rust so
// host glue, classify and both UIs can never drift from each other.
function tag() {
  return native().unattendedTag();
}

// The fixed fault-recovery instruction (without the marker prefix). The same
// literal drives the injected message and the scheduler's recovery detection.
function faultInstruction() {
  return native().unattendedFaultInstruction();
}

// The one decision for every turn end (`evaluate | fault_continue |
// needs_human | pause | none`). The fault policy is shared inside Rust
// (`decide_fault`), so there is deliberately no second JS entry for it.
function decideTurnEnd(input) {
  return JSON.parse(native().unattendedDecideTurnEnd(JSON.stringify(input || {})));
}

function selectQueued(input) {
  return JSON.parse(native().unattendedSelectQueued(JSON.stringify(input || {})));
}

function deferEvaluation(input) {
  return JSON.parse(native().unattendedDeferEvaluation(JSON.stringify(input || {})));
}

module.exports = {
  LIMITS,
  armDeadline,
  buildVerdictPrompt,
  clampDuration,
  deadlineExpired,
  decide,
  decideClear,
  decideTurnEnd,
  deferEvaluation,
  deliveryRetryDecision,
  faultInstruction,
  normalizeConfig,
  parseVerdict,
  selectQueued,
  tag,
  // Convenience for callers that only need the literal.
  get TAG() { return tag(); },
};
