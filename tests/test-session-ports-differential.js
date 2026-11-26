'use strict';

// Differential: the retired `src/session/ports.js` validators (frozen as
// tests/helpers/legacy-session-ports.js) versus the Rust owner behind
// `getNative().sessionAssert*`, which every production caller now uses.
//
// Both sides run the same corpus of port shapes and must agree on:
//   1. success: the returned value is the very same object (identity),
//   2. failure: a TypeError whose message is byte-identical.
//
// Coverage is asserted per branch (missing port, non-object, each missing
// method, non-function method, valid, extra members) so an empty corpus cannot
// pass. The mutation block at the bottom tampers with the oracle and proves
// the comparison turns red.

const assert = require('node:assert/strict');
const test = require('node:test');

const { getNative } = require('../src/native/binding');
const legacy = require('./helpers/legacy-session-ports');

const PAIRS = [
  ['assertSessionRecordsPort', 'sessionAssertSessionRecordsPort', 'records', ['list', 'get']],
  ['assertSessionRuntimePort', 'sessionAssertSessionRuntimePort', 'runtime', ['read']],
  ['assertWorkspaceFactsPort', 'sessionAssertWorkspaceFactsPort', 'workspaceFacts', ['read']],
  ['assertDirectoryRecordsPort', 'sessionAssertDirectoryRecordsPort', 'directories', ['list', 'get']],
  ['assertChatHistoryPort', 'sessionAssertChatHistoryPort', 'history',
    ['read', 'write', 'deleteSession', 'hasPersistedDelivery']],
];

function validPort(methods) {
  return Object.fromEntries(methods.map(name => [name, () => {}]));
}

// One corpus entry per branch, per validator: the port shapes probe the
// require-branch, the non-object branch, every per-method branch (missing and
// wrong-typed), the happy path and the pass-through of extra members.
function corpus(name, methods) {
  const entries = [
    ['null', null],
    ['undefined', undefined],
    ['zero', 0],
    ['string', 'port'],
    ['array', []],
    ['empty object', {}],
    ['valid', validPort(methods)],
    ['valid with extra members', { ...validPort(methods), extra: 1, more: 'x' }],
  ];
  for (const method of methods) {
    const missing = validPort(methods);
    delete missing[method];
    entries.push([`missing ${method}`, missing]);
    entries.push([`${method} not a function`, { ...validPort(methods), [method]: 42 }]);
    entries.push([`${method} null`, { ...validPort(methods), [method]: null }]);
  }
  return entries;
}

function outcome(fn, port) {
  try {
    const returned = fn(port);
    return { ok: true, same: returned === port };
  } catch (error) {
    return { ok: false, type: error.constructor.name, message: error.message };
  }
}

test('session port validators: native matches the frozen Node oracle on every branch', () => {
  const native = getNative();
  const covered = new Set();
  for (const [legacyName, nativeName, name, methods] of PAIRS) {
    const legacyFn = legacy[legacyName];
    const nativeFn = native[nativeName].bind(native);
    assert.equal(typeof legacyFn, 'function', legacyName);
    assert.equal(typeof nativeFn, 'function', nativeName);
    for (const [label, port] of corpus(name, methods)) {
      covered.add(`${name}:${label}`);
      const before = outcome(legacyFn, port);
      const after = outcome(nativeFn, port);
      assert.deepEqual(after, before, `${nativeName} diverged on "${label}"`);
    }
  }
  // Every validator must exercise both outcomes and every method branch.
  for (const [, , name, methods] of PAIRS) {
    for (const label of ['null', 'empty object', 'valid']) {
      assert.ok(covered.has(`${name}:${label}`), `coverage hole: ${name}:${label}`);
    }
    for (const method of methods) {
      assert.ok(covered.has(`${name}:missing ${method}`), `coverage hole: ${name} missing ${method}`);
    }
  }
});

test('the differential turns red when the oracle is tampered with', () => {
  const native = getNative();
  const port = { list: () => {}, get: () => {} };
  // A mutated oracle that accepts a missing method must diverge from native.
  const tampered = port => port;
  const before = outcome(tampered, {});
  const after = outcome(native.sessionAssertSessionRecordsPort.bind(native), {});
  assert.notDeepEqual(after, before, 'a silent oracle must not match a throwing native side');
  assert.equal(outcome(tampered, port).ok, outcome(native.sessionAssertSessionRecordsPort.bind(native), port).ok,
    'the tampered oracle still agrees on the happy path, so the red above is attributable');
});
