'use strict';

// Native bridge for unattended mode. Every rule (caps, verdict prompt, tolerant
// JSON parsing, stall/aux-failure policy, wall-clock deadline math) lives in
// native/core/src/unattended.rs; this file only marshals JSON across napi.
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

function decide(input) {
  return JSON.parse(native().unattendedDecide(JSON.stringify(input || {})));
}

// The one marker every supervisor message carries. The literal lives in Rust so
// host glue, classify and both UIs can never drift from each other.
function tag() {
  return native().unattendedTag();
}

// Immediate fault-E continuation (`{nextState, action, message, faults}`).
function decideFault(input) {
  return JSON.parse(native().unattendedDecideFault(JSON.stringify(input || {})));
}

module.exports = {
  LIMITS,
  armDeadline,
  buildVerdictPrompt,
  clampDuration,
  deadlineExpired,
  decide,
  decideFault,
  normalizeConfig,
  parseVerdict,
  tag,
  // Convenience for callers that only need the literal.
  get TAG() { return tag(); },
};
