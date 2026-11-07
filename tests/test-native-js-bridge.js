'use strict';

// The napi bridge must move JavaScript values without the losses JSON inflicts:
// lone surrogates (in values and keys), NaN/Infinity/-0, undefined versus a
// missing key, array holes, Buffers, Dates and integer-like key order. Every
// assertion compares leaves with Object.is, so `-0` and `NaN` cannot pass by
// accident. A seeded corpus also pins `jsBridgeJsonView(x)` to the exact bytes
// of `JSON.stringify(x)`.

const assert = require('node:assert/strict');
const test = require('node:test');

const { getNative } = require('../src/native/runtime');

const native = getNative();

function leafSame(actual, expected) {
  if (Object.is(actual, expected)) return true;
  if (Buffer.isBuffer(actual) && Buffer.isBuffer(expected)) {
    return actual.equals(expected);
  }
  if (actual instanceof Date && expected instanceof Date) {
    return Object.is(actual.getTime(), expected.getTime());
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) return false;
    for (let index = 0; index < actual.length; index += 1) {
      if (!leafSame(actual[index], expected[index])) return false;
    }
    return true;
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object'
      && !Buffer.isBuffer(actual) && !Buffer.isBuffer(expected)) {
    const actualKeys = Object.keys(actual);
    const expectedKeys = Object.keys(expected);
    if (actualKeys.length !== expectedKeys.length) return false;
    for (let index = 0; index < actualKeys.length; index += 1) {
      if (actualKeys[index] !== expectedKeys[index]) return false;
      if (!leafSame(actual[actualKeys[index]], expected[expectedKeys[index]])) return false;
    }
    return true;
  }
  return false;
}

function assertRoundTrip(value, expected = value, message) {
  const actual = native.jsBridgeRoundTrip(value);
  assert.ok(leafSame(actual, expected), message || 'round trip mismatch');
}

test('round trip preserves every surprising leaf', () => {
  assertRoundTrip(NaN);
  assertRoundTrip(-0);
  assertRoundTrip(Infinity);
  assertRoundTrip(-Infinity);
  assertRoundTrip('\ud83d');
  assertRoundTrip('A\ud83dB');
  assertRoundTrip('😀 emoji \u{1F680}', '😀 emoji \u{1F680}');
  assertRoundTrip('中文段落 with \ud800 lone high');
  assertRoundTrip(undefined);
  assertRoundTrip(null);
  assertRoundTrip(true);
  assertRoundTrip(1.5);
});

test('round trip preserves object values, keys and order', () => {
  const input = {
    '\ud83d': 'lone surrogate key',
    'a\ud800b': 'lone surrogate inside a key',
    '😀': 'emoji key',
    undef: undefined,
    nan: NaN,
    negativeZero: -0,
    positiveInfinity: Infinity,
    negativeInfinity: -Infinity,
    buffer: Buffer.from([0, 1, 2, 255]),
    date: new Date(1_700_000_000_123),
    invalidDate: new Date(NaN),
  };
  const actual = native.jsBridgeRoundTrip(input);
  assert.equal(Object.keys(actual)[0], '\ud83d');
  assert.ok(Object.keys(actual).includes('a\ud800b'));
  assert.ok(Object.keys(actual).includes('😀'));
  assert.ok('undef' in actual);
  assert.equal(actual.undef, undefined);
  assert.ok(Object.is(actual.nan, NaN));
  assert.ok(Object.is(actual.negativeZero, -0));
  assert.ok(Object.is(actual.positiveInfinity, Infinity));
  assert.ok(Object.is(actual.negativeInfinity, -Infinity));
  assert.ok(Buffer.isBuffer(actual.buffer));
  assert.deepEqual([...actual.buffer], [0, 1, 2, 255]);
  assert.ok(actual.date instanceof Date);
  assert.equal(actual.date.getTime(), 1_700_000_000_123);
  assert.ok(actual.invalidDate instanceof Date);
  assert.ok(Number.isNaN(actual.invalidDate.getTime()));
});

test('round trip keeps integer-like key order and array holes', () => {
  const ordered = { b: 1, 2: 'two', 1: 'one' };
  const orderedOut = native.jsBridgeRoundTrip(ordered);
  assert.deepEqual(Object.keys(ordered), Object.keys(orderedOut));
  assert.deepEqual(Object.keys(orderedOut), ['1', '2', 'b']);

  const holey = [1, , 3];
  const holeyOut = native.jsBridgeRoundTrip(holey);
  assert.equal(holeyOut.length, 3);
  assert.equal(holeyOut[1], undefined);
  assert.ok(1 in holeyOut);

  const nested = [undefined, [undefined], { a: undefined }];
  assertRoundTrip(nested, [undefined, [undefined], { a: undefined }]);
});

test('round trip reads getters once and honors toJSON', () => {
  let reads = 0;
  const withGetter = {
    get value() {
      reads += 1;
      return 'read';
    },
  };
  const out = native.jsBridgeRoundTrip(withGetter);
  assert.equal(reads, 1);
  assert.deepEqual(out, { value: 'read' });

  const withToJson = {
    keep: 'dropped',
    toJSON() {
      return { replaced: true, when: 42 };
    },
  };
  assert.deepEqual(native.jsBridgeRoundTrip(withToJson), { replaced: true, when: 42 });

  const arrayToJson = { list: [{ toJSON: () => 'x' }, { toJSON: () => null }] };
  assert.deepEqual(native.jsBridgeRoundTrip(arrayToJson).list, ['x', null]);
});

test('round trip survives deep nesting', () => {
  let value = 0;
  for (let index = 0; index < 500; index += 1) value = [value];
  const out = native.jsBridgeRoundTrip(value);
  let cursor = out;
  let depth = 0;
  while (Array.isArray(cursor)) {
    depth += 1;
    cursor = cursor[0];
  }
  assert.equal(depth, 500);
  assert.equal(cursor, 0);
});

test('Uint8Array becomes a Buffer with the same bytes', () => {
  const out = native.jsBridgeRoundTrip(new Uint8Array([9, 8, 7]));
  assert.ok(Buffer.isBuffer(out));
  assert.deepEqual([...out], [9, 8, 7]);
});

test('cycles and BigInt throw TypeError', () => {
  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  assert.throws(() => native.jsBridgeRoundTrip(cyclic), (error) => (
    error instanceof TypeError && /circular/i.test(error.message)
  ));

  const list = [];
  list.push(list);
  assert.throws(() => native.jsBridgeRoundTrip(list), TypeError);

  assert.throws(() => native.jsBridgeRoundTrip({ big: 10n }), TypeError);
  assert.throws(() => native.jsBridgeRoundTrip(10n), TypeError);
});

// Deterministic PRNG (mulberry32).
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function makeValue(next, depth) {
  const choice = next();
  if (depth > 4 || choice < 0.35) {
    const leaf = next();
    if (leaf < 0.1) return null;
    if (leaf < 0.18) return undefined;
    if (leaf < 0.3) return next() < 0.5;
    if (leaf < 0.55) {
      const numbers = [0, -0, 1, -1, 0.1, 1e21, 1e-7, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER];
      return numbers[Math.floor(next() * numbers.length)];
    }
    if (leaf < 0.65) return Buffer.from(Array.from({ length: Math.floor(next() * 4) }, () => Math.floor(next() * 256)));
    if (leaf < 0.72) return new Date(Math.floor(next() * 2_000_000_000));
    const fragments = ['plain', '中文', '😀', '\ud800', '\udfff', 'a"b\\c\n\t', '\u2028', '\u0001', '"', '/'];
    let text = '';
    const count = Math.floor(next() * 4);
    for (let index = 0; index < count; index += 1) {
      text += fragments[Math.floor(next() * fragments.length)];
    }
    return text;
  }
  if (choice < 0.6) {
    const items = [];
    const count = Math.floor(next() * 4);
    for (let index = 0; index < count; index += 1) items.push(makeValue(next, depth + 1));
    return items;
  }
  const object = {};
  const count = Math.floor(next() * 4);
  for (let index = 0; index < count; index += 1) {
    const keys = ['a', 'b', '2', '1', '\ud83d', '😀', '中', 'x"y'];
    object[keys[Math.floor(next() * keys.length)]] = makeValue(next, depth + 1);
  }
  return object;
}

test('jsBridgeJsonView matches JSON.stringify byte for byte', () => {
  const next = random(0x5EED);
  for (let index = 0; index < 3000; index += 1) {
    const value = makeValue(next, 0);
    const expected = JSON.stringify(value);
    const actual = native.jsBridgeJsonView(value);
    assert.equal(actual, expected, `case ${index}`);
  }
});

test('jsBridgeJsonView matches JSON.stringify for explicit shapes', () => {
  const custom = { a: 1, toJSON: () => ({ replaced: [1, 2] }) };
  assert.equal(native.jsBridgeJsonView(custom), JSON.stringify(custom));
  assert.equal(native.jsBridgeJsonView(undefined), JSON.stringify(undefined));
  assert.equal(native.jsBridgeJsonView(-0), JSON.stringify(-0));
  assert.equal(native.jsBridgeJsonView('\ud83d'), JSON.stringify('\ud83d'));
  assert.equal(native.jsBridgeJsonView({ '\ud83d': 1 }), JSON.stringify({ '\ud83d': 1 }));
});
