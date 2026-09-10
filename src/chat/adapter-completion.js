'use strict';

const { completion, isCompleted } = require('../cli-adapters/completion');

function settleAdapterCompletion(runner, boundary, logger) {
  const outcome = runner.completion?.finish(boundary)
    || completion('unknown', 'completion_tracker_missing', 'host');
  runner.completionOutcome = outcome;
  logger?.info?.('chat_adapter_completion', { turnId: runner.turnId, runnerId: runner.runnerId,
    sessionId: runner.providerAttempt?.sessionId, routeAttemptId: runner.providerAttempt?.routeAttemptId,
    boundary: boundary.kind, completion: outcome });
  return outcome;
}

// Rejection of send and an exception in finalization are separate failures.
// A finalizer exception must never execute finalization a second time.
function finalizeCompletionStream(promise, { runner, finalize, onRejected, onFinalizeError, logger }) {
  return promise.then(() => {
    settleAdapterCompletion(runner, { kind: 'stream', resolved: true, killReason: runner.killReason }, logger);
    return finalize();
  }, error => {
    settleAdapterCompletion(runner, { kind: 'stream', rejected: true, killReason: runner.killReason }, logger);
    try { onRejected(error); } finally { return finalize(); }
  }).catch(error => {
    runner.completionOutcome = Object.freeze({ ...completion('failed', 'finalization_failed', 'host'), settled: true });
    return onFinalizeError(error);
  });
}

// Transport failure recorded at the proxy boundary that can coexist with a
// genuinely completed turn. Shared by the persist gate below and by
// provider-attempt-runtime's close-time proxyFailure() reconciliation, so both
// adjudicators forgive exactly the same evidence.
//   - httpStatus != null (4xx/5xx): real upstream error, never forgivable.
//   - downstream_disconnect: the client hung up after consuming the terminal
//     frame but before HTTP EOF — benign by construction.
//   - anything else (upstream_failure, unknown): forgivable only when the
//     runtime marked the stain `recovered` (a later inference request on the
//     same attempt ended cleanly) AND the turn completion is protocol-attested.
//     Host-guessed completions (exit_fallback) never forgive transport
//     evidence — exit 0 plus output cannot prove the model finished.
function isProxyFailureCompatibleWithCompletion(proxyFailure, outcome) {
  if (!proxyFailure || proxyFailure.httpStatus != null) return false;
  const termination = proxyFailure.proxyOutcome?.termination;
  if (termination === 'downstream_disconnect') return true;
  return proxyFailure.recovered === true
    && (outcome?.source === 'protocol' || outcome?.source === 'protocol_and_exit');
}

// This is a turn-level success candidate, never a proxy-level HTTP success.
// Known upstream errors and error envelopes still veto the history commit.
function canPersistAdapterCompletion(outcome, proxyFailure, errorEnvelope) {
  return isCompleted(outcome) && !errorEnvelope
    && (!proxyFailure || isProxyFailureCompatibleWithCompletion(proxyFailure, outcome));
}

module.exports = { settleAdapterCompletion, canPersistAdapterCompletion, finalizeCompletionStream, isProxyFailureCompatibleWithCompletion };
