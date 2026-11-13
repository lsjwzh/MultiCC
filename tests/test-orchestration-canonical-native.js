'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { getNative } = require('../src/native/runtime');
const { canonicalize } = require('../src/outbox');

test('native canonicalization matches live JavaScript array methods and exception identity', () => {
  const native = getNative();
  const custom = Object.assign([1, 2], { map: () => ({ join: () => 17 }) });
  assert.equal(native.waitCanonicalize(custom), canonicalize(custom));
  const sparse = [1, , 3];
  assert.equal(native.waitCanonicalize(sparse), canonicalize(sparse));
  const cycle = []; cycle.push(cycle);
  assert.throws(() => native.waitCanonicalize(cycle), /cannot contain cycles/);
  const sentinel = new Error('sentinel');
  const throwing = Object.assign([1], { map() { throw sentinel; } });
  assert.throws(() => native.waitCanonicalize(throwing), error => error === sentinel);
  let retained;
  const savesCallback = Object.assign([1], { map(fn) { retained = fn; return []; } });
  assert.equal(native.waitCanonicalize(savesCallback), '[]');
  assert.equal(retained({ a: 2 }), '{"a":2}');
});

test('object canonicalization respects dynamically overridden key map and join', () => {
  const native = getNative();
  const original = Array.prototype.map;
  const value = { b: 2, a: 1 };
  let retained;
  try {
    Array.prototype.map = function (callback, ...args) {
      if (this.length === 2 && this[0] === 'a' && this[1] === 'b') {
        retained = callback;
        return { join(separator) { return callback('b') + separator + callback('a'); } };
      }
      return Reflect.apply(original, this, [callback, ...args]);
    };
    const actual = native.orchestrationCanonicalize(value);
    const retainedNative = retained;
    assert.equal(actual, canonicalize(value));
    assert.equal(retainedNative('a'), '"a":1');
  } finally {
    Array.prototype.map = original;
  }
});

test('object canonicalization uses the dynamically returned sort result', () => {
  const native = getNative();
  const original = Array.prototype.sort;
  const value = { b: 2, a: 1 };
  let actual; let expected;
  try {
    Array.prototype.sort = function (...args) {
      if (this.length === 2 && this[0] === 'b' && this[1] === 'a') {
        return { map(callback) { return { join(separator) { return callback('a') + separator + callback('b'); } }; } };
      }
      return Reflect.apply(original, this, args);
    };
    actual = native.orchestrationCanonicalize(value);
    expected = canonicalize(value);
  } finally {
    Array.prototype.sort = original;
  }
  assert.equal(actual, expected);
});

test('canonicalization preserves isolated UTF-16 units returned by an overridden join', () => {
  const native = getNative();
  const value = Object.assign([1], { map: () => ({ join: () => '"\ud83d"' }) });
  const expected = canonicalize(value);
  const actual = native.orchestrationCanonicalize(value);
  assert.equal(actual, expected);
  assert.equal(actual.charCodeAt(2), 0xd83d);
});

test('overridden JSON.stringify results match JavaScript without crashing the process', () => {
  const { spawnSync } = require('node:child_process');
  const script = String.raw`
    const assert = require('node:assert/strict');
    const { getNative } = require('./src/native/runtime');
    const { canonicalize } = require('./src/outbox');
    const native = getNative();
    const original = JSON.stringify;
    const returnedObject = { toString() { return 'object-result'; } };
    const returnedSymbol = Symbol('result');
    const values = [undefined, 42, returnedObject, returnedSymbol];
    const inputs = [true, [true], { key: true }, null];
    const outcome = fn => {
      try { return { value: fn() }; } catch (error) { return { error }; }
    };
    try {
      for (const returned of values) {
        JSON.stringify = () => returned;
        for (const input of inputs) {
          const expected = outcome(() => canonicalize(input));
          for (const name of ['waitCanonicalize', 'orchestrationCanonicalize']) {
            const actual = outcome(() => native[name](input));
            if (expected.error) {
              assert.ok(actual.error, name + ' should throw');
              assert.equal(actual.error.constructor, expected.error.constructor);
            } else {
              assert.ifError(actual.error);
              assert.ok(Object.is(actual.value, expected.value), name + ' returned different value');
            }
          }
        }
      }
    } finally { JSON.stringify = original; }
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: process.cwd(), encoding: 'utf8', env: process.env });
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
});
