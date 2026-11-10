'use strict';

// Unattended v2 orders its own messages against the session-work FIFO by
// DELIVERING them, not by reading the queue: the real scheduler already gates
// the FIFO behind a pending question (answer first) and behind an E fault
// (continuation first, FIFO staged until D), and drains it on its own after D.
//
// These tests compose the REAL scheduler + outbox + session-work host behind
// the real unattended host, the real session-delivery boundary and the real
// wait injector — only the Rust kernel is scripted, exactly like
// tests/test-unattended-supervisor.js. They pin:
//   (a) W + pending question + 2 staged deliveries: the auto-answer is selected
//       first and the backlog only afterwards (after the answer's D);
//   (b) E + staged backlog: the supervisor's fault-continue (its real
//       onFault → injectSystemMsg → deliverContinuation → admission path) is
//       selectable first, and the backlog stays staged until a D;
//   (c) D + staged backlog: the supervisor DEFERS (no aux call, no round, held
//       push released) and the backlog's own D settle is what evaluates.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createOrchestrationStore } = require('../src/orchestration/store');
const { createOutbox } = require('../src/outbox');
const { createSessionWorkScheduler } = require('../src/session-work/scheduler');
const { createSessionWorkHost } = require('../src/session-work/host');
const { createUnattendedHost } = require('../src/unattended/host');
const { createSessionDelivery } = require('../src/session/delivery');
const waitInjector = require('../src/wait/injector');

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

  const record = { id: SESSION, type: null, taskState: { classifyState: 'D' } };
  let pending = null;
  const scheduler = createSessionWorkScheduler({
    store,
    now: () => clock,
    getClassifyState: () => record.taskState.classifyState,
    getPendingUserInput: () => pending,
  });

  const sessionWorkHost = createSessionWorkHost({
    runtime: () => ({
      sessionScheduler: scheduler,
      hasPending: () => false,
      tick: async () => {},
      admitSessionWork: spec => scheduler.admit(spec),
    }),
    getRecord: () => record,
    getChatSession: () => ({}),
    getTaskState: value => value?.taskState || record.taskState,
    pendingUserInput: () => pending,
    getTurnLiveness: () => ({ state: 'inactive' }),
    recordUserInput: () => ({ ok: true }),
    resolveUserInput: () => ({ ok: true }),
    broadcast: () => {},
    setTaskState: (id, patch) => { Object.assign(record.taskState, patch || {}); },
    onTaskBoardQueueEvent() {},
    onWorkspaceQueueStatus() {},
    classifyDisplay: () => ({ cardStatus: 'running' }),
    dispatchStateAction() {},
    reconcileTaskProjection() {},
    cancelClassify() {},
    cancelSessionClassifyJobs() {},
    assignKillReason() {},
    finishProviderAttempt() {},
    stopBackgroundForInsert() {},
    appendMessage() { return true; },
    chatStream: { isAlive: () => false, cancel() {} },
    cancelPreparation() {},
    log: { warn() {}, log() {}, info() {} },
  });

  const calls = { decide: 0, decideFault: 0, enqueue: 0 };
  let plan = null;
  let faultPlan = null;
  const kernel = {
    tag: () => TAG,
    normalizeConfig: input => ({
      ok: true,
      config: {
        goal: String(input.goal || ''),
        criteria: Array.isArray(input.criteria) ? input.criteria.map(String) : [],
        maxDurationMinutes: Number(input.maxDurationMinutes) || 120,
      },
    }),
    clampDuration: input => ({ maxDurationMinutes: Math.max(5, Math.min(1440,
      Math.floor(Number(input.maxDurationMinutes) || 120))) }),
    armDeadline: input => {
      const at = Number(input.now) || 0;
      const startedAt = input.startedAt == null ? at : Number(input.startedAt) || 0;
      const minutes = Math.max(5, Math.min(1440, Math.floor(Number(input.maxDurationMinutes) || 120)));
      let deadlineAt = startedAt + minutes * 60000;
      let clamped = false;
      if (deadlineAt <= at) { deadlineAt = at + 60000; clamped = true; }
      return { startedAt, deadlineAt, maxDurationMinutes: minutes, clamped };
    },
    deadlineExpired: input => ({ expired: (Number(input.deadlineAt) || 0) > 0
      && (Number(input.now) || 0) >= (Number(input.deadlineAt) || 0) }),
    buildVerdictPrompt: () => 'PROMPT',
    parseVerdict: () => ({ ok: true }),
    decide() {
      calls.decide += 1;
      return typeof plan === 'function' ? plan() : plan;
    },
    decideFault() {
      calls.decideFault += 1;
      return typeof faultPlan === 'function' ? faultPlan() : faultPlan;
    },
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
        return { text: '{"verdict":"continue","reason":"r","nextInstruction":"go"}' };
      },
    }),
    // Exactly what src/task-context-host.js deliverSessionMessage reaches at
    // the admission boundary; `system`/`unattendedSystem` ride along untouched.
    deliver: (id, text, options) => sessionWorkHost.admit(id, text, options),
    // Exactly how server.js wires the supervisor's `inject` port.
    inject: (id, text) => waitInjector.injectSystemMsg(id, text, 0),
    broadcast: () => {},
    notify: () => {},
    appendMessage: () => true,
    hasQueuedDeliveries: id => sessionWorkHost.hasQueuedDeliveries(id),
    isRunActive: () => false,
    now: () => clock,
    kernel,
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
    record,
    calls,
    unattended,
    claimOne,
    startClaim,
    activeTurn,
    setPending(value) { pending = value; },
    setClassifyState(value) { record.taskState.classifyState = value; },
    plan(value) { plan = value; },
    planFault(value) { faultPlan = value; },
    advance(ms = 1) { clock += ms; },
    arm: () => unattended.start(SESSION, { goal: 'ship it', maxDurationMinutes: 90, evaluateNow: false }),
  };
}

function injectDecision(host, extra = {}) {
  const current = host.unattended.get(SESSION);
  return {
    nextState: {
      ...current,
      rounds: (current.rounds || 0) + 1,
      updatedAt: current.updatedAt + 1,
      lastVerdict: { verdict: 'continue', reason: 'more work', nextInstruction: 'do the next thing', humanReason: '' },
    },
    action: 'inject',
    message: `${TAG} do the next thing`,
    ...extra,
  };
}

function faultDecision(host, extra = {}) {
  const current = host.unattended.get(SESSION);
  return {
    nextState: {
      ...current,
      rounds: (current.rounds || 0) + 1,
      updatedAt: current.updatedAt + 1,
      stall: { ...(current.stall || {}), consecutiveFaults: 1 },
      lastVerdict: { verdict: 'continue', reason: 'fault_continue', nextInstruction: '', humanReason: '' },
    },
    action: 'fault_continue',
    message: `${TAG} The previous turn was interrupted. Resume from where it stopped.`,
    faults: 1,
    ...extra,
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
  const typed = await h.scheduler.admit({ sessionId: SESSION, text: 'typed queued work', idempotencyKey: 'typed' });
  const system = await h.scheduler.admit({
    sessionId: SESSION,
    text: 'system queued work',
    source: 'background',
    idempotencyKey: 'system',
  });
  assert.equal(typed.queued, true);
  assert.equal(system.queued, true);

  h.setPending({ requestId: 'q1', resolved: false, createdAt: 1_002 });
  h.setClassifyState('W');
  await h.scheduler.complete(SESSION, { classifyState: 'W', awaitingRequestId: 'q1' });
  assert.equal(await h.claimOne(), null, 'staged work holds behind the open question');

  h.plan(() => injectDecision(h, { answer: 'option B', pendingQuestionId: 'q1' }));
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

  // The REAL supervisor path: onFault → inject(tagged) → injectSystemMsg →
  // deliverContinuation → session-work admission.
  h.planFault(() => faultDecision(h));
  const decision = h.unattended.onFault(SESSION, { reason: 'api_error' });
  assert.equal(decision.action, 'fault_continue');
  assert.equal(h.calls.decideFault, 1);

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

  h.plan(() => injectDecision(h));
  const pushes = [];
  const deferred = await h.unattended.onTurnSettled(SESSION, {
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
  await h.unattended.onTurnSettled(SESSION, {
    assistantText: 'B finished',
    settle: 'D',
    fallbackPush: () => pushes.push('classic-after-backlog'),
  });
  await flush();
  assert.equal(h.calls.decide, 1, 'the last backlog settle makes the verdict');
  assert.equal(h.calls.enqueue, 1);
  assert.deepEqual(pushes, ['classic'], 'the follow-up settle produced its own outcome');
});
