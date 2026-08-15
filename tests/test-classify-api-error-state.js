'use strict';

// An API failure that reaches turn end has a known outcome — the centralized
// policy already chose retry or fail_fast, and only fail_fast reaches finalize.
// These tests pin the consequence: the classify centre publishes E from that
// structured decision instead of asking Aux to infer a state from a transcript
// that is usually empty (empty reply → prompt rule says P → P renders as W →
// the dispatcher reported an API error as 「等待用户操作」).

const assert = require('node:assert/strict');
const test = require('node:test');

const { createClassifyStateMachine } = require('../src/classify/state-machine');

const FAIL_FAST = Object.freeze({
  category: 'unknown', provider: 'qoder', code: 'error_during_execution',
  retryable: true, safeToRetry: true, phase: 'before_first_token',
  partialOutput: false, attempt: 1, maxAttempts: 1,
  action: 'fail_fast', reason: 'retry_budget_exhausted',
  userAction: '检查错误详情后决定是否手动重试',
});

function fixture({
  classifyState = 'P',
  apiError = null,
  lastDecision = { action: 'fail_fast', error: FAIL_FAST },
  retryPlanned = false,
  auxReply = '定位 codex 冷启瓶颈\n规划中\nP',
  auxUnhealthy = false,
  backgroundPending = false,
} = {}) {
  const record = {
    id: 's1', kind: 'chat', cli: 'qoder',
    taskState: {
      classifyState, goal: '定位 codex 冷启瓶颈', phase: 'planning',
      startedAt: Date.now() - 60_000, classifyHistory: [], apiError,
      cancelledAt: null,
    },
  };
  // The turn is over: no live child, not streaming — exactly the state the
  // finalize effects leave behind before classify-turn-end runs.
  const chatState = {
    cli: 'qoder', isStreaming: false, claudeProc: null,
    currentAssistantText: '', currentUserText: '排查冷启动',
    currentTask: { goal: '定位 codex 冷启瓶颈', phase: 'planning' },
    _currentTaskId: 'task-1',
    _lastApiErrorDecision: lastDecision,
    _activeRunner: retryPlanned ? { retryPlanned: true } : null,
  };
  const persistedSessions = new Map([['s1', record]]);
  const chatSessions = new Map([['s1', chatState]]);
  const observed = {
    enqueued: 0, cancelledFor: [], transitions: 0,
    broadcasts: [], pushes: [], evaluated: 0, boardTurnEnds: 0,
    auxRuns: [], annotations: [],
  };
  let releaseAux = () => {};
  const auxQueue = {
    queue: [],
    isUnhealthy: () => auxUnhealthy,
    hasPendingFor: () => false,
    enqueue() {
      observed.enqueued += 1;
      return new Promise(resolve => { releaseAux = () => resolve({ text: auxReply }); });
    },
    cancelClassifyFor(sessionKey) { observed.cancelledFor.push(sessionKey); return 1; },
  };
  const machine = createClassifyStateMachine({
    persistedSessions,
    chatSessions,
    getSessionSummaries: () => new Map(),
    logger: { info() {}, warn() {}, error() {} },
    getAuxQueue: () => auxQueue,
    getSessionWorkHost: () => ({
      classifyTransition() { observed.transitions += 1; },
      classifyUnavailable() {},
    }),
    getLivenessRuntime: () => ({
      ownership() {
        const state = chatSessions.get('s1');
        if (!state) return { state: 'unknown', reason: 'no_chat_runtime' };
        if (state._activeRunner?.retryPlanned) {
          return { state: 'active', reason: 'owned_retry_pending' };
        }
        return state.isStreaming
          ? { state: 'active', reason: 'fixture_runner' }
          : { state: 'inactive', reason: 'no_owned_turn' };
      },
    }),
    getTaskContextHost: () => ({ recordGoal() {} }),
    getTaskBoardRuntime: () => ({ onTurnEnd() { observed.boardTurnEnds += 1; } }),
    getUserInputSignalHost: () => ({ apply: (_sessionId, result) => result, pending: () => null }),
    getApiErrorHost: () => ({ isHeld: () => false }),
    getWaitInjector: () => ({ SYS_PREFIX: '[system]', resetAuto() {}, resetInterrupted() {} }),
    setTaskState: (_sessionId, patch) => {
      record.taskState = { ...record.taskState, ...patch };
    },
    getTaskState: value => ({ apiError: null, cancelledAt: null, ...(value?.taskState || {}) }),
    setSessionSummary() {},
    setSessionStatus() {},
    chatBroadcast: (_sessionId, event) => observed.broadcasts.push(event),
    workspaceBroadcast() {},
    terminalBroadcast() {},
    triggerPush: (_sessionId, type, message) => observed.pushes.push([type, message]),
    evaluateTurnApiError() { observed.evaluated += 1; },
    turnHasSideEffects: () => false,
    retryNotice: () => '上游 API 请求失败，未自动重试。检查错误详情后决定是否手动重试',
    loadChatHistory: () => [{ role: 'assistant', content: 'x'.repeat(40) }],
    appendChatMessage() {},
    annotateChatTurn: (...args) => { observed.annotations.push(args); return []; },
    getAuxRunLog: () => ({
      record: (_sessionId, run) => { observed.auxRuns.push(run); return run; },
    }),
    hasBackgroundPending: () => backgroundPending,
  });
  return { machine, record, chatState, observed, releaseAux: () => releaseAux() };
}

test('an exhausted API failure publishes E from rules before best-effort Aux naming', () => {
  const h = fixture();
  h.machine.classifyTurnEnd(h.chatState, 's1', { classification: 'api-error' });

  assert.equal(h.observed.enqueued, 1, 'Aux still records task attribution for the message');
  assert.equal(h.record.taskState.classifyState, 'E');
  assert.equal(h.observed.transitions, 1, 'the verdict still crosses the scheduler boundary');
  assert.equal(h.observed.boardTurnEnds, 1, 'the task board turn-end hook still runs');

  const history = h.record.taskState.classifyHistory;
  assert.equal(history.length, 1);
  assert.equal(history[0].state, 'E');
  assert.equal(history[0].error, true);
  assert.equal(history[0].evidence, 'api_error_policy');

  const notify = h.observed.broadcasts.find(event => event.type === 'notify');
  assert.equal(notify.classifyState, 'E');
  assert.equal(notify.state, 'error');
  assert.match(notify.message, /未自动重试/);
});

test('the same turn cancels this session queued and in-flight classify work', () => {
  const h = fixture();
  h.machine.classifyTurnEnd(h.chatState, 's1', { classification: 'api-error' });
  assert.deepEqual(h.observed.cancelledFor, ['s1']);
  assert.equal(typeof h.chatState._classifyTaskId, 'string',
    'the cancelled stale request is replaced by one naming-only request for this turn');
});

test('a classify already in flight cannot overwrite the deterministic E when it lands', async () => {
  const h = fixture();
  // A judgement was already running when the API failed.
  h.machine.runClassifyNow(h.chatState, 's1');
  assert.equal(h.observed.enqueued, 1);

  h.machine.classifyTurnEnd(h.chatState, 's1', { classification: 'api-error' });
  assert.equal(h.record.taskState.classifyState, 'E');

  h.releaseAux();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.record.taskState.classifyState, 'E', 'the stale P verdict must be dropped');
  assert.equal(h.record.taskState.classifyHistory.length, 1,
    'the superseded verdict must not even be recorded');
});

test('a new-task Aux result indexes its run by the resolved task, not the prior task', async () => {
  const h = fixture({
    auxReply: '{"taskName":"账单下载","phase":"planning","relation":"new","taskId":null}',
  });
  h.machine.classifyTurnEnd(h.chatState, 's1', {
    classification: 'completed', turnId: 'turn-new-task',
  });
  h.releaseAux();
  await new Promise(resolve => setImmediate(resolve));
  const run = h.observed.auxRuns.at(-1);
  assert.equal(run.priorTaskId, 'task-1');
  assert.match(run.taskId, /^tsk_[a-f0-9]{32}$/);
  assert.notEqual(run.taskId, 'task-1');
  assert.equal(h.record.taskState.taskId, run.taskId);
});

test('a turn end without a boundary verdict fails closed and still attributes the task', () => {
  const h = fixture();
  h.machine.classifyTurnEnd(h.chatState, 's1');
  assert.equal(h.observed.enqueued, 1);
  assert.deepEqual(h.observed.cancelledFor, ['s1'], 'runClassifyNow owns its own dedup');
  assert.equal(h.record.taskState.classifyState, 'E');
});

test('a planned retry owns the turn, so no premature E is published', () => {
  const h = fixture({ retryPlanned: true });
  h.machine.classifyTurnEnd(h.chatState, 's1', { classification: 'api-error' });
  assert.equal(h.record.taskState.classifyState, 'P', 'liveness holds the candidate');
  assert.equal(h.observed.transitions, 0);
});

test('clean completion reaches D even when Aux task attribution is unavailable', () => {
  const h = fixture({ auxUnhealthy: true });
  h.machine.classifyTurnEnd(h.chatState, 's1', {
    classification: 'completed', turnId: 'turn-offline',
  });
  assert.equal(h.record.taskState.classifyState, 'D');
  assert.equal(h.observed.enqueued, 0);
  assert.equal(h.record.taskState.classifyHistory.at(-1).evidence, 'turn_completed');
  assert.equal(h.observed.auxRuns.length, 1);
  assert.equal(h.observed.auxRuns[0].error, 'aux_unhealthy');
  assert.equal(h.observed.auxRuns[0].turnId, 'turn-offline');
  assert.equal(h.observed.annotations.length, 1,
    'the turn still receives an inspectable auxRunId when Aux is unavailable');
});

test('clean turn with authoritative background work reaches B without Aux', () => {
  const h = fixture({ auxUnhealthy: true, backgroundPending: true });
  h.machine.classifyTurnEnd(h.chatState, 's1', { classification: 'completed' });
  assert.equal(h.record.taskState.classifyState, 'B');
  assert.equal(h.record.taskState.classifyHistory.at(-1).evidence, 'background_pending');
  assert.equal(h.observed.enqueued, 0);
});

test('a legacy API error with no policy decision still records one before publishing E', () => {
  const h = fixture({ lastDecision: null });
  h.machine.classifyTurnEnd(h.chatState, 's1', { classification: 'api-error' });
  assert.equal(h.observed.evaluated, 1);
  assert.equal(h.record.taskState.classifyState, 'E');
});

test('the naming scan cannot rewrite a fail_fast E', () => {
  const h = fixture({ classifyState: 'E', apiError: FAIL_FAST });
  h.machine.scanAndReclassify();
  const decision = h.machine.scanHistory.passes[0].decisions.find(entry => entry.sid === 's1');
  assert.equal(decision.decision, 'skipped-goal-resolved');
  assert.equal(h.observed.enqueued, 0);
  assert.equal(h.record.taskState.classifyState, 'E');
});

test('the naming scan skips any already-resolved goal regardless of turn state', () => {
  const h = fixture({ classifyState: 'E', apiError: null });
  h.machine.scanAndReclassify();
  const decision = h.machine.scanHistory.passes[0].decisions.find(entry => entry.sid === 's1');
  assert.equal(decision.decision, 'skipped-goal-resolved');
  assert.equal(h.observed.enqueued, 0);
});
