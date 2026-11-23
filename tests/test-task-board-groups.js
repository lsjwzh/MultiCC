'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/task-board/core');
const { createTaskBoardRuntime } = require('../src/routes/task-board');
const { mkRuntime } = require('./helpers/task-board-runtime');

test('related task grouping persists a separate family without merging task identity', () => {
  const board = core.createEmptyBoard();
  const original = core.createPendingTask(board, {
    taskId: 'task-original', dirId: 'd1', sessionId: 's1', taskText: '实现文件选择器', now: 10,
  });
  const derived = core.createPendingTask(board, {
    taskId: 'task-derived', dirId: 'd1', sessionId: 's1', taskText: '新增相册回归测试', now: 20,
  });
  const third = core.createPendingTask(board, {
    taskId: 'task-third', dirId: 'd1', sessionId: 's1', taskText: '补充桌面端兼容', now: 30,
  });
  const before = JSON.parse(JSON.stringify(board.tasks));
  const first = core.groupRelatedTasks(board, derived.id, original.id, 40);
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.deepEqual(board.tasks, before, 'presentation grouping must not mutate task records');
  assert.deepEqual(first.taskIds, ['task-original', 'task-derived']);
  assert.equal(core.groupRelatedTasks(board, derived.id, original.id, 50).changed, false);
  const expanded = core.groupRelatedTasks(board, third.id, derived.id, 60);
  assert.equal(expanded.groupId, first.groupId);
  assert.deepEqual(new Set(expanded.taskIds), new Set(['task-original', 'task-derived', 'task-third']));

  const dto = core.buildBoardDto(board);
  assert.equal(dto.taskGroups.length, 1);
  assert.equal(dto.taskGroups[0].rootTaskId, original.id);
  assert.equal(dto.taskGroups[0].title, '实现文件选择器');
  assert.deepEqual(new Set(dto.taskGroups[0].taskIds), new Set(expanded.taskIds));
  assert.equal(dto.tasks.find(task => task.id === derived.id).taskGroupId, first.groupId);
  assert.equal(dto.tasks.length, 3);
});

test('normalizeBoard drops dangling groups and coalesces overlapping presentation families', () => {
  const rawTasks = Object.fromEntries(['a', 'b', 'c', 'd'].map((id, index) => [id, {
    id, title: `任务${id}`, status: 'active', refs: [{ sessionId: 's1', dirId: 'd1' }],
    createdAt: index + 1, updatedAt: index + 1,
  }]));
  const board = core.normalizeBoard({
    tasks: rawTasks,
    taskGroups: {
      'group-old': { id: 'group-old', rootTaskId: 'a', taskIds: ['a', 'b'], createdAt: 1 },
      'group-other': { id: 'group-other', rootTaskId: 'c', taskIds: ['c', 'd'], createdAt: 2 },
      'group-bridge': { id: 'group-bridge', taskIds: ['b', 'c'], createdAt: 3 },
      'group-dangling': { id: 'group-dangling', taskIds: ['a', 'missing'], createdAt: 4 },
    },
  });
  assert.equal(Object.keys(board.taskGroups).length, 1);
  const [group] = Object.values(board.taskGroups);
  assert.equal(group.id, 'group-old');
  assert.equal(group.rootTaskId, 'a');
  assert.deepEqual(new Set(group.taskIds), new Set(['a', 'b', 'c', 'd']));
});

test('runtime persists related task groups while keeping both task ids independently addressable', t => {
  const fixture = mkRuntime();
  t.after(() => fs.rmSync(path.dirname(fixture.file), { recursive: true, force: true }));
  const first = core.createPendingTask(fixture.runtime.getBoard(), {
    taskId: 'task-family-root', dirId: 'dir-1', sessionId: 'sess-1', taskText: '主任务', now: 1,
  });
  const second = core.createPendingTask(fixture.runtime.getBoard(), {
    taskId: 'task-family-child', dirId: 'dir-1', sessionId: 'sess-1', taskText: '衍生任务', now: 2,
  });
  const grouped = fixture.runtime.linkRelatedTasks(second.id, first.id);
  assert.equal(grouped.ok, true);
  assert.equal(grouped.changed, true);
  assert.deepEqual(Object.keys(fixture.runtime.getBoard().tasks).sort(),
    ['task-family-child', 'task-family-root']);
  assert.equal(fixture.runtime.getBoard().tasks[first.id].mergedInto, undefined);
  assert.equal(fixture.runtime.getBoard().tasks[second.id].mergedInto, undefined);

  const restored = createTaskBoardRuntime(fixture.deps).getBoard();
  assert.deepEqual(Object.keys(restored.tasks).sort(), ['task-family-child', 'task-family-root']);
  assert.equal(Object.keys(restored.taskGroups).length, 1);
  assert.deepEqual(new Set(Object.values(restored.taskGroups)[0].taskIds),
    new Set(['task-family-root', 'task-family-child']));
});

test('failed related-task persistence rolls back only presentation metadata', t => {
  const fixture = mkRuntime({ atomicWriteJson: () => { throw new Error('disk full'); } });
  t.after(() => fs.rmSync(path.dirname(fixture.file), { recursive: true, force: true }));
  const board = fixture.runtime.getBoard();
  const first = core.createPendingTask(board, {
    taskId: 'task-family-root', dirId: 'dir-1', sessionId: 'sess-1', taskText: '主任务', now: 1,
  });
  const second = core.createPendingTask(board, {
    taskId: 'task-family-child', dirId: 'dir-1', sessionId: 'sess-1', taskText: '衍生任务', now: 2,
  });
  const tasksBefore = JSON.parse(JSON.stringify(board.tasks));
  const revisionBefore = board.revision;

  const result = fixture.runtime.linkRelatedTasks(second.id, first.id);

  assert.deepEqual(result, { ok: false, error: 'persistence_failed' });
  assert.deepEqual(board.taskGroups, {});
  assert.deepEqual(board.tasks, tasksBefore, 'a failed presentation write cannot alter task identities');
  assert.equal(board.revision, revisionBefore);
  assert.equal(fixture.broadcasts.length, 0);
});

test('group linking matches the frozen runtime across refusal, failed save, retry and duplicate', t => {
  const legacy = require('./helpers/load-legacy-task-board-runtime');
  t.mock.method(Date, 'now', () => 1700000000000);
  function capture(createRuntime) {
    const effects = [];
    let fail = false;
    const fixture = mkRuntime({
      atomicWriteJson(file, value) {
        effects.push(['write', value.revision]);
        if (fail) throw new Error('disk full');
        fs.writeFileSync(file, JSON.stringify(value));
      },
      workspaceBroadcast(dirId, payload) { effects.push(['notify', dirId, payload]); },
    }, createRuntime);
    t.after(() => fs.rmSync(path.dirname(fixture.file), { recursive: true, force: true }));
    const board = fixture.runtime.getBoard();
    for (const taskId of ['a', 'b', 'c']) {
      core.createPendingTask(board, { taskId, dirId: 'dir-1', sessionId: 'sess-1', taskText: taskId, now: 10 });
    }
    function link(id, related) {
      effects.length = 0;
      const result = fixture.runtime.linkRelatedTasks(id, related);
      const disk = fs.existsSync(fixture.file) ? JSON.parse(fs.readFileSync(fixture.file, 'utf8')) : null;
      return structuredClone({ result, effects, revision: board.revision,
        groups: JSON.parse(JSON.stringify(board.taskGroups)), persisted: disk && disk.taskGroups });
    }
    const refused = link('missing', 'a');
    const created = link('b', 'a');
    fail = true;
    const rolledBack = link('c', 'b');
    fail = false;
    return [refused, created, rolledBack, link('c', 'b'), link('a', 'b')];
  }
  const expected = capture(legacy.createTaskBoardRuntime);
  assert.equal(expected[0].result.error, 'task_not_found');
  assert.ok(expected[1].effects.some(([kind]) => kind === 'notify'));
  assert.equal(expected[2].result.error, 'persistence_failed');
  assert.deepEqual(expected[2].groups, expected[1].groups);
  assert.deepEqual(expected[2].persisted, expected[1].persisted);
  assert.ok(expected[3].result.changed);
  assert.deepEqual(expected[4].effects, []);
  assert.deepEqual(capture(createTaskBoardRuntime), expected);
});

test('required board ports preserve validation order, missing values and getter exceptions', () => {
  const { assertTaskBoardDeps } = require('../src/routes/task-board');
  const frozen = require('./helpers/legacy-task-board-runtime-helpers').assertTaskBoardDeps;
  function trace(validate, missing, value) {
    const reads = [];
    const deps = new Proxy({}, { get(_, key) { reads.push(key); return key === missing ? value : false; } });
    try { validate(deps); return { reads }; }
    catch (error) { return { reads, error: [error.constructor.name, error.message, error.code] }; }
  }
  for (const missing of ['file', 'atomicWriteJson', 'getSessionRunState', 'none']) {
    for (const value of [null, undefined]) {
      assert.deepEqual(trace(assertTaskBoardDeps, missing, value), trace(frozen, missing, value));
    }
  }
  for (const value of [undefined, null, 'file', () => {}]) {
    assert.throws(() => assertTaskBoardDeps(value), { name: 'Error', message: '[taskboard] deps object required' });
  }
  const fault = new Error('port unavailable');
  assert.throws(() => assertTaskBoardDeps({ get file() { throw fault; } }), error => error === fault);
});
