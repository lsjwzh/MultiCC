'use strict';

// Manual-cancel state flow, end to end.
//
// The bug this pins: cancelling used to write `classifyState: 'E'` straight into
// the session's task state AND separately tell the scheduler the slot was free.
// Two writers, two fan-outs — the chat bar learned about the cancel through the
// task_state broadcast while the task board only learned about it through a
// scheduler event that (a) carried no verdict, so the board hard-coded `done`,
// and (b) was never emitted at all when there was no active entry. The result
// was the reported 「内部已经 error/cancelled、外部任务卡/会话卡仍显示 running」.
//
// The invariant these tests enforce: the cancel controller stops the runner and
// submits ONE structured result to classify; classify is the only writer of
// business state; every projection reads back the same canonical letter.
//
// Everything below runs on isolated temp files and in-process fakes — no real
// session, port or user task is touched.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionWorkHost } = require('../src/session-work-host');
const { createClassifyStateMachine } = require('../src/classify/state-machine');
const { createTaskStateStore } = require('../src/routes/task-state-store');
const { createTaskBoardRuntime } = require('../src/routes/task-board');
const { createSessionWorkScheduler } = require('../src/session-work-scheduler');
const { createOrchestrationStore } = require('../src/orchestration-store');
const { createOutbox } = require('../src/outbox');
const { createOrchestrationRoutes } = require('../src/routes/orchestration');
const { classifyDisplay } = require('../src/classify/vocab');

// ── Harness ────────────────────────────────────────────────────────────────

function harness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cancel-flow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // One ordered log for the whole chain. Every entry carries its sequence, which
  // is what lets a test prove controller → cancel event → classify → persist →
  // broadcast → projection actually happened in that order.
  const events = [];
  let seq = 0;
  const record = entry => { events.push({ seq: ++seq, ...entry }); return entry; };
  const kinds = () => events.map(event => event.kind);
  const firstIndex = kind => kinds().indexOf(kind);

  const boardFile = path.join(dir, 'task_board.json');
  fs.writeFileSync(boardFile, JSON.stringify({
    modules: {},
    tasks: {
      'tsk-1': {
        title: '重构取消链路',
        status: 'active',
        // The card is mid-run when the user hits Cancel — this is the value that
        // used to survive as a stale `running` forever.
        runState: 'running',
        runStateAt: 1_000,
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    },
  }));

  const persistedSessions = new Map([['s1', {
    id: 'sess-1',
    kind: 'chat',
    cli: 'codex',
    dirId: 'dir-1',
    taskState: { goal: '重构取消链路', phase: 'implement' },
  }]]);

  // A CLI that stops when asked, unless the test says otherwise. `signalCode` +
  // the 'exit' event are what Node sets when a child actually dies, and they are
  // what the host reads to tell a delivered signal from a stopped process.
  const diesOn = options.diesOn === undefined ? 'SIGTERM' : options.diesOn;
  const exitListeners = [];
  const child = {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kills: 0,
    signals: [],
    once(event, fn) { if (event === 'exit') exitListeners.push(fn); },
    kill(signal) {
      this.kills += 1;
      this.signal = signal;
      this.signals.push(signal);
      record({ kind: 'runner_kill', signal });
      if (!diesOn || signal !== diesOn) return;
      this.signalCode = signal;
      exitListeners.splice(0).forEach(fn => fn(null, signal));
    },
  };
  const chatState = {
    cli: 'codex',
    claudeProc: child,
    isStreaming: true,
    currentAssistantText: '',
    currentToolCalls: [],
    streamReplay: ['partial'],
    _activeRunner: {},
    _currentTaskId: 'tsk-1',
    currentTask: { goal: '重构取消链路', phase: 'implement' },
  };
  const chatSessions = new Map([['s1', chatState]]);

  // The Aux queue is classify's LLM input channel. A cancel has to reach it too:
  // the judgement admitted for the killed turn must be dropped, and the trailing
  // turn-end that the runner's close handler fires after the kill must not queue
  // a replacement.
  const auxJobs = { enqueued: [], cancelledFor: [] };
  const auxQueue = {
    isUnhealthy: () => false,
    cancel() {},
    cancelClassifyFor(sessionKey) { auxJobs.cancelledFor.push(sessionKey); return 0; },
    enqueue(task) {
      auxJobs.enqueued.push(task);
      record({ kind: 'aux_enqueue', taskType: task.type });
      return new Promise(() => {});  // still in flight
    },
  };

  const taskStateStore = createTaskStateStore({
    persistedSessions,
    saveBestEffort() {},
    chatBroadcast: (sessionId, payload) => record({ kind: 'chat_broadcast', sessionId, payload }),
    workspaceBroadcast: (dirId, payload) => record({ kind: 'workspace_broadcast', dirId, payload }),
  });

  const taskBoard = createTaskBoardRuntime({
    file: boardFile,
    auxQueue: { isUnhealthy: () => true, cancel() {}, enqueue: async () => ({ cancelled: true }) },
    records: persistedSessions,
    loadHistory: () => [],
    dispatchToSession: async () => ({ ok: true }),
    routeCommanderTask: async () => ({ ok: false, code: 'not_used' }),
    sendSessionMessage: async () => ({ ok: true, handled: false }),
    workspaceBroadcast: (dirId, payload) => record({ kind: 'board_broadcast', dirId, payload }),
    atomicWriteJson: (file, value) => fs.writeFileSync(file, JSON.stringify(value)),
    isSystemInjected: () => false,
    getSessionRunState: () => sessionWorkHost?.getRunState('s1') || 'idle',
    logger: { log() {} },
  });

  let clock = 10_000;
  const store = createOrchestrationStore({
    file: path.join(dir, 'orchestration.json'),
    now: () => clock,
  });
  let leases = 0;
  const outbox = createOutbox({ store, now: () => clock, leaseTokenFactory: () => `lease-${++leases}` });
  const scheduler = createSessionWorkScheduler({
    store,
    now: () => clock,
    onEvent: event => {
      record({ kind: `scheduler:${event.type}`, event });
      sessionWorkHost?.onSchedulerEvent(event);
    },
    getClassifyState: () => persistedSessions.get('s1')?.taskState?.classifyState || null,
  });

  let sessionWorkHost;
  const classify = createClassifyStateMachine({
    persistedSessions,
    chatSessions,
    getSessionSummaries: () => new Map(),
    logger: { info() {}, warn() {}, error() {} },
    getAuxQueue: () => auxQueue,
    getSessionWorkHost: () => sessionWorkHost,
    getLivenessRuntime: () => ({
      ownership: sessionId => chatSessions.get(sessionId)?.isStreaming
        ? { state: 'active', reason: 'fixture_streaming' }
        : { state: 'inactive', reason: 'fixture_idle' },
    }),
    getTaskContextHost: () => ({
      recordGoal: (sessionName, goal, phase, cs, classifyState) => {
        record({ kind: 'task_context_goal', sessionName, goal, phase, classifyState });
      },
    }),
    getTaskBoardRuntime: () => taskBoard,
    getUserInputSignalHost: () => ({ clear() {} }),
    getApiErrorHost: () => ({}),
    getWaitInjector: () => ({ resetAuto() { record({ kind: 'wait_reset_auto' }); }, resetInterrupted() {} }),
    setTaskState: (sessionId, patch, opts) => {
      record({ kind: 'task_state_write', sessionId, patch });
      return taskStateStore.setTaskState(sessionId, patch, opts);
    },
    getTaskState: taskStateStore.getTaskState,
    setSessionSummary: () => {},
    setSessionStatus: (sessionId, patch) => record({ kind: 'session_status', sessionId, patch }),
    chatBroadcast: (sessionId, payload) => record({ kind: 'chat_broadcast', sessionId, payload }),
    workspaceBroadcast: (dirId, payload) => record({ kind: 'workspace_broadcast', dirId, payload }),
    terminalBroadcast: (sessionId, payload) => record({ kind: 'terminal_broadcast', sessionId, payload }),
    // A push is a lock-screen interrupt. Recording it lets a test prove the user
    // who just pressed Cancel is not notified about their own action.
    triggerPush: (sessionId, type, message) => record({ kind: 'push', sessionId, type, message }),
    evaluateTurnApiError: input => record({ kind: 'api_error_policy', input }),
    turnHasSideEffects: () => false,
    retryNotice: () => 'retry notice',
    loadChatHistory: () => [],
    appendChatMessage: () => {},
  });

  sessionWorkHost = createSessionWorkHost({
    runtime: () => ({
      sessionScheduler: scheduler,
      hasPending: () => false,
      tick: async () => { record({ kind: 'tick' }); },
      admitSessionWork: async input => { record({ kind: 'admit', input }); return { ok: true }; },
    }),
    getRecord: id => persistedSessions.get(id),
    getChatSession: id => chatSessions.get(id),
    getTaskState: taskStateStore.getTaskState,
    pendingUserInput: () => null,
    recordUserInput: () => ({ ok: true }),
    resolveUserInput: () => ({ ok: true }),
    broadcast: (sessionId, payload) => record({ kind: 'chat_broadcast', sessionId, payload }),
    setTaskState: (sessionId, patch, opts) => {
      record({ kind: 'task_state_write', sessionId, patch });
      return taskStateStore.setTaskState(sessionId, patch, opts);
    },
    onTaskBoardQueueEvent: event => taskBoard.onQueueEvent(event),
    onWorkspaceQueueStatus: (sessionId, status) =>
      record({ kind: 'workspace_queue_status', sessionId, status }),
    dispatchStateAction: (result, ctx) => {
      record({ kind: 'classify_dispatch', result, ctx: { sessionName: ctx.sessionName } });
      return classify.dispatchStateAction(result, ctx);
    },
    reconcileTaskProjection: (taskId, opts) => {
      record({ kind: 'projection_reconcile', taskId, opts });
      return taskBoard.reconcileRunState(taskId, opts);
    },
    classifyDisplay,
    cancelClassify: () => {},
    cancelSessionClassifyJobs: sessionId => auxQueue.cancelClassifyFor(sessionId),
    assignKillReason: (runner, reason) => { if (runner) runner.killReason = reason; },
    appendMessage: (sessionId, message) => record({ kind: 'history_append', sessionId, message }),
    cancelPreparation: (sessionId, reason) => record({ kind: 'cancel_preparation', sessionId, reason }),
    chatStream: { isAlive: () => false, cancel() {} },
    zcodeAuth: { ensureZcodeAuth: () => ({ ok: true }) },
    runnerStopTimeoutMs: options.runnerStopTimeoutMs,
    runnerKillGraceMs: options.runnerKillGraceMs,
    log: { warn: (...args) => record({ kind: 'warn', args }), log() {} },
  });

  async function startTurn(text = '第一条消息') {
    const admitted = await scheduler.admit({
      sessionId: 's1', text, idempotencyKey: text, options: { taskId: 'tsk-1' },
    });
    const claims = await outbox.claim({
      workerId: 'test-worker', limit: 8, selectSessionItem: scheduler.selectSessionItem,
    });
    const item = claims.find(candidate => candidate.sessionId === 's1');
    assert.ok(item, 'the admitted entry must be claimable');
    assert.equal((await scheduler.claim(item)).ok, true);
    assert.equal((await outbox.ack(item.id, item.leaseToken)).ok, true);
    assert.equal((await scheduler.started(item)).ok, true);
    return admitted;
  }

  return {
    dir, events, record, kinds, firstIndex,
    persistedSessions, chatSessions, chatState, child, classify, auxJobs,
    taskStateStore, taskBoard, scheduler, outbox,
    get host() { return sessionWorkHost; },
    taskState: () => taskStateStore.getTaskState(persistedSessions.get('s1')),
    boardTask: () => taskBoard.getBoard().tasks['tsk-1'],
    startTurn,
    async enqueueBehind(text) {
      return scheduler.admit({ sessionId: 's1', text, idempotencyKey: text });
    },
    advance(ms = 1) { clock += ms; },
  };
}

// ── 1. The canonical chain ─────────────────────────────────────────────────

test('manual cancel: controller → cancel event → classify → persist → broadcast → projection', async t => {
  const h = harness(t);
  await h.startTurn();
  assert.equal(h.boardTask().runState, 'running');

  const result = await h.host.cancelActiveTurn('s1', {
    source: 'manual_cancel', operationId: 'idem-42',
  });
  assert.equal(result.ok, true);
  assert.equal(result.classifyState, 'E');

  // (a) The runner really stopped — a cancel that only repaints the UI is a lie.
  assert.equal(h.child.kills, 1);
  assert.equal(h.chatState.isStreaming, false);

  // (b) classify persisted the transition, with the cancel envelope that tells a
  // stop apart from a provider fault without a second terminal value.
  const persisted = h.taskState();
  assert.equal(persisted.classifyState, 'E');
  assert.equal(persisted.cancelReason, 'user_cancelled');
  assert.equal(persisted.cancelSource, 'manual_cancel');
  assert.equal(persisted.cancelOperationId, 'idem-42');
  assert.ok(Number.isFinite(persisted.cancelledAt));
  assert.equal(persisted.classifyHistory.length, 1, 'exactly one transition recorded');

  // (c) Every projection reads the same letter. This is the assertion that would
  // have failed before: internal E, external running.
  assert.equal(h.host.getRunState('s1'), 'error', 'session card');
  assert.equal(h.boardTask().runState, 'error', 'task card');
  assert.equal(h.host.isRunActive('s1'), false, 'no lingering running spinner');
  const bar = h.events.filter(event => event.kind === 'chat_broadcast'
    && event.payload.type === 'task_state').pop();
  assert.equal(bar.payload.classifyState, 'E', 'chat bar');
  assert.ok(bar.payload.cancelledAt, 'the bar can say 已取消 rather than API 异常');

  // (d) Ordering, by sequence number.
  assert.ok(h.firstIndex('cancel_preparation') < h.firstIndex('classify_dispatch'));
  assert.ok(h.firstIndex('classify_dispatch') < h.firstIndex('scheduler:completed'));
  assert.ok(h.firstIndex('scheduler:completed') < h.firstIndex('projection_reconcile'));
  const persistIndex = h.events.findIndex(event => event.kind === 'task_state_write'
    && event.patch.classifyState === 'E');
  const notifyIndex = h.events.findIndex(event => event.kind === 'chat_broadcast'
    && event.payload.type === 'notify');
  assert.ok(persistIndex > h.firstIndex('classify_dispatch'), 'classify writes, nobody else');
  assert.ok(notifyIndex >= 0);

  // (e) The scheduler event carries the verdict letter, so no consumer has to
  // guess what "completed" meant.
  const completed = h.events.find(event => event.kind === 'scheduler:completed');
  assert.equal(completed.event.classifyState, 'E');
  assert.equal(completed.event.taskId, 'tsk-1');

  // (f) A cancel is not an API fault and does not push the user who just clicked.
  assert.equal(h.events.some(event => event.kind === 'api_error_policy'), false);
  assert.equal(h.events.some(event => event.kind === 'push'), false);
  const notify = h.events.filter(event => event.kind === 'chat_broadcast'
    && event.payload.type === 'notify').pop();
  assert.equal(notify.payload.message, '已取消：重构取消链路');
});

test('a cancelled turn is never dressed up as completed on the task card', async t => {
  const h = harness(t);
  await h.startTurn();
  await h.host.cancelActiveTurn('s1');
  // `completed` from the scheduler means "the slot was released", not "the task
  // finished". Hard-coding `done` here is what rendered ✅ over a cancel.
  assert.notEqual(h.boardTask().runState, 'done');
  assert.equal(h.boardTask().runState, 'error');
  assert.equal(classifyDisplay('E').cardStatus, 'error');
  assert.equal(classifyDisplay('E').barTint, 'error', 'card and bar agree');
});

test('manual cancel emits stream_end so the frontend live spinner ends with the per-turn runner', async t => {
  const h = harness(t);
  await h.startTurn();
  const result = await h.host.cancelActiveTurn('s1', { source: 'manual_cancel' });
  assert.equal(result.ok, true);
  // stopRunner detaches claudeProc BEFORE signalling, so turn-engine's close
  // handler sees a stale proc and skips its entire finalization - by design,
  // the structured cancel owns that chain. But nothing in the cancel chain
  // broadcasts stream_end, and the classify-E notify never touches the
  // frontend's isStreaming, so the live spinner would hang until reconnect.
  // The one stream_end stopRunner emits is the only end-of-stream the client
  // gets; assert it exists, exactly once, and ahead of the E verdict.
  const streamEnds = h.events.filter(e => e.kind === 'chat_broadcast' && e.payload.type === 'stream_end');
  assert.equal(streamEnds.length, 1, 'cancel of a per-turn runner must emit exactly one stream_end');
  assert.ok(streamEnds[0].seq < h.firstIndex('classify_dispatch'),
    'stream_end precedes the structured E verdict so the spinner falls before the 已取消 notify');
  // A repeat cancel on the now-idle session (claudeProc gone, isStreaming
  // false) must not re-emit a spurious stream_end.
  await h.host.cancelActiveTurn('s1');
  assert.equal(h.events.filter(e => e.kind === 'chat_broadcast' && e.payload.type === 'stream_end').length, 1,
    'no spurious stream_end once the runner is detached');
});

// ── 2. FIFO policy is untouched ────────────────────────────────────────────

test('cancel releases the active slot without advancing the FIFO', async t => {
  const h = harness(t);
  await h.startTurn('第一条消息');
  await h.enqueueBehind('排队中的第二条');
  assert.deepEqual((await h.scheduler.status('s1')).queued.map(item => item.text), ['排队中的第二条']);

  await h.host.cancelActiveTurn('s1');

  const queue = await h.scheduler.status('s1');
  assert.equal(queue.active, null, 'the slot is released');
  assert.deepEqual(queue.queued.map(item => item.text), ['排队中的第二条'],
    'only a D verdict drains the queue — a cancel must not auto-start the next item');
  assert.equal(h.events.some(event => event.kind === 'admit'), false);
});

// ── 3. Idempotency ─────────────────────────────────────────────────────────

test('double-click, HTTP retry and dual-end cancel collapse into one transition', async t => {
  const h = harness(t);
  await h.startTurn();

  const [a, b] = await Promise.all([
    h.host.cancelActiveTurn('s1', { operationId: 'idem-1' }),
    h.host.cancelActiveTurn('s1', { operationId: 'idem-1' }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.deduplicated, true);

  const again = await h.host.cancelActiveTurn('s1', { operationId: 'idem-1' });
  assert.equal(again.ok, true);
  assert.equal(again.alreadyCancelled, true);

  assert.equal(h.child.kills, 1, 'one kill');
  assert.equal(h.taskState().classifyHistory.length, 1, 'one history write');
  assert.equal(h.events.filter(event => event.kind === 'classify_dispatch').length, 1,
    'one verdict');
  assert.equal(h.events.filter(event => event.kind === 'history_append').length, 0);
  // Re-publishing the projection on a repeat click is deliberate and safe: it
  // repairs a card that drifted, and it produces no duplicate task or queue item.
  assert.equal(Object.keys(h.taskBoard.getBoard().tasks).length, 1);
  assert.equal(h.boardTask().runState, 'error');
});

test('a stale projection is repaired even when the computed state already matches', async t => {
  const h = harness(t);
  await h.startTurn();
  await h.host.cancelActiveTurn('s1');
  const before = h.events.filter(event => event.kind === 'board_broadcast').length;

  // Simulate the drift the bug produced: the card says running while the session
  // is canonically E. A repeat cancel must re-emit through the formal reducer.
  h.boardTask().runState = 'running';
  await h.host.cancelActiveTurn('s1');
  assert.equal(h.boardTask().runState, 'error');
  assert.ok(h.events.filter(event => event.kind === 'board_broadcast').length > before,
    'the repair goes out on the normal broadcast chain, not a hand-rolled second one');
});

// ── 4. Late events must not resurrect a cancelled turn ─────────────────────

test('a running heartbeat that was already in flight cannot un-cancel the card', async t => {
  const h = harness(t);
  await h.startTurn();
  await h.host.cancelActiveTurn('s1');
  const stampedAt = h.boardTask().runStateAt;

  const stale = h.taskBoard.onQueueEvent({
    type: 'started', taskId: 'tsk-1', at: stampedAt - 5_000,
  });
  assert.equal(stale.code, 'stale_queue_event');
  assert.equal(h.boardTask().runState, 'error');

  // And the guard survives a reload — the stamp is persisted with the card.
  const reloaded = JSON.parse(fs.readFileSync(path.join(h.dir, 'task_board.json'), 'utf8'));
  assert.equal(reloaded.tasks['tsk-1'].runState, 'error');
  assert.ok(Number(reloaded.tasks['tsk-1'].runStateAt) > 0);
});

test('a late classifier verdict is ignored once the turn is cancelled', async t => {
  const h = harness(t);
  await h.startTurn();
  await h.host.cancelActiveTurn('s1');
  // applyClassifyResult / scanAndReclassify read cancelledAt to drop an Aux
  // verdict that was already in flight. classify writes that field, so the guard
  // still has its input after the controller stopped writing state directly.
  assert.ok(h.taskState().cancelledAt > 0);
  assert.equal(h.taskState().classifyState, 'E');
});

// ── 5. Stop failure is reported as a failure ───────────────────────────────

test('a runner that will not stop lands on an explicit error, not a fake cancel', async t => {
  const h = harness(t, { runnerStopTimeoutMs: 0 });
  await h.startTurn();
  Object.defineProperty(h.chatState, 'isStreaming', {
    get() { return true; }, set() { /* the runner ignores the stop request */ },
  });

  const result = await h.host.cancelActiveTurn('s1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'runner_stop_timeout');
  assert.equal(result.cancelReason, 'cancel_stop_timeout');
  assert.equal(h.taskState().classifyState, 'E');
  assert.equal(h.taskState().cancelReason, 'cancel_stop_timeout');
  assert.equal(h.boardTask().runState, 'error');
  const notify = h.events.filter(event => event.kind === 'chat_broadcast'
    && event.payload.type === 'notify').pop();
  assert.equal(notify.payload.message, '取消失败：任务未能停止');
  assert.ok(h.events.some(event => event.kind === 'warn'));
});

test('a cancel escalates to SIGKILL rather than accepting an ignored SIGTERM', async t => {
  const h = harness(t, { diesOn: 'SIGKILL', runnerKillGraceMs: 10, runnerStopTimeoutMs: 2_000 });
  await h.startTurn();

  const result = await h.host.cancelActiveTurn('s1');
  assert.deepEqual(h.child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.ok, true);
  // A killed runner is still a clean cancel, not a stop failure.
  assert.equal(h.taskState().classifyState, 'E');
  assert.equal(h.taskState().cancelReason, 'user_cancelled');
  assert.equal(h.boardTask().runState, 'error');
});

// ── 5b. The classify input channel ─────────────────────────────────────────

test('cancel drops the judgement queued for the killed turn and the trailing turn-end queues no replacement', async t => {
  const h = harness(t);
  await h.startTurn();
  h.chatState.currentUserText = '把取消链路收敛到 classify';
  h.chatState.currentAssistantText = '正在修改 session-work-host 的取消路径实现';

  // Normal path: a turn end is judged by the Aux queue.
  h.classify.classifyTurnEnd(h.chatState, 's1');
  assert.equal(h.auxJobs.enqueued.length, 1);
  assert.equal(h.auxJobs.enqueued[0].type, 'intent_classify');

  await h.host.cancelActiveTurn('s1');
  // 1. The judgement admitted for the killed turn is dropped, not left to run.
  assert.equal(h.auxJobs.cancelledFor.includes('s1'), true);
  // 2. The kill makes the CLI exit, and its close handler runs finalize →
  //    classifyTurnEnd once more. That turn already has its verdict; queueing a
  //    second judgement would only pay for a result applyClassifyResult drops.
  h.classify.classifyTurnEnd(h.chatState, 's1');
  assert.equal(h.auxJobs.enqueued.length, 1);
  assert.equal(h.taskState().classifyState, 'E');
});

// ── 6. No active scheduler entry ───────────────────────────────────────────

test('cancelling with no active entry still publishes the canonical snapshot', async t => {
  const h = harness(t);
  // No startTurn(): the scheduler has nothing active. The old code returned
  // {ok:true, alreadyIdle:true} here and emitted nothing at all, which is how a
  // card stayed on `running` with no event to correct it.
  const result = await h.host.cancelActiveTurn('s1');
  assert.equal(result.ok, true);
  assert.equal(result.alreadyIdle, true);
  assert.equal(h.taskState().classifyState, 'E');
  assert.equal(h.boardTask().runState, 'error');
  assert.equal(h.events.some(event => event.kind === 'projection_reconcile'), true);
});

// ── 7. Streaming / tool execution in flight ────────────────────────────────

test('cancelling mid-tool persists the partial reply once and still transitions', async t => {
  const h = harness(t);
  await h.startTurn();
  h.chatState.currentAssistantText = '我正在读取文件';
  h.chatState.currentToolCalls = [{ name: 'Read', input: {} }];

  await h.host.cancelActiveTurn('s1');
  const appended = h.events.filter(event => event.kind === 'history_append');
  assert.equal(appended.length, 1);
  assert.equal(appended[0].message.cancelled, true);
  assert.equal(appended[0].message.tools.length, 1);
  assert.equal(h.taskState().classifyState, 'E');
  assert.equal(h.boardTask().runState, 'error');
});

// ── 8. The HTTP controller boundary ────────────────────────────────────────

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
    delete(route, handler) { routes.set(`DELETE ${route}`, handler); },
  };
}

async function invoke(app, method, route, options = {}) {
  const handler = app.routes.get(`${method} ${route}`);
  assert.equal(typeof handler, 'function', `missing ${method} ${route}`);
  const headers = Object.fromEntries(Object.entries(options.headers || {})
    .map(([key, value]) => [key.toLowerCase(), value]));
  const request = {
    params: options.params || {}, query: {}, body: options.body, headers,
    get(name) { return headers[String(name).toLowerCase()]; },
    id: 'request-id',
  };
  const response = {
    statusCode: 200, body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler(request, response);
  return response;
}

function routeFixture(cancelResult = { ok: true, classifyState: 'E' }) {
  const calls = [];
  const app = fakeApp();
  createOrchestrationRoutes({
    records: new Map([['s1', { id: 's1', cwd: '/repo' }]]),
    runtime: {
      operations: { list: async () => [], listTasks: async () => [] },
      sessionScheduler: {
        status: async () => ({ state: 'running', queued: [] }),
        resolve: async (sessionId, input) => {
          calls.push({ type: 'scheduler.resolve', input });
          return { ok: false, code: 'no_active_task' };
        },
        cancelQueued: async () => ({ ok: true }),
        insertQueued: async () => ({ ok: true }),
      },
      tick: async () => { calls.push({ type: 'tick' }); },
      register: async () => ({}),
      resolveCallback: async () => ({}),
      listForSession: () => [],
      stats: () => ({}),
      cancel: () => ({ ok: true }),
      startDetached: async () => ({}),
      hasPending: () => false,
    },
    waitInjector: { listForSession: () => [], stats: () => ({}), cancel: () => ({ ok: true }) },
    detached: { status: () => null },
    cwdForSession: () => '/repo',
    resolveCwd: (base, value) => `${base}/${value}`,
    toWaitDto: wait => wait,
    withApiMeta: payload => payload,
    requestContext: () => ({ requestId: 'r' }),
    v1Error: (req, res, status, message, code) => res.status(status).json({ error: message, code }),
    cancelActiveTurn: async (sessionId, options) => {
      calls.push({ type: 'cancelActiveTurn', sessionId, options });
      return cancelResult;
    },
  }).mountRoutes(app);
  return { app, calls };
}

test('the queue cancel route delegates to the cancel intent and never resolves the entry', async () => {
  const { app, calls } = routeFixture();
  const response = await invoke(app, 'POST', '/api/sessions/:id/queue/action', {
    params: { id: 's1' },
    headers: { 'idempotency-key': 'idem-9' },
    body: { action: 'cancel', confirm: true, reason: '用户点了取消' },
  });

  assert.equal(response.statusCode, 200, 'a successful cancel is not a 404');
  assert.equal(response.body.classifyState, 'E');
  const cancel = calls.find(call => call.type === 'cancelActiveTurn');
  assert.equal(cancel.sessionId, 's1');
  assert.equal(cancel.options.source, 'manual_cancel');
  assert.equal(cancel.options.operationId, 'idem-9', 'Idempotency-Key becomes the operation id');
  assert.equal(cancel.options.reason, '用户点了取消');
  // resolve() would have overwritten the E verdict with D, and — because the
  // active entry was already released — answered a successful cancel with 404.
  assert.equal(calls.some(call => call.type === 'scheduler.resolve'), false);
  // No tick(): a cancel does not advance the FIFO.
  assert.equal(calls.some(call => call.type === 'tick'), false);
});

test('a failed stop surfaces as a non-200 instead of a green checkmark', async () => {
  const { app } = routeFixture({ ok: false, code: 'runner_stop_timeout', classifyState: 'E' });
  const response = await invoke(app, 'POST', '/api/sessions/:id/queue/action', {
    params: { id: 's1' },
    body: { action: 'cancel', confirm: true },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'runner_stop_timeout');
});

test('cancel still requires explicit confirmation', async () => {
  const { app, calls } = routeFixture();
  const response = await invoke(app, 'POST', '/api/sessions/:id/queue/action', {
    params: { id: 's1' }, body: { action: 'cancel' },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error, 'confirmation_required');
  assert.equal(calls.length, 0);
});

// ── 9. No legacy direct-write path is left behind ──────────────────────────

test('no module outside classify writes a cancel terminal state', () => {
  const hostSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'session-work-host.js'), 'utf8');
  // The host may stop the runner and submit a result; it may not persist one.
  assert.doesNotMatch(hostSource, /setTaskState\([^)]*cancelledAt/,
    'session-work-host must not write the cancel envelope itself');
  assert.match(hostSource, /deps\.dispatchStateAction\(/);

  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'orchestration.js'), 'utf8');
  assert.doesNotMatch(routeSource, /action === 'cancel'[\s\S]{0,400}sessionScheduler\.resolve/,
    'the cancel branch must return before reaching resolve()');

  const machineSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'classify', 'state-machine.js'), 'utf8');
  assert.match(machineSource, /cancelledAt: cancel\.at/,
    'classify is the sole writer of cancelledAt');

  // The frontend may only claim 「正在取消」; the terminal label comes from the
  // classify broadcast.
  const chatSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat.js'), 'utf8');
  assert.match(chatSource, /finishCancelledTurn[\s\S]{0,400}正在取消/);
  assert.doesNotMatch(chatSource, /addSystemMsg\('Cancelled'\)/);
});
