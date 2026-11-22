'use strict';
// Differential test: the retired `src/session/hibernation-reclaimer.js`
// (frozen under tests/helpers/) against the Rust port
// `sessionHibernationReclaimerCreate`. Both sides run the same scenarios and
// every observable trace — getter order, iterator close, coercion counts,
// error identity and microtask outcomes — must match byte-for-byte.
const test = require('node:test');
const assert = require('node:assert/strict');
const implementations = [
  require('./helpers/legacy-hibernation-reclaimer'),
  { createHibernationReclaimer: deps => require('../src/native/runtime').getNative().sessionHibernationReclaimerCreate(deps) },
];

function makeRecord(id, extra = {}) {
  return { id, dirId: 'dir', kind: 'chat', ...extra };
}

function fixture(implementation, { records = [], batchSize = 16, idleMs = 1000, ports = {} } = {}) {
  const trace = [];
  const map = new Map(records.map(record => [record.id, record]));
  const factory = implementation.createHibernationReclaimer({
    records: map,
    now: ports.now || (() => { trace.push('now'); return 5000; }),
    idleMs,
    batchSize,
    eligible: ports.eligible || ((record, options) => {
      trace.push(`eligible:${record && record.id}:${options.nowMs}:${options.idleMs}`);
      return { eligible: true, lastWorkMs: 4000, reasons: [] };
    }),
    hibernate: ports.hibernate || (async (id, options) => {
      trace.push(`hibernate:${id}:${options.eligibilityChecked}:${options.ignoreIdle}:${options.idleMs}`);
      return { ok: true, hibernated: true };
    }),
    publish: ports.publish || ((...args) => { trace.push(`publish:${args.join(':')}`); }),
    isStopped: ports.isStopped || (() => { trace.push('isStopped'); return false; }),
  });
  return { factory, trace, map };
}

test('facade shape: frozen, key order, arity', () => {
  for (const implementation of implementations) {
    const { factory } = fixture(implementation);
    assert.equal(Object.isFrozen(factory), true);
    assert.deepEqual(Object.keys(factory), ['candidatesFor', 'pendingCapacity', 'reclaimForCapacity', 'runCandidates', 'settleCapacity']);
    assert.equal(factory.candidatesFor.length, 0);
    assert.equal(factory.pendingCapacity.length, 0);
    assert.equal(factory.reclaimForCapacity.length, 0);
    assert.equal(factory.runCandidates.length, 1);
    assert.equal(factory.settleCapacity.length, 0);
    assert.equal(factory.pendingCapacity(), 0);
  }
});

test('factory destructures eight ports in order without validation', () => {
  const traces = [];
  for (const implementation of implementations) {
    const trace = [];
    const backing = { records: new Map(), now() {}, idleMs: 1, batchSize: 2, eligible() {}, hibernate() {}, publish() {}, isStopped() {} };
    const proxy = new Proxy(backing, { get(target, key, receiver) { trace.push(String(key)); return Reflect.get(target, key, receiver); } });
    implementation.createHibernationReclaimer(proxy);
    traces.push(trace);
  }
  assert.deepEqual(traces[1], traces[0]);
  assert.deepEqual(traces[0], ['records', 'now', 'idleMs', 'batchSize', 'eligible', 'hibernate', 'publish', 'isStopped']);
  for (const implementation of implementations) {
    assert.throws(() => implementation.createHibernationReclaimer(), { name: 'TypeError', message: "Cannot destructure property 'records' of 'undefined' as it is undefined." });
    assert.throws(() => implementation.createHibernationReclaimer(null), { name: 'TypeError', message: "Cannot destructure property 'records' of 'object null' as it is null." });
    // Primitives wrap: every port reads as undefined and nothing throws.
    implementation.createHibernationReclaimer(42);
    const marker = Error('getter');
    assert.throws(() => implementation.createHibernationReclaimer(Object.defineProperty({}, 'records', { get() { throw marker; } })), error => error === marker);
  }
});

test('candidatesFor selects, filters, sorts and reads in legacy order', () => {
  const outcomes = [];
  for (const implementation of implementations) {
    const records = [
      makeRecord('b', { lastWorkMs: undefined }),
      makeRecord('a'),
      makeRecord('c'),
      makeRecord('d', { dirId: 'other' }),
    ];
    const { factory, trace } = fixture(implementation, {
      records,
      ports: {
        eligible(record, options) {
          trace.push(`eligible:${record.id}:${options.nowMs}:${options.idleMs}`);
          const lastWorkMs = { a: 100, b: 50, c: 100 }[record.id];
          return { eligible: record.id !== 'c', lastWorkMs, reasons: ['idle'] };
        },
      },
    });
    const candidates = factory.candidatesFor({ dirId: 'dir', excludeSessionIds: ['b'] });
    outcomes.push({ ids: candidates.map(entry => entry.record.id), trace, shape: candidates.map(entry => Object.keys(entry)) });
  }
  assert.deepEqual(outcomes[1], outcomes[0]);
  assert.deepEqual(outcomes[0].ids, ['a']);
  assert.deepEqual(outcomes[0].shape, [['record', 'lastWorkMs']]);
});

test('candidatesFor ties break by localeCompare of record.id', () => {
  for (const implementation of implementations) {
    const records = [makeRecord('z'), makeRecord('a'), makeRecord('m')];
    const { factory } = fixture(implementation, {
      records,
      ports: { eligible: () => ({ eligible: true, lastWorkMs: 7, reasons: [] }) },
    });
    assert.deepEqual(factory.candidatesFor().map(entry => entry.record.id), ['a', 'm', 'z']);
  }
});

test('candidatesFor option destructuring, defaults and null message', () => {
  for (const implementation of implementations) {
    const { factory } = fixture(implementation);
    assert.throws(() => factory.candidatesFor(null), { name: 'TypeError', message: "Cannot read properties of null (reading 'dirId')" });
    assert.deepEqual(factory.candidatesFor(42), []);
    assert.deepEqual(factory.candidatesFor(), []);
    assert.deepEqual(factory.candidatesFor({}), []);
  }
});

test('idleMs override coerces twice when accepted and once when rejected', () => {
  const outcomes = [];
  for (const implementation of implementations) {
    const trace = [];
    let coercions = 0;
    const override = { valueOf() { coercions += 1; trace.push('valueOf'); return '250'; } };
    const { factory } = fixture(implementation, {
      records: [makeRecord('x')],
      ports: {
        eligible(record, options) { trace.push(`idle:${options.idleMs}`); return { eligible: false, lastWorkMs: 0, reasons: [] }; },
      },
    });
    factory.candidatesFor({ idleMs: override });
    outcomes.push({ coercions, trace });
  }
  assert.deepEqual(outcomes[1], outcomes[0]);
  assert.deepEqual(outcomes[0], { coercions: 2, trace: ['valueOf', 'valueOf', 'idle:250'] });
  // A non-finite override falls back to the factory idleMs after one coercion.
  for (const implementation of implementations) {
    const seen = [];
    let coercions = 0;
    const override = { valueOf() { coercions += 1; return 'not-a-number'; } };
    const { factory } = fixture(implementation, {
      records: [makeRecord('x')], idleMs: 777,
      ports: { eligible: (record, options) => { seen.push(options.idleMs); return { eligible: true, lastWorkMs: 0, reasons: [] }; } },
    });
    factory.candidatesFor({ idleMs: override });
    assert.equal(coercions, 1);
    assert.deepEqual(seen, [777]);
    // A throwing coercion propagates before any record is visited.
    const marker = Error('coerce');
    const bad = { valueOf() { throw marker; } };
    assert.throws(() => factory.candidatesFor({ idleMs: bad }), error => error === marker);
  }
});

test('excluded set wraps scalars and matches ids strictly', () => {
  for (const implementation of implementations) {
    const records = [makeRecord('a'), makeRecord('b'), makeRecord('c')];
    const { factory } = fixture(implementation, {
      records,
      ports: { eligible: () => ({ eligible: true, lastWorkMs: 1, reasons: [] }) },
    });
    assert.deepEqual(factory.candidatesFor({ excludeSessionIds: 'a' }).map(entry => entry.record.id), ['b', 'c']);
    assert.deepEqual(factory.candidatesFor({ excludeSessionIds: ['a', 'c'] }).map(entry => entry.record.id), ['b']);
    assert.deepEqual(factory.candidatesFor({ excludeSessionIds: 42 }).length, 3);
  }
});

test('skip publish gates short-circuit and read in legacy order', () => {
  const traces = [];
  for (const implementation of implementations) {
    const trace = [];
    const record = {
      get dirId() { trace.push('get:dirId'); return 'dir'; },
      get id() { trace.push('get:id'); return 'x'; },
      get taskBoundTaskId() { trace.push('get:taskBound'); return 'task-1'; },
      get kind() { trace.push('get:kind'); return 'chat'; },
    };
    const verdict = {
      get eligible() { trace.push('get:eligible'); return false; },
      get reasons() { trace.push('get:reasons'); return ['too-recent']; },
    };
    const { factory } = fixture(implementation, {
      records: [record],
      ports: {
        now: () => { trace.push('now'); return 0; },
        eligible: () => verdict,
        publish: (...args) => { trace.push(`publish:${args.join('|')}`); },
      },
    });
    factory.candidatesFor({ reportSkips: true });
    traces.push(trace);
  }
  assert.deepEqual(traces[1], traces[0]);
  // dirId defaults to null so the dirId filter short-circuits without reading
  // the record; the two leading id reads are the Map construction and the
  // excluded-set probe, and now() runs once before eligible.
  assert.deepEqual(traces[0], ['get:id', 'get:id', 'now', 'get:eligible', 'get:taskBound', 'get:kind', 'get:id', 'get:reasons', 'publish:sweep|skip|x|too-recent']);
  // reportSkips false suppresses the record reads entirely.
  for (const implementation of implementations) {
    const trace = [];
    const record = { get taskBoundTaskId() { trace.push('taskBound'); return 't'; } };
    const { factory } = fixture(implementation, {
      records: [record],
      ports: { eligible: () => ({ eligible: false, lastWorkMs: 0, reasons: [] }) },
    });
    factory.candidatesFor({ reportSkips: false });
    assert.deepEqual(trace, []);
    // Capacity path default: ignoreIdle true suppresses skip events too.
    factory.candidatesFor({ ignoreIdle: true });
    assert.deepEqual(trace, []);
  }
});

test('skip publish uses the ineligible fallback and non-chat kinds stay silent', () => {
  for (const implementation of implementations) {
    const published = [];
    const records = [
      makeRecord('plain', { taskBoundTaskId: 't' }),
      makeRecord('taskless', {}),
      makeRecord('aux', { taskBoundTaskId: 't', kind: 'aux' }),
    ];
    const { factory } = fixture(implementation, {
      records,
      ports: {
        eligible: () => ({ eligible: false, lastWorkMs: 0, reasons: [] }),
        publish: (...args) => published.push(args),
      },
    });
    factory.candidatesFor();
    assert.deepEqual(published, [['sweep', 'skip', 'plain', 'ineligible']]);
  }
});

test('candidatesFor iterator protocol: close on body throw, none on next throw', () => {
  const outcomes = [];
  for (const implementation of implementations) {
    const trace = [];
    const marker = Error('body');
    let closed = 0;
    const iterable = {
      [Symbol.iterator]() {
        return {
          next() { trace.push('next'); return { done: false, value: makeRecord('x') }; },
          return() { closed += 1; trace.push('return'); return {}; },
        };
      },
    };
    const { factory } = fixture(implementation, {
      ports: {
        eligible() { throw marker; },
      },
    });
    // Override records port with the tracked iterable by rebuilding.
    const factory2 = implementation.createHibernationReclaimer({
      records: { values: () => iterable },
      now: () => 0, idleMs: 1, batchSize: 1,
      eligible() { throw marker; },
      hibernate() {}, publish() {}, isStopped() {},
    });
    let caught;
    try { factory2.candidatesFor(); } catch (error) { caught = error; }
    outcomes.push({ identity: caught === marker, closed, trace });
  }
  assert.deepEqual(outcomes[1], outcomes[0]);
  assert.deepEqual(outcomes[0], { identity: true, closed: 1, trace: ['next', 'return'] });
  // A throwing next() propagates without closing.
  for (const implementation of implementations) {
    const marker = Error('next-failure');
    let closed = 0;
    const iterable = {
      [Symbol.iterator]() {
        return { next() { throw marker; }, return() { closed += 1; return {}; } };
      },
    };
    const factory = implementation.createHibernationReclaimer({
      records: { values: () => iterable },
      now: () => 0, idleMs: 1, batchSize: 1, eligible() {}, hibernate() {}, publish() {}, isStopped() {},
    });
    assert.throws(() => factory.candidatesFor(), error => error === marker);
    assert.equal(closed, 0);
    // records.values missing: exact TypeError.
    const noValues = implementation.createHibernationReclaimer({
      records: {}, now() {}, idleMs: 1, batchSize: 1, eligible() {}, hibernate() {}, publish() {}, isStopped() {},
    });
    assert.throws(() => noValues.candidatesFor(), { name: 'TypeError', message: 'records.values is not a function or its return value is not iterable' });
  }
});

test('candidatesFor malformed iterables and sort comparator edges match', () => {
  const HEAD = 'records.values is not a function or its return value is not iterable';
  const scenarios = [
    { records: { values: () => null }, name: 'TypeError', message: HEAD },
    { records: { values: () => ({}) }, name: 'TypeError', message: HEAD },
    { records: { values: () => 42 }, name: 'TypeError', message: HEAD },
    { records: { values: () => ({ [Symbol.iterator]: 1 }) }, name: 'TypeError', message: HEAD },
    { records: null, name: 'TypeError', message: "Cannot read properties of null (reading 'values')" },
    { records: { values: () => ({ [Symbol.iterator]() { return 1; } }) }, name: 'TypeError', message: 'Result of the Symbol.iterator method is not an object' },
    { records: { values: () => ({ [Symbol.iterator]() { return { next: 1 }; } }) }, name: 'TypeError', message: 'number 1 is not a function' },
    { records: { values: () => ({ [Symbol.iterator]() { return { next() { return 42; } }; } }) }, name: 'TypeError', message: 'Iterator result 42 is not an object' },
    { records: { values: () => ({ [Symbol.iterator]() { return { next() { return null; } }; } }) }, name: 'TypeError', message: 'Iterator result null is not an object' },
  ];
  for (const scenario of scenarios) {
    for (const implementation of implementations) {
      const factory = implementation.createHibernationReclaimer({
        now() {}, idleMs: 1, batchSize: 1, eligible() {}, hibernate() {}, publish() {}, isStopped() {},
        ...scenario,
      });
      assert.throws(() => factory.candidatesFor(), { name: scenario.name, message: scenario.message });
    }
  }
  // BigInt differences: equal BigInts fall through to localeCompare; unequal
  // BigInts reach V8 sort and fail ToNumber exactly like the legacy code.
  for (const implementation of implementations) {
    const equal = fixture(implementation, {
      records: [makeRecord('b'), makeRecord('a')],
      ports: { eligible: () => ({ eligible: true, lastWorkMs: 5n, reasons: [] }) },
    });
    assert.deepEqual(equal.factory.candidatesFor().map(entry => entry.record.id), ['a', 'b']);
    const unequal = fixture(implementation, {
      records: [makeRecord('b'), makeRecord('a')],
      ports: { eligible: record => ({ eligible: true, lastWorkMs: record.id === 'a' ? 1n : 2n, reasons: [] }) },
    });
    assert.throws(() => unequal.factory.candidatesFor(), { name: 'TypeError', message: 'Cannot convert a BigInt value to a number' });
    const mixed = fixture(implementation, {
      records: [makeRecord('b'), makeRecord('a')],
      ports: { eligible: record => ({ eligible: true, lastWorkMs: record.id === 'a' ? 1n : 2, reasons: [] }) },
    });
    assert.throws(() => mixed.factory.candidatesFor(), { name: 'TypeError', message: 'Cannot mix BigInt and other types, use explicit conversions' });
  }
});

test('runCandidates counts outcomes and stops at the success budget', async () => {
  const outcomes = [];
  for (const implementation of implementations) {
    const trace = [];
    const plan = {
      a: { ok: true, hibernated: true },
      b: { ok: false, skipped: true },
      c: { ok: true, hibernated: true },
      d: { ok: false, already: true },
    };
    const { factory } = fixture(implementation, {
      batchSize: 3,
      ports: {
        hibernate: async id => { trace.push(`hibernate:${id}`); return plan[id]; },
      },
    });
    const candidates = ['a', 'b', 'c', 'd'].map(id => ({ record: { id }, lastWorkMs: 0 }));
    const result = await factory.runCandidates(candidates, { limit: 3 });
    outcomes.push({ result, trace, keys: Object.keys(result) });
  }
  assert.deepEqual(outcomes[1], outcomes[0]);
  assert.deepEqual(outcomes[0].result, { attempted: 4, hibernated: 2, failed: 0, skipped: 2 });
  assert.deepEqual(outcomes[0].keys, ['attempted', 'hibernated', 'failed', 'skipped']);
  // limit reached: the loop breaks before attempting the next candidate.
  for (const implementation of implementations) {
    const trace = [];
    const { factory } = fixture(implementation, {
      ports: { hibernate: async id => { trace.push(id); return { ok: true, hibernated: true }; } },
    });
    const candidates = ['a', 'b', 'c'].map(id => ({ record: { id }, lastWorkMs: 0 }));
    const result = await factory.runCandidates(candidates, { limit: 2 });
    assert.deepEqual(result, { attempted: 2, hibernated: 2, failed: 0, skipped: 0 });
    assert.deepEqual(trace, ['a', 'b']);
  }
});

test('runCandidates default limit comes from the factory batchSize', async () => {
  for (const implementation of implementations) {
    const trace = [];
    const { factory } = fixture(implementation, {
      batchSize: 2,
      ports: { hibernate: async id => { trace.push(id); return { ok: true, hibernated: true }; } },
    });
    const candidates = ['a', 'b', 'c'].map(id => ({ record: { id }, lastWorkMs: 0 }));
    const result = await factory.runCandidates(candidates);
    assert.deepEqual(result, { attempted: 2, hibernated: 2, failed: 0, skipped: 0 });
    assert.deepEqual(trace, ['a', 'b']);
  }
});

test('runCandidates hibernate options and failures keep legacy shape', async () => {
  const outcomes = [];
  for (const implementation of implementations) {
    const trace = [];
    const { factory } = fixture(implementation, {
      ports: {
        hibernate: async (id, options) => {
          trace.push(`${id}:${Object.keys(options).join(',')}:${options.eligibilityChecked}:${options.ignoreIdle}:${options.idleMs}`);
          if (id === 'boom') throw Error('ignored');
          if (id === 'weird') return 42;
          if (id === 'null-result') return null;
          return { ok: false };
        },
      },
    });
    const candidates = ['boom', 'weird', 'fine'].map(id => ({ record: { id }, lastWorkMs: 0 }));
    const result = await factory.runCandidates(candidates, { ignoreIdle: true, idleMs: 42 });
    outcomes.push({ result, trace: trace.slice() });
    // Classification reads result.ok directly: a null result is an abrupt
    // body completion and rejects the run instead of counting as failed.
    await assert.rejects(
      factory.runCandidates([{ record: { id: 'null-result' } }], { limit: 1 }),
      { name: 'TypeError', message: "Cannot read properties of null (reading 'ok')" },
    );
  }
  assert.deepEqual(outcomes[1], outcomes[0]);
  assert.deepEqual(outcomes[0].result, { attempted: 3, hibernated: 0, failed: 3, skipped: 0 });
  assert.deepEqual(outcomes[0].trace, [
    'boom:eligibilityChecked,ignoreIdle,idleMs:true:true:42',
    'weird:eligibilityChecked,ignoreIdle,idleMs:true:true:42',
    'fine:eligibilityChecked,ignoreIdle,idleMs:true:true:42',
  ]);
});

test('runCandidates rejects (never throws sync) on binding and iterator errors', async () => {
  for (const implementation of implementations) {
    const { factory } = fixture(implementation);
    await assert.rejects(factory.runCandidates(null), { name: 'TypeError', message: 'candidates is not iterable' });
    await assert.rejects(factory.runCandidates([{ record: { id: 'x' } }], null), { name: 'TypeError', message: "Cannot read properties of null (reading 'limit')" });
    const primitive = factory.runCandidates([], 42);
    await assert.doesNotReject(primitive);
    assert.deepEqual(await factory.runCandidates([]), { attempted: 0, hibernated: 0, failed: 0, skipped: 0 });
  }
});

test('runCandidates argument reads stay inside the legacy try', async () => {
  for (const implementation of implementations) {
    const trace = [];
    const { factory } = fixture(implementation, {
      ports: { hibernate: async id => { trace.push(`call:${id}`); return { ok: true, hibernated: true }; } },
    });
    const broken = {
      get record() { trace.push('get:record'); throw Error('ignored'); },
    };
    const idless = { record: { get id() { trace.push('get:id'); throw Error('ignored'); } } };
    const result = await factory.runCandidates([broken, idless, null, { record: { id: 'ok' } }], { limit: 4 });
    assert.deepEqual(result, { attempted: 4, hibernated: 1, failed: 3, skipped: 0 });
    assert.deepEqual(trace, ['get:record', 'get:id', 'call:ok']);
  }
});

test('runCandidates classification getters close the iterator and reject', async () => {
  const outcomes = [];
  for (const implementation of implementations) {
    const trace = [];
    const marker = Error('ok-getter');
    let closed = 0;
    const iterable = {
      [Symbol.iterator]() {
        let index = 0;
        const values = [{ record: { id: 'x' } }, { record: { id: 'y' } }];
        return {
          next() { trace.push('next'); const value = values[index]; index += 1; return value ? { done: false, value } : { done: true }; },
          return() { closed += 1; trace.push('return'); return {}; },
        };
      },
    };
    const { factory } = fixture(implementation, {
      ports: {
        hibernate: async () => ({ get ok() { trace.push('get:ok'); throw marker; } }),
      },
    });
    let caught;
    try { await factory.runCandidates(iterable, { limit: 2 }); } catch (error) { caught = error; }
    outcomes.push({ identity: caught === marker, closed, trace });
  }
  assert.deepEqual(outcomes[1], outcomes[0]);
  assert.deepEqual(outcomes[0], { identity: true, closed: 1, trace: ['next', 'get:ok', 'return'] });
});

test('runCandidates break closes the iterator and close errors propagate', async () => {
  const outcomes = [];
  for (const implementation of implementations) {
    const trace = [];
    const marker = Error('close-failure');
    const iterable = {
      [Symbol.iterator]() {
        const values = [{ record: { id: 'a' } }, { record: { id: 'b' } }];
        let index = 0;
        return {
          next() { const value = values[index]; index += 1; return value ? { done: false, value } : { done: true }; },
          return() { trace.push('return'); throw marker; },
        };
      },
    };
    const { factory } = fixture(implementation, {
      ports: { hibernate: async () => ({ ok: true, hibernated: true }) },
    });
    let caught;
    try { await factory.runCandidates(iterable, { limit: 1 }); } catch (error) { caught = error; }
    outcomes.push({ identity: caught === marker, trace });
  }
  assert.deepEqual(outcomes[1], outcomes[0]);
  assert.deepEqual(outcomes[0], { identity: true, trace: ['return'] });
  // A plain (non-promise) hibernate return assimilates like await does.
  for (const implementation of implementations) {
    const { factory } = fixture(implementation, {
      ports: { hibernate: id => ({ ok: true, hibernated: true }) },
    });
    const result = await factory.runCandidates([{ record: { id: 'x' } }], { limit: 1 });
    assert.deepEqual(result, { attempted: 1, hibernated: 1, failed: 0, skipped: 0 });
  }
});

test('runCandidates awaits thenables through PromiseResolve assimilation', async () => {
  const outcomes = [];
  for (const implementation of implementations) {
    const trace = [];
    const { factory } = fixture(implementation, {
      ports: {
        hibernate: id => ({
          then(resolve) { trace.push(`thenable:${id}`); resolve({ ok: true, hibernated: true }); },
        }),
      },
    });
    const result = await factory.runCandidates([{ record: { id: 't' } }], { limit: 1 });
    outcomes.push({ result, trace });
  }
  assert.deepEqual(outcomes[1], outcomes[0]);
  assert.deepEqual(outcomes[0].result, { attempted: 1, hibernated: 1, failed: 0, skipped: 0 });
  assert.deepEqual(outcomes[0].trace, ['thenable:t']);
});

test('reclaimForCapacity requires a directory with the exact early shape', async () => {
  for (const implementation of implementations) {
    const { factory } = fixture(implementation);
    const result = await factory.reclaimForCapacity({});
    assert.deepEqual(result, { ok: false, code: 'directory_required', considered: 0, hibernated: 0 });
    assert.deepEqual(await factory.reclaimForCapacity(), { ok: false, code: 'directory_required', considered: 0, hibernated: 0 });
    assert.throws(() => factory.reclaimForCapacity(null), { name: 'TypeError', message: "Cannot destructure property 'dirId' of '(intermediate value)(intermediate value)(intermediate value)' as it is null." });
    assert.equal(factory.pendingCapacity(), 0);
  }
});

test('reclaimForCapacity stop probe short-circuits the body', async () => {
  const outcomes = [];
  for (const implementation of implementations) {
    const trace = [];
    const { factory } = fixture(implementation, {
      records: [makeRecord('x')],
      ports: { isStopped: () => { trace.push('isStopped'); return true; } },
    });
    const result = await factory.reclaimForCapacity({ dirId: 'dir' });
    outcomes.push({ result, trace });
  }
  assert.deepEqual(outcomes[1], outcomes[0]);
  assert.deepEqual(outcomes[0].result, { ok: false, code: 'hibernation_stopped', considered: 0, hibernated: 0 });
  assert.deepEqual(outcomes[0].trace, ['isStopped']);
});

test('reclaimForCapacity spreads run counters after considered', async () => {
  const outcomes = [];
  for (const implementation of implementations) {
    const trace = [];
    const { factory } = fixture(implementation, {
      records: [makeRecord('a'), makeRecord('b'), makeRecord('c')],
      ports: {
        eligible: record => ({ eligible: true, lastWorkMs: { a: 1, b: 2, c: 3 }[record.id], reasons: [] }),
        hibernate: async id => { trace.push(`hibernate:${id}`); return { ok: true, hibernated: true }; },
        isStopped: () => { trace.push('isStopped'); return false; },
      },
    });
    const result = await factory.reclaimForCapacity({ dirId: 'dir', count: 2 });
    outcomes.push({ result, trace, keys: Object.keys(result) });
  }
  assert.deepEqual(outcomes[1], outcomes[0]);
  assert.deepEqual(outcomes[0].result, { ok: true, considered: 3, attempted: 2, hibernated: 2, failed: 0, skipped: 0 });
  assert.deepEqual(outcomes[0].keys, ['ok', 'considered', 'attempted', 'hibernated', 'failed', 'skipped']);
  assert.deepEqual(outcomes[0].trace, ['isStopped', 'hibernate:a', 'hibernate:b']);
});

test('reclaimForCapacity count coerces once and clamps like the legacy code', async () => {
  const outcomes = [];
  for (const implementation of implementations) {
    let coercions = 0;
    const count = { valueOf() { coercions += 1; return 3; } };
    const { factory } = fixture(implementation, {
      records: ['a', 'b', 'c', 'd', 'e'].map(id => makeRecord(id)),
      ports: {
        eligible: record => ({ eligible: true, lastWorkMs: 0, reasons: [] }),
        hibernate: async () => ({ ok: true, hibernated: true }),
      },
    });
    const result = await factory.reclaimForCapacity({ dirId: 'dir', count });
    outcomes.push({ coercions, result });
  }
  assert.deepEqual(outcomes[1], outcomes[0]);
  assert.equal(outcomes[0].coercions, 1);
  assert.equal(outcomes[0].result.hibernated, 3);
  for (const implementation of implementations) {
    const { factory } = fixture(implementation, {
      records: ['a', 'b'].map(id => makeRecord(id)),
      ports: {
        eligible: () => ({ eligible: true, lastWorkMs: 0, reasons: [] }),
        hibernate: async () => ({ ok: true, hibernated: true }),
      },
    });
    assert.equal((await factory.reclaimForCapacity({ dirId: 'dir', count: 0 })).hibernated, 1);
  }
});

test('capacity runs serialize on the tail and pendingCapacity tracks them', async () => {
  const outcomes = [];
  for (const implementation of implementations) {
    const trace = [];
    const releases = [];
    const { factory } = fixture(implementation, {
      records: [makeRecord('a'), makeRecord('b')],
      ports: {
        eligible: record => ({ eligible: true, lastWorkMs: 0, reasons: [] }),
        hibernate: id => new Promise(resolve => { trace.push(`start:${id}`); releases.push(() => { trace.push(`release:${id}`); resolve({ ok: true, hibernated: true }); }); }),
        isStopped: () => { trace.push('isStopped'); return false; },
      },
    });
    const first = factory.reclaimForCapacity({ dirId: 'dir', count: 1 });
    const second = factory.reclaimForCapacity({ dirId: 'dir', count: 1 });
    assert.equal(factory.pendingCapacity(), 2);
    // Drain microtasks so the first body starts its hibernate call; the
    // second body must still be queued behind the tail.
    await new Promise(resolve => setImmediate(resolve));
    const beforeRelease = trace.slice();
    releases.shift()();
    const firstResult = await first;
    // The second body is queued behind the first run's settlement, so let
    // the chain reach its hibernate call before releasing it.
    await new Promise(resolve => setImmediate(resolve));
    releases.shift()();
    const secondResult = await second;
    assert.equal(factory.pendingCapacity(), 0);
    outcomes.push({ firstResult, secondResult, beforeRelease, trace });
  }
  assert.deepEqual(outcomes[1], outcomes[0]);
  assert.deepEqual(outcomes[0].beforeRelease, ['isStopped', 'start:a']);
  assert.deepEqual(outcomes[0].firstResult, { ok: true, considered: 2, attempted: 1, hibernated: 1, failed: 0, skipped: 0 });
  assert.deepEqual(outcomes[0].secondResult, { ok: true, considered: 2, attempted: 1, hibernated: 1, failed: 0, skipped: 0 });
});

test('settleCapacity exposes the tail and tracks every queued run', async () => {
  for (const implementation of implementations) {
    const { factory } = fixture(implementation, {
      records: [makeRecord('a')],
      ports: {
        eligible: () => ({ eligible: true, lastWorkMs: 0, reasons: [] }),
        hibernate: async () => ({ ok: true, hibernated: true }),
      },
    });
    const initialTail = factory.settleCapacity();
    const run = factory.reclaimForCapacity({ dirId: 'dir' });
    const nextTail = factory.settleCapacity();
    assert.notEqual(nextTail, initialTail);
    await run;
    await nextTail;
    assert.equal(factory.pendingCapacity(), 0);
    assert.equal(factory.settleCapacity(), nextTail);
  }
});

test('capacity failure keeps the tail settleable for later runs', async () => {
  for (const implementation of implementations) {
    const marker = Error('explode');
    let fail = true;
    const { factory } = fixture(implementation, {
      records: [makeRecord('a')],
      ports: {
        eligible: () => { if (fail) throw marker; return { eligible: true, lastWorkMs: 0, reasons: [] }; },
        hibernate: async () => ({ ok: true, hibernated: true }),
      },
    });
    await assert.rejects(factory.reclaimForCapacity({ dirId: 'dir' }), error => error === marker);
    assert.equal(factory.pendingCapacity(), 0);
    fail = false;
    const recovered = await factory.reclaimForCapacity({ dirId: 'dir' });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.hibernated, 1);
  }
});

test('global Promise is honored for the tail seed and early return', async () => {
  const Patched = class extends Promise {};
  const original = Promise;
  try {
    globalThis.Promise = Patched;
    for (const implementation of implementations) {
      const { factory } = fixture(implementation);
      assert.equal(factory.settleCapacity() instanceof Patched, true);
      const early = factory.reclaimForCapacity({});
      assert.equal(early instanceof Patched, true);
      const value = await early;
      assert.deepEqual(value, { ok: false, code: 'directory_required', considered: 0, hibernated: 0 });
    }
  } finally {
    globalThis.Promise = original;
  }
});
