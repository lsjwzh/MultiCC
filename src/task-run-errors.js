'use strict';

// TaskRun failure visibility: one structural error entry per failed run.
//
// A failed run previously sealed its usage and scrubbed its slot without
// leaving any trace of *why* — the board card turned red with no reason and
// the partial transcript looked complete. The error entry is a ledger message
// (role 'system', kind 'error') with machine-readable metadata {code,
// category, retryable}; it is written once per run under the fixed message id
// `error:<runId>` so a finalizer replay can never double-write it.
//
// The retryable flag is derived from the session's structured api-error
// policy state (src/chat/api-error-policy.js categories), never from free
// text — only transient categories (rate_limit / provider_transient /
// network / timeout / unknown with evidence) may auto-retry.

const CATEGORY_LABELS = Object.freeze({
  provider_transient: '上游服务暂时异常',
  network: '网络异常',
  timeout: '调用超时',
  rate_limit: '触发服务端限流',
  authentication_permission: '凭据或权限问题',
  billing_quota: '额度或账单问题',
  context_token_limit: '上下文超出模型上限',
  invalid_request_model: '请求参数或模型配置问题',
  tool_protocol: '工具协议错误',
  adapter_configuration: 'CLI/Provider 配置错误',
  cancel_shutdown: '已取消',
  unknown: '未知错误',
});

// Mirror of the policy's RETRYABLE set: kept local so a failure description
// never trusts a caller-supplied retryable flag blindly — a category that is
// not transient can never be marked retryable here.
const RETRYABLE_CATEGORIES = new Set(['rate_limit', 'provider_transient', 'network', 'timeout', 'unknown']);

function clean(value, max = 128) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function describeRunFailure({ event = {}, apiError = null } = {}) {
  const category = clean(apiError && apiError.category, 64) || 'unknown';
  const hasEvidence = !!(apiError && apiError.category);
  const code = clean(apiError && (apiError.code || apiError.reason), 128)
    || (hasEvidence ? category : 'TURN_FAILED');
  const label = CATEGORY_LABELS[category] || CATEGORY_LABELS.unknown;
  const action = clean(apiError && apiError.userAction, 200);
  const retryable = hasEvidence
    && RETRYABLE_CATEGORIES.has(category)
    && apiError.retryable === true;
  const text = hasEvidence
    ? `任务执行失败（${label}）${action ? `：${action}` : ''}`
    : '任务执行失败：模型调用异常结束，未产出完整结果。可手动重新发起。';
  return Object.freeze({ code, category, retryable, text });
}

function errorMessageId(runId) {
  return `error:${String(runId || '').trim()}`;
}

function recordRunError(store, {
  runId,
  code,
  category,
  retryable = false,
  message,
  createdAt,
} = {}) {
  const id = String(runId || '').trim();
  if (!id) throw new TypeError('runId must be a non-empty string');
  // Idempotency guard: a replay with a different clock reading would trip the
  // store's content-hash conflict, so an existing entry always wins.
  const existing = runErrorOf(store, id);
  if (existing) {
    return { duplicate: true, messageId: errorMessageId(id) };
  }
  return store.appendMessage({
    runId: id,
    messageId: errorMessageId(id),
    role: 'system',
    kind: 'error',
    content: clean(message, 2000) || '任务执行失败',
    metadata: {
      code: clean(code, 128) || 'TURN_FAILED',
      category: clean(category, 64) || 'unknown',
      retryable: retryable === true,
    },
    createdAt: Number.isSafeInteger(Number(createdAt)) ? Number(createdAt) : Date.now(),
  });
}

function runErrorOf(store, runId) {
  const id = String(runId || '').trim();
  if (!id || !store || typeof store.getRunMessages !== 'function') return null;
  let messages;
  try {
    messages = store.getRunMessages(id);
  } catch (_) {
    return null;
  }
  const entry = (Array.isArray(messages) ? messages : [])
    .find(message => message && message.kind === 'error');
  if (!entry) return null;
  return {
    code: clean(entry.metadata && entry.metadata.code, 128) || 'TURN_FAILED',
    category: clean(entry.metadata && entry.metadata.category, 64) || 'unknown',
    retryable: entry.metadata && entry.metadata.retryable === true,
    message: typeof entry.content === 'string' ? entry.content : '',
  };
}

module.exports = {
  describeRunFailure,
  recordRunError,
  runErrorOf,
};
