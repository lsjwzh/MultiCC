'use strict';

// Unattended supervisor glue (src/unattended/host.js): evidence gathering, one
// aux call per settle, persistence, pause/takeover, held-push fallbacks, trace
// lines and fault continuation. The policy itself (budget, stall, fault caps,
// prompt caps) is Rust (native/core/src/unattended.rs) and covered there; here
// `kernel` is a scripted fake so each branch of the application layer is
// exercised in isolation. Queue ordering against the REAL scheduler is covered
// in tests/test-unattended-fifo-order.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createUnattendedHost, STATUS } = require('../src/unattended/host');

const TAG = '[无人值守 Unattended]';

function nextState(extra = {}) {
  return {
    status: STATUS.ACTIVE, goal: 'ship it', criteria: [], maxDurationMinutes: 5, rounds: 1,
    startedAt: 1, deadlineAt: 1 + 5 * 60000, updatedAt: 2, lastVerdict: null, history: [],
    stall: { sameInstruction: 0, auxFailures: 0, consecutiveFaults: 0 },
    evaluating: false, pausedBy: null,
    ...extra,
  };
}

function decision(action, extra = {}) {
  const { message, nextState: stateExtra, ...rest } = extra;
  return {
    nextState: nextState(stateExtra),
    action,
    message: message === undefined ? `message:${action}` : message,
    ...rest,
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function harness({
  reply = '{"verdict":"continue","reason":"next","nextInstruction":"do X"}',
  reject = null,
  planned = decision('inject'),
  record = { id: 's1', type: null },
  history = null,
  auxAvailable = true,
  busy = false,
  hasQueued = false,
  fault = null,
  clock = 1234,
} = {}) {
  const records = new Map([[record.id, record]]);
  const calls = { persist: [], broadcast: [], notify: [], inject: [], deliver: [], taskState: [],
    enqueue: [], append: [], fallback: [] };
  const kernelCalls = { prompts: [], decisions: [], faults: [] };
  const failures = { persist: false, inject: false };
  let appendSeq = 0;
  let currentClock = clock;
  const timers = new Map();
  let timerSeq = 0;
  const kernel = {
    tag: () => TAG,
    normalizeConfig(input) {
      const goal = String(input.goal || '').trim();
      if (!goal) return { ok: false, error: 'goal_required' };
      return { ok: true, config: {
        goal,
        criteria: Array.isArray(input.criteria) ? input.criteria.map(String) : [],
        maxDurationMinutes: Math.max(5, Math.min(1440, Math.floor(Number(input.maxDurationMinutes) || 120))),
      } };
    },
    clampDuration(input) {
      return { maxDurationMinutes: Math.max(5, Math.min(1440, Math.floor(Number(input.maxDurationMinutes) || 120))) };
    },
    armDeadline(input) {
      const at = Number(input.now) || 0;
      const startedAt = input.startedAt == null ? at : Number(input.startedAt) || 0;
      const minutes = Math.max(5, Math.min(1440, Math.floor(Number(input.maxDurationMinutes) || 120)));
      let deadlineAt = startedAt + minutes * 60000;
      let clamped = false;
      if (deadlineAt <= at) { deadlineAt = at + 60000; clamped = true; }
      return { startedAt, deadlineAt, maxDurationMinutes: minutes, clamped };
    },
    deadlineExpired(input) {
      const deadlineAt = Number(input.deadlineAt) || 0;
      return { expired: deadlineAt > 0 && (Number(input.now) || 0) >= deadlineAt };
    },
    buildVerdictPrompt(evidence) {
      kernelCalls.prompts.push(evidence);
      return `PROMPT:${evidence.lastOutput}`;
    },
    parseVerdict(text) {
      try {
        const value = JSON.parse(text);
        return { ok: true, verdict: value };
      } catch (_) {
        return { ok: false, error: 'unparseable_verdict', raw: text };
      }
    },
    decide(input) {
      kernelCalls.decisions.push(input);
      if (typeof planned === 'function') return planned(input);
      return planned;
    },
    decideFault(input) {
      kernelCalls.faults.push(input);
      if (typeof fault === 'function') return fault(input);
      return fault || { nextState: nextState({ rounds: 2 }), action: 'none', message: '', faults: 1 };
    },
  };
  const host = createUnattendedHost({
    getRecord: id => records.get(id),
    persistState: (id, next) => {
      if (failures.persist) throw new Error('disk full');
      calls.persist.push(next);
      records.get(id).unattended = next;
    },
    getHistory: id => history || record.history || [
      { role: 'user', content: 'ship it' },
      { role: 'assistant', content: 'working on it' },
    ],
    setTaskState: (id, patch) => calls.taskState.push({ id, patch }),
    getPendingQuestion: () => records.get(record.id).pending || null,
    getAuxQueue: () => (auxAvailable ? {
      enqueue: async request => {
        calls.enqueue.push(request);
        if (reject) throw reject;
        if (typeof reply === 'function') return reply(request);
        return { text: reply };
      },
    } : null),
    deliver: async (id, text, options) => calls.deliver.push({ id, text, options }),
    inject: (id, text) => {
      if (failures.inject) throw new Error('injector unavailable');
      calls.inject.push({ id, text });
    },
    notify: (id, type, message, options) => calls.notify.push({ id, type, message, options }),
    broadcast: (id, payload) => calls.broadcast.push({ id, payload }),
    appendMessage: (id, message) => {
      appendSeq += 1;
      message.id = `m${appendSeq}`;
      calls.append.push({ id, message: { ...message } });
      return true;
    },
    hasQueuedDeliveries: async () => hasQueued,
    isRunActive: () => busy,
    now: () => currentClock,
    setTimeout: (fn, delay) => {
      const id = ++timerSeq;
      timers.set(id, { fn, at: currentClock + Math.max(0, Number(delay) || 0) });
      return { id, unref() {} };
    },
    clearTimeout: timer => {
      const id = timer && timer.id;
      if (id) timers.delete(id);
    },
    kernel,
  });
  async function arm(options = {}) {
    const result = await host.start('s1', { goal: 'ship it', maxDurationMinutes: 5, evaluateNow: false, ...options });
    assert.equal(result.ok, true);
    calls.persist.length = 0;
    calls.broadcast.length = 0;
    calls.append.length = 0;
    return result;
  }
  function advance(ms) { currentClock += ms; }
  function fireDueTimers(at = currentClock) {
    currentClock = at;
    let fired = 0;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= currentClock) {
        timers.delete(id);
        fired += 1;
        timer.fn();
      }
    }
    return fired;
  }
  return { host, records, calls, kernelCalls, failures, arm, record, timers, advance, fireDueTimers,
    clock: () => currentClock };
}

test('continue injects a tagged instruction, persists the new state and writes a trace', async () => {
  const f = harness({ planned: decision('inject', {
    message: `${TAG} do X`,
    nextState: { lastVerdict: { verdict: 'continue', reason: 'next', nextInstruction: 'do X', humanReason: '' } },
  }) });
  await f.arm();
  const result = await f.host.evaluate('s1', { reason: 'turn_end', assistantText: 'still working' });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'inject');
  assert.deepEqual(f.calls.inject, [{ id: 's1', text: `${TAG} do X` }]);
  assert.equal(f.calls.enqueue[0].type, 'unattended_verdict');
  assert.equal(f.calls.enqueue[0].priority, 'interactive');
  assert.deepEqual(f.calls.enqueue[0].meta, { sessionName: 's1', unattended: true });
  const decided = f.calls.persist[f.calls.persist.length - 1];
  assert.equal(decided.rounds, 1);
  assert.ok(f.calls.broadcast.some(row => row.payload.type === 'unattended_state'));
  assert.equal(f.calls.notify.length, 0);
  // Exactly one persisted UI-only trace, starting with the marker.
  const traces = f.calls.append.filter(row => row.message.kind === 'unattended_trace');
  assert.equal(traces.length, 1);
  assert.equal(traces[0].message.role, 'system');
  assert.equal(traces[0].message.content, `${TAG} 判定：继续 · next · 下一步：do X`);
  assert.ok(f.calls.broadcast.some(row => row.payload.type === 'unattended_trace'
    && row.payload.entry.content === traces[0].message.content));
  // Evidence carries the assistant output, recent history and the goal state.
  assert.equal(f.kernelCalls.prompts[0].lastOutput, 'still working');
  assert.equal(f.kernelCalls.prompts[0].goal, 'ship it');
  assert.equal(f.kernelCalls.prompts[0].rounds, 0);
});

test('an untagged aux instruction still leaves with exactly one marker', async () => {
  const f = harness({ planned: decision('inject', {
    message: `${TAG} ${TAG} run the tests`,
    nextState: { lastVerdict: { verdict: 'continue', reason: '', nextInstruction: 'run the tests', humanReason: '' } },
  }) });
  await f.arm();
  await f.host.evaluate('s1', { assistantText: 'working' });
  assert.deepEqual(f.calls.inject, [{ id: 's1', text: `${TAG} run the tests` }]);
});

test('achieved marks the task goal achieved and notifies success', async () => {
  const f = harness({ reply: '{"verdict":"achieved","reason":"tests pass"}',
    planned: decision('achieved', {
      message: '目标已达成',
      nextState: { status: STATUS.ACHIEVED, lastVerdict: { verdict: 'achieved', reason: 'tests pass', nextInstruction: '', humanReason: '' } },
    }) });
  await f.arm();
  const result = await f.host.evaluate('s1', { assistantText: 'all tests pass' });
  assert.equal(result.action, 'achieved');
  assert.equal(f.calls.taskState.length, 1);
  assert.equal(f.calls.taskState[0].patch.goalState, 'achieved');
  assert.deepEqual(f.calls.notify[0], { id: 's1', type: 'succeeded', message: '目标已达成',
    options: { classifyState: 'D', goalState: 'achieved' } });
  assert.ok(f.calls.broadcast.some(row => row.payload.type === 'notify'
    && row.payload.state === 'succeeded' && row.payload.goalState === 'achieved'));
  assert.equal(f.calls.inject.length, 0);
  assert.match(f.calls.append.find(row => row.message.kind === 'unattended_trace').message.content,
    /判定：达成 · tests pass$/);
});

test('needs_human and stalled notify a waiting user instead of injecting', async () => {
  for (const action of ['needs_human', 'stalled']) {
    const f = harness({ reply: '{"verdict":"needs_human","reason":"needs password","humanReason":"password"}',
      planned: decision(action, {
        message: `blocked:${action}`,
        nextState: { status: STATUS.NEEDS_HUMAN, lastVerdict: { verdict: 'needs_human', reason: 'needs password', nextInstruction: '', humanReason: 'password' } },
      }) });
    await f.arm();
    const result = await f.host.evaluate('s1', { assistantText: 'need credentials' });
    assert.equal(result.action, action);
    assert.equal(f.calls.inject.length, 0);
    assert.deepEqual(f.calls.notify[0], { id: 's1', type: 'waiting', message: `blocked:${action}`,
      options: { classifyState: 'W' } });
    assert.ok(f.calls.broadcast.some(row => row.payload.type === 'notify' && row.payload.state === 'waiting'));
  }
});

test('exhausted and error notify an error state', async () => {
  for (const action of ['exhausted', 'error']) {
    const f = harness({ planned: decision(action, { message: `stop:${action}` }) });
    await f.arm();
    const result = await f.host.evaluate('s1', { assistantText: 'still not done' });
    assert.equal(result.action, action);
    assert.equal(f.calls.inject.length, 0);
    assert.deepEqual(f.calls.notify[0], { id: 's1', type: 'error', message: `stop:${action}`,
      options: { classifyState: 'E' } });
    assert.ok(f.calls.broadcast.some(row => row.payload.type === 'notify' && row.payload.state === 'error'));
  }
});

test('an aux rejection reaches decide as a parse error and still persists', async () => {
  const f = harness({ reject: new Error('aux permission denied') });
  await f.arm();
  const result = await f.host.evaluate('s1', { assistantText: 'working' });
  assert.equal(result.ok, true);
  assert.equal(f.calls.enqueue.length, 1);
  assert.equal(f.kernelCalls.decisions.length, 1);
  assert.equal(f.kernelCalls.decisions[0].verdict, undefined);
  assert.match(f.kernelCalls.decisions[0].parseError, /aux_failed: aux permission denied/);
  assert.ok(f.calls.persist.some(state => state.rounds === 1));
});

test('a cancelled aux request changes nothing and clears the evaluating flag', async () => {
  const cancelled = new Error('cancelled');
  cancelled.cancelled = true;
  const f = harness({ reject: cancelled });
  await f.arm();
  const result = await f.host.evaluate('s1', { assistantText: 'working' });
  assert.deepEqual(result, { ok: false, code: 'cancelled' });
  assert.equal(f.kernelCalls.decisions.length, 0);
  assert.equal(f.host.get('s1').evaluating, false);
});

test('a pending question is answered immediately through the delivery path, tagged and system-flagged', async () => {
  const f = harness({ planned: decision('inject', {
    message: `${TAG} choose B`, answer: 'B', pendingQuestionId: 'usrq-1',
  }) });
  f.records.get('s1').pending = { requestId: 'usrq-1', question: 'Pick one', options: ['A', 'B'] };
  await f.arm();
  const result = await f.host.evaluate('s1', { assistantText: 'choose a lane' });
  assert.equal(result.action, 'inject');
  assert.equal(f.calls.inject.length, 0);
  assert.deepEqual(f.calls.deliver, [{ id: 's1', text: `${TAG} B`,
    options: { userInputRequestId: 'usrq-1', unattendedSystem: true, system: true } }]);
  assert.deepEqual(f.kernelCalls.prompts[0].pendingQuestion,
    { requestId: 'usrq-1', question: 'Pick one', options: ['A', 'B'] });
});

test('evaluating is true while the aux call is in flight and false afterwards', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = harness({ reply: () => gate });
  await f.arm();
  const pending = f.host.evaluate('s1', { assistantText: 'working' });
  await tick();
  assert.equal(f.host.get('s1').evaluating, true, 'verdict start sets evaluating');
  assert.ok(f.calls.broadcast.some(row => row.payload.type === 'unattended_state'
    && row.payload.unattended.evaluating === true));
  release({ text: '{"verdict":"continue","reason":"r","nextInstruction":"go"}' });
  await pending;
  assert.equal(f.host.get('s1').evaluating, false);
  assert.ok(f.calls.broadcast.some(row => row.payload.type === 'unattended_state'
    && row.payload.unattended.evaluating === false));
});

test('real user input pauses the supervisor, cancel and stop record their own cause', async () => {
  const f = harness();
  await f.arm();
  const paused = f.host.noteUserMessage('s1');
  assert.equal(paused.status, STATUS.STOPPED);
  assert.equal(paused.pausedBy, 'input');
  assert.match(f.calls.append.find(row => row.message.kind === 'unattended_trace').message.content,
    /已暂停（用户输入）$/);

  const resumed = await f.host.resume('s1');
  assert.equal(resumed.ok, true);
  assert.equal(f.host.get('s1').pausedBy, null);
  await tick();

  const stopped = f.host.stop('s1');
  assert.equal(stopped.ok, true);
  assert.equal(f.host.get('s1').pausedBy, 'user');

  await f.host.resume('s1');
  await tick();
  const cancelled = f.host.onManualCancel('s1');
  assert.equal(cancelled.status, STATUS.STOPPED);
  assert.equal(cancelled.pausedBy, 'cancel');
  const enqueuesBefore = f.calls.enqueue.length;
  const after = await f.host.evaluate('s1', { assistantText: 'ignored' });
  assert.deepEqual(after, { ok: false, code: 'not_active' });
  assert.equal(f.calls.enqueue.length, enqueuesBefore);
});

test('resume clears pausedBy and evaluates when idle, defers when a turn is live or queued', async () => {
  const idle = harness();
  await idle.arm();
  idle.host.stop('s1');
  idle.calls.enqueue.length = 0;
  const resumed = await idle.host.resume('s1');
  assert.equal(resumed.ok, true);
  assert.equal(resumed.deferred, false);
  await tick();
  assert.equal(idle.calls.enqueue.length, 1, 'idle resume asks the aux for a fresh verdict');

  const busy = harness({ busy: true });
  const busyStart = await busy.host.start('s1', { goal: 'ship it' });
  assert.equal(busyStart.deferred, true);
  assert.equal(busy.calls.enqueue.length, 0, 'a streaming turn will settle itself');

  const queued = harness({ hasQueued: true });
  await queued.arm();
  queued.host.stop('s1');
  queued.calls.enqueue.length = 0;
  const queuedResume = await queued.host.resume('s1');
  assert.equal(queuedResume.deferred, true);
  assert.equal(queued.calls.enqueue.length, 0);
});

test('a D settle with staged FIFO defers and releases the held push; W still evaluates', async () => {
  const f = harness({ hasQueued: true });
  await f.arm();
  const pushes = [];
  const result = await f.host.onTurnSettled('s1', {
    assistantText: 'done',
    settle: 'D',
    fallbackPush: () => pushes.push('fallback'),
  });
  assert.deepEqual(result, { ok: false, code: 'backlog_pending' });
  assert.equal(f.calls.enqueue.length, 0, 'no verdict burns a round on stale output');
  assert.deepEqual(pushes, ['fallback'], 'the held classic push is released');
  assert.equal(f.host.get('s1').rounds, 0);

  // W is the pending-question settle: the aux has to answer it even with a
  // backlog staged (that backlog is gated behind the answer by the scheduler).
  const w = harness({ hasQueued: true });
  await w.arm();
  await w.host.onTurnSettled('s1', { assistantText: 'which?', settle: 'W' });
  await tick();
  assert.equal(w.calls.enqueue.length, 1);
});

test('shouldHoldPush only holds when the supervisor will really evaluate', async () => {
  const f = harness();
  assert.equal(f.host.shouldHoldPush('s1'), false, 'never armed');
  await f.arm();
  assert.equal(f.host.shouldHoldPush('s1', { assistantText: 'output' }), true);
  assert.equal(f.host.shouldHoldPush('s1', { assistantText: '   ' }), true,
    'history already has assistant output');
  f.host.stop('s1');
  assert.equal(f.host.shouldHoldPush('s1', { assistantText: 'output' }), false);
});

test('every no-op path releases the held classic push (a settle is never silent)', async () => {
  // no_output: empty transcript and no assistant text.
  const empty = harness({ history: [] });
  await empty.arm();
  const noOutput = await empty.host.onTurnSettled('s1', { assistantText: '', fallbackPush: () => empty.calls.fallback.push('push') });
  assert.deepEqual(noOutput, { ok: false, code: 'no_output' });
  assert.deepEqual(empty.calls.fallback, ['push']);

  // aux unavailable.
  const noAux = harness({ auxAvailable: false });
  await noAux.arm();
  await noAux.host.onTurnSettled('s1', { assistantText: 'working', fallbackPush: () => noAux.calls.fallback.push('push') });
  assert.deepEqual(noAux.calls.fallback, ['push']);

  // action none (aux failure below its limit): the supervisor stays silent.
  const none = harness({ planned: decision('none', { message: '' }) });
  await none.arm();
  await none.host.onTurnSettled('s1', { assistantText: 'working', fallbackPush: () => none.calls.fallback.push('push') });
  assert.deepEqual(none.calls.fallback, ['push']);

  // persist failure: the decided state cannot be stored, so the classic push wins.
  const persistFail = harness();
  await persistFail.arm();
  persistFail.failures.persist = true;
  await persistFail.host.onTurnSettled('s1', { assistantText: 'working', fallbackPush: () => persistFail.calls.fallback.push('push') });
  assert.deepEqual(persistFail.calls.fallback, ['push']);

  // the injector throwing is an apply failure → fallback again.
  const applyFail = harness();
  await applyFail.arm();
  applyFail.failures.inject = true;
  await applyFail.host.onTurnSettled('s1', { assistantText: 'working', fallbackPush: () => applyFail.calls.fallback.push('push') });
  assert.deepEqual(applyFail.calls.fallback, ['push']);

  // an outcome with its own notice suppresses the classic push.
  const inject = harness({ planned: decision('inject') });
  await inject.arm();
  await inject.host.onTurnSettled('s1', { assistantText: 'working', fallbackPush: () => inject.calls.fallback.push('push') });
  assert.deepEqual(inject.calls.fallback, []);
});

test('fault continuation injects the fixed resume instruction without an aux call', async () => {
  const f = harness({ fault: {
    nextState: nextState({ rounds: 2, stall: { sameInstruction: 0, auxFailures: 0, consecutiveFaults: 1 } }),
    action: 'fault_continue',
    message: `${TAG} resume and verify`,
    faults: 1,
  } });
  await f.arm();
  const decisionOut = f.host.onFault('s1', { reason: 'rate_limit' });
  assert.equal(decisionOut.action, 'fault_continue');
  assert.equal(f.kernelCalls.faults.length, 1);
  assert.equal(f.calls.enqueue.length, 0, 'no aux verdict for a fault');
  assert.deepEqual(f.calls.inject, [{ id: 's1', text: `${TAG} resume and verify` }]);
  assert.equal(f.host.get('s1').rounds, 2);
  assert.match(f.calls.append.find(row => row.message.kind === 'unattended_trace').message.content,
    /故障后自动继续（第 1 次）$/);
});

test('a fault that hits the limit notifies a human instead of injecting', async () => {
  const f = harness({ fault: {
    nextState: nextState({ status: STATUS.NEEDS_HUMAN }),
    action: 'needs_human',
    message: 'repeated faults',
    faults: 3,
  } });
  await f.arm();
  const out = f.host.onFault('s1', { reason: 'api_error' });
  assert.equal(out.action, 'needs_human');
  await new Promise(done => setImmediate(done));
  assert.equal(f.calls.inject.length, 0);
  assert.deepEqual(f.calls.notify[0], { id: 's1', type: 'waiting', message: 'repeated faults',
    options: { classifyState: 'W' } });
});

test('a clean D/W settle resets the consecutive fault counter', async () => {
  const f = harness();
  await f.arm();
  f.records.get('s1').unattended = {
    ...f.records.get('s1').unattended,
    status: STATUS.ACTIVE,
    stall: { sameInstruction: 0, auxFailures: 0, consecutiveFaults: 2 },
  };
  await f.host.onTurnSettled('s1', { assistantText: 'recovered' });
  assert.ok(f.calls.persist.some(state => state.stall && state.stall.consecutiveFaults === 0),
    'the settle proves the upstream recovered');
});

test('first-message arming is idempotent for the same config', async () => {
  const f = harness();
  const first = f.host.armFromRequest('s1', { maxDurationMinutes: 90 }, { defaultGoal: 'ship it' });
  assert.equal(first.ok, true);
  assert.equal(first.unattended.goal, 'ship it');
  assert.equal(first.unattended.maxDurationMinutes, 90);
  assert.equal(first.unattended.evaluating, false);
  assert.equal(first.unattended.pausedBy, null);
  assert.ok(first.unattended.startedAt === 1234);
  assert.equal(first.unattended.deadlineAt, 1234 + 90 * 60000);
  const again = f.host.armFromRequest('s1', { maxDurationMinutes: 90 }, { defaultGoal: 'ship it' });
  assert.equal(again.unchanged, true);
  assert.equal(again.unattended, first.unattended, 'a receipt retry must not reset rounds');
  assert.deepEqual(f.host.armFromRequest('s1', {}, { defaultGoal: '   ' }),
    { ok: false, code: 'goal_required' });
  assert.deepEqual(f.host.armFromRequest('missing', { maxDurationMinutes: 30 }),
    { ok: false, code: 'session_not_found' });
});

test('legacy maxRounds in a request is accepted but never persisted', async () => {
  const f = harness();
  const armed = f.host.armFromRequest('s1', { goal: 'ship it', maxRounds: 7 }, { defaultGoal: 'ship it' });
  assert.equal(armed.ok, true);
  assert.equal('maxRounds' in armed.unattended, false);
  assert.equal(armed.unattended.maxDurationMinutes, 120);
  assert.equal('maxRounds' in f.records.get('s1').unattended, false);

  const started = await f.host.start('s1', { goal: 'ship it', maxRounds: 3, maxDurationMinutes: 60,
    evaluateNow: false });
  assert.equal(started.ok, true);
  assert.equal('maxRounds' in started.unattended, false);
  assert.equal(started.unattended.maxDurationMinutes, 60);
  assert.equal(f.host.stats().timers, 1, 'one expiry timer for the active session');
});

test('the expiry timer fires without any turn settle', async () => {
  const f = harness();
  await f.arm({ maxDurationMinutes: 5 });
  const deadlineAt = f.host.get('s1').deadlineAt;
  assert.equal(deadlineAt, 1234 + 5 * 60000);
  assert.equal(f.host.stats().timers, 1);

  assert.equal(f.fireDueTimers(deadlineAt), 1);
  await tick();
  const state = f.host.get('s1');
  assert.equal(state.status, STATUS.EXHAUSTED);
  assert.equal(state.pausedBy, null);
  assert.match(state.lastVerdict.humanReason, /^\[无人值守 Unattended\] 已达到最长值守时间$/);
  const trace = f.calls.append.find(row => row.message.kind === 'unattended_trace');
  assert.equal(trace.message.content, `${TAG} 已达到最长值守时间`);
  assert.ok(f.calls.broadcast.some(row => row.payload.type === 'unattended_state'
    && row.payload.unattended.status === STATUS.EXHAUSTED));
  assert.deepEqual(f.calls.notify[0], { id: 's1', type: 'error', message: `${TAG} 已达到最长值守时间`,
    options: { classifyState: 'E' } });
  assert.equal(f.calls.enqueue.length, 0, 'expiry needs no verdict');
  assert.equal(f.host.stats().timers, 0, 'the timer disarms after firing');
});

test('expiry releases the held classic push and blocks a late injection', async () => {
  const f = harness({ planned: decision('inject') });
  await f.arm({ maxDurationMinutes: 5 });
  f.advance(5 * 60000);
  const pushes = [];
  const result = await f.host.evaluate('s1', {
    assistantText: 'working', fallbackPush: () => pushes.push('classic'),
  });
  assert.deepEqual(result, { ok: false, code: 'expired' });
  assert.deepEqual(pushes, ['classic'], 'the user is still told the session needs them');
  assert.equal(f.calls.enqueue.length, 0, 'a late timer never allows another injection');
  assert.equal(f.host.get('s1').status, STATUS.EXHAUSTED);
  assert.equal(f.calls.inject.length, 0);
});

test('the timer is cleared on stop/pause and re-armed on resume', async () => {
  const f = harness();
  await f.arm({ maxDurationMinutes: 30 });
  assert.equal(f.host.stats().timers, 1);
  f.host.stop('s1');
  assert.equal(f.host.stats().timers, 0, 'stop clears the timer');

  await f.host.resume('s1');
  await tick();
  assert.equal(f.host.stats().timers, 1, 'resume re-arms the clock');
  assert.equal(f.host.get('s1').status, STATUS.ACTIVE);

  f.host.noteUserMessage('s1');
  assert.equal(f.host.stats().timers, 0, 'a human takeover pauses and disarms');
  f.host.shutdown();
  assert.equal(f.host.stats().timers, 0);
});

test('resume re-arms the clock from now and accepts a new duration', async () => {
  const f = harness();
  await f.arm({ maxDurationMinutes: 30 });
  f.advance(1000);
  f.host.stop('s1');
  const resumed = await f.host.resume('s1', { maxDurationMinutes: 10 });
  assert.equal(resumed.ok, true);
  const state = resumed.unattended;
  assert.equal(state.maxDurationMinutes, 10);
  assert.equal(state.startedAt, 2234, 'resume starts a new clock');
  assert.equal(state.deadlineAt, 2234 + 10 * 60000);
});

test('update recomputes the deadline from the original startedAt and clamps a past one', async () => {
  const f = harness();
  await f.arm({ maxDurationMinutes: 30 });
  const startedAt = f.host.get('s1').startedAt;
  f.advance(2000);
  const updated = f.host.update('s1', { maxDurationMinutes: 60 });
  assert.equal(updated.ok, true);
  assert.equal(updated.unattended.startedAt, startedAt, 'the original start is preserved');
  assert.equal(updated.unattended.deadlineAt, startedAt + 60 * 60000);
  assert.equal(f.host.stats().timers, 1, 'the timer follows the new deadline');

  // Shrink the duration until the recomputed deadline is already past.
  f.advance(startedAt + 60 * 60000 - f.clock());
  const clamped = f.host.update('s1', { maxDurationMinutes: 5 });
  assert.equal(clamped.ok, true);
  assert.equal(clamped.unattended.deadlineAt, f.clock() + 60000);
  assert.match(f.calls.append.find(row => row.message.kind === 'unattended_trace').message.content,
    /截止时间顺延到 1 分钟后$/);
});

test('thirty-one-plus rounds keep inject instead of exhausting', async () => {
  const f = harness({
    planned: input => ({
      nextState: {
        ...input.state,
        rounds: (Number(input.state.rounds) || 0) + 1,
        lastVerdict: { verdict: 'continue', reason: 'more', nextInstruction: 'keep going', humanReason: '' },
      },
      action: 'inject',
      message: `${TAG} keep going`,
    }),
  });
  await f.arm({ maxDurationMinutes: 1440 });
  for (let index = 0; index < 31; index += 1) {
    const result = await f.host.evaluate('s1', { assistantText: `output ${index}` });
    assert.equal(result.action, 'inject', `round ${index + 1} still injects`);
  }
  assert.equal(f.host.get('s1').rounds, 31);
  assert.equal(f.host.get('s1').status, STATUS.ACTIVE);
  assert.equal(f.calls.notify.length, 0);
});

test('one in-flight evaluation coalesces a second settle', async () => {
  const f = harness();
  await f.arm();
  f.calls.enqueue.length = 0;
  const host = f.host;
  const first = host.evaluate('s1', { assistantText: 'first' });
  const second = host.evaluate('s1', { assistantText: 'second' });
  const secondResult = await second;
  assert.deepEqual(secondResult, { ok: true, deferred: true });
  assert.equal(host.stats().inFlight, 1);
  assert.equal(host.stats().queued, 1);
  await first;
  await new Promise(done => setImmediate(done));
  assert.equal(host.stats().queued, 0);
  // The coalesced follow-up ran after the first finished.
  assert.ok(f.calls.enqueue.length >= 2);
});

test('boot migrates legacy records, clears a stale evaluating:true and re-arms active timers', () => {
  const { createUnattendedRuntime } = require('../src/unattended/runtime');
  const records = new Map([
    ['s1', { id: 's1', type: null, unattended: {
      status: 'active', evaluating: true, maxRounds: 5, rounds: 4,
    } }],
    ['s2', { id: 's2', type: null, unattended: {
      status: 'stopped', evaluating: false, maxRounds: 9, updatedAt: 777,
    } }],
  ]);
  const saves = [];
  const host = createUnattendedRuntime({
    persistedSessions: records,
    saveSessions: source => saves.push(source),
    loadHistory: () => [],
    setTaskState: () => {},
    userInputSignalHost: { pending: () => null },
    getAuxQueue: () => null,
    taskContextHost: { deliverSessionMessage: async () => ({ ok: true }) },
    waitInjector: { injectSystemMsg: () => {} },
    triggerPush: () => {},
    chatBroadcast: () => {},
    logger: { log: () => {} },
  });
  const active = records.get('s1').unattended;
  assert.equal(active.evaluating, false);
  assert.equal('maxRounds' in active, false, 'the legacy round budget is dropped');
  assert.equal(active.maxDurationMinutes, 120);
  assert.equal(active.rounds, 4, 'rounds survive as an informational counter');
  assert.equal(active.deadlineAt, active.startedAt + 120 * 60000);
  assert.equal(host.stats().timers, 1, 'an active record is re-armed at boot');

  const stopped = records.get('s2').unattended;
  assert.equal('maxRounds' in stopped, false);
  assert.equal(stopped.maxDurationMinutes, 120);
  assert.equal(stopped.startedAt, 777, 'null-safe startedAt falls back to updatedAt');
  assert.equal(stopped.deadlineAt, 777 + 120 * 60000);
  assert.deepEqual(saves, ['unattended.boot']);

  host.shutdown();
  assert.equal(host.stats().timers, 0);
});
