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

// 当前运行器的协议成功 + 正常收尾证明流程已恢复。物理请求的历史错误只作诊断，
// 不再要求另一个 HTTP 成功回调，也不按错误码决定能否恢复。保存和收尾共用此规则。
// 紧急修复限于现有 Node 协议桥；待运行器/回合所有权迁入 Rust 时一起迁移此判断，
// 避免现在增加第二套跨语言收尾状态机。
function isProxyFailureCompatibleWithCompletion(proxyFailure, outcome) {
  if (!proxyFailure || !isCompleted(outcome)) return false;
  if (outcome.source === 'protocol' || outcome.source === 'protocol_and_exit') return true;
  // 无原生完成协议的旧适配器仍只允许已知的正常收尾断连；仅有输出/退出码不证明恢复。
  return proxyFailure.httpStatus == null
    && proxyFailure.proxyOutcome?.termination === 'downstream_disconnect';
}

// This is a turn-level success candidate, never a proxy-level HTTP success.
// 最终错误回复仍表示流程失败；历史请求错误交给整轮完成证据协调。
function canPersistAdapterCompletion(outcome, proxyFailure, errorEnvelope) {
  return isCompleted(outcome) && !errorEnvelope
    && (!proxyFailure || isProxyFailureCompatibleWithCompletion(proxyFailure, outcome));
}

module.exports = { settleAdapterCompletion, canPersistAdapterCompletion, finalizeCompletionStream, isProxyFailureCompatibleWithCompletion };
