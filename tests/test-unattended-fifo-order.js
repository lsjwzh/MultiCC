'use strict';

// Unattended v2 orders its own messages against the session-work FIFO by
// DELIVERING them, not by reading the queue: the real scheduler already gates
// the FIFO behind a pending question (answer first) and behind an E fault
// (continuation first, FIFO staged until D), and drains it on its own after D.
//
// These tests compose the REAL scheduler + outbox + session-work host behind
// the real unattended host, the real classify state machine, the real
// session-delivery boundary, the real wait injector and the REAL Rust kernel —
// only external ports (clock, transports) are test doubles. They pin:
//   (a) W + pending question + 2 staged deliveries: the auto-answer is selected
//       first and the backlog only afterwards (after the answer's D);
//   (b) E + staged backlog: the supervisor's fault-continue (its real
//       onTurnEnd → injectSystemMsg → deliverContinuation → admission path) is
//       selectable first, and the backlog stays staged until a D;
//   (c) D + staged backlog: the supervisor DEFERS (no aux call, no round, held
//       push released) and the backlog's own D settle is what evaluates.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createOrchestrationStore } = require('../src/orchestration/store');
const { createOutbox, admitOutboxItem } = require('../src/outbox');
const { createSessionWorkScheduler } = require('../src/session-work/scheduler');
const { createSessionWorkHost } = require('../src/session-work/host');
const { createUnattendedHost } = require('../src/unattended/host');
const nativeKernel = require('../src/unattended/kernel');
const { createClassifyStateMachine } = require('../src/classify/state-machine');
const { createSessionDelivery } = require('../src/session/delivery');
const waitInjector = require('../src/wait/injector');
const { createProcessingWatchdog } = require('../src/chat/process-watchdog');

const TAG = '[无人值守 Unattended]';
const SYS_PREFIX = '🔇';
const SESSION = 's1';

async function flush(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setImmediate(resolve));
}

async function until(check, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await flush(1);
  }
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-unattended-order-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 1_000;
  // Fake clock for the supervisor's durable timers; the scheduler's own
  // timestamps use the same `clock`.
  const timers = new Map();
  let timerSeq = 0;
  const store = createOrchestrationStore({
    file: path.join(dir, 'orchestration.json'),
    now: () => clock,
  });
  const outbox = createOutbox({
    store,
    now: () => clock,
    leaseTokenFactory: (() => {
      let sequence = 0;
      return () => `lease-${++sequence}`;
    })(),
  });

  const record = { id: SESSION, type: null, taskState: { classifyState: 'D', classifyHistory: [] } };
  const persistedSessions = new Map([[SESSION, record]]);
  const chatState = {
    cli: 'qoder', isStreaming: false, currentAssistantText: '',
    currentTask: { goal: 'ship it', phase: 'planning' }, _currentTaskId: null,
  };
  let pending = null;
  const scheduler = createSessionWorkScheduler({
    store,
    now: () => clock,
    getClassifyState: () => record.taskState.classifyState,
    getPendingUserInput: () => pending,
    getUnattendedState: () => record.unattended,
  });

  let machine = null;
  const sessionWorkHost = createSessionWorkHost({
    runtime: () => ({
      sessionScheduler: scheduler,
      hasPending: () => false,
      tick: async () => {},
      admitSessionWork: spec => scheduler.admit(spec),
    }),
    getRecord: () => record,
    getChatSession: () => chatState,
    getTaskState: value => value?.taskState || record.taskState,
    pendingUserInput: () => pending,
    getTurnLiveness: () => ({ state: 'inactive' }),
    recordUserInput: () => ({ ok: true }),
    resolveUserInput: () => { pending = null; return { ok: true }; },
    broadcast: () => {},
    setTaskState: (id, patch) => { Object.assign(record.taskState, patch || {}); },
    onTaskBoardQueueEvent() {},
    onWorkspaceQueueStatus() {},
    classifyDisplay: () => ({ cardStatus: 'running' }),
    // Wired to the REAL classify state machine below: dispatchStateAction is
    // the production cancel/finalize observer, not a hand-written hook.
    dispatchStateAction: (result, ctx) => machine.dispatchStateAction(result, ctx),
    reconcileTaskProjection() {},
    cancelClassify() {},
    cancelSessionClassifyJobs() {},
    assignKillReason() {},
    finishProviderAttempt() {},
    stopBackgroundForInsert() {},
    appendMessage() { return true; },
    chatStream: { isAlive: () => false, status: () => ({ busy: false }), cancel() {} },
    cancelPreparation() {},
    log: { warn() {}, log() {}, info() {} },
  });

  // The REAL native kernel, recorded only. These tests exercise scheduler
  // ordering; the policy bytes are Rust and are exercised verbatim.
  const calls = { decide: 0, enqueue: 0, turnEnds: [] };
  const kernel = {
    tag: () => nativeKernel.tag(),
    deferEvaluation: input => nativeKernel.deferEvaluation(input),
    normalizeConfig: input => nativeKernel.normalizeConfig(input),
    clampDuration: input => nativeKernel.clampDuration(input),
    armDeadline: input => nativeKernel.armDeadline(input),
    deadlineExpired: input => nativeKernel.deadlineExpired(input),
    buildVerdictPrompt: input => nativeKernel.buildVerdictPrompt(input),
    parseVerdict: text => nativeKernel.parseVerdict(text),
    decide: input => {
      calls.decide += 1;
      return nativeKernel.decide(input);
    },
    decideTurnEnd: input => {
      calls.turnEnds.push(input);
      return nativeKernel.decideTurnEnd(input);
    },
    selectQueued: input => nativeKernel.selectQueued(input),
    faultInstruction: () => nativeKernel.faultInstruction(),
  };

  const unattended = createUnattendedHost({
    getRecord: () => record,
    persistState: (id, next) => {
      if (next == null) delete record.unattended;
      else record.unattended = next;
      return record.unattended || null;
    },
    getHistory: () => [
      { role: 'user', content: 'ship it' },
      { role: 'assistant', content: 'working' },
    ],
    getPendingQuestion: () => pending,
    getAuxQueue: () => ({
      enqueue: async request => {
        calls.enqueue += 1;
        return {
          text: '{"verdict":"continue","reason":"more work",'
            + '"nextInstruction":"do the next thing","answer":"option B"}',
        };
      },
    }),
    // Exactly what src/task-context-host.js deliverSessionMessage reaches at
    // the admission boundary; `system`/`unattendedSystem` ride along untouched.
    deliver: (id, text, options) => sessionWorkHost.admit(id, text, options),
    // Exactly how server.js wires the supervisor's `inject` port: the typed
    // session-delivery boundary, whose admission result tells the supervisor
    // whether its continuation is still queued.
    inject: (id, text, options) => delivery.deliverSystem(id, text, { ...options, unattendedSystem: true }),
    withdrawQueued: (id, entryId) => scheduler.cancelQueued(id, entryId, {
      actor: 'unattended', reason: 'paused',
    }),
    broadcast: () => {},
    notify: () => {},
    appendMessage: () => true,
    hasQueuedDeliveries: id => sessionWorkHost.hasQueuedDeliveries(id),
    isRunActive: () => false,
    getTaskState: () => record.taskState,
    getSchedulerStatus: id => scheduler.status(id),
    listSessionIds: () => [SESSION],
    now: () => clock,
    setTimeout: (fn, delay) => {
      const id = ++timerSeq;
      timers.set(id, { fn, at: clock + Math.max(0, Number(delay) || 0) });
      return { id, unref() {} };
    },
    clearTimeout: timer => {
      const id = timer && timer.id;
      if (id) timers.delete(id);
    },
    kernel,
  });

  // The production classify machine behind session-work's cancel/finalize
  // observer. Only its external ports are test doubles.
  machine = createClassifyStateMachine({
    persistedSessions,
    chatSessions: new Map([[SESSION, chatState]]),
    getSessionSummaries: () => new Map(),
    logger: { info() {}, warn() {}, error() {} },
    getAuxQueue: () => null,
    getSessionWorkHost: () => sessionWorkHost,
    getLivenessRuntime: () => ({ ownership: () => ({ state: 'inactive', reason: 'test' }) }),
    getTaskContextHost: () => ({ recordGoal() {} }),
    getTaskBoardRuntime: () => ({ onTurnEnd() {}, onTaskAttributionSettled() {} }),
    getUserInputSignalHost: () => ({ apply: (_sessionId, result) => result, pending: () => null }),
    getApiErrorHost: () => ({ recordApiError() {} }),
    getWaitInjector: () => waitInjector,
    setTaskState: (id, patch) => { Object.assign(record.taskState, patch || {}); },
    getTaskState: value => value?.taskState || record.taskState,
    appendClassifyHistory: (id, entry, cutoff) => {
      const taskState = persistedSessions.get(id)?.taskState;
      if (!taskState) return;
      const kept = (Array.isArray(taskState.classifyHistory) ? taskState.classifyHistory : [])
        .filter(item => Number(item?.at || 0) >= cutoff);
      taskState.classifyHistory = [...kept, entry];
    },
    setSessionSummary() {},
    setSessionStatus() {},
    chatBroadcast() {},
    workspaceBroadcast() {},
    terminalBroadcast() {},
    triggerPush() {},
    evaluateTurnApiError() {},
    turnHasSideEffects: () => false,
    retryNotice: () => '',
    loadChatHistory: () => [],
    appendChatMessage() {},
    annotateChatTurn: () => [],
    getUnattendedHost: () => unattended,
  });

  const delivery = createSessionDelivery({
    admit: (session, text, options) => sessionWorkHost.admit(session, text, options),
  });
  waitInjector.init({
    inject: (session, text, options) => delivery.deliverContinuation(session, text, options),
    log: () => {},
  });
  t.after(() => waitInjector.stop());

  async function claimOne() {
    const claims = await outbox.claim({
      workerId: 'test-worker',
      limit: 8,
      selectSessionItem: scheduler.selectSessionItem,
    });
    const item = claims.find(candidate => candidate.sessionId === SESSION) || null;
    if (!item) return null;
    const claimed = await scheduler.claim(item);
    assert.equal(claimed.ok, true, `claim ${item.id}`);
    return item;
  }

  async function startClaim(item) {
    assert.equal((await outbox.ack(item.id, item.leaseToken)).ok, true);
    assert.equal((await scheduler.started(item)).ok, true);
    record.taskState.classifyState = 'P';
  }

  async function activeTurn(text) {
    const admitted = await scheduler.admit({ sessionId: SESSION, text, idempotencyKey: text });
    const item = await claimOne();
    assert.ok(item, `active turn ${text} claimable`);
    assert.equal(item.id, admitted.entry.id);
    await startClaim(item);
    return admitted;
  }

  return {
    outbox,
    scheduler,
    store,
    sessionWorkHost,
    record,
    chatState,
    calls,
    unattended,
    claimOne,
    startClaim,
    activeTurn,
    setPending(value) { pending = value; },
    setClassifyState(value) { record.taskState.classifyState = value; },
    now: () => clock,
    advance(ms = 1) { clock += ms; },
    fireTimers() {
      let fired = 0;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock) {
          timers.delete(id);
          fired += 1;
          timer.fn();
        }
      }
      return fired;
    },
    arm: () => unattended.start(SESSION, { goal: 'ship it', maxDurationMinutes: 90, evaluateNow: false }),
  };
}

async function pendingIds(h) {
  const items = await h.outbox.list({ sessionId: SESSION, states: 'pending' });
  return items.map(item => item.id).sort();
}

test('(a) W with a pending question: the auto-answer is selected before the staged FIFO', async t => {
  const h = fixture(t);
  await h.arm();

  await h.activeTurn('ask the user');
  h.setPending({ requestId: 'q1', resolved: false, createdAt: 1_002 });
  const typed = await h.sessionWorkHost.admit(SESSION, 'typed queued work', {
    clientMsgId: 'typed', taskSource: 'task-shell', originContinue: true,
    taskShellReceiptId: 'typed', userInputRequestId: 'q1',
    taskShellControl: { intent: 'answer', turnId: 'question-turn' },
  });
  const system = await h.scheduler.admit({
    sessionId: SESSION,
    text: 'system queued work',
    source: 'background',
    idempotencyKey: 'system',
  });
  assert.equal(typed.queued, true);
  assert.equal(typed.entry.payload.workKind, 'task');
  assert.equal(system.queued, true);

  h.setClassifyState('W');
  await h.scheduler.complete(SESSION, { classifyState: 'W', awaitingRequestId: 'q1' });
  assert.equal(await h.claimOne(), null, 'staged work holds behind the open question');

  // The real kernel answers the pending question itself (the aux reply carries
  // `answer`); the supervisor delivers it exactly like a human answer.
  const result = await h.unattended.evaluate(SESSION, { reason: 'turn_end', assistantText: 'Which option?' });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'inject');

  const answer = await h.claimOne();
  assert.ok(answer, 'the answer is immediately selectable');
  assert.equal(answer.payload.workKind, 'answer');
  assert.equal(answer.payload.requestId, 'q1');
  assert.equal(answer.payload.options.userInputRequestId, 'q1');
  assert.equal(answer.payload.options.unattendedSystem, true);
  assert.equal(answer.payload.options.system, true);
  assert.deepEqual(await pendingIds(h), [typed.entry.id, system.entry.id].sort(),
    'both queued deliveries stay staged behind the answer');

  // The answer's turn finishes D → the FIFO resumes in admission order.
  await h.startClaim(answer);
  h.setPending(null);
  h.setClassifyState('D');
  await h.scheduler.complete(SESSION, { classifyState: 'D' });

  const first = await h.claimOne();
  assert.equal(first.id, typed.entry.id, 'the older queued delivery runs after the answer');
  await h.startClaim(first);
  h.setClassifyState('D');
  await h.scheduler.complete(SESSION, { classifyState: 'D' });

  const second = await h.claimOne();
  assert.equal(second.id, system.entry.id);
  await h.startClaim(second);
  h.setClassifyState('D');
  await h.scheduler.complete(SESSION, { classifyState: 'D' });
  assert.equal(await h.claimOne(), null, 'the FIFO is fully drained');
});

test('(b) E fault: the supervisor fault-continue is selectable before a staged FIFO', async t => {
  const h = fixture(t);
  await h.arm();

  await h.activeTurn('do work');
  const backlogA = await h.scheduler.admit({ sessionId: SESSION, text: 'queued A', source: 'operation', idempotencyKey: 'a' });
  const backlogB = await h.scheduler.admit({ sessionId: SESSION, text: 'queued B', source: 'operation', idempotencyKey: 'b' });
  assert.equal(backlogA.queued, true);
  assert.equal(backlogB.queued, true);

  h.setClassifyState('E');
  await h.scheduler.complete(SESSION, { classifyState: 'E' });
  assert.equal(await h.claimOne(), null, 'E leaves ordinary FIFO work staged');

  // The REAL supervisor path: onTurnEnd → inject(tagged) → injectSystemMsg →
  // deliverContinuation → session-work admission.
  const decision = await h.unattended.onTurnEnd(SESSION, { kind: 'fault', retryScheduled: false });
  assert.equal(decision.action, 'fault_continue');
  assert.equal(h.calls.turnEnds.length, 1);

  const injected = await until(async () => {
    const claims = await h.outbox.claim({
      workerId: 'test-worker',
      limit: 8,
      selectSessionItem: h.scheduler.selectSessionItem,
    });
    if (!claims.length) return null;
    const item = claims.find(candidate => candidate.sessionId === SESSION);
    if (!item) return null;
    const claimed = await h.scheduler.claim(item);
    assert.equal(claimed.ok, true);
    return item;
  }, 'fault-continue admission');
  assert.equal(injected.payload.workKind, 'continuation',
    'the delivery layer admits the supervisor message as a continuation');
  assert.equal(injected.directRun, true, 'a continuation is an insert-now control');
  assert.ok(injected.payload.message.startsWith(`${SYS_PREFIX}${TAG}`),
    `delivery adds the system prefix: ${injected.payload.message}`);
  assert.deepEqual(await pendingIds(h), [backlogA.entry.id, backlogB.entry.id].sort(),
    'the staged backlog is untouched');

  // While the fault-continue runs (P), the backlog stays staged.
  await h.startClaim(injected);
  assert.equal(await h.claimOne(), null);

  // Its D verdict releases the FIFO, which drains by itself.
  h.setClassifyState('D');
  await h.scheduler.complete(SESSION, { classifyState: 'D' });
  const first = await h.claimOne();
  assert.equal(first.id, backlogA.entry.id);
  await h.startClaim(first);
  h.setClassifyState('D');
  await h.scheduler.complete(SESSION, { classifyState: 'D' });
  const second = await h.claimOne();
  assert.equal(second.id, backlogB.entry.id);
});

test('(c) D settle with a staged backlog defers; the backlog drains, then its own D evaluates', async t => {
  const h = fixture(t);
  await h.arm();

  await h.activeTurn('finish A');
  const backlog = await h.scheduler.admit({ sessionId: SESSION, text: 'queued after A', source: 'operation', idempotencyKey: 'backlog' });
  assert.equal(backlog.queued, true);

  h.setClassifyState('D');
  await h.scheduler.complete(SESSION, { classifyState: 'D' });

  const pushes = [];
  const deferred = await h.unattended.onTurnEnd(SESSION, {
    kind: 'settle',
    assistantText: 'A finished',
    settle: 'D',
    fallbackPush: () => pushes.push('classic'),
  });
  assert.deepEqual(deferred, { ok: false, code: 'backlog_pending' });
  assert.equal(h.calls.decide, 0, 'no verdict on stale output');
  assert.equal(h.calls.enqueue, 0, 'no aux call and no round burned');
  assert.deepEqual(pushes, ['classic'], 'the held classic push is released, not lost');
  assert.equal(h.unattended.get(SESSION).rounds, 0);

  // The scheduler runs the user's queued item next — not a supervisor follow-up.
  const next = await h.claimOne();
  assert.equal(next.id, backlog.entry.id);
  const all = await h.outbox.list({ sessionId: SESSION });
  assert.equal(all.filter(item => String(item.payload?.message || '').includes(TAG)).length, 0,
    'the deferred settle injected nothing');

  // The backlog's own D is the settle that evaluates — no deadlock.
  await h.startClaim(next);
  h.setClassifyState('D');
  await h.scheduler.complete(SESSION, { classifyState: 'D' });
  await h.unattended.onTurnEnd(SESSION, {
    kind: 'settle',
    assistantText: 'B finished',
    settle: 'D',
    fallbackPush: () => pushes.push('classic-after-backlog'),
  });
  await flush();
  assert.equal(h.calls.decide, 1, 'the last backlog settle makes the verdict');
  assert.equal(h.calls.enqueue, 1);
  assert.deepEqual(pushes, ['classic'], 'the follow-up settle produced its own outcome');
});

test('ordinary unattended user inputs drain in FIFO before the next automatic instruction', async t => {
  const h = fixture(t);
  await h.arm();
  await h.activeTurn('current task');
  const queued = [];
  for (const text of ['first user input', 'second user input']) {
    assert.equal(h.unattended.noteUserMessage(SESSION).status, 'active');
    const result = await h.sessionWorkHost.admit(SESSION, text, {
      clientMsgId: text, taskSource: 'task-shell', originContinue: true,
    });
    assert.equal(result.queued, true);
    queued.push(result.entry.id);
  }
  h.setClassifyState('D');
  await h.scheduler.complete(SESSION, { classifyState: 'D' });
  const deferred = await h.unattended.onTurnEnd(SESSION, {
    kind: 'settle', settle: 'D', assistantText: 'current task finished',
  });
  assert.equal(deferred.code, 'backlog_pending');
  assert.equal(h.calls.enqueue, 0);
  for (const [index, entryId] of queued.entries()) {
    const next = await h.claimOne();
    assert.equal(next.id, entryId);
    await h.startClaim(next);
    h.setClassifyState('D');
    await h.scheduler.complete(SESSION, { classifyState: 'D' });
    await h.unattended.onTurnEnd(SESSION, {
      kind: 'settle', settle: 'D', assistantText: `user input ${index} finished`,
    });
    assert.equal(h.unattended.get(SESSION).status, 'active');
    assert.equal(h.calls.enqueue, index === 0 ? 0 : 1);
  }
});

test('(d) a host-side watchdog cancel leaves the frozen slot and its continuation is selectable', async t => {
  // The incident shape: a restart parks the active slot as frozen/classify_running,
  // the processing watchdog cancels the dead turn, and nothing wakes the session
  // again until a real user message. The cancel must (a) reach the one supervisor
  // entry, (b) release the slot, (c) make the fault continuation selectable while
  // the staged FIFO stays staged.
  const h = fixture(t);
  await h.arm();

  await h.activeTurn('do work');
  const backlog = await h.scheduler.admit({
    sessionId: SESSION, text: 'queued A', source: 'operation', idempotencyKey: 'a',
  });
  assert.equal(backlog.queued, true);

  // The real classify machine is the dispatchStateAction wired into the
  // session-work host above: it reports the turn end through the one supervisor
  // entry *and* runs the scheduler transition. No hand-written hook here.
  //
  // The restart shape: the previous turn settled (`turnId` === the supervisor's
  // lastTurnEndId), the current turn is still persisted as in-flight
  // (`activeTurnId`), `_activeTurn` is gone because the process died. A stale-id
  // fallback here would make the watchdog cancel look like a duplicate of the
  // previous turn: zero injections and a session that stays locked.
  h.record.unattended.lastTurnEndId = 'turn-prev';
  h.record.taskState.turnId = 'turn-prev';
  h.record.taskState.activeTurnId = 'turn-current';
  assert.equal(h.record.taskState.classifyState, 'P');
  assert.equal(h.chatState?._activeTurn, undefined);

  const cancelled = await h.sessionWorkHost.cancelActiveTurn(SESSION, {
    reason: 'process_watchdog',
    killReason: 'process_watchdog',
    source: 'process_watchdog',
  });
  assert.equal(cancelled.ok, true);
  assert.equal(h.calls.turnEnds.length, 1, 'the watchdog cancel reached the supervisor');
  assert.equal(h.calls.turnEnds[0].kind, 'cancel');
  assert.equal(h.calls.turnEnds[0].cancelSource, 'process_watchdog');
  assert.equal(h.calls.turnEnds[0].turnId, 'turn-current',
    'the in-flight identity is used, never the already-settled previous turn id');
  assert.equal(h.record.taskState.turnId, 'turn-current',
    'the cancel transition records the turn it actually ended');
  assert.equal(h.record.taskState.activeTurnId, null, 'the in-flight marker is cleared');

  const status = await h.scheduler.status(SESSION);
  assert.equal(status.active, null, 'the E cancel released the active slot (no lasting freeze)');

  const injected = await until(async () => {
    const claims = await h.outbox.claim({
      workerId: 'test-worker',
      limit: 8,
      selectSessionItem: h.scheduler.selectSessionItem,
    });
    if (!claims.length) return null;
    const item = claims.find(candidate => candidate.sessionId === SESSION);
    if (!item) return null;
    const claimed = await h.scheduler.claim(item);
    assert.equal(claimed.ok, true);
    return item;
  }, 'watchdog fault-continuation admission');
  assert.equal(injected.payload.workKind, 'continuation');
  assert.ok(injected.payload.message.startsWith(`${SYS_PREFIX}${TAG}`));
  assert.deepEqual(await pendingIds(h), [backlog.entry.id], 'the staged backlog stays staged');
});

// The incident shape end to end, on the real scheduler: a persisted P turn
// (with its in-flight identity) survives a restart, the scheduler parks it as
// frozen/classify_running, and exactly one owner recovers it. Boot reconciliation
// must not touch it; the processing watchdog's dead-runner detection cancels it
// through the one supervisor entry, and that continuation's D is what lets the
// already-staged task.interrupted notice through.
function processingWatchdog(h) {
  return createProcessingWatchdog({
    listRecords: () => [[SESSION, { ...h.record, kind: 'chat' }]],
    getTaskState: record => record.taskState,
    getChatSession: () => h.chatState,
    getStreamStatus: () => ({ busy: false, alive: false }),
    getPreparation: () => ({ phase: 'idle' }),
    getSchedulerStatus: id => h.scheduler.status(id),
    isPidAlive: () => false,
    cancelTurn: (id, options) => h.sessionWorkHost.cancelActiveTurn(id, options),
    now: () => h.now(),
    startGraceMs: 0,
    deadConfirmMs: 0,
    logger: { warn() {} },
  });
}

async function claimNext(h, label) {
  return until(async () => {
    const claims = await h.outbox.claim({
      workerId: 'test-worker',
      limit: 8,
      selectSessionItem: h.scheduler.selectSessionItem,
    });
    const item = claims.find(candidate => candidate.sessionId === SESSION);
    if (!item) return null;
    const claimed = await h.scheduler.claim(item);
    assert.equal(claimed.ok, true, `claim ${item.id}`);
    return item;
  }, label);
}

test('(e) restart: the watchdog, not boot, recovers a persisted P turn into one fault-continuation', async t => {
  const h = fixture(t);
  await h.arm();

  // The old server died mid-turn. `activeTurnId` is the turn that was running;
  // `turnId` still names the previous settled turn.
  await h.activeTurn('do work');
  h.record.taskState.turnId = 'turn-prev';
  h.record.taskState.activeTurnId = 'turn-current';
  h.record.unattended.lastTurnEndId = 'turn-prev';

  // A task.interrupted notice was already staged before the restart. It must
  // wait for the recovered turn's own D, exactly like ordinary FIFO work.
  await h.store.mutate(draft => admitOutboxItem(draft, {
    id: 'task:child:interrupted',
    sessionId: SESSION,
    payload: {
      type: 'task.interrupted',
      taskId: 'child',
      deliveryText: `${SYS_PREFIX}【内置任务已中断】Task/Agent child 在 MultiCC 服务重启时仍未结束`,
    },
    source: { type: 'task', taskId: 'child' },
    now: h.now(),
  }));

  // Production start() order: expired leases, then scheduler.recover().
  await h.outbox.recoverExpired();
  await h.scheduler.recover({ stateForSession: () => h.record.taskState });
  const recovered = await h.scheduler.status(SESSION);
  assert.equal(recovered.state, 'frozen');
  assert.equal(recovered.freezeReason, 'classify_running');
  assert.ok(recovered.active, 'the persisted running item still owns the slot');

  // Single owner: boot reconciliation never replays a persisted P turn. (Before
  // this it also ran here, and only duplicate_turn kept the injection single.)
  const boot = await h.unattended.reconcileStartup();
  assert.deepEqual(boot.settled, [], 'boot leaves the orphan to the watchdog');
  assert.equal(h.calls.turnEnds.length, 0);

  // One sweep marks the dead runner suspect, the next confirms and cancels it
  // through the one supervisor entry.
  const watchdog = processingWatchdog(h);
  assert.equal((await watchdog.sweep()).results[0].action, 'suspect');
  h.advance(6000);  // past the dead-runner confirmation window
  assert.equal((await watchdog.sweep()).results[0].action, 'cancelled');
  assert.equal(h.calls.turnEnds.length, 1, 'the watchdog cancel reached the supervisor');
  assert.equal(h.calls.turnEnds[0].kind, 'cancel');
  assert.equal(h.calls.turnEnds[0].cancelSource, 'process_watchdog');
  assert.equal(h.calls.turnEnds[0].turnId, 'turn-current',
    'the in-flight identity is used, never the already-settled previous turn id');
  assert.equal(h.record.taskState.classifyState, 'E');
  assert.equal(h.record.taskState.activeTurnId, null, 'the in-flight marker is cleared');
  assert.equal((await h.scheduler.status(SESSION)).active, null, 'the slot is released');

  const continuation = await claimNext(h, 'recovery fault-continuation admission');
  assert.equal(continuation.payload.workKind, 'continuation');
  assert.ok(continuation.payload.message.startsWith(`${SYS_PREFIX}${TAG}`));

  // The continuation runs (P): the staged notice stays staged.
  await h.startClaim(continuation);
  assert.equal(await h.claimOne(), null, 'the interrupt notice waits for a D');

  // This turn's D is what drains the notice.
  h.setClassifyState('D');
  await h.scheduler.complete(SESSION, { classifyState: 'D' });
  const notice = await h.claimOne();
  assert.ok(notice, 'the staged interrupt notice drains after the continuation D');
  assert.equal(notice.id, 'task:child:interrupted');

  const all = await h.outbox.list({ sessionId: SESSION });
  assert.equal(all.filter(item => String(item.payload?.message || '').includes(TAG)).length, 1,
    'exactly one supervisor injection for the whole restart flow');
});

test('(f) restart with no scheduler item: the watchdog still owns the persisted P turn', async t => {
  // Shape B: the old schedule did not survive, so scheduler.recover() creates
  // nothing and status is idle. Boot still must not replay; the watchdog's
  // dead-runner path must still settle the turn and wake the session once.
  const h = fixture(t);
  await h.arm();
  h.record.unattended.lastTurnEndId = 'turn-prev';
  h.record.taskState = {
    classifyState: 'P', classifyHistory: [], turnId: 'turn-prev', activeTurnId: 'turn-current',
  };

  await h.outbox.recoverExpired();
  await h.scheduler.recover({ stateForSession: () => h.record.taskState });
  const status = await h.scheduler.status(SESSION);
  assert.equal(status.state, 'idle');
  assert.equal(status.active, null);

  const boot = await h.unattended.reconcileStartup();
  assert.deepEqual(boot.settled, [], 'boot does not invent a settle without a cancel record');
  assert.equal(h.calls.turnEnds.length, 0);

  const watchdog = processingWatchdog(h);
  assert.equal((await watchdog.sweep()).results[0].action, 'suspect');
  h.advance(6000);  // past the dead-runner confirmation window
  assert.equal((await watchdog.sweep()).results[0].action, 'cancelled');
  assert.equal(h.calls.turnEnds.length, 1);
  assert.equal(h.calls.turnEnds[0].cancelSource, 'process_watchdog');
  assert.equal(h.calls.turnEnds[0].turnId, 'turn-current');
  assert.equal(h.record.taskState.classifyState, 'E');
  assert.equal(h.record.taskState.activeTurnId, null);

  const continuation = await claimNext(h, 'watchdog fault-continuation admission');
  assert.equal(continuation.payload.workKind, 'continuation');
  const all = await h.outbox.list({ sessionId: SESSION });
  assert.equal(all.filter(item => String(item.payload?.message || '').includes(TAG)).length, 1,
    'one orphan turn produces one injection');
});

test('(g) a user takeover withdraws a supervisor continuation that has not started yet', async t => {
  const h = fixture(t);
  await h.arm();
  await h.activeTurn('do work');

  // The verdict injects while the turn it just observed is still the active
  // slot, so the continuation is admitted into the FIFO but stays queued.
  const decision = await h.unattended.evaluate(SESSION, { reason: 'turn_end', assistantText: 'still working' });
  assert.equal(decision.action, 'inject');
  await until(async () => {
    const all = await h.outbox.list({ sessionId: SESSION, states: 'pending' });
    return all.some(item => String(item.payload?.message || '').includes(TAG));
  }, 'queued continuation admission');
  await flush();

  const withdrawn = h.unattended.stop(SESSION);
  assert.equal(withdrawn.ok, true);
  assert.equal(withdrawn.unattended.status, 'stopped');
  assert.equal(withdrawn.unattended.pausedBy, 'user');
  await flush();

  const tagged = (await h.outbox.list({ sessionId: SESSION }))
    .filter(item => String(item.payload?.message || '').includes(TAG));
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0].state, 'cancelled',
    'the paused supervisor does not leave a round of its own waiting in the FIFO');
  const stillPending = await h.outbox.list({ sessionId: SESSION, states: 'pending' });
  assert.equal(stillPending.some(item => String(item.payload?.message || '').includes(TAG)), false,
    'nothing of the paused supervisor is left claimable');
});

test('(h) a preparation failure settles through the one entry as a host fault', async t => {
  // The turn died between its P write and the provider spawn. There is no
  // runner and no finalizer, so the turn engine cancels it with
  // `source:preparation_failed` instead of leaving a phantom P turn for the
  // watchdog. The kernel decides what that source means: a host interruption,
  // so an armed supervisor continues under its fault backoff.
  const h = fixture(t);
  await h.arm();
  await h.activeTurn('do work');
  h.record.taskState.turnId = 'turn-prev';
  h.record.taskState.activeTurnId = 'turn-current';

  const result = await h.sessionWorkHost.cancelActiveTurn(SESSION, {
    reason: 'message-compose-failed',
    killReason: 'message-compose-failed',
    source: 'preparation_failed',
  });
  assert.equal(result.ok, true);
  assert.equal(result.classifyState, 'E');
  assert.equal(h.calls.turnEnds.length, 1, 'one result through the supervisor entry');
  assert.equal(h.calls.turnEnds[0].kind, 'cancel');
  assert.equal(h.calls.turnEnds[0].cancelSource, 'preparation_failed');
  assert.equal(h.calls.turnEnds[0].turnId, 'turn-current');
  assert.equal(h.record.taskState.classifyState, 'E');
  assert.equal(h.record.taskState.activeTurnId, null, 'no dangling in-flight identity');
  assert.equal((await h.scheduler.status(SESSION)).active, null, 'the slot is released');

  const continuation = await claimNext(h, 'preparation-failure fault continuation');
  assert.equal(continuation.payload.workKind, 'continuation');
  assert.ok(continuation.payload.message.startsWith(`${SYS_PREFIX}${TAG}`));
  const all = await h.outbox.list({ sessionId: SESSION });
  assert.equal(all.filter(item => String(item.payload?.message || '').includes(TAG)).length, 1,
    'a preparation failure produces exactly one supervisor injection');
});

for (const letter of ['W', 'E']) {
  test(`${letter}：先恢复等待或异常，再按人工顺序发送 FIFO，最后普通接续`, async t => {
    const h = fixture(t);
    await h.arm();
    await h.activeTurn('正在执行');
    const auto = await h.sessionWorkHost.admit(SESSION, `${SYS_PREFIX}${TAG} 普通接续`, {
      originContinue: true, unattendedSystem: true,
    });
    const first = await h.scheduler.admit({ sessionId: SESSION, text: '第一条', idempotencyKey: 'first' });
    const second = await h.scheduler.admit({ sessionId: SESSION, text: '第二条', source: 'operation', idempotencyKey: 'second' });
    assert.equal((await h.scheduler.reorderQueued(SESSION, second.entry.id, { toIndex: 0 })).ok, true);
    if (letter === 'W') h.setPending({ requestId: 'q1', createdAt: 1002 });
    h.setClassifyState(letter);
    await h.scheduler.complete(SESSION, { classifyState: letter, awaitingRequestId: letter === 'W' ? 'q1' : null });
    assert.equal(await h.claimOne(), null, '普通接续和 FIFO 均不能越过等待/异常');
    await h.unattended.onTurnEnd(SESSION, {
      kind: letter === 'W' ? 'settle' : 'fault', settle: letter, assistantText: '需要恢复', retryScheduled: false,
    });
    const recovery = await claimNext(h, '恢复消息');
    assert.equal(recovery.payload.options.unattendedRecovery, true);
    assert.ok(recovery.payload.message.includes(TAG));
    if (letter === 'W') assert.equal(recovery.payload.workKind, 'answer');
    await h.startClaim(recovery);
    assert.equal(await h.claimOne(), null, '恢复执行中继续暂存 FIFO');
    for (const expected of [second, first, auto]) {
      h.setClassifyState('D');
      await h.scheduler.complete(SESSION, { classifyState: 'D' });
      const selected = await h.claimOne();
      assert.equal(selected.id, expected.entry.id);
      await h.startClaim(selected);
    }
    assert.deepEqual(await pendingIds(h), []);
  });

  test(`恢复无人值守时 ${letter} 有积压也会先处理等待或异常`, async t => {
    const h = fixture(t);
    await h.arm();
    await h.activeTurn('正在执行');
    const fifo = await h.scheduler.admit({ sessionId: SESSION, text: '人工补充要求', source: 'operation' });
    h.unattended.stop(SESSION);
    if (letter === 'W') h.setPending({ requestId: 'q1', createdAt: 1002 });
    h.setClassifyState(letter);
    await h.scheduler.complete(SESSION, { classifyState: letter, awaitingRequestId: letter === 'W' ? 'q1' : null });
    const resumed = await h.unattended.resume(SESSION);
    assert.equal(resumed.deferred, false, '不能因 FIFO 积压跳过恢复');
    const recovery = await claimNext(h, '恢复后的恢复指令');
    assert.equal(recovery.payload.options.unattendedRecovery, true);
    assert.notEqual(recovery.id, fifo.entry.id);
    await h.startClaim(recovery);
    h.setClassifyState('D');
    await h.scheduler.complete(SESSION, { classifyState: 'D' });
    assert.equal((await h.claimOne()).id, fifo.entry.id);
  });
}

test('(i) a delayed fault retry is selectable before a staged FIFO when its timer fires', async t => {
  const h = fixture(t);
  await h.arm();

  await h.activeTurn('do work');
  const backlog = await h.scheduler.admit({
    sessionId: SESSION, text: 'staged human work', source: 'operation', idempotencyKey: 'staged',
  });
  assert.equal(backlog.queued, true);
  h.setClassifyState('E');
  await h.scheduler.complete(SESSION, { classifyState: 'E' });

  // First fault: immediate continuation (the (b) path).
  const first = await h.unattended.onTurnEnd(SESSION, { kind: 'fault', retryScheduled: false });
  assert.equal(first.action, 'fault_continue');
  const immediate = await claimNext(h, 'immediate fault continuation');
  await h.startClaim(immediate);
  h.setClassifyState('E');
  await h.scheduler.complete(SESSION, { classifyState: 'E' });

  // Second fault: the kernel backs off and persists retryAt; nothing is
  // injected yet and the staged FIFO stays put.
  const second = await h.unattended.onTurnEnd(SESSION, { kind: 'fault', retryScheduled: false });
  assert.equal(second.action, 'fault_wait');
  assert.ok(h.record.unattended.retryAt > h.now());
  assert.equal(await h.claimOne(), null, 'nothing runs while the retry waits');

  // The durable timer fires: the recovery injection outranks the FIFO.
  h.advance(h.record.unattended.retryAt - h.now());
  assert.equal(h.fireTimers(), 1);
  await flush();
  assert.equal(h.record.unattended.retryAt, null, 'the consumed retry is cleared');
  const recovery = await claimNext(h, 'delayed fault continuation');
  assert.equal(recovery.payload.options.unattendedRecovery, true);
  assert.ok(recovery.payload.message.includes(TAG));
  assert.notEqual(recovery.id, backlog.entry.id);
  await h.startClaim(recovery);
  assert.equal(await h.claimOne(), null, 'the FIFO stays staged behind the recovery turn');
});

test('provider handoff is the single fault recovery and clears an existing retry', async t => {
  const h = fixture(t);
  await h.arm();
  await h.activeTurn('previous work');
  const ordinary = await h.scheduler.admit({ sessionId: SESSION, text: 'human backlog', source: 'operation' });
  h.setClassifyState('E');
  await h.scheduler.complete(SESSION, { classifyState: 'E' });
  h.record.unattended.retryAt = h.now() + 5000;
  h.record.unattended.retryCategory = 'capacity';
  h.unattended.rearmTimer(SESSION);
  const deferred = await h.unattended.onTurnEnd(SESSION, {
    kind: 'fault', turnId: 'provider-fault', handoffPending: true, retryScheduled: false,
  });
  assert.equal(deferred.code, 'handoff_pending');
  assert.deepEqual(await pendingIds(h), [ordinary.entry.id]);
  const handoff = await h.sessionWorkHost.admit(SESSION, '🔇switch provider and continue', {
    taskSource: 'auto_provider_handoff', originContinue: true, idempotencyKey: 'provider-fault',
  });
  assert.equal(handoff.ok, true);
  assert.equal(h.unattended.handoffAccepted(SESSION, 'provider-fault'), true);
  assert.equal(h.record.unattended.retryAt, null);
  const selected = await h.claimOne();
  assert.equal(selected.id, handoff.entry.id);
  await h.startClaim(selected);
  h.advance(5000);
  h.fireTimers();
  assert.deepEqual(await pendingIds(h), [ordinary.entry.id]);
});

test('failed provider handoff admission leaves the ordinary fault recovery available', async t => {
  const h = fixture(t);
  await h.arm();
  await h.activeTurn('previous work');
  h.setClassifyState('E');
  await h.scheduler.complete(SESSION, { classifyState: 'E' });
  const deferred = await h.unattended.onTurnEnd(SESSION, {
    kind: 'fault', turnId: 'provider-fault', handoffPending: true, retryScheduled: false,
  });
  assert.equal(deferred.code, 'handoff_pending');
  const fallback = await h.unattended.onTurnEnd(SESSION, {
    kind: 'fault', turnId: 'provider-fault', retryScheduled: false,
  });
  assert.equal(fallback.action, 'fault_continue');
  const recovery = await claimNext(h, 'fault fallback after rejected handoff');
  assert.equal(recovery.payload.options.unattendedRecovery, true);
});

test('accepted provider handoff withdraws a still-queued fault continuation', async t => {
  const h = fixture(t);
  await h.arm();
  await h.activeTurn('previous work');
  h.setClassifyState('E');
  await h.scheduler.complete(SESSION, { classifyState: 'E' });
  await h.unattended.onTurnEnd(SESSION, { kind: 'fault', turnId: 'same-fault', retryScheduled: false });
  const old = await until(async () => {
    const items = await h.outbox.list({ sessionId: SESSION, states: 'pending' });
    return items.find(item => item.payload?.options?.unattendedRecovery === true) || null;
  }, 'queued fault continuation');
  await flush();
  const handoff = await h.sessionWorkHost.admit(SESSION, '🔇switch provider', {
    taskSource: 'auto_provider_handoff', originContinue: true, idempotencyKey: 'handoff-same-fault',
  });
  assert.equal(h.unattended.handoffAccepted(SESSION, 'same-fault'), true);
  await until(async () => !(await pendingIds(h)).includes(old.id), 'withdraw duplicate recovery');
  assert.deepEqual(await pendingIds(h), [handoff.entry.id]);
});

test('a provider handoff never bypasses an outstanding user question', () => {
  const choice = nativeKernel.selectQueued({
    state: { status: 'active', deadlineAt: 10000 }, now: 1000, hasActive: false,
    classifyState: 'E', pendingRequestId: 'question-1',
    items: [
      { id: 'handoff', taskSource: 'auto_provider_handoff', workKind: 'continuation' },
      { id: 'answer', workKind: 'answer', requestId: 'question-1' },
    ],
  });
  assert.equal(choice.entryId, 'answer');
});

test('a retry after restart waits for an already persisted provider handoff', async t => {
  const h = fixture(t);
  await h.arm();
  await h.activeTurn('previous work');
  h.setClassifyState('E');
  await h.scheduler.complete(SESSION, { classifyState: 'E' });
  const handoff = await h.sessionWorkHost.admit(SESSION, '🔇switch provider', {
    taskSource: 'auto_provider_handoff', originContinue: true, idempotencyKey: 'restart-handoff',
  });
  // Crash window: the queue entry landed, but the retry marker did not clear.
  h.record.unattended.retryAt = h.now() + 10;
  h.record.unattended.retryCategory = 'fault';
  h.unattended.rearmTimer(SESSION);
  h.advance(10);
  assert.equal(h.fireTimers(), 1);
  await flush();
  assert.deepEqual(await pendingIds(h), [handoff.entry.id], 'no duplicate recovery is enqueued');
  assert.equal(h.unattended.handoffAccepted(SESSION, 'restart-fault'), true);
  assert.equal(h.record.unattended.retryAt, null);
  assert.equal((await h.claimOne()).id, handoff.entry.id);
});

test('restart cleanup withdraws only the persisted fault continuation', async t => {
  const h = fixture(t);
  await h.arm();
  await h.activeTurn('previous work');
  h.setClassifyState('E');
  await h.scheduler.complete(SESSION, { classifyState: 'E' });
  const old = await h.sessionWorkHost.admit(SESSION, `🔇${TAG} ${nativeKernel.faultInstruction()}`, {
    unattendedSystem: true, unattendedRecovery: true, originContinue: true,
  });
  const other = await h.sessionWorkHost.admit(SESSION, '🔇unrelated system result', { originContinue: true });
  const handoff = await h.sessionWorkHost.admit(SESSION, '🔇switch provider', {
    taskSource: 'auto_provider_handoff', originContinue: true,
  });
  // Entries were persisted by a previous process, so none are in the host's
  // in-memory injection tracker.
  assert.equal(h.unattended.handoffAccepted(SESSION, 'old-fault'), true);
  await until(async () => !(await pendingIds(h)).includes(old.entry.id), 'withdraw persisted fault');
  assert.deepEqual(await pendingIds(h), [other.entry.id, handoff.entry.id].sort());
});
