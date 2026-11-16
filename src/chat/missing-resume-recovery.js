'use strict';

// Missing native resume target: the single decision point for BOTH chat lanes.
//
// No Node fallback: this kernel is Rust-only. Every rule lives in
// `native/core/src/missing_resume_recovery.rs`: what counts as the CLI's
// "No conversation found with session ID" answer, whether a replay is safe
// (nothing forwarded yet), how many rotations one user message may buy, and how
// a transcript probe maps to first turn vs resume. This file only transports
// values and re-throws the structured error.
//
// Why both lanes share it: the resident legacy stream (`chat-stream.js`) still
// backs qoder/codebuddy, whose adapters also spawn with `--resume` and speak the
// same stream-json envelope, while Claude's chat lane runs the Agent SDK
// (`claude-sdk-stream.js`). Both receive the identical upstream answer, so both
// must reach the identical decision; keeping the regex and the gate arithmetic
// in JS is exactly how the SDK lane drifted into a permanent "No conversation
// found" loop with no recovery at all.

const { getNative } = require('../native/runtime');

const native = getNative();
const CATALOG = Object.freeze(JSON.parse(native.missingResumeRecoveryCatalog()));

// Constant tables snapshotted from the kernel instead of hardcoded here: op
// names, actions, evidence values and every skip reason. The kernel decides
// which one a case receives; these only name the values callers compare against.
const OPS = Object.freeze(CATALOG.ops);
const ACTIONS = Object.freeze(CATALOG.actions);
const EVIDENCE = Object.freeze(CATALOG.evidence);
const REASONS = Object.freeze(CATALOG.reasons);

class MissingResumeRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MissingResumeRecoveryError';
    this.code = code;
  }
}

function call(op, payload) {
  // Direct value transport, like turn-request.js: a JSON round trip would fold
  // `undefined` (absent evidence) into null and change what the kernel reads.
  const out = native.missingResumeRecoveryRequestValue(op, payload);
  if (!out.ok) throw new MissingResumeRecoveryError(out.error.code, out.error.message);
  return out.value;
}

// Does this stream event say "the --resume target is gone"? The kernel owns the
// shape: a `result` with is_error, carrying the notice in errors[], error,
// error.message or result.
function classifyMissingResumeResult(event) {
  return call('classifyResult', { event });
}

// The whole replay gate: not-missing, never-resumed, events-already-forwarded
// and attempt-exhausted skip; otherwise `rotate` plus the replacement v4 UUID.
// `forwardedEventCount` is the caller's own forwarded-event tally: the zero case
// is the only one in which re-running the message cannot duplicate output or
// tool side effects.
function decideMissingResume({ event, lastSpawnWasResume, forwardedEventCount = 0, attempt = 0 } = {}) {
  return call('decide', {
    event,
    lastSpawnWasResume: lastSpawnWasResume === true,
    forwardedEventCount,
    attempt,
  });
}

// Fail-closed transcript probe: only a proven ENOENT is `proven_absent`; every
// I/O or permission error reads as `present`, so a probe can never turn an
// established resume into a silently new conversation.
function probeTranscript({ sessionId, configDir } = {}) {
  return call('probeTranscript', { sessionId, configDir });
}

// Intake plan for one turn: first turn vs resume, plus whether the probe already
// proved the resume target gone (`recoverBeforeSpawn`). The probe may only make
// recovery EARLIER; it never flips `isFirstTurn`.
function resumePlan({ cli, turnCount, hasNativeSession, sessionId, configDir } = {}) {
  return call('resumePlan', {
    cli,
    turnCount,
    hasNativeSession: hasNativeSession === true,
    sessionId,
    configDir,
  });
}

module.exports = {
  CATALOG,
  OPS,
  ACTIONS,
  EVIDENCE,
  REASONS,
  MissingResumeRecoveryError,
  classifyMissingResumeResult,
  decideMissingResume,
  probeTranscript,
  resumePlan,
};
