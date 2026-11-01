'use strict';

// 常驻任务板句柄：同一操作序列走无状态整板路径与常驻句柄，结果与最终板必须一致；
// 另覆盖对象身份、Proxy 记脏、裸引用写入、事务回滚、失败/panic 恢复、落盘与异步只读。
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../src/task-board/core');
const planning = require('../src/task-board/planning');
const { boardRule } = require('../src/task-board/native-bridge');
const { taskDomain, taskDomainAsync, cloneBoard } = require('../src/native/task-domain');
const { openBoardStore } = require('../src/task-board/board-store');
const { createTaskBoardRepository } = require('../src/task-board/repository');

const NEW_IDS = Array.from({ length: 32 }, (_, i) => `${String(i).padStart(2, '0')}`.padEnd(32, 'a'));
const plain = value => JSON.parse(JSON.stringify(value));

function rawBoard() {
  const tasks = {};
  for (let i = 0; i < 12; i++) {
    const id = `tsk-${String(i).padStart(2, '0')}`;
    tasks[id] = {
      id, moduleId: i % 3 === 0 ? 'mod-a' : 'mod-b', title: `任务 ${i}`, status: i === 4 ? 'done' : 'active',
      areas: [`src/${i}`], createdAt: 1000 + i, updatedAt: 2000 + i,
      refs: [{ sessionId: `s${i % 4}`, dirId: 'd1', userMsgId: `u${i}`, assistantMsgId: `a${i}`, ts: 3000 + i, excerpt: `第 ${i} 轮` }],
      origin: i % 2 ? 'board' : 'session',
      ...(i % 5 === 0 ? { recordType: 'planned', workflowStage: 'ready', rank: 1024 * (i + 1), dirId: 'd1',
        dueAt: i === 5 ? '2026-12-01' : 1767225600000, priority: 'high', planningRevision: 1 } : {}),
    };
  }
  return {
    schemaVersion: 2, revision: 7,
    modules: { 'mod-a': { id: 'mod-a', name: '服务端', dirId: 'd1' }, 'mod-b': { id: 'mod-b', name: '前端 UI', dirId: 'd1' } },
    tasks, deletedTaskIds: [],
  };
}
const ref = (n, sessionId = 's1') => ({ sessionId, dirId: 'd1', userMsgId: `ru${n}`, assistantMsgId: `ra${n}`, ts: 9000 + n, excerpt: `ref ${n}` });

// 两条路径共用的操作序列：规则调用 + 宿主直接写入，混在一起。
function scenario(board) {
  const out = [];
  const classify = (action, args) => boardRule(action, { op: 'classification', board, newIds: NEW_IDS,
    idOrder: Object.values(board.taskGroups || {}).map(g => g.id).sort((a, b) => a.localeCompare(b)), ...args });
  out.push(core.resolveTask(board, 'tsk-03')?.id);
  out.push(classify('applyTagResult', { entries: [{ id: 'tsk-03', areas: ['src/x'] }, { id: 'new', title: '新卡', module: '发布运维', areas: [] }], ref: ref(1), now: 5000, options: {} }));
  out.push(classify('createPendingTask', { input: { taskId: 'tsk-pending', dirId: 'd1', sessionId: 's9', taskText: '待归类的新任务', origin: 'manual', now: 5100 } }));
  const t = board.tasks['tsk-01'];
  t.title = '宿主改名';
  t.refs.push(ref(2, 's2'));
  t.routing = { mode: 'task-bound', workerSessionId: 's2', oneWay: true };
  core.addRefToTask(board.tasks['tsk-02'], ref(3), 5200);
  core.setTaskRouting(board.tasks['tsk-02'], { mode: 'task-bound', workerSessionId: 's3', oneWay: true });
  out.push(core.groupRelatedTasks(board, 'tsk-01', 'tsk-02', 5300));
  out.push(core.relatedTaskGroup(board, 'tsk-02')?.id);
  out.push(core.taskLineageIds(board, 'tsk-02'));
  out.push(planning.createPlannedTask(board, { title: '规划任务', workflowStage: 'inbox', dirId: 'd1', dueAt: '2027-01-02' },
    { id: 'tsk-plan-fixed', now: 5400 })?.ok);
  out.push(planning.updatePlannedTask(board, 'tsk-05', { priority: 'low', expectedRevision: 1 }, { now: 5500 })?.ok);
  out.push(planning.movePlannedTask(board, 'tsk-00', { workflowStage: 'doing' }, { now: 5600 })?.ok);
  out.push(planning.rankAtEnd(board, 'doing', null, 'd1'));
  out.push(boardRule('lifecycle', { board, taskId: 'tsk-06', operation: 'archive', now: 5700 }));
  out.push(boardRule('lifecycle', { board, ids: ['tsk-07'], operation: 'barrier' }));
  out.push(boardRule('lifecycle', { board, ids: ['tsk-07'], operation: 'delete' }));
  delete board.tasks['tsk-08'];
  board.modules['mod-c'] = { id: 'mod-c', name: '文档', dirId: 'd1' };
  board.deletedTaskIds.push('tsk-legacy');
  out.push(classify('mergeTasks', { input: { sourceTaskId: 'tsk-09', targetTaskId: 'tsk-10', now: 5800 } }));
  out.push(core.taskLineageIds(board, 'tsk-10'));
  out.push(core.findModuleByName(board, '服务端', 'd1')?.id);
  out.push(core.reconcileTaskGroups(board) && Object.keys(board.taskGroups).length);
  return out;
}

function storeFor(raw, extra = {}) {
  return openBoardStore({ raw, verify: true, verifyIntervalMs: 0, logger: { log() {}, warn() {} }, ...extra });
}

test('常驻句柄与无状态整板路径：同一操作序列结果与最终板一致', () => {
  const reference = core.normalizeBoard(rawBoard());
  const store = storeFor(rawBoard());
  assert.deepEqual(plain(store.board), plain(reference), '打开时的规范化结果一致');
  const expected = scenario(reference);
  const actual = scenario(store.board);
  assert.deepEqual(plain(actual), plain(expected));
  assert.deepEqual(plain(store.board), plain(reference), 'JS 镜像与无状态结果一致');
  assert.deepEqual(store.snapshot(), plain(reference), 'Rust 常驻副本与无状态结果一致');
  assert.equal(store.verify(), true);
  store.close();
});

test('回填保持任务对象身份，规则只回传变化条目', () => {
  const store = storeFor(rawBoard());
  const held = store.board.tasks['tsk-03'];
  boardRule('applyTagResult', { op: 'classification', board: store.board, newIds: NEW_IDS,
    entries: [{ id: 'tsk-03', areas: ['src/held'] }], ref: ref(7), now: 6000, options: {} });
  assert.equal(store.board.tasks['tsk-03'], held, '同一个代理对象');
  assert.ok(held.areas.includes('src/held'));
  assert.ok(held.refs.some(r => r.userMsgId === 'ru7'));
  store.close();
});

test('嵌套写入与裸引用写入都能同步到常驻副本', () => {
  const store = storeFor(rawBoard());
  const task = store.board.tasks['tsk-02'];
  task.refs[0].excerpt = '嵌套改写';
  const mine = { mode: 'task-bound', workerSessionId: 's0', oneWay: true };
  task.routing = mine;
  mine.workerSessionId = 's7';               // 挂入后经裸引用再改
  // 下一次规则调用前就要带上裸引用的修改（不是等到落盘）。
  assert.deepEqual(core.taskLineageIds(store.board, 'tsk-02'), ['tsk-02']);
  const snap = store.snapshot();
  assert.equal(snap.tasks['tsk-02'].refs[0].excerpt, '嵌套改写');
  assert.equal(snap.tasks['tsk-02'].routing.workerSessionId, 's7');
  assert.equal(store.verify(), true);
  store.close();
});

test('事务回滚恢复内容、对象身份与键序，常驻副本同步回退', () => {
  const store = storeFor(rawBoard());
  const before = plain(store.board);
  const held = store.board.tasks['tsk-01'];
  const result = store.transaction(rollback => {
    planning.createPlannedTask(store.board, { title: '回滚掉', workflowStage: 'inbox', dirId: 'd1' }, { id: 'tsk-plan-tx', now: 1 });
    store.board.tasks['tsk-01'].title = '事务内改名';
    delete store.board.tasks['tsk-02'];
    store.board.revision = 99;
    rollback();
    return 'rolled';
  });
  assert.equal(result, 'rolled');
  assert.deepEqual(plain(store.board), before);
  assert.deepEqual(Object.keys(store.board.tasks), Object.keys(before.tasks), '键序也回到事务前');
  assert.equal(store.board.tasks['tsk-01'], held);
  assert.deepEqual(store.snapshot(), before);
  assert.throws(() => store.transaction(() => { store.board.tasks['tsk-03'].title = 'x'; throw new Error('boom'); }), /boom/);
  assert.equal(store.board.tasks['tsk-03'].title, before.tasks['tsk-03'].title, '抛错自动回滚');
  store.close();
});

test('规则报错与 panic：常驻副本半改的条目由宿主副本覆盖', () => {
  const store = storeFor(rawBoard());
  const before = plain(store.board);
  assert.throws(() => boardRule('lifecycle', { board: store.board, taskId: 'missing', operation: 'archive', now: 1 }),
    { code: 'task_not_found' });
  assert.deepEqual(store.snapshot(), before);
  // 畸形条目让规则 panic：同步入口返回结构化错误，进程不中止，副本不分叉。
  store.board.tasks['tsk-bad'] = [];
  const shaped = plain(store.board);
  assert.throws(() => boardRule('lifecycle', { board: store.board, taskId: 'tsk-bad', operation: 'archive', now: 1 }),
    { code: 'TASK_DOMAIN_PANIC' });
  assert.deepEqual(store.snapshot(), shaped);
  assert.equal(store.verify(), true);
  assert.equal(core.resolveTask(store.board, 'tsk-03').id, 'tsk-03', '之后仍可正常调用');
  store.close();
});

test('落盘直接写常驻副本；外部写者推高 revision 时保全并续写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-store-'));
  const file = path.join(dir, 'task_board.json');
  const repository = createTaskBoardRepository(file);
  const store = storeFor(rawBoard(), { repository });
  store.board.tasks['tsk-01'].title = '落盘前改名';
  store.board.revision = 8;
  const saved = store.persist(0);
  assert.equal(saved.ok, true);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.tasks['tsk-01'].title, '落盘前改名');
  assert.deepEqual(disk, store.snapshot());
  // 另一个写者把磁盘推到 20。
  createTaskBoardRepository(file).save({ ...disk, revision: 20 }, 8);
  store.board.revision = 9;
  const preserved = store.persist(8);
  assert.equal(preserved.revision, 21);
  assert.equal(preserved.conflict.diskRevision, 20);
  assert.equal(store.board.revision, 21, '冲突改写的 revision 回填到镜像');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).revision, 21);
  assert.ok(fs.existsSync(preserved.conflict.backup));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('异步只读与卡片缓存直接读常驻副本，结果与无状态一致', async () => {
  const reference = core.normalizeBoard(rawBoard());
  const store = storeFor(rawBoard());
  store.board.tasks['tsk-01'].title = '异步前改名';
  reference.tasks['tsk-01'].title = '异步前改名';
  const shellTasks = Object.keys(reference.tasks).map(id => ({ id, dirId: 'd1', ready: true }));
  const sync = taskDomain({ op: 'airVisible', board: reference, shellTasks });
  assert.deepEqual(await taskDomainAsync({ op: 'airVisible', board: store.board, shellTasks }), sync);
  const { createAirCardCache } = require('../src/workspace/air-card-cache');
  const command = board => ({ op: 'airInputs', board, records: [], admission: { workspaces: [], leases: [] }, shellTasks, epoch: null });
  const viaStore = await createAirCardCache({ mode: 'on' }).prepareAsync(command(store.board));
  const viaJson = await createAirCardCache({ mode: 'on' }).prepareAsync(command(reference));
  assert.deepEqual(viaStore, viaJson);
  store.close();
});

test('cloneBoard 对常驻板走 Rust 快照，结果是独立的普通对象', () => {
  const store = storeFor(rawBoard());
  const copy = cloneBoard(store.board);
  copy.tasks['tsk-01'].title = '改副本';
  assert.notEqual(store.board.tasks['tsk-01'].title, '改副本');
  assert.deepEqual(copy.tasks['tsk-02'], plain(store.board.tasks['tsk-02']));
  store.close();
});
