'use strict';

// Regression tests for the 2026-11-03 resident-Claude incident: a held turn's
// background self-wake (task-notification) got HTTP 429, the synthetic
// "API Error: …" assistant message was appended to the answer, and the held
// turn was released as SUCCESS. The last upstream request of the turn decides
// (background-hold), and the synthetic message is structured evidence handled
// by src/chat/claude-api-error-message.js rather than model output.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createChatTurnEngine } = require('../src/chat/turn-engine');
const { createClaudeAdapter } = require('../src/cli-adapters/claude');
const { createAdapterCompletion } = require('../src/cli-adapters/completion');
const { createBackgroundHold } = require('../src/chat/background-hold');
const { isMainResult } = require('../src/cli-adapters/result-completion');
const { detectErrorEnvelope } = require('../src/chat/api-error-policy');
const { apiErrorMessageOf } = require('../src/chat/claude-api-error-message');

const noop = () => {};
const ENVELOPE = "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.";
const BODY = '巡检照常：19:00 整点，21:00 起每 15 分钟一次。';
const AUTO_TURN = { enabled: false, failover: () => null, prepareHandoff: () => null, recordSuccess: noop };

function build({ replayFence = 'visible_output', onPersist = noop, onUsage = noop } = {}) {
  const adapter = createClaudeAdapter({
    resolveSessionWireModel: v => v, claudeDefaultModel: () => null,
    cliEffortLevel: () => null, normalizeEffort: () => null,
  });
  const persisted = { id: 'sess', cli: 'claude', model: 'opus' };
  const chatSessions = new Map();
  const writes = [], decisions = [], classified = [], forwarded = [];
  const attempt = { cli: 'claude', runtimeEpoch: 'epoch-1', turnId: 'turn-1', decisionId: 'decision-1',
    routeAttemptId: 'attempt-1', routeGeneration: 1, attemptNo: 1, providerId: 'provider-1',
    providerRevision: 'revision-1', sessionId: 'sess' };
  const engine = createChatTurnEngine({
    persistedSessions: new Map([['sess', persisted]]), chatSessions,
    isCurrentTurnRunner: (cs, turn, runner) => cs._activeTurn === turn && cs._activeRunner === runner,
    providerAttemptRuntime: {
      scrubAttemptStructure: (_r, e) => e, scrubAttemptEvent: (_r, e) => e,
      acceptEvent: () => true, observeEvent: (r, e) => ({ ...r, accepted: true, event: e }),
      proxyFailure: () => null, snapshot: () => ({ replayFence }), finishAttempt: () => null,
    },
    turnProgressHeartbeat: { touchActivity: noop, updatePhase: noop, touchVisible: noop, stop: noop, start: noop },
    noteReportedModel: noop, setSessionStatus: noop, scheduleIncrementalSave: noop,
    getChatHistoryRuntime: () => ({ clearIncrementalSave: noop, scheduleIncrementalSave: noop }),
    getBackgroundTaskRuntime: () => ({ recordMainToolUseId: noop, markTaskOutputAwaiting: noop,
      handleEvent: noop, hasProcessBackgroundTasks: () => false }),
    persistFinalAssistantResult: (sessionId, state, turn, runner, message) => {
      writes.push({ content: String(message.content || ''), partial: !!message.partial });
      if (message.partial !== true) { turn.resultDurable = true; turn.resultRunnerId = runner.runnerId; }
      onPersist(state, turn, runner);
      return true;
    },
    recordDurableTurnUsage: (...args) => { onUsage(...args); return true; },
    modelAttributionField: () => ({}), turnTimingsField: () => ({}), usageLimitPoller: { onTurnComplete: noop },
    logger: { warn: noop, info: noop, error: noop }, chatBroadcast: noop, loadChatHistory: () => [],
    taskContextHost: { turnOptions: o => o, restore: () => null }, savePersistedSessionsBestEffort: noop,
    cancelClassify: noop, emitTurnOutcome: noop, runDurablePostTurn: noop,
    classifyTurnEnd: (cs, sessionName, entry) => classified.push(entry),
    getSessionWorkHost: () => ({ turnSucceeded: noop, turnFailed: () => Promise.resolve() }),
    getSessionGitRuntime: () => null,
    getWorkspaceAdmission: () => ({ starting: noop, spawned: noop, finalized: noop }),
    evaluateTurnApiError: input => {
      decisions.push(input);
      return { action: 'finalize', error: { category: input.raw?.httpStatus === 429 ? 'rate_limit' : 'unknown' } };
    },
    meaningfulTurnOutput: cs => !!(cs.currentAssistantText || cs.currentToolCalls.length),
    turnHasSideEffects: () => false,
    clearSessionApiErrorState: noop, recordApiSuccess: noop, codexUsageHost: { complete: noop },
    assistantCheckpointKey: () => 'checkpoint-1', getPort: () => 3000,
  });
  const cs = { cli: 'claude', clients: new Set(), chatTurnCount: 0, currentAssistantText: '',
    currentToolCalls: [], currentCost: null, streamReplay: [], turnStartedAt: Date.now(), isStreaming: true };
  const turn = { turnId: 'turn-1', sessionId: 'sess' };
  const runner = { runnerId: 'stream_1', completionOutcome: null, pendingClaudeResult: null,
    completion: createAdapterCompletion(adapter), providerAttempt: attempt, sawApiError: false,
    adapterError: null, killReason: null, apiErrorRaw: null, retryPlanned: false, resultEvent: false,
    pendingUsage: null };
  cs._activeTurn = turn; cs._activeRunner = runner; cs._streamTurnSeq = 1;
  const forward = evt => { forwarded.push(evt); return true; };
  return { engine, adapter, cs, persisted, turn, runner, forward, writes, decisions, classified, forwarded, chatSessions };
}

const textEvent = (text, extra = {}) => ({ type: 'assistant', parent_tool_use_id: null,
  message: { model: '<synthetic>', content: [{ type: 'text', text }] }, ...extra });
const realAnswer = text => ({ type: 'assistant', parent_tool_use_id: null,
  message: { model: 'claude-opus', content: [{ type: 'text', text }] } });
const toolUse = () => ({ type: 'assistant', parent_tool_use_id: null,
  message: { model: 'claude-opus', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }] } });
const mainResult = resultText => ({ type: 'result', parent_tool_use_id: null, subtype: 'success',
  is_error: false, result: resultText, usage: { input_tokens: 5 }, total_cost_usd: 0.1 });
const synthetic429 = extra => textEvent(ENVELOPE, { is_api_error_message: true, api_error_status: 429,
  error: 'rate_limit', request_id: 'req_1', uuid: 'uuid-1', ...extra });
const wakeFailure = (resultText = ENVELOPE) => ({ type: 'result', subtype: 'success', is_error: true,
  terminal_reason: 'api_error', api_error_status: 429, result: resultText,
  origin: { kind: 'task-notification' }, usage: { input_tokens: 9 }, total_cost_usd: 0.2 });
const wakeSuccess = resultText => ({ type: 'result', subtype: 'success', is_error: false, result: resultText,
  origin: { kind: 'task-notification' }, usage: { input_tokens: 9 }, total_cost_usd: 0.2 });
// The main query's own failure result (no task-notification origin).
const mainFailure = (resultText = ENVELOPE) => ({ type: 'result', parent_tool_use_id: null, subtype: 'success',
  is_error: true, terminal_reason: 'api_error', api_error_status: 429, result: resultText,
  usage: { input_tokens: 9 }, total_cost_usd: 0.2 });
const userEvent = text => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });

// Mirrors claude-sdk-stream.js consume(): a main result starts the hold and
// every later event is swallowed into that turn.
function runStream(env, events, { hold = true } = {}) {
  const item = { sent: true, finishing: false, cancelled: false, hold: null,
    onEvent: evt => env.engine.applyAdapterChatEvent(env.adapter, env.cs, env.persisted, 'sess', evt,
      env.forward, env.turn, env.runner) };
  for (const evt of events) {
    if (item.hold?.held && item.hold.observe(evt)) continue;
    if (isMainResult(evt) && !item.cancelled && hold) {
      item.hold ||= createBackgroundHold({ hasBackground: () => true, quietMs: 10, tickMs: 5, release: noop });
      if (item.hold.start(evt)) continue;
    }
    item.onEvent(evt);
  }
  return item;
}

async function release(env, item) {
  const released = item.hold ? item.hold.flush() : null;
  if (released) item.onEvent(released);
  env.runner.completionOutcome = env.runner.completion.finish({ kind: 'stream', resolved: true });
  await env.engine.finalizeStreamingTurn('sess', env.cs, env.persisted, 1, env.turn, env.runner, {},
    env.adapter, () => ({}), AUTO_TURN);
  return released;
}

const errorFrameCount = (env, text = ENVELOPE) => env.forwarded.filter(frame => JSON.stringify(frame).includes(text)).length;
const bodyWrites = writes => writes.filter(write => write.content.trim());

test('a stale result callback cannot mutate or broadcast into the replacement runner', async () => {
  for (const boundary of ['append', 'usage', 'session-replaced', 'session-deleted']) {
    let env;
    const replace = () => {
      if (boundary === 'session-replaced') { env.chatSessions.set('sess', { _resultSaved: 'replacement' }); return; }
      if (boundary === 'session-deleted') { env.chatSessions.delete('sess'); return; }
      env.cs._activeRunner = { runnerId: 'replacement', turnId: env.turn.turnId };
      env.cs._resultSaved = 'replacement';
      env.cs.chatTurnCount = 37;
    };
    env = build({ onPersist: boundary !== 'usage' ? replace : noop,
      onUsage: boundary === 'usage' ? replace : noop });
    if (boundary.startsWith('session-')) {
      env.chatSessions.set('sess', env.cs);
      env.cs._resultSaved = 'replacement';
      env.cs.chatTurnCount = 37;
    }
    env.cs.currentAssistantText = BODY;
    env.runner.completionOutcome = { version: 1, state: 'completed', settled: true };
    env.engine.applyClaudeChatEvent(env.cs, 'sess', mainResult(BODY), env.forward, env.turn, env.runner);
    // The append verdict returns through the async commit entry; wait for the
    // same durable-confirmation point the production caller awaits.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(env.writes.length, 1, 'the original history append completed');
    assert.equal(env.cs._resultSaved, 'replacement');
    assert.equal(env.cs.chatTurnCount, 37);
    assert.equal(env.forwarded.some(event => event.type === 'result'), false);
  }
});

test('held turn: a 429 self-wake finalizes as an API error and keeps the envelope out of the answer', async () => {
  const env = build();
  const item = runStream(env, [userEvent('do the thing'), realAnswer(BODY), toolUse(), mainResult(BODY),
    userEvent('<task-notification>wake'), synthetic429(), wakeFailure()]);
  const released = await release(env, item);
  assert.equal(released.background_wake_failed, true);
  assert.equal(released.is_error, true);
  assert.equal(released.terminal_reason, 'api_error');
  assert.notEqual(released.origin?.kind, 'task-notification', 'the main result identity is kept');
  assert.equal(env.runner.completionOutcome.state, 'failed', 'the turn is not reported as succeeded');
  assert.equal(errorFrameCount(env), 0, 'the suppressed synthetic message is never forwarded');
  assert.equal(env.decisions.length, 1);
  const decision = env.decisions[0];
  assert.equal(decision.partialOutput, true, 'the main answer is meaningful partial output');
  assert.equal(decision.raw.httpStatus, 429);
  assert.equal(decision.raw.body, BODY);
  assert.match(decision.raw.message, /^API Error: Request rejected \(429\)/);
  assert.notEqual(env.classified[0]?.classification, 'succeeded');
  const written = bodyWrites(env.writes);
  assert.ok(written.length >= 1, 'the partial answer is checkpointed');
  for (const write of written) {
    assert.equal(write.content.includes('API Error'), false, 'the persisted body is never the envelope');
    assert.equal(write.content, BODY);
  }
});

test('held turn: a duplicated synthetic message delivery has no duplicate effect', async () => {
  const env = build();
  const item = runStream(env, [userEvent('do the thing'), realAnswer(BODY), mainResult(BODY),
    userEvent('<task-notification>wake'), synthetic429(), synthetic429(), wakeFailure()]);
  await release(env, item);
  assert.equal(errorFrameCount(env), 0);
  assert.equal(env.decisions.length, 1);
  const written = bodyWrites(env.writes);
  assert.ok(written.every(write => write.content === BODY));
});

test('held turn: a later successful wake supersedes the 429 and the turn succeeds with its text', async () => {
  const env = build();
  const item = runStream(env, [userEvent('do the thing'), realAnswer(BODY), mainResult(BODY),
    userEvent('<task-notification>wake-1'), synthetic429(), wakeFailure(),
    userEvent('<task-notification>wake-2'), realAnswer('wake two finished'), wakeSuccess('wake two finished')]);
  const released = await release(env, item);
  assert.notEqual(released.is_error, true);
  assert.equal(released.background_wake_failed, undefined);
  assert.equal(env.runner.completionOutcome.state, 'completed');
  assert.equal(errorFrameCount(env), 0, 'the failed wake never forwarded its envelope');
  assert.equal(env.decisions.length, 0, 'a recovered turn is not classified as an API error');
  const written = bodyWrites(env.writes);
  assert.ok(written.some(write => write.content === `${BODY}wake two finished`));
  assert.ok(written.every(write => write.content.includes('API Error') === false));
});

test('error-only main query keeps the previous behaviour: envelope shown, whole-message boundary', async () => {
  const env = build({ replayFence: 'none' });
  runStream(env, [userEvent('hi'), synthetic429(), mainFailure()], { hold: false });
  assert.equal((env.cs.currentAssistantText.match(/API Error/g) || []).length, 1);
  assert.ok(errorFrameCount(env) >= 1, 'the error bubble still reaches the client');
  await release(env, { hold: null });
  assert.equal(env.runner.apiErrorRaw?.body, null, 'whole-message boundary keeps safe-retry eligibility');
  assert.equal(env.runner.apiErrorRaw?.httpStatus, 429);
  const decision = env.decisions.at(-1);
  assert.equal(decision.raw.body, null, 'error-only boundary is preserved');
  assert.notEqual(env.classified.at(-1)?.classification, 'succeeded');
});

test('duplicate synthetic delivery is dropped in the error-only path too', () => {
  const env = build({ replayFence: 'none' });
  runStream(env, [userEvent('hi'), synthetic429(), synthetic429(), wakeFailure()], { hold: false });
  assert.equal((env.cs.currentAssistantText.match(/API Error/g) || []).length, 1);
  assert.equal(errorFrameCount(env), 1, 'the duplicate assistant snapshot is not forwarded');
});

test('a synthetic message the text regex does not recognize is still an API error', async () => {
  const text = 'Upstream said no (429)';
  assert.equal(detectErrorEnvelope('claude', text), null, 'the wording is invisible to the text regex');
  const env = build({ replayFence: 'none' });
  runStream(env, [userEvent('hi'),
    textEvent(text, { is_api_error_message: true, api_error_status: 429, error: 'rate_limit', uuid: 'u-2' }),
    mainFailure(text)], { hold: false });
  await release(env, { hold: null });
  assert.equal(env.runner.apiErrorRaw?.message, text);
  assert.equal(env.runner.apiErrorRaw?.httpStatus, 429);
  assert.equal(env.runner.apiErrorRaw?.body, null);
  const decision = env.decisions.at(-1);
  assert.equal(decision.raw.httpStatus, 429);
  assert.equal(decision.raw.structured, true);
});

test('watchdog: a synthetic API-error message followed by a success result is still an error', async () => {
  const env = build({ replayFence: 'none' });
  runStream(env, [userEvent('hi'), synthetic429(), wakeSuccess('recovered?')], { hold: false });
  assert.equal(env.runner.completionOutcome, null, 'the native result is held until settlement');
  await release(env, { hold: null });
  assert.equal(env.decisions.length, 1, 'a successful result does not clear the structured error');
  assert.equal(env.decisions[0].raw.httpStatus, 429);
  assert.equal(env.decisions[0].raw.body, null);
  assert.notEqual(env.classified.at(-1)?.classification, 'succeeded');
});

test('synthetic message recognition accepts wire and camelCase transcript spellings', () => {
  const wire = apiErrorMessageOf(textEvent(ENVELOPE, { is_api_error_message: true, api_error_status: 429,
    error: 'rate_limit', request_id: 'req_9' }));
  assert.equal(wire.text, ENVELOPE);
  assert.equal(wire.httpStatus, 429);
  assert.equal(wire.cliError, 'rate_limit');
  assert.equal(wire.key, 'req_9\0' + ENVELOPE);
  const camel = apiErrorMessageOf(textEvent(ENVELOPE, { isApiErrorMessage: true, apiErrorStatus: 429,
    uuid: 'uuid-9' }));
  assert.equal(camel.httpStatus, 429);
  assert.equal(camel.key, 'uuid-9');
  assert.equal(apiErrorMessageOf({ type: 'assistant', error: 'rate_limit',
    message: { model: '<synthetic>', content: [{ type: 'text', text: ENVELOPE }] } }).httpStatus, null);
  assert.equal(apiErrorMessageOf(realAnswer('plain')), null);
  assert.equal(apiErrorMessageOf({ type: 'user', is_api_error_message: true }), null);
});
