'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/task-board');
const { createTaskBoardRuntime } = require('../src/routes/task-board');
const taskBoardUi = require('../public/task-board-ui');
const { mkRuntime } = require('./helpers/task-board-runtime');

test('task board UI groups only visible related tasks and leaves every task card distinct', () => {
  const tasks = [
    { id: 'task-new', title: '新衍生任务', lastTs: 30 },
    { id: 'task-old', title: '原始任务', lastTs: 20 },
    { id: 'task-free', title: '无关任务', lastTs: 10 },
  ];
  const partitioned = taskBoardUi.partitionTaskGroups(tasks, [{
    id: 'group-1', title: '原始任务', taskIds: ['task-old', 'task-new'], lastTs: 30,
  }]);
  assert.deepEqual(partitioned.groups.map(group => group.id), ['group-1']);
  assert.deepEqual(partitioned.groups[0].tasks.map(task => task.id), ['task-new', 'task-old']);
  assert.deepEqual(partitioned.ungrouped.map(task => task.id), ['task-free']);
  assert.deepEqual(tasks.map(task => task.id), ['task-new', 'task-old', 'task-free']);

  const filtered = taskBoardUi.partitionTaskGroups([tasks[0], tasks[2]], [{
    id: 'group-1', taskIds: ['task-old', 'task-new'],
  }]);
  assert.equal(filtered.groups.length, 0);
  assert.deepEqual(filtered.ungrouped.map(task => task.id), ['task-new', 'task-free']);
  for (const file of ['public/manage-taskboard.js', 'public/meta.html']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(source, /MultiCCTaskBoardUi\.partitionTaskGroups/);
    assert.match(source, /tb-related-group/);
  }
});

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
