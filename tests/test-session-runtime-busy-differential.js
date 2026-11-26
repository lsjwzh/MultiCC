'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const legacy = require('./helpers/session-runtime-busy-oracle');
const { getNative } = require('../src/native/binding');

const candidate = {
  isChatStateBusy: (...args) => getNative().sessionRuntimeIsChatStateBusy(...args),
  processAlive: (...args) => getNative().sessionRuntimeProcessAlive(...args),
};
const examples = [
  ['undefined', () => undefined], ['null', () => null], ['zero', () => 0],
  ['false', () => false], ['string', () => 's'], ['bigint', () => 1n],
  ['symbol', () => Symbol('s')], ['idle', () => ({})],
  ['streaming', () => ({ isStreaming: true })],
  ['strict truth', () => ({ isStreaming: 1 })],
  ['live process', () => ({ claudeProc: { exitCode: null, signalCode: null } })],
  ['reaped process', () => ({ claudeProc: { exitCode: 0, signalCode: null } })],
  ['cancelled process', () => ({ _cancelledProc: {} })],
  ['active runner', () => ({ _activeRunner: {} })],
  ['throwing getter', trace => Object.defineProperty({}, 'isStreaming', { get() { trace.push('stream'); throw new Error('fixture'); } })],
  ['traced getters', trace => new Proxy({ claudeProc: { exitCode: null }, _activeRunner: {} }, {
    get(target, key) { trace.push(String(key)); return Reflect.get(target, key); },
  })],
  ['process getter', trace => Object.defineProperties({}, {
    exitCode: { get() { trace.push('exit'); return null; } },
    signalCode: { get() { trace.push('signal'); return 'TERM'; } },
  })],
];
for (const method of ['isChatStateBusy', 'processAlive']) {
  test(`${method} matches the frozen port for values, errors and reads`, () => {
    for (const [label, make] of examples) {
      const results = [];
      for (const implementation of [legacy, candidate]) {
        const trace = [];
        try { results.push({ value: implementation[method](make(trace)), trace }); }
        catch (error) { results.push({ error: { name: error.name, message: error.message, code: error.code }, trace }); }
      }
      assert.deepEqual(results[1], results[0], label);
    }
    assert.equal(candidate[method](), legacy[method](), 'omitted argument');
  });
}
