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

// This is a turn-level success candidate, never a proxy-level HTTP success.
// Known upstream errors and error envelopes still veto the history commit.
function canPersistAdapterCompletion(outcome, proxyFailure, errorEnvelope) {
  return isCompleted(outcome) && !errorEnvelope
    && (!proxyFailure || (proxyFailure.httpStatus == null
      && proxyFailure.proxyOutcome?.termination === 'downstream_disconnect'));
}

module.exports = { settleAdapterCompletion, canPersistAdapterCompletion, finalizeCompletionStream };
