'use strict';

// Unattended supervisor glue (src/unattended/host.js): evidence gathering, one
// aux call per settle, persistence and the decided action. The policy itself
// (budget, stall, aux-failure counting) is Rust (native/core/src/unattended.rs)
// and covered there; here `kernel` is a scripted fake so each branch of the
// application layer is exercised in isolation.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createUnattendedHost, STATUS } = require('../src/unattended/host');

function decision(action, extra = {}) {
  return {
    nextState: { status: STATUS.ACTIVE, goal: 'ship it', criteria: [], maxRounds: 5, rounds: 1,
      startedAt: 1, updatedAt: 2, lastVerdict: null, history: [], stall: { sameInstruction: 0, auxFailures: 0 } },
    action,
    message: extra.message === undefined ? `message:${action}` : extra.message,
    ...extra,
  };
}

function harness({ reply = '{"verdict":"continue","reason":"next","nextInstruction":"do X"}', reject = null,
  planned = decision('inject'), record = { id: 's1', type: null } } = {}) {
  const records = new Map([[record.id, record]]);
  const calls = { persist: [], broadcast: [], notify: [], inject: [], deliver: [], taskState: [], enqueue: [] };
  const kernelCalls = { prompts: [], decisions: [] };
  const kernel = {
    normalizeConfig(input) {
      const goal = String(input.goal || '').trim();
      if (!goal) return { ok: false, error: 'goal_required' };
      return { ok: true, config: {
        goal,
        criteria: Array.isArray(input.criteria) ? input.criteria.map(String) : [],
        maxRounds: Math.max(1, Math.min(200, Math.floor(Number(input.maxRounds) || 30))),
      } };
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
  };
  const host = createUnattendedHost({
    getRecord: id => records.get(id),
    persistState: (id, next) => {
      calls.persist.push(next);
      records.get(id).unattended = next;
    },
    getHistory: id => record.history || [
      { role: 'user', content: 'ship it' },
      { role: 'assistant', content: 'working on it' },
    ],
    setTaskState: (id, patch) => calls.taskState.push({ id, patch }),
    getPendingQuestion: () => records.get(record.id).pending || null,
    getAuxQueue: () => ({
      enqueue: async request => {
        calls.enqueue.push(request);
        if (reject) throw reject;
        return { text: reply };
      },
    }),
    deliver: async (id, text, options) => calls.deliver.push({ id, text, options }),
    inject: (id, text) => calls.inject.push({ id, text }),
    notify: (id, type, message, options) => calls.notify.push({ id, type, message, options }),
    broadcast: (id, payload) => calls.broadcast.push({ id, payload }),
    now: () => 1234,
    kernel,
  });
  function arm() {
    const result = host.start('s1', { goal: 'ship it', maxRounds: 5, evaluateNow: false });
    assert.equal(result.ok, true);
    calls.persist.length = 0;
    calls.broadcast.length = 0;
    return result;
  }
  return { host, records, calls, kernelCalls, arm, record };
}

test('continue injects the decided instruction and stores the new state', async () => {
  const f = harness({ planned: decision('inject', { message: '【无人值守】do X' }) });
  f.arm();
  const result = await f.host.evaluate('s1', { reason: 'turn_end', assistantText: 'still working' });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'inject');
  assert.deepEqual(f.calls.inject, [{ id: 's1', text: '【无人值守】do X' }]);
  assert.equal(f.calls.enqueue[0].type, 'unattended_verdict');
  assert.equal(f.calls.enqueue[0].priority, 'interactive');
  assert.deepEqual(f.calls.enqueue[0].meta, { sessionName: 's1', unattended: true });
  assert.equal(f.calls.persist.length, 1, 'the decided nextState is persisted once');
  assert.equal(f.calls.persist[0].rounds, 1);
  assert.ok(f.calls.broadcast.some(row => row.payload.type === 'unattended_state'));
  assert.equal(f.calls.notify.length, 0);
  // Evidence carries the assistant output, recent history and the goal state.
  assert.equal(f.kernelCalls.prompts[0].lastOutput, 'still working');
  assert.equal(f.kernelCalls.prompts[0].goal, 'ship it');
  assert.equal(f.kernelCalls.prompts[0].rounds, 0);
});

test('achieved marks the task goal achieved and notifies success', async () => {
  const f = harness({ reply: '{"verdict":"achieved","reason":"tests pass"}',
    planned: decision('achieved', { message: '目标已达成' }) });
  f.arm();
  const result = await f.host.evaluate('s1', { assistantText: 'all tests pass' });
  assert.equal(result.action, 'achieved');
  assert.equal(f.calls.taskState.length, 1);
  assert.equal(f.calls.taskState[0].patch.goalState, 'achieved');
  assert.deepEqual(f.calls.notify[0], { id: 's1', type: 'succeeded', message: '目标已达成',
    options: { classifyState: 'D', goalState: 'achieved' } });
  assert.ok(f.calls.broadcast.some(row => row.payload.type === 'notify'
    && row.payload.state === 'succeeded' && row.payload.goalState === 'achieved'));
  assert.equal(f.calls.inject.length, 0);
});

test('needs_human and stalled notify a waiting user instead of injecting', async () => {
  for (const action of ['needs_human', 'stalled']) {
    const f = harness({ reply: '{"verdict":"needs_human","reason":"needs password","humanReason":"password"}',
      planned: decision(action, { message: `blocked:${action}` }) });
    f.arm();
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
    f.arm();
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
  f.arm();
  const result = await f.host.evaluate('s1', { assistantText: 'working' });
  assert.equal(result.ok, true);
  assert.equal(f.calls.enqueue.length, 1);
  assert.equal(f.kernelCalls.decisions.length, 1);
  assert.equal(f.kernelCalls.decisions[0].verdict, undefined);
  assert.match(f.kernelCalls.decisions[0].parseError, /aux_failed: aux permission denied/);
  assert.equal(f.calls.persist.length, 1);
});

test('a cancelled aux request changes nothing', async () => {
  const cancelled = new Error('cancelled');
  cancelled.cancelled = true;
  const f = harness({ reject: cancelled });
  f.arm();
  const result = await f.host.evaluate('s1', { assistantText: 'working' });
  assert.deepEqual(result, { ok: false, code: 'cancelled' });
  assert.equal(f.kernelCalls.decisions.length, 0);
  assert.equal(f.calls.persist.length, 0);
});

test('a pending question is answered through the delivery path, not injected as a turn', async () => {
  const f = harness({ planned: decision('inject', {
    message: '【无人值守】choose B', answer: 'B', pendingQuestionId: 'usrq-1',
  }) });
  f.records.get('s1').pending = { requestId: 'usrq-1', question: 'Pick one', options: ['A', 'B'] };
  f.arm();
  const result = await f.host.evaluate('s1', { assistantText: 'choose a lane' });
  assert.equal(result.action, 'inject');
  assert.equal(f.calls.inject.length, 0);
  assert.deepEqual(f.calls.deliver, [{ id: 's1', text: 'B',
    options: { userInputRequestId: 'usrq-1', unattendedSystem: true } }]);
  // The question was forwarded to the aux prompt as evidence.
  assert.deepEqual(f.kernelCalls.prompts[0].pendingQuestion,
    { requestId: 'usrq-1', question: 'Pick one', options: ['A', 'B'] });
});

test('manual cancel stops the loop and a user message only resets counters', async () => {
  const f = harness();
  f.arm();
  f.records.get('s1').unattended = { ...f.records.get('s1').unattended,
    stall: { sameInstruction: 2, auxFailures: 1 } };
  f.calls.persist.length = 0;
  const noted = f.host.noteUserMessage('s1');
  assert.equal(noted.status, STATUS.ACTIVE, 'typing to the agent does not disarm it');
  assert.deepEqual(noted.stall, { sameInstruction: 0, auxFailures: 0 });

  const stopped = f.host.onManualCancel('s1');
  assert.equal(stopped.status, STATUS.STOPPED);
  assert.equal(f.records.get('s1').unattended.status, STATUS.STOPPED);
  const after = await f.host.evaluate('s1', { assistantText: 'ignored' });
  assert.deepEqual(after, { ok: false, code: 'not_active' });
  assert.equal(f.calls.enqueue.length, 0);
});

test('stop and resume move the state and re-evaluate on resume', async () => {
  const f = harness();
  f.arm();
  assert.equal(f.host.stop('s1').ok, true);
  assert.equal(f.host.get('s1').status, STATUS.STOPPED);
  f.calls.enqueue.length = 0;
  const resumed = f.host.resume('s1');
  assert.equal(resumed.ok, true);
  assert.equal(f.host.get('s1').status, STATUS.ACTIVE);
  assert.equal(f.calls.enqueue.length, 1, 'resume asks the aux for a fresh verdict');
  await new Promise(done => setImmediate(done));
});

test('first-message arming is idempotent for the same config', () => {
  const f = harness();
  const first = f.host.armFromRequest('s1', { maxRounds: 5 }, { defaultGoal: 'ship it' });
  assert.equal(first.ok, true);
  assert.equal(first.unattended.goal, 'ship it');
  assert.equal(first.unattended.maxRounds, 5);
  assert.ok(first.unattended.startedAt === 1234);
  const again = f.host.armFromRequest('s1', { maxRounds: 5 }, { defaultGoal: 'ship it' });
  assert.equal(again.unchanged, true);
  assert.equal(again.unattended, first.unattended, 'a receipt retry must not reset rounds');
  assert.deepEqual(f.host.armFromRequest('s1', {}, { defaultGoal: '   ' }),
    { ok: false, code: 'goal_required' });
  assert.deepEqual(f.host.armFromRequest('missing', { maxRounds: 2 }),
    { ok: false, code: 'session_not_found' });
});

test('one in-flight evaluation coalesces a second settle', async () => {
  const f = harness();
  f.arm();
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
