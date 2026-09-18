'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MODES, DEFAULT_MODE, normalizeAttributionMode, planAttributionAction } = require('../src/task-routing/attribution-mode');

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
