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
  { type: 'claim_released', freezeReason: 'incomplete_requires_resume' },
  { type: 'reconcile', classifyState: 'W' },
  { type: 'cancelled' },
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
        sessionId: input.sessionId, at: 1700000000001 + index });
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

test('native outcome adapter preserves live classifier inputs and exceptions', () => {
  const project = require('../src/native/runtime').getNative().taskBoardTurnOutcome;
  const calls = [];
  const classify = value => { calls.push(value); return value; };
  for (const [outcome, expected] of [['succeeded', 'succeeded'], ['failed', 'error'], ['running', 'running']]) {
    assert.equal(project(outcome, 'ignored', classify), expected);
  }
  assert.deepEqual(calls, []);
  assert.equal(project('waiting_user', 'ignored', classify), 'W');
  assert.equal(project('waiting_background', 'ignored', classify), 'B');
  for (const value of [undefined, null, false, 0, NaN, '']) {
    assert.equal(project('unknown', value, classify), 'D');
  }
  const token = { state: 'W' };
  assert.equal(project(new String('succeeded'), token, classify), token);
  assert.equal(calls.at(-1), token);
  const error = new Error('classifier failed');
  assert.throws(() => project('unknown', 'W', () => { throw error; }), value => value === error);
});
