'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MODES, DEFAULT_MODE, normalizeAttributionMode, planAttributionAction } = require('../src/native/binding').taskDomainHost.getAttributionModePolicy();

test('unknown modes fall back to the default instead of failing open', () => {
  assert.deepEqual(MODES, ['off', 'shadow', 'suggest', 'auto']);
  assert.equal(DEFAULT_MODE, 'suggest');
  assert.equal(normalizeAttributionMode('AUTO'), 'auto');
  assert.equal(normalizeAttributionMode(' shadow '), 'shadow');
  assert.equal(normalizeAttributionMode('always'), DEFAULT_MODE);
  assert.equal(normalizeAttributionMode(undefined), DEFAULT_MODE);
  assert.equal(normalizeAttributionMode('nonsense', 'off'), 'off');
});

test('a verdict that names the current task is never a change', () => {
  for (const mode of MODES) {
    assert.deepEqual(planAttributionAction({ mode, relation: 'same', targetTaskId: 'tsk_a', currentTaskId: 'tsk_a' }),
      { mode, action: 'none', reason: 'no_change', targetTaskId: null });
    assert.equal(planAttributionAction({ mode, relation: 'same', targetTaskId: null, currentTaskId: null }).action, 'none');
  }
});

test('the ladder only widens what the host may do, never what the verdict says', () => {
  const change = { relation: 'new', targetTaskId: 'tsk_b', currentTaskId: 'tsk_a' };
  assert.equal(planAttributionAction({ ...change, mode: 'off' }).action, 'none');
  assert.equal(planAttributionAction({ ...change, mode: 'shadow' }).action, 'record');
  assert.equal(planAttributionAction({ ...change, mode: 'suggest' }).action, 'suggest');
  assert.deepEqual(planAttributionAction({ ...change, mode: 'auto' }),
    { mode: 'auto', action: 'apply', reason: 'auto', targetTaskId: 'tsk_b' });
});

test('auto without an address stays a suggestion rather than minting an unnamed task', () => {
  assert.equal(planAttributionAction({ mode: 'auto', relation: 'new', targetTaskId: null, currentTaskId: 'tsk_a' }).action, 'suggest');
  assert.equal(planAttributionAction({ mode: 'auto', relation: 'new', targetTaskId: null, currentTaskId: 'tsk_a' }).reason, 'target_unknown');
  // A named different task is an address even when the verdict says "same".
  assert.equal(planAttributionAction({ mode: 'auto', relation: 'same', targetTaskId: 'tsk_b', currentTaskId: 'tsk_a' }).action, 'apply');
});

test('attribution mode live inputs agree with the frozen host', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const filename = path.resolve(__dirname, '../src/task-routing/attribution-mode.js');
  const source = fs.readFileSync(path.join(__dirname, 'helpers/legacy-attribution-mode.js'));
  const blob = crypto.createHash('sha1').update('blob ' + source.length + '\0').update(source).digest('hex');
  assert.equal(blob, '26bb5c1eeb3ef4306935010f6f63d36bc4cf7746');
  const frozen = { exports: {} };
  require('node:vm').compileFunction(source.toString(), ['require', 'module'], { filename })(
    require('node:module').createRequire(filename), frozen);
  const live = { MODES, DEFAULT_MODE, planAttributionAction, normalizeAttributionMode };
  const old = frozen.exports;
  assert.deepEqual(live.MODES, old.MODES);
  assert.equal(Object.isFrozen(live.MODES), true);
  const values = [undefined, null, false, 0, 2n, Symbol('a'), {}, ['auto'], 'auto', ' shadow ', '\ufeffOff', '\u0085auto', '\ud800', '建议'];
  const callbacks = { get unused() { throw Error('unexpected read'); } };
  for (const v of values) {
    for (const fallback of [undefined, null, 12n, callbacks]) {
      assert.strictEqual(live.normalizeAttributionMode(v, fallback), old.normalizeAttributionMode(v, fallback));
    }
    for (const relation of [undefined, false, {}, 'same', 'new']) {
      for (const targetTaskId of [undefined, null, 9n, 'a', '\ud800', '✨']) {
        for (const currentTaskId of ['a', 'b', '\udfff']) {
          const input = { mode: v, relation, targetTaskId, currentTaskId };
          const actual = live.planAttributionAction(input);
          const expected = old.planAttributionAction(input);
          assert.deepEqual(actual, expected);
          assert.deepEqual(Object.keys(actual), Object.keys(expected));
        }
      }
    }
  }
  function observe(api, failAt) {
    const reads = [], sentinel = Error('property');
    const input = new Proxy({}, { get(_, key) {
      reads.push(key);
      if (key === failAt) throw sentinel;
      return 'new';
    } });
    try { return [api.planAttributionAction(input), reads]; }
    catch (err) { assert.strictEqual(err, sentinel); return reads; }
  }
  for (const field of ['', 'mode', 'relation', 'targetTaskId', 'currentTaskId']) {
    assert.deepEqual(observe(live, field), observe(old, field));
  }
  for (const input of [null, undefined, 5n, Symbol('x'), false]) {
    function result(api) {
      try { return api.planAttributionAction(input); }
      catch (err) { return { error: err.name, message: err.message }; }
    }
    assert.deepEqual(result(live), result(old));
  }
});

test('归属设置保留模式、拒绝错误与回滚前的内存值', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const assert = require('node:assert/strict');
  const { createHash } = require('node:crypto');
  const { createRequire } = require('node:module');
  const { compileFunction } = require('node:vm');
  const file = path.resolve(__dirname, '../src/task-shell/attribution-settings.js');
  const resolve = require('./helpers/frozen-batch10').from(file, createRequire(file));
  const bytes = fs.readFileSync(path.join(__dirname, 'helpers/frozen-attribution-settings.js'));
  const hash = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
  assert.equal(hash, 'ebbf73b31408052f35d644e59f8db80406e50184');
  const original = { exports: {} };
  compileFunction(bytes.toString(), ['module', 'require'], {filename:file})(original,resolve);
  const api = require('../src/native/binding').taskDomainHost;
  const table = resolve('../native/task-domain').getAttributionModePolicy().MODES;
  const values = [undefined, null, '', false, 0, 1, Symbol('mode'), new String('auto'), {},
    { toString(){ throw Error('coercion'); } }, '\u0085auto\u0085', '\ud800auto', 'deny', ...table,
    ...table.map(m => '\ufeff' + m.toUpperCase() + '\u00a0')];
  let comparisons = 0;
  for (const initial of values) {
    const settings = [original.exports, api].map(a => a.createAttributionSettings({initial}));
    for (const value of [...values, ...values].reverse()) {
      const output = settings.map(s => {
        const {getMode,setMode} = s;
        const before = getMode();
        try {
          const result = setMode(value);
          return [before, Object.keys(result), result, getMode()];
        } catch (err) {
          return [before, err.constructor.name, err.message, err.status, err.code, Object.keys(err), getMode()];
        }
      });
      assert.deepEqual(...output);
      comparisons++;
    }
  }
  assert.equal(comparisons, 2 * values.length ** 2);
});
