'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createClassifyStateMachine } = require('../src/classify/state-machine');

function fixture({
  cli = 'opencode', goal = '已识别任务', isStreaming = true, type = 'worker',
  history = null, auxText = null,
} = {}) {
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
    enqueued: 0, enqueuedTasks: [], transitions: 0,
    transitionResults: [], transitionOptions: [], broadcasts: [], summaries: [],
    boardReassignments: [], boardGroupLinks: [],
  };
  const auxQueue = {
    queue: [],
    isUnhealthy: () => false,
    hasPendingFor: () => false,
    cancelClassifyFor() {},
    enqueue(task) {
      observed.enqueued += 1;
      observed.enqueuedTasks.push(task);
      return Promise.resolve({ text: auxText || '已识别任务\n实现中\nW' });
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
    getTaskContextHost: () => ({
      recordGoal() {},
      continues: (_state, previous, forceNew) => !!previous && !forceNew,
    }),
    getTaskBoardRuntime: () => ({
      onTurnEnd() {},
      onMessagePersisted() {},
      reassignTurnTask(...args) { observed.boardReassignments.push(args); },
      linkRelatedTasks(...args) {
        observed.boardGroupLinks.push(args);
        return { ok: true, groupId: 'group-related' };
      },
      onTaskAttributionSettled() {},
    }),
    getUserInputSignalHost: () => ({ apply: (_sessionId, result) => result, pending: () => null }),
    getApiErrorHost: () => ({ isHeld: () => false }),
    getWaitInjector: () => ({ SYS_PREFIX: '[system]', resetAuto() {}, resetInterrupted() {} }),
    setTaskState: (_sessionId, patch) => {
      record.taskState = { ...record.taskState, ...patch };
    },
    getTaskState: value => value?.taskState || {},
    setSessionSummary: (_sessionId, summary) => observed.summaries.push(summary),
    setSessionStatus() {},
    chatBroadcast: (_sessionId, event) => observed.broadcasts.push(event),
    workspaceBroadcast() {},
    terminalBroadcast() {},
    triggerPush() {},
    evaluateTurnApiError() {},
    turnHasSideEffects: () => false,
    retryNotice: () => '',
    loadChatHistory: () => history || [{
      id: 'msg-scan-1', role: 'assistant', content: 'x'.repeat(40), taskId: 'task-1',
    }],
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
  assert.equal(h.observed.enqueuedTasks[0].meta.anchorMessageId, 'msg-scan-1');
  assert.equal(h.observed.enqueuedTasks[0].meta.taskId, 'task-1');
  assert.equal(h.observed.transitions, 0, 'mid-turn W cannot reach the scheduler');
  assert.equal(h.record.taskState.classifyState, 'P');
  assert.equal(h.chatState.isStreaming, true);
});

test('scan retries a provisional identity even when its temporary title is resolved text', async () => {
  const h = fixture({ cli: 'opencode', goal: '跨平台桌面包壳与 GitHub Release' });
  h.record.taskState.taskIdentityPending = true;
  h.machine.scanAndReclassify();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.observed.enqueued, 1);
  assert.match(h.observed.enqueuedTasks[0].systemPrompt, /候选 ID/);
  assert.equal(h.record.taskState.taskId, 'task-1', 'scan new/same fallback keeps the provisional id');
  assert.equal(h.record.taskState.classifyState, 'P');
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

test('a succeeded gateway turn deterministically reaches D without Aux classification', () => {
  const h = fixture({ cli: 'claude', type: 'gateway', isStreaming: false });
  h.chatState.claudeProc = null;
  h.machine.classifyTurnEnd(h.chatState, 's1', { classification: 'succeeded' });
  assert.equal(h.observed.enqueued, 0, 'gateway completion must not depend on Aux health');
  assert.equal(h.observed.transitions, 1);
  assert.equal(h.observed.transitionResults[0].state, 'D');
  assert.equal(h.observed.transitionResults[0].evidence, 'gateway_turn_succeeded');
  assert.equal(h.record.taskState.classifyState, 'D');
  const notify = h.observed.broadcasts.find(event => event.type === 'notify');
  assert.match(notify.taskShortCode, /^[0-9A-Z]{4}$/);
  assert.equal(notify.taskGoal, '已识别任务');
  assert.equal(
    notify.voiceMessage,
    `任务 ${notify.taskShortCode}，已识别任务，本轮执行成功`,
  );
});

function admissionHistory() {
  return [
    {
      id: 'msg-old', role: 'user', content: '修复 iOS 文件选择器',
      taskId: 'task-1', taskName: 'iOS文件选择器兼容相册图片',
    },
    {
      id: 'msg-new', role: 'user', content: '跨平台桌面包壳与 GitHub Release',
      taskId: 'task-candidate', taskStart: true, taskSource: 'router-tool',
    },
  ];
}

test('new admission first frame uses its provisional id/title while prior task is unfinished', () => {
  const h = fixture({ goal: 'iOS文件选择器兼容相册图片', history: admissionHistory() });
  h.chatState.currentTask.phase = 'wrapping';
  h.record.taskState.phase = 'wrapping';
  h.machine.ensureCurrentTask(
    h.chatState,
    's1',
    '跨平台桌面包壳与 GitHub Release',
    true,
    {
      taskId: 'task-candidate',
      taskText: '【任务派发方：Commander】\n\n跨平台桌面包壳与 GitHub Release',
    },
  );
  assert.equal(h.chatState._currentTaskId, 'task-candidate');
  assert.equal(h.chatState.currentTask.goal, '跨平台桌面包壳与 GitHub Release');
  assert.equal(h.record.taskState.taskIdentityPending, true);
  assert.equal(h.record.taskState.classifyState, 'P');
  assert.equal(h.observed.summaries.at(-1), '归类中：跨平台桌面包壳与 GitHub Release');
});

test('admission classify new promotes the provisional id without changing turn state', async () => {
  const h = fixture({
    goal: 'iOS文件选择器兼容相册图片',
    history: admissionHistory(),
    auxText: JSON.stringify({
      taskName: 'MultiCC 跨平台桌面壳', phase: 'implementing', relation: 'new', taskId: null,
    }),
  });
  h.chatState.currentUserText = '跨平台桌面包壳与 GitHub Release';
  h.machine.ensureCurrentTask(h.chatState, 's1', h.chatState.currentUserText, true, {
    taskId: 'task-candidate', taskText: h.chatState.currentUserText,
  });
  h.machine.runClassifyNow(h.chatState, 's1', {
    turnId: 'turn-new', source: 'admission', admittedTaskId: 'task-candidate',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.chatState._currentTaskId, 'task-candidate');
  assert.equal(h.record.taskState.taskId, 'task-candidate');
  assert.equal(h.record.taskState.goal, 'MultiCC 跨平台桌面壳');
  assert.equal(h.record.taskState.taskIdentityPending, false);
  assert.equal(h.record.taskState.classifyState, 'P', 'Aux must not rewrite D/W/B/E/P');
});

test('admission classify groups a related new task without replacing either task id', async () => {
  const h = fixture({
    goal: 'iOS文件选择器兼容相册图片',
    history: admissionHistory(),
    auxText: JSON.stringify({
      taskName: 'iOS 相册回归测试', phase: 'implementing', relation: 'new', taskId: null,
      relatedTaskId: 'task-1',
    }),
  });
  h.chatState.currentUserText = '为刚才的 iOS 文件选择器新增相册回归测试';
  h.machine.ensureCurrentTask(h.chatState, 's1', h.chatState.currentUserText, true, {
    taskId: 'task-candidate', taskText: h.chatState.currentUserText,
  });
  h.machine.runClassifyNow(h.chatState, 's1', {
    turnId: 'turn-related', source: 'admission', admittedTaskId: 'task-candidate',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.chatState._currentTaskId, 'task-candidate');
  assert.equal(h.record.taskState.taskId, 'task-candidate');
  assert.deepEqual(h.observed.boardGroupLinks, [['task-candidate', 'task-1']]);
  assert.equal(h.observed.boardReassignments.length, 0);
});

test('admission classify same re-points to the old canonical id and preserves rule facts', async () => {
  const h = fixture({
    goal: 'iOS文件选择器兼容相册图片',
    history: admissionHistory(),
    auxText: JSON.stringify({
      taskName: 'iOS文件选择器兼容相册图片',
      phase: 'verifying', relation: 'same', taskId: 'task-1',
    }),
  });
  h.chatState.currentUserText = '继续 #旧任务 的验证';
  h.machine.ensureCurrentTask(h.chatState, 's1', h.chatState.currentUserText, true, {
    taskId: 'task-candidate', taskText: h.chatState.currentUserText,
  });
  h.record.taskState.classifyState = 'B';
  h.record.taskState.classifyHistory.push({
    at: h.chatState.currentTask.startedAt + 1,
    taskId: 'task-candidate', goal: '候选标题', phase: 'planning',
    state: 'B', evidence: 'background_work_pending',
  });
  h.machine.runClassifyNow(h.chatState, 's1', {
    turnId: 'turn-same', source: 'admission', admittedTaskId: 'task-candidate',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.chatState._currentTaskId, 'task-1');
  assert.equal(h.record.taskState.taskId, 'task-1');
  assert.equal(h.record.taskState.classifyState, 'B');
  assert.deepEqual(
    {
      taskId: h.record.taskState.classifyHistory[0].taskId,
      goal: h.record.taskState.classifyHistory[0].goal,
      state: h.record.taskState.classifyHistory[0].state,
      evidence: h.record.taskState.classifyHistory[0].evidence,
    },
    {
      taskId: 'task-1', goal: 'iOS文件选择器兼容相册图片',
      state: 'B', evidence: 'background_work_pending',
    },
  );
});

test('explicit old-task continuation keeps its canonical id/title without a pending stale frame', () => {
  const h = fixture({ goal: 'iOS文件选择器兼容相册图片', history: admissionHistory() });
  h.record.taskState.taskId = 'task-1';
  h.machine.ensureCurrentTask(h.chatState, 's1', '#ABCD 继续验证', true, {
    taskId: 'task-1', explicitContinuation: true,
  });
  assert.equal(h.chatState._currentTaskId, 'task-1');
  assert.equal(h.chatState.currentTask.goal, 'iOS文件选择器兼容相册图片');
  assert.equal(h.record.taskState.taskIdentityPending, false);
  assert.equal(h.observed.summaries.at(-1), '处理中：iOS文件选择器兼容相册图片');
});

test('identity-locked continuation ignores a malformed new-related model verdict', async () => {
  const h = fixture({
    goal: 'iOS文件选择器兼容相册图片',
    history: admissionHistory(),
    auxText: JSON.stringify({
      taskName: '错误拆分', phase: 'planning', relation: 'new', taskId: null,
      relatedTaskId: 'task-candidate',
    }),
  });
  h.record.taskState.taskId = 'task-1';
  h.chatState.currentUserText = '#ABCD 继续验证';
  h.machine.runClassifyNow(h.chatState, 's1', {
    turnId: 'turn-locked', source: 'admission', identityLocked: true,
    admittedTaskId: 'task-1',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.chatState._currentTaskId, 'task-1');
  assert.equal(h.record.taskState.taskId, 'task-1');
  assert.equal(h.observed.boardGroupLinks.length, 0);
  assert.equal(h.observed.boardReassignments.length, 0);
});

test('delayed attribution with a superseded anchor cannot overwrite the newer task', () => {
  const h = fixture({ goal: '更新后的任务', history: admissionHistory() });
  h.chatState._currentTaskId = 'task-newer';
  h.record.taskState.taskId = 'task-newer';
  const result = h.machine.applyTaskAttributionResult(h.chatState, 's1', {
    taskName: '过期任务', phase: 'planning', relation: 'new', taskId: null,
  }, {
    taskId: 'task-candidate', resolvedTaskId: 'task-candidate',
    anchorMessageId: 'msg-old',
    anchorStatus: { changed: true, observedAnchorMessageId: 'msg-new' },
  });
  assert.equal(result.superseded, true);
  assert.equal(h.chatState._currentTaskId, 'task-newer');
  assert.equal(h.record.taskState.taskId, 'task-newer');
  assert.equal(h.chatState.currentTask.goal, '更新后的任务');
});
