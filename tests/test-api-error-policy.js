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
  isErrorOnlyText,
  splitTrailingErrorEnvelope,
  detectErrorEnvelope,
  isKnownHarmlessStderrLine,
  API_ERROR_SIGNATURES,
  apiErrorSignaturesQuoted,
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

test('normalized errors preserve legacy CLI provider and add immutable route identity', () => {
  const error = normalizeApiError({
    httpStatus: 503,
    source: 'codex_event',
    provider: 'legacy-raw-provider',
  }, {
    cli: 'codex',
    providerId: 'provider-a',
    providerName: 'Provider A',
    providerRouteScope: 'attempt',
    runtimeEpoch: 'runtime-epoch-1',
    turnId: 'turn-1',
    decisionId: 'decision-1',
    routeAttemptId: 'route-attempt-1',
    routeGeneration: 7,
    attemptNo: 2,
    providerRevision: 'revision-a',
    phase: 'before_first_token',
  });
  assert.equal(error.provider, 'codex');
  assert.equal(error.providerId, 'provider-a');
  assert.equal(error.providerName, 'Provider A');
  assert.equal(error.runtimeEpoch, 'runtime-epoch-1');
  assert.equal(error.providerRouteScope, 'attempt');
  assert.equal(error.turnId, 'turn-1');
  assert.equal(error.decisionId, 'decision-1');
  assert.equal(error.routeAttemptId, 'route-attempt-1');
  assert.equal(error.routeGeneration, 7);
  assert.equal(error.attemptNo, 2);
  assert.equal(error.providerRevision, 'revision-a');
  assert.equal(error.safeToRetry, true, 'route identity must not change replay safety');
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

// ── Turn-boundary envelope detection: whole-message + trailing forms ──
// Every text below is a real sample recovered from chat_history or pm2 logs;
// before this detection existed each one was persisted verbatim as an
// assistant message (113 occurrences across 90+ session files).

test('whole-message envelopes beyond the pinned watchdog list are detected as errors', () => {
  // These all reached chat_history as assistant messages because the old
  // claudeErrorEnvelope only knew the five CLI 2.1.x watchdog wordings.
  const samples = [
    ['API Error: Unable to connect to API (ConnectionRefused)', 'network'],
    ['API Error: The model has reached its context window limit.', 'context_token_limit'],
    ['API Error: Request rejected (429) · This request would exceed your account\'s rate limit. Please try again later.', 'rate_limit'],
    ['Failed to authenticate. API Error: 403 用户额度不足, 剩余额度: ＄-2.528834 (request id: 20260630182451514881408268d9d6SaERUZbx)', 'billing_quota'],
    ['API Error: 400 [1211][模型不存在，请检查模型代码。][20260724151208020fa67b8fe54477]', 'invalid_request_model'],
    ['API Error: 500 getaddrinfo ENOTFOUND maas-coding-api.cn-huabei-1.xf-yun.com', 'network'],
  ];
  for (const [message, category] of samples) {
    const envelope = detectErrorEnvelope('claude', message);
    assert.ok(envelope, `whole-message envelope must be detected: ${message.slice(0, 60)}`);
    assert.equal(envelope.body, null, `whole-message envelope has no body: ${message.slice(0, 60)}`);
    assert.equal(envelope.source, 'claude_result');
    const normalized = normalizeApiError(envelope, { source: envelope.source, provider: 'claude' });
    assert.equal(normalized.category, category, message);
  }
  assert.equal(detectErrorEnvelope('codex', 'API Error: The model has reached its context window limit.').source, 'codex_event');
  assert.equal(detectErrorEnvelope('qoder', 'API Error: 400 error, status code: 400').source, 'qoder_result');
  // The CLI boundary swallows upstream response headers, so the status the
  // relay returned is recovered from the envelope text as structured evidence.
  assert.equal(detectErrorEnvelope('claude', 'API Error: 503 The system is busy, please try again later.').httpStatus, 503);
  assert.equal(detectErrorEnvelope('claude', 'API Error: Request rejected (429) · rate limit.').httpStatus, 429);
  assert.equal(detectErrorEnvelope('claude', 'API Error: Connection closed mid-response. The response above may be incomplete.').httpStatus, null);
  const trailingStatus = detectErrorEnvelope('claude', '正文输出完毕。API Error: 502 upstream error: TLS disconnected');
  assert.equal(trailingStatus.httpStatus, 502);
  assert.equal(trailingStatus.body, '正文输出完毕');
});

test('trailing envelopes appended after real output are split into body + error', () => {
  // Real production samples: meaningful body, error envelope bolted on at the
  // end after a sentence/colon boundary.
  const samples = [
    {
      text: '现在更新 `generate_signals` 使用弱势区三角形 + 双路径入场：API Error: 503 The system is busy, please try again later. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:3000).',
      body: '现在更新 `generate_signals` 使用弱势区三角形 + 双路径入场',
      category: 'provider_transient',
    },
    {
      text: '我先快速看一下本地环境（仓库结构、codex 是否安装及其版本/配置），然后开一个 workflow 做并行调研。API Error: Connection closed mid-response. The response above may be incomplete.',
      body: '我先快速看一下本地环境（仓库结构、codex 是否安装及其版本/配置），然后开一个 workflow 做并行调研',
      category: 'network',
    },
    {
      text: '好，我去它的目录里彻底挖一遍：两个 sqlite 数据库、引擎自己的配置解析逻辑，看 auth 到底存哪、零配置能不能跑。Failed to authenticate. API Error: 403 You\'ve reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/code/#pricing',
      body: '好，我去它的目录里彻底挖一遍：两个 sqlite 数据库、引擎自己的配置解析逻辑，看 auth 到底存哪、零配置能不能跑',
      category: 'billing_quota',
    },
  ];
  for (const sample of samples) {
    const envelope = detectErrorEnvelope('claude', sample.text);
    assert.ok(envelope, `trailing envelope must be detected: ${sample.text.slice(-80)}`);
    assert.equal(envelope.body, sample.body, `stripped body must keep the real output: ${sample.text.slice(0, 40)}…`);
    assert.ok(/api error/i.test(envelope.message));
    assert.ok(!envelope.body.includes('API Error'));
    const normalized = normalizeApiError(envelope, { source: envelope.source, provider: 'claude' });
    assert.equal(normalized.category, sample.category, sample.text.slice(-60));
  }
});

test('envelope detection never fires on prose that merely mentions errors', () => {
  assert.equal(detectErrorEnvelope('claude', '好的，我来解释 API Error 的处理方式，以及重试策略。'), null);
  assert.equal(detectErrorEnvelope('claude', '如果看到 API Error: 429 就等一会再重试。'), null);
  assert.equal(detectErrorEnvelope('claude', `${'正文'.repeat(300)}，前面说过 API Error 这个词。`), null);
  assert.equal(detectErrorEnvelope('claude', ''), null);
  assert.equal(detectErrorEnvelope('claude', null), null);
  // A mid-message envelope with real text AFTER it is not a trailing envelope.
  assert.equal(detectErrorEnvelope('claude', '步骤一完成。API Error: 429 rate limited. 不过我已经在步骤二重试成功了，结果如下。'), null);
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

test('circuit identity is cli plus providerId and success clears only that identity', () => {
  const runtime = createApiErrorPolicyRuntime({
    now: () => 5_000,
    random: () => 0,
    circuitThreshold: 2,
  });
  const raw = { httpStatus: 503, source: 'codex_event' };
  const fail = (cli, providerId, idempotencyKey) => runtime.evaluate(raw, {
    source: raw.source,
    provider: cli,
    ...(providerId == null ? {} : { providerId }),
    idempotencyKey,
  });
  const circuit = (cli, providerId) => runtime.snapshot().circuits.find(item => (
    item.cli === cli && item.providerId === providerId
  ));

  fail('codex', 'provider-a', 'a-1');
  assert.equal(fail('codex', 'provider-a', 'a-2').action, 'wait_circuit');
  assert.equal(fail('codex', 'provider-b', 'b-1').action, 'retry');
  assert.equal(circuit('codex', 'provider-a').open, true);
  assert.equal(circuit('codex', 'provider-b').open, false);

  runtime.recordSuccess('codex', { providerId: 'provider-b' });
  assert.equal(circuit('codex', 'provider-a').open, true,
    'a success on provider B must not close provider A');
  runtime.recordSuccess('codex', { providerId: 'provider-a' });
  assert.equal(circuit('codex', 'provider-a').open, false);

  fail('claude', null, 'claude-default-1');
  assert.equal(fail('claude', null, 'claude-default-2').action, 'wait_circuit');
  assert.equal(fail('codex', null, 'codex-default-1').action, 'retry');
  assert.equal(circuit('claude', '_default_').open, true);
  assert.equal(circuit('codex', '_default_').open, false,
    'default routes remain isolated by CLI');
  runtime.recordSuccess('codex');
  assert.equal(circuit('claude', '_default_').open, true,
    'the provider-only compatibility API clears only its CLI default route');
  runtime.recordSuccess('claude');
  assert.equal(circuit('claude', '_default_').open, false);
});

test('known-harmless provider stderr chatter is filtered, real errors are kept', () => {
  // Lines measured from multicc-error.log noise (100+ skill warnings per log,
  // model-refresh timeouts, mid-turn delta warnings). These never affect the
  // turn outcome, so the turn engine drops them before the warn log and the
  // close-time stderr tail.
  const harmless = [
    '2026-08-11T05:55:18.051710Z ERROR codex_core::session::session: failed to load skill [/Users/x/.codex/skills/foo] missing YAML frontmatter delimited by ---',
    '2026-08-11T03:55:19.699334Z ERROR codex_core::session::session: failed to load skill [/Users/x/.codex/skills/bar] missing field `description`',
    '2026-08-11T06:25:18.151557Z ERROR codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit',
    '2026-08-11T07:25:18.305148Z ERROR codex_models_manager::manager: failed to renew cache TTL: EOF while parsing a value at line 1 column 0',
    'codex_core::util: OutputTextDelta without active item',
    'codex_core::util: ReasoningSummaryDelta without active item',
    '2026-08-12T01:02:03.456Z ERROR codex_core::util: Custom tool call output is missing for call id: call_l6W8pqQJxR9axWZ510dKYHcL',
    '2026-08-11T05:00:00.000Z ERROR codex_rollout::list: state db returned stale rollout path for thread 1234: /root/rollout',
    'Reading additional input from stdin...',
    '',
  ];
  for (const line of harmless) {
    assert.equal(isKnownHarmlessStderrLine(line), true, JSON.stringify(line));
  }
  // Real signals that must keep flowing into the warn log and the tail.
  const meaningful = [
    '2026-08-11T05:10:00Z ERROR codex_core::tools::router: error=agent type is currently not available',
    '2026-08-11T05:10:00Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed',
    'stream error: unexpected status 429 Too Many Requests',
    'error: failed to connect to 127.0.0.1:3000: Connection refused',
  ];
  for (const line of meaningful) {
    assert.equal(isKnownHarmlessStderrLine(line), false, JSON.stringify(line));
  }
});

test('the canonical API-error signature list stays in sync with the actual matchers', () => {
  // The classify/push prompts describe the E-state vocabulary by rendering
  // API_ERROR_SIGNATURES. This test pins the invariant that makes that
  // honest: every advertised signature is actually recognized by the policy
  // (error-only prefix OR a specific text-fallback category) when it appears
  // in a trusted provider message.
  for (const sig of API_ERROR_SIGNATURES) {
    const message = `${sig}: request failed before completion`;
    const recognized = isErrorOnlyText(message)
      || normalizeApiError({ message, source: 'claude_result', provider: 'claude' }).category !== 'unknown';
    assert.equal(recognized, true, `unrecognized signature: ${sig}`);
  }
  // The prompts render the same list, so classifier instructions and the
  // detection vocabulary cannot drift apart silently.
  assert.equal(typeof apiErrorSignaturesQuoted(), 'string');
  for (const sig of API_ERROR_SIGNATURES) {
    assert.equal(apiErrorSignaturesQuoted().includes(sig), true);
  }
});
