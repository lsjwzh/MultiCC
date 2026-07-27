'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  normalizeApiError,
  decideApiErrorPolicy,
  createApiErrorPolicyRuntime,
  parseRetryAfter,
  retryNotice,
  claudeErrorEnvelope,
} = require('../src/chat/api-error-policy');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'api-errors-sanitized.json'), 'utf8',
));

function decide(raw, context = {}, deps = {}) {
  return decideApiErrorPolicy(raw, {
    source: raw.source,
    provider: raw.provider,
    phase: 'before_first_token',
    ...context,
  }, { now: () => 1_000_000, random: () => 0, ...deps });
}

test('sanitized production fixture contains no secrets, accounts, paths, or user request bodies', () => {
  assert.equal(fixture.sanitized, true);
  const text = JSON.stringify(fixture);
  assert.doesNotMatch(text, /authorization|bearer\s+|cookie|api[_-]?key|sk-[A-Za-z0-9]/i);
  assert.doesNotMatch(text, /\/Users\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
  assert.equal(fixture.samples.every(sample => !('requestBody' in sample)), true);
});

test('real Claude and Codex samples converge on the same stable taxonomy', () => {
  const categories = fixture.samples.map(sample => normalizeApiError(sample, {
    source: sample.source,
    provider: sample.provider,
    phase: 'before_first_token',
  }).category);
  assert.deepEqual(categories, [
    'authentication_permission',
    'rate_limit',
    'provider_transient',
    'provider_transient',
    'invalid_request_model',
    'rate_limit',
    'provider_transient',
    'provider_transient',
    'unknown',
  ]);
});

test('401/403, billing, invalid request, context, tool/config errors fail fast', () => {
  const cases = [
    [{ httpStatus: 401, source: 'codex_event', provider: 'codex' }, 'authentication_permission'],
    [{ httpStatus: 403, source: 'claude_result', provider: 'claude' }, 'authentication_permission'],
    [{ httpStatus: 402, source: 'aux_http', provider: 'aux-openai' }, 'billing_quota'],
    [{ httpStatus: 400, source: 'codex_event', provider: 'codex' }, 'invalid_request_model'],
    [{ code: 'context_length_exceeded', source: 'claude_result', provider: 'claude' }, 'context_token_limit'],
    [{ code: 'invalid_tool_arguments', source: 'codex_event', provider: 'codex' }, 'tool_protocol'],
    [{ code: 'missing_base_url', source: 'process_stderr', provider: 'opencode' }, 'adapter_configuration'],
  ];
  for (const [raw, category] of cases) {
    const result = decide(raw);
    assert.equal(result.error.category, category);
    assert.equal(result.action, 'fail_fast');
  }
});

test('trusted quota/context details refine generic HTTP status without overriding explicit auth', () => {
  const quota403 = decide({
    httpStatus: 403,
    message: 'You have reached your usage limit for this billing cycle; quota will refresh next cycle.',
    source: 'claude_result',
    provider: 'claude',
  });
  assert.equal(quota403.error.category, 'billing_quota');
  assert.equal(quota403.action, 'fail_fast');

  const structuredQuota403 = decide({
    httpStatus: 403,
    code: 'quota_exceeded',
    source: 'codex_event',
    provider: 'codex',
  });
  assert.equal(structuredQuota403.error.category, 'billing_quota');

  const explicitAuth403 = decide({
    httpStatus: 403,
    code: 'permission_denied',
    message: 'usage limit is shown in unrelated diagnostic text',
    source: 'claude_result',
    provider: 'claude',
  });
  assert.equal(explicitAuth403.error.category, 'authentication_permission');

  const context400 = decide({
    httpStatus: 400,
    message: 'Maximum context window exceeded: too many tokens in this request.',
    source: 'codex_event',
    provider: 'codex',
  });
  assert.equal(context400.error.category, 'context_token_limit');
  assert.equal(context400.action, 'fail_fast');
});

test('local CLI launch failures are configuration errors and never auto-retry', () => {
  const cases = [
    { code: 'EACCES', message: 'spawn bridge EACCES' },
    { code: 'ENOENT', message: 'spawn bridge ENOENT' },
    { code: 'ENOEXEC', message: 'spawn bridge ENOEXEC' },
    { code: -13, message: 'spawn failed' },
    { message: 'ZCode 无响应（exit -13）' },
  ];
  for (const raw of cases) {
    const result = decide({
      ...raw,
      source: 'process_stderr',
      provider: 'zcode',
    });
    assert.equal(result.error.category, 'adapter_configuration', JSON.stringify(raw));
    assert.equal(result.error.retryable, false, JSON.stringify(raw));
    assert.equal(result.action, 'fail_fast', JSON.stringify(raw));
    assert.equal(result.error.maxAttempts, 0, JSON.stringify(raw));
  }
});

test('429 honors Retry-After without jitter and long reset windows do not short-loop', () => {
  assert.equal(parseRetryAfter('7', 0), 7_000);
  const short = decide({
    httpStatus: 429, headers: { 'Retry-After': '7' },
    source: 'claude_result', provider: 'claude',
  });
  assert.equal(short.action, 'retry');
  assert.equal(short.delayMs, 7_000);
  assert.equal(short.reason, 'server_retry_after');
  const long = decide({
    httpStatus: 429, retryAfterMs: 600_000,
    source: 'codex_event', provider: 'codex',
  });
  assert.equal(long.action, 'wait_reset');
  assert.equal(long.delayMs, 600_000);
  const quota = decide({
    httpStatus: 402, retryAfterMs: 3_600_000,
    source: 'aux_http', provider: 'aux-openai',
  });
  assert.equal(quota.action, 'wait_reset');
  assert.equal(quota.retryAt, 4_600_000);
});

test('5xx and network retry with bounded exponential backoff and budget', () => {
  const first = decide({
    httpStatus: 503, source: 'claude_result', provider: 'claude',
  });
  assert.equal(first.action, 'retry');
  assert.equal(first.attempt, 1);
  assert.equal(first.delayMs, 1_000);
  const second = decide({
    code: 'ECONNRESET', source: 'codex_event', provider: 'codex',
  }, { attempt: 1 });
  assert.equal(second.action, 'retry');
  assert.equal(second.attempt, 2);
  assert.equal(second.delayMs, 2_000);
  const exhausted = decide({
    httpStatus: 503, source: 'claude_result', provider: 'claude',
  }, { attempt: 2 });
  assert.equal(exhausted.action, 'fail_fast');
  assert.equal(exhausted.reason, 'retry_budget_exhausted');
});

test('timeout phase and partial output/tool side effects forbid blind whole-turn replay', () => {
  const connect = decide({
    code: 'CONNECT_TIMEOUT', source: 'codex_event', provider: 'codex',
  }, { phase: 'connect' });
  assert.equal(connect.action, 'retry');
  const partial = decide({
    code: 'READ_TIMEOUT', source: 'claude_result', provider: 'claude',
  }, { phase: 'stream', partialOutput: true });
  assert.equal(partial.action, 'fail_fast');
  assert.equal(partial.reason, 'unsafe_replay_boundary');
  const tool = decide({
    httpStatus: 503, source: 'codex_event', provider: 'codex',
  }, { phase: 'before_first_token', sideEffects: true });
  assert.equal(tool.action, 'fail_fast');
  assert.equal(retryNotice(tool).includes('未自动重放'), true);
});

test('cancellation and shutdown never retry; unknown gets at most one controlled retry', () => {
  for (const code of ['user_cancel', 'shutdown', 'SIGTERM']) {
    const result = decide({ code, source: 'process_stderr', provider: 'codex' });
    assert.equal(result.error.category, 'cancel_shutdown');
    assert.equal(result.action, 'fail_fast');
  }
  const first = decide({ message: 'opaque upstream failure', source: 'opencode_event', provider: 'opencode' });
  assert.equal(first.action, 'retry');
  assert.equal(first.error.category, 'unknown');
  const second = decide({
    message: 'opaque upstream failure', source: 'opencode_event', provider: 'opencode',
  }, { attempt: 1 });
  assert.equal(second.action, 'fail_fast');
});

test('elapsed retry budget stops even the bounded unknown fallback', () => {
  const raw = {
    message: 'opaque upstream failure',
    source: 'opencode_event',
    provider: 'opencode',
  };
  const withinBudget = decide(raw, { elapsedMs: 119_999 });
  assert.equal(withinBudget.error.category, 'unknown');
  assert.equal(withinBudget.action, 'retry');
  assert.equal(withinBudget.attempt, 1);

  const exhausted = decide(raw, { elapsedMs: 120_000 });
  assert.equal(exhausted.error.category, 'unknown');
  assert.equal(exhausted.action, 'fail_fast');
  assert.equal(exhausted.reason, 'retry_budget_exhausted');
});

test('untrusted text cannot smuggle a retryable category and public messages are sanitized', () => {
  const error = normalizeApiError({
    message: '503 Bearer secret-token authorization=secret /Users/person/private.json',
    source: 'browser_user_text',
    provider: 'unknown',
  }, { phase: 'before_first_token' });
  assert.equal(error.category, 'unknown');
  assert.doesNotMatch(error.sanitizedMessage, /secret-token|\/Users\/person/);
});

test('Claude CLI 2.1.x stream-watchdog envelopes are detected and classified', () => {
  const cases = [
    ['API Error: Response stalled mid-stream. The response above may be incomplete.', 'timeout', 'response_stalled_mid_stream'],
    ['API Error: Response stalled while thinking, before producing a response. Try again.', 'timeout', 'response_stalled_before_response'],
    ['API Error: Server error mid-response. The response above may be incomplete.', 'provider_transient', 'server_error_mid_response'],
    ['API Error: Connection closed mid-response. The response above may be incomplete.', 'network', 'connection_closed_mid_response'],
    ['API Error: Connection closed while thinking, before producing a response. Try again.', 'network', 'connection_closed_before_response'],
  ];
  for (const [message, category, code] of cases) {
    const envelope = claudeErrorEnvelope('claude', message);
    assert.ok(envelope, `envelope must be detected: ${message}`);
    assert.equal(envelope.code, code);
    assert.equal(envelope.source, 'claude_result');
    assert.equal(envelope.provider, 'claude');
    const normalized = normalizeApiError(envelope, {
      source: envelope.source, provider: 'claude', phase: 'before_first_token',
    });
    assert.equal(normalized.category, category, message);
    assert.equal(normalized.retryable, true, message);
  }
  assert.equal(claudeErrorEnvelope('qoder', 'API Error: Response stalled mid-stream. The response above may be incomplete.').source, 'qoder_result');
});

test('watchdog envelope detection never fires on meaningful assistant output', () => {
  assert.equal(claudeErrorEnvelope('claude', '好的，我来解释 API Error 的处理方式，以及重试策略。'), null);
  assert.equal(claudeErrorEnvelope('claude', ''), null);
  assert.equal(claudeErrorEnvelope('claude', null), null);
  const withRealOutput = '已经完成了第一步。\nAPI Error: Response stalled mid-stream. The response above may be incomplete.';
  assert.equal(claudeErrorEnvelope('claude', withRealOutput), null);
  assert.equal(claudeErrorEnvelope('claude', `${'x'.repeat(700)} API Error: Response stalled mid-stream.`), null);
});

test('stalled mid-stream with partial output fails fast at the replay boundary; stalled while thinking retries once', () => {
  const midStream = claudeErrorEnvelope('claude', 'API Error: Response stalled mid-stream. The response above may be incomplete.');
  const partial = decide({ ...midStream }, { phase: 'stream', partialOutput: true });
  assert.equal(partial.action, 'fail_fast');
  assert.equal(partial.reason, 'unsafe_replay_boundary');
  const whileThinking = claudeErrorEnvelope('claude', 'API Error: Response stalled while thinking, before producing a response. Try again.');
  const first = decide({ ...whileThinking });
  assert.equal(first.action, 'retry');
  assert.equal(first.attempt, 1);
  assert.equal(first.error.maxAttempts, 1);
  const second = decide({ ...whileThinking }, { attempt: 1 });
  assert.equal(second.action, 'fail_fast');
  assert.equal(second.reason, 'retry_budget_exhausted');
});

test('structured watchdog, stale-connection and server_error codes classify without text evidence', () => {
  const cases = [
    [{ code: 'watchdog', source: 'claude_result', provider: 'claude', message: '' }, 'timeout'],
    [{ code: 'stream_idle_timeout', source: 'claude_result', provider: 'claude', message: '' }, 'timeout'],
    [{ code: 'stale_connection', source: 'claude_result', provider: 'claude', message: '' }, 'network'],
    [{ code: 'network_down', source: 'claude_result', provider: 'claude', message: '' }, 'network'],
    [{ code: 'server_error', source: 'claude_result', provider: 'claude', message: '' }, 'provider_transient'],
    [{ code: 'overloaded_error', source: 'claude_result', provider: 'claude', message: '' }, 'provider_transient'],
  ];
  for (const [raw, category] of cases) {
    assert.equal(normalizeApiError(raw, {
      source: raw.source, provider: raw.provider, phase: 'before_first_token',
    }).category, category, String(raw.code));
  }
});

test('runtime deduplicates repeated events, opens provider circuit, and exposes aggregate metrics', () => {
  const logs = [];
  const metrics = new Map();
  const runtime = createApiErrorPolicyRuntime({
    now: () => 5_000,
    random: () => 0,
    circuitThreshold: 3,
    logger: {
      info(event, fields) { logs.push({ event, fields }); },
      warn(event, fields) { logs.push({ event, fields }); },
      error(event, fields) { logs.push({ event, fields }); },
    },
    metrics: {
      inc(name) { metrics.set(name, (metrics.get(name) || 0) + 1); },
      set() {},
    },
  });
  const raw = { httpStatus: 503, source: 'claude_result', provider: 'claude' };
  const one = runtime.evaluate(raw, { source: raw.source, provider: raw.provider, idempotencyKey: 'turn-1' });
  const duplicate = runtime.evaluate(raw, { source: raw.source, provider: raw.provider, idempotencyKey: 'turn-1' });
  assert.equal(one.action, 'retry');
  assert.equal(duplicate.duplicate, true);
  runtime.evaluate(raw, { source: raw.source, provider: raw.provider, idempotencyKey: 'turn-2' });
  const open = runtime.evaluate(raw, { source: raw.source, provider: raw.provider, idempotencyKey: 'turn-3' });
  assert.equal(open.action, 'wait_circuit');
  assert.equal(runtime.snapshot().circuits[0].open, true);
  assert.equal(logs.length, 3);
  assert.equal(metrics.get('multicc_api_error_circuit_open_total'), 1);
  runtime.recordSuccess('claude', { retryAttempt: 1 });
  assert.equal(runtime.snapshot().circuits[0].open, false);
  assert.equal(metrics.get('multicc_api_error_retry_succeeded_total'), 1);
});
