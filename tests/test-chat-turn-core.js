'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const {
  TurnRequestError,
  normalizeTurnRequest,
  planTurnAdmission,
  createDurableMessageProof,
  createProviderRouteProof,
  evaluateSpawnGuard,
  decideRetry,
  routePostTurn,
  createDeliveryProof,
  acknowledgeDeliveredEffect,
  createTurnRuntimeStore,
  createTurnLifecycle,
  bindTurnUsageAttribution,
  bindRunnerUsageAttribution,
  createRunnerOwnership,
  ownsCurrentRunner,
  assignKillReason,
  recordResultEvent,
  recordCloseResult,
  recordPartialCheckpoint,
  hasMatchingPartialCheckpoint,
  claimDurableUsage,
  evaluatePostTurn,
  claimPostTurn,
  CHAT_TURN_PORTS,
  assertChatTurnPorts,
} = require('../src/chat');
const { createProviderBinding } = require('../src/providers/binding');
const { redactProviderRouteCapability } = require('../src/observability');
const {
  adapterReasoningProgressEvent,
  appendAdapterAssistantText,
  markReplaySafeAssistantEnvelope,
  reconcileBoundaryErrorEnvelope,
  normalizeClaudeAssistantSnapshot,
  normalizeClaudeToolResultContent,
  recoverDispatchFromHistory,
} = require('../src/chat/turn-engine');
const { createProviderAttemptRuntime } = require('../src/chat/provider-attempt-runtime');

function runtimeRouteProof(sessionId, turnId) {
  return Object.freeze({
    kind: 'provider-route', resolved: true, sessionId, turnId,
    route: Object.freeze({
      runtimeEpoch: 'epoch-1', decisionId: `decision-${turnId}`,
      routeAttemptId: `attempt-${turnId}`, routeGeneration: 1, attemptNo: 1,
      providerId: 'provider-a', protocol: 'anthropic', model: 'model-a',
      providerRevision: 'revision-a',
    }),
  });
}

test('adapter assistant snapshots preserve every OpenCode text part canonically', () => {
  assert.equal(appendAdapterAssistantText('', 'first'), 'first');
  assert.equal(appendAdapterAssistantText('first', 'second'), 'first\n\nsecond');
});

test('adapter reasoning publishes only normalized display text for sync progress', () => {
  assert.deepEqual(adapterReasoningProgressEvent({
    id: 'reason-1', text: 'inspect protocol', signature: 'must-not-cross', raw: { secret: true },
  }), {
    type: 'reasoning', id: 'reason-1', text: 'inspect protocol', snapshot: true,
  });
  assert.equal(adapterReasoningProgressEvent({ text: { secret: true } }), null);
  assert.equal(adapterReasoningProgressEvent({ text: '' }), null);
});

test('dispatch recovery uses the latest lineage-owned turn after a superseded attempt', () => {
  const operation = { id: 'op-1', requestOutboxId: 'operation:op-1:request' };
  const recovered = recoverDispatchFromHistory([
    {
      role: 'user', content: 'original', turnId: 'turn-1',
      deliveryId: 'operation:op-1:request', originDispatchId: 'op-1',
    },
    {
      role: 'assistant', content: 'partial old output', turnId: 'turn-1',
      partial: true, cancelled: true,
    },
    {
      role: 'user', content: 'replacement', turnId: 'turn-2',
      originDispatchId: 'op-1',
    },
    { role: 'assistant', content: 'replacement completed', turnId: 'turn-2' },
  ], operation);
  assert.deepEqual(recovered, { completed: true, text: 'replacement completed' });
});

test('dispatch recovery fails closed when the latest lineage-owned turn is incomplete', () => {
  const operation = { id: 'op-2', requestOutboxId: 'operation:op-2:request' };
  const recovered = recoverDispatchFromHistory([
    {
      role: 'user', content: 'original', turnId: 'turn-a',
      clientMsgId: 'operation:op-2:request',
    },
    { role: 'assistant', content: 'old success', turnId: 'turn-a' },
    { role: 'user', content: 'replacement', turnId: 'turn-b', originDispatchId: 'op-2' },
    { role: 'assistant', content: 'still partial', turnId: 'turn-b', partial: true },
  ], operation);
  assert.deepEqual(recovered, { completed: false, lastOutput: 'still partial' });
  assert.equal(recoverDispatchFromHistory([
    { role: 'user', content: 'unrelated' },
    { role: 'assistant', content: 'done' },
  ], operation), null);
});

test('Claude-compatible content arrays collapse before capability redaction and forwarding', () => {
  const capability = 'pr1.c2Vzc2lvbi0x.cHJveHktcm91dGUtc2VjcmV0';
  const tool = normalizeClaudeToolResultContent([
    { type: 'text', text: capability.slice(0, 18) },
    { type: 'text', text: capability.slice(18) },
  ]);
  assert.doesNotMatch(JSON.stringify(tool), /pr1\./);
  assert.match(tool.text, /REDACTED_PROVIDER_ROUTE/);
  const assistant = normalizeClaudeAssistantSnapshot({
    type: 'assistant',
    message: { content: [
      { type: 'text', text: capability.slice(0, 18) },
      { type: 'text', text: capability.slice(18) },
      { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
    ] },
  }, redactProviderRouteCapability(capability));
  assert.equal(assistant.message.textSnapshot, true);
  assert.doesNotMatch(JSON.stringify(assistant), /pr1\./);
  assert.equal(assistant.message.content.filter(block => block.type === 'text').length, 1);
});

test('only an exact host-detected DeepSeek error envelope avoids the replay fence', () => {
  let id = 0;
  const runtime = createProviderAttemptRuntime({
    runtimeEpoch: 'error-envelope-runtime', nextId: prefix => `${prefix}-${++id}`,
  });
  const route = (sessionId, turnId) => ({
    sessionId, turnId, cli: 'claude', providerId: 'deepseek-empty',
    providerName: 'DeepSeek Flash', protocol: 'anthropic', model: 'deepseek-v4-flash',
    providerRevision: 'deepseek-revision', attemptNo: 1,
  });
  const first = runtime.beginAttempt(route('deepseek-exact', 'turn-exact'));
  const exact = markReplaySafeAssistantEnvelope({
    type: 'assistant', message: { content: [{
      type: 'text',
      text: 'Failed to authenticate. API Error: 403 用户额度不足, 剩余额度: ＄-2.528834',
    }] },
  }, 'claude');
  runtime.observeEvent(first, exact);
  assert.equal(runtime.snapshot('deepseek-exact').replayFence, 'none');

  const second = runtime.beginAttempt(route('deepseek-trailing', 'turn-trailing'));
  const trailing = markReplaySafeAssistantEnvelope({
    type: 'assistant', message: { content: [{
      type: 'text', text: '已经完成第一步。\nAPI Error: 403 用户额度不足',
    }] },
  }, 'claude');
  runtime.observeEvent(second, trailing);
  assert.equal(runtime.snapshot('deepseek-trailing').replayFence, 'visible_output');
});

test('an authoritative error-only snapshot reconciles earlier streamed error deltas', () => {
  let id = 0;
  const runtime = createProviderAttemptRuntime({
    runtimeEpoch: 'streamed-error-runtime', nextId: prefix => `${prefix}-${++id}`,
  });
  const attempt = runtime.beginAttempt({
    sessionId: 'streamed-error', turnId: 'turn-403', cli: 'claude',
    providerId: 'provider-empty', providerName: 'Empty', protocol: 'anthropic',
    model: 'model-empty', providerRevision: 'revision-empty', attemptNo: 1,
  });
  runtime.observeEvent(attempt, {
    type: 'stream_event', event: {
      type: 'content_block_delta', delta: { type: 'text_delta', text: 'Failed to authenticate.' },
    },
  });
  assert.equal(runtime.snapshot('streamed-error').replayFence, 'visible_output');

  const text = 'Failed to authenticate. API Error: 403 用户额度不足, 剩余额度: ＄-2.528834';
  const envelope = reconcileBoundaryErrorEnvelope(runtime, attempt, 'claude', text);
  assert.equal(envelope.httpStatus, 403);
  assert.equal(envelope.body, null);
  assert.equal(runtime.snapshot('streamed-error').replayFence, 'none');
  assert.equal(runtime.snapshot('streamed-error').visibleOutputObserved, false);
});

test('a trailing envelope found only at the turn boundary never reaches the persisted partial', () => {
  // Text-only lanes (kimi, relayed codex/opencode text) have no result-event
  // strip: the boundary is where "answer + API Error: …" must become the answer.
  const cs = { currentAssistantText: 'Pushed main and the tag.API Error: Request rejected (429) · Please try again later.' };
  const envelope = reconcileBoundaryErrorEnvelope(null, null, 'kimi', cs);
  assert.equal(envelope.httpStatus, 429);
  assert.equal(envelope.body, 'Pushed main and the tag.');
  assert.equal(cs.currentAssistantText, 'Pushed main and the tag.');

  const errorOnly = { currentAssistantText: 'API Error: Request rejected (429) · Please try again later.' };
  assert.equal(reconcileBoundaryErrorEnvelope(null, null, 'kimi', errorOnly).body, null);
  assert.equal(errorOnly.currentAssistantText, 'API Error: Request rejected (429) · Please try again later.',
    'an error-only envelope keeps its text so the failed turn still shows the error bubble');

  const clean = { currentAssistantText: 'All done.' };
  assert.equal(reconcileBoundaryErrorEnvelope(null, null, 'kimi', clean), null);
  assert.equal(clean.currentAssistantText, 'All done.');
});

test('provider-cause evidence outranks the proxy generic status at turn close', () => {
  // The relay records "upstream HTTP 429" generically; the CLI's own envelope or
  // error event names the cause ("You have exceeded the 5-hour usage quota…").
  // Both close paths must hand the specific record to the policy — reading the
  // proxy record first made every quota wall a retryable rate limit.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'turn-engine.js'), 'utf8');
  assert.equal((source.match(/boundaryErrorEnvelope\s*\|\| (?:opencodeProcessError\([^\n]+?\) \|\| )?runner\.apiErrorRaw \|\| proxyFailure/g) || []).length, 2,
    'both the process and stream close paths must prefer provider-owned evidence over the proxy status');
  assert.equal(/proxyFailure \|\| boundaryErrorEnvelope/.test(source), false,
    'the generic proxy record must never shadow the provider diagnosis');

  // The policy then classifies the specific record: a quota wall is never a
  // short retry, with or without the relay status riding along.
  const { normalizeApiError } = require('../src/chat/api-error-policy');
  const quotaText = 'You have exceeded the 5-hour usage quota. It will reset at 2026-09-20 18:11:35 +0800 CST.';
  for (const raw of [
    { source: 'codex_event', provider: 'codex', message: quotaText },
    { source: 'codex_event', provider: 'codex', message: quotaText, httpStatus: 429 },
  ]) {
    assert.equal(normalizeApiError(raw, { source: raw.source, provider: raw.provider }).category, 'billing_quota');
  }
});

test('attempt semantic DLP runs before Claude and adapter state mutation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'turn-engine.js'), 'utf8');
  const claudeStart = source.indexOf('function applyClaudeChatEvent(');
  const claudeEnd = source.indexOf('function applyAdapterChatEvent(', claudeStart);
  const claudeBody = source.slice(claudeStart, claudeEnd);
  assert.ok(claudeStart >= 0 && claudeEnd > claudeStart);
  // The Claude decision body is native: assert the scrub port is wired and
  // that the native reducer scrubs before it mutates transcript/tool state.
  assert.match(source, /scrub: \(attempt, event\) => attemptRuntime\.scrubAttemptStructure\(attempt, event\)/,
    'the Claude lane must hand semantic DLP to the native reducer as a port');
  assert.match(claudeBody, /chatApplyClaudeEvent\(/);
  const nativeSource = fs.readFileSync(
    path.join(__dirname, '..', 'native', 'addon', 'src', 'chat_events.rs'), 'utf8');
  const nativeEntry = nativeSource.slice(nativeSource.indexOf('pub(crate) fn apply_claude_event'));
  assert.ok(nativeEntry.indexOf('c"scrub"') < nativeEntry.indexOf('c"currentAssistantText"'),
    'assistant content must be semantically scrubbed before transcript state changes');
  assert.ok(nativeEntry.indexOf('c"scrub"') < nativeEntry.indexOf('c"currentToolCalls"'),
    'tool input must be semantically scrubbed before tool state changes');

  // The adapter decision body is native too. Its scrub port must run before
  // any tool state mutates, including in the nested claude_event path.
  const adapterStart = nativeSource.indexOf('fn apply_adapter_one');
  const adapterEnd = nativeSource.indexOf('fn apply_adapter_event', adapterStart);
  const adapterBody = nativeSource.slice(adapterStart, adapterEnd);
  assert.ok(adapterStart >= 0 && adapterEnd > adapterStart);
  assert.ok(adapterBody.indexOf('c"scrub"') < adapterBody.indexOf('c"currentToolCalls"'),
    'adapter-normalized tool input must be scrubbed before tool state changes');
  assert.match(source, /chatApplyAdapterEvent\(/,
    'the adapter lane must hand every event to the native reducer');
});

function request(overrides = {}) {
  return normalizeTurnRequest({
    sessionId: 'session-1',
    text: '  complete the task  ',
    cli: 'claude',
    turnCount: 0,
    hasNativeSession: false,
    ...overrides,
  });
}

test('turn request normalizes identity/origin/history without native ids or secrets', () => {
  const turn = request({ deliveryId: ' delivery-1 ', bgTaskIds: ['a', 'a', 'b'] });
  assert.equal(turn.text, 'complete the task');
  assert.equal(turn.requestId, 'delivery-1');
  assert.deepEqual(turn.identity, { clientMsgId: 'delivery-1', deliveryId: 'delivery-1' });
  assert.deepEqual(turn.background.taskIds, ['a', 'b']);
  assert.deepEqual(turn.origin, { kind: 'user', operationId: null });
  assert.deepEqual(turn.launch, { reason: 'request' });
  assert.deepEqual(turn.execution, {
    transport: 'claude-stream', historyIntent: 'first', isFirstTurn: true,
  });
  const serialized = JSON.stringify(turn);
  assert.equal(serialized.includes('cliSessionId'), false);
  assert.equal(serialized.includes('nativeSessionId'), false);
  assert.equal(serialized.includes('secret'), false);
});

test('Claude Exp resumes native history even before the first successful reply', () => {
  for (const turnCount of [0, 1, 34]) {
    for (const hasNativeSession of [true, false]) {
      const turn = request({ cli: 'claude-exp', turnCount, hasNativeSession });
      assert.deepEqual(turn.execution, {
        transport: 'claude-stream',
        historyIntent: hasNativeSession ? 'resume' : 'first',
        isFirstTurn: !hasNativeSession,
      });
    }
  }
  for (const cli of ['claude', 'codex', 'codex-exp', 'opencode']) {
    assert.equal(request({ cli, turnCount: 0, hasNativeSession: true }).execution.isFirstTurn, true);
  }
});

test('history intent is derived from live state and dispatch metadata fails closed', () => {
  // A resume is a conclusion, not a request: it appears only when this session
  // has already taken a turn AND still holds a native session. Callers pass
  // neither forceFirstTurn nor resume — the fields do not exist.
  const turn = request({
    cli: 'codex', turnCount: 4, hasNativeSession: true,
    forceFirstTurn: false, resume: true,
    originDispatchId: 'operation-9', clientMsgId: 'client-9',
  });
  assert.deepEqual(turn.execution, {
    transport: 'cli-process', historyIntent: 'resume', isFirstTurn: false,
  });
  const rotatedAway = request({ cli: 'codex', turnCount: 4, hasNativeSession: false, resume: true });
  assert.deepEqual(rotatedAway.execution, {
    transport: 'cli-process', historyIntent: 'first', isFirstTurn: true,
  });
  assert.deepEqual(turn.origin, { kind: 'dispatch', operationId: 'operation-9' });

  assert.throws(() => request({ cliSessionId: 'native-secret' }), error => (
    error instanceof TurnRequestError && error.code === 'secret_field_forbidden'
  ));
  const continuedDispatch = request({ originDispatchId: 'd1', originContinue: true });
  assert.deepEqual(continuedDispatch.origin, { kind: 'dispatch', operationId: 'd1' });
  assert.deepEqual(continuedDispatch.launch, { reason: 'continue' });
  const continuedTrigger = request({ originTrigger: true, originContinue: true });
  assert.deepEqual(continuedTrigger.origin, { kind: 'trigger', operationId: null });
  assert.deepEqual(continuedTrigger.launch, { reason: 'continue' });
  assert.throws(() => request({ originDispatchId: 'd1', originTrigger: true }), /mutually exclusive/);
});

test('task context is explicit, trusted, and preserved only for routed task starts', () => {
  const request = normalizeTurnRequest({
    sessionId: 'worker-1',
    text: '【任务：新任务】\n完整正文',
    cli: 'codex',
    turnCount: 0,
    hasNativeSession: false,
    taskId: 'tsk-stable',
    taskStart: true,
    taskSource: 'task-board',
    taskText: '完整正文\n<script>alert(1)</script>',
  });
  assert.deepEqual(request.task, {
    id: 'tsk-stable',
    start: true,
    source: 'task-board',
    text: '完整正文\n<script>alert(1)</script>',
  });
  const routed = normalizeTurnRequest({
    sessionId: 'worker-1',
    text: 'tool-routed task',
    taskId: 'tsk-router',
    taskStart: true,
    taskSource: 'router-tool',
    taskText: 'tool-routed task',
  });
  assert.equal(routed.task.source, 'router-tool');
  const legacyCommanderRoute = normalizeTurnRequest({
    sessionId: 'worker-1',
    text: 'legacy Commander marker task',
    taskId: 'tsk-legacy-router',
    taskStart: true,
    taskSource: 'commander-route',
    taskText: 'legacy Commander marker task',
  });
  assert.equal(legacyCommanderRoute.task.source, 'commander',
    'persisted pre-1.2 Commander outbox items remain deliverable after restart');
  assert.throws(() => normalizeTurnRequest({
    sessionId: 'worker-1', text: 'x', taskStart: true, taskId: 'tsk-x',
  }), /trusted task source/);
  assert.throws(() => normalizeTurnRequest({
    sessionId: 'worker-1', text: 'x', taskText: 'body',
  }), /only valid on a task start/);
  const ordinary = normalizeTurnRequest({ sessionId: 'worker-1', text: '普通聊天' });
  assert.deepEqual(ordinary.task, { id: null, start: false, source: null, text: '' });
  // A system-injected auto-provider handoff after an unsafe replay boundary
  // carries a continuation label plus task attribution. It must normalize —
  // rejection burns its outbox retry into dead-letter — but it still cannot
  // START a task.
  const handoff = normalizeTurnRequest({
    sessionId: 'worker-1',
    text: '🔇Zhipu GLM 因上游限额或接口错误中断。请由 火山Codingplan 继续剩余任务。',
    taskId: 'tsk-stable',
    taskSource: 'auto_provider_handoff',
    originContinue: true,
  });
  assert.deepEqual(handoff.task, {
    id: 'tsk-stable', start: false, source: 'auto_provider_handoff', text: '',
  });
  assert.throws(() => normalizeTurnRequest({
    sessionId: 'worker-1', text: '🔇上游 API 已恢复…', taskSource: 'api_recovery',
  }), /unsupported task source/);
  assert.throws(() => normalizeTurnRequest({
    sessionId: 'worker-1', text: 'x', taskId: 'tsk-x',
    taskStart: true, taskSource: 'auto_provider_handoff',
  }), /trusted task source/);
  assert.throws(() => normalizeTurnRequest({
    sessionId: 'worker-1', text: 'x', taskSource: 'mystery-source',
  }), /unsupported task source/);
});

test('turn lifecycle carries canonical task identity into router tool capabilities', () => {
  const normalized = normalizeTurnRequest({
    sessionId: 'commander',
    text: '任务后续',
    taskId: 'tsk-upstream',
    taskStart: false,
    taskSource: 'task-board',
  });
  const turn = createTurnLifecycle(normalized, { turnId: 'turn-followup' });
  assert.deepEqual(turn.task, {
    id: 'tsk-upstream',
    start: false,
    source: 'task-board',
  });
  assert.equal(Object.isFrozen(turn.task), true);
});

test('task identity and provider attribution stay frozen for the admitted turn', () => {
  const normalized = normalizeTurnRequest({
    sessionId: 'worker-1',
    text: 'run the task',
    cli: 'codex',
    taskId: 'task-1',
    taskSource: 'task-board',
  });
  const turn = createTurnLifecycle(normalized, { turnId: 'turn-task-run' });
  assert.deepEqual(turn.task, {
    id: 'task-1',
    start: false, source: 'task-board',
  });

  const binding = bindTurnUsageAttribution(turn, {
    providerId: 'provider-a', providerName: 'Provider A', cli: 'codex',
    protocol: 'openai-responses', model: 'model-a', roleKind: 'main', routeName: 'main',
  });
  const runner = createRunnerOwnership(turn, { runnerId: 'runner-1', kind: 'process' });
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(runner.usageAttribution, binding);
  assert.throws(() => bindTurnUsageAttribution(turn, {
    providerId: 'provider-b', providerName: 'Provider B', cli: 'codex', model: 'model-b',
  }), /already frozen/);
  assert.equal(runner.usageAttribution.providerId, 'provider-a');

  const attemptBinding = bindRunnerUsageAttribution(runner, {
    ...binding,
    runtimeEpoch: 'epoch-1', decisionId: 'decision-1', routeAttemptId: 'attempt-1',
    routeGeneration: 1, attemptNo: 1, providerRevision: 'revision-1',
  });
  assert.equal(attemptBinding.routeAttemptId, 'attempt-1');
  assert.equal(attemptBinding.routeGeneration, 1);
  assert.throws(() => bindRunnerUsageAttribution(runner, {
    ...binding,
    runtimeEpoch: 'epoch-1', decisionId: 'decision-1', routeAttemptId: 'attempt-2',
    routeGeneration: 2, attemptNo: 2, providerRevision: 'revision-1',
  }), /already frozen/);

  const retryRunner = createRunnerOwnership(turn, { runnerId: 'runner-2', kind: 'process' });
  bindRunnerUsageAttribution(retryRunner, {
    providerId: 'provider-b', providerName: 'Provider B', cli: 'codex',
    protocol: 'openai_responses', model: 'model-b', roleKind: 'main', routeName: 'main',
    runtimeEpoch: 'epoch-1', decisionId: 'decision-1', routeAttemptId: 'attempt-2',
    routeGeneration: 2, attemptNo: 2, providerRevision: 'revision-2',
  });
  assert.equal(retryRunner.usageAttribution.providerId, 'provider-b');
  assert.equal(retryRunner.usageAttribution.routeAttemptId, 'attempt-2');
});

test('runner attempt ownership requires one exact proof and attribution tuple', () => {
  const normalized = request({ cli: 'codex' });
  const turn = createTurnLifecycle(normalized, { turnId: 'turn-attempt' });
  const binding = createProviderBinding({
    sessionId: turn.sessionId, cli: 'codex', providerId: 'provider-a', model: 'model-a',
  });
  const proof = createProviderRouteProof(normalized, {
    resolved: true, binding, providerName: 'Provider A', protocol: 'openai_responses',
    runtimeEpoch: 'epoch-1', turnId: turn.turnId, decisionId: 'decision-1',
    routeAttemptId: 'attempt-1', routeGeneration: 1, attemptNo: 1,
    providerRevision: 'revision-1',
  });
  const attempt = Object.freeze({
    sessionId: turn.sessionId, turnId: turn.turnId,
    cli: 'codex',
    runtimeEpoch: 'epoch-1', decisionId: 'decision-1', routeAttemptId: 'attempt-1',
    routeGeneration: 1, attemptNo: 1, providerId: 'provider-a',
    providerName: 'Provider A', protocol: 'openai_responses', model: 'model-a',
    providerRevision: 'revision-1',
  });
  const usageAttribution = {
    providerId: 'provider-a', providerName: 'Provider A', cli: 'codex',
    protocol: 'openai_responses', model: 'model-a', roleKind: 'main', routeName: 'main',
    runtimeEpoch: 'epoch-1', decisionId: 'decision-1', routeAttemptId: 'attempt-1',
    routeGeneration: 1, attemptNo: 1, providerRevision: 'revision-1',
  };
  const runner = createRunnerOwnership(turn, {
    runnerId: 'runner-attempt', providerAttempt: attempt, routeProof: proof, usageAttribution,
  });
  assert.equal(runner.providerRouteProof, proof);
  assert.equal(Object.getOwnPropertyDescriptor(runner, 'providerAttempt').writable, false);
  assert.throws(() => createRunnerOwnership(turn, {
    runnerId: 'runner-mismatch', providerAttempt: attempt, routeProof: proof,
    usageAttribution: { ...usageAttribution, providerId: 'provider-b' },
  }), /must match/);
});

test('Claude host pre-allocation proof preserves legacy resume intent for existing history', () => {
  const turn = request({ cli: 'claude', turnCount: 3, hasNativeSession: true });
  assert.equal(turn.execution.isFirstTurn, false);
  assert.equal(turn.execution.historyIntent, 'resume');
});

test('duplicate delivery wins and a fresh busy runner rejects without interruption effects', () => {
  const turn = request({ deliveryId: 'delivery-1' });
  const duplicate = planTurnAdmission(turn, {
    duplicateSeen: true,
    duplicatePersisted: true,
    runningTurn: true,
  });
  assert.equal(duplicate.decision, 'duplicate');
  assert.equal(duplicate.accepted, true);
  assert.deepEqual(duplicate.trace, ['duplicate-check']);
  assert.deepEqual(duplicate.effects, []);

  const fresh = planTurnAdmission(turn, { sessionExists: true, runningTurn: true });
  assert.equal(fresh.decision, 'reject');
  assert.equal(fresh.reason, 'session-busy');
  assert.deepEqual(fresh.effects, []);
});

test('a new Claude attempt is rejected before persistence while background work owns the old process', () => {
  const turn = request({ cli: 'claude' });
  const blocked = planTurnAdmission(turn, {
    sessionExists: true,
    backgroundWorkActive: true,
  });
  assert.equal(blocked.decision, 'reject');
  assert.equal(blocked.reason, 'background-work-active');
  assert.deepEqual(blocked.effects, []);
  assert.equal(blocked.trace.includes('persistence-plan'), false);

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'turn-engine.js'), 'utf8');
  const admissionStart = source.indexOf('const admission = planTurnAdmission');
  const turnStart = source.indexOf('const turnId =', admissionStart);
  const body = source.slice(admissionStart, turnStart);
  assert.match(body, /backgroundWorkActive:[\s\S]*hasProcessBackgroundTasks\(sessionName\)/);
  assert.match(body, /background-work-active[\s\S]*本消息尚未执行/);
});

test('a prior network failure never gates a later continuation or user request', () => {
  const system = request({ originContinue: true });
  const continued = planTurnAdmission(system, { sessionExists: true, networkUnhealthy: true });
  assert.equal(continued.decision, 'prepare');
  assert.equal(continued.effects[0].type, 'persist-user-message');
  const user = request();
  assert.equal(planTurnAdmission(user, { sessionExists: true, networkUnhealthy: true }).decision, 'prepare');
});

test('spawn requires durable message, provider route and runtime claim proofs', () => {
  const turn = request({ requestId: 'request-1' });
  const runtime = createTurnRuntimeStore({ now: () => 100 });
  assert.equal(runtime.claim(turn.sessionId, 'turn-1', {
    cli: turn.cli, transport: turn.execution.transport,
  }).ok, true);
  const binding = createProviderBinding({
    sessionId: turn.sessionId, cli: turn.cli, providerId: 'provider-a',
    model: 'model-a', roleKind: 'main', routeName: 'main',
  });
  assert.throws(() => createProviderRouteProof(turn, { resolved: true }), /concrete provider route/);
  const routeEvidence = {
    resolved: true,
    binding,
    providerName: 'Provider A',
    protocol: 'anthropic',
    runtimeEpoch: 'epoch-1',
    turnId: 'turn-1',
    decisionId: 'decision-1',
    routeAttemptId: 'attempt-1',
    routeGeneration: 1,
    attemptNo: 1,
    providerRevision: 'revision-1',
  };
  const route = createProviderRouteProof(turn, routeEvidence);
  assert.equal(Object.isFrozen(route), true);
  assert.equal(Object.isFrozen(route.route), true);
  assert.throws(() => createProviderRouteProof(turn, {
    ...routeEvidence, token: 'must-never-cross-the-proof-boundary',
  }), /too broad/);
  assert.throws(() => createProviderRouteProof(turn, {
    ...routeEvidence,
    binding: createProviderBinding({
      sessionId: turn.sessionId, cli: turn.cli, providerId: 'auto:balanced',
      model: 'model-a', roleKind: 'main', routeName: 'main',
    }),
  }), /concrete provider route/);
  const missing = evaluateSpawnGuard(turn, {
    message: createDurableMessageProof(turn, { persisted: false }),
    route,
    runtime: runtime.claimProof(turn.sessionId, 'turn-1'),
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['durable-user-message']);

  const ready = evaluateSpawnGuard(turn, {
    message: createDurableMessageProof(turn, { persisted: true }),
    route,
    runtime: runtime.claimProof(turn.sessionId, 'turn-1'),
  });
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.effect, {
    type: 'spawn-turn', sessionId: 'session-1', turnId: 'turn-1', cli: 'claude',
    transport: 'claude-stream', historyIntent: 'first',
    route: {
      runtimeEpoch: 'epoch-1', decisionId: 'decision-1', routeAttemptId: 'attempt-1', routeGeneration: 1,
      attemptNo: 1, providerId: 'provider-a', providerName: 'Provider A',
      protocol: 'anthropic', model: 'model-a', providerRevision: 'revision-1',
    },
  });
  const wrongTurnRoute = createProviderRouteProof(turn, { ...routeEvidence, turnId: 'turn-other' });
  assert.deepEqual(evaluateSpawnGuard(turn, {
    message: createDurableMessageProof(turn, { persisted: true }),
    route: wrongTurnRoute,
    runtime: runtime.claimProof(turn.sessionId, 'turn-1'),
  }).missing, ['provider-route']);
});

test('runtime store blocks double turns and requires legal proof-bearing transitions', () => {
  let clock = 1_000;
  const store = createTurnRuntimeStore({ now: () => clock++ });
  assert.equal(store.claim('s1', 't1', { cli: 'codex', transport: 'cli-process' }).ok, true);
  assert.equal(store.claim('s1', 't2').code, 'turn_in_flight');
  assert.deepEqual(store.start('s1', 't1').missing, ['durable-user-message', 'provider-route']);
  assert.equal(store.markMessageDurable('s1', 't1').ok, true);
  assert.equal(store.markProviderRouteResolved('s1', 't1', {
    resolved: true, proof: runtimeRouteProof('s1', 't1'),
  }).ok, true);
  assert.equal(store.start('s1', 't1').state.phase, 'running');
  assert.equal(store.cleanup('s1', 't1').code, 'invalid_transition');
  assert.equal(store.beginCleanup('s1', 't1', { status: 'completed' }).state.phase, 'finishing');
  assert.equal(store.cleanup('s1', 't1').state.phase, 'idle');

  assert.equal(store.claim('s1', 't2', { cli: 'claude', transport: 'claude-stream' }).ok, true);
  assert.equal(store.cleanup('s1', 't1').code, 'stale_turn');
  assert.equal(store.snapshot('s1').turnId, 't2', 'stale cleanup must not erase the new turn');
});

test('provider route failure returns runtime to idle and never leaves running state', () => {
  const store = createTurnRuntimeStore({ now: () => 55 });
  store.claim('s1', 't1', { cli: 'codex', transport: 'cli-process' });
  store.markMessageDurable('s1', 't1');
  const failed = store.markProviderRouteResolved('s1', 't1', { resolved: false, reason: 'provider unavailable' });
  assert.equal(failed.ok, true);
  assert.equal(failed.state.phase, 'idle');
  assert.equal(failed.state.lastOutcome.status, 'failed');
  assert.equal(store.start('s1', 't1').code, 'stale_turn');

  store.claim('s1', 't2', { cli: 'claude', transport: 'claude-stream' });
  const persistenceFailure = store.abortPreparation('s1', 't2', 'message-not-durable');
  assert.equal(persistenceFailure.state.phase, 'idle');
  assert.equal(persistenceFailure.state.lastOutcome.reason, 'message-not-durable');
});

test('preparation lease settles after runner handoff and releases every failure phase', () => {
  const store = createTurnRuntimeStore({ now: () => 77 });
  assert.equal(store.claim('s1', 'failed-before-spawn').ok, true);
  const failed = store.settle('s1', 'failed-before-spawn', {
    status: 'failed', reason: 'message-not-durable',
  });
  assert.equal(failed.ok, true);
  assert.equal(failed.state.phase, 'idle');
  assert.deepEqual(failed.state.lastOutcome, {
    turnId: 'failed-before-spawn', status: 'failed', reason: 'message-not-durable', at: 77,
  });

  assert.equal(store.claim('s1', 'delegated', { cli: 'codex', transport: 'cli-process' }).ok, true);
  store.markMessageDurable('s1', 'delegated');
  store.markProviderRouteResolved('s1', 'delegated', {
    resolved: true, proof: runtimeRouteProof('s1', 'delegated'),
  });
  assert.equal(store.start('s1', 'delegated').ok, true);
  const delegated = store.settle('s1', 'delegated', {
    status: 'delegated', reason: 'cli-process',
  });
  assert.equal(delegated.ok, true);
  assert.equal(delegated.state.phase, 'idle');
  assert.equal(store.claim('s1', 'next-turn').ok, true,
    'the preparation lease must not replace the established runner lifecycle');
});

test('production cutover keeps duplicate, proof and runner ordering explicit', () => {
  // runChatTurn now lives in src/chat/turn-engine.js; the ordering assertions scan
  // the extracted engine body up to the next engine function's banner comment.
  // The boundary starts at admitRunChatTurn (the pre-flight gate chain extracted
  // from runChatTurn's head), so both the admission gates and the turn body stay
  // inside the scanned region.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'turn-engine.js'), 'utf8');
  const start = source.indexOf('function admitRunChatTurn(sessionName, text, opts)');
  const end = source.indexOf('// ── Wait injector: continue a session', start);
  assert.ok(start >= 0 && end > start, 'runChatTurn engine boundary must exist');
  const body = source.slice(start, end);
  const at = (needle) => {
    const index = body.indexOf(needle);
    assert.ok(index >= 0, `production turn boundary must include ${needle}`);
    return index;
  };

  const normalized = at('normalizeTurnRequest({');
  const futureClaudeProof = at('const willAllocateClaudeNativeSession =');
  const admission = at('planTurnAdmission(turnRequest');
  const duplicateReturn = at("admission.decision === 'duplicate'");
  const nativeAllocation = at('persisted.cliSessionId = crypto.randomUUID()');
  const claim = at('chatTurnPreparationRuntime.claim(');
  // P0-2: a re-executed delivery skips the duplicate append, so the canonical
  // shape is a conditional `userMessageSaved = appendChatMessage(`.
  const append = at('userMessageSaved = appendChatMessage(');
  const durable = at('createDurableMessageProof(turnRequest');
  const route = at('const initialInvocation = prepareInvocation(');
  const usageAttribution = at('bindTurnUsageAttribution(turn, initialInvocation.baseUsageAttribution)');
  const guard = at('evaluateSpawnGuard(turnRequest');
  const authorize = at('chatTurnPreparationRuntime.start(');
  const claudeRunner = at('const accepted = runChatTurnStreaming(');
  const codexRunner = at('cs.claudeProc = spawnChat(initialInvocation, false)');
  const failureRelease = at('if (preparationOpen)');

  assert.ok(futureClaudeProof < normalized && normalized < admission);
  assert.ok(admission < duplicateReturn && duplicateReturn < nativeAllocation,
    'duplicate delivery must not allocate or mutate a native session');
  assert.ok(duplicateReturn < claim);
  assert.doesNotMatch(body, /New user_message while claude pid=|interrupting previous/,
    'the canonical turn boundary must reject busy races instead of interrupting an active turn');
  assert.ok(claim < append && append < durable && durable < route);
  assert.ok(route < usageAttribution && usageAttribution < guard,
    'provider/model/cli attribution is frozen after route resolution and before authorization');
  assert.ok(usageAttribution < authorize);
  assert.ok(guard < authorize);
  assert.ok(authorize < claudeRunner && authorize < codexRunner);
  assert.ok(codexRunner < failureRelease, 'finally must release a failed preparation lease');
  const invocationSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'chat', 'provider-invocation.js'), 'utf8');
  assert.match(invocationSource, /router\.resolveSpawnEnv\(session, selectionOverrides\)/,
    'every physical attempt must resolve its route instead of reusing captured argv/env');
  assert.match(invocationSource,
    /routeOverrides = Object\.freeze\(\{ providerId: binding\.providerId, model: selectedModel \}\)/,
    'the child env must rebuild from the same provider and raw selected model, not a qualified wire model');
  assert.match(body, /errorCategory: 'proxy_config', reasonCode: 'proxy_config_failed'/,
    'a proxy materialization failure must terminalize its physical attempt before retry exits');
});

test('retry policy bounds API failures and keeps deterministic scheduling', () => {
  const deps = { now: () => 1_000, random: () => 0 };
  const api = decideRetry({
    event: 'api-error',
    error: { httpStatus: 503, source: 'claude_result', provider: 'claude' },
    context: { source: 'claude_result', provider: 'claude', phase: 'before_first_token' },
    attempts: { apiError: 0 },
  }, deps);
  assert.equal(api.action, 'retry-api');
  assert.equal(api.attempt, 1);
  assert.equal(api.delayMs, 1000);
  assert.equal(api.capped, true);
  const exhausted = decideRetry({
    event: 'api-error',
    error: { httpStatus: 503, source: 'claude_result', provider: 'claude' },
    context: { source: 'claude_result', provider: 'claude', phase: 'before_first_token' },
    attempts: { apiError: 2 },
  }, deps);
  assert.equal(exhausted.action, 'fail');
  assert.equal(exhausted.reason, 'retry_budget_exhausted');
  const interrupted = decideRetry({ event: 'interrupted', attempts: { interruptedResume: 9 } }, { now: () => 0 });
  assert.equal(interrupted.action, 'resume');
  assert.equal(interrupted.attempt, 10);
  assert.equal(decideRetry({ event: 'interrupted', attempts: { interruptedResume: 10 } }).reason, 'resume-cap-reached');
  assert.equal(decideRetry({ event: 'interrupted', userStopped: true }).reason, 'user-stopped');
  assert.equal(decideRetry({ event: 'interrupted', killReason: 'shutdown' }).reason, 'explicit-lifecycle-stop');
  assert.equal(decideRetry({ event: 'interrupted', killReason: 'session_delete' }).action, 'fail');
  assert.equal(decideRetry({ event: 'interrupted', hasExplicitWait: true }).action, 'wait');

  const fresh = decideRetry({ event: 'empty-exit', cli: 'codex', attempts: {} }, { now: () => 5 });
  assert.equal(fresh.action, 'retry-fresh');
  assert.equal(fresh.attempt, 1);
  assert.equal(decideRetry({ event: 'empty-exit', cli: 'codex', isRetry: true }).reason, 'fresh-retry-exhausted');
  assert.equal(decideRetry({ event: 'empty-exit', cli: 'claude' }).reason, 'claude-stream-does-not-fresh-retry');
});

test('Codex disconnect continuation remains distinct from Claude and is capped at two', () => {
  const base = {
    event: 'codex-stream-disconnect', hasOutput: true, resultSaved: false,
    hasNativeSession: true, attempts: { codexDisconnect: 1 },
  };
  const codex = decideRetry({ ...base, cli: 'codex' }, { now: () => 0 });
  assert.equal(codex.action, 'resume');
  assert.equal(codex.attempt, 2);
  assert.equal(decideRetry({ ...base, cli: 'codex', attempts: { codexDisconnect: 2 } }).reason,
    'codex-continuation-cap-reached');
  assert.equal(decideRetry({ ...base, cli: 'claude' }).reason, 'codex-continuation-not-applicable');
});

test('native retry decisions preserve cancellation precedence and host scheduling', () => {
  let clocks = 0;
  let samples = 0;
  const deps = { now: () => { clocks++; return 1_000; }, random: () => { samples++; return 0.75; },
    jitterMs: 20, delays: { interruptedResume: 40 } };
  const stopped = decideRetry({ event: 'interrupted', killReason: 'shutdown', hasExplicitWait: true }, deps);
  assert.equal(stopped.reason, 'explicit-lifecycle-stop');
  assert.equal(clocks, 0);
  assert.equal(samples, 0);
  const resume = decideRetry({ event: 'interrupted', attempts: { interruptedResume: 1 } }, deps);
  assert.deepEqual(resume, { action: 'resume', classification: 'interrupted', attempt: 2,
    delayMs: 55, scheduledAt: 1055, cap: 10 });
  assert.ok(Object.isFrozen(resume));
  assert.equal(clocks, 1);
  assert.equal(samples, 1);
  assert.equal(decideRetry({ event: 'empty-exit', cli: 'codex', guardedHandoff: true }).preserveHandoff, true);
});

test('origin dispatch return wins routing and exactly-once receipt prevents redispatch', () => {
  const first = routePostTurn({
    turnId: 't1', sessionId: 'worker', sessionType: 'normal',
    originDispatchId: 'dispatch-1',
    finalText: 'done\n<<dispatch target="another">must not run</dispatch>',
  });
  assert.equal(first.route, 'dispatch-return');
  assert.deepEqual(first.effects.map(effect => effect.type), ['complete-dispatch']);
  assert.equal(first.effects.some(effect => effect.type === 'inspect-dispatch-markers'), false);
  const repeated = routePostTurn({
    turnId: 't1', sessionId: 'worker', sessionType: 'normal',
    originDispatchId: 'dispatch-1', finalText: 'done',
    receipts: ['dispatch-return:dispatch-1'],
  });
  assert.deepEqual(repeated.effects, []);
});

test('typed Commander cannot fan out through assistant markers', () => {
  // Marker-shaped assistant prose is inert. Cross-session execution is MCP-only.
  const direct = routePostTurn({
    turnId: 'commander-direct', sessionId: 'commander-1', sessionType: 'commander',
    finalText: '<<route target="worker-1">do the work</route>>',
  });
  assert.equal(direct.route, 'commander');
  assert.deepEqual(direct.effects, []);
  const directRepeated = routePostTurn({
    turnId: 'commander-direct', sessionId: 'commander-1', sessionType: 'commander',
    finalText: 'same', receipts: ['commander-turn:commander-direct'],
  });
  assert.deepEqual(directRepeated.effects, []);

  const first = routePostTurn({
    turnId: 'commander-turn', sessionId: 'commander-1', sessionType: 'commander',
    originDispatchId: 'taskboard-dispatch-1',
    finalText: '<<dispatch target="worker-1">do the work</dispatch>>',
  });
  assert.equal(first.route, 'dispatch-return');
  assert.deepEqual(first.effects.map(effect => effect.type), ['complete-dispatch']);
  assert.equal(first.effects[0].effectId, 'dispatch-return:taskboard-dispatch-1');

  const repeated = routePostTurn({
    turnId: 'commander-turn', sessionId: 'commander-1', sessionType: 'commander',
    originDispatchId: 'taskboard-dispatch-1', finalText: 'same',
    receipts: ['dispatch-return:taskboard-dispatch-1'],
  });
  assert.deepEqual(repeated.effects, []);
});

test('dispatch/outbox acknowledgement requires matching durable delivery proof', () => {
  const routed = routePostTurn({
    turnId: 't1', sessionId: 'worker', originDispatchId: 'dispatch-1', finalText: 'done',
  });
  const effect = routed.effects[0];
  assert.equal(acknowledgeDeliveredEffect(effect, null).code, 'delivery_proof_required');
  assert.equal(acknowledgeDeliveredEffect(effect, createDeliveryProof({
    effectId: 'wrong', deliveryId: 'outbox-1', durable: true, delivered: true,
  })).code, 'delivery_proof_required');
  const ack = acknowledgeDeliveredEffect(effect, createDeliveryProof({
    effectId: effect.effectId, deliveryId: 'outbox-1', durable: true, delivered: true,
  }));
  assert.deepEqual(ack, {
    ok: true,
    receipt: { type: 'ack-delivery', effectId: 'dispatch-return:dispatch-1', deliveryId: 'outbox-1' },
  });
});

test('assistant append failure never becomes durable and suppresses every post-turn effect', () => {
  const normalized = request({ originDispatchId: 'dispatch-1', originContinue: true });
  const turn = createTurnLifecycle(normalized, { turnId: 'turn-1' });
  const runner = createRunnerOwnership(turn, { runnerId: 'proc-1' });
  const cs = { _activeTurn: turn, _activeRunner: runner };
  const append = () => false; // fault injection: disk append failed
  const persisted = append({ role: 'assistant', content: 'done' });
  const proof = recordResultEvent(turn, runner, {
    current: ownsCurrentRunner(cs._activeTurn, cs._activeRunner, turn, runner),
    persisted,
  });
  assert.equal(proof.ok, false);
  assert.equal(proof.resultDurable, false);
  assert.equal(turn.resultDurable, false);
  assert.equal(evaluatePostTurn(turn, runner, {
    currentTurn: cs._activeTurn, currentRunner: cs._activeRunner,
  }).code, 'result_not_durable');
  assert.deepEqual(turn.lineage, { kind: 'dispatch', operationId: 'dispatch-1' },
    'failed persistence must retain dispatch lineage for recovery');
});

test('Rust-owned turn finality matches plain-object compatibility across retries and claims', () => {
  const originalDecision = (turn, runner, facts) => {
    if (!(facts.currentTurn === turn && facts.currentRunner === runner && turn && runner && runner.turnId === turn.turnId)) return 'stale_runner';
    if (!turn.resultDurable) return 'result_not_durable';
    if (turn.resultRunnerId !== runner.runnerId) return 'result_owned_by_other_runner';
    if (runner.killReason || facts.interrupted === true) return 'turn_interrupted';
    if (facts.apiError === true) return 'api_error_retry_pending';
    if (runner.retryPlanned || facts.retryPlanned === true) return 'retry_pending';
    if (facts.handoffResumeFailure === true) return 'handoff_resume_failed';
    const outcome = runner.completionOutcome;
    if (!(outcome?.version === 1 && outcome.state === 'completed' && outcome.settled === true)) return 'runner_not_completed';
    if (turn.postTurnClaimed) return 'post_turn_already_claimed';
    return null;
  };
  for (let mask = 0; mask < 512; mask++) {
    const turn = createTurnLifecycle(request(), { turnId: 'turn-finality' });
    const plain = { ...turn };
    const runner = createRunnerOwnership(turn, { runnerId: 'runner-\ud800' });
    const other = { ...runner, runnerId: 'runner-other' };
    const activeRunner = mask & 1 ? other : runner;
    const persisted = !!(mask & 2);
    const current = !!(mask & 4);
    const final = !!(mask & 8);
    const operation = mask & 16 ? recordCloseResult : recordResultEvent;
    assert.deepEqual(operation(turn, activeRunner, { current, persisted, final }),
      operation(plain, { ...activeRunner }, { current, persisted, final }));
    assert.equal(turn.resultDurable, plain.resultDurable);
    assert.equal(turn.resultRunnerId, plain.resultRunnerId);
    runner.completionOutcome = { version: 1, state: 'completed', settled: true };
    runner.killReason = mask & 32 ? 'cancelled' : null;
    runner.retryPlanned = !!(mask & 64);
    const facts = { currentTurn: turn, currentRunner: runner,
      apiError: !!(mask & 128), handoffResumeFailure: !!(mask & 256) };
    const plainFacts = { ...facts, currentTurn: plain };
    assert.equal(evaluatePostTurn(turn, runner, facts).code, originalDecision(turn, runner, facts));
    assert.deepEqual(evaluatePostTurn(turn, runner, facts), evaluatePostTurn(plain, runner, plainFacts));
    assert.deepEqual(claimPostTurn(turn, runner, facts), claimPostTurn(plain, runner, plainFacts));
    assert.deepEqual(claimPostTurn(turn, runner, facts), claimPostTurn(plain, runner, plainFacts));
    assert.equal(turn.postTurnClaimed, plain.postTurnClaimed);
  }
});

test('turn state preserves unusual JavaScript values and object identity at the host boundary', () => {
  const turn = createTurnLifecycle(request(), { turnId: 'turn-boundary' });
  for (const value of [undefined, null, -0, NaN, Infinity, '\ud800', 0n, 1n, Symbol('x'), {}, []]) {
    turn.resultDurable = value;
    turn.resultRunnerId = value;
    turn.postTurnClaimed = value;
    assert.ok(Object.is(turn.resultDurable, value));
    assert.ok(Object.is(turn.resultRunnerId, value));
    assert.ok(Object.is(turn.postTurnClaimed, value));
  }
  const identity = {};
  const runner = { turnId: turn.turnId, runnerId: identity, completionOutcome: { version: 1, state: 'completed', settled: true } };
  turn.postTurnClaimed = 0n;
  recordResultEvent(turn, runner, { current: true, persisted: true });
  assert.equal(turn.resultRunnerId, identity);
  assert.equal(claimPostTurn(turn, runner, { currentTurn: turn, currentRunner: runner }).ok, true);
  assert.equal(turn.postTurnClaimed, true);
});

test('turn state preserves mutation order and compatibility with replaced properties', () => {
  const turn = createTurnLifecycle(request(), { turnId: 'turn-order' });
  const runner = { turnId: turn.turnId, get runnerId() { throw new Error('identity unavailable'); } };
  assert.throws(() => recordResultEvent(turn, runner, { current: true, persisted: true }), /identity unavailable/);
  assert.equal(turn.resultDurable, true, 'durability is written before reading runnerId');
  assert.equal(turn.resultRunnerId, null);
  delete turn.resultDurable;
  delete turn.resultRunnerId;
  recordCloseResult(turn, { turnId: turn.turnId, runnerId: 'new' }, { current: true, persisted: true, final: true });
  assert.equal(turn.resultDurable, true);
  assert.equal(turn.resultRunnerId, 'new');
  delete turn.postTurnClaimed;
  const finalRunner = { turnId: turn.turnId, runnerId: 'new', completionOutcome: { version: 1, state: 'completed', settled: true } };
  assert.equal(claimPostTurn(turn, finalRunner, { currentTurn: turn, currentRunner: finalRunner }).ok, true);
  assert.equal(turn.postTurnClaimed, true);
  const frozen = createTurnLifecycle(request(), { turnId: 'turn-frozen' });
  Object.freeze(frozen);
  assert.throws(() => { frozen.resultDurable = true; }, TypeError);
  assert.equal(frozen.resultDurable, false);
});

test('native post-turn guards preserve getter order and short-circuit exceptions', () => {
  const reads = [];
  const turn = { turnId: 't', get resultDurable() { reads.push('durable'); return false; } };
  const runner = { turnId: 't', get runnerId() { throw new Error('not reached'); } };
  const facts = {
    get currentTurn() { reads.push('currentTurn'); return turn; },
    get currentRunner() { reads.push('currentRunner'); return runner; },
    get apiError() { throw new Error('not reached'); },
  };
  assert.equal(evaluatePostTurn(turn, runner, facts).code, 'result_not_durable');
  assert.deepEqual(reads, ['currentTurn', 'currentRunner', 'durable']);
  const brokenFacts = { get currentTurn() { throw new Error('expected getter'); } };
  assert.throws(() => evaluatePostTurn(turn, runner, brokenFacts), /expected getter/);
});

test('superseded and cancelled runners own their kill reason and cannot contaminate a new turn', () => {
  const first = createTurnLifecycle(request(), { turnId: 'turn-old' });
  const oldRunner = createRunnerOwnership(first, { runnerId: 'proc-old' });
  assignKillReason(oldRunner, 'new_user_message');

  const next = createTurnLifecycle(request(), { turnId: 'turn-new' });
  const newRunner = createRunnerOwnership(next, { runnerId: 'proc-new' });
  const cs = { _activeTurn: next, _activeRunner: newRunner };
  assert.equal(recordResultEvent(first, oldRunner, {
    current: ownsCurrentRunner(cs._activeTurn, cs._activeRunner, first, oldRunner),
    persisted: true,
  }).code, 'stale_runner');
  assert.equal(claimPostTurn(first, oldRunner, {
    currentTurn: cs._activeTurn, currentRunner: cs._activeRunner,
  }).code, 'stale_runner');
  assert.equal(newRunner.killReason, null);

  assignKillReason(newRunner, 'user_cancel');
  const afterCancel = createTurnLifecycle(request(), { turnId: 'turn-after-cancel' });
  const afterCancelRunner = createRunnerOwnership(afterCancel, { runnerId: 'proc-after-cancel' });
  cs._activeTurn = afterCancel;
  cs._activeRunner = afterCancelRunner;
  assert.equal(afterCancelRunner.killReason, null);
  assert.equal(evaluatePostTurn(next, newRunner, {
    currentTurn: cs._activeTurn, currentRunner: cs._activeRunner,
  }).code, 'stale_runner');
});

test('API error and planned retry suppress post-turn while preserving dispatch/trigger lineage', () => {
  for (const lineage of [
    { originDispatchId: 'dispatch-9' },
    { originTrigger: true },
  ]) {
    const normalized = request({ ...lineage, originContinue: true });
    const turn = createTurnLifecycle(normalized, { turnId: `turn-${normalized.origin.kind}` });
    const runner = createRunnerOwnership(turn, { runnerId: `runner-${normalized.origin.kind}` });
    const current = { _activeTurn: turn, _activeRunner: runner };
    recordResultEvent(turn, runner, { current: true, persisted: true });
    assert.equal(evaluatePostTurn(turn, runner, {
      currentTurn: current._activeTurn, currentRunner: current._activeRunner, apiError: true,
    }).code, 'api_error_retry_pending');
    runner.retryPlanned = true;
    assert.equal(evaluatePostTurn(turn, runner, {
      currentTurn: current._activeTurn, currentRunner: current._activeRunner,
    }).code, 'retry_pending');
    assert.equal(turn.lineage.kind, normalized.origin.kind);
    assert.equal(turn.launchReason, 'continue');
  }
});

test('only one current durable final result can claim dispatch return', () => {
  const normalized = request({ originDispatchId: 'dispatch-once' });
  const turn = createTurnLifecycle(normalized, { turnId: 'turn-once' });
  const runner = createRunnerOwnership(turn, { runnerId: 'runner-once' });
  runner.completionOutcome = { version: 1, state: 'completed', settled: true };
  const facts = { currentTurn: turn, currentRunner: runner };
  assert.equal(recordCloseResult(turn, runner, { current: true, persisted: true, final: false }).code,
    'not_final_result');
  assert.equal(turn.resultDurable, false, 'partial close persistence is not a final-result proof');
  assert.equal(recordCloseResult(turn, runner, { current: true, persisted: true, final: true }).ok, true);
  let returns = 0;
  if (claimPostTurn(turn, runner, facts).ok) returns++;
  if (claimPostTurn(turn, runner, facts).ok) returns++;
  assert.equal(returns, 1);
  assert.equal(turn.postTurnClaimed, true);
});

test('usage is recorded once when close persistence recovers an initial result append failure', () => {
  const turn = createTurnLifecycle(request(), { turnId: 'turn-usage' });
  const runner = createRunnerOwnership(turn, { runnerId: 'runner-usage' });
  recordResultEvent(turn, runner, { current: true, persisted: false });
  assert.equal(claimDurableUsage(runner, { resultDurable: turn.resultDurable }).code,
    'result_not_durable');
  recordCloseResult(turn, runner, { current: true, persisted: true, final: true });
  let usageWrites = 0;
  if (claimDurableUsage(runner, { resultDurable: turn.resultDurable }).ok) usageWrites++;
  if (claimDurableUsage(runner, { resultDurable: turn.resultDurable }).ok) usageWrites++;
  assert.equal(usageWrites, 1);
  assert.equal(runner.usageRecorded, true);
});

test('failed authoritative usage write leaves the once claim open for a synchronous retry', () => {
  const turn = createTurnLifecycle(request(), { turnId: 'turn-usage-write' });
  const runner = createRunnerOwnership(turn, { runnerId: 'runner-usage-write' });
  recordCloseResult(turn, runner, { current: true, persisted: true, final: true });
  const writeResults = [false, true];
  let writes = 0;
  const record = () => {
    if (runner.usageRecorded) return false;
    const written = writeResults[writes++];
    if (!written) return false;
    return claimDurableUsage(runner, { resultDurable: turn.resultDurable }).ok;
  };
  assert.equal(record(), false);
  assert.equal(runner.usageRecorded, undefined, 'failed disk write must not burn the once claim');
  assert.equal(record(), true);
  assert.equal(runner.usageRecorded, true);
  assert.equal(record(), false);
  assert.equal(writes, 2, 'already-recorded usage must not write a third time');
});

test('Rust usage claims are runner-local and retain the host property contract', () => {
  const turn = createTurnLifecycle(request(), { turnId: 'turn-usage-native' });
  const first = createRunnerOwnership(turn, { runnerId: 'first' });
  const retry = createRunnerOwnership(turn, { runnerId: 'retry' });
  assert.equal(Object.hasOwn(first, 'usageRecorded'), false);
  assert.equal(claimDurableUsage(first, { resultDurable: false }).code, 'result_not_durable');
  assert.equal(Object.hasOwn(first, 'usageRecorded'), false);
  assert.equal(claimDurableUsage(first, { resultDurable: true }).ok, true);
  assert.equal(first.usageRecorded, true);
  assert.equal(claimDurableUsage(first, { resultDurable: true }).code, 'usage_already_recorded');
  assert.equal(claimDurableUsage(retry, { resultDurable: true }).ok, true);
  first.usageRecorded = { marker: true };
  const marker = first.usageRecorded;
  assert.equal(first.usageRecorded, marker);
  assert.equal(claimDurableUsage(first, { resultDurable: true }).ok, true);
  delete first.usageRecorded;
  assert.equal(claimDurableUsage(first, { resultDurable: true }).ok, true);
  const sealed = createRunnerOwnership(turn, { runnerId: 'sealed' });
  Object.preventExtensions(sealed);
  assert.throws(() => claimDurableUsage(sealed, { resultDurable: true }), TypeError);
  assert.equal(sealed.usageRecorded, undefined);
});

test('result event is runner-owned and cannot promote a retry runner partial to final', () => {
  const turn = createTurnLifecycle(request({ cli: 'codex' }), { turnId: 'turn-retry-owner' });
  const first = createRunnerOwnership(turn, { runnerId: 'runner-first' });
  recordResultEvent(turn, first, { current: true, persisted: false });
  assert.equal(first.resultEvent, true);
  assert.equal(turn.resultDurable, false);

  const retry = createRunnerOwnership(turn, { runnerId: 'runner-retry' });
  assert.equal(retry.resultEvent, false, 'runner-local result evidence must not cross retry attempts');
  const partial = recordCloseResult(turn, retry, { current: true, persisted: true, final: retry.resultEvent });
  assert.equal(partial.code, 'not_final_result');
  assert.equal(turn.resultDurable, false);
  assert.equal(turn.resultRunnerId, null);
});

test('shutdown partial checkpoint is durable but never a final result proof', () => {
  const turn = createTurnLifecycle(request(), { turnId: 'turn-checkpoint' });
  const runner = createRunnerOwnership(turn, { runnerId: 'runner-checkpoint' });
  const checkpoint = recordPartialCheckpoint(turn, runner, {
    current: true, persisted: true, checkpointKey: 'sha256-partial-v1',
  });
  assert.equal(checkpoint.ok, true);
  assert.equal(hasMatchingPartialCheckpoint(runner, 'sha256-partial-v1'), true);
  assert.equal(hasMatchingPartialCheckpoint(runner, 'sha256-new-output'), false);
  assert.equal(turn.resultDurable, false);
  assert.equal(evaluatePostTurn(turn, runner, {
    currentTurn: turn, currentRunner: runner,
  }).code, 'result_not_durable');
});

test('production lifecycle uses append return, runner ownership and one guarded post-turn boundary', () => {
  // Turn-finalization composition (persistAssistant / turnFinalizationExecutor /
  // runChatTurn / runner-handoff) now lives in src/chat/turn-engine.js; scan the
  // concatenated host + engine source so host-only negatives and engine positives
  // both resolve.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
    + '\n' + fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'turn-engine.js'), 'utf8');
  assert.equal(source.includes('cs._killReason'), false, 'kill reason must not be session-global');
  assert.doesNotMatch(source, /function (?:persistFinalAssistantResult|recordDurableTurnUsage|runDurablePostTurn)\(/,
    'host lifecycle composition must live outside the God file');
  assert.match(source, /createChatHostRuntime\(\{/,
    'server must consume the extracted host runtime through narrow ports');
  const finalizeHostSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'finalize-host.js'), 'utf8');
  assert.match(finalizeHostSource, /chatExecuteTurnFinalization\(plan, rawContext, ports, runtime\)/);
  assert.doesNotMatch(finalizeHostSource, /function (?:applyEffect|executeUnsafe|isBlockedTerminalEffect)\(/);
  const finalizeNativeSource = fs.readFileSync(path.join(__dirname, '..', 'native', 'addon', 'src',
    'chat_finalize_execution.rs'), 'utf8');
  assert.match(finalizeNativeSource, /\.port\(\s*c"persistAssistant",[\s\S]{0,130}\.is_true\(\)\?/,
    '原生收尾执行器必须以真实历史写入返回值确认持久化');
  assert.match(source, /persistAssistant\(context, append\) \{[\s\S]{0,120}persistFinalAssistantResult\(/,
    'server composition must inject the authoritative assistant writer');
  assert.match(source, /context\.runner\.pendingUsage[\s\S]{0,180}\{ usage: context\.runner\.pendingUsage \}/,
    'interrupted/error assistant checkpoints must persist measured token usage');
  // The durable-result branch is native; the engine only wires the port and the
  // native reducer gates usage recording and _resultSaved on its return value.
  assert.match(source, /persistFinal: \(sessionName, cs, turn, runner, message, options\) => persistFinalAssistantResult\(/);
  const nativeEvents = fs.readFileSync(
    path.join(__dirname, '..', 'native', 'addon', 'src', 'chat_events.rs'), 'utf8');
  assert.match(nativeEvents, /if durable \{[\s\S]{0,600}cs\.assign\(c"_resultSaved"/);
  assert.match(source, /runPostTurn\(context, entry\) \{[\s\S]{0,160}runDurablePostTurn\(/);
  assert.match(source, /isCurrentTurnRunner\(cs, turn, runner\)/);
  assert.equal((source.match(/runnerHandedOff = true;/g) || []).length, 2,
    'both streaming and process runners must be marked handed off before lease release');
  const catchAt = source.indexOf('if (runnerHandedOff) {', source.indexOf('function runChatTurn('));
  const falsePreparationErrorAt = source.indexOf('turn preparation failed before runner handoff', catchAt);
  assert.ok(catchAt >= 0 && falsePreparationErrorAt > catchAt,
    'a handed-off runner must bypass the pre-runner failure response');
  assert.equal((finalizeNativeSource.match(/回复已生成但未能持久化，已停止回流和后续动作。/g) || []).length, 1,
    'stream and process finalizers must share one durable-result failure effect');
  assert.equal(source.includes('turn.resultEvent'), false, 'result events must be runner-owned');
  assert.equal((source.match(/sameDurablePartial: hasMatchingPartialCheckpoint\(runner,/g) || []).length, 2,
    'both runner paths must pass checkpoint evidence into the shared planner');
  assert.ok((source.match(/planTurnFinalization\(\{/g) || []).length >= 2,
    'process and stream paths, including blocked retries, must use the pure finalization plan');
  assert.equal((source.match(/turnFinalizationExecutor\.execute\((?:finalizePlan|plan),/g) || []).length, 2,
    'process and stream paths must both use the shared host effect executor');
  assert.match(source, /createChatHostRuntime\(\{[\s\S]{0,500}persistUsage: accumulateTokenUsage/,
    'production host must inject the authoritative usage writer into the coordinator');
  const hostSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'host-coordinator.js'), 'utf8');
  const usageStart = hostSource.indexOf('function commitUsage(');
  const usageEnd = hostSource.indexOf('\n  function finalize(', usageStart);
  const usageBody = hostSource.slice(usageStart, usageEnd);
  assert.ok(usageBody.indexOf('ports.usage.commit(') < usageBody.indexOf('claimDurableUsage(runner'),
    'main token usage must commit before the in-memory once claim');
  const tokenSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'token-usage.js'), 'utf8');
  const accumulateStart = tokenSource.indexOf('function accumulateTokenUsage(');
  const accumulateEnd = tokenSource.indexOf('\n  function seedTokenUsageFromHistory(', accumulateStart);
  const accumulateBody = tokenSource.slice(accumulateStart, accumulateEnd);
  assert.ok(accumulateBody.indexOf('deps.atomicWriteJson(deps.tokenUsageFile, data)')
    < accumulateBody.indexOf('accumulateTokenDaily(sessionId, usage, attribution)'),
  'daily aggregation must derive only after the main usage file commits');
  assert.match(accumulateBody,
    /catch \(error\) \{[\s\S]{0,120}logFailure\('token_usage_write_failed', error\);[\s\S]{0,80}return false;/,
    'a failed cumulative write must release the durable usage claim for retry');
  // The planner moved into Rust; the same source-level guarantees are asserted
  // against its new home (native/core/src/chat_finalize.rs).
  const finalizeSource = fs.readFileSync(
    path.join(__dirname, '..', 'native', 'core', 'src', 'chat_finalize.rs'), 'utf8');
  assert.match(finalizeSource, /if !kill_truthy \{[\s\S]{0,400}freeze-interrupted/,
    'unknown interruptions must freeze until an explicit user decision');
  assert.match(finalizeSource, /if durable_after_append \{[\s\S]{0,260}turn_end\("succeeded"\)/,
    'clean streaming completion must still classify immediately');
});

test('handoff, gateway, aux and normal post-turn routes remain explicit', () => {
  const handoff = routePostTurn({
    turnId: 't1', sessionId: 's1', sessionType: 'normal', finalText: 'ok',
    handoff: { id: 'h1', status: 'pending', completed: true },
  });
  assert.deepEqual(handoff.effects.map(effect => effect.type), ['ack-handoff']);
  const handoffRepeated = routePostTurn({
    turnId: 't1', sessionId: 's1', sessionType: 'normal', finalText: 'ok',
    handoff: { id: 'h1', status: 'pending', completed: true }, receipts: ['handoff:h1'],
  });
  assert.equal(handoffRepeated.effects.some(effect => effect.type === 'ack-handoff'), false);
  assert.equal(routePostTurn({ handoffResumeFailure: true }).route, 'handoff-failed');
  assert.equal(routePostTurn({ turnId: 't2', sessionId: 'g', sessionType: 'gateway' }).route, 'gateway');
  assert.equal(routePostTurn({ turnId: 't3', sessionId: 'a', sessionType: 'aux' }).route, 'aux');
  assert.equal(routePostTurn({ turnId: 't3c', sessionId: 'c', sessionType: 'commander' }).route, 'commander');
  assert.equal(routePostTurn({ turnId: 't4', sessionId: 'n', sessionType: 'normal' }).route, 'normal');
});

test('chat turn ports are narrow and pure modules import no runtime I/O dependencies', () => {
  const calls = [];
  const ports = {};
  for (const [name, methods] of Object.entries(CHAT_TURN_PORTS)) {
    ports[name] = Object.fromEntries(methods.map(method => [method, () => calls.push(`${name}.${method}`)]));
  }
  assert.equal(assertChatTurnPorts(ports), ports);
  assert.throws(() => assertChatTurnPorts({}), /port missing/);

  for (const file of [
    'turn-request.js', 'retry-policy.js', 'post-turn-router.js',
    'runtime-store.js', 'turn-lifecycle.js', 'finalize-plan.js',
    'finalize-host.js', 'ports.js',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', file), 'utf8');
    assert.equal(/require\(['"](?:fs|child_process|express|ws)['"]\)/.test(source), false, `${file} must stay pure`);
  }
});

test('hard turn-control paths terminalize the provider attempt before teardown or history mutation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'turn-engine.js'), 'utf8');
  // Resume-mismatch teardown is a native decision now; the JS module only wires
  // the attempt and process effects as ports.
  const rust = fs.readFileSync(
    path.join(__dirname, '..', 'native', 'addon', 'src', 'chat_events.rs'), 'utf8');
  const adapterStart = rust.indexOf('fn apply_adapter_one');
  const adapterEnd = rust.indexOf('fn apply_adapter_event', adapterStart);
  assert.ok(adapterStart >= 0 && adapterEnd > adapterStart);
  const adapterBody = rust.slice(adapterStart, adapterEnd);
  assert.match(adapterBody, /assign_kill_reason\(/);
  for (const code of ['cli_resume_mismatch', 'native_resume_mismatch']) {
    assert.match(adapterBody, new RegExp(`finish_attempt\\(anchor, ports, runner, "${code}"\\)`),
      `${code} teardown must close the provider attempt in the native reducer`);
  }
  assert.ok(adapterBody.indexOf('forward_error(') < adapterBody.indexOf('finish_attempt('),
    'the owned error remains visible before the attempt becomes terminal');
  assert.match(source, /finishProviderAttempt: \(runner, outcome, facts\) =>/,
    'the adapter reducer must close the provider attempt through a host port');

  const clearStart = source.indexOf("if (msg.type === 'clear_history')");
  const clearEnd = source.indexOf("if (msg.type === 'user_message'", clearStart);
  const clearBody = source.slice(clearStart, clearEnd);
  assert.ok(clearStart >= 0 && clearEnd > clearStart);
  assert.match(clearBody, /clearHistory\(sessionName, msg, cs\)/);
  assert.doesNotMatch(clearBody, /cancelActiveTurn|killReason|hasLiveBackgroundTasks/,
    'display clearing must not cancel active work or wait for background tasks');
  const proxyStart = source.indexOf('const proxyRequired = providers.codexProxyConfigRequired(');
  const proxyEnd = source.indexOf('} catch (error)', proxyStart);
  assert.ok(proxyStart >= 0 && proxyEnd > proxyStart);
  const proxyBody = source.slice(proxyStart, proxyEnd);
  assert.match(proxyBody, /const proxyApplied = providers\.applyCodexProxyConfig\([\s\S]*?providers\.assertCodexProxyConfigApplied\(\{ required: proxyRequired, applied: proxyApplied \}\)/,
    'a routed Codex attempt must apply the explicit route policy before leaving the guarded setup block');
});

test('tool timing stamps ride in the persisted tools array (replay upgrade)', () => {
  // The DSH timing arc's last gap was server-side: currentToolCalls carried
  // no timing, so every replayed tool was "unknown" forever. The stamps are
  // applied where every claude-shaped event (spawn path, streaming path, and
  // the adapter-synthesized ones) funnels through — the native Claude reducer.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'native', 'addon', 'src', 'chat_events.rs'), 'utf8');
  // tool_use arrival stamps startedAt on the pushed call…
  assert.match(
    source,
    /tool\.set\(c"startedAt", number\(anchor, now\(anchor\)\?\)\?\)\?;/,
  );
  // …and the matching tool_result stamps endedAt right where result/is_error
  // land, so the persisted tools array carries measured spans for replay.
  assert.match(
    source,
    /tool\.assign\(c"is_error",[\s\S]{0,200}tool\.assign\(c"endedAt", number\(anchor, now\(anchor\)\?\)\?\)\?;/,
  );
});

test('reasoning spans are measured so think time reaches the wall-clock', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'native', 'addon', 'src', 'chat_events.rs'), 'utf8');
  // The adapter Thinking card carries a real start stamp. It used to have none
  // at all, so every persisted Thinking tool was "unknown" and the wall-clock
  // trajectory could never show the think segment.
  assert.match(
    source,
    /tool\.set\(c"name", text\(anchor, "Thinking"\)\?\)\?;[\s\S]{0,400}tool\.set\(c"startedAt", number\(anchor, now\(anchor\)\?\)\?\)\?;/,
  );
  assert.match(source, /tool\.assign\(c"endedAt", number\(anchor, now\(anchor\)\?\)\?\)\?;/);

  const { closeOpenThinkingTool } = require(path.join(__dirname, '..', 'src', 'chat', 'turn-engine.js'));

  // A lane that never emits the closing frame still gets a measured span when
  // the turn's result lands — reasoning cannot outlive the turn.
  const open = { name: 'Thinking', startedAt: 1000 };
  const cs = { currentToolCalls: [open, { name: 'Bash', startedAt: 5, endedAt: 9 }] };
  closeOpenThinkingTool(cs);
  assert.ok(Number.isFinite(open.endedAt) && open.endedAt >= 1000, 'an open Thinking span is closed');

  // An already-settled Thinking tool is left exactly as it was (never re-stamped).
  const settled = { name: 'Thinking', startedAt: 10, endedAt: 20 };
  closeOpenThinkingTool({ currentToolCalls: [settled] });
  assert.equal(settled.endedAt, 20);

  // A Thinking card with no start (legacy history) stays unmeasured — no
  // fabricated duration, same rule the clients follow.
  const legacy = { name: 'Thinking' };
  closeOpenThinkingTool({ currentToolCalls: [legacy] });
  assert.equal(legacy.endedAt, undefined);

  // Non-reasoning tools are never touched by the thinking settle.
  const bash = { name: 'Bash', startedAt: 1 };
  closeOpenThinkingTool({ currentToolCalls: [bash] });
  assert.equal(bash.endedAt, undefined);

  assert.doesNotThrow(() => closeOpenThinkingTool(undefined));
});

test('a turn refreshes a stale chat cwd before spawning the CLI', () => {
  const source = fs.readFileSync('src/chat/turn-engine.js', 'utf8');
  const start = source.indexOf('function runChatTurn(sessionName, text, opts = {})');
  const end = source.indexOf('function runChatTurnStreaming(', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  const created = body.indexOf('chatSessions.set(sessionName, cs)');
  const refreshed = body.indexOf("cs.cwd = cwdForSession(persisted)");
  assert.ok(created >= 0 && refreshed > created,
    'the cached cwd must be re-resolved after the chat state exists');
  // The CLI-switch path does the same before reusing the chat state.
  const switchSource = fs.readFileSync('src/cli/switch-runtime.js', 'utf8');
  assert.match(switchSource, /chat\.cwd = cwd/);
});

// Frozen Node implementation, used only for migration differential checks.
const legacyTurnEffects = (() => {
const clean = value => value == null ? '' : String(value).trim();
const isCompleted = outcome => outcome?.version === 1 && outcome.state === 'completed' && outcome.settled === true;
function ownsCurrentRunner(currentTurn, currentRunner, turn, runner) {
  return !!(
    currentTurn === turn
    && currentRunner === runner
    && turn && runner
    && runner.turnId === turn.turnId
  );
}

function assignKillReason(runner, reason) {
  if (!runner) return false;
  runner.killReason = clean(reason) || null;
  return !!runner.killReason;
}

// Transient event errors may recover (for example Codex housekeeping failures).
// Clear them only after the owning adapter confirms completion, the execution
// boundary settles, and the result is durable. Proxy diagnostics use the same
// completed-turn evidence in the attempt runtime; they are not deleted.
// A boundary error envelope ("Codex 出错：Selected model is at capacity" as
// the assistant text) is provider-owned fault evidence — never clear it.
function clearErrorFlagsForSucceededTurn(turn, runner, cs, facts = {}) {
  if (!turn || !runner || turn.resultDurable !== true) return false;
  if (!isCompleted(runner.completionOutcome) || !runner.runnerId || turn.resultRunnerId !== runner.runnerId) return false;
  if (facts.killReason) return false;
  if (facts.code !== undefined && facts.code !== null && facts.code !== 0) return false;
  if (facts.boundaryErrorEnvelope) return false;
  const hadErrorFlags = !!(runner.sawApiError || runner.apiErrorRaw || runner.adapterError
    || cs?._sawApiError || cs?._adapterError || cs?._codexTransportError || cs?._codexPendingStreamError);
  runner.sawApiError = false;
  runner.apiErrorRaw = null;
  runner.adapterError = null;
  if (cs) {
    cs._sawApiError = false;
    cs._adapterError = null;
    cs._codexTransportError = '';
    cs._codexPendingStreamError = '';
  }
  return hadErrorFlags;
}

function recordResultEvent(turn, runner, facts = {}) {
  if (!turn || !runner || runner.turnId !== turn.turnId || facts.current !== true) {
    return Object.freeze({ ok: false, code: 'stale_runner', resultDurable: !!(turn && turn.resultDurable) });
  }
  runner.resultEvent = true;
  // Durability is monotonic for one turn. A failed later duplicate append must
  // never erase an earlier committed final result.
  if (facts.persisted === true) {
    turn.resultDurable = true;
    turn.resultRunnerId = runner.runnerId;
  }
  return Object.freeze({
    ok: facts.persisted === true,
    code: facts.persisted === true ? null : 'result_not_durable',
    resultDurable: turn.resultDurable,
  });
}

function recordCloseResult(turn, runner, facts = {}) {
  if (!turn || !runner || runner.turnId !== turn.turnId || facts.current !== true) {
    return Object.freeze({ ok: false, code: 'stale_runner', resultDurable: !!(turn && turn.resultDurable) });
  }
  if (facts.final === true && facts.persisted === true) {
    turn.resultDurable = true;
    turn.resultRunnerId = runner.runnerId;
  }
  return Object.freeze({
    ok: facts.final === true && facts.persisted === true,
    code: facts.final !== true ? 'not_final_result'
      : facts.persisted !== true ? 'result_not_durable' : null,
    resultDurable: turn.resultDurable,
  });
}

function recordPartialCheckpoint(turn, runner, facts = {}) {
  if (!turn || !runner || runner.turnId !== turn.turnId || facts.current !== true) {
    return Object.freeze({ ok: false, code: 'stale_runner' });
  }
  const checkpointKey = clean(facts.checkpointKey);
  if (facts.persisted !== true || !checkpointKey) {
    return Object.freeze({ ok: false, code: 'checkpoint_not_durable' });
  }
  runner.partialCheckpointKey = checkpointKey;
  return Object.freeze({ ok: true, code: null, checkpointKey });
}

function hasMatchingPartialCheckpoint(runner, checkpointKey) {
  return !!(runner && runner.partialCheckpointKey && runner.partialCheckpointKey === clean(checkpointKey));
}


return { ownsCurrentRunner, assignKillReason, clearErrorFlagsForSucceededTurn, recordResultEvent, recordCloseResult, recordPartialCheckpoint, hasMatchingPartialCheckpoint };
})();

test('Rust turn mutations match legacy ownership, persistence and error recovery', () => {
  const native = require('../src/chat/turn-lifecycle');
  const values = [undefined, null, false, true, 0, 1, '', 'x', ' key ', {}, Symbol('id')];
  let seed = 19517;
  const pick = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return values[seed % values.length]; };
  for (let i = 0; i < 1400; i++) {
    const turn = { turnId: 't', resultDurable: pick(), resultRunnerId: 'r' };
    const runner = { turnId: i % 7 ? 't' : 'old', runnerId: 'r', completionOutcome: {
      version: 1, state: i % 5 ? 'completed' : 'unknown', settled: i % 4 !== 0 },
      sawApiError: pick(), apiErrorRaw: pick(), adapterError: pick(), partialCheckpointKey: pick() };
    const cs = { _sawApiError: pick(), _adapterError: pick(), _codexTransportError: pick(), _codexPendingStreamError: pick() };
    const facts = { current: i % 3 !== 0, persisted: i % 4 !== 0, final: i % 5 !== 0,
      code: i % 3 ? undefined : pick(), checkpointKey: pick(), killReason: i % 7 ? null : 'cancel' };
    for (const name of ['recordResultEvent', 'recordCloseResult', 'recordPartialCheckpoint', 'clearErrorFlagsForSucceededTurn']) {
      const run = fn => {
        const t = { ...turn }, r = { ...runner }, c = { ...cs };
        const args = name === 'clearErrorFlagsForSucceededTurn' ? [t, r, c, facts] : [t, r, facts];
        return { result: fn(...args), turn: t, runner: r, cs: c };
      };
      assert.deepEqual(run(native[name]), run(legacyTurnEffects[name]), name);
    }
    assert.equal(native.ownsCurrentRunner(turn, runner, turn, runner), legacyTurnEffects.ownsCurrentRunner(turn, runner, turn, runner));
    assert.equal(native.ownsCurrentRunner({ ...turn }, runner, turn, runner), false);
    assert.equal(native.hasMatchingPartialCheckpoint(runner, facts.checkpointKey), legacyTurnEffects.hasMatchingPartialCheckpoint(runner, facts.checkpointKey));
    const r1 = { ...runner }, r2 = { ...runner };
    assert.equal(native.assignKillReason(r1, facts.checkpointKey), legacyTurnEffects.assignKillReason(r2, facts.checkpointKey));
    assert.deepEqual(r1, r2);
  }
});

test('Rust turn mutations keep strict setters, reads, partial writes and reentry', () => {
  const native = require('../src/chat/turn-lifecycle');
  const sentinel = new Error('turn property sentinel');
  for (const name of ['recordResultEvent', 'recordCloseResult', 'recordPartialCheckpoint', 'clearErrorFlagsForSucceededTurn']) {
    for (const throwAt of [null, 'get:turn.turnId', 'get:runner.runnerId', 'set:turn.resultRunnerId', 'get:facts.persisted', 'set:runner.apiErrorRaw']) {
      const execute = fn => {
        const trace = [];
        const wrap = (value, label) => new Proxy(value, {
          get(obj, key) { const event = `get:${label}.${String(key)}`; trace.push(event); if (event === throwAt) throw sentinel; return obj[key]; },
          set(obj, key, value) { const event = `set:${label}.${String(key)}`; trace.push(event); if (event === throwAt) throw sentinel; obj[key] = value; return true; },
        });
        const turn = wrap({ turnId: 't', resultDurable: true, resultRunnerId: 'r' }, 'turn');
        const runner = wrap({ turnId: 't', runnerId: 'r', sawApiError: true, completionOutcome: { version: 1, state: 'completed', settled: true } }, 'runner');
        const facts = wrap({ current: true, persisted: true, final: true, checkpointKey: ' k ', code: 0 }, 'facts');
        const cs = wrap({}, 'cs');
        const args = name === 'clearErrorFlagsForSucceededTurn' ? [turn, runner, cs, facts] : [turn, runner, facts];
        try { return { result: fn(...args), trace }; }
        catch (error) { return { error, trace }; }
      };
      assert.deepEqual(execute(native[name]), execute(legacyTurnEffects[name]), name);
    }
    for (const fn of [native[name], legacyTurnEffects[name]]) {
      const turn = { turnId: 't', resultDurable: true, resultRunnerId: 'r' };
      const runner = { turnId: 't', runnerId: 'r', completionOutcome: { version: 1, state: 'completed', settled: true } };
      const facts = { current: true, final: true, persisted: true, checkpointKey: 'k' };
      Object.freeze(name === 'recordCloseResult' ? turn : runner);
      const args = name === 'clearErrorFlagsForSucceededTurn' ? [turn, runner, {}, facts] : [turn, runner, facts];
      assert.throws(() => fn(...args), TypeError, `${name} must preserve strict-mode failure`);
    }
  }
  const run = fn => {
    const turn = { turnId: 't' };
    const runner = { turnId: 't', runnerId: 'r', set resultEvent(value) {
      assert.equal(value, true);
      fn(turn, { turnId: 't', runnerId: 'nested', resultEvent: false }, { current: true, persisted: false });
    } };
    return { result: fn(turn, runner, { current: true, persisted: true }), turn };
  };
  assert.deepEqual(run(native.recordResultEvent), run(legacyTurnEffects.recordResultEvent));
  for (const fn of [native.assignKillReason, legacyTurnEffects.assignKillReason]) {
    assert.throws(() => fn(new Proxy({}, { set() { return false; } }), 'cancel'), TypeError);
  }
});

test('a redelivered persisted message is never refused by the configuration step', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/chat/turn-engine.js'), 'utf8');
  const start = source.indexOf('    const configuration = ');
  const end = source.indexOf('    return finishConfiguration();', start);
  assert.ok(start > 0 && end > start, 'the configuration step is still where this test reads it');
  // Run the real step with stubbed collaborators: refusal comes back as
  // { blocked: true }, admission as the finishConfiguration() marker.
  const step = new Function('replay', 'deps', 'sessionName', 'opts', 'text', 'finishConfiguration',
    source.slice(start, end) + '    return finishConfiguration();');
  const admitted = () => 'admitted';
  for (const verdict of [true, false, undefined]) {
    let called = 0;
    const deps = { applyPendingConfiguration: () => { called++; return verdict; } };
    assert.equal(step(true, deps, 's', {}, 't', admitted), 'admitted', `replay with verdict ${verdict}`);
    assert.equal(called, 0, 'a redelivery does not apply configuration again');
  }
  assert.deepEqual(step(false, { applyPendingConfiguration: () => false }, 's', {}, 't', admitted), { blocked: true });
  assert.equal(step(false, { applyPendingConfiguration: () => true }, 's', {}, 't', admitted), 'admitted');
  assert.equal(step(false, {}, 's', {}, 't', admitted), 'admitted');
});
