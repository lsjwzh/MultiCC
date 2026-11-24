'use strict';

const { isProxyStallCode } = require('../providers/proxy-stall-watch');

// 只接受当前主请求的宿主超时证据。关闭 runner 后复用错误收尾，不能标记为用户取消。
function recoverModelTimeout({ event, outcome, chatSessions, chatStream, setTimeout: schedule = setTimeout }) {
  const failure = outcome?.failure;
  if (!outcome?.accepted || !failure || (!isProxyStallCode(failure.code) && !failure.retryBudgetExhausted)) return false;
  const cs = chatSessions.get(event.sessionId);
  const runner = cs?._activeRunner;
  const attempt = runner?.providerAttempt;
  if (!attempt || runner.killReason || runner.modelTimeoutStopping
      || cs._activeTurn?.turnId !== event.turnId
      || !['runtimeEpoch', 'turnId', 'routeAttemptId', 'routeGeneration', 'decisionId', 'attemptNo', 'providerRevision']
        .every(key => attempt[key] === event[key])) return false;
  runner.modelTimeoutStopping = true;
  runner.sawApiError = true;
  runner.apiErrorRaw = failure;
  if (runner.kind === 'stream') {
    chatStream.cancel(event.sessionId);
  } else {
    const proc = cs.claudeProc;
    if (!proc) return false;
    try { proc.kill('SIGTERM'); } catch (_) {}
    const timer = schedule(() => {
      if (proc.exitCode == null && proc.signalCode == null) { try { proc.kill('SIGKILL'); } catch (_) {} }
    }, 1_500);
    timer?.unref?.();
    proc.once?.('exit', () => clearTimeout(timer));
  }
  return true;
}

module.exports = { recoverModelTimeout };
