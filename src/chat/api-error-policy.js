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
  'stale_connection', 'network_down', 'stream_suspended',
  'connection_closed_mid_response', 'connection_closed_before_response',
]);
const TIMEOUT_CODES = new Set([
  'etimedout', 'timeout', 'connect_timeout', 'read_timeout', 'overall_timeout',
  'deadline_exceeded', 'und_err_connect_timeout', 'headers_timeout',
  'watchdog', 'stream_idle_timeout',
  'response_stalled_mid_stream', 'response_stalled_before_response',
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
const PROVIDER_TRANSIENT_CODES = new Set([
  'server_error', 'api_error', 'overloaded', 'overloaded_error',
  'internal_error', 'internal_server_error', 'server_error_mid_response',
]);
const CONFIG_CODES = new Set([
  'provider_unavailable', 'provider_config_invalid', 'missing_provider',
  'missing_base_url', 'spawn_failed', 'cli_not_installed', 'cli_resume_mismatch',
  'eacces', 'enoent', 'enoexec', 'spawn_eacces', 'spawn_enoent',
  'spawn_enoexec', 'exit_13',
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
  const text = String(value || '').trim().toLowerCase();
  // libuv exposes spawn EACCES as errno -13. Preserve the launch-failure
  // meaning instead of normalizing it into the opaque token "_13".
  if (text === '-13') return 'exit_13';
  return text.replace(/[\s.-]+/g, '_').slice(0, 80);
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
const ERROR_ONLY_PREFIX_RE = /^(?:api\s*error|failed to authenticate|error:|codex\s*(?:error|出错)|claude\s*(?:error|出错)|opencode\s*(?:error|出错)|qoder\s*(?:error|出错)|zcode\s*(?:error|出错)|stream disconnected|connection (?:closed|reset|refused)|request (?:failed|timed out)|rate limit|overloaded|internal server error|service unavailable|timeout|timed out)/i;

function isErrorOnlyText(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 600) return false;
  return ERROR_ONLY_PREFIX_RE.test(text);
}

// Canonical "what an API fault looks like in text" signature list. Every
// surface that needs to DESCRIBE the vocabulary (classify prompt E-state
// definition in src/classify/vocab.js, push prompt in src/push-runtime.js)
// renders from this single list instead of hand-maintaining a copy that drifts
// away from ERROR_ONLY_PREFIX_RE / textFallbackCategory above.
const API_ERROR_SIGNATURES = Object.freeze([
  'API Error', '503', 'Connection closed', 'Overloaded',
  'Internal server error', 'The system is busy',
]);

function apiErrorSignaturesQuoted() {
  return API_ERROR_SIGNATURES.map(sig => `“${sig}”`).join('、');
}

// Some CLIs append the error envelope to the END of an otherwise complete
// assistant turn ("…正文：API Error: Request rejected (429)…"). The whole-message
// predicate above cannot see that shape, so the error text used to land in the
// transcript verbatim. This splitter recognizes exactly one trailing envelope:
// it must sit at the very end, on its own or after a sentence/line boundary,
// and be short. Anything ambiguous stays untouched.
const TRAILING_ERROR_ENVELOPE_RE = /(?:^|[\n。：:；;])\s*(failed to authenticate\b[^\n]{0,80}?api\s*error\s*:|api\s*error\s*:)[^\n。！？]{0,400}\s*$/i;

function splitTrailingErrorEnvelope(value) {
  const text = String(value || '').trim();
  if (!text || isErrorOnlyText(text)) return null;
  const matched = TRAILING_ERROR_ENVELOPE_RE.exec(text);
  if (!matched) return null;
  const body = text.slice(0, matched.index).trim();
  if (!body) return null; // whole-message case — handled by isErrorOnlyText callers
  return Object.freeze({ body, envelope: matched[0].trim() });
}

// Unified turn-boundary detector: recognizes BOTH the whole-message envelope
// ("API Error: …" is the entire assistant text) and the trailing envelope
// appended after real output. Returns null or { source, provider, message,
// body } — body is null for the whole-message form and the stripped partial
// output for the trailing form. Source is always a TRUSTED_TEXT_SOURCES member
// so the envelope message may be classified by text evidence.
function envelopeSourceFor(provider) {
  const name = String(provider || 'claude').toLowerCase();
  if (name === 'qoder') return 'qoder_result';
  if (name === 'codex') return 'codex_event';
  if (name === 'opencode') return 'opencode_event';
  if (name === 'zcode') return 'zcode_event';
  return 'claude_result';
}

// The CLI boundary swallows upstream response headers, so the HTTP status a
// relay returned (the CPR proxy forwards it verbatim) survives only inside the
// envelope text ("API Error: 503 …"). Recover it here as structured evidence:
// normalizeApiError then classifies from httpStatus first instead of pure text
// matching, and taskState.apiError.httpStatus reaches the App UI.
const ENVELOPE_STATUS_RE = /\b([45]\d\d)\b/;

function envelopeHttpStatus(message) {
  const matched = ENVELOPE_STATUS_RE.exec(String(message || ''));
  if (!matched) return null;
  const status = Number(matched[1]);
  return status >= 400 && status <= 599 ? status : null;
}

// Known-harmless provider stderr lines (measured from multicc-error.log noise):
// codex skill-loading complaints (108+/log), background model-refresh timeouts
// (15+/log), mid-stream delta warnings after a turn switch, and pure
// informational notices. They never affect turn outcome, so the turn engine
// drops them instead of logging warns and polluting the stderr tail used for
// close-time diagnosis. Deliberately NOT filtered: tool router failures and
// MCP transport errors — those can be the real signal.
const HARMLESS_STDERR_LINE_RES = [
  /failed to load skill \[[^\]]*\] missing /i,
  /codex_core::util: \w+ without active item\b/i,
  /codex_core::util: Custom tool call output is missing for call id:/i,
  /failed to refresh available models/i,
  /failed to renew cache TTL/i,
  /state db returned stale rollout path for thread/i,
  /^Reading additional input from stdin\.\.\.$/i,
];

function isKnownHarmlessStderrLine(line) {
  const text = String(line || '').trim();
  if (!text) return true;
  return HARMLESS_STDERR_LINE_RES.some(re => re.test(text));
}

function detectErrorEnvelope(provider, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  if (isErrorOnlyText(trimmed)) {
    return Object.freeze({
      source: envelopeSourceFor(provider),
      provider: String(provider || 'claude').toLowerCase(),
      message: trimmed,
      httpStatus: envelopeHttpStatus(trimmed),
      body: null,
    });
  }
  const split = splitTrailingErrorEnvelope(trimmed);
  if (!split) return null;
  return Object.freeze({
    source: envelopeSourceFor(provider),
    provider: String(provider || 'claude').toLowerCase(),
    message: split.envelope,
    httpStatus: envelopeHttpStatus(split.envelope),
    body: split.body,
  });
}

// Claude CLI (2.1.x) stream watchdog: when a stream stalls, errors, or the
// connection drops mid-response, the CLI finalizes the turn as an ordinary
// result whose assistant text is one of these short "API Error: …" envelopes
// — with no is_error/subtype evidence on the result event. The envelope text
// is therefore the only structured signal. Wording is version-pinned to the
// CLI 2.1.x watchdog; keep the codes aligned with the category sets above.
const CLAUDE_ERROR_ENVELOPE_CODES = Object.freeze([
  { code: 'response_stalled_mid_stream', pattern: /response stalled mid-stream/i },
  { code: 'response_stalled_before_response', pattern: /response stalled while thinking/i },
  { code: 'server_error_mid_response', pattern: /server error mid-response/i },
  { code: 'connection_closed_mid_response', pattern: /connection closed mid-response/i },
  { code: 'connection_closed_before_response', pattern: /connection closed while thinking/i },
]);

function claudeErrorEnvelope(provider, text) {
  if (!isErrorOnlyText(text)) return null;
  const message = String(text).trim();
  const matched = CLAUDE_ERROR_ENVELOPE_CODES.find(entry => entry.pattern.test(message));
  if (!matched) return null;
  const providerName = String(provider || 'claude').toLowerCase();
  return Object.freeze({
    source: providerName === 'qoder' ? 'qoder_result' : 'claude_result',
    provider: providerName,
    code: matched.code,
    message,
  });
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
  // A provider error code is more specific than a generic HTTP status. In
  // particular, quota_exceeded is commonly transported as HTTP 403.
  if (AUTH_CODES.has(code)) return 'authentication_permission';
  if (BILLING_CODES.has(code)) return 'billing_quota';
  if (RATE_CODES.has(code)) return 'rate_limit';
  if (PROVIDER_TRANSIENT_CODES.has(code)) return 'provider_transient';
  if (CONTEXT_CODES.has(code)) return 'context_token_limit';
  if (TOOL_CODES.has(code)) return 'tool_protocol';
  if (CONFIG_CODES.has(code)) return 'adapter_configuration';
  if (NETWORK_CODES.has(code)) return 'network';
  if (TIMEOUT_CODES.has(code)) return 'timeout';
  if (status === 401 || status === 403) return 'authentication_permission';
  if (status === 402) return 'billing_quota';
  if (status === 429) return 'rate_limit';
  if (status != null && [500, 502, 503, 504, 529].includes(status)) return 'provider_transient';
  if (status != null && [400, 404, 409, 422].includes(status)) return 'invalid_request_model';
  return null;
}

function textFallbackCategory(message) {
  const text = String(message || '').toLowerCase();
  // Billing wording outranks a bare 401/403: providers transport quota
  // exhaustion as HTTP 403 ("用户额度不足", "usage limit"), and telling the
  // user to re-login would be the wrong remedy. Mirrors structuredCategory's
  // 403 refinement below.
  if (/\b402\b|insufficient (?:balance|quota)|billing|usage limit|credit balance|额度不足|余额不足|剩余额度/.test(text)) return 'billing_quota';
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|authentication failed|authorization failed|invalid api key|insufficient scope/.test(text)) return 'authentication_permission';
  if (/\b429\b|rate limit|too many requests/.test(text)) return 'rate_limit';
  if (/context (?:window|length)|too many tokens|maximum context|max(?:imum)? output tokens?|token limit/.test(text)) return 'context_token_limit';
  if (/invalid tool|tool (?:schema|arguments?|protocol)|mcp (?:error|failed)|function (?:arguments?|call) error/.test(text)) return 'tool_protocol';
  if (/cancelled by user|canceled by user|server (?:is )?shutting down|sigterm|sigint/.test(text)) return 'cancel_shutdown';
  if (/provider (?:config|configuration).*(?:missing|invalid)|missing (?:provider|base url)|cli not installed|spawn failed|\b(?:eacces|enoent|enoexec)\b|\bexit(?:ed)?(?:\s+(?:code|status))?\s*[:=]?\s*-13\b/.test(text)) return 'adapter_configuration';
  if (/etimedout|timed? out|timeout|deadline exceeded|response stalled|stream idle/.test(text)) return 'timeout';
  if (/enotfound|dns|tls|certificate|econnreset|connection reset|connection closed|connection ?refused|unable to connect|socket hang|network error|fetch failed|stream disconnected/.test(text)) return 'network';
  if (/\b(?:500|502|503|504|529)\b|overloaded|server error|internal server error|service unavailable|bad gateway|system is busy/.test(text)) return 'provider_transient';
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

function routeIdentityText(value, fallback = null, maxLength = 256) {
  const text = value == null ? '' : String(value).trim();
  return text ? text.slice(0, maxLength) : fallback;
}

function routeIdentityNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizeApiError(raw = {}, context = {}, deps = {}) {
  const now = typeof deps.now === 'function' ? Number(deps.now()) : Date.now();
  const source = String(context.source || raw.source || 'unknown').toLowerCase().slice(0, 40);
  // Historical callers and persisted UI state call this field `provider`, but
  // its value is the CLI family. Accept the additive `cli` spelling without
  // changing the legacy output contract.
  const provider = String(
    context.provider || context.cli || raw.provider || raw.cli || 'unknown',
  ).toLowerCase().slice(0, 40);
  const nested = raw && typeof raw === 'object' && raw.error && typeof raw.error === 'object'
    ? raw.error : {};
  const providerId = routeIdentityText(
    context.providerId ?? raw.providerId ?? nested.providerId,
    '_default_',
  );
  const providerName = routeIdentityText(
    context.providerName ?? raw.providerName ?? nested.providerName,
    providerId === '_default_' ? provider : providerId,
  );
  const turnId = routeIdentityText(context.turnId ?? raw.turnId ?? nested.turnId);
  const decisionId = routeIdentityText(
    context.decisionId ?? raw.decisionId ?? nested.decisionId,
  );
  const runtimeEpoch = routeIdentityText(
    context.runtimeEpoch ?? raw.runtimeEpoch ?? nested.runtimeEpoch,
  );
  const routeAttemptId = routeIdentityText(
    context.routeAttemptId ?? raw.routeAttemptId ?? nested.routeAttemptId,
  );
  const routeGeneration = routeIdentityNumber(
    context.routeGeneration ?? raw.routeGeneration ?? nested.routeGeneration,
  );
  const attemptNo = routeIdentityNumber(
    context.attemptNo ?? raw.attemptNo ?? nested.attemptNo,
  );
  const providerRevision = routeIdentityText(
    context.providerRevision ?? raw.providerRevision ?? nested.providerRevision,
  );
  const providerRouteScope = context.providerRouteScope === 'attempt'
    && runtimeEpoch && turnId && decisionId && routeAttemptId
    && routeGeneration && attemptNo && providerRevision ? 'attempt' : null;
  const code = normalizeCode(context.code || raw.code || nested.code || raw.type || nested.type);
  const httpStatus = httpStatusOf(raw);
  const message = sourceMessage(raw);
  const rawCategory = normalizeCode(context.category || raw.category || nested.category);
  const explicit = structuredCategory(httpStatus, code, rawCategory);
  const trustedTextCategory = TRUSTED_TEXT_SOURCES.has(source)
    ? textFallbackCategory(message) : null;
  let category = explicit || trustedTextCategory || 'unknown';
  if (!CATEGORY_SET.has(rawCategory)) {
    // HTTP 403 alone is only a generic auth signal. Provider-owned quota and
    // billing wording is more specific, but must not override an explicit
    // authentication code/category.
    if (httpStatus === 403
        && explicit === 'authentication_permission'
        && !AUTH_CODES.has(code)
        && trustedTextCategory === 'billing_quota') {
      category = 'billing_quota';
    }
    // Likewise, HTTP 400 is the usual transport for context overflow. Prefer
    // the trusted, specific context signal over the generic invalid-request
    // fallback while preserving explicit structured categories.
    if (httpStatus === 400
        && explicit === 'invalid_request_model'
        && trustedTextCategory === 'context_token_limit') {
      category = 'context_token_limit';
    }
    // A bare 5xx only says "the relay returned an error". When the trusted
    // envelope text names a more specific root cause (DNS failure, TLS
    // disconnect, timeout), that diagnosis outranks the generic bucket —
    // relays commonly transport network faults as 500/502. Only applies when
    // the status was the sole structured evidence; a real provider error code
    // still wins.
    const codeDerivedCategory = AUTH_CODES.has(code) || BILLING_CODES.has(code)
      || RATE_CODES.has(code) || PROVIDER_TRANSIENT_CODES.has(code)
      || CONTEXT_CODES.has(code) || TOOL_CODES.has(code) || CONFIG_CODES.has(code)
      || NETWORK_CODES.has(code) || TIMEOUT_CODES.has(code);
    if (!codeDerivedCategory
        && httpStatus != null && [500, 502, 503, 504, 529].includes(httpStatus)
        && (trustedTextCategory === 'network' || trustedTextCategory === 'timeout')) {
      category = trustedTextCategory;
    }
  }
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
    providerId,
    providerName,
    providerRouteScope,
    runtimeEpoch,
    turnId,
    decisionId,
    routeAttemptId,
    routeGeneration,
    attemptNo,
    providerRevision,
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

function circuitIdentity(providerOrIdentity, context = {}) {
  const source = providerOrIdentity && typeof providerOrIdentity === 'object'
    ? providerOrIdentity : {};
  const providerAttempt = context.providerAttempt && typeof context.providerAttempt === 'object'
    ? context.providerAttempt
    : context.runner?.providerAttempt && typeof context.runner.providerAttempt === 'object'
      ? context.runner.providerAttempt : {};
  const usageAttribution = context.usageAttribution && typeof context.usageAttribution === 'object'
    ? context.usageAttribution
    : context.runner?.usageAttribution && typeof context.runner.usageAttribution === 'object'
      ? context.runner.usageAttribution : {};
  const cli = String(
    providerAttempt.cli || usageAttribution.cli || context.cli || context.provider
      || source.cli || source.provider
      || (typeof providerOrIdentity === 'string' ? providerOrIdentity : '')
      || 'unknown',
  ).trim().toLowerCase().slice(0, 40) || 'unknown';
  const providerId = routeIdentityText(
    providerAttempt.providerId || usageAttribution.providerId || context.providerId
      || source.providerId,
    '_default_',
  );
  const providerName = routeIdentityText(
    providerAttempt.providerName || usageAttribution.providerName || context.providerName
      || source.providerName,
    providerId === '_default_' ? cli : providerId,
  );
  return { cli, providerId, providerName };
}

function circuitIdentityKey(identity) {
  // JSON tuple encoding avoids collisions when provider ids contain `:`.
  return JSON.stringify([identity.cli, identity.providerId]);
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

  function circuitFor(providerOrIdentity, context = {}) {
    const identity = circuitIdentity(providerOrIdentity, context);
    const key = circuitIdentityKey(identity);
    if (!circuits.has(key)) {
      circuits.set(key, { ...identity, failures: [], openUntil: 0 });
    }
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
      providerId: error.providerId,
      providerName: error.providerName,
      providerRouteScope: error.providerRouteScope,
      runtimeEpoch: error.runtimeEpoch,
      decisionId: error.decisionId,
      routeAttemptId: error.routeAttemptId,
      routeGeneration: error.routeGeneration,
      attemptNo: error.attemptNo,
      providerRevision: error.providerRevision,
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
    const circuit = circuitFor(normalized);
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
    const circuit = circuitFor(provider, context);
    const recovered = circuit.failures.length > 0 || circuit.openUntil > 0;
    circuit.failures = [];
    circuit.openUntil = 0;
    if (recovered) metrics.inc('multicc_api_error_recovery_total');
    if (context.retryAttempt) metrics.inc('multicc_api_error_retry_succeeded_total');
  }

  function snapshot() {
    const at = Number(now());
    return {
      circuits: [...circuits.values()].map(state => ({
        // Preserve `provider` for provider-only callers; it has always meant
        // the CLI in this policy. The concrete provider is additive.
        provider: state.cli,
        cli: state.cli,
        providerId: state.providerId,
        providerName: state.providerName,
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
  ERROR_ONLY_PREFIX_RE,
  TRAILING_ERROR_ENVELOPE_RE,
  splitTrailingErrorEnvelope,
  detectErrorEnvelope,
  claudeErrorEnvelope,
  isKnownHarmlessStderrLine,
  API_ERROR_SIGNATURES,
  apiErrorSignaturesQuoted,
};
