'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

module.exports = ({ createProviderAttemptRuntime, legacyCreationRuntime, route }) => {
  test('finish short-circuits falsy references before prototype getters and preserves stale audit', () => {
    const keys = ['sessionId', 'runtimeEpoch', 'turnId', 'routeAttemptId', 'routeGeneration'];
    const protos = [Number.prototype, Boolean.prototype, String.prototype, BigInt.prototype];
    const execute = (factory, reference) => {
      const trace = [];
      const runtime = factory({ runtimeEpoch: 'epoch', nextId: prefix => `${prefix}-1`,
        now: () => { trace.push('clock'); return 42; },
        audit: (session, event) => trace.push(['audit', session, event, Object.keys(event)]) });
      for (const sessionId of ['0', 'false', 'NaN']) runtime.beginAttempt(route({ sessionId }));
      trace.length = 0;
      const saved = [];
      try {
        for (const proto of protos) for (const key of keys) {
          const descriptor = Object.getOwnPropertyDescriptor(proto, key);
          saved.push([proto, key, descriptor]);
          Object.defineProperty(proto, key, { configurable: true, get() {
            trace.push(['prototype-get', key]);
            throw new Error(`unexpected ${key} access`);
          } });
        }
        const result = runtime.finishAttempt(reference, { outcome: 'failed' });
        trace.push(['result', result, Object.keys(result), result.attempt && Object.keys(result.attempt)]);
      } catch (error) {
        trace.push(['error', error.name, error.message]);
      } finally {
        for (const [proto, key, descriptor] of saved.reverse()) {
          if (descriptor) Object.defineProperty(proto, key, descriptor);
          else delete proto[key];
        }
      }
      return trace;
    };
    for (const reference of [false, 0, -0, NaN, '', 0n, null, undefined]) {
      const actual = execute(createProviderAttemptRuntime, reference);
      const expected = execute(legacyCreationRuntime, reference);
      assert.deepEqual(actual, expected, `reference ${String(reference)}`);
      assert.equal(actual.some(item => Array.isArray(item) && item[0] === 'prototype-get'), false);
      if (reference === false || typeof reference === 'number') {
        assert.deepEqual(actual.slice(0, 2).map(item => Array.isArray(item) ? item[0] : item), ['clock', 'audit']);
        assert.equal(actual[1][1], String(reference));
        assert.equal(actual[1][2].operation, 'finish');
        assert.ok(actual[2][1].attempt, 'a current record is returned for this coerced session');
      }
    }
  });

  test('finish reads truthy reference getters in order and propagates their exceptions', () => {
    const execute = (factory, throwAt) => {
      const trace = [];
      const values = { sessionId: 'missing', runtimeEpoch: 'epoch', turnId: 'turn',
        routeAttemptId: 'attempt', routeGeneration: 3n };
      const runtime = factory({ runtimeEpoch: 'epoch', now: () => { trace.push('clock'); return 42; },
        audit: (session, event) => trace.push(['audit', session, event, Object.keys(event)]) });
      const reference = new Proxy(values, { get(target, key, receiver) {
        trace.push(['get', key]);
        if (key === throwAt) throw new Error(`getter ${key}`);
        return Reflect.get(target, key, receiver);
      } });
      try { trace.push(['result', runtime.finishAttempt(reference)]); }
      catch (error) { trace.push(['error', error.name, error.message]); }
      return trace;
    };
    for (const throwAt of [undefined, 'sessionId', 'runtimeEpoch', 'turnId', 'routeAttemptId', 'routeGeneration']) {
      const actual = execute(createProviderAttemptRuntime, throwAt);
      assert.deepEqual(actual, execute(legacyCreationRuntime, throwAt));
      if (!throwAt) {
        assert.deepEqual(actual.filter(item => Array.isArray(item) && item[0] === 'get').map(item => item[1]),
          ['sessionId', 'runtimeEpoch', 'turnId', 'routeAttemptId', 'routeGeneration']);
        assert.deepEqual(actual.slice(-3).map(item => Array.isArray(item) ? item[0] : item), ['clock', 'audit', 'result']);
      }
    }
  });

  test('finish resolves its lifecycle receiver and setter before the reentrant clock', () => {
    const { RustProviderAttemptLifecycle } = require('../../src/native/binding').getNative();
    const proto = RustProviderAttemptLifecycle.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, 'setFinishedAt');
    const execute = (factory, throwGetter) => {
      const trace = [];
      let armed = false;
      const runtime = factory({ runtimeEpoch: 'epoch', nextId: prefix => `${prefix}-1`,
        now: () => {
          trace.push('clock');
          if (armed) {
            armed = false;
            Object.defineProperty(proto, 'setFinishedAt', { ...original, value() { trace.push('replacement'); } });
          }
          return 1234;
        }, emit: (_, event) => trace.push(['event', event.routePhase]) });
      const current = runtime.beginAttempt(route());
      trace.length = 0;
      const captured = function(value) {
        trace.push(['captured', this instanceof RustProviderAttemptLifecycle, value]);
        return original.value.call(this, value);
      };
      try {
        Object.defineProperty(proto, 'setFinishedAt', { configurable: true, get() {
          trace.push(['getter', this instanceof RustProviderAttemptLifecycle]);
          if (throwGetter) throw new Error('setter lookup');
          return captured;
        } });
        armed = true;
        try {
          const result = runtime.finishAttempt(current, { outcome: 'failed' });
          trace.push(['result', result.attempt.finishedAt]);
        } catch (error) { trace.push(['error', error.name, error.message]); }
      } finally {
        Object.defineProperty(proto, 'setFinishedAt', original);
      }
      const snapshot = runtime.snapshot('session-1');
      trace.push(['after', snapshot.outcome, snapshot.finishedAt]);
      return trace;
    };
    for (const throwGetter of [false, true]) {
      const actual = execute(createProviderAttemptRuntime, throwGetter);
      assert.deepEqual(actual, execute(legacyCreationRuntime, throwGetter));
      assert.deepEqual(actual[0], ['getter', true]);
      if (throwGetter) assert.equal(actual.includes('clock'), false);
      else {
        assert.equal(actual[1], 'clock');
        assert.deepEqual(actual[2], ['captured', true, 1234]);
        assert.equal(actual.includes('replacement'), false);
        assert.deepEqual(actual.at(-1), ['after', 'failed', 1234]);
      }
    }
  });
};
