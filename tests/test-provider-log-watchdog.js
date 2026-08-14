'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createProviderLogWatchdog,
  sanitizeWithUrls,
  extractErrorText,
  parseResetDelayMs,
  opencodeRateLimitInfoFromError,
} = require('../src/chat/provider-log-watchdog');

// Regression suite for the provider-log watchdog: opencode swallows provider
// stream errors (quota/auth/billing) into its own log — no stdout event, empty
// stderr, no exit. The watchdog must surface the correlated error once and end
// the turn, without touching healthy slow starts or other sessions' errors.

const QUOTA_ERROR = 'AI_APICallError: Weekly usage limit reached. Resets in 2 days. '
  + 'To continue using this model now, enable usage from your available balance: '
  + 'https://opencode.ai/workspace/wrk_01KWCDPN4GC6QA5325NCTC1AE9/go';

const AT = Date.parse('2026-08-14T09:42:30.000Z');

function logLine({ ts, level = 'INFO', run = 'aaaa1111', message, sessionId = '', directory = '', error = '' }) {
  let line = `timestamp=${new Date(ts).toISOString()} level=${level} run=${run}`;
  if (message) line += ` message=${/\s/.test(message) ? `"${message}"` : message}`;
  if (sessionId) line += ` session.id=${sessionId}`;
  if (directory) line += ` directory=${directory}`;
  if (error) line += ` error.error="${error}"`;
  return line;
}

function fixture(options = {}) {
  const at = options.at ?? AT;
  const turnStart = options.turnStart ?? at - 40_000;
  const cs = options.cs ?? {
    isStreaming: true,
    turnStartedAt: turnStart,
    lastStreamAt: options.lastStreamAt ?? turnStart,
    cwd: options.cwd ?? '/work/session',
    cli: 'opencode',
    streamReplay: [],
    _activeTurn: { turnId: options.turnId ?? 'turn_1' },
    _activeRunner: {},
  };
  const record = options.record ?? {
    id: 's1', kind: 'chat', type: 'chat', cli: 'opencode',
    cliSessionId: options.cliSessionId ?? 'ses_native1',
    provider: 'opencodego',
  };
  const broadcasts = [];
  const cancelCalls = [];
  const watchdog = createProviderLogWatchdog({
    listRecords: () => new Map([['s1', record]]).entries(),
    getChatSession: () => cs,
    broadcast: (id, evt) => broadcasts.push([id, evt]),
    cancelTurn: async (id, cancelOptions) => {
      cancelCalls.push([id, cancelOptions]);
      return { ok: true, classifyState: 'E' };
    },
    readLogTail: () => options.logTail ?? '',
    now: () => at,
    minSilenceMs: options.minSilenceMs ?? 20_000,
    logger: { warn() {} },
  });
  return { watchdog, cs, record, broadcasts, cancelCalls, at, turnStart };
}

test('quota error without stdout/exit is surfaced once and the turn is ended', async () => {
  const { watchdog, cs, broadcasts, cancelCalls, at } = fixture({
    logTail: logLine({ ts: AT - 9_000, level: 'ERROR', message: 'stream error', sessionId: 'ses_native1', error: QUOTA_ERROR }),
  });
  const { results } = await watchdog.sweep();
  assert.equal(results[0].action, 'surfaced_and_cancelled');
  assert.equal(broadcasts.length, 2);
  const [limitId, limitEvt] = broadcasts[0];
  assert.equal(limitId, 's1');
  assert.equal(limitEvt.type, 'rate_limit_event');
  assert.deepEqual(limitEvt.rate_limit_info, {
    rateLimitType: 'weekly',
    status: 'rejected',
    utilization: 1,
    resetsAt: Math.trunc((at + 2 * 86_400_000) / 1000),
    provider: 'opencode',
  });
  assert.ok(limitEvt.bar.text.includes('OpenCode Go · 1wk 0%'), 'weekly OpenCode bar visible');
  const [id, evt] = broadcasts[1];
  assert.equal(id, 's1');
  assert.equal(evt.type, 'error');
  assert.ok(evt.error.includes('Weekly usage limit reached'), 'quota text visible');
  assert.ok(evt.error.includes('Resets in 2 days'), 'reset info visible');
  assert.ok(evt.error.includes('https://opencode.ai/workspace/'), 'safe action link kept');
  assert.equal(cancelCalls.length, 1);
  assert.equal(cancelCalls[0][1].killReason, 'provider_log_error');
  assert.equal(cancelCalls[0][1].source, 'opencode_log_watchdog');
  // Close-time classification flags mirror the stdout error path.
  assert.ok(cs._adapterError.includes('Weekly usage limit reached'));
  assert.equal(cs._activeRunner.sawApiError, true);
  assert.equal(cs._activeRunner.apiErrorRaw.source, 'opencode_log');
  assert.equal(cs.streamReplay.at(-1).type, 'error');
});

test('errors of other native sessions are ignored', async () => {
  const { watchdog, broadcasts, cancelCalls } = fixture({
    logTail: logLine({ ts: Date.parse('2026-08-14T09:42:21.000Z'), level: 'ERROR', message: 'stream error', sessionId: 'ses_somebody_else', error: QUOTA_ERROR }),
  });
  const { results } = await watchdog.sweep();
  assert.equal(results[0].action, 'clean');
  assert.equal(broadcasts.length, 0);
  assert.equal(cancelCalls.length, 0);
});

test('normal slow start with no correlated ERROR line is left alone', async () => {
  const { watchdog, broadcasts, cancelCalls, turnStart, at } = fixture({
    logTail: [
      logLine({ ts: AT - 40_000 + 1000, message: 'process', sessionId: 'ses_native1' }),
      logLine({ ts: AT - 40_000 + 1100, message: 'stream', sessionId: 'ses_native1' }),
      logLine({ ts: AT - 1000, message: 'cleanup prune=7.days'.replace(' ', '='), sessionId: 'ses_native1' }),
    ].join('\n'),
  });
  const { results } = await watchdog.sweep();
  assert.equal(results[0].action, 'clean');
  assert.equal(broadcasts.length, 0);
  assert.equal(cancelCalls.length, 0);
});

test('the same error is shown exactly once across sweeps', async () => {
  const { watchdog, broadcasts, cancelCalls, at } = fixture({
    logTail: logLine({ ts: AT - 9_000, level: 'ERROR', message: 'stream error', sessionId: 'ses_native1', error: QUOTA_ERROR }),
  });
  await watchdog.sweep();
  const second = await watchdog.sweep();
  assert.equal(second.results[0].action, 'skip');
  assert.equal(second.results[0].reason, 'already_surfaced');
  assert.equal(broadcasts.length, 2);
  assert.equal(cancelCalls.length, 1);
});

test('stdout error path already displayed -> watchdog stays silent', async () => {
  const { watchdog, cs, broadcasts, cancelCalls, at } = fixture({
    logTail: logLine({ ts: AT - 9_000, level: 'ERROR', message: 'stream error', sessionId: 'ses_native1', error: QUOTA_ERROR }),
  });
  cs._adapterError = 'Weekly usage limit reached. Resets in 2 days.'; // set by the stdout JSON error branch
  const { results } = await watchdog.sweep();
  assert.equal(results[0].reason, 'adapter_error_present');
  assert.equal(broadcasts.length, 0);
  assert.equal(cancelCalls.length, 0);
});

test('error from a previous turn (before the current window) is ignored', async () => {
  const { watchdog, broadcasts, cancelCalls, turnStart } = fixture({
    logTail: logLine({ ts: AT - 40_000 - 60_000, level: 'ERROR', message: 'stream error', sessionId: 'ses_native1', error: QUOTA_ERROR }),
  });
  const { results } = await watchdog.sweep();
  assert.equal(results[0].action, 'clean');
  assert.equal(broadcasts.length, 0);
  assert.equal(cancelCalls.length, 0);
});

test('first turn without native session id correlates via cwd + run id', async () => {
  const at = AT;
  const turnStart = at - 40_000;
  const tail = [
    logLine({ ts: AT - 40_000 + 500, run: 'run_this', message: 'creating instance', directory: '/work/session' }),
    logLine({ ts: AT - 40_000 + 501, run: 'run_other', message: 'creating instance', directory: '/work/other-session' }),
    logLine({ ts: AT - 9_000, run: 'run_other', level: 'ERROR', message: 'stream error', error: QUOTA_ERROR }),
  ].join('\n');
  const quiet = fixture({ cliSessionId: '', logTail: tail, at, turnStart });
  const quietRun = await quiet.watchdog.sweep();
  assert.equal(quietRun.results[0].action, 'clean', 'other directory/run error ignored');
  assert.equal(quiet.broadcasts.length, 0);

  const hitTail = tail + '\n' + logLine({ ts: AT - 8_000, run: 'run_this', level: 'ERROR', message: 'stream error', error: QUOTA_ERROR });
  const hit = fixture({ cliSessionId: '', logTail: hitTail, at, turnStart });
  const hitRun = await hit.watchdog.sweep();
  assert.equal(hitRun.results[0].action, 'surfaced_and_cancelled');
  assert.equal(hitRun.results[0].reason, 'correlated_error');
  assert.equal(hit.broadcasts.length, 2);
  assert.equal(hit.broadcasts[0][1].type, 'rate_limit_event');
  assert.equal(hit.broadcasts[1][1].type, 'error');
});

test('active streaming (recent output) does not trigger a scan', async () => {
  const { watchdog, broadcasts, cancelCalls, at } = fixture({
    lastStreamAt: AT - 1_000, // well inside the silence gate
    logTail: logLine({ ts: AT - 9_000, level: 'ERROR', message: 'stream error', sessionId: 'ses_native1', error: QUOTA_ERROR }),
  });
  const { results } = await watchdog.sweep();
  assert.equal(results[0].reason, 'active_stream');
  assert.equal(broadcasts.length, 0);
  assert.equal(cancelCalls.length, 0);
});

test('non-opencode, aux and gateway sessions are never scanned', async () => {
  const claudeRecord = { id: 's2', kind: 'chat', type: 'chat', cli: 'claude', cliSessionId: 'x' };
  const broadcasts = [];
  const watchdog = createProviderLogWatchdog({
    listRecords: () => new Map([
      ['s2', claudeRecord],
      ['s3', { id: 's3', kind: 'chat', type: 'aux', cli: 'opencode' }],
      ['s4', { id: 's4', kind: 'chat', type: 'gateway', cli: 'opencode' }],
    ]).entries(),
    getChatSession: () => ({ isStreaming: true, turnStartedAt: 1, lastStreamAt: 1 }),
    broadcast: (id, evt) => broadcasts.push([id, evt]),
    cancelTurn: async () => ({ ok: true }),
    readLogTail: () => logLine({ ts: 1_700_000_000_000, level: 'ERROR', sessionId: 'x', error: 'boom' }),
    now: () => 1_800_000_000_000,
    logger: { warn() {} },
  });
  const { results } = await watchdog.sweep();
  assert.equal(results.length, 1, 'aux/gateway filtered before inspect');
  assert.equal(results[0].reason, 'not_watched_cli');
  assert.equal(broadcasts.length, 0);
});

test('sanitizeWithUrls keeps provider action URLs and redacts secrets', () => {
  const raw = `${QUOTA_ERROR} key=sk-live-abcdef1234567890`;
  const sanitized = sanitizeWithUrls(raw);
  assert.ok(sanitized.includes('https://opencode.ai/workspace/wrk_01KWCDPN4GC6QA5325NCTC1AE9/go'));
  assert.ok(!sanitized.includes('sk-live-abcdef1234567890'));
  assert.ok(sanitized.length > 0);
});

test('extractErrorText parses quoted and unquoted error fields', () => {
  const quoted = 'timestamp=2026-08-14T09:42:21.487Z level=ERROR run=a message="stream error" error.error="AI_APICallError: Weekly usage limit reached."';
  assert.equal(extractErrorText(quoted), 'AI_APICallError: Weekly usage limit reached.');
  const unquoted = 'timestamp=x level=ERROR run=a error.error=boom';
  assert.equal(extractErrorText(unquoted), 'boom');
  assert.equal(extractErrorText('timestamp=x level=ERROR run=a message=plain'), '');
});

test('OpenCode weekly limit text becomes a rejected weekly quota event', () => {
  assert.equal(parseResetDelayMs('Weekly usage limit reached. Resets in 2 days.'), 2 * 86_400_000);
  assert.equal(parseResetDelayMs('Resets in 1 day 3 hours 30 minutes.'), 99_000_000);
  const info = opencodeRateLimitInfoFromError(QUOTA_ERROR, AT);
  assert.deepEqual(info, {
    rateLimitType: 'weekly',
    status: 'rejected',
    utilization: 1,
    resetsAt: Math.trunc((AT + 2 * 86_400_000) / 1000),
    provider: 'opencode',
  });
  assert.equal(opencodeRateLimitInfoFromError('plain auth error', AT), null);
});
