'use strict';

// 「手动待办」是用户的选择，和 pin 一样换设备、换 App 都得看到同一份。这些用例钉住：
// 落盘往返、错误码不和 pin 串、存在性剪枝、以及 /api/air 快照确实带着它（taskTodos）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { TODO_LIMIT, createAirTodoRuntime } = require('../src/native/binding').taskDomainHost;
const { mountAir } = require('./helpers/air-host');

function tempFile(name = 'air-todos.json') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-air-todos-')), name);
}

test('toggle 标记再取消，落盘后换一个运行时实例仍在', () => {
  const file = tempFile();
  const runtime = createAirTodoRuntime({ file, listTaskIds: () => ['t1', 't2'] });
  assert.deepEqual(runtime.toggle('t2'), ['t2']);
  assert.deepEqual(runtime.toggle('t1'), ['t2', 't1']);
  assert.deepEqual(runtime.toggle('t2'), ['t1']);
  assert.deepEqual(createAirTodoRuntime({ file, listTaskIds: () => ['t1', 't2'] }).read(), ['t1']);
  assert.ok(TODO_LIMIT >= 100);
});

test('任务删掉标记自己掉下来；不存在的任务不许标记；落盘失败用自己的错误码', () => {
  const known = new Set(['t1']);
  const runtime = createAirTodoRuntime({ file: tempFile(), listTaskIds: () => [...known] });
  runtime.toggle('t1');
  known.delete('t1');
  assert.deepEqual(runtime.read(), []);
  assert.throws(() => runtime.toggle('t1'), { status: 404, code: 'task_not_found' });

  const blocker = tempFile('blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const blocked = createAirTodoRuntime({ file: path.join(blocker, 'todos.json'), listTaskIds: () => ['t1'], logger: { warn() {} } });
  assert.throws(() => blocked.toggle('t1'), { code: 'todo_save_failed' });
  assert.deepEqual(blocked.read(), []);
});

test('/api/air 快照带着 taskTodos，与 pin 互不串；toggle 接口可用', async () => {
  const pinsFile = tempFile('air-pins.json');
  const board = { tasks: { t1: { id: 't1', title: 'One' }, t2: { id: 't2', title: 'Two' } } };
  const air = mountAir({
    pinsFile, getBoard: () => board,
    admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }) },
    records: new Map(), directories: new Map(), clis: ['claude'],
    shell: { taskAccess: () => ({ readOnly: false }) },
  });
  // 清单类写操作走宿主：失败与成功都按原语义失效摘要，响应外壳由前门补。
  assert.deepEqual(await air.ok({ op: 'todos-toggle', taskId: 't2' }), ['t2']);
  assert.equal((await air.fail({ op: 'todos-toggle', taskId: 'ghost' })).status, 404);
  await air.ok({ op: 'pins-toggle', taskId: 't1' });
  // 没指定 todosFile 时落在 pins 文件旁边，测试不会碰真实数据目录。
  assert.ok(fs.existsSync(path.join(path.dirname(pinsFile), 'air-todos.json')));
  const snapshot = (await air.snapshot()).json;
  assert.deepEqual(snapshot.taskTodos, ['t2']);
  assert.deepEqual(snapshot.taskPins, ['t1']);
});
