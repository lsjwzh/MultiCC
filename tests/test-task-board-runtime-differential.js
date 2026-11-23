'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkRuntime } = require('./helpers/task-board-runtime');
const legacy = require('./helpers/load-legacy-task-board-runtime');
const current = require('../src/routes/task-board');
const baseline = require('./fixtures/task-board-runtime-baseline.json');
const queueBaseline = require('./fixtures/task-board-queue-baseline.json');
const queueEvents = [
  { type: 'queued', workKind: 'task' },
  { type: 'claimed' },
  { type: 'completed', turnOutcome: 'succeeded' },
  { type: 'completed', turnOutcome: 'failed' },
  { type: 'completed', turnOutcome: 'waiting_user' },
  { type: 'completed', turnOutcome: 'waiting_background' },
  { type: 'completed', turnOutcome: 'running' },
  ...['D', 'W', 'B', 'E', null].map(classifyState => ({ type: 'completed', classifyState })),
  { type: 'claim_released' },
  { type: 'claim_released', queuedItems: ['item'] },
  { type: 'claim_released', queuedItems: [], queueSummary: { classifyState: 'D' } },
  { type: 'claim_released', queueSummary: { classifyState: 'W' } },
  { type: 'claim_released', queueSummary: {} },
  { type: 'claim_released', queuedItems: null },
  { type: 'claim_released', queuedItems: { length: 3 } },
  { type: 'claim_released', freezeReason: 'incomplete_requires_resume' },
  { type: 'claim_released', freezeReason: 'configuration_required' },
  { type: 'claim_released', freezeReason: 'future_reason_with_error_inside' },
  { type: 'claim_released', freezeReason: 'future_reason_calm' },
  { type: 'frozen', freezeReason: 'incomplete_requires_resume' },
  { type: 'frozen', freezeReason: 'mystery_error_xyz' },
  { type: 'frozen', freezeReason: 'mystery_calm' },
  { type: 'frozen' },
  { type: 'started' },
  { type: 'resumed' },
  { type: 'skipped' },
  { type: 'mystery_type' },
  { type: 'queued', workKind: 'chat' },
  { type: 'completed', turnOutcome: 'made_up_outcome', classifyState: 'B' },
  { type: 'reconcile', classifyState: 'W' },
  { type: 'cancelled' },
  // A reconcile bypasses the stale guard on purpose (formal re-publish); the
  // trailing heartbeat with an old clock must then be rejected as stale.
  { type: 'reconcile', classifyState: 'B', at: 1 },
  { type: 'started', at: 1 },
];

// The clock and identifiers are controlled on both sides; output includes the
// persisted board and emitted notifications, not just function return values.
async function capture(createRuntime) {
  const oldNow = Date.now;
  Date.now = () => 1700000000000;
  let fixture;
  try {
    fixture = mkRuntime({}, createRuntime);
    const { runtime, broadcasts, file } = fixture;
    const input = { id: 'tsk-baseline', dirId: 'dir-1', sessionId: 'sess-1',
      title: '固定任务', createdAt: 1700000000000 };
    const results = [];
    results.push(runtime.markTaskSeen('missing'));
    results.push(await runtime.archiveTasks([]));
    results.push(runtime.registerShellTask(input));
    results.push(runtime.registerShellTask({ ...input, sessionId: 'different-session' }));
    results.push(await runtime.routeCommanderInput('missing', 'hello'));
    results.push(await runtime.routeCommanderInput('commander-1', '  '));
    results.push(await runtime.archiveTasks(['missing']));
    const queue = queueEvents.map((event, index) => {
      const result = runtime.onQueueEvent({ ...event, taskId: input.id,
        sessionId: input.sessionId, at: event.at ?? (1700000000001 + index) });
      return { result, runState: runtime.getBoard().tasks[input.id].runState };
    });
    const board = JSON.parse(JSON.stringify(runtime.getBoard()));
    const persisted = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    const moduleIds = Object.keys(board.modules);
    assert.equal(moduleIds.length, 1);
    const [moduleId] = moduleIds;
    assert.match(moduleId, /^mod-[a-f0-9]{32}$/);
    assert.equal(board.modules[moduleId].id, moduleId);
    assert.equal(board.tasks['tsk-baseline'].moduleId, moduleId);
    assert.equal(persisted.modules[moduleId].id, moduleId);
    assert.equal(persisted.tasks['tsk-baseline'].moduleId, moduleId);
    const raw = JSON.stringify({ results, queue, board, broadcasts, persisted });
    return JSON.parse(raw.replaceAll(moduleId, '<generated-module-id>'));
  } finally {
    Date.now = oldNow;
    if (fixture) fs.rmSync(path.dirname(fixture.file), { recursive: true, force: true });
  }
}

test('task board runtime matches its frozen host baseline', async () => {
  const expected = await capture(legacy.createTaskBoardRuntime);
  assert.deepEqual(expected.results, baseline);
  assert.deepEqual(expected.queue, queueBaseline);
  assert.deepEqual(await capture(current.createTaskBoardRuntime), expected);
});

test('queue result mutation is detected by the baseline', async () => {
  const expected = await capture(legacy.createTaskBoardRuntime);
  const mutated = await capture(deps => {
    const runtime = legacy.createTaskBoardRuntime(deps);
    return { ...runtime, onQueueEvent(event) {
      const result = runtime.onQueueEvent(event);
      return { ...result, changed: !result.changed };
    } };
  });
  assert.notDeepEqual(mutated, expected);
  assert.notDeepEqual(mutated.queue, queueBaseline);
});

test('native queue run-state adapter preserves live reads and exceptions', () => {
  const run = require('../src/native/runtime').getNative().taskBoardQueueRunState;
  const calls = [];
  const classify = value => { calls.push(value); return value; };
  const freeze = value => { calls.push(value); return value; };
  // completed reads turnOutcome then classifyState, both eagerly, and the
  // matched-outcome branches never consult the classifier.
  const reads = [];
  const eager = {};
  Object.defineProperties(eager, {
    turnOutcome: { get() { reads.push('turnOutcome'); return 'succeeded'; } },
    classifyState: { get() { reads.push('classifyState'); return 'W'; } },
  });
  assert.equal(run('completed', eager, freeze, classify), 'succeeded');
  assert.deepEqual(reads, ['turnOutcome', 'classifyState']);
  assert.deepEqual(calls, []);
  for (const [outcome, expected] of [['failed', 'error'], ['running', 'running']]) {
    assert.equal(run('completed', { turnOutcome: outcome }, freeze, classify), expected);
  }
  assert.equal(run('completed', { turnOutcome: 'waiting_user' }, freeze, classify), 'W');
  assert.equal(run('completed', { turnOutcome: 'waiting_background' }, freeze, classify), 'B');
  for (const value of [undefined, null, false, 0, NaN, '']) {
    assert.equal(run('completed', { classifyState: value }, freeze, classify), 'D');
  }
  const token = { state: 'W' };
  assert.equal(run('completed', { turnOutcome: new String('succeeded'), classifyState: token },
    freeze, classify), token);
  assert.equal(calls.at(-1), token);
  // reconcile reads classifyState exactly once.
  const reconcileReads = [];
  const reconcileEvent = {};
  Object.defineProperty(reconcileEvent, 'classifyState',
    { get() { reconcileReads.push('classifyState'); return 'B'; } });
  assert.equal(run('reconcile', reconcileEvent, freeze, classify), 'B');
  assert.deepEqual(reconcileReads, ['classifyState']);
  // frozen forwards the raw reason; callback exceptions propagate untouched.
  const reason = { why: 'auth' };
  assert.equal(run('frozen', { freezeReason: reason }, freeze, classify), reason);
  const error = new Error('lookup failed');
  assert.throws(() => run('frozen', { freezeReason: 'x' }, () => { throw error; }, classify),
    value => value === error);
  assert.throws(() => run('reconcile', { classifyState: 'W' }, freeze, () => { throw error; }),
    value => value === error);
  // claim_released reads freezeReason twice when set (check + argument) and
  // then short-circuits before touching queuedItems.
  const releaseReads = [];
  const release = {};
  Object.defineProperties(release, {
    freezeReason: { get() { releaseReads.push('freezeReason'); return 'configuration_required'; } },
    queuedItems: { get() { releaseReads.push('queuedItems'); return undefined; } },
  });
  assert.equal(run('claim_released', release, freeze, classify), 'configuration_required');
  assert.deepEqual(releaseReads, ['freezeReason', 'freezeReason']);
  // Depth rules: a non-empty array queues; an empty one falls back to the
  // queue summary's classify verdict; a missing summary selects 'D'.
  assert.equal(run('claim_released', { queuedItems: ['i'] }, freeze, classify), 'queued');
  assert.equal(run('claim_released', { queuedItems: [] }, freeze, classify), 'D');
  assert.equal(run('claim_released', { queuedItems: [], queueSummary: { classifyState: 'B' } },
    freeze, classify), 'B');
  assert.equal(run('claim_released', {}, freeze, classify), 'queued');
  assert.equal(run('queued', {}, freeze, classify), 'queued');
  assert.equal(run('claimed', {}, freeze, classify), 'running');
  assert.equal(run('skipped', {}, freeze, classify), 'idle');
  assert.equal(run('mystery', {}, freeze, classify), null);
});
