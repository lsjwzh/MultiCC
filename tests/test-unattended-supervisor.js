'use strict';

// Unattended supervisor glue (src/unattended/host.js): evidence gathering, one
// aux call per settle, persistence, pause/takeover, held-push fallbacks, trace
// lines, fault continuation, per-turn dedupe and boot reconciliation.
//
// The policy itself is Rust (native/core/src/unattended.rs) and these tests run
// the REAL native kernel through src/unattended/kernel.js. Only external ports
// (aux queue, delivery, injector, clock, persistence) are faked. Queue ordering
// against the REAL scheduler is covered in tests/test-unattended-fifo-order.js;
// the classify-side double-observer race is in test-classify-api-error-state.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const nativeKernel = require('../src/unattended/kernel');
const { createUnattendedHost, STATUS } = require('../src/unattended/host');

const TAG = '[无人值守 Unattended]';
const CONTINUE = '{"verdict":"continue","reason":"next","nextInstruction":"do X"}';

// The real kernel with call recording. Nothing here re-implements a rule: the
// wrappers only observe the facts the host sends and the bytes Rust returns.
function recordingKernel() {
  const calls = { prompts: [], decisions: [], turnEnds: [] };
  const kernel = {
    tag: () => nativeKernel.tag(),
    deferEvaluation: input => nativeKernel.deferEvaluation(input),
    normalizeConfig: input => nativeKernel.normalizeConfig(input),
    clampDuration: input => nativeKernel.clampDuration(input),
    armDeadline: input => nativeKernel.armDeadline(input),
    deadlineExpired: input => nativeKernel.deadlineExpired(input),
    buildVerdictPrompt: evidence => {
      calls.prompts.push(evidence);
      return nativeKernel.buildVerdictPrompt(evidence);
    },
    parseVerdict: text => nativeKernel.parseVerdict(text),
    decide: input => {
      calls.decisions.push(input);
      return nativeKernel.decide(input);
    },
    decideTurnEnd: input => {
      calls.turnEnds.push(input);
      return nativeKernel.decideTurnEnd(input);
    },
    faultInstruction: () => nativeKernel.faultInstruction(),
  };
  return { kernel, calls };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function harness({
  reply = CONTINUE,
  reject = null,
  record = { id: 's1', type: null },
  peers = [],
  history = null,
  auxAvailable = true,
  busy = false,
  hasQueued = false,
  taskState = null,
  schedulerStatus = null,
  clock = 1234,
  injectResult = null,
  withdrawQueued = null,
  getRetryNotBefore = () => null,
} = {}) {
  const records = new Map([[record.id, record]]);
  for (const peer of peers) records.set(peer.id, { type: null, ...peer });
  const calls = { persist: [], broadcast: [], notify: [], inject: [], injectOptions: [], deliver: [],
    taskState: [], enqueue: [], append: [], fallback: [], withdraw: [] };
  const logs = [];
  const { kernel, calls: kernelCalls } = recordingKernel();
  const failures = { persist: false, inject: false, persistFor: new Set() };
  let appendSeq = 0;
  let currentClock = clock;
  const timers = new Map();
  let timerSeq = 0;
  const host = createUnattendedHost({
    getRecord: id => records.get(id),
    persistState: (id, next) => {
      if (failures.persist || failures.persistFor.has(id)) throw new Error('disk full');
      calls.persist.push({ id, state: next });
      records.get(id).unattended = next;
    },
    getHistory: id => history || records.get(id)?.history || [
      { role: 'user', content: 'ship it' },
      { role: 'assistant', content: 'working on it' },
    ],
    setTaskState: (id, patch) => calls.taskState.push({ id, patch }),
    getPendingQuestion: id => records.get(id).pending || null,
    getAuxQueue: () => (auxAvailable ? {
      enqueue: async request => {
        calls.enqueue.push(request);
        if (reject) throw reject;
        if (typeof reply === 'function') {
          const out = await reply(request);
          return typeof out === 'string' ? { text: out } : out;
        }
        return { text: reply };
      },
    } : null),
    deliver: async (id, text, options) => calls.deliver.push({ id, text, options }),
    inject: (id, text, options) => {
      if (failures.inject) throw new Error('injector unavailable');
      calls.inject.push({ id, text });
      calls.injectOptions.push({ id, text, options });
      return injectResult;
    },
    withdrawQueued: typeof withdrawQueued === 'function'
      ? (id, entryId) => {
        calls.withdraw.push({ id, entryId });
        return withdrawQueued(id, entryId);
      }
      : null,
    notify: (id, type, message, options) => calls.notify.push({ id, type, message, options }),
    broadcast: (id, payload) => calls.broadcast.push({ id, payload }),
    appendMessage: (id, message) => {
      appendSeq += 1;
      message.id = `m${appendSeq}`;
      calls.append.push({ id, message: { ...message } });
      return true;
    },
    hasQueuedDeliveries: async () => typeof hasQueued === 'function' ? hasQueued() : hasQueued,
    isRunActive: () => (typeof busy === 'function' ? busy() : busy),
    getTaskState: id => (typeof taskState === 'function'
      ? taskState(id)
      : (taskState || records.get(id)?.taskState || {})),
    getSchedulerStatus: async id => (typeof schedulerStatus === 'function' ? schedulerStatus(id) : schedulerStatus),
    getRetryNotBefore: id => (typeof getRetryNotBefore === 'function' ? getRetryNotBefore(id) : getRetryNotBefore),
    listSessionIds: () => [...records.keys()],
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
    log: line => logs.push(line),
    kernel,
  });
  async function arm(options = {}) {
    const result = await host.start(record.id, {
      goal: 'ship it', maxDurationMinutes: 5, evaluateNow: false, ...options,
    });
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
  return { host, records, calls, kernelCalls, failures, logs, arm, record, timers, advance, fireDueTimers,
    clock: () => currentClock };
}

function lastTrace(f) {
  return f.calls.append.filter(row => row.message.kind === 'unattended_trace').at(-1);
}

test('continue injects a tagged instruction, persists the new state and writes a trace', async () => {
  const f = harness();
  await f.arm();
  const result = await f.host.evaluate('s1', { reason: 'turn_end', assistantText: 'still working' });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'inject');
  assert.deepEqual(f.calls.inject, [{ id: 's1', text: `${TAG} do X` }]);
  assert.equal(f.calls.enqueue[0].type, 'unattended_verdict');
  assert.equal(f.calls.enqueue[0].priority, 'interactive');
  assert.deepEqual(f.calls.enqueue[0].meta, { sessionName: 's1', unattended: true });
  const decided = f.host.get('s1');
  assert.equal(decided.rounds, 1);
  assert.equal(decided.lastVerdict.verdict, 'continue');
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
  const f = harness({ reply: '{"verdict":"continue","reason":"","nextInstruction":"run the tests"}' });
  await f.arm();
  await f.host.evaluate('s1', { assistantText: 'working' });
  assert.deepEqual(f.calls.inject, [{ id: 's1', text: `${TAG} run the tests` }]);
});

test('achieved marks the task goal achieved and notifies success', async () => {
  const f = harness({ reply: '{"verdict":"achieved","reason":"tests pass"}' });
  await f.arm();
  const result = await f.host.evaluate('s1', { assistantText: 'all tests pass' });
  assert.equal(result.action, 'achieved');
  assert.equal(f.calls.taskState.length, 1);
  assert.equal(f.calls.taskState[0].patch.goalState, 'achieved');
  assert.deepEqual(f.calls.notify[0], { id: 's1', type: 'succeeded', message: '无人值守：目标已达成。tests pass',
    options: { classifyState: 'D', goalState: 'achieved' } });
  assert.ok(f.calls.broadcast.some(row => row.payload.type === 'notify'
    && row.payload.state === 'succeeded' && row.payload.goalState === 'achieved'));
  assert.equal(f.calls.inject.length, 0);
  assert.match(lastTrace(f).message.content, /判定：达成 · tests pass$/);
});

test('a needs_human verdict notifies a waiting user instead of injecting', async () => {
  const f = harness({ reply: '{"verdict":"needs_human","humanReason":"password"}' });
  await f.arm();
  const result = await f.host.evaluate('s1', { assistantText: 'need credentials' });
  assert.equal(result.action, 'needs_human');
  assert.equal(f.calls.inject.length, 0);
  assert.deepEqual(f.calls.notify[0], { id: 's1', type: 'waiting', message: '无人值守需要你介入：password',
    options: { classifyState: 'W' } });
  assert.ok(f.calls.broadcast.some(row => row.payload.type === 'notify' && row.payload.state === 'waiting'));
});

test('three identical instructions trip the stall guard and stop for a human', async () => {
  const f = harness({ reply: '{"verdict":"continue","reason":"same","nextInstruction":"same step"}' });
  await f.arm();
  assert.equal((await f.host.evaluate('s1', { assistantText: 'a' })).action, 'inject');
  assert.equal((await f.host.evaluate('s1', { assistantText: 'b' })).action, 'inject');
  const third = await f.host.evaluate('s1', { assistantText: 'c' });
  assert.equal(third.action, 'stalled');
  assert.equal(f.calls.inject.length, 2, 'the stalled turn injects nothing');
  assert.equal(f.calls.notify[0].type, 'waiting');
  assert.equal(f.calls.notify[0].options.classifyState, 'W');
});

test('repeated aux failures eventually notify an error state', async () => {
  const f = harness({ reject: new Error('aux permission denied') });
  await f.arm();
  const first = await f.host.evaluate('s1', { assistantText: 'working' });
  assert.equal(first.action, 'none', 'one failure is below the limit');
  const second = await f.host.evaluate('s1', { assistantText: 'working' });
  assert.equal(second.action, 'error');
  assert.equal(f.calls.inject.length, 0);
  assert.equal(f.calls.notify[0].type, 'error');
  assert.equal(f.calls.notify[0].options.classifyState, 'E');
  assert.match(f.calls.notify[0].message, /辅助模型连续 2 次未能给出可解析的判定/);
});

test('an aux rejection reaches decide as a parse error and still persists', async () => {
  const f = harness({ reject: new Error('aux permission denied') });
  await f.arm();
  const result = await f.host.evaluate('s1', { assistantText: 'working' });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'none');
  assert.equal(f.calls.enqueue.length, 1);
  assert.equal(f.kernelCalls.decisions.length, 1);
  assert.equal(f.kernelCalls.decisions[0].verdict, undefined);
  assert.match(f.kernelCalls.decisions[0].parseError, /aux_failed: aux permission denied/);
  assert.equal(f.host.get('s1').stall.auxFailures, 1);
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
  const f = harness({ reply: '{"verdict":"continue","answer":"B","nextInstruction":"choose B"}' });
  f.records.get('s1').pending = { requestId: 'usrq-1', question: 'Pick one', options: ['A', 'B'] };
  await f.arm();
  const result = await f.host.evaluate('s1', { assistantText: 'choose a lane' });
  assert.equal(result.action, 'inject');
  assert.equal(f.calls.inject.length, 0);
  assert.deepEqual(f.calls.deliver, [{ id: 's1', text: `${TAG} B`,
    // Answering the pending wait is a recovery: it must outrank the FIFO backlog.
    options: { userInputRequestId: 'usrq-1', unattendedSystem: true, unattendedRecovery: true, system: true } }]);
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
  assert.match(lastTrace(f).message.content, /已暂停（用户输入）$/);

  const resumed = await f.host.resume('s1');
  assert.equal(resumed.ok, true);
  assert.equal(f.host.get('s1').pausedBy, null);
  await tick();

  const stopped = f.host.stop('s1');
  assert.equal(stopped.ok, true);
  assert.equal(f.host.get('s1').pausedBy, 'user');

  await f.host.resume('s1');
  await tick();
  const cancelled = await f.host.onTurnEnd('s1', { kind: 'cancel', cancelSource: 'manual_cancel' });
  assert.equal(cancelled.status, STATUS.STOPPED);
  assert.equal(cancelled.pausedBy, 'cancel');
  const enqueuesBefore = f.calls.enqueue.length;
  const after = await f.host.evaluate('s1', { assistantText: 'ignored' });
  assert.deepEqual(after, { ok: false, code: 'not_active' });
  assert.equal(f.calls.enqueue.length, enqueuesBefore);
});

test('a queued supervisor continuation is withdrawn on user takeover, a started one is not', async () => {
  const queued = harness({
    injectResult: { ok: true, queued: true, entry: { id: 'entry-1' } },
    withdrawQueued: () => ({ ok: true }),
  });
  await queued.arm();
  await queued.host.evaluate('s1', { assistantText: 'still working' });
  assert.equal(queued.calls.inject.length, 1);
  queued.host.noteUserMessage('s1');
  assert.deepEqual(queued.calls.withdraw, [{ id: 's1', entryId: 'entry-1' }],
    'the not-yet-started continuation is removed instead of running one more round');

  // Production session delivery resolves admission asynchronously; that shape is
  // tracked too.
  const asyncQueued = harness({
    injectResult: Promise.resolve({ ok: true, queued: true, entry: { id: 'entry-2' } }),
    withdrawQueued: () => ({ ok: true }),
  });
  await asyncQueued.arm();
  await asyncQueued.host.evaluate('s1', { assistantText: 'still working' });
  await tick();
  asyncQueued.host.noteUserMessage('s1');
  assert.deepEqual(asyncQueued.calls.withdraw, [{ id: 's1', entryId: 'entry-2' }]);

  // A selected (already running) delivery, a duplicate admission and a rejected
  // admission own nothing to withdraw.
  for (const injectResult of [
    { ok: true, queued: false, entry: { id: 'entry-3' } },
    { ok: true, duplicate: true, queued: true, entry: { id: 'entry-4' } },
    { ok: false, code: 'delivery_failed' },
  ]) {
    const f = harness({ injectResult, withdrawQueued: () => ({ ok: true }) });
    await f.arm();
    await f.host.evaluate('s1', { assistantText: 'still working' });
    f.host.noteUserMessage('s1');
    assert.deepEqual(f.calls.withdraw, [], JSON.stringify(injectResult));
  }
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

test('D 有 FIFO 时推迟判定，W 必须先解决等待', async () => {
  const f = harness({ hasQueued: true });
  await f.arm();
  const pushes = [];
  const result = await f.host.onTurnEnd('s1', {
    kind: 'settle',
    assistantText: 'done',
    settle: 'D',
    fallbackPush: () => pushes.push('fallback'),
  });
  assert.deepEqual(result, { ok: false, code: 'backlog_pending' });
  assert.equal(f.calls.enqueue.length, 0, 'no verdict burns a round on stale output');
  assert.deepEqual(pushes, ['fallback'], 'the held classic push is released');
  assert.equal(f.host.get('s1').rounds, 0);

  // W 必须先解决等待，不因 FIFO 积压跳过判定。
  const w = harness({ hasQueued: true, taskState: { classifyState: 'W' } });
  await w.arm();
  await w.host.onTurnEnd('s1', { kind: 'settle', assistantText: 'which?', settle: 'W' });
  await tick();
  assert.equal(w.calls.enqueue.length, 1);
  assert.equal(w.calls.inject.length, 1);
});

test('辅助判定期间出现 FIFO 时丢弃过时的达成结论', async () => {
  let queued = false;
  const f = harness({
    hasQueued: () => queued,
    reply: async () => {
      queued = true;
      return '{"verdict":"achieved","reason":"旧目标完成"}';
    },
  });
  await f.arm();
  const result = await f.host.evaluate('s1', { assistantText: '旧回合完成' });
  assert.equal(result.action, 'none');
  assert.equal(f.host.get('s1').status, 'active');
  assert.equal(f.host.get('s1').evaluating, false);
  assert.equal(f.host.get('s1').rounds, 0);
  assert.equal(f.calls.inject.length, 0);
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
  const noOutput = await empty.host.onTurnEnd('s1', { kind: 'settle', settle: 'D', assistantText: '', fallbackPush: () => empty.calls.fallback.push('push') });
  assert.deepEqual(noOutput, { ok: false, code: 'no_output' });
  assert.deepEqual(empty.calls.fallback, ['push']);

  // aux unavailable.
  const noAux = harness({ auxAvailable: false });
  await noAux.arm();
  await noAux.host.onTurnEnd('s1', { kind: 'settle', settle: 'D', assistantText: 'working', fallbackPush: () => noAux.calls.fallback.push('push') });
  assert.deepEqual(noAux.calls.fallback, ['push']);

  // action none (aux failure below its limit): the supervisor stays silent.
  const none = harness({ reject: new Error('aux down') });
  await none.arm();
  await none.host.onTurnEnd('s1', { kind: 'settle', settle: 'D', assistantText: 'working', fallbackPush: () => none.calls.fallback.push('push') });
  assert.deepEqual(none.calls.fallback, ['push']);

  // persist failure: the decided state cannot be stored, so the classic push wins.
  const persistFail = harness();
  await persistFail.arm();
  persistFail.failures.persist = true;
  await persistFail.host.onTurnEnd('s1', { kind: 'settle', settle: 'D', assistantText: 'working', fallbackPush: () => persistFail.calls.fallback.push('push') });
  assert.deepEqual(persistFail.calls.fallback, ['push']);

  // the injector throwing is an apply failure → fallback again.
  const applyFail = harness();
  await applyFail.arm();
  applyFail.failures.inject = true;
  await applyFail.host.onTurnEnd('s1', { kind: 'settle', settle: 'D', assistantText: 'working', fallbackPush: () => applyFail.calls.fallback.push('push') });
  assert.deepEqual(applyFail.calls.fallback, ['push']);

  // an outcome with its own notice suppresses the classic push.
  const inject = harness();
  await inject.arm();
  await inject.host.onTurnEnd('s1', { kind: 'settle', settle: 'D', assistantText: 'working', fallbackPush: () => inject.calls.fallback.push('push') });
  assert.deepEqual(inject.calls.fallback, []);
});

test('fault continuation injects the fixed resume instruction without an aux call', async () => {
  const f = harness();
  await f.arm();
  const decisionOut = await f.host.onTurnEnd('s1', { kind: 'fault', retryScheduled: false });
  assert.equal(decisionOut.action, 'fault_continue');
  assert.equal(f.kernelCalls.turnEnds.length, 1);
  assert.equal(f.calls.enqueue.length, 0, 'no aux verdict for a fault');
  assert.equal(f.calls.inject.length, 1);
  assert.ok(f.calls.inject[0].text.startsWith(TAG));
  assert.match(f.calls.inject[0].text, /verify the current state/);
  assert.equal(f.host.get('s1').rounds, 1);
  assert.match(lastTrace(f).message.content, /故障后自动继续（第 1 次）$/);
});

test('a fault streak backs off 0/60/120/300/600/900s and never needs a human', async () => {
  // The incident: mid-stream 429s used to stop after three faults. A rate
  // limit heals, so a streak only ever backs off; the wall-clock deadline is
  // the only bound.
  const f = harness();
  await f.arm({ maxDurationMinutes: 60 });
  const delays = [0, 60_000, 120_000, 300_000, 600_000, 900_000, 900_000];
  let injects = 0;
  for (let index = 0; index < delays.length; index += 1) {
    const faults = index + 1;
    const at = f.clock();
    const out = await f.host.onTurnEnd('s1', { kind: 'fault', retryScheduled: false });
    const delay = delays[index];
    assert.equal(out.faults, faults);
    assert.equal(f.host.get('s1').stall.consecutiveFaults, faults);
    assert.equal(f.host.get('s1').status, STATUS.ACTIVE, 'recovery outranks giving up');
    if (delay === 0) {
      assert.equal(out.action, 'fault_continue');
      assert.equal(out.retryAt, null);
      injects += 1;
      assert.equal(f.calls.inject.length, injects);
      assert.match(lastTrace(f).message.content,
        new RegExp(`故障后自动继续（第 ${faults} 次）$`));
    } else {
      assert.equal(out.action, 'fault_wait');
      assert.equal(out.retryAt, at + delay);
      assert.equal(out.retryCategory, 'fault');
      assert.equal(f.host.get('s1').retryAt, at + delay);
      assert.equal(f.calls.inject.length, injects, 'a delayed retry waits for the timer');
      assert.equal(f.host.stats().retryTimers, 1);
      assert.match(lastTrace(f).message.content,
        new RegExp(`故障后将在 \\d{2}:\\d{2} 自动重试（第 ${faults} 次）$`));
      f.advance(delay);
      assert.equal(f.fireDueTimers(), 1, 'the one retry timer fires');
      injects += 1;
      assert.equal(f.calls.inject.length, injects);
      assert.equal(f.calls.injectOptions.at(-1).options.unattendedRecovery, true);
      assert.equal(f.host.get('s1').retryAt, null, 'the consumed retry is cleared');
      assert.equal(f.host.stats().retryTimers, 0);
    }
    const notices = f.calls.notify.filter(row => row.type === 'waiting');
    assert.equal(notices.length, faults >= 3 ? 1 : 0, 'exactly one notice at the third fault');
  }
  assert.equal(f.calls.notify.length, 1);
  assert.match(f.calls.notify[0].message, /连续第 3 次上游故障/);
  assert.match(f.calls.notify[0].message, /下一次尝试预计在 \d{2}:\d{2}/);
  assert.match(f.calls.notify[0].message, /你可以随时暂停并接管/);
});

test('a provider unblock hint pushes the retry past the bare backoff', async () => {
  const notBefore = 1_600_000;
  const f = harness({ clock: 1_000_000, getRetryNotBefore: () => notBefore });
  await f.arm({ maxDurationMinutes: 60 });
  const out = await f.host.onTurnEnd('s1', {
    kind: 'fault', faultCategory: 'rate_limit', retryScheduled: false,
  });
  assert.equal(f.kernelCalls.turnEnds[0].retryNotBefore, notBefore, 'the host passes the fact');
  assert.equal(out.action, 'fault_wait');
  assert.equal(out.faults, 1);
  assert.equal(out.retryAt, notBefore, 'the unblock time wins over now + 0');
  assert.equal(out.retryCategory, 'capacity');
  assert.ok(lastTrace(f).message.content.includes('上游额度/线路暂不可用'));
  assert.equal(f.calls.inject.length, 0);
  f.advance(notBefore - f.clock());
  assert.equal(f.fireDueTimers(), 1);
  assert.equal(f.calls.inject.length, 1);
});

test('a retry that lands after the deadline needs a human', async () => {
  const f = harness();
  await f.arm(); // 5 min
  f.records.get('s1').unattended = {
    ...f.host.get('s1'),
    stall: { sameInstruction: 0, auxFailures: 0, consecutiveFaults: 4 },
  };
  const out = await f.host.onTurnEnd('s1', { kind: 'fault', retryScheduled: false });
  assert.equal(out.action, 'needs_human');
  assert.equal(out.reason, 'retry_past_deadline');
  assert.equal(out.retryAt, f.clock() + 600_000);
  await tick();
  assert.equal(f.host.get('s1').status, STATUS.NEEDS_HUMAN);
  assert.equal(f.host.get('s1').retryAt, null);
  assert.equal(f.calls.inject.length, 0);
  assert.equal(f.host.stats().retryTimers, 0);
});

test('a human-only fault category stops immediately with the cause in the message', async () => {
  for (const category of ['authentication_permission', 'billing_quota',
    'invalid_request_model', 'adapter_configuration']) {
    const f = harness();
    await f.arm();
    const out = await f.host.onTurnEnd('s1', {
      kind: 'fault', faultCategory: category, retryScheduled: false,
    });
    assert.equal(out.action, 'needs_human', category);
    assert.equal(out.reason, 'non_recoverable_fault', category);
    assert.match(out.message, /无人值守已停止自动续接/, category);
    assert.equal(f.host.get('s1').status, STATUS.NEEDS_HUMAN, category);
    assert.equal(f.calls.inject.length, 0, category);
    assert.equal(f.host.stats().retryTimers, 0, category);
  }
});

test('a clean D/W settle resets the fault streak and clears a pending retry', async () => {
  const f = harness();
  await f.arm({ maxDurationMinutes: 60 });
  f.records.get('s1').unattended = {
    ...f.host.get('s1'),
    status: STATUS.ACTIVE,
    stall: { sameInstruction: 0, auxFailures: 0, consecutiveFaults: 2 },
    retryAt: f.clock() + 120_000,
    retryCategory: 'fault',
  };
  await f.host.onTurnEnd('s1', { kind: 'settle', settle: 'D', assistantText: 'recovered' });
  assert.ok(f.calls.persist.some(row => row.state.stall && row.state.stall.consecutiveFaults === 0),
    'the settle proves the upstream recovered');
  const settled = f.host.get('s1');
  assert.equal(settled.retryAt, null, 'a real settle clears the armed retry');
  assert.equal(settled.retryCategory, null);
  assert.equal(f.host.stats().retryTimers, 0);
});

test('stop and a user takeover cancel the pending retry timer', async () => {
  for (const how of ['stop', 'input']) {
    const f = harness({ clock: 1_000_000 });
    await f.arm({ maxDurationMinutes: 60 });
    await f.host.onTurnEnd('s1', { kind: 'fault', retryScheduled: false });
    const delayed = await f.host.onTurnEnd('s1', { kind: 'fault', retryScheduled: false });
    assert.equal(delayed.action, 'fault_wait');
    assert.equal(f.host.stats().retryTimers, 1);
    if (how === 'stop') f.host.stop('s1');
    else f.host.noteUserMessage('s1');
    assert.equal(f.host.get('s1').retryAt, null, how);
    assert.equal(f.host.get('s1').status, STATUS.STOPPED, how);
    assert.equal(f.host.stats().retryTimers, 0, how);
    const before = f.calls.inject.length;
    f.advance(60_000);
    f.fireDueTimers();
    assert.equal(f.calls.inject.length, before, `${how}: a cancelled timer never injects`);
  }
});

test('a turn already running when the retry timer fires wins and clears the marker', async () => {
  let busy = false;
  const f = harness({ clock: 1_000_000, busy: () => busy });
  await f.arm({ maxDurationMinutes: 60 });
  await f.host.onTurnEnd('s1', { kind: 'fault', retryScheduled: false });
  const delayed = await f.host.onTurnEnd('s1', { kind: 'fault', retryScheduled: false });
  assert.equal(delayed.action, 'fault_wait');
  const before = f.calls.inject.length;
  busy = true; // a new turn started before retryAt
  f.advance(60_000);
  assert.equal(f.fireDueTimers(), 1);
  assert.equal(f.calls.inject.length, before, 'the running turn owns the conversation');
  assert.equal(f.host.get('s1').retryAt, null, 'the obsolete retry is consumed');
  assert.equal(f.host.get('s1').status, STATUS.ACTIVE);
});

test('boot re-arms a persisted retry and fires promptly when it is already due', async () => {
  const f = harness({ clock: 2_000_000 });
  await f.arm({ maxDurationMinutes: 60 });
  f.records.get('s1').unattended = {
    ...f.host.get('s1'),
    stall: { sameInstruction: 0, auxFailures: 0, consecutiveFaults: 2 },
    retryAt: 1_999_000, // already past
    retryCategory: 'fault',
  };
  f.host.rearmTimer('s1');
  assert.equal(f.host.stats().retryTimers, 1);
  assert.equal(f.fireDueTimers(), 1, 'a past-due retry fires on the next boot tick');
  assert.equal(f.calls.inject.length, 1);
  assert.equal(f.calls.injectOptions[0].options.unattendedRecovery, true);
  assert.equal(f.host.get('s1').retryAt, null);
});

test('resume resets the fault streak and drops the pending retry', async () => {
  const f = harness({ clock: 1_000_000 });
  await f.arm({ maxDurationMinutes: 60 });
  f.records.get('s1').unattended = {
    ...f.host.get('s1'),
    status: STATUS.NEEDS_HUMAN,
    stall: { sameInstruction: 0, auxFailures: 0, consecutiveFaults: 4 },
    retryAt: 1_060_000,
    retryCategory: 'capacity',
  };
  const out = await f.host.resume('s1', {});
  assert.equal(out.ok, true);
  const resumed = f.host.get('s1');
  assert.equal(resumed.status, STATUS.ACTIVE);
  assert.deepEqual(resumed.stall, { sameInstruction: 0, auxFailures: 0, consecutiveFaults: 0 });
  assert.equal(resumed.retryAt, null);
  assert.equal(resumed.retryCategory, null);
  assert.equal(f.host.stats().retryTimers, 0);
  await tick();
});

test('a host-side cancel continues, a user cancel pauses — all through one entry', async () => {
  const hostCancel = harness();
  await hostCancel.arm();
  const continued = await hostCancel.host.onTurnEnd('s1', {
    kind: 'cancel', cancelSource: 'process_watchdog', killReason: 'process_watchdog',
  });
  assert.equal(continued.action, 'fault_continue');
  assert.equal(hostCancel.kernelCalls.turnEnds[0].cancelSource, 'process_watchdog');
  assert.equal(hostCancel.kernelCalls.turnEnds[0].killReason, 'process_watchdog');
  assert.equal(hostCancel.calls.enqueue.length, 0, 'a cancel continuation needs no Aux verdict');
  assert.equal(hostCancel.calls.inject.length, 1);
  assert.match(hostCancel.calls.inject[0].text, /verify the current state/);

  const userCancel = harness();
  await userCancel.arm();
  const paused = await userCancel.host.onTurnEnd('s1', { kind: 'cancel', cancelSource: 'manual_cancel' });
  assert.equal(paused.status, STATUS.STOPPED);
  assert.equal(paused.pausedBy, 'cancel');
  assert.equal(userCancel.calls.inject.length, 0);

  const insert = harness();
  await insert.arm();
  const takeover = await insert.host.onTurnEnd('s1', {
    kind: 'cancel', cancelSource: 'insert_queued', killReason: 'new_user_message',
  });
  assert.equal(takeover.status, STATUS.STOPPED);
  assert.equal(takeover.pausedBy, 'input', 'an inserted message is a takeover, not a cancel');
});

test('a turn killed by shutdown, cli_switch or relocate continues through the same entry', async () => {
  // Those paths kill the runner; the close finalizer reports the turn as a
  // fault settle carrying the kill reason. Each is a host interruption, so the
  // supervisor continues instead of silently leaving the session parked.
  for (const killReason of ['shutdown', 'cli_switch', 'relocate']) {
    const f = harness();
    await f.arm();
    const out = await f.host.onTurnEnd('s1', {
      kind: 'fault', settle: 'E', killReason, retryScheduled: false,
    });
    assert.equal(out.action, 'fault_continue', killReason);
    assert.equal(f.calls.inject.length, 1, killReason);
    assert.equal(f.host.get('s1').status, STATUS.ACTIVE, killReason);
  }
});

test('a fault whose API policy already scheduled a retry injects nothing', async () => {
  const f = harness();
  await f.arm();
  const push = [];
  const out = await f.host.onTurnEnd('s1', {
    kind: 'fault', retryScheduled: true, fallbackPush: () => push.push('classic'),
  });
  assert.deepEqual(out, { ok: false, code: 'policy_retry' });
  assert.equal(f.kernelCalls.turnEnds[0].retryScheduled, true);
  assert.equal(f.calls.inject.length, 0, 'the API policy owns the retry');
  assert.deepEqual(push, ['classic'], 'a no-op turn end still releases the held push');
});

test('a non-boolean retryScheduled is rejected instead of being coerced', async () => {
  const f = harness();
  await f.arm();
  const push = [];
  const out = await f.host.onTurnEnd('s1', {
    kind: 'fault', retryScheduled: 'true', fallbackPush: () => push.push('classic'),
  });
  assert.equal(out, null, 'an invalid fact is not a decision');
  assert.equal(f.calls.inject.length, 0, 'the API policy retry is never double-injected');
  assert.deepEqual(push, ['classic'], 'the held push is released');
  assert.ok(f.logs.some(line => /turn-end decision failed/.test(line)));
});

test('a user-caused fault pauses for every user source, regardless of kind or retry', async () => {
  // High 1: the finalize observer can report E before the cancel writer runs.
  // Attribution, not `kind`, decides: a user source never injects.
  const sources = [
    'manual_cancel', 'task-shell', 'user_cancel', 'insert_queued', 'force_insert',
    'new_user_message', 'cancel_repeat', 'dispatch_cancel',
  ];
  for (const source of sources) {
    for (const retryScheduled of [false, true]) {
      const f = harness();
      await f.arm();
      const out = await f.host.onTurnEnd('s1', { kind: 'fault', killReason: source, retryScheduled });
      assert.equal(out.status, STATUS.STOPPED, source);
      assert.equal(out.pausedBy, ['insert_queued', 'force_insert', 'new_user_message'].includes(source)
        ? 'input' : 'cancel', source);
      assert.equal(f.calls.inject.length, 0, `${source}: no continuation may be injected`);
      assert.equal(f.calls.enqueue.length, 0, `${source}: no verdict either`);
    }
  }
});

test('a second report for the same turn is a no-op', async () => {
  const f = harness();
  await f.arm();
  const first = await f.host.onTurnEnd('s1', {
    kind: 'cancel', turnId: 'turn-1', cancelSource: 'process_watchdog', killReason: 'process_watchdog',
  });
  assert.equal(first.action, 'fault_continue');
  assert.equal(f.calls.inject.length, 1);
  assert.equal(f.host.get('s1').lastTurnEndId, 'turn-1');
  const second = await f.host.onTurnEnd('s1', {
    kind: 'cancel', turnId: 'turn-1', cancelSource: 'process_watchdog', killReason: 'process_watchdog',
  });
  assert.deepEqual(second, { ok: false, code: 'duplicate_turn' });
  assert.equal(f.calls.inject.length, 1, 'the same turn injects exactly once');
});

test('a later user cancel for an already-handled turn pauses without another injection', async () => {
  const f = harness();
  await f.arm();
  await f.host.onTurnEnd('s1', {
    kind: 'cancel', turnId: 'turn-2', cancelSource: 'process_watchdog', killReason: 'process_watchdog',
  });
  assert.equal(f.calls.inject.length, 1);
  const late = await f.host.onTurnEnd('s1', {
    kind: 'cancel', turnId: 'turn-2', cancelSource: 'manual_cancel',
  });
  assert.equal(late.status, STATUS.STOPPED);
  assert.equal(late.pausedBy, 'cancel');
  assert.equal(f.calls.inject.length, 1, 'the user wins as a pause, never a second injection');
});

test('a D settle then a duplicate cancel report injects exactly once', async () => {
  const f = harness();
  await f.arm();
  const settled = await f.host.onTurnEnd('s1', {
    kind: 'settle', settle: 'D', turnId: 'turn-3', assistantText: 'done',
  });
  assert.equal(settled.action, 'inject');
  assert.equal(f.host.get('s1').lastTurnEndId, 'turn-3', 'the verdict rebuild keeps the turn identity');
  const duplicate = await f.host.onTurnEnd('s1', {
    kind: 'cancel', turnId: 'turn-3', cancelSource: 'process_watchdog',
  });
  assert.deepEqual(duplicate, { ok: false, code: 'duplicate_turn' });
  assert.equal(f.calls.inject.length, 1);
});

test('a policy-scheduled retry leaves the turn unclaimed and its later settle evaluates', async () => {
  const f = harness();
  await f.arm();
  // The API policy owns this retry and reuses the SAME turn object: the turn has
  // not ended, so the supervisor must not claim it. Claiming it would make the
  // retry's real settle a duplicate and leave the session input locked.
  const retry = await f.host.onTurnEnd('s1', {
    kind: 'fault', settle: 'E', turnId: 'turn-retry', retryScheduled: true,
  });
  assert.deepEqual(retry, { ok: false, code: 'policy_retry' });
  assert.equal(f.calls.inject.length, 0, 'the supervisor injects nothing for a policy retry');
  assert.equal(f.host.get('s1').lastTurnEndId, undefined, 'the turn is not claimed');
  assert.equal(f.host.get('s1').lastSettleAt, undefined, 'no settle watermark is stamped');

  const settled = await f.host.onTurnEnd('s1', {
    kind: 'settle', settle: 'D', turnId: 'turn-retry', assistantText: 'retry finished',
  });
  assert.equal(settled.ok, true);
  assert.equal(settled.action, 'inject', 'the retry\'s own settle still evaluates');
  assert.equal(f.calls.enqueue.length, 1);
  assert.equal(f.calls.inject.length, 1);
  assert.equal(f.host.get('s1').lastTurnEndId, 'turn-retry');
});

test('a handled turn end is not replayed from task state after a restart', async () => {
  const f = harness({ clock: 6000 });
  await f.arm();
  await f.host.onTurnEnd('s1', {
    kind: 'settle', settle: 'D', turnId: 'turn-eval', assistantText: 'done',
  });
  assert.equal(f.calls.inject.length, 1);
  f.advance(1000);
  const historical = {
    classifyState: 'E', endedAt: 7000, cancelledAt: 7000,
    cancelReason: 'process_watchdog', cancelSource: 'process_watchdog', turnId: 'turn-eval',
  };
  f.records.get('s1').taskState = historical;
  const result = await f.host.reconcileStartup();
  assert.deepEqual(result.settled, [], 'the turn identity makes the replay a no-op');
  assert.equal(f.calls.inject.length, 1);
});

test('a restart-settled cancel is replayed exactly once at boot', async () => {
  const taskState = {
    classifyState: 'E', endedAt: 5000, cancelledAt: 5000, turnId: 'turn-boot',
    cancelReason: 'process_watchdog', cancelSource: 'process_watchdog',
  };
  const f = harness({ taskState, schedulerStatus: { active: null } });
  await f.arm();
  f.advance(6000 - f.clock());
  const first = await f.host.reconcileStartup();
  assert.equal(first.settled.length, 1, 'the interrupted cancel is settled');
  assert.deepEqual(first.failedIds, []);
  assert.equal(f.kernelCalls.turnEnds[0].kind, 'cancel');
  assert.equal(f.kernelCalls.turnEnds[0].cancelSource, 'process_watchdog');
  assert.equal(f.kernelCalls.turnEnds[0].turnId, 'turn-boot');
  assert.equal(f.calls.inject.length, 1);
  assert.equal(f.host.get('s1').lastSettleAt, 6000, 'the handled settle is watermarked');

  const second = await f.host.reconcileStartup();
  assert.deepEqual(second.settled, [], 'the watermark prevents a second trigger');
  assert.equal(f.calls.inject.length, 1, 'one settle never injects twice');
});

test('boot reconciliation never replays a persisted P turn: the watchdog owns it', async () => {
  // One owner per orphan. A shutdown-killed turn leaves P + `activeTurnId` and
  // no cancel record. Boot must leave it alone — with or without a recovered
  // scheduler slot — because the processing watchdog is the only observer that
  // can prove the runner is dead. Two owners would each write E and only
  // `duplicate_turn` would keep the continuation single (already the observed
  // production shape when scheduler.recover rebuilds legacy-active).
  for (const schedulerStatus of [
    { active: { entryId: 'legacy-active:s1' }, queued: [] },
    { active: null, queued: [] },
    null,
  ]) {
    const taskState = { classifyState: 'P', turnId: 'turn-prev', activeTurnId: 'turn-current' };
    const f = harness({ taskState, schedulerStatus });
    await f.arm();
    f.advance(6000 - f.clock());
    assert.deepEqual((await f.host.reconcileStartup()).settled, [],
      `boot leaves the P turn to the watchdog (status ${JSON.stringify(schedulerStatus)})`);
    assert.equal(f.calls.inject.length, 0);
    assert.equal(f.kernelCalls.turnEnds.length, 0);
    assert.equal(f.host.get('s1').lastTurnEndId, undefined, 'nothing claimed the turn');
  }
});

test('startup reconciliation leaves live slots, handled settles and user cancels alone', async () => {
  const taskState = {
    classifyState: 'E', endedAt: 5000, cancelledAt: 5000,
    cancelReason: 'process_watchdog', cancelSource: 'process_watchdog',
  };
  const live = harness({ taskState, schedulerStatus: { active: { id: 'entry-1' } } });
  await live.arm();
  live.advance(6000 - live.clock());
  assert.deepEqual((await live.host.reconcileStartup()).settled, [], 'the watchdog owns a still-live slot');

  const handled = harness({ taskState, schedulerStatus: null });
  await handled.arm();
  handled.advance(6000 - handled.clock());
  handled.records.get('s1').unattended = { ...handled.host.get('s1'), lastSettleAt: 5000 };
  assert.deepEqual((await handled.host.reconcileStartup()).settled, [], 'an already settled turn is not replayed');

  const user = harness({
    taskState: { classifyState: 'E', endedAt: 5000, cancelledAt: 5000, cancelSource: 'manual_cancel' },
    schedulerStatus: null,
  });
  await user.arm();
  user.advance(6000 - user.clock());
  const out = await user.host.reconcileStartup();
  assert.equal(out.settled.length, 1);
  assert.equal(out.settled[0].pausedBy, 'cancel', 'a user cancel still pauses');
  assert.equal(user.calls.inject.length, 0);

  // Low 2: a new run started after the old cancel must not be paused by it.
  const newRun = harness({ taskState, schedulerStatus: null });
  await newRun.arm();
  newRun.advance(6000 - newRun.clock());
  newRun.records.get('s1').unattended = { ...newRun.host.get('s1'), startedAt: 9000 };
  const historical = await newRun.host.reconcileStartup();
  assert.deepEqual(historical.settled, [], 'an event before startedAt belongs to a previous run');
  assert.equal(newRun.host.get('s1').status, STATUS.ACTIVE);
  assert.equal(newRun.calls.inject.length, 0);
});

test('one failing session does not stop the boot replay of the others', async () => {
  const healthy = { classifyState: 'E', endedAt: 5000, cancelledAt: 5000,
    cancelReason: 'process_watchdog', cancelSource: 'process_watchdog', turnId: 'turn-s2' };
  const broken = { get cancelledAt() { throw new Error('task state unreadable'); } };
  const f = harness({
    peers: [{ id: 's2' }],
    taskState: id => (id === 's1' ? broken : healthy),
    schedulerStatus: { active: null },
  });
  await f.arm();
  await f.host.start('s2', { goal: 'ship it', maxDurationMinutes: 5, evaluateNow: false });
  f.advance(6000 - f.clock());
  const result = await f.host.reconcileStartup();
  assert.deepEqual(result.failedIds, ['s1'], 'the broken session is reported, not hidden');
  assert.equal(result.settled.length, 1, 'the healthy session still settles');
  assert.deepEqual(f.calls.inject.map(row => row.id), ['s2']);
  assert.ok(f.logs.some(line => /startup reconcile failed for s1/.test(line)));
  assert.ok(f.logs.some(line => /1 session\(s\) failed: s1/.test(line)));
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
  const trace = lastTrace(f);
  assert.equal(trace.message.content, `${TAG} 已达到最长值守时间`);
  assert.ok(f.calls.broadcast.some(row => row.payload.type === 'unattended_state'
    && row.payload.unattended.status === STATUS.EXHAUSTED));
  assert.deepEqual(f.calls.notify[0], { id: 's1', type: 'error', message: `${TAG} 已达到最长值守时间`,
    options: { classifyState: 'E' } });
  assert.equal(f.calls.enqueue.length, 0, 'expiry needs no verdict');
  assert.equal(f.host.stats().timers, 0, 'the timer disarms after firing');
});

test('expiry releases the held classic push and blocks a late injection', async () => {
  const f = harness();
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
  assert.match(lastTrace(f).message.content, /截止时间顺延到 1 分钟后$/);
});

test('thirty-one-plus rounds keep inject instead of exhausting', async () => {
  let step = 0;
  const f = harness({
    reply: () => {
      step += 1;
      return JSON.stringify({ verdict: 'continue', reason: 'more', nextInstruction: `step ${step}` });
    },
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
  let replies = 0;
  const f = harness({ reply: () => ++replies === 1
    ? '{"verdict":"achieved","reason":"旧输出已完成"}' : CONTINUE });
  await f.arm();
  f.calls.enqueue.length = 0;
  const host = f.host;
  const first = host.evaluate('s1', { assistantText: 'first' });
  const second = host.evaluate('s1', { assistantText: 'second' });
  const secondResult = await second;
  assert.deepEqual(secondResult, { ok: true, deferred: true });
  assert.equal(host.stats().inFlight, 1);
  assert.equal(host.stats().queued, 1);
  assert.equal((await first).action, 'none', '后续回合已结束时也不能采用旧判定');
  await new Promise(done => setImmediate(done));
  assert.equal(host.stats().queued, 0);
  // The coalesced follow-up ran after the first finished.
  assert.ok(f.calls.enqueue.length >= 2);
  assert.equal(host.get('s1').status, 'active');
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
