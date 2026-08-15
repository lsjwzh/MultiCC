'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createClassifyStateMachine } = require('../src/classify/state-machine');

function fixture({ cli = 'opencode', goal = '已识别任务', isStreaming = true, type = 'worker' } = {}) {
  const record = {
    id: 's1', kind: 'chat', cli, type,
    taskState: {
      classifyState: 'P', goal, phase: 'implementing',
      startedAt: Date.now() - 20 * 60_000,
      classifyHistory: [],
    },
  };
  const liveChild = {
    pid: 4242, killed: false, exitCode: null, signalCode: null,
  };
  const chatState = {
    cli,
    isStreaming,
    // Reproduce the incident: more than ten minutes without a JSONL event while
    // the OpenCode child remains alive inside a long-running tool.
    lastStreamAt: Date.now() - 11 * 60_000,
    turnStartedAt: Date.now() - 12 * 60_000,
    claudeProc: cli === 'claude' ? null : liveChild,
    currentTask: { goal, phase: 'implementing' },
    _currentTaskId: 'task-1',
  };
  const persistedSessions = new Map([['s1', record]]);
  const chatSessions = new Map([['s1', chatState]]);
  const observed = {
    enqueued: 0, transitions: 0, transitionResults: [], transitionOptions: [], broadcasts: [],
  };
  const auxQueue = {
    queue: [],
    isUnhealthy: () => false,
    hasPendingFor: () => false,
    cancelClassifyFor() {},
    enqueue() {
      observed.enqueued += 1;
      return Promise.resolve({ text: '已识别任务\n实现中\nW' });
    },
  };
  const machine = createClassifyStateMachine({
    persistedSessions,
    chatSessions,
    getSessionSummaries: () => new Map(),
    logger: { info() {}, warn() {}, error() {} },
    getAuxQueue: () => auxQueue,
    getSessionWorkHost: () => ({
      classifyTransition(_sessionId, _taskId, result, options) {
        observed.transitions += 1;
        observed.transitionResults.push(result);
        observed.transitionOptions.push(options);
      },
      classifyUnavailable() {},
    }),
    getLivenessRuntime: () => ({
      ownership() {
        const state = chatSessions.get('s1');
        if (!state) return { state: 'unknown', reason: 'no_chat_runtime' };
        const child = state.claudeProc;
        const liveChild = !!child && child.killed !== true
          && child.exitCode == null && child.signalCode == null;
        if (state.isStreaming || liveChild) return { state: 'active', reason: 'fixture_runner' };
        return { state: 'inactive', reason: 'fixture_idle' };
      },
    }),
    getTaskContextHost: () => ({ recordGoal() {} }),
    getTaskBoardRuntime: () => ({ onTurnEnd() {} }),
    getUserInputSignalHost: () => ({ apply: (_sessionId, result) => result, pending: () => null }),
    getApiErrorHost: () => ({ isHeld: () => false }),
    getWaitInjector: () => ({ SYS_PREFIX: '[system]', resetAuto() {}, resetInterrupted() {} }),
    setTaskState: (_sessionId, patch) => {
      record.taskState = { ...record.taskState, ...patch };
    },
    getTaskState: value => value?.taskState || {},
    setSessionSummary() {},
    setSessionStatus() {},
    chatBroadcast: (_sessionId, event) => observed.broadcasts.push(event),
    workspaceBroadcast() {},
    terminalBroadcast() {},
    triggerPush() {},
    evaluateTurnApiError() {},
    turnHasSideEffects: () => false,
    retryNotice: () => '',
    loadChatHistory: () => [{ role: 'assistant', content: 'x'.repeat(40) }],
    appendChatMessage() {},
  });
  return { machine, record, chatState, chatSessions, observed };
}

test('silent live turns remain P across OpenCode, Codex and Claude scans', () => {
  for (const cli of ['opencode', 'codex', 'claude']) {
    const h = fixture({ cli });
    h.machine.scanAndReclassify();
    assert.equal(h.observed.enqueued, 0, `${cli}: resolved live goal must be scan-skipped`);
    assert.equal(h.observed.transitions, 0, `${cli}: scan cannot transition a live turn`);
    assert.equal(h.record.taskState.classifyState, 'P', `${cli}: canonical state remains processing`);
    assert.equal(h.chatState.isStreaming, true, `${cli}: scan must not mutate turn liveness`);
  }
});

test('OpenCode live child protects the turn even if isStreaming was cleared early', () => {
  const h = fixture({ cli: 'opencode', isStreaming: false });
  h.machine.scanAndReclassify();
  assert.equal(h.observed.enqueued, 0);
  assert.equal(h.observed.transitions, 0);
  assert.equal(h.record.taskState.classifyState, 'P');
});

test('mid-turn goal discovery is observational and cannot publish a W verdict', async () => {
  const h = fixture({ cli: 'opencode', goal: '新任务' });
  h.machine.scanAndReclassify();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.observed.enqueued, 1, 'unresolved goal may be classified for display');
  assert.equal(h.observed.transitions, 0, 'mid-turn W cannot reach the scheduler');
  assert.equal(h.record.taskState.classifyState, 'P');
  assert.equal(h.chatState.isStreaming, true);
});

test('scan never re-judges turn state after the runner is inactive', async () => {
  const h = fixture({ cli: 'opencode', isStreaming: false });
  h.chatState.claudeProc = null;
  h.machine.scanAndReclassify();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.observed.enqueued, 0);
  assert.equal(h.observed.transitions, 0);
  assert.equal(h.record.taskState.classifyState, 'P');
});

test('unknown liveness fails closed before classify admission', () => {
  const h = fixture({ cli: 'opencode', isStreaming: false });
  h.chatSessions.delete('s1');
  h.machine.scanAndReclassify();
  assert.equal(h.observed.enqueued, 0);
  assert.equal(h.observed.transitions, 0);
  assert.equal(h.record.taskState.classifyState, 'P');
});

test('a completed gateway turn deterministically reaches D without Aux classification', () => {
  const h = fixture({ cli: 'claude', type: 'gateway', isStreaming: false });
  h.chatState.claudeProc = null;
  h.machine.classifyTurnEnd(h.chatState, 's1', { classification: 'completed' });
  assert.equal(h.observed.enqueued, 0, 'gateway completion must not depend on Aux health');
  assert.equal(h.observed.transitions, 1);
  assert.equal(h.observed.transitionResults[0].state, 'D');
  assert.equal(h.observed.transitionResults[0].evidence, 'gateway_turn_completed');
  assert.equal(h.record.taskState.classifyState, 'D');
});
