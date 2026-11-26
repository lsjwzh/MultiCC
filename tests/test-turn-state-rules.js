'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveTurnState } = require('../src/native/binding').getTurnState();

const inactive = { state: 'inactive', reason: 'runner_closed' };

test('structured turn facts cover the complete P/D/W/B/E vocabulary without Aux', () => {
  assert.deepEqual(resolveTurnState({ liveness: { state: 'active', reason: 'owned' }, boundary: 'succeeded' }),
    { state: 'P', evidence: 'owned' });
  assert.equal(resolveTurnState({ liveness: inactive, boundary: 'succeeded' }).state, 'D');
  assert.equal(resolveTurnState({ liveness: inactive, boundary: 'succeeded', pendingUserInput: true }).state, 'W');
  assert.equal(resolveTurnState({
    liveness: inactive, boundary: 'succeeded', backgroundPending: true,
  }).state, 'B');
  assert.equal(resolveTurnState({ liveness: inactive, boundary: 'api-error' }).state, 'E');
});

test('every abnormal finalization boundary maps to E and unknown values fail closed', () => {
  for (const boundary of [
    'api-error', 'interrupted', 'unknown-interruption',
    'result-not-durable', 'handoff-resume-failed', 'future-adapter-ending',
  ]) {
    assert.equal(resolveTurnState({ liveness: inactive, boundary }).state, 'E', boundary);
  }
});

test('gateway success uses the same resolver with gateway evidence', () => {
  assert.deepEqual(resolveTurnState({
    liveness: inactive, boundary: 'succeeded', sessionType: 'gateway',
  }), { state: 'D', evidence: 'gateway_turn_succeeded' });
  assert.equal(resolveTurnState({ liveness: inactive, boundary: 'completed' }).state, 'D',
    'legacy completed boundary remains compatible');
});

test('回合状态保留 JSON 输入边界与冻结结果', () => {
  const old = require('./helpers/frozen-host-ports/classify-turn-state');
  const current = require('../src/native/binding').getTurnState();
  assert.equal(current, require('../src/native/binding').getTurnState());
  assert.deepEqual([...current.ABNORMAL_BOUNDARIES], [...old.ABNORMAL_BOUNDARIES]);
  const value = fn => { try { return fn(); } catch (e) { return [e.name, e.message]; } };
  for (const v of [null, undefined, 5, {}, { toJSON: () => ({ boundary: 'succeeded', liveness: inactive }) },
    { x: 4n }, { boundary: '\ud800' }, Symbol('无')]) {
    assert.deepEqual(value(() => resolveTurnState(v)), value(() => old.resolveTurnState(v)));
  }
});
