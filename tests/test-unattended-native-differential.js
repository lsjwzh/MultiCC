'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const frozen = require('./helpers/frozen-unattended/host');
const oldKernel = require('./helpers/frozen-unattended/kernel');
const native = require('../src/unattended/native-host');
const tick = () => new Promise(resolve => setImmediate(resolve));
const achieved = { text: '{"verdict":"achieved","reason":"finished"}' };
const more = { text: '{"verdict":"continue","reason":"next","nextInstruction":"work","answer":"ok"}' };

function supervisor(api, overrides = {}) {
  const record = { id: 's' };
  const events = [];
  const effect = name => (...args) => { events.push([name, structuredClone(args)]); };
  const host = api.createUnattendedHost({
    getRecord: () => record,
    persistState: (id, value) => { effect('save')(id, value); record.unattended = value; },
    now: () => 1234, setTimeout: () => 1, clearTimeout() {},
    getHistory: () => [{ role: 'assistant', content: 'done' }],
    appendMessage: effect('append'), broadcast: effect('broadcast'),
    notify: effect('notify'), inject: effect('inject'), setTaskState: effect('task'),
    ...overrides,
  });
  return { host, record, events };
}
const start = (host, goal) => host.start('s', { goal, evaluateNow: false });
function observe(fn) {
  try { return { value: fn() }; }
  catch (e) { return { error: [e.name, e.code, e.message] }; }
}

test('frozen kernel facade, values and error mapping', () => {
  const next = native.kernel;
  assert.deepEqual(Object.keys(next), Object.keys(oldKernel));
  assert.deepEqual(next.LIMITS, oldKernel.LIMITS);
  assert(Object.isFrozen(next.LIMITS));
  assert.equal(next.TAG, oldKernel.TAG);
  assert.equal(Object.getOwnPropertyDescriptor(next, 'TAG').get.name, 'get TAG');
  const cycle = {}; cycle.self = cycle;
  for (const name of Object.keys(oldKernel).filter(k => typeof oldKernel[k] === 'function')) {
    assert.equal(next[name].length, oldKernel[name].length);
    assert.equal(next[name].name, oldKernel[name].name);
    for (const input of [undefined, null, true, 0, {}, { state: { status: 'active' }, now: 1234 },
      { goal: '努力', criteria: ['done'] }, 'bad json', Symbol('x'), 1n, () => 0, cycle]) {
      assert.deepEqual(observe(() => next[name](input)), observe(() => oldKernel[name](input)), name);
    }
  }
});

for (const [label, reply] of Object.entries({ achieved, more, invalid: { text: '???' } })) {
  test('frozen supervisor results and ordered effects — ' + label, async () => {
    async function run(api) {
      const { host, record, events } = supervisor(api, { getAuxQueue: () => ({ enqueue: () => reply }) });
      const shape = Object.entries(host).map(([k, f]) => [k, f.name, f.length]);
      assert(Object.isFrozen(host));
      const results = [];
      results.push(await start(host, 'ship'), host.update('s', { criteria: ['ship'] }));
      results.push(await host.onTurnEnd('s', { kind: 'fault', retryScheduled: true }));
      results.push(await host.onTurnEnd('s', { settle: 'D', turnId: 't1' }));
      results.push(host.stop('s'), host.clear('s'));
      await tick();
      return { shape, results, record, events, stats: host.stats() };
    }
    assert.deepEqual(await run(native), await run(frozen));
  });
}

test('an earlier verdict and its fallback cannot settle a replacement evaluation', async () => {
  const a = Promise.withResolvers(), b = Promise.withResolvers();
  const pushes = [], answers = [a.promise, b.promise];
  const { host, record, events } = supervisor(native, { getAuxQueue: () => ({ enqueue: () => answers.shift() }) });
  await start(host, 'first');
  const first = host.evaluate('s', { fallbackPush: () => pushes.push('first') });
  await tick();
  await start(host, 'second');
  const second = host.evaluate('s', { fallbackPush: () => pushes.push('second') });
  await tick();
  a.resolve(achieved);
  assert.equal((await first).code, 'superseded');
  assert.equal(record.unattended.goal, 'second');
  assert.equal(record.unattended.status, 'active');
  assert.equal(record.unattended.evaluating, true);
  assert.deepEqual(pushes, ['first']);
  assert.equal(events.filter(([k]) => k === 'notify').length, 0);
  b.resolve(achieved);
  assert.equal((await second).action, 'achieved');
  assert.deepEqual(pushes, ['first']);
  assert.equal(host.stats().inFlight, 0);
});

for (const method of ['inject', 'deliver']) {
  for (const duplicate of [false, true]) {
    test(method + ' late admission after stop, duplicate=' + duplicate, async () => {
      const sent = Promise.withResolvers(), entered = Promise.withResolvers(), removed = [];
      const { host } = supervisor(native, {
        [method]: () => { entered.resolve(); return sent.promise; },
        getAuxQueue: () => ({ enqueue: () => more }),
        getPendingQuestion: () => method === 'deliver' ? { requestId: 'q', question: 'why?' } : null,
        withdrawQueued: (id, entry) => removed.push(entry),
      });
      await start(host, 'first');
      const evaluating = host.evaluate('s');
      await entered.promise;
      assert.equal(host.stop('s').ok, true);
      sent.resolve({ ok: true, queued: true, entry: { id: 'e1' }, duplicate });
      await evaluating;
      await tick();
      assert.deepEqual(removed, duplicate ? [] : ['e1']);
    });
  }
}
test('failed persistence restores the previous live state before timers or notices change', async () => {
  const record = {}, marker = new Error('disk full');
  let fail = false;
  const { host, events } = supervisor(native, {
    getRecord: () => record,
    persistState: (id, next) => { record.unattended = next; if (fail) throw marker; },
  });
  await start(host, 'first');
  const state = record.unattended, stats = host.stats(), size = events.length;
  fail = true;
  assert.equal(host.stop('s').code, 'persist_failed');
  assert.equal(record.unattended, state);
  assert.deepEqual(host.stats(), stats);
  assert.equal(events.length, size);
});
test('startup failure retains the exact rejection from a session port', async () => {
  const rejection = new Error('read failure');
  const { host } = supervisor(native, { listSessionIds: () => ['broken'],
    getRecord: () => { throw rejection; } });
  const result = await host.reconcileStartup();
  assert.deepEqual(result.failedIds, ['broken']);
  assert.equal(result.failed[0].error, rejection);
});
