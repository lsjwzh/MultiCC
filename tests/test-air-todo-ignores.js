'use strict';

// 「手动忽略」是待办视图上的人工状态：用户已知晓、不想再被提醒（尤其是出错）
// 的任务。这些用例钉住产品语义的最终版本：
//   · 只有 error / waiting 两类「待办来源」可以忽略，其它任务 400；
//   · 忽略只对「这一次问题」有效：类别变了失效，同类问题出现新的一次也失效；
//     改名/移动这种只动 updatedAt 的操作不算新的一次；
//   · 老格式条目（没有 kind）按 updatedAt 旧规则兼容；
//   · 忽略与手动待办各自独立，不再互斥；
//   · 「标记达成」接口复用聊天页同一条落状态路径，并出现在 /api/air 快照里。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { TODO_IGNORE_LIMIT, createAirTodoIgnoreRuntime } = require('../src/workspace/todo-ignores');
const { mountAir } = require('./helpers/air-host');
// `POST /api/air/tasks/mark-achieved` 的公开挂载点已搬到 Rust 前门
// （native/gateway/src/app/task_routes.rs），eligibility 阶梯的单元/集成用例在
// native/core/src/task_routes.rs 与 native/gateway/tests/task_routes.rs。
// `markTaskAchieved` 是退休处理器原样保留的组合（facts + write），这里用它钉住
// Node 侧的事实与落状态 writer 仍是同一条路径。
const { markTaskAchieved } = require('../src/routes/task-goal');

function tempFile(name = 'air-todo-ignores.json') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-air-todo-ignores-')), name);
}

function call(handler, { params = {}, body = {} } = {}) {
  const response = { statusCode: 200, body: undefined };
  const res = {
    status(code) { response.statusCode = code; return this; },
    json(value) { response.body = value; return this; },
  };
  handler({ params, body }, res);
  return response;
}

function task(id, extra = {}) {
  return { id, title: id, updatedAt: 1000, chatSessionId: `s-${id}`, runState: 'error', ...extra };
}

function readItems(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).data.items;
}

function mountFixture(tasks, pinsFile, options = {}) {
  const board = { tasks: Object.fromEntries(tasks.map(value => [value.id, value])) };
  const records = options.records || new Map();
  for (const value of tasks) {
    const sessionId = value.chatSessionId || value.sessionId;
    if (sessionId && !records.has(sessionId)) {
      records.set(sessionId, {
        id: sessionId, kind: 'chat', taskBoundTaskId: value.id,
        taskState: { endedAt: Number(value.updatedAt) || 0, ...(options.taskState || {}) },
      });
    }
  }
  const chatSessions = options.chatSessions || new Map();
  // 任务 / 待办 / 忽略走宿主端口；标记达成由 Rust 前门拥有，Node 只剩事实与 writer。
  const air = mountAir({
    pinsFile, getBoard: () => board, records, pendingUserInput: options.pendingUserInput,
    admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }) },
    directories: new Map(), clis: ['claude'],
    shell: { taskAccess: () => ({ readOnly: false }) },
  });
  const setTaskState = (sessionId, patch) => {
    const record = records.get(sessionId);
    if (!record) return null;
    record.taskState = { ...(record.taskState || {}), ...patch };
    return record.taskState;
  };
  const taskGoalDeps = {
    records, chatSessions, setTaskState,
    getTaskState: record => (record && record.taskState) || {},
  };
  const handlers = {
    get: route => {
      if (route !== 'POST /api/air/tasks/mark-achieved') return air.app.routes.get(route);
      // 退休处理器的形状：成功返回 { ok, taskId, goalState }，失败抛带 status/code 的
      // 错误；Rust 侧把同一条阶梯翻译成同样的状态码与正文。
      // Express 处理器形状：成功/失败都写回 res，`call()` 再读出 statusCode/body。
      return (req = {}, res) => {
        const body = req.body || {};
        try {
          res.status(200).json(markTaskAchieved(taskGoalDeps, body.taskId));
        } catch (error) {
          res.status(error.status || 500).json({
            ok: false, code: error.code || 'mark_achieved_failed', message: error.message,
          });
        }
      };
    },
  };
  return { air, handlers, board, records, chatSessions };
}

test('只有 error / waiting 可以忽略；其它任务 400 todo_ignore_not_applicable', () => {
  const file = tempFile();
  const tasks = [
    { id: 'err', updatedAt: 1000, kind: 'error', occurredAt: 1000 },
    { id: 'wait', updatedAt: 1000, kind: 'waiting', occurredAt: 1000 },
    { id: 'run', updatedAt: 1000, kind: null, occurredAt: 0 },
    { id: 'done', updatedAt: 1000, kind: null, occurredAt: 0 },
  ];
  const runtime = createAirTodoIgnoreRuntime({
    file, listTasks: () => tasks, readTodos: () => [],
    problemOf: value => ({ kind: value.kind, occurredAt: value.occurredAt }),
  });

  assert.deepEqual(runtime.toggle('err'), { ignored: true, kind: 'error', taskIds: ['err'], todos: [] });
  assert.deepEqual(runtime.toggle('wait'), { ignored: true, kind: 'waiting', taskIds: ['err', 'wait'], todos: [] });
  for (const id of ['run', 'done']) {
    assert.throws(() => runtime.toggle(id), { status: 400, code: 'todo_ignore_not_applicable' });
  }
  assert.ok(TODO_IGNORE_LIMIT >= 100);
});

test('类别变化即失效：不再出错/不再等待后忽略掉下来，再次出问题要重新忽略', () => {
  const file = tempFile();
  const tasks = [{ id: 't1', updatedAt: 1000, kind: 'error', occurredAt: 1000 }];
  const runtime = createAirTodoIgnoreRuntime({
    file, listTasks: () => tasks, readTodos: () => [],
    problemOf: value => ({ kind: value.kind, occurredAt: value.occurredAt }),
  });
  runtime.toggle('t1');
  assert.deepEqual(runtime.read(), ['t1']);

  tasks[0] = { id: 't1', updatedAt: 1500, kind: null, occurredAt: 0 };   // 又开始跑了
  assert.deepEqual(runtime.read(), [], '类别变了就不该再算忽略');

  tasks[0] = { id: 't1', updatedAt: 2000, kind: 'error', occurredAt: 2000 }; // 新的一次异常
  assert.deepEqual(runtime.read(), [], '旧条目已失效，新异常正常进待办');
  assert.equal(runtime.toggle('t1').kind, 'error');
  assert.deepEqual(readItems(file), [{ taskId: 't1', kind: 'error', stamp: 2000 }]);
});

test('同类问题只有「新的一次」才失效：renamed/updatedAt 变大不算，endedAt 变大才算', () => {
  const file = tempFile();
  const tasks = [{ id: 't1', updatedAt: 1000, kind: 'error', occurredAt: 1000 }];
  const runtime = createAirTodoIgnoreRuntime({
    file, listTasks: () => tasks, readTodos: () => [],
    problemOf: value => ({ kind: value.kind, occurredAt: value.occurredAt }),
  });
  runtime.toggle('t1');

  // 改名 / 移动 / 已读只动 updatedAt：还是同一次异常，忽略保持有效。
  tasks[0].updatedAt = 9999;
  assert.deepEqual(runtime.read(), ['t1']);

  // 同一任务又出现「新的一次」异常：发生时刻前进 → 失效。
  tasks[0].occurredAt = 2000;
  assert.deepEqual(runtime.read(), []);

  // 等待回复同理。
  const waiting = [{ id: 'w1', updatedAt: 3000, kind: 'waiting', occurredAt: 3000 }];
  const file2 = tempFile();
  const runtime2 = createAirTodoIgnoreRuntime({
    file: file2, listTasks: () => waiting, readTodos: () => [],
    problemOf: value => ({ kind: value.kind, occurredAt: value.occurredAt }),
  });
  runtime2.toggle('w1');
  waiting[0].updatedAt = 5000;
  assert.deepEqual(runtime2.read(), ['w1'], '时间戳只随状态变更动');
  waiting[0].occurredAt = 4000;
  assert.deepEqual(runtime2.read(), []);
});

test('拿不到「发生时刻」时退回 updatedAt 保守规则（已知误差）', () => {
  const file = tempFile();
  const tasks = [{ id: 't1', updatedAt: 1000, kind: 'error', occurredAt: 0 }];
  const runtime = createAirTodoIgnoreRuntime({
    file, listTasks: () => tasks, readTodos: () => [],
    problemOf: value => ({ kind: value.kind, occurredAt: value.occurredAt }),
  });
  const result = runtime.toggle('t1');
  assert.equal(result.ignored, true);
  assert.deepEqual(readItems(file), [{ taskId: 't1', kind: 'error', stamp: 1000 }]);
  tasks[0].updatedAt = 1001;
  assert.deepEqual(runtime.read(), [], '没有精确时刻时，任何 updatedAt 前进都按新异常处理');
});

test('老格式条目（没有 kind）按 updatedAt 规则兼容读取，不崩', () => {
  const file = tempFile();
  const tasks = [{ id: 't1', updatedAt: 1000, kind: 'error', occurredAt: 1000 }];
  // 先产生一份真实文件，再把条目改回旧形状。
  const seed = createAirTodoIgnoreRuntime({
    file, listTasks: () => tasks, readTodos: () => [],
    problemOf: value => ({ kind: value.kind, occurredAt: value.occurredAt }),
  });
  seed.toggle('t1');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.data.items = [{ taskId: 't1', stamp: 1000 }];
  fs.writeFileSync(file, JSON.stringify(stored));

  const legacy = createAirTodoIgnoreRuntime({
    file, listTasks: () => tasks, readTodos: () => [],
    problemOf: value => ({ kind: value.kind, occurredAt: value.occurredAt }),
  });
  assert.deepEqual(legacy.read(), ['t1']);
  tasks[0].updatedAt = 1001;   // 任何更新都失效（旧规则）
  assert.deepEqual(legacy.read(), []);

  // 取消一个已失效的老条目不该当成「新增」报 400：先把任务改回可忽略状态再点。
  tasks[0].updatedAt = 1000;
  assert.deepEqual(legacy.toggle('t1'), { ignored: false, kind: null, taskIds: [], todos: [] });
});

test('任务被删后忽略掉下来；未知任务 404、空 taskId 400、落盘失败用自己的错误码', () => {
  const tasks = [{ id: 't1', updatedAt: 1000, kind: 'error', occurredAt: 1000 },
    { id: 't2', updatedAt: 2000, kind: 'waiting', occurredAt: 2000 }];
  const runtime = createAirTodoIgnoreRuntime({
    file: tempFile(), listTasks: () => tasks, readTodos: () => [],
    problemOf: value => ({ kind: value.kind, occurredAt: value.occurredAt }),
  });
  runtime.toggle('t1');
  runtime.toggle('t2');
  tasks.splice(0, 1);
  assert.deepEqual(runtime.read(), ['t2']);
  assert.throws(() => runtime.toggle('t1'), { status: 404, code: 'task_not_found' });
  assert.throws(() => runtime.toggle('  '), { status: 400, code: 'task_id_required' });

  const blocker = tempFile('blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const blocked = createAirTodoIgnoreRuntime({
    file: path.join(blocker, 'ignores.json'), listTasks: () => tasks,
    problemOf: value => ({ kind: value.kind, occurredAt: value.occurredAt }),
    logger: { warn() {} },
  });
  assert.throws(() => blocked.toggle('t2'), { code: 'todo_ignore_save_failed' });
});

test('忽略与手动待办不再互斥（宿主端口）：两份清单各自保留', async () => {
  const pinsFile = tempFile('air-pins.json');
  const tasks = [
    task('t1', { runState: 'error', updatedAt: 1000 }),
    task('t2', { runState: 'waiting', updatedAt: 2000 }),
  ];
  const { air, records } = mountFixture(tasks, pinsFile);
  records.get('s-t1').taskState.endedAt = 1000;
  records.get('s-t2').taskState.endedAt = 2000;
  const ignore = body => air.ok({ op: 'todos-ignore', ...body });
  const todoToggle = body => air.ok({ op: 'todos-toggle', ...body });

  assert.deepEqual(await todoToggle({ taskId: 't1' }), ['t1']);
  // 忽略 t1：待办标记保留，不互相清除。前门把这份事实直接摊进 { ok: true, … }。
  assert.deepEqual(await ignore({ taskId: 't1' }),
    { ignored: true, kind: 'error', taskIds: ['t1'], todos: ['t1'] });
  assert.deepEqual(await air.ok({ op: 'todos-read' }), ['t1']);
  // 取消再标记一次待办：第二次「标记为待办」不会清掉忽略 —— 若清掉了，下一次
  // ignore 会变成新增（ignored:true），而不是取消（ignored:false）。
  assert.deepEqual(await todoToggle({ taskId: 't1' }), []);
  assert.deepEqual(await todoToggle({ taskId: 't1' }), ['t1']);
  assert.deepEqual(await ignore({ taskId: 't1' }),
    { ignored: false, kind: 'error', taskIds: [], todos: ['t1'] });
  // 错误码风格：未知任务 404、缺 taskId 400。
  assert.equal((await air.fail({ op: 'todos-ignore', taskId: 'ghost' })).status, 404);
  assert.equal((await air.fail({ op: 'todos-ignore' })).status, 400);
});

test('不可忽略的任务在前门拿到 400 todo_ignore_not_applicable', async () => {
  const pinsFile = tempFile('air-pins.json');
  const tasks = [
    task('busy', { runState: 'running', updatedAt: 1000 }),
    task('ok', { runState: 'error', updatedAt: 1000 }),
  ];
  const { air } = mountFixture(tasks, pinsFile);
  const rejected = await air.fail({ op: 'todos-ignore', taskId: 'busy' });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.code, 'todo_ignore_not_applicable');
  await air.ok({ op: 'todos-ignore', taskId: 'ok' });
});

test('/api/air 快照带 taskTodoIgnored（只含有效项）：类别变化或新一次问题都会被剪掉', async () => {
  const pinsFile = tempFile('air-pins.json');
  const tasks = [
    task('t1', { runState: 'error', updatedAt: 1000 }),
    task('t2', { runState: 'waiting', updatedAt: 2000 }),
  ];
  const { air, board, records } = mountFixture(tasks, pinsFile);
  records.get('s-t1').taskState.endedAt = 1000;
  records.get('s-t2').taskState.endedAt = 2000;
  const ignore = taskId => air.ok({ op: 'todos-ignore', taskId });
  await ignore('t1');
  await ignore('t2');
  assert.ok(fs.existsSync(path.join(path.dirname(pinsFile), 'air-todo-ignores.json')));

  assert.deepEqual((await air.snapshot()).json.taskTodoIgnored, ['t1', 't2']);

  // t1 改名（只动 updatedAt）仍有效；t2 出现新的一次等待 → 失效。
  board.tasks.t1.updatedAt = 9999;
  records.get('s-t2').taskState.endedAt = 2001;
  assert.deepEqual((await air.snapshot()).json.taskTodoIgnored, ['t1']);

  // t1 不再出错、t2 被删：都掉下来。
  board.tasks.t1.runState = 'idle';
  delete board.tasks.t2;
  assert.deepEqual((await air.snapshot()).json.taskTodoIgnored, []);
});

test('待回答问题的忽略时间读取当前所有者，所有者不可用时不丢弃忽略', async () => {
  const pinsFile = tempFile('air-pins.json');
  let current = { requestId: 'new', createdAt: 2000 };
  const { air, records } = mountFixture([task('t1', { runState: 'waiting' })], pinsFile, {
    pendingUserInput: () => {
      if (current instanceof Error) throw current;
      return current;
    },
  });
  records.get('s-t1').taskState = { pendingUserInput: { requestId: 'old', createdAt: 1000 } };
  await air.ok({ op: 'todos-ignore', taskId: 't1' });
  assert.equal(readItems(path.join(path.dirname(pinsFile), 'air-todo-ignores.json'))[0].stamp, 2000);
  current = Object.assign(new Error('owner unavailable'), { code: 'SESSION_WORK_OWNER_UNAVAILABLE' });
  assert.equal((await air.fail({ op: 'todos-ignore', taskId: 't1' })).code, 'SESSION_WORK_OWNER_UNAVAILABLE');
  assert.equal(readItems(path.join(path.dirname(pinsFile), 'air-todo-ignores.json'))[0].stamp, 2000);
  current = { requestId: 'next', createdAt: 3000 };
  assert.deepEqual((await air.snapshot()).json.taskTodoIgnored, []);
});

// 这一条钉的是把 node CPU 钉死的那个闭环：忽略清单的剪枝要问会话状态的 owner，
// owner 不可读时旧实现在读路径上重抛，于是整轮 /api/air 快照作废 —— 而这份辅助
// 清单排在 1500+ 张卡之后，抛出去等于把整轮计算全扔掉，再由 air-sync 每几秒重试
// 一次，反复全量重建。读路径必须降级（不剪枝、原样返回），写路径才 fail-closed。
test('所有者不可读时：快照照常出，忽略不被剪掉；只有写入才 fail-closed', async () => {
  const pinsFile = tempFile('air-pins.json');
  let current = { requestId: 'q1', createdAt: 2000 };
  const { air } = mountFixture([task('t1', { runState: 'waiting' })], pinsFile, {
    pendingUserInput: () => {
      if (current instanceof Error) throw current;
      return current;
    },
  });
  await air.ok({ op: 'todos-ignore', taskId: 't1' });
  assert.deepEqual((await air.snapshot()).json.taskTodoIgnored, ['t1'], '先确认忽略已生效');

  current = Object.assign(new Error('owner unavailable'), { code: 'SESSION_WORK_OWNER_UNAVAILABLE' });
  const snapshot = await air.snapshot();
  assert.equal(snapshot.json.ok, true, 'owner 不可读不该让整轮快照失败');
  assert.deepEqual(snapshot.json.taskTodoIgnored, ['t1'], '判不出类别时不剪枝，保留用户的选择');
  assert.equal(snapshot.json.tasks.length, 1, '卡片正文不受这份辅助清单影响');
  assert.equal((await air.fail({ op: 'todos-ignore', taskId: 't1' })).code,
    'SESSION_WORK_OWNER_UNAVAILABLE', '写入仍要 fail-closed');
});

test('标记达成：需要交互 → 200，快照 goalState=achieved；非交互 409、未知 404、运行中 409', async () => {
  const pinsFile = tempFile('air-pins.json');
  const tasks = [
    task('g1', { runState: 'succeeded' }),
    task('g2', { runState: 'succeeded', chatSessionId: 's-g2' }),
    task('busy', { runState: 'succeeded' }),
  ];
  const { air, handlers, records, chatSessions } = mountFixture(tasks, pinsFile);
  records.get('s-g1').taskState = { classifyState: 'D', goalState: 'interact' };
  records.get('s-g2').taskState = { classifyState: 'D', goalState: 'achieved' };
  records.get('s-busy').taskState = { classifyState: 'D', goalState: 'interact' };
  chatSessions.set('s-busy', { isStreaming: true });

  const mark = taskId => call(handlers.get('POST /api/air/tasks/mark-achieved'), { body: { taskId } });

  assert.deepEqual(mark('g1').body, { ok: true, taskId: 'g1', goalState: 'achieved' });
  assert.equal(records.get('s-g1').taskState.goalState, 'achieved');
  assert.ok(records.get('s-g1').taskState.goalStateManualAt > 0, 'manual 护栏要一起写，防止晚到的归因改回去');

  const snapshot = (await air.snapshot()).json;
  assert.equal(snapshot.tasks.find(value => value.id === 'g1').goalState, 'achieved');

  const notApplicable = mark('g2');
  assert.equal(notApplicable.statusCode, 409);
  assert.equal(notApplicable.body.code, 'mark_achieved_not_applicable');
  assert.equal(mark('ghost').statusCode, 404);
  assert.equal(mark('ghost').body.code, 'task_not_found');
  const streaming = mark('busy');
  assert.equal(streaming.statusCode, 409);
  assert.equal(streaming.body.code, 'task_streaming');
  assert.equal(mark().statusCode, 400);
});
