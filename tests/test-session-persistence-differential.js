'use strict';

// Differential gate for the native session persistence adapter (former
// src/session/persistence.js). Every scenario runs once against the frozen
// legacy oracle and once against the native port, each on its own fresh record
// table and native owner, and the two normalized transcripts must be equal.
// Owner methods are stubbed through instance properties so statuses the real
// owner never emits (unexpected, Symbol, non-string) still reach the adapter.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const legacyPath = path.resolve(__dirname, '../src/session/persistence.js');
const legacyModule = new Module(legacyPath, module);
legacyModule.filename = legacyPath;
legacyModule.paths = Module._nodeModulePaths(path.dirname(legacyPath));
legacyModule._compile(fs.readFileSync(path.join(__dirname, 'helpers/legacy-session-persistence.js'), 'utf8'), legacyPath);
const legacy = legacyModule.exports;
const runtime = require('../src/native/binding');
const { recordsOf } = require('./helpers/session-records');
const { sessionRecordsOwner } = require('../src/session/records');

const impls = {
  legacy: { create: legacy.createSessionPersistence, PersistenceError: legacy.PersistenceError },
  native: { create: runtime.createSessionPersistence, PersistenceError: runtime.PersistenceError },
};

function plain(value, depth = 0) {
  if (value === undefined) return { undefined: true };
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') return { function: value.name, length: value.length };
    if (typeof value === 'bigint') return { bigint: String(value) };
    if (typeof value === 'symbol') return { symbol: String(value) };
    return value;
  }
  if (depth > 4) return { deep: true };
  if (Array.isArray(value)) return value.map(item => plain(item, depth + 1));
  const out = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    // Failure records carry a wall-clock stamp; it must be a valid ISO time,
    // its value differs between the two runs by construction.
    if (key === 'at' && typeof item === 'string') {
      assert.ok(Number.isFinite(Date.parse(item)), 'failure timestamp is an ISO time');
      out[key] = '<iso-time>';
    } else {
      out[key] = plain(item, depth + 1);
    }
  }
  return out;
}

function shape(impl, error) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return { primitive: plain(error) };
  }
  const own = Object.getOwnPropertyNames(error);
  return {
    ctor: error.constructor && error.constructor.name,
    isPersistenceError: error instanceof impl.PersistenceError,
    isError: error instanceof Error,
    name: error.name,
    message: error.message,
    code: error.code,
    status: error.status,
    source: plain(error.source),
    own,
    hasCause: Object.prototype.hasOwnProperty.call(error, 'cause'),
    cause: Object.prototype.hasOwnProperty.call(error, 'cause') ? shape(impl, error.cause) : undefined,
    text: String(error),
  };
}

function attempt(impl, fn) {
  try {
    return { ok: true, value: plain(fn()) };
  } catch (error) {
    return { ok: false, error: shape(impl, error) };
  }
}

async function attemptAsync(impl, fn) {
  try {
    return { ok: true, value: plain(await fn()) };
  } catch (error) {
    return { ok: false, error: shape(impl, error) };
  }
}
// Dotted paths where two transcripts differ, so a failure names its cause
// instead of dumping both documents.
function diffPaths(left, right, path = '$', out = []) {
  if (Object.is(left, right)) return out;
  const bothObjects = left && right && typeof left === 'object' && typeof right === 'object';
  if (!bothObjects) {
    out.push(`${path}: legacy=${JSON.stringify(left)} native=${JSON.stringify(right)}`);
    return out;
  }
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (!(key in left) || !(key in right)) {
      out.push(`${path}.${key}: present only in ${key in left ? 'legacy' : 'native'}`);
    } else {
      diffPaths(left[key], right[key], `${path}.${key}`, out);
    }
  }
  return out;
}

// Run the scenario on both implementations and require identical transcripts.
async function both(scenario) {
  const expected = await scenario(impls.legacy);
  const actual = await scenario(impls.native);
  const differences = diffPaths(expected, actual);
  assert.deepStrictEqual(differences, [], `legacy vs native differ:\n${differences.join('\n')}`);
  assert.deepStrictEqual(actual, expected);
  return expected;
}

function table() {
  return recordsOf([
    ['s1', { id: 's1', label: 'before', nested: { value: 1 } }],
    ['s2', { id: 's2', label: 'second' }],
  ]);
}

function liveRecords(records) {
  return JSON.parse(JSON.stringify([...records.entries()]));
}

test('PersistenceError class surface matches the legacy class', async () => {
  const expected = await both(async impl => {
    const E = impl.PersistenceError;
    const prototypeConstructor = Object.getOwnPropertyDescriptor(E.prototype, 'constructor');
    const out = {
      name: E.name,
      prototypeWritable: Object.getOwnPropertyDescriptor(E, 'prototype').writable,
      primitivePrototype: (() => { function NewTarget() {} NewTarget.prototype = 5; return Object.getPrototypeOf(Reflect.construct(E, ['child'], NewTarget)) === Error.prototype; })(),
      subclass: (() => {
        class Child extends E {}
        const value = new Child('child');
        return { instance: value instanceof Child, prototype: Object.getPrototypeOf(value) === Child.prototype };
      })(),
      length: E.length,
      typeofClass: typeof E,
      extendsError: Object.getPrototypeOf(E) === Error,
      protoChain: Object.getPrototypeOf(E.prototype) === Error.prototype,
      ctorDescriptor: {
        sameCtor: prototypeConstructor.value === E,
        writable: prototypeConstructor.writable,
        enumerable: prototypeConstructor.enumerable,
        configurable: prototypeConstructor.configurable,
      },
      bare: shape(impl, new E('m')),
      withSource: shape(impl, new E('m', { source: 'http.x' })),
      withNullSource: shape(impl, new E('m', { source: null })),
      withUndefinedSource: shape(impl, new E('m', { source: undefined })),
      withCause: shape(impl, new E('m', { source: 's', cause: new RangeError('why') })),
      falsyCauseZero: shape(impl, new E('m', { cause: 0 })),
      falsyCauseEmpty: shape(impl, new E('m', { cause: '' })),
      truthyPrimitiveCause: shape(impl, new E('m', { cause: 'text' })),
      noMessage: shape(impl, new E()),
      numericMessage: shape(impl, new E(42, { source: 7 })),
      objectMessage: shape(impl, new E({ toString() { return 'obj'; } })),
      nullOptions: attempt(impl, () => new E('m', null)),
      primitiveOptions: shape(impl, new E('m', 5)),
      stringOptions: shape(impl, new E('m', 'abc')),
      throwsWithoutNew: attempt(impl, () => E('m')),
      getterOrder: (() => {
        const trace = [];
        const options = {
          get source() { trace.push('source'); return 's'; },
          get cause() { trace.push('cause'); return undefined; },
        };
        const err = new E('m', options);
        return { trace, source: err.source };
      })(),
    };
    return out;
  });
  assert.equal(expected.name, 'PersistenceError');
  assert.equal(expected.length, 1);
  assert.equal(expected.bare.source, 'unknown');
  assert.equal(expected.nullOptions.ok, false);
  assert.equal(expected.throwsWithoutNew.ok, false);
  assert.equal(expected.withCause.hasCause, true);
  assert.equal(expected.falsyCauseZero.hasCause, false);
});

test('factory validation order and messages match the legacy guard chain', async () => {
  const expected = await both(async impl => {
    const plainMap = new Map([['s1', { id: 's1' }]]);
    const records = table();
    const store = { save() {} };
    const cases = {
      undefinedOptions: undefined,
      nullOptions: null,
      numberOptions: 5,
      stringOptions: 'x',
      emptyOptions: {},
      plainObjectRecords: { records: {}, store },
      arrayRecords: { records: [], store },
      foreignMap: { records: plainMap, store },
      noStoreNoFile: { records },
      emptyFile: { records, file: '' },
      numericFile: { records, file: 5 },
      nullStore: { records, store: null },
      falsyStore: { records, store: 0 },
      storeWithoutSave: { records, store: {} },
      storeSaveNotFunction: { records, store: { save: 'x' } },
      storeAsFunction: { records, store: Object.assign(() => {}, { save() {} }) },
      storeWithFileToo: { records, store, file: '' },
      fileOk: { records, file: '/tmp/never-written.json' },
    };
    const out = {};
    for (const [name, options] of Object.entries(cases)) {
      out[name] = attempt(impl, () => {
        const service = impl.create(options);
        return Object.keys(service);
      });
    }
    out.noArguments = attempt(impl, () => Object.keys(impl.create()));
    return out;
  });
  assert.match(expected.nullOptions.error.message, /Cannot destructure property 'records'/);
  assert.equal(expected.foreignMap.error.message, 'session persistence requires the native session record owner');
  assert.equal(expected.plainObjectRecords.error.message, 'session persistence requires a records Map');
  assert.equal(expected.emptyFile.error.message, 'session persistence requires a durable file');
  assert.equal(expected.storeWithoutSave.error.message, 'session persistence requires store.save');
  assert.deepEqual(expected.fileOk.value, ['begin', 'mutate', 'bestEffort', 'status', 'stop']);
});

test('option getters are read once, in declaration order, before any validation', async () => {
  const expected = await both(async impl => {
    const outcomes = [];
    for (const variant of ['invalid-records', 'valid-store', 'valid-file']) {
      const records = variant === 'invalid-records' ? {} : table();
      const trace = [];
      const spy = (key, value) => ({
        get [key]() { trace.push(key); return value; },
      });
      const options = Object.defineProperties({}, {
        ...Object.getOwnPropertyDescriptors(spy('records', records)),
        ...Object.getOwnPropertyDescriptors(spy('store', variant === 'valid-store' ? { save() {} } : undefined)),
        ...Object.getOwnPropertyDescriptors(spy('file', variant === 'valid-file' ? '/tmp/x.json' : undefined)),
        ...Object.getOwnPropertyDescriptors(spy('kind', undefined)),
        ...Object.getOwnPropertyDescriptors(spy('root', undefined)),
        ...Object.getOwnPropertyDescriptors(spy('onFailure', undefined)),
        ...Object.getOwnPropertyDescriptors(spy('onState', undefined)),
        ...Object.getOwnPropertyDescriptors(spy('retryDelayMs', undefined)),
        ...Object.getOwnPropertyDescriptors(spy('maxRetries', undefined)),
        ...Object.getOwnPropertyDescriptors(spy('setTimeoutFn', undefined)),
        ...Object.getOwnPropertyDescriptors(spy('clearTimeoutFn', undefined)),
      });
      const result = attempt(impl, () => Object.keys(impl.create(options)));
      outcomes.push({ variant, trace, result });
    }
    return outcomes;
  });
  assert.equal(expected[0].trace.length, 11);
  assert.equal(expected[0].result.ok, false);
  assert.equal(expected[1].result.ok, true);
  assert.equal(expected[0].trace[0], 'records');
  assert.equal(expected[0].trace[10], 'clearTimeoutFn');
});

test('ports handed to the native owner keep their order, identity, defaults and arity', async () => {
  const expected = await both(async impl => {
    const out = {};
    const storeSaves = [];
    const store = {
      saveCalls: 0,
      save(value) { this.saveCalls += 1; storeSaves.push({ self: this === store, value }); return 'saved'; },
    };
    const onFailure = () => {};
    const onState = () => {};
    const setTimeoutFn = () => ({ unref() {} });
    const clearTimeoutFn = () => {};
    const variants = {
      storeDefaults: { store },
      storeExplicit: { store, onFailure, onState, retryDelayMs: 9, maxRetries: 0, setTimeoutFn, clearTimeoutFn },
      storeFalsyRetry: { store, retryDelayMs: null, maxRetries: null },
      fileDefaults: { file: '/tmp/s.json' },
      fileExplicit: { file: '/tmp/s.json', kind: 'dirs', root: '/tmp/root' },
      fileEmptyRoot: { file: '/tmp/s.json', root: '' },
      fileNonStringRoot: { file: '/tmp/s.json', root: 5 },
      fileNullKind: { file: '/tmp/s.json', kind: null },
    };
    for (const [name, extra] of Object.entries(variants)) {
      const records = table();
      const owner = sessionRecordsOwner(records);
      const captured = [];
      const realConfigure = owner.configure;
      owner.configure = function configure(ports) {
        captured.push(ports);
        return realConfigure.call(this, ports);
      };
      impl.create({ records, ...extra });
      const ports = captured[0];
      const retryTrace = [];
      owner.retryTick = function retryTick() { retryTrace.push(this === owner); return 'tick'; };
      const description = {
        calls: captured.length,
        keys: Object.keys(ports),
        stringifyIsJson: ports.stringify === JSON.stringify,
        onFailureIsGiven: ports.onFailure === onFailure,
        onStateIsGiven: ports.onState === onState,
        setTimeoutIsGiven: ports.setTimeout === setTimeoutFn,
        setTimeoutIsGlobal: ports.setTimeout === setTimeout,
        clearTimeoutIsGiven: ports.clearTimeout === clearTimeoutFn,
        clearTimeoutIsGlobal: ports.clearTimeout === clearTimeout,
        defaultOnFailure: { name: ports.onFailure.name, length: ports.onFailure.length, result: ports.onFailure({}) },
        defaultOnState: { name: ports.onState.name, length: ports.onState.length, result: ports.onState({}) },
        retryTick: { name: ports.retryTick.name, length: ports.retryTick.length, result: ports.retryTick(), trace: retryTrace },
        retryDelayMs: plain(ports.retryDelayMs),
        maxRetries: plain(ports.maxRetries),
        file: plain(ports.file),
        kind: plain(ports.kind),
        root: plain(ports.root),
        hasStoreSave: 'storeSave' in ports,
      };
      if (ports.storeSave) {
        description.storeSave = {
          name: ports.storeSave.name,
          length: ports.storeSave.length,
          result: ports.storeSave('payload'),
          noArgument: ports.storeSave(),
        };
      }
      out[name] = description;
    }
    out.storeSaves = storeSaves;
    return out;
  });
  assert.deepEqual(expected.storeDefaults.keys, [
    'stringify', 'onFailure', 'onState', 'setTimeout', 'clearTimeout',
    'retryTick', 'retryDelayMs', 'maxRetries', 'storeSave',
  ]);
  assert.deepEqual(expected.fileExplicit.keys, [
    'stringify', 'onFailure', 'onState', 'setTimeout', 'clearTimeout',
    'retryTick', 'retryDelayMs', 'maxRetries', 'file', 'kind', 'root',
  ]);
  assert.equal(expected.storeDefaults.retryDelayMs, 250);
  assert.equal(expected.storeFalsyRetry.retryDelayMs, null);
  assert.equal(expected.fileEmptyRoot.keys.includes('root'), false);
  assert.equal(expected.fileNullKind.kind, null);
  assert.equal(expected.storeSaves.length, 6);
});

test('store.save is looked up per call, bound to the store, and read once at validation', async () => {
  const expected = await both(async impl => {
    const trace = [];
    const store = {
      get save() {
        trace.push('read-save');
        const self = this;
        return function save(value) { trace.push(['save', this === self, value.length]); };
      },
    };
    const records = table();
    const service = impl.create({ records, store });
    const afterCreate = trace.splice(0);
    service.mutate('http.one', map => { map.get('s1').label = 'x'; });
    service.mutate('http.two', map => { map.get('s2').label = 'y'; });
    return { afterCreate, trace };
  });
  assert.deepEqual(expected.afterCreate, ['read-save']);
  assert.equal(expected.trace.filter(item => item === 'read-save').length, 2);
});

test('mutate returns the mutator value, saves detached snapshots and commits memory', async () => {
  const expected = await both(async impl => {
    const writes = [];
    const records = table();
    const service = impl.create({ records, store: { save: value => writes.push(value) } });
    const results = [];
    results.push(attempt(impl, () => service.mutate('http.patch', map => {
      map.get('s1').label = 'after';
      return { committed: true };
    })));
    results.push(attempt(impl, () => service.mutate('http.undefined-result', () => {})));
    results.push(attempt(impl, () => service.mutate('http.delete', map => map.delete('s2'))));
    results.push(attempt(impl, () => service.mutate('http.create', map => { map.set('s3', { id: 's3' }); return map.size; })));
    records.get('s1').label = 'later-memory-change';
    return { results, writes, final: liveRecords(records), status: plain(service.status()) };
  });
  assert.equal(expected.results[0].value.committed, true);
  assert.equal(expected.writes[0][0][1] === undefined ? expected.writes[0][0].label : expected.writes[0][0][1].label, 'after');
  assert.equal(expected.status.dirty, false);
});

test('mutate rejects non-function mutators before touching the owner', async () => {
  const expected = await both(async impl => {
    const records = table();
    const owner = sessionRecordsOwner(records);
    const calls = [];
    const real = owner.mutate;
    owner.mutate = function mutate(...args) { calls.push(args.length); return real.apply(this, args); };
    const service = impl.create({ records, store: { save() {} } });
    const out = {};
    for (const [name, mutator] of Object.entries({
      missing: undefined, nullish: null, string: 'x', object: {}, number: 3,
    })) {
      out[name] = attempt(impl, () => service.mutate('http.bad', mutator));
    }
    out.noArguments = attempt(impl, () => service.mutate());
    out.ownerCalls = calls;
    return out;
  });
  assert.equal(expected.missing.error.message, 'session persistence mutate requires a function');
  assert.deepEqual(expected.ownerCalls, []);
});

test('mutate failure classes: required, mutator, snapshot, async and nested', async () => {
  const expected = await both(async impl => {
    const out = {};
    // required: the store rejects the atomic save, the owner rolls back
    {
      const records = table();
      const failures = [];
      const states = [];
      const service = impl.create({
        records,
        store: { save() { throw new Error('injected EIO'); } },
        onFailure: event => failures.push(plain(event)),
        onState: state => states.push(plain(state)),
      });
      out.required = attempt(impl, () => service.mutate('http.required', map => { map.get('s1').label = 'changed'; }));
      out.requiredUnknownSource = attempt(impl, () => service.mutate(undefined, map => { map.delete('s1'); }));
      out.requiredNumericSource = attempt(impl, () => service.mutate(7, map => { map.delete('s1'); }));
      out.requiredNullSource = attempt(impl, () => service.mutate(null, map => { map.delete('s1'); }));
      out.requiredState = { records: liveRecords(records), failures, states, status: plain(service.status()) };
    }
    // mutator throws: raw error, no save attempt
    {
      const records = table();
      let saves = 0;
      const service = impl.create({ records, store: { save() { saves += 1; } } });
      const raw = new RangeError('validation failed');
      out.mutatorThrow = attempt(impl, () => service.mutate('http.validation', map => {
        map.get('s1').nested.value = 2;
        throw raw;
      }));
      out.mutatorThrowString = attempt(impl, () => service.mutate('http.validation', () => { throw 'plain string'; }));
      out.mutatorThrowNull = attempt(impl, () => service.mutate('http.validation', () => { throw null; }));
      out.mutatorState = { saves, nested: records.get('s1').nested.value };
    }
    // snapshot: a record JSON cannot serialize
    {
      const circular = { id: 's9' };
      circular.self = circular;
      const records = recordsOf([['s9', circular]]);
      const service = impl.create({ records, store: { save() {} } });
      out.snapshotCircular = attempt(impl, () => service.mutate('http.snapshot', () => 1));
      const big = recordsOf([['s8', { id: 's8', n: 10n }]]);
      const bigService = impl.create({ records: big, store: { save() {} } });
      out.snapshotBigInt = attempt(impl, () => bigService.mutate('http.snapshot', () => 1));
    }
    // async mutator
    {
      const records = table();
      const service = impl.create({ records, store: { save() {} } });
      let settled;
      out.asyncMutator = attempt(impl, () => service.mutate('http.async', map => {
        map.get('s1').label = 'async-change';
        settled = Promise.resolve('late');
        return settled;
      }));
      if (settled) await settled;
      out.asyncRolledBack = records.get('s1').label;
      out.thenableMutator = attempt(impl, () => service.mutate('http.thenable', () => ({ then() {} })));
    }
    // nested
    {
      const records = table();
      const service = impl.create({ records, store: { save() {} } });
      out.nestedMutateInMutate = attempt(impl, () => service.mutate('outer', () => service.mutate('inner', () => 1)));
      out.nestedBeginInMutate = attempt(impl, () => service.mutate('outer2', () => service.begin('inner2')));
      const caught = [];
      out.nestedCaught = attempt(impl, () => service.mutate('outer3', () => {
        try { service.mutate(undefined, () => 1); } catch (error) { caught.push(shape(impl, error)); }
        return 'survived';
      }));
      out.nestedCaughtErrors = caught;
      out.afterNested = attempt(impl, () => service.mutate('after', () => 'usable'));
    }
    return out;
  });
  assert.equal(expected.required.error.message, 'session state could not be persisted');
  assert.equal(expected.required.error.cause.message, 'injected EIO');
  // The real owner takes `source: String`, so non-string sources fail inside it,
  // identically on both sides, before the adapter's own fallback is reachable.
  for (const name of ['requiredUnknownSource', 'requiredNumericSource', 'requiredNullSource']) {
    assert.equal(expected[name].error.code, 'StringExpected', name);
    assert.equal(expected[name].error.isPersistenceError, false, name);
  }
  assert.equal(expected.mutatorThrow.error.name, 'RangeError');
  assert.equal(expected.mutatorThrowString.error.primitive, 'plain string');
  assert.equal(expected.asyncMutator.error.message, 'session persistence mutator must be synchronous');
  assert.equal(expected.asyncRolledBack, 'before');
  assert.equal(expected.nestedMutateInMutate.error.message, 'nested session persistence mutation');
  assert.equal(expected.nestedMutateInMutate.error.source, 'inner');
  assert.equal(expected.nestedCaughtErrors[0].code, 'StringExpected');
  assert.equal(expected.afterNested.value, 'usable');
  assert.equal(expected.snapshotCircular.ok, false);
});

test('mutate statuses the real owner never emits still classify like the legacy switch', async () => {
  const expected = await both(async impl => {
    const out = {};
    const statuses = {
      ok: { status: 'ok', value: { v: 1 } },
      okUndefined: { status: 'ok' },
      nested: { status: 'nested' },
      async: { status: 'async' },
      snapshot: { status: 'snapshot', error: new TypeError('snap') },
      mutator: { status: 'mutator', error: new SyntaxError('mut') },
      mutatorPrimitive: { status: 'mutator', error: 'raw' },
      required: { status: 'required', error: new Error('why') },
      requiredNoError: { status: 'required' },
      unexpected: { status: 'weird' },
      unexpectedNumber: { status: 5 },
      unexpectedUndefined: { status: undefined },
      unexpectedNull: { status: null },
      unexpectedObject: { status: { toString() { return 'obj'; } } },
      unexpectedSymbol: { status: Symbol('s') },
      caseSensitive: { status: 'OK' },
    };
    for (const [name, outcome] of Object.entries(statuses)) {
      const records = table();
      const owner = sessionRecordsOwner(records);
      const seen = [];
      owner.mutate = function mutate(...args) {
        seen.push({ self: this === owner, count: args.length, source: args[0], recordsOk: args[1] === records, mutatorOk: typeof args[2] === 'function' });
        return outcome;
      };
      const service = impl.create({ records, store: { save() {} } });
      out[name] = { result: attempt(impl, () => service.mutate(`src.${name}`, () => 1)), seen };
    }
    return out;
  });
  assert.equal(expected.unexpected.result.error.message, 'session persistence returned unexpected status weird');
  assert.equal(expected.unexpected.result.error.source, 'unknown');
  assert.equal(expected.unexpectedObject.result.error.message, 'session persistence returned unexpected status obj');
  assert.equal(expected.unexpectedSymbol.result.error.message, 'Cannot convert a Symbol value to a string');
  assert.equal(expected.okUndefined.result.value.undefined, true);
  assert.equal(expected.requiredNoError.result.error.hasCause, false);
});

test('a stubbed owner exposes the adapter source fallback: undefined selects unknown, null and numbers pass through', async () => {
  const expected = await both(async impl => {
    const out = {};
    const sources = { undefinedSource: undefined, nullSource: null, numeric: 7, text: 'http.x', empty: '' };
    for (const [name, source] of Object.entries(sources)) {
      const records = table();
      const owner = sessionRecordsOwner(records);
      owner.mutate = () => ({ status: 'required', error: new Error('why') });
      let commitStatus = 'closed';
      owner.begin = () => ({ status: 'ok', token: 3 });
      owner.commit = () => ({ status: commitStatus, error: new Error('cwhy') });
      const service = impl.create({ records, store: { save() {} } });
      owner.begin = () => ({ status: 'nested' });
      const nested = attempt(impl, () => service.begin(source));
      owner.begin = () => ({ status: 'ok', token: 3 });
      const tx = service.begin(source);
      const closed = attempt(impl, () => tx.commit());
      const closedAgain = attempt(impl, () => tx.commit());
      commitStatus = 'required';
      const tx2 = service.begin(source);
      const required = attempt(impl, () => tx2.commit());
      out[name] = {
        mutateRequired: attempt(impl, () => service.mutate(source, () => 1)),
        nested, closed, closedAgain, required,
      };
    }
    return out;
  });
  assert.equal(expected.undefinedSource.mutateRequired.error.source, 'unknown');
  assert.equal(expected.undefinedSource.closedAgain.error.source, 'unknown');
  assert.equal(expected.nullSource.mutateRequired.error.source, null);
  assert.equal(expected.numeric.nested.error.source, 7);
  assert.equal(expected.empty.required.error.source, '');
});

test('manual transactions: commit, rollback, reuse and failure behavior', async () => {
  const expected = await both(async impl => {
    const out = {};
    const records = table();
    const writes = [];
    let failNext = false;
    const service = impl.create({
      records,
      store: { save(value) { if (failNext) throw new Error('commit EIO'); writes.push(value.length); } },
    });
    const tx = service.begin('http.patch');
    out.shape = {
      keys: Object.keys(tx),
      frozen: Object.isFrozen(tx),
      commit: { name: tx.commit.name, length: tx.commit.length },
      rollback: { name: tx.rollback.name, length: tx.rollback.length },
    };
    records.get('s1').label = 'in-tx';
    out.commit = attempt(impl, () => tx.commit());
    out.commitAgain = attempt(impl, () => tx.commit());
    out.rollbackAfterCommit = attempt(impl, () => tx.rollback());
    out.afterCommit = { label: records.get('s1').label, writes: writes.length };

    const rolled = service.begin('http.rolled');
    records.get('s1').label = 'discard-me';
    out.rollback = attempt(impl, () => rolled.rollback());
    out.rollbackAgain = attempt(impl, () => rolled.rollback());
    out.commitAfterRollback = attempt(impl, () => rolled.commit());
    out.afterRollback = { label: records.get('s1').label, writes: writes.length };

    // `begin()` without a source reaches the real owner, which rejects it.
    out.unnamedBegin = attempt(impl, () => service.begin());

    const nestedOuter = service.begin('outer');
    out.beginInBegin = attempt(impl, () => service.begin('inner'));
    out.mutateInBegin = attempt(impl, () => service.mutate('inner-mutate', () => 1));
    out.nestedOuterRollback = attempt(impl, () => nestedOuter.rollback());
    out.afterNested = attempt(impl, () => service.mutate('after', () => 'usable'));

    failNext = true;
    const failing = service.begin('http.failing');
    records.get('s1').label = 'will-fail';
    out.commitFails = attempt(impl, () => failing.commit());
    out.commitFailsAgain = attempt(impl, () => failing.commit());
    failNext = false;
    out.afterFailure = { label: records.get('s1').label, status: plain(service.status()), records: liveRecords(records) };

    return out;
  });
  assert.deepEqual(expected.shape.keys, ['commit', 'rollback']);
  assert.equal(expected.shape.frozen, true);
  assert.equal(expected.commitAgain.error.message, 'session persistence transaction is closed');
  assert.equal(expected.commitAgain.error.source, 'http.patch');
  assert.equal(expected.unnamedBegin.error.code, 'StringExpected');
  assert.equal(expected.beginInBegin.error.message, 'nested session persistence mutation');
  assert.equal(expected.commitFails.error.message, 'session state could not be persisted');
  assert.equal(expected.commitFails.error.cause.message, 'commit EIO');
});

test('begin and commit statuses the real owner never emits classify like the legacy chain', async () => {
  const expected = await both(async impl => {
    const out = {};
    const beginOutcomes = {
      ok: { status: 'ok', token: 11 },
      okNoToken: { status: 'ok' },
      nested: { status: 'nested' },
      snapshot: { status: 'snapshot', error: new TypeError('snap') },
      weird: { status: 'weird' },
      symbol: { status: Symbol('b') },
      missing: {},
    };
    for (const [name, opened] of Object.entries(beginOutcomes)) {
      const records = table();
      const owner = sessionRecordsOwner(records);
      const seen = [];
      owner.begin = function begin(...args) { seen.push({ self: this === owner, args }); return opened; };
      const service = impl.create({ records, store: { save() {} } });
      out[name] = { result: attempt(impl, () => Object.keys(service.begin(`b.${name}`))), seen: plain(seen) };
    }
    const commitOutcomes = {
      ok: { status: 'ok' },
      required: { status: 'required', error: new Error('why') },
      closed: { status: 'closed' },
      nested: { status: 'nested' },
      empty: {},
      symbol: { status: Symbol('c') },
    };
    for (const [name, outcome] of Object.entries(commitOutcomes)) {
      const records = table();
      const owner = sessionRecordsOwner(records);
      const seen = [];
      owner.begin = function begin() { return { status: 'ok', token: 77 }; };
      owner.commit = function commit(...args) { seen.push({ self: this === owner, args }); return outcome; };
      owner.rollback = function rollback(...args) { seen.push({ rollback: args }); };
      const service = impl.create({ records, store: { save() {} } });
      const tx = service.begin(`c.${name}`);
      out[`commit_${name}`] = {
        result: attempt(impl, () => tx.commit()),
        again: attempt(impl, () => tx.commit()),
        rollback: attempt(impl, () => tx.rollback()),
        seen: plain(seen),
      };
    }
    {
      const records = table();
      const owner = sessionRecordsOwner(records);
      const seen = [];
      owner.begin = function begin() { return { status: 'ok', token: 5 }; };
      owner.rollback = function rollback(...args) { seen.push({ self: this === owner, args }); return 'ignored'; };
      const service = impl.create({ records, store: { save() {} } });
      const tx = service.begin('r');
      out.rollbackArgs = { first: attempt(impl, () => tx.rollback()), second: attempt(impl, () => tx.rollback()), seen: plain(seen) };
    }
    return out;
  });
  assert.equal(expected.weird.result.error.message, 'session persistence returned unexpected status weird');
  assert.equal(expected.symbol.result.error.message, 'Cannot convert a Symbol value to a string');
  assert.equal(expected.nested.result.error.source, 'b.nested');
  assert.equal(expected.commit_closed.result.error.message, 'session persistence transaction is closed');
  assert.equal(expected.commit_required.result.error.cause.message, 'why');
  assert.equal(expected.rollbackArgs.seen.length, 1);
});

test('bestEffort defaults its source, forwards the owner result and retries within the bound', async () => {
  const expected = await both(async impl => {
    const out = {};
    {
      const records = table();
      const owner = sessionRecordsOwner(records);
      const seen = [];
      owner.bestEffort = function bestEffort(...args) { seen.push({ self: this === owner, args: plain(args) }); return 'owner-result'; };
      const service = impl.create({ records, store: { save() {} } });
      out.defaults = {
        none: attempt(impl, () => service.bestEffort()),
        undef: attempt(impl, () => service.bestEffort(undefined)),
        nullSource: attempt(impl, () => service.bestEffort(null)),
        named: attempt(impl, () => service.bestEffort('timer.x')),
        extra: attempt(impl, () => service.bestEffort('a', 'b')),
        seen,
        length: service.bestEffort.length,
      };
    }
    {
      const records = table();
      const scheduled = [];
      const cleared = [];
      const failures = [];
      const states = [];
      let saves = 0;
      const service = impl.create({
        records,
        store: { save() { saves += 1; throw new Error('disk unavailable'); } },
        onFailure: event => failures.push(plain(event)),
        onState: state => states.push(plain(state)),
        setTimeoutFn: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
        clearTimeoutFn: handle => cleared.push(typeof handle),
        maxRetries: 2,
        retryDelayMs: 17,
      });
      records.get('s1').label = 'dirty';
      const first = service.bestEffort('timer.capture');
      const afterFirst = { first, scheduled: scheduled.length, delay: scheduled[0] && scheduled[0].delay, status: plain(service.status()) };
      scheduled.shift().callback();
      scheduled.shift().callback();
      const exhausted = { scheduled: scheduled.length, saves, status: plain(service.status()) };
      service.stop();
      out.retry = { afterFirst, exhausted, failures, states, cleared, stopStatus: plain(service.status()) };
    }
    return out;
  });
  assert.deepEqual(expected.defaults.seen[0].args, ['runtime']);
  assert.deepEqual(expected.defaults.seen[1].args, ['runtime']);
  assert.deepEqual(expected.defaults.seen[2].args, [null]);
  assert.equal(expected.defaults.length, 0);
  assert.equal(expected.retry.exhausted.saves, 3);
  assert.equal(expected.retry.afterFirst.delay, 17);
});

test('status snapshots are frozen copies and keep the legacy falsy passthrough', async () => {
  const expected = await both(async impl => {
    const out = {};
    const records = table();
    const owner = sessionRecordsOwner(records);
    const failure = { mode: 'required', attempt: 0, nested: { keep: 1 } };
    const variants = {
      object: { dirty: true, retryAttempt: 2, retryScheduled: true, lastFailure: failure },
      nullFailure: { dirty: false, retryAttempt: 0, retryScheduled: false, lastFailure: null },
      undefinedFailure: { dirty: false, retryAttempt: 0, retryScheduled: false },
      zeroFailure: { dirty: 1, retryAttempt: '3', retryScheduled: 0, lastFailure: 0 },
      emptyStringFailure: { dirty: 'x', retryAttempt: null, retryScheduled: undefined, lastFailure: '' },
      stringFailure: { dirty: false, retryAttempt: 0, retryScheduled: false, lastFailure: 'boom' },
      arrayFailure: { dirty: false, retryAttempt: 0, retryScheduled: false, lastFailure: ['a', 'b'] },
      extraKeys: { dirty: false, retryAttempt: 0, retryScheduled: false, lastFailure: null, extra: 'dropped' },
    };
    let current;
    owner.status = function status() { return current; };
    const service = impl.create({ records, store: { save() {} } });
    for (const [name, snapshot] of Object.entries(variants)) {
      current = snapshot;
      const result = service.status();
      out[name] = {
        value: plain(result),
        keys: Object.keys(result),
        frozen: Object.isFrozen(result),
        failureIsCopy: result.lastFailure && typeof result.lastFailure === 'object'
          ? result.lastFailure !== snapshot.lastFailure && Object.isFrozen(result.lastFailure) === false
          : null,
        nestedShared: result.lastFailure && result.lastFailure.nested
          ? result.lastFailure.nested === failure.nested
          : null,
      };
    }
    const trace = [];
    current = {
      get dirty() { trace.push('dirty'); return true; },
      get retryAttempt() { trace.push('retryAttempt'); return 1; },
      get retryScheduled() { trace.push('retryScheduled'); return false; },
      get lastFailure() {
        trace.push('lastFailure');
        return { get a() { trace.push('a'); return 1; }, get b() { trace.push('b'); return 2; } };
      },
    };
    out.readOrder = { value: plain(service.status()), trace };
    return out;
  });
  assert.equal(expected.object.failureIsCopy, true);
  assert.equal(expected.object.nestedShared, true);
  assert.equal(expected.zeroFailure.value.lastFailure, 0);
  assert.equal(expected.extraKeys.keys.length, 4);
  // `snapshot.lastFailure && { ...snapshot.lastFailure }` reads the property twice.
  assert.deepEqual(expected.readOrder.trace, ['dirty', 'retryAttempt', 'retryScheduled', 'lastFailure', 'lastFailure', 'a', 'b']);
});

test('stop forwards to the owner with its receiver and returns undefined', async () => {
  const expected = await both(async impl => {
    const records = table();
    const owner = sessionRecordsOwner(records);
    const seen = [];
    owner.stop = function stop(...args) { seen.push({ self: this === owner, args: args.length }); return 'ignored'; };
    const service = impl.create({ records, store: { save() {} } });
    const result = attempt(impl, () => service.stop('extra'));
    const throwing = (() => {
      owner.stop = function stop() { throw new URIError('stop failed'); };
      return attempt(impl, () => service.stop());
    })();
    return { result, seen, throwing, shape: { keys: Object.keys(service), frozen: Object.isFrozen(service), lengths: Object.values(service).map(fn => fn.length), names: Object.values(service).map(fn => fn.name) } };
  });
  assert.equal(expected.result.value.undefined, true);
  assert.deepEqual(expected.seen, [{ self: true, args: 0 }]);
  assert.equal(expected.throwing.error.name, 'URIError');
  assert.deepEqual(expected.shape.lengths, [1, 2, 0, 0, 0]);
});

test('a throwing owner method propagates its error untouched through every entry point', async () => {
  const expected = await both(async impl => {
    const out = {};
    for (const method of ['mutate', 'begin', 'bestEffort', 'status', 'stop']) {
      const records = table();
      const owner = sessionRecordsOwner(records);
      const boom = new EvalError(`owner ${method} failed`);
      owner[method] = function failing() { throw boom; };
      const service = impl.create({ records, store: { save() {} } });
      const args = method === 'mutate' ? ['s', () => 1] : method === 'begin' ? ['s'] : [];
      out[method] = attempt(impl, () => service[method](...args));
    }
    {
      const records = table();
      const owner = sessionRecordsOwner(records);
      owner.begin = () => ({ status: 'ok', token: 1 });
      owner.commit = () => { throw new EvalError('owner commit failed'); };
      owner.rollback = () => { throw new EvalError('owner rollback failed'); };
      const service = impl.create({ records, store: { save() {} } });
      const tx = service.begin('t');
      out.commit = attempt(impl, () => tx.commit());
      out.commitAfter = attempt(impl, () => tx.commit());
      const tx2 = service.begin('t2');
      out.rollback = attempt(impl, () => tx2.rollback());
      out.rollbackAfter = attempt(impl, () => tx2.rollback());
    }
    return out;
  });
  assert.equal(expected.mutate.error.name, 'EvalError');
  assert.equal(expected.commit.error.name, 'EvalError');
  assert.equal(expected.commitAfter.error.message, 'session persistence transaction is closed');
  assert.equal(expected.rollbackAfter.ok, true);
});

test('real owner end-to-end: required save failure rolls back and a later success flushes dirty state', async () => {
  const expected = await both(async impl => {
    const records = table();
    let fail = true;
    const writes = [];
    const service = impl.create({
      records,
      store: { save(value) { if (fail) throw new Error('temporary'); writes.push(value); } },
      setTimeoutFn: () => ({ unref() {} }),
      clearTimeoutFn: () => {},
    });
    records.get('s1').label = 'runtime-change';
    const runtime = service.bestEffort('runtime');
    const dirty = plain(service.status());
    fail = false;
    const flushed = attempt(impl, () => service.mutate('http.patch', map => { map.get('s1').nested.value = 5; return 'saved'; }));
    return { runtime, dirty, flushed, status: plain(service.status()), last: writes.at(-1) };
  });
  assert.equal(expected.runtime, false);
  assert.equal(expected.dirty.dirty, true);
  assert.equal(expected.status.dirty, false);
});


test('jsonClone matches the frozen export for values, getters, and exceptions', () => {
  for (const make of [
    () => undefined, () => null, () => ({ a: [1, null, { b: 'ok' }] }),
    () => ({ get field() { return 7; } }), () => BigInt(1),
    () => ({ get field() { throw new RangeError('clone getter'); } }),
  ]) {
    const capture = fn => {
      try { return { value: fn(make()) }; } catch (error) { return { name: error.name, message: error.message }; }
    };
    assert.deepEqual(capture(runtime.jsonClone), capture(legacy.jsonClone));
  }
});

test('native service and transaction callbacks retain live state without leaking cycles', () => {
  const { spawnSync } = require('node:child_process');
  const script = `
    const assert = require('node:assert/strict');
    const native = require(process.env.MULTICC_RUST_ADDON);
    const tick = () => new Promise(resolve => setImmediate(resolve));
    async function collect() { for (let i = 0; i < 20; i++) { await tick(); global.gc(); } await tick(); }
    (async () => {
      let weakOwner, weakToken, serviceMethod, commit;
      (() => {
        let token = {};
        const owner = { configure(ports) { this.ports = ports; }, begin() { return {status:'ok', token}; },
          commit(received) { assert.equal(received, token); return {status:'ok'}; }, status() { return {dirty:false}; } };
        weakOwner = new WeakRef(owner); weakToken = new WeakRef(token);
        const service = native.sessionPersistenceCreate(() => owner, {records:new Map(), store:{save(){}}});
        serviceMethod = service.status;
        commit = service.begin('test').commit;
      })();
      await collect();
      assert.ok(weakOwner.deref()); assert.ok(weakToken.deref());
      assert.equal(serviceMethod().dirty, false);
      serviceMethod = null;
      await collect();
      commit(); commit = null;
      await collect();
      assert.equal(weakOwner.deref(), undefined); assert.equal(weakToken.deref(), undefined);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ['--expose-gc', '-e', script], {
    env: { ...process.env, MULTICC_RUST_ADDON: runtime.addonPath() }, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout || String(child.error));
});
