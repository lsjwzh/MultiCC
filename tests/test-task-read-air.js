'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTaskReadModel } = require('../src/native/task-read-model');
const { getNative } = require('../src/native/runtime');
const { createAirReadIndex } = require('../src/workspace/air-read-index');
const { fixtures, project } = require('./helpers/task-read-model');
const { create: createClient } = require('../public/air-sync');
const addon = getNative('read_model', process.env.MULTICC_REQUIRE_RUST_TESTS === '1' ? 'rust' : 'auto');
const native = typeof addon?.RustTaskReadModel === 'function';
if (!native && process.env.MULTICC_REQUIRE_RUST_TESTS === '1') throw Error('read_model_backend_unavailable');
const run = (name, fn) => test(name, { skip: !native }, fn);
const card = (n, patch = {}) => ({ id: `tsk_${n}`, title: `任务 ${n}`, dirId: 'd', status: 'active', runState: 'idle', updatedAt: n, lastMessageAt: n, ...patch });
const snapshot = tasks => ({ ok: true, directories: [{ id: 'd', name: '项目' }], taskPins: [], taskTodos: [], taskTodoIgnored: [], tasks });
async function setup(t, options = {}) {
  const model = createTaskReadModel({ addon }), node = createAirReadIndex(options), epoch = randomUUID();
  t.after(() => model.close());
  const rust = command => model.run({ op: 'air', command });
  await rust({ op: 'open', epoch, ...options });
  const normalize = value => JSON.parse(JSON.stringify(value).replaceAll(node.cursor().split(':')[0], epoch));
  async function compare(command, expected) { const got = await rust(command); assert.deepEqual(got, normalize(expected)); return got; }
  return { rust, node, compare, normalize, async apply(data, options = {}) {
    return compare({ op: 'apply', snapshot: data, ...options }, node.apply(data, options));
  } };
}
run('Air 全量及逐卡增删改、仅元数据、重复输入与源对象隔离', async t => {
  const f = await setup(t), data = snapshot([card(1), card(2)]);
  await f.compare({ op: 'changes' }, f.node.changes());
  await f.apply(data); const cursor = f.node.cursor();
  await f.apply(data);
  data.tasks[0].runState = 'running'; await f.apply(data);
  await f.apply({ ...data, tasks: [card(2, { runState: 'succeeded' })] }, { partial: true, removed: ['tsk_1'] });
  await f.apply({ ...data, taskTodos: ['tsk_2'], tasks: [] }, { partial: true });
  await f.compare({ op: 'changes', since: f.normalize(cursor) }, f.node.changes(cursor));
  await f.compare({ op: 'snapshot' }, f.node.snapshot());
  data.taskTodos.push('tsk_1'); await f.compare({ op: 'snapshot' }, f.node.snapshot());
});
run('Air 引导集合、置顶、include 上限、提醒、分页筛选与统计逐字段对照', async t => {
  const f = await setup(t), data = fixtures(140), snap = { ...data.metadata, tasks: data.tasks.map(task => project(task, data.overlays)) };
  await f.apply(snap);
  const include = data.tasks.slice().reverse().map(task => task.id);
  await f.compare({ op: 'bootstrap', include, dayStart: 5002 }, f.node.bootstrap({ include, dayStart: 5002 }));
  for (const status of ['all', 'needs', 'waitingReply', 'todo', 'archived', 'today', 'running', 'achieved', 'interact']) {
    const options = { status, page: 2, limit: 7, query: '中文', dayStart: 5002 };
    await f.compare({ op: 'page', options }, f.node.page(options));
  }
  await f.compare({ op: 'stats', dayStart: 5002 }, f.node.stats(5002));
});
run('Air 断线只重放最终摘要，删除后重建与重复删除保持顺序', async t => {
  const f = await setup(t); let data = snapshot([card(1), card(2), card(3)]); await f.apply(data);
  const cursor = f.node.cursor();
  await f.apply(snapshot([card(1, { runState: 'running' }), card(2), card(3)]));
  await f.apply(snapshot([card(3)]));
  await f.apply(snapshot([card(2, { runState: 'error' }), card(3)]));
  await f.apply(snapshot([card(2, { runState: 'succeeded', goalState: 'interact' })]), { partial: true, removed: ['tsk_3', 'tsk_3', 'absent'] });
  await f.compare({ op: 'changes', since: f.normalize(cursor) }, f.node.changes(cursor));
});
run('Air 有界历史过期、跨代、未来和无效游标均重置', async t => {
  const f = await setup(t, { historyLimit: 2 }); await f.apply(snapshot([card(1)]));
  const cursor = f.node.cursor();
  for (let i = 0; i < 4; i++) await f.apply(snapshot([card(1, { title: String(i) })]));
  for (const since of [cursor, 'other:2', '', cursor.replace(/\d+$/, '999'), cursor.replace(/\d+$/, 'NaN'), f.node.cursor()]) {
    await f.compare({ op: 'changes', since: f.normalize(since) }, f.node.changes(since));
  }
  const previous = (await f.rust({ op: 'cursor' })).cursor;
  await f.rust({ op: 'open', epoch: randomUUID() });
  assert.deepEqual(await f.rust({ op: 'changes', since: previous }), { ok: false, code: 'air_warming' });
  await f.rust({ op: 'apply', snapshot: snapshot([card(1)]) });
  assert.equal((await f.rust({ op: 'changes', since: previous })).reset, true);
});
run('Air 超过 64 帧、累计字节上限及单个大事件使用 reset', async t => {
  for (const options of [{}, { maxDeltaBytes: 950 }]) {
    const f = await setup(t, options); await f.apply(snapshot([card(1)])); const cursor = f.node.cursor();
    for (let i = 0; i < 65; i++) await f.apply(snapshot([card(1, { title: String(i) })]));
    await f.compare({ op: 'changes', since: f.normalize(cursor) }, f.node.changes(cursor));
    await f.apply(snapshot([card(1, { title: '长'.repeat(100000) })]));
    await f.compare({ op: 'changes', since: f.normalize(cursor) }, f.node.changes(cursor));
  }
});
run('Air 单帧 UTF-8 字节边界与当前 Node 的 reset 阈值一致', async t => {
  for (const numeric of [1, 0.000001, 1e-7, -0, 333333333.3333333]) {
    const probe = createAirReadIndex(); probe.apply(snapshot([card(1)]));
    const next = { ...snapshot([card(1, { title: '中文 😀' })]), budgets: { numeric } };
    const bytes = Buffer.byteLength(JSON.stringify(probe.apply(next)));
    for (const maxDeltaBytes of [bytes - 1, bytes, bytes + 1]) {
      const f = await setup(t, { maxDeltaBytes }); await f.apply(snapshot([card(1)])); await f.apply(next);
    }
  }
});
run('Air 非法输入不推进游标、快照或重放窗口', async t => {
  const f = await setup(t); await f.apply(snapshot([card(1)])); const before = await f.rust({ op: 'snapshot' }), cursor = await f.rust({ op: 'cursor' });
  for (const data of [snapshot([card(1), card(1)]), snapshot([card(1, { runState: {} })]), { taskPins: {} }, snapshot([card(1, { updatedAt: 'bad' })])]) {
    await assert.rejects(f.rust({ op: 'apply', snapshot: data }), /invalid/);
    assert.deepEqual(await f.rust({ op: 'snapshot' }), before); assert.deepEqual(await f.rust({ op: 'cursor' }), cursor);
  }
});
run('Air 历史 ID 沿用 ICU，新增、删除和同时间排序兼容', async t => {
  const f = await setup(t), ids = ['任务甲', 'a-b', 'a_b', 'tsk_A', 'task-Z'];
  let cards = ids.map(id => ({ ...card(1), id })); await f.apply(snapshot(cards));
  await f.compare({ op: 'page', options: { status: 'all' } }, f.node.page({ status: 'all' }));
  cards = cards.slice(1).concat({ ...card(1), id: '任务乙' }); await f.apply(snapshot(cards));
  await f.compare({ op: 'bootstrap' }, f.node.bootstrap());
});
run('Rust Air 输出直接交给现有客户端，重复帧、离线补齐与换代恢复可用', async t => {
  const f = await setup(t); await f.apply(snapshot([card(1), card(2)]));
  const client = createClient({ Socket: null, request: async path => {
    const url = new URL(path, 'http://test'); return f.rust(url.searchParams.has('cursor')
      ? { op: 'changes', since: url.searchParams.get('cursor') } : { op: 'bootstrap' });
  } });
  t.after(() => client.close()); await client.sync();
  const live = await f.apply(snapshot([card(1, { runState: 'running' }), card(2)]));
  assert.equal(client.delta(live), true); assert.equal(client.delta(live), true);
  await f.apply(snapshot([card(1, { runState: 'succeeded' })])); await client.sync();
  assert.equal(client.current().tasks.length, 1); assert.equal(client.current().tasks[0].runState, 'succeeded');
  await f.rust({ op: 'open', epoch: randomUUID() }); await f.rust({ op: 'apply', snapshot: snapshot([card(3)]) });
  await client.sync(); assert.deepEqual(client.current().tasks.map(task => task.id), ['tsk_3']);
});
run('沿用真实 Air 卡片生产者验证可见性与动态字段，Rust 不猜权限或状态', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { mountAirRoutes } = require('../src/workspace/air-routes');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rust-air-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const board = { tasks: {}, deletedTaskIds: ['tsk_2'] }, shells = [], records = new Map();
  for (let i = 1; i <= 7; i++) {
    board.tasks[`tsk_${i}`] = { ...card(i), sessionId: `s${i}`, dirId: 'd', createdAt: i };
    records.set(`s${i}`, { id: `s${i}`, kind: 'chat', dirId: 'd', provider: 'p', taskState: { goalState: 'achieved' } });
  }
  board.tasks.tsk_3.mergedIntoTaskId = 'tsk_1';
  shells.push({ id: 'tsk_4', embedded: true }, { id: 'tsk_5', separatedFromTaskId: 'tsk_1', ready: false }, { id: 'tsk_6', separatedFromTaskId: 'tsk_1', ready: true });
  let dirty = false, readOnly = true, capacity = null;
  const handlers = new Map(), runtime = mountAirRoutes({ get: (p, fn) => handlers.set(p, fn), post() {} }, {
    getBoard: () => board, records, directories: new Map([['d', { id: 'd', name: '项目', path: '/isolated' }]]), clis: ['codex'],
    pinsFile: path.join(dir, 'pins.json'), registerSync() {}, send() {}, providerName: () => '线路名称',
    admission: { snapshot: () => ({ workspaces: [{ id: 'ws1', ownerId: 's1', dirId: 'd', residency: 'resident' }], leases: [], budgets: {} }), capacityReason: () => capacity },
    shell: { listTasks: () => shells, taskAccess: () => ({ readOnly, shellId: 'shell' }) },
    mergeStateCached: () => ({ dirty, ahead: 2 }),
  });
  t.after(() => runtime.close());
  await runtime.ensureReady();
  const f = await setup(t); let data = await runtime.query('snapshot');
  assert.deepEqual(data.tasks.map(c => c.id).sort(), ['tsk_1', 'tsk_6', 'tsk_7']);
  await f.apply(data); assert.deepEqual(await f.rust({ op: 'snapshot' }), data);
  const cursor = (await f.rust({ op: 'cursor' })).cursor;
  board.tasks.tsk_1.runState = 'waiting'; records.get('s1').taskState.goalState = 'interact'; readOnly = false; dirty = true; capacity = 'workspace_execution_capacity';
  shells.find(s => s.id === 'tsk_5').ready = true; board.deletedTaskIds.push('tsk_7');
  runtime.invalidate(); await runtime.flush(); data = await runtime.query('snapshot');
  // Pass exactly the producer's visible cards. Hidden pins/includes never revive
  // merged, deleted, embedded or unready split tasks in the Rust consumer.
  await f.apply(data);
  const got = await f.rust({ op: 'bootstrap', include: ['tsk_2', 'tsk_3', 'tsk_4', 'tsk_7'] });
  assert.deepEqual(got.tasks.map(c => c.id).sort(), ['tsk_1', 'tsk_5', 'tsk_6']);
  const one = got.tasks.find(c => c.id === 'tsk_1');
  assert.equal(one.runState, 'waiting'); assert.equal(one.goalState, 'interact');
  assert.equal(one.readOnly, false); assert.equal(one.providerName, '线路名称');
  assert.deepEqual(one.worktreeChanges, { dirty: true, ahead: 2 }); assert.equal(one.resource.capacityReason, capacity);
  const replay = await f.rust({ op: 'changes', since: cursor });
  assert.deepEqual(replay.events[0].deleted, ['tsk_7']);
  await f.compare({ op: 'stats', dayStart: 0 }, await runtime.query('stats', 0));
});
run('固定种子混合 180 次更新，查询、引导和重放始终与 Node 一致', async t => {
  const f = await setup(t, { historyLimit: 50 }); const rows = new Map(); let seed = 51;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  let data = snapshot([]); await f.apply(data); let since = f.node.cursor();
  for (let i = 0; i < 180; i++) {
    const id = random(20), key = `tsk_${id}`, action = random(5);
    if (action === 0) rows.delete(key); else rows.set(key, card(id, { title: `任务 ${i}`, runState: ['running', 'waiting', 'succeeded', 'error'][random(4)], goalState: 'interact' }));
    data = { ...data, taskPins: [`tsk_${random(20)}`], taskTodos: [`tsk_${random(20)}`], tasks: [...rows.values()] };
    if (i % 3) await f.apply({ ...data, tasks: rows.has(key) ? [rows.get(key)] : [] }, { partial: true, removed: rows.has(key) ? [] : [key] });
    else await f.apply(data);
    if (i % 7 === 0) {
      await f.compare({ op: 'changes', since: f.normalize(since) }, f.node.changes(since)); since = f.node.cursor();
      await f.compare({ op: 'bootstrap', include: ['tsk_19'], dayStart: 4 }, f.node.bootstrap({ include: ['tsk_19'], dayStart: 4 }));
      for (const status of ['all', 'needs', 'todo']) await f.compare({ op: 'page', options: { status, limit: 3, page: 2 } }, f.node.page({ status, limit: 3, page: 2 }));
    }
  }
});
