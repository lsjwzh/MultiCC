'use strict';

// Native bridge for unattended mode. Every rule (caps, verdict prompt, tolerant
// JSON parsing, budget/stall/aux-failure policy) lives in
// native/core/src/unattended.rs; this file only marshals JSON across napi.
// There is deliberately no JavaScript fallback — a missing addon must fail loudly
// the same way classify vocab does.

const { getNative } = require('../native/runtime');

// Mirrors MAX_ROUNDS_DEFAULT / MAX_ROUNDS_LIMIT in the Rust kernel; pinned by
// the route contract test.
const LIMITS = Object.freeze({ maxRoundsDefault: 30, maxRoundsMax: 200 });

let cached = null;
function native() {
  if (!cached) cached = getNative();
  return cached;
}

function normalizeConfig(input) {
  return JSON.parse(native().unattendedNormalizeConfig(JSON.stringify(input || {})));
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
  buildVerdictPrompt,
  decide,
  decideFault,
  normalizeConfig,
  parseVerdict,
  tag,
  // Convenience for callers that only need the literal.
  get TAG() { return tag(); },
};
