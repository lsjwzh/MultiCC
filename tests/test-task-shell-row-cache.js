'use strict';
// 回归守卫：任务壳的行缓存（store.cachedList / cachedEntries）必须省掉重复的
// 整表读与 JSON.parse，同时在内容变化时立刻失效。
// 背景：线上 task 表 514 行 / 4.5MB，一次 /api/air 要读两遍（迁移一次、任务板
// 刻画一次），每遍 12-20ms 外加几 MB 的临时分配。缓存的前提是「没变」这件事
// 判定得住 —— 同库文件上还有第二个连接（admission 的 store），漏掉它就会把
// 陈旧的行当成最新的发出去。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskShellStore } = require('../src/task-shell/store');

function storeFixture(t, file = 'shell.sqlite') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-shell-cache-'));
  const store = createTaskShellStore(path.join(dir, file));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}

test('内容没变时复用上一次解析出来的行，顺序与 list 一致', t => {
  const store = storeFixture(t);
  for (const id of ['tsk_1', 'tsk_2', 'tsk_3']) store.set('task', id, { id, sessionId: 's_' + id, title: id });
  const first = store.cachedList('task');
  assert.deepEqual(first, store.list('task'), '首次读与 list 完全一致');
  assert.deepEqual(first.map(task => task.id), ['tsk_1', 'tsk_2', 'tsk_3'], '保序（插入序）');
  // 命中缓存的判据：行对象被复用。重新解析会给出新对象，因此这里必须全等。
  const second = store.cachedList('task');
  assert.equal(second[0], first[0], '没变时必须复用同一行对象');
  assert.deepEqual(second, first);
  // 拿到的数组是副本：调用方 sort/push 不得污染缓存。
  second.push({ id: 'tsk_fake' });
  second.reverse();
  assert.equal(store.cachedList('task').length, 3, '数组副本被改写不影响缓存');
  assert.equal(store.cachedList('task')[0].id, 'tsk_1');
});

test('自己的写立刻失效（set 与 remove 都要）', t => {
  const store = storeFixture(t);
  store.set('task', 'tsk_1', { id: 'tsk_1', sessionId: 's1', title: '原标题' });
  assert.equal(store.cachedList('task')[0].title, '原标题');
  store.set('task', 'tsk_1', { id: 'tsk_1', sessionId: 's1', title: '新标题' });
  assert.equal(store.cachedList('task')[0].title, '新标题', 'set 之后必须重读');
  store.set('task', 'tsk_2', { id: 'tsk_2', sessionId: 's2', title: '第二条' });
  assert.equal(store.cachedList('task').length, 2, '新增的行必须出现');
  store.remove('task', 'tsk_1');
  assert.deepEqual(store.cachedList('task').map(task => task.id), ['tsk_2'], 'remove 之后必须重读');
  // 纯读不写不该让缓存失效（否则缓存等于没有）。
  const held = store.cachedList('task')[0];
  store.list('task');
  assert.equal(store.cachedList('task')[0], held, '只读不写不失效');
});

test('另一个连接写入也必须失效 —— admission 的 store 就是同库第二个连接', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-shell-cache-'));
  const file = path.join(dir, 'shell.sqlite');
  const reader = createTaskShellStore(file), writer = createTaskShellStore(file);
  t.after(() => { reader.close(); writer.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  writer.set('task', 'tsk_1', { id: 'tsk_1', sessionId: 's1', title: '外部连接写的' });
  assert.equal(reader.cachedList('task').length, 1, '外部提交后首个读者必须看见它');
  const held = reader.cachedList('task')[0];
  writer.set('task', 'tsk_2', { id: 'tsk_2', sessionId: 's2', title: '外部连接又写' });
  assert.equal(reader.cachedList('task').length, 2, '同一个库文件的第二个连接写入后必须重读');
  assert.notEqual(reader.cachedList('task')[0], held);
  writer.remove('task', 'tsk_1');
  assert.deepEqual(reader.cachedList('task').map(task => task.id), ['tsk_2']);
});

test('entries 缓存同样按内容失效，且只对白名单里的小表开放', t => {
  const store = storeFixture(t);
  store.set('task-first:indexed', 'tsk_1', { taskId: 'tsk_1', sessionId: 's1', version: 1 });
  const first = store.cachedEntries('task-first:indexed');
  assert.deepEqual(first.map(([id]) => id), ['tsk_1']);
  assert.equal(store.cachedEntries('task-first:indexed')[0], first[0], '没变时复用');
  store.set('task-first:indexed', 'tsk_2', { taskId: 'tsk_2', sessionId: 's2', version: 1 });
  assert.deepEqual(store.cachedEntries('task-first:indexed').map(([id]) => id), ['tsk_1', 'tsk_2']);
  assert.deepEqual(store.cachedEntries('task-first:indexed'), store.entries('task-first:indexed'));
  // receipt 一张表就 201MB：白名单外必须报错，而不是悄悄退化成不缓存。
  assert.throws(() => store.cachedList('receipt'), /row cache not allowed for kind receipt/);
  assert.throws(() => store.cachedEntries('link'), /row cache not allowed for kind link/);
});

test('热路径必须走缓存版（防止以后悄悄退回 store.list）', () => {
  const runtime = fs.readFileSync(path.join(__dirname, '..', 'src', 'task-shell', 'runtime.js'), 'utf8');
  const taskFirst = fs.readFileSync(path.join(__dirname, '..', 'src', 'task-shell', 'task-first.js'), 'utf8');
  // listTasks 是 /api/air 每轮都要走的读投影入口。
  assert.match(runtime, /listTasks: \(\) => store\.cachedList\('task'\)/);
  assert.match(taskFirst, /store\.cachedList\('task'\)/);
  assert.match(taskFirst, /store\.cachedEntries\('task-first:indexed'\)/);
  assert.doesNotMatch(taskFirst, /store\.list\('task'\)/);
});
