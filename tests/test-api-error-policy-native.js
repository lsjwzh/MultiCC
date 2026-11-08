'use strict';

// The API error policy moved from src/chat/api-error-policy.js to
// native/core/src/api_error_policy.rs (bridge: src/chat/api-error-policy.js,
// addon: native/addon/src/api_error_policy.rs). Every entry point is compared
// with the frozen Node implementation (tests/helpers/legacy-api-error-policy.js)
// on production fixtures plus generated adversarial input: CJK punctuation that
// the envelope scanner treats as a boundary, lone surrogates, JSON quota-guard
// bodies, header objects in every casing, Retry-After dates and seconds, and
// numeric edge cases.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const legacy = require('./helpers/legacy-api-error-policy');
const current = require('../src/chat/api-error-policy');

const NOW = 1_790_000_000_000;
const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'api-errors-sanitized.json'), 'utf8',
));

function generator(seed) {
  let n = seed >>> 0;
  const next = () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n; };
  const pick = list => list[(next() >>> 16) % list.length];
  return { next, pick, int: max => (next() >>> 16) % max };
}

function outcome(fn) {
  try {
    const value = fn();
    const isObject = value !== null && (typeof value === 'object' || typeof value === 'function');
    const holder = isObject && value.error && typeof value.error === 'object' ? value.error : value;
    const rejection = holder && typeof holder === 'object' ? holder.rejection : undefined;
    return {
      value,
      frozen: isObject ? Object.isFrozen(value) : null,
      keys: isObject ? Reflect.ownKeys(value).map(String) : null,
      errorFrozen: isObject && value.error && typeof value.error === 'object'
        ? Object.isFrozen(value.error) : null,
      rejectionFrozen: rejection && typeof rejection === 'object' ? Object.isFrozen(rejection) : null,
    };
  } catch (error) {
    return { threw: `${error && error.constructor && error.constructor.name}: ${error && error.message}` };
  }
}

function compare(label, legacyCall, currentCall) {
  assert.deepStrictEqual(outcome(currentCall), outcome(legacyCall), label);
}

const TEXT_FRAGMENTS = [
  'API Error: ', 'api error:', 'API ERROR:', 'API  Error:', 'Failed to authenticate.', 'failed to authenticate',
  'Request rejected (429)', 'request rejected (503)', '503 Service Unavailable', '503', '429', '500', '502', '504', '529',
  '401', '403', '402', '400', '404', '422', 'error:', 'Error:', '出错：',
  'Codex 出错：', 'Codex Exec 出错：', 'Codex Exp 出错：', 'Claude 出错：', 'OpenCode 出错：', 'Qoder 出错：',
  'ZCode 出错：', 'Kimi 出错：', 'CodeBuddy 出错：', 'DSH 出错：', 'Gemini 出错：', 'Grok 出错：', 'Pi 出错：',
  'response stalled mid-stream', 'response stalled while thinking', 'server error mid-response',
  'connection closed mid-response', 'connection closed while thinking', 'Response Stalled Mid-Stream',
  'Overloaded', 'Internal server error', 'The system is busy', 'Connection closed', 'stream disconnected',
  'connection reset', 'connection refused', 'request failed', 'request timed out', 'rate limit', 'timeout', 'timed out',
  'The operation timed out', 'unable to connect to API', 'connection error', 'exceeded retry limit', '[ERROR]',
  'insufficient quota', 'You have exceeded the 5-hour usage quota', 'usage limit', 'credit balance', 'weekly quota',
  'waiting for the reset', 'upgrade your plan', 'purchase extra usage', 'hit your limit', '额度不足', '余额不足',
  '套餐不支持', '暂未开放', 'usage credits are required', 'not available on your plan',
  'context window exceeded', 'too many tokens', 'maximum context length', 'invalid request', 'unsupported model',
  'invalid tool arguments', 'mcp error', 'cancelled by user', 'server shutting down', 'sigterm',
  'invalid session id. must be a valid uuid', 'no conversation found with session id', 'session id abc is already in use',
  'cli not installed', 'spawn failed', 'EACCES', 'exit code -13', 'ETIMEDOUT', 'ENOTFOUND', 'socket hang up',
  '{"code":"quota_guard"}', '{"error":"quota guard exceeded"}', '{"code" : "quota-guard"}', '{"a":1}', '[1,2,3]',
  '正文', '这是正文。', '这是一段很长的正文', '。', '！', '？', '：', '；', '.', '!', '?', ':', ';',
  '（', '）', ')', '(', '”', '’', '"', '\n', '\n\n', '\r\n', ' ', '\t', '　', ' ', '﻿',
  '`API Error: 429`', '中文正文', '😀', '\ud800', '\udfff', 'ß', 'İ', 'ı', 'ſ', 'K',
  'It will reset in 5 minutes.', 'resets in 2 hours', 'reset in 1 day', 'Reset in 0 seconds', 'reset in 999 days',
  'reset at 2026-09-20 18:11:35 +0800', 'Resets at 2026-09-20T18:11:35Z', 'reset on 2026-09-20 18:11:35.123',
  'retry-after', 'x-ratelimit-reset', 'x-request-id', 'Authorization: Bearer x', 'root', 'permission denied',
  '403 permission denied', 'permission_denied', 'rate_limit_error', 'invalid_api_key', 'econnreset', 'exit_13',
  '-13', 'model_request_deadline', 'response_stalled_before_response', 'context_length_exceeded',
];

const PROVIDERS = [
  'claude', 'codex', 'qoder', 'opencode', 'zcode', 'kimi', 'codebuddy', 'dsh', 'gemini', 'grok',
  'commandcode', 'pi', 'CLAUDE', 'Codex', 'unknown', '', 'anthropic', 'aux', undefined, null, 0, 42,
];

const SOURCES = [
  'claude_result', 'claude-exp_event', 'anthropic_event', 'codex_event', 'opencode_event', 'qoder_result',
  'zcode_event', 'kimi_event', 'codebuddy_result', 'dsh_event', 'gemini_event', 'grok_event',
  'commandcode_event', 'pi_event', 'process_stderr', 'aux_http', 'host_interruption', 'classifier_legacy',
  'proxy_response', 'assistant_text', 'unknown', '', 'CLAUDE_RESULT', 'codex', undefined, null, 0,
];

const CODES = [
  'rate_limit_error', 'rate_limited', 'too_many_requests', 'overloaded', 'overloaded_error', 'api_error',
  'server_error', 'internal_error', 'authentication_error', 'permission_denied', 'invalid_api_key',
  'insufficient_quota', 'quota_exceeded', 'usage_limit_exceeded', 'credit_balance_exhausted',
  'context_length_exceeded', 'too_many_tokens', 'max_output_tokens', 'invalid_tool_arguments', 'mcp_error',
  'tool_protocol_error', 'provider_unavailable', 'spawn_failed', 'cli_not_installed', 'exit_13',
  'econnreset', 'enotfound', 'etimedout', 'timeout', 'model_request_deadline', 'response_stalled_mid_stream',
  'connection_closed_mid_response', 'user_cancel', 'sigterm', 'shutdown', 'bypass_root', 'org_verify_failed',
  'unknown_code', 'rate-limit', '  Too Many.Requests  ', '-13', 'EAI_AGAIN',
];

const PLAIN_VALUES = [
  undefined, null, 0, -0, 1, 42, -5, 429, 401.5, 1e13, 1e9, NaN, Infinity, -Infinity,
  '', ' ', '429', 'retry-after', true, false, [], {}, [1, 2], { code: 'x' },
];

function randomText(g, parts = 1 + g.int(10)) {
  let out = '';
  for (let index = 0; index < parts; index += 1) out += g.pick(TEXT_FRAGMENTS);
  return out;
}

function randomValue(g) {
  if (g.int(3) === 0) return g.pick(PLAIN_VALUES);
  return randomText(g);
}

function randomHeaders(g) {
  if (g.int(6) === 0) return randomValue(g);
  const headers = {};
  if (g.int(2)) headers['retry-after'] = g.pick(['3', '1.5', '0', '-2', 'Wed, 21 Oct 2015 07:28:00 GMT', '', 'abc', 7, null, undefined]);
  if (g.int(2)) headers['Retry-After'] = g.pick(['5', 'junk']);
  if (g.int(2)) headers['x-ratelimit-reset'] = g.pick(['1790000000', '1790000120', '0', 'junk', 1790000000]);
  if (g.int(3) === 0) headers['X-RateLimit-Reset'] = g.pick(['1790000600', 'x']);
  if (g.int(2)) headers['x-request-id'] = g.pick(['req-abc', '0', '', 42]);
  if (g.int(3) === 0) headers['X-Request-Id'] = 'REQ-UP';
  return headers;
}

function randomRaw(g) {
  const raw = {};
  if (g.int(2)) raw.source = g.pick(SOURCES);
  if (g.int(2)) raw.provider = g.pick(PROVIDERS);
  if (g.int(4) === 0) raw.cli = g.pick(PROVIDERS);
  if (g.int(2)) raw.code = g.pick(CODES);
  if (g.int(2)) raw.message = randomValue(g);
  if (g.int(3) === 0) raw.detail = randomValue(g);
  if (g.int(4) === 0) raw.reason = randomValue(g);
  if (g.int(4) === 0) raw.type = g.pick(CODES);
  if (g.int(4) === 0) raw.category = g.pick([...legacy.CATEGORIES, 'rate_limit_error', 'unknown', '', null, 42]);
  if (g.int(4) === 0) raw.errors = [randomValue(g), randomValue(g)];
  if (g.int(3) === 0) {
    const nested = {};
    if (g.int(2)) nested.message = randomValue(g);
    if (g.int(2)) nested.code = g.pick(CODES);
    if (g.int(3) === 0) nested.httpStatus = g.pick([429, 403, 500, '429', null, 99, 600, 402.6]);
    if (g.int(3) === 0) nested.status = g.pick([503, '401', 0]);
    if (g.int(3) === 0) nested.type = g.pick(CODES);
    if (g.int(3) === 0) nested.rejection = g.pick([{ kind: 'window', scope: 'model', resetMs: NOW + 60_000 }, { kind: 'transient' }, { kind: 'bogus' }, null]);
    if (g.int(3) === 0) nested.headers = randomHeaders(g);
    if (g.int(4) === 0) nested.providerId = g.pick(['p1', '', 7, null]);
    raw.error = g.int(10) === 0 ? g.pick(PLAIN_VALUES) : nested;
  }
  if (g.int(3) === 0) raw.headers = randomHeaders(g);
  if (g.int(3) === 0) raw.httpStatus = g.pick([429, 403, 402, 500, 503, 529, 400, 404, 409, 422, 599, 600, '429', null, 0, 401.7]);
  if (g.int(4) === 0) raw.status = g.pick([429, '503', 0, null]);
  if (g.int(4) === 0) raw.statusCode = g.pick([500, '401', null]);
  if (g.int(4) === 0) raw.retryAfterMs = g.pick([0, 3000, 300_001, 3_000_000, -1, '2500', null, NaN, 1.6]);
  if (g.int(4) === 0) raw.retryAfter = g.pick(['10', '0.5', 'Wed, 21 Oct 2015 07:28:00 GMT', 1790000030, '', null, 'nope']);
  if (g.int(4) === 0) raw.resetAt = g.pick([1790000060, 1_790_000_060_000, '1790000090', 5, -5, null, 'x']);
  if (g.int(4) === 0) raw.rateLimitReset = g.pick([1790000045, 1_790_000_045_000, 0, null]);
  if (g.int(4) === 0) raw.rejection = g.pick([{ kind: 'transient', scope: 'account' }, { kind: 'entitlement', scope: 'model' }, null, { kind: 'window', scope: 'model', resetMs: NOW + 120_000, source: 'headers' }]);
  if (g.int(4) === 0) raw.param = g.pick(['max_tokens', 'model', '', null, 42]);
  if (g.int(4) === 0) raw.requestId = g.pick(['req-1', '', 0, null, 'x'.repeat(80)]);
  if (g.int(4) === 0) raw.requestDeadlineAt = g.pick([NOW + 30_000, NOW - 1, NaN, null, 'soon', 0]);
  if (g.int(4) === 0) raw.retryBudgetExhausted = g.pick([true, false, 1, 'yes', null]);
  if (g.int(4) === 0) raw.partialOutput = g.pick([true, false, 1, 'yes', null]);
  if (g.int(4) === 0) raw.sideEffects = g.pick([true, false, 1, 'yes', null]);
  if (g.int(4) === 0) raw.phase = g.pick(['connect', 'before_first_token', 'stream', 'request', '', null]);
  if (g.int(4) === 0) raw.attempt = g.pick([0, 1, 2, -1, '1', '01', null, 1.7, 'x']);
  if (g.int(5) === 0) raw.providerId = g.pick(['p1', '', 0, null, '_default_']);
  if (g.int(5) === 0) raw.providerName = g.pick(['name', '', null]);
  if (g.int(5) === 0) raw.turnId = g.pick(['t1', '', null, 0]);
  if (g.int(5) === 0) raw.decisionId = g.pick(['d1', '', null]);
  if (g.int(5) === 0) raw.runtimeEpoch = g.pick(['e1', '', null]);
  if (g.int(5) === 0) raw.routeAttemptId = g.pick(['a1', '', null]);
  if (g.int(5) === 0) raw.routeGeneration = g.pick([1, 0, -1, 1.5, '2', null]);
  if (g.int(5) === 0) raw.attemptNo = g.pick([1, 0, null, '3']);
  if (g.int(5) === 0) raw.providerRevision = g.pick(['r1', '', null]);
  return raw;
}

function randomContext(g, raw) {
  const context = {};
  if (g.int(3) === 0) context.source = g.pick(SOURCES);
  if (g.int(3) === 0) context.provider = g.pick(PROVIDERS);
  if (g.int(4) === 0) context.cli = g.pick(PROVIDERS);
  if (g.int(4) === 0) context.code = g.pick(CODES);
  if (g.int(4) === 0) context.category = g.pick([...legacy.CATEGORIES, 'rate_limit_error', '', null]);
  if (g.int(4) === 0) context.phase = g.pick(['connect', 'before_first_token', 'request', 'stream', '', null]);
  if (g.int(4) === 0) context.attempt = g.pick([0, 1, 2, -1, '1', null, 1.7]);
  if (g.int(4) === 0) context.maxAttempts = g.pick([0, 1, 2, 5, null, -3, '2', NaN]);
  if (g.int(4) === 0) context.partialOutput = g.pick([true, false, 1, null]);
  if (g.int(4) === 0) context.sideEffects = g.pick([true, false, 1, null]);
  if (g.int(4) === 0) context.rejection = g.pick([{ kind: 'window', scope: 'model', resetMs: NOW + 60_000 }, { kind: 'transient' }, null, { kind: 'billing' }]);
  if (g.int(4) === 0) context.providerId = g.pick(['p1', '', 0, null]);
  if (g.int(4) === 0) context.providerName = g.pick(['name', '', null]);
  if (g.int(4) === 0) context.providerRouteScope = g.pick(['attempt', 'other', null]);
  if (g.int(4) === 0) context.runtimeEpoch = g.pick(['e1', '', null]);
  if (g.int(4) === 0) context.turnId = g.pick(['t1', '', null]);
  if (g.int(4) === 0) context.decisionId = g.pick(['d1', '', null]);
  if (g.int(4) === 0) context.routeAttemptId = g.pick(['a1', '', null]);
  if (g.int(4) === 0) context.routeGeneration = g.pick([1, 0, -1, '2', null]);
  if (g.int(4) === 0) context.attemptNo = g.pick([1, 0, null, '3']);
  if (g.int(4) === 0) context.providerRevision = g.pick(['r1', '', null]);
  // Keep `source` present often enough that the two implementations read the
  // same object shape rather than throwing on a nullish receiver.
  if (!context.source && raw && typeof raw === 'object' && !raw.source) context.source = 'claude_result';
  return context;
}

test('text predicates and envelopes match the Node rules', () => {
  const providers = ['claude', 'codex', 'qoder', 'opencode', 'zcode', 'kimi', 'codebuddy', 'dsh',
    'gemini', 'grok', 'commandcode', 'pi', 'CLAUDE', 'Codex', '', undefined, null, 0, 42];
  for (const provider of providers) {
    compare(`envelopeSourceFor(${String(provider)})`,
      () => legacy.envelopeSourceFor(provider),
      () => current.envelopeSourceFor(provider));
  }
  for (let seed = 1; seed <= 4000; seed += 1) {
    const g = generator(seed);
    const text = randomText(g);
    const provider = g.pick(providers);
    compare(`isErrorOnlyText #${seed} ${JSON.stringify(text)}`,
      () => legacy.isErrorOnlyText(text), () => current.isErrorOnlyText(text));
    compare(`splitTrailingErrorEnvelope #${seed} ${JSON.stringify(text)}`,
      () => legacy.splitTrailingErrorEnvelope(text), () => current.splitTrailingErrorEnvelope(text));
    compare(`detectErrorEnvelope #${seed} ${JSON.stringify(text)}`,
      () => legacy.detectErrorEnvelope(provider, text), () => current.detectErrorEnvelope(provider, text));
    compare(`claudeErrorEnvelope #${seed} ${JSON.stringify(text)}`,
      () => legacy.claudeErrorEnvelope(provider, text), () => current.claudeErrorEnvelope(provider, text));
    const line = g.int(8) === 0 ? g.pick(PLAIN_VALUES) : text;
    compare(`isKnownHarmlessStderrLine #${seed} ${JSON.stringify(line)}`,
      () => legacy.isKnownHarmlessStderrLine(line),
      () => current.isKnownHarmlessStderrLine(line));
    const retryAfter = randomValue(g);
    compare(`parseRetryAfter #${seed} ${JSON.stringify(retryAfter)}`,
      () => legacy.parseRetryAfter(retryAfter, NOW),
      () => current.parseRetryAfter(retryAfter, NOW));
    const resetText = randomValue(g);
    compare(`resetAfterFromText #${seed} ${JSON.stringify(resetText)}`,
      () => legacy.resetAfterFromText(resetText, NOW),
      () => current.resetAfterFromText(resetText, NOW));
  }
});

test('harmless stderr fixtures keep their verdicts', () => {
  const lines = [
    'warning: failed to load skill [foo] missing SKILL.md',
    'codex_core::util: Delta without active item',
    'codex_core::util: Custom tool call output is missing for call id: x',
    'failed to refresh available models: timeout',
    'failed to renew cache TTL',
    'state db returned stale rollout path for thread t',
    'Reading additional input from stdin...',
    'MCP transport error',
    'Fatal error',
    '',
    '   ',
    '\ud800failed to renew cache TTL',
  ];
  for (const line of lines) {
    compare(`line ${JSON.stringify(line)}`,
      () => legacy.isKnownHarmlessStderrLine(line), () => current.isKnownHarmlessStderrLine(line));
  }
});

test('exported patterns and signature lists come from the same source', () => {
  assert.equal(current.ERROR_ONLY_PREFIX_RE.source, legacy.ERROR_ONLY_PREFIX_RE.source);
  assert.equal(current.ERROR_ONLY_PREFIX_RE.flags, legacy.ERROR_ONLY_PREFIX_RE.flags);
  assert.equal(current.TRAILING_ERROR_ENVELOPE_RE.source, legacy.TRAILING_ERROR_ENVELOPE_RE.source);
  assert.equal(current.TRAILING_ERROR_ENVELOPE_RE.flags, legacy.TRAILING_ERROR_ENVELOPE_RE.flags);
  assert.deepStrictEqual([...current.CATEGORIES], [...legacy.CATEGORIES]);
  assert.deepStrictEqual([...current.API_ERROR_SIGNATURES], [...legacy.API_ERROR_SIGNATURES]);
  assert.equal(current.apiErrorSignaturesQuoted(), legacy.apiErrorSignaturesQuoted());
});

test('normalizeApiError matches the Node policy on fixtures and generated input', () => {
  for (const [index, sample] of fixture.samples.entries()) {
    compare(`fixture #${index}`, () => legacy.normalizeApiError(sample, { now: () => NOW }),
      () => current.normalizeApiError(sample, { now: () => NOW }));
  }
  for (let seed = 1; seed <= 3000; seed += 1) {
    const g = generator(seed * 7919);
    const raw = randomRaw(g);
    const context = randomContext(g, raw);
    const now = NOW + g.int(1000);
    compare(`normalize #${seed} ${JSON.stringify(raw).slice(0, 200)}`,
      () => legacy.normalizeApiError(raw, context, { now: () => now }),
      () => current.normalizeApiError(raw, context, { now: () => now }));
  }
});

test('decideApiErrorPolicy matches the Node policy on fixtures and generated input', () => {
  for (const [index, sample] of fixture.samples.entries()) {
    const context = { source: sample.source, provider: sample.provider, phase: 'before_first_token' };
    compare(`fixture #${index}`, () => legacy.decideApiErrorPolicy(sample, context, { now: () => NOW, random: () => 0.5 }),
      () => current.decideApiErrorPolicy(sample, context, { now: () => NOW, random: () => 0.5 }));
  }
  for (let seed = 1; seed <= 3000; seed += 1) {
    const g = generator(seed * 104729);
    const raw = randomRaw(g);
    const context = randomContext(g, raw);
    const now = NOW + g.int(1000);
    const sample = (g.int(1000) / 1000);
    compare(`decide #${seed} ${JSON.stringify(raw).slice(0, 200)}`,
      () => legacy.decideApiErrorPolicy(raw, context, { now: () => now, random: () => sample }),
      () => current.decideApiErrorPolicy(raw, context, { now: () => now, random: () => sample }));
  }
  // Already-normalized errors take the spread branch; feed each side its own
  // normalized object so both see a known category.
  for (let seed = 1; seed <= 500; seed += 1) {
    const g = generator(seed * 31337);
    const raw = randomRaw(g);
    const context = randomContext(g, raw);
    const now = NOW + g.int(1000);
    const left = legacy.normalizeApiError(raw, context, { now: () => now });
    const right = current.normalizeApiError(raw, context, { now: () => now });
    compare(`decide(normalized) #${seed}`,
      () => legacy.decideApiErrorPolicy(left, context, { now: () => now, random: () => 0.25 }),
      () => current.decideApiErrorPolicy(right, context, { now: () => now, random: () => 0.25 }));
  }
});

test('retryNotice matches the Node wording on generated decisions', () => {
  for (let seed = 1; seed <= 1200; seed += 1) {
    const g = generator(seed * 65537);
    const raw = randomRaw(g);
    const context = randomContext(g, raw);
    const now = NOW + g.int(1000);
    const left = legacy.decideApiErrorPolicy(raw, context, { now: () => now, random: () => 0.75 });
    const right = current.decideApiErrorPolicy(raw, context, { now: () => now, random: () => 0.75 });
    compare(`retryNotice #${seed}`, () => legacy.retryNotice(left), () => current.retryNotice(right));
    compare(`retryNotice(decision) #${seed}`, () => legacy.retryNotice(right), () => current.retryNotice(left));
  }
  const decisions = [
    null,
    undefined,
    {},
    { action: 'retry', delayMs: 1500, attempt: 2, error: { category: 'network', maxAttempts: 2, rootCause: 'socket hang up', userAction: '稍后继续' } },
    { action: 'retry', delayMs: 0, attempt: '1', error: { category: 'unknown', maxAttempts: '1', sanitizedMessage: 'boom' } },
    { action: 'wait_reset', delayMs: 90_000, attempt: 1, error: { category: 'billing_quota', code: 'insufficient_quota', userAction: '检查账单' } },
    { action: 'wait_reset', delayMs: Number.NaN, error: { category: 'rate_limit', userAction: '等待' } },
    { action: 'fail_fast', reason: 'unsafe_replay_boundary', error: { code: 'x', httpStatus: 0, source: 'host_interruption', userAction: 'a' } },
    { action: 'fail_fast', reason: 'unsafe_replay_boundary', error: { code: null, httpStatus: '503', source: 'claude_result', rootCause: 'done.', userAction: 'a' } },
    { action: 'fail_fast', reason: 'rate_limit_retried_by_cli', error: { category: 'rate_limit', userAction: 'a' } },
    { action: 'fail_fast', reason: 'retry_budget_exhausted', budgetExhaustedBy: 'attempts', error: { category: 'network', userAction: 'a' } },
    { action: 'fail_fast', reason: 'retry_budget_exhausted', error: { category: 'network', userAction: 'a' } },
    { action: 'fail_fast', reason: 'request_budget_exhausted', budgetExhaustedBy: 'request', error: { category: 'timeout', userAction: 'a' } },
    { action: 'fail_fast', reason: 'cancelled_or_shutdown', error: { category: 'cancel_shutdown', code: 'SIGTERM', userAction: 'a' } },
    { action: 'fail_fast', reason: 'cancelled_or_shutdown', error: { category: 'cancel_shutdown', code: 'unknown', userAction: 'a' } },
    { action: 'fail_fast', reason: 'x', error: { category: 'adapter_configuration', param: 'p', rootCause: 'bad param p', userAction: 'a' } },
    { action: 'fail_fast', reason: 'x', error: { category: 'x', diagnosis: { reason: 'context_overflow' }, rootCause: 'ctx', userAction: 'a' } },
    { action: 'fail_fast', reason: 'x', error: { category: 'adapter_configuration', code: 'bypass_root', userAction: 'a' } },
    { action: 'fail_fast', reason: 'x', error: { category: 'unknown', rootCause: '\ud800broken', param: '\ud800', userAction: '\udfff' } },
  ];
  for (const [index, decision] of decisions.entries()) {
    compare(`retryNotice fixture #${index}`, () => legacy.retryNotice(decision), () => current.retryNotice(decision));
  }
});

test('the synthesized entitlement rejection is shared and frozen, as before', () => {
  const text = 'API Error: Request rejected (429) · Usage credits are required for this model.';
  for (const [label, normalize] of [['legacy', legacy.normalizeApiError], ['native', current.normalizeApiError]]) {
    const first = normalize({ source: 'claude_result', provider: 'claude', httpStatus: 429, message: text }, {}, { now: () => NOW });
    const second = normalize({ source: 'claude_result', provider: 'claude', httpStatus: 429, message: text }, {}, { now: () => NOW });
    assert.equal(first.rejection.kind, 'entitlement', label);
    assert.equal(Object.isFrozen(first.rejection), true, `${label}: rejection is frozen`);
    assert.equal(first.rejection, second.rejection, `${label}: one shared rejection object`);
  }
  const normalized = current.normalizeApiError({ source: 'claude_result', provider: 'claude', httpStatus: 429, message: text }, {}, { now: () => NOW });
  const decision = current.decideApiErrorPolicy(normalized, {}, { now: () => NOW });
  assert.equal(decision.error.rejection, current.normalizeApiError({ source: 'claude_result', provider: 'claude', httpStatus: 429, message: text }, {}, { now: () => NOW }).rejection);
  assert.equal(Object.isFrozen(decision.error.rejection), true);
});

test('a chain head glued onto any accepted boundary is detected', () => {
  const leads = ['Done (see the log above)', 'Done, see the log（上文）', 'Done, see the log「上文」',
    'Done, see the log『上文』', 'Done, see the log”上文”', 'Done, see the log’上文’',
    'Done, see the log"上文"', 'That is wrong!', 'Did it fail?', 'Done.', 'Done;', 'Done:', 'Done：', 'Done；'];
  for (const lead of leads) {
    const text = `${lead}API Error: 502 upstream error: TLS disconnected`;
    const left = legacy.detectErrorEnvelope('claude', text);
    const right = current.detectErrorEnvelope('claude', text);
    assert.deepStrictEqual(outcome(() => right), outcome(() => left), lead);
    assert.ok(right, `${lead} must still be detected`);
  }
});

test('the envelope content cap boundary is exact', () => {
  for (const length of [0, 1, 395, 398, 399, 400, 401, 402, 405, 600]) {
    for (const text of [
      `API Error: ${'x'.repeat(length)}`,
      `正文输出完毕\nAPI Error: 502 ${'y'.repeat(length)}`,
      `正文输出完毕\nAPI Error: 502 upstream error: ${'z'.repeat(length)}`,
    ]) {
      compare(`detect @${length}`, () => legacy.detectErrorEnvelope('claude', text),
        () => current.detectErrorEnvelope('claude', text));
      compare(`split @${length}`, () => legacy.splitTrailingErrorEnvelope(text),
        () => current.splitTrailingErrorEnvelope(text));
      compare(`errorOnly @${length}`, () => legacy.isErrorOnlyText(text),
        () => current.isErrorOnlyText(text));
    }
  }
});

test('Retry-After keeps sub-millisecond and fractional rounding', () => {
  const values = ['0.0005', '0.0004', '0.0006', '0.0015', '0.0014', '1.0005', '1.0004',
    '2.4995', '2.5005', '401.5', 0.0005, 1.0005, 3.3335, '0.5', 0.5, 1.5, 2.5];
  for (const value of values) {
    compare(`parseRetryAfter ${JSON.stringify(value)}`,
      () => legacy.parseRetryAfter(value, NOW), () => current.parseRetryAfter(value, NOW));
    compare(`header ${JSON.stringify(value)}`,
      () => legacy.normalizeApiError({ source: 'claude_result', provider: 'claude', httpStatus: 429, headers: { 'retry-after': value } }, {}, { now: () => NOW }),
      () => current.normalizeApiError({ source: 'claude_result', provider: 'claude', httpStatus: 429, headers: { 'retry-after': value } }, {}, { now: () => NOW }));
  }
});

test('a Headers-like receiver answers only through get', () => {
  const cases = [
    // `get` wins even when it knows nothing: the own entries are never read.
    { get: () => null, 'retry-after': '5' },
    { get: name => (name === 'retry-after' ? '7' : null), 'retry-after': '5' },
    { get: () => '3' },
    { get: () => undefined },
    { get: name => (name === 'x-ratelimit-reset' ? String(Math.floor(NOW / 1000) + 90) : null) },
  ];
  for (const headers of cases) {
    const raw = { source: 'aux_http', httpStatus: 429, message: '429 rate limit', headers };
    compare('normalize reads headers through get',
      () => legacy.normalizeApiError(raw, {}, { now: () => NOW }),
      () => current.normalizeApiError(raw, {}, { now: () => NOW }));
    compare('decide reads headers through get',
      () => legacy.decideApiErrorPolicy(raw, {}, { now: () => NOW, random: () => 0.5 }),
      () => current.decideApiErrorPolicy(raw, {}, { now: () => NOW, random: () => 0.5 }));
  }
});

test('nullish receivers fail the same way', () => {
  for (const raw of [null, undefined]) {
    for (const context of [null, undefined, {}, { source: 'proxy_response' }, { source: 0 }, { provider: 'codex' }]) {
      compare(`normalize(${String(raw)}, ${JSON.stringify(context)})`,
        () => legacy.normalizeApiError(raw, context, { now: () => NOW }),
        () => current.normalizeApiError(raw, context, { now: () => NOW }));
    }
  }
});
