'use strict';

const crypto = require('crypto');
const { redact } = require('../observability');

const CATEGORIES = Object.freeze([
  'authentication_permission',
  'billing_quota',
  'rate_limit',
  'provider_transient',
  'network',
  'timeout',
  'invalid_request_model',
  'context_token_limit',
  'tool_protocol',
  'cancel_shutdown',
  'adapter_configuration',
  'unknown',
]);
const CATEGORY_SET = new Set(CATEGORIES);
const RETRYABLE = new Set(['rate_limit', 'provider_transient', 'network', 'timeout', 'unknown']);
const TRANSIENT = new Set(['rate_limit', 'provider_transient', 'network', 'timeout']);
const TRUSTED_TEXT_SOURCES = new Set([
  'anthropic_event',
  'claude_result',
  'codex_event',
  'opencode_event',
  'qoder_result',
  'zcode_event',
  'process_stderr',
  'aux_http',
  'host_interruption',
  'classifier_legacy',
]);
const CANCELLATION_CODES = new Set([
  'aborterror', 'aborted', 'cancelled', 'canceled', 'user_cancel',
  'new_user_message', 'shutdown', 'server_shutting_down', 'session_delete',
  'cli_switch', 'relocate', 'sigterm', 'sigint',
]);
const NETWORK_CODES = new Set([
  'econnreset', 'econnrefused', 'econnaborted', 'enotfound', 'eai_again',
  'epipe', 'err_network', 'fetch_failed', 'socket_hang_up',
]);
const TIMEOUT_CODES = new Set([
  'etimedout', 'timeout', 'connect_timeout', 'read_timeout', 'overall_timeout',
  'deadline_exceeded', 'und_err_connect_timeout', 'headers_timeout',
]);
const CONTEXT_CODES = new Set([
  'context_length_exceeded', 'context_window_exceeded', 'too_many_tokens',
  'max_tokens_exceeded', 'max_output_tokens', 'length_limit',
]);
const AUTH_CODES = new Set([
  'authentication_error', 'permission_denied', 'unauthorized', 'forbidden',
  'invalid_api_key', 'invalid_authentication', 'insufficient_scope',
]);
const BILLING_CODES = new Set([
  'billing_error', 'insufficient_balance', 'insufficient_quota',
  'quota_exceeded', 'usage_limit_exceeded', 'credit_balance_exhausted',
]);
const RATE_CODES = new Set(['rate_limit_error', 'rate_limited', 'too_many_requests']);
const CONFIG_CODES = new Set([
  'provider_unavailable', 'provider_config_invalid', 'missing_provider',
  'missing_base_url', 'spawn_failed', 'cli_not_installed', 'cli_resume_mismatch',
]);
const TOOL_CODES = new Set([
  'invalid_tool_arguments', 'tool_schema_error', 'tool_protocol_error',
  'mcp_error', 'function_call_error',
]);
const MAX_SANITIZED_MESSAGE = 240;

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeCode(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s.-]+/g, '_').slice(0, 80);
}

function sourceMessage(raw) {
  if (typeof raw === 'string') return raw;
  if (!raw || typeof raw !== 'object') return '';
  const nested = raw.error && typeof raw.error === 'object' ? raw.error : {};
  return raw.message || nested.message || raw.detail || raw.reason || '';
}

function sanitizeMessage(value, fallback = 'Upstream API request failed') {
  let message = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  message = String(redact(message));
  message = message
    .replace(/(?:sk|sess|key|token|cookie|auth)[-_A-Za-z0-9.]{8,}/ig, '[REDACTED]')
    .replace(/\b[A-Fa-f0-9]{24,}\b/g, '[ID]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[ID]')
    .replace(/[A-Z]:\\[^\s]+|\/(?:Users|home|var|tmp)\/[^\s]+/g, '[PATH]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[ACCOUNT]');
  if (!message) message = fallback;
  return message.slice(0, MAX_SANITIZED_MESSAGE);
}

// Provider-owned fallback only: distinguishes a short error envelope rendered
// as assistant text from meaningful partial output. It is never applied to user
// input and never decides the category by itself.
function isErrorOnlyText(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 600) return false;
  return /^(?:api\s*error|error:|codex\s*(?:error|出错)|claude\s*(?:error|出错)|opencode\s*(?:error|出错)|qoder\s*(?:error|出错)|zcode\s*(?:error|出错)|stream disconnected|connection (?:closed|reset|refused)|request (?:failed|timed out)|rate limit|overloaded|internal server error|service unavailable|timeout|timed out)/i.test(text);
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) return value;
  }
  return null;
}

function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function parseReset(value, now = Date.now()) {
  const number = numberOrNull(value);
  if (number == null || number < 0) return null;
  const epochMs = number > 1e12 ? number : number > 1e9 ? number * 1000 : now + number * 1000;
  return Math.max(0, Math.round(epochMs - now));
}

function httpStatusOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const nested = raw.error && typeof raw.error === 'object' ? raw.error : {};
  const value = raw.httpStatus ?? raw.statusCode ?? raw.status ?? nested.httpStatus
    ?? nested.statusCode ?? nested.status;
  const number = numberOrNull(value);
  return number != null && number >= 100 && number <= 599 ? Math.round(number) : null;
}

function retryAfterOf(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  if (numberOrNull(raw.retryAfterMs) != null) return Math.max(0, Math.round(Number(raw.retryAfterMs)));
  const headers = raw.headers || (raw.error && raw.error.headers);
  const retryAfter = raw.retryAfter ?? headerValue(headers, 'retry-after');
  const direct = parseRetryAfter(retryAfter, now);
  if (direct != null) return direct;
  const reset = raw.resetAt ?? raw.rateLimitReset ?? headerValue(headers, 'x-ratelimit-reset')
    ?? headerValue(headers, 'ratelimit-reset');
  return parseReset(reset, now);
}

function structuredCategory(status, code, rawCategory) {
  if (CATEGORY_SET.has(rawCategory)) return rawCategory;
  if (CANCELLATION_CODES.has(code)) return 'cancel_shutdown';
  if (AUTH_CODES.has(code) || status === 401 || status === 403) return 'authentication_permission';
  if (BILLING_CODES.has(code) || status === 402) return 'billing_quota';
  if (RATE_CODES.has(code) || status === 429) return 'rate_limit';
  if (CONTEXT_CODES.has(code)) return 'context_token_limit';
  if (TOOL_CODES.has(code)) return 'tool_protocol';
  if (CONFIG_CODES.has(code)) return 'adapter_configuration';
  if (NETWORK_CODES.has(code)) return 'network';
  if (TIMEOUT_CODES.has(code)) return 'timeout';
  if (status != null && [500, 502, 503, 504, 529].includes(status)) return 'provider_transient';
  if (status != null && [400, 404, 409, 422].includes(status)) return 'invalid_request_model';
  return null;
}

function textFallbackCategory(message) {
  const text = String(message || '').toLowerCase();
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|authentication failed|authorization failed|invalid api key|insufficient scope/.test(text)) return 'authentication_permission';
  if (/\b402\b|insufficient (?:balance|quota)|billing|usage limit|credit balance/.test(text)) return 'billing_quota';
  if (/\b429\b|rate limit|too many requests/.test(text)) return 'rate_limit';
  if (/context (?:window|length)|too many tokens|maximum context|max(?:imum)? output tokens?|token limit/.test(text)) return 'context_token_limit';
  if (/invalid tool|tool (?:schema|arguments?|protocol)|mcp (?:error|failed)|function (?:arguments?|call) error/.test(text)) return 'tool_protocol';
  if (/cancelled by user|canceled by user|server (?:is )?shutting down|sigterm|sigint/.test(text)) return 'cancel_shutdown';
  if (/provider (?:config|configuration).*(?:missing|invalid)|missing (?:provider|base url)|cli not installed|spawn failed/.test(text)) return 'adapter_configuration';
  if (/etimedout|timed? out|timeout|deadline exceeded/.test(text)) return 'timeout';
  if (/enotfound|dns|tls|certificate|econnreset|connection reset|connection closed|connection refused|socket hang|network error|fetch failed|stream disconnected/.test(text)) return 'network';
  if (/\b(?:500|502|503|504|529)\b|overloaded|internal server error|service unavailable|bad gateway|system is busy/.test(text)) return 'provider_transient';
  if (/\b(?:400|404|409|422)\b|invalid request|validation error|unsupported model|model not found|unprocessable/.test(text)) return 'invalid_request_model';
  return 'unknown';
}

function userAction(category, retryAfterMs) {
  switch (category) {
    case 'authentication_permission': return '重新登录、更新 API 凭据或补足权限后重试';
    case 'billing_quota': return retryAfterMs != null ? '等待额度重置后重试' : '检查账单、额度或用量上限';
    case 'rate_limit': return '等待服务端限流窗口结束';
    case 'context_token_limit': return '压缩或裁剪上下文，或开启新会话';
    case 'invalid_request_model': return '修正请求参数、模型名称或 Provider 配置';
    case 'tool_protocol': return '修正工具参数或协议结构';
    case 'adapter_configuration': return '检查 CLI、Provider 和适配器配置';
    case 'cancel_shutdown': return '无需操作；如有需要可重新发起';
    case 'provider_transient':
    case 'network':
    case 'timeout': return '可等待受控重试，或稍后手动继续';
    default: return '检查错误详情后决定是否手动重试';
  }
}

function normalizeApiError(raw = {}, context = {}, deps = {}) {
  const now = typeof deps.now === 'function' ? Number(deps.now()) : Date.now();
  const source = String(context.source || raw.source || 'unknown').toLowerCase().slice(0, 40);
  const provider = String(context.provider || raw.provider || 'unknown').toLowerCase().slice(0, 40);
  const nested = raw && typeof raw === 'object' && raw.error && typeof raw.error === 'object'
    ? raw.error : {};
  const code = normalizeCode(context.code || raw.code || nested.code || raw.type || nested.type);
  const httpStatus = httpStatusOf(raw);
  const message = sourceMessage(raw);
  const explicit = structuredCategory(httpStatus, code,
    normalizeCode(context.category || raw.category || nested.category));
  const category = explicit || (TRUSTED_TEXT_SOURCES.has(source)
    ? textFallbackCategory(message) : 'unknown');
  const partialOutput = context.partialOutput === true || raw.partialOutput === true;
  const sideEffects = context.sideEffects === true || raw.sideEffects === true;
  const phase = String(context.phase || raw.phase || (partialOutput ? 'stream' : 'before_first_token'));
  const retryAfterMs = retryAfterOf(raw, now);
  const retryable = RETRYABLE.has(category);
  const replaySafePhase = phase === 'connect' || phase === 'before_first_token' || phase === 'request';
  const safeToRetry = retryable && replaySafePhase && !partialOutput && !sideEffects;
  const requestIdRaw = raw.requestId || nested.requestId || headerValue(raw.headers, 'x-request-id');
  const requestId = requestIdRaw
    ? `req_${crypto.createHash('sha256').update(String(requestIdRaw)).digest('hex').slice(0, 10)}`
    : null;
  return Object.freeze({
    category,
    provider,
    code: code || null,
    httpStatus,
    retryable,
    retryAfterMs,
    safeToRetry,
    phase,
    partialOutput,
    sideEffects,
    attempt: Math.max(0, Number(context.attempt || raw.attempt || 0) || 0),
    maxAttempts: null,
    userAction: userAction(category, retryAfterMs),
    sanitizedMessage: sanitizeMessage(message),
    cause: code || (httpStatus ? `http_${httpStatus}` : category),
    source,
    requestId,
  });
}

function withMaxAttempts(error, maxAttempts) {
  return Object.freeze({ ...error, maxAttempts });
}

function maxAttemptsFor(category) {
  if (category === 'provider_transient' || category === 'network' || category === 'rate_limit') return 2;
  if (category === 'timeout' || category === 'unknown') return 1;
  return 0;
}

function decideApiErrorPolicy(rawError, context = {}, deps = {}) {
  const now = typeof deps.now === 'function' ? Number(deps.now()) : Date.now();
  const random = typeof deps.random === 'function' ? deps.random : Math.random;
  let error = rawError && CATEGORY_SET.has(rawError.category)
    ? Object.freeze({ ...rawError })
    : normalizeApiError(rawError, context, { now: () => now });
  const maxAttempts = context.maxAttempts == null
    ? maxAttemptsFor(error.category) : Math.max(0, Number(context.maxAttempts) || 0);
  error = withMaxAttempts(error, maxAttempts);
  const nextAttempt = error.attempt + 1;
  const elapsedMs = Math.max(0, Number(context.elapsedMs || 0) || 0);

  if (error.category === 'cancel_shutdown') {
    return Object.freeze({ action: 'fail_fast', reason: 'cancelled_or_shutdown', error, attempt: error.attempt, delayMs: 0 });
  }
  if (error.category === 'billing_quota' && error.retryAfterMs != null) {
    return Object.freeze({
      action: 'wait_reset',
      reason: 'quota_reset_required',
      error,
      attempt: error.attempt,
      delayMs: error.retryAfterMs,
      retryAt: now + error.retryAfterMs,
    });
  }
  if (error.partialOutput || error.sideEffects || !error.safeToRetry) {
    const reason = error.partialOutput || error.sideEffects
      ? 'unsafe_replay_boundary' : `${error.category}_not_retryable`;
    return Object.freeze({ action: 'fail_fast', reason, error, attempt: error.attempt, delayMs: 0 });
  }
  if (nextAttempt > maxAttempts || elapsedMs >= 120_000) {
    return Object.freeze({ action: 'fail_fast', reason: 'retry_budget_exhausted', error, attempt: error.attempt, delayMs: 0 });
  }

  if (error.category === 'rate_limit'
      && error.retryAfterMs != null && error.retryAfterMs > 5 * 60_000) {
    return Object.freeze({
      action: 'wait_reset',
      reason: 'server_reset_outside_auto_window',
      error,
      attempt: error.attempt,
      delayMs: error.retryAfterMs,
      retryAt: now + error.retryAfterMs,
    });
  }

  const bases = {
    rate_limit: 2_000,
    provider_transient: 1_000,
    network: 1_000,
    timeout: 1_500,
    unknown: 1_000,
  };
  const base = bases[error.category] || 1_000;
  const exponential = Math.min(30_000, base * (2 ** Math.max(0, nextAttempt - 1)));
  const jitter = error.retryAfterMs == null
    ? Math.floor(Math.max(0, Math.min(0.999999, Number(random()) || 0)) * Math.min(1_000, exponential / 2))
    : 0;
  const delayMs = error.retryAfterMs == null ? exponential + jitter : error.retryAfterMs;
  return Object.freeze({
    action: 'retry',
    reason: error.retryAfterMs == null ? 'bounded_backoff' : 'server_retry_after',
    error,
    attempt: nextAttempt,
    maxAttempts,
    delayMs,
    retryAt: now + delayMs,
  });
}

function metricToken(value) {
  const token = String(value || 'unknown').toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  return token.replace(/^_+|_+$/g, '') || 'unknown';
}

function createApiErrorPolicyRuntime(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const logger = options.logger || { info() {}, warn() {}, error() {} };
  const metrics = options.metrics || { inc() {}, set() {} };
  const threshold = Math.max(2, Number(options.circuitThreshold || 3));
  const windowMs = Math.max(1_000, Number(options.circuitWindowMs || 60_000));
  const cooldownMs = Math.max(1_000, Number(options.circuitCooldownMs || 60_000));
  const circuits = new Map();
  const decisions = new Map();

  function circuitFor(provider) {
    const key = provider || 'unknown';
    if (!circuits.has(key)) circuits.set(key, { failures: [], openUntil: 0 });
    return circuits.get(key);
  }

  function remember(key, value) {
    if (!key) return;
    decisions.set(key, value);
    if (decisions.size > 1_000) decisions.delete(decisions.keys().next().value);
  }

  function logDecision(decision, context, duplicate = false) {
    if (duplicate) return;
    const error = decision.error;
    const fields = {
      category: error.category,
      provider: error.provider,
      code: error.code,
      httpStatus: error.httpStatus,
      phase: error.phase,
      partialOutput: error.partialOutput,
      sideEffects: error.sideEffects,
      safeToRetry: error.safeToRetry,
      retryable: error.retryable,
      action: decision.action,
      reason: decision.reason,
      delayMs: decision.delayMs || 0,
      attempt: decision.attempt || 0,
      maxAttempts: error.maxAttempts,
      sessionId: context.sessionId || null,
      turnId: context.turnId || null,
      requestId: error.requestId,
    };
    const method = decision.action === 'retry' ? 'warn' : 'info';
    logger[method]('api_error_policy_decision', fields);
    metrics.inc(`multicc_api_error_${metricToken(error.category)}_total`);
    metrics.inc(`multicc_api_error_provider_${metricToken(error.provider)}_total`);
    metrics.inc(`multicc_api_error_decision_${metricToken(decision.action)}_total`);
    if (decision.action === 'retry') metrics.inc('multicc_api_error_retry_attempted_total');
    if (decision.action === 'fail_fast') metrics.inc('multicc_api_error_fail_fast_total');
    if (decision.reason === 'retry_budget_exhausted') metrics.inc('multicc_api_error_retry_exhausted_total');
  }

  function evaluate(raw, context = {}) {
    const key = context.idempotencyKey ? String(context.idempotencyKey) : '';
    if (key && decisions.has(key)) {
      return Object.freeze({ ...decisions.get(key), duplicate: true });
    }
    const at = Number(now());
    const normalized = normalizeApiError(raw, context, { now: () => at });
    let decision = decideApiErrorPolicy(normalized, context, { now: () => at, random });
    const circuit = circuitFor(normalized.provider);
    circuit.failures = circuit.failures.filter(ts => at - ts <= windowMs);

    if (decision.action === 'retry' && TRANSIENT.has(normalized.category)) {
      if (circuit.openUntil > at) {
        decision = Object.freeze({
          ...decision,
          action: 'wait_circuit',
          reason: 'provider_circuit_open',
          delayMs: circuit.openUntil - at,
          retryAt: circuit.openUntil,
        });
      } else {
        circuit.failures.push(at);
        if (circuit.failures.length >= threshold) {
          circuit.openUntil = at + cooldownMs;
          decision = Object.freeze({
            ...decision,
            action: 'wait_circuit',
            reason: 'provider_circuit_opened',
            delayMs: cooldownMs,
            retryAt: circuit.openUntil,
          });
          metrics.inc('multicc_api_error_circuit_open_total');
        }
      }
    }
    remember(key, decision);
    logDecision(decision, context);
    return decision;
  }

  function recordSuccess(provider, context = {}) {
    const key = String(provider || 'unknown').toLowerCase();
    const circuit = circuitFor(key);
    const recovered = circuit.failures.length > 0 || circuit.openUntil > 0;
    circuit.failures = [];
    circuit.openUntil = 0;
    if (recovered) metrics.inc('multicc_api_error_recovery_total');
    if (context.retryAttempt) metrics.inc('multicc_api_error_retry_succeeded_total');
  }

  function snapshot() {
    const at = Number(now());
    return {
      circuits: [...circuits.entries()].map(([provider, state]) => ({
        provider,
        failures: state.failures.filter(ts => at - ts <= windowMs).length,
        open: state.openUntil > at,
        openUntil: state.openUntil || null,
      })),
      idempotencyEntries: decisions.size,
    };
  }

  return Object.freeze({ evaluate, recordSuccess, snapshot });
}

function retryNotice(decision) {
  if (!decision || !decision.error) return '上游 API 请求失败，未自动重试。';
  const { error } = decision;
  if (decision.action === 'retry') {
    const seconds = Math.max(1, Math.ceil((decision.delayMs || 0) / 1000));
    return `上游 API 暂时不可用，将在 ${seconds} 秒后进行受控重试（${decision.attempt}/${error.maxAttempts}）。`;
  }
  if (decision.action === 'wait_reset') {
    return `额度或限流窗口尚未恢复，系统不会短周期重试。${error.userAction}`;
  }
  if (decision.action === 'wait_circuit') {
    const seconds = Math.max(1, Math.ceil((decision.delayMs || 0) / 1000));
    return `Provider 连续失败，熔断 ${seconds} 秒以避免重试风暴；本轮未重放。`;
  }
  if (decision.reason === 'unsafe_replay_boundary') {
    return `上游 API 中断，但本轮已有部分输出或工具执行；为避免重复副作用，未自动重放。${error.userAction}`;
  }
  return `上游 API 请求失败，未自动重试。${error.userAction}`;
}

module.exports = {
  CATEGORIES,
  normalizeApiError,
  decideApiErrorPolicy,
  createApiErrorPolicyRuntime,
  parseRetryAfter,
  retryNotice,
  sanitizeMessage,
  isErrorOnlyText,
};
