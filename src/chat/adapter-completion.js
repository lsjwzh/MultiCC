'use strict';

const { completion } = require('../cli-adapters/completion');
const { getNative } = require('../native/runtime');

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

// 当前运行器的协议成功 + 正常收尾证明流程已恢复。物理请求的历史错误只作诊断，
// 不再要求另一个 HTTP 成功回调，也不按错误码决定能否恢复。保存和收尾共用此规则。
function isProxyFailureCompatibleWithCompletion(proxyFailure, outcome) {
  return getNative().cliProxyFailureCompatible(proxyFailure, outcome);
}

// This is a turn-level success candidate, never a proxy-level HTTP success.
// 最终错误回复仍表示流程失败；历史请求错误交给整轮完成证据协调。
function canPersistAdapterCompletion(outcome, proxyFailure, errorEnvelope) {
  return getNative().cliCanPersistCompletion(outcome, proxyFailure, errorEnvelope);
}

module.exports = { settleAdapterCompletion, canPersistAdapterCompletion, finalizeCompletionStream, isProxyFailureCompatibleWithCompletion };
