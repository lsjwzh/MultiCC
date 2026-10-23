'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAirReadIndex } = require('../src/workspace/air-read-index');
const { createAirSyncRuntime } = require('../src/workspace/air-sync-runtime');
const { create } = require('../public/air-sync');
const { createAirCardCache } = require('../src/workspace/air-card-cache');

const tick = () => new Promise(done => setImmediate(done));
const task = (id, patch = {}) => ({ id: String(id), dirId: 'd', title: `任务 ${id}`, status: 'active',
  runState: 'idle', lastMessageAt: Number(id) || 1, ...patch });
const snapshot = tasks => ({ ok: true, tasks, directories: [{ id: 'd', name: '项目' }], taskPins: [],
  taskTodos: [], taskTodoIgnored: [], sessions: [], migration: { errors: [] } });

test('后台逐卡核对分批让出事件循环，逻辑请求计数不随分批翻倍', async () => {
  const cache = createAirCardCache({ mode: 'on' }); const tasks = Array.from({ length: 1277 }, (_, i) => task(i));
  const options = { keyOf: t => t.id, signatureOf: t => t.title, build: t => ({ card: { ...t } }) };
  let yielded = false; setImmediate(() => { yielded = true; });
  const built = await cache.resolveAsync('version', tasks, options); assert.ok(yielded); assert.equal(built.builds, 1277);
  const hit = await cache.resolveAsync('version', tasks.slice(0, 1), { ...options, prune: false });
  assert.equal(hit.hits, 1); assert.equal(cache.stats().requests, 2);
  assert.equal((await cache.resolveAsync('version', tasks, options)).hits, 1277);
});

test('摘要索引：真正分页、跨页筛选、完整计数和置顶排序', () => {
  const index = createAirReadIndex();
  const data = snapshot(Array.from({ length: 1277 }, (_, i) => task(i, { runState: i === 2 ? 'running' : 'idle' })));
  data.taskPins = ['1']; data.taskTodos = ['3'];
  index.apply(data);
  const first = index.page({ dirId: 'd', limit: 20 });
  assert.equal(first.tasks.length, 20); assert.equal(first.total, 1277);
  assert.equal(first.tasks[0].id, '1');
  const second = index.page({ dirId: 'd', limit: 20, page: 2 });
  assert.equal(second.tasks.length, 20);
  assert.ok(second.tasks.every(t => !first.tasks.some(a => a.id === t.id)));
  assert.deepEqual(index.page({ status: 'running' }).tasks.map(t => t.id), ['2']);
  assert.deepEqual(index.page({ status: 'needs' }).tasks.map(t => t.id), ['3']);
  assert.equal(index.page({ status: 'all', query: '任务 0' }).tasks[0].id, '0');
  assert.equal(index.stats(0).d.total, 1277);
  assert.ok(index.bootstrap().tasks.length <= 31, '首屏不能把全任务状态带回来');
});

test('摘要索引：游标补齐、重复读取、删除标记和保留窗口过期', () => {
  const index = createAirReadIndex({ historyLimit: 2 });
  index.apply(snapshot([task(1), task(2)]));
  const start = index.cursor();
  const data = snapshot([task(1, { runState: 'running' }), task(2)]);
  const event = index.apply(data);
  assert.equal(event.tasks.length, 1); assert.equal(event.tasks[0].id, '1');
  assert.equal(index.changes(start).events.length, 1);
  assert.equal(index.apply(data), null, '没变化不能推进游标');
  const cached = index.serialized(); assert.equal(index.serialized(), cached);
  index.apply(snapshot([task(1, { runState: 'running' })]));
  assert.deepEqual(index.changes(start).events.at(-1).deleted, ['2']);
  index.apply(snapshot([task(1, { runState: 'succeeded' })]));
  assert.equal(index.changes(start).reset, true);
  assert.equal(index.changes('其他服务:2').reset, true);
  assert.notEqual(index.serialized(), cached);
});

test('摘要索引：缓存与原地修改隔离，单卡删除、忽略和今日计数一致', () => {
  const index = createAirReadIndex();
  const data = snapshot([task(1, { runState: 'error' }), task(2, { runState: 'succeeded', updatedAt: 500 })]);
  data.taskTodoIgnored = ['1']; index.apply(data);
  const before = index.cursor();
  data.tasks[0].title = '改名';
  assert.notEqual(index.page({ status: 'error' }).tasks[0].title, '改名');
  assert.equal(index.page({ status: 'needs' }).tasks.length, 0);
  assert.equal(index.stats(400).all.today, 1); assert.equal(index.stats(600).all.today, undefined);
  index.apply({ ...data, tasks: [data.tasks[0]] }, { partial: true, removed: ['2'] });
  assert.equal(index.changes(before).events[0].tasks.length, 1);
  assert.equal(index.page({ status: 'all' }).total, 1);
});

test('多客户端共享一个生产者；请求、重连和分页都不触发额外构建', async t => {
  let builds = 0, observer; const listeners = new EventEmitter();
  let data = snapshot([task(1), task(2)]);
  const runtime = createAirSyncRuntime({ index: createAirReadIndex(),
    build: async ids => { builds++; await tick(); return ids ? { ...data, tasks: data.tasks.filter(t => ids.includes(t.id)) } : data; },
    subscribe: fn => { observer = fn; listeners.on('change', fn); return () => listeners.off('change', fn); },
    taskIdsForSession: () => ['1'], send: (socket, event) => socket.frames.push(event),
  });
  t.after(() => runtime.close());
  await Promise.all(Array.from({ length: 20 }, () => runtime.ensureReady()));
  assert.equal(builds, 1);
  class Socket extends EventEmitter { readyState = 1; frames = []; close() { this.emit('close'); } }
  const a = new Socket(), b = new Socket(), start = runtime.index.cursor();
  runtime.attach(a, new URL('http://x?cursor=' + start));
  runtime.attach(b, new URL('http://x?cursor=' + start)); await tick();
  for (let i = 0; i < 100; i++) runtime.index.page({ page: i + 1 });
  assert.equal(builds, 1);
  data = snapshot([task(1, { runState: 'running' }), task(2)]);
  observer('d', { type: 'task_state', sessionId: 's' }); await runtime.flush();
  assert.equal(builds, 2);
  assert.equal(a.frames.at(-1).tasks.length, 1); assert.equal(b.frames.at(-1).cursor, a.frames.at(-1).cursor);
  const c = new Socket(); runtime.attach(c, new URL('http://x?cursor=' + start)); await tick();
  assert.equal(c.frames[0].tasks[0].runState, 'running'); assert.equal(builds, 2);
  a.close(); runtime.close(); assert.equal(listeners.listenerCount('change'), 0);
});

test('失败保留旧索引，恢复后继续推进', async t => {
  let fail = false, data = snapshot([task(1)]);
  const runtime = createAirSyncRuntime({ index: createAirReadIndex(), build: async () => {
    if (fail) throw new Error('失败'); return data;
  }, logger: { warn() {} }, send() {} });
  t.after(() => runtime.close());
  await runtime.ensureReady(); const first = runtime.index.cursor();
  fail = true; await runtime.flush(); assert.equal(runtime.index.cursor(), first);
  fail = false; data = snapshot([task(1, { runState: 'succeeded' })]);
  await runtime.flush(); assert.notEqual(runtime.index.cursor(), first);
});

test('事件提前唤醒周期核对；构建中再次变化会保留到下一轮', async t => {
  let observer, finish, builds = 0;
  let data = snapshot([task(1)]);
  const runtime = createAirSyncRuntime({ index: createAirReadIndex(), debounceMs: 5, reconcileMs: 60_000,
    subscribe: fn => { observer = fn; }, send() {}, build: async () => {
      builds++; const captured = structuredClone(data);
      if (builds === 2) await new Promise(done => { finish = done; });
      return captured;
    } });
  t.after(() => runtime.close()); await runtime.ensureReady();
  data.tasks[0].title = '第二版'; observer('d', { type: 'task_state', taskIds: ['1'] });
  const wait = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail('事件未及时处理'); };
  await wait(() => finish);
  data.tasks[0].title = '第三版'; observer('d', { type: 'task_state', taskIds: ['1'] });
  finish(); await wait(() => builds >= 3);
  assert.equal(runtime.index.page({ status: 'all' }).tasks[0].title, '第三版');
});

test('超长断线补齐有上限；过量事件重新分页引导', () => {
  const index = createAirReadIndex(); index.apply(snapshot([task(1)])); const cursor = index.cursor();
  for (let i = 0; i < 65; i++) index.apply(snapshot([task(1, { title: String(i) })]));
  assert.equal(index.changes(cursor).reset, true);
  assert.ok(index.bootstrap().tasks.length <= 30);
});

test('重连合并最终摘要，HTTP 补齐与同时到达的 WS 变化可以重叠', async t => {
  const index = createAirReadIndex(); index.apply(snapshot([task(1), task(2)]));
  const client = create({ Socket: null, request: async () => index.bootstrap() });
  t.after(() => client.close()); await client.sync(); const before = index.cursor();
  const one = index.apply(snapshot([task(1, { runState: 'running' }), task(2)]));
  client.delta(one);
  index.apply(snapshot([task(1, { runState: 'succeeded' })]));
  const replay = index.changes(before); assert.equal(replay.events.length, 1);
  assert.equal(replay.events[0].tasks.length, 1); assert.deepEqual(replay.events[0].deleted, ['2']);
  assert.ok(client.delta(replay.events[0])); assert.equal(client.current().tasks[0].runState, 'succeeded');
  assert.equal(client.current().tasks.length, 1);
  assert.equal(client.delta({ cursor: index.cursor().replace(/\d+$/, 'NaN'), previous: index.cursor() }), false);
});

test('关闭等待已开始的后台构建，不在关闭后再发布或安排核对', async () => {
  let finish, unsubscribe = 0, sends = 0;
  const runtime = createAirSyncRuntime({ index: createAirReadIndex(), build: () => new Promise(done => { finish = done; }),
    subscribe: () => () => unsubscribe++, send: () => sends++ });
  const building = runtime.flush(); const draining = runtime.close();
  let drained = false; draining.then(() => { drained = true; }); await tick(); assert.equal(drained, false);
  finish(snapshot([task(1)])); await building; await draining;
  assert.equal(unsubscribe, 1); assert.equal(sends, 0); assert.equal(runtime.index.isReady(), false);
});

test('前端：隐藏期间迟到的分页不生效，恢复后重新请求；失败会有界重试', async t => {
  const index = createAirReadIndex(); index.apply(snapshot([task(1)]));
  let finish, fail = false, calls = 0, paints = 0; const timers = [];
  const client = create({ Socket: null, schedule: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, cancel() {},
    onChange: () => paints++, request: async path => {
      const url = new URL(path, 'http://x');
      if (!url.pathname.endsWith('/page')) return url.searchParams.has('cursor') ? index.changes(url.searchParams.get('cursor')) : index.bootstrap();
      calls++; if (fail) throw Error('网络失败');
      return new Promise(done => { finish = () => done(index.page({ status: 'all' })); });
    } });
  t.after(() => client.close()); await client.sync();
  client.page('d', {}); client.pause(); finish(); await tick();
  const before = paints; client.resume(); await tick(); assert.ok(paints > before);
  client.page('d', {}); assert.equal(calls, 2); finish(); await tick();
  assert.equal(client.page('d', {}).tasks.length, 1);
  fail = true; client.page('err', {}); await tick();
  const count = calls; client.page('err', {}); assert.equal(calls, count, '失败不能立即循环请求');
  assert.ok(timers.some(timer => timer.ms >= 5000 && timer.ms < 6000), '分页需要自己的有界重试');
});

test('前端：新一代引导不被旧 pending 阻塞，同一游标重复帧不重画', async t => {
  let index = createAirReadIndex(); index.apply(snapshot([task(1)])); const completions = [];
  class Socket { readyState = 1; constructor() { Socket.instance = this; } close() {} }
  let paints = 0;
  const client = create({ Socket, socketUrl: async path => path, onChange: () => paints++, request: async path => {
    const url = new URL(path, 'http://x');
    if (url.pathname.endsWith('/page')) { const result = index.page({ status: 'all' }); return new Promise(done => completions.push(() => done(result))); }
    return url.searchParams.has('cursor') ? index.changes(url.searchParams.get('cursor')) : index.bootstrap();
  } });
  t.after(() => client.close()); await client.sync(); await tick(); client.page('d', {});
  index = createAirReadIndex(); index.apply(snapshot([task(1, { title: '新实例' })]));
  await client.sync(); client.page('d', {}); assert.equal(completions.length, 2);
  completions[0](); await tick(); completions[1](); await tick();
  assert.equal(client.page('d', {}).tasks[0].title, '新实例');
  const event = index.apply(snapshot([task(1, { runState: 'running' })]));
  Socket.instance.onmessage({ data: JSON.stringify(event) }); const before = paints;
  Socket.instance.onmessage({ data: JSON.stringify(event) }); assert.equal(paints, before);
});

test('前端：首次只读分页引导；校准无变化不重画；断线补齐且重复帧幂等', async t => {
  const index = createAirReadIndex(); index.apply(snapshot([task(1)]));
  const paths = []; let paints = 0;
  const client = create({ Socket: null, request: async path => {
    paths.push(path); const url = new URL(path, 'http://x');
    if (url.searchParams.has('cursor')) return index.changes(url.searchParams.get('cursor'));
    return index.bootstrap();
  }, onChange: () => paints++ });
  t.after(() => client.close());
  await client.sync(); const baseline = paints;
  await client.sync(); assert.equal(paints, baseline);
  assert.ok(paths.every(path => path.startsWith('/api/air/sync?')));
  const event = index.apply(snapshot([task(1, { runState: 'running' })]));
  await client.sync(); assert.equal(client.current().tasks[0].runState, 'running');
  assert.equal(client.delta(event), true);
  assert.equal(client.current().tasks[0].runState, 'running');
  assert.equal(client.delta({ ...event, previous: '错误:0', cursor: event.cursor.replace(/\d+$/, '999') }), false);
});

test('前端：迟到分页不能覆盖推送后的状态，重启更换代际后重新引导', async t => {
  let index = createAirReadIndex(); index.apply(snapshot([task(1)]));
  let finish, requested = false;
  const client = create({ Socket: null, request: async path => {
    const url = new URL(path, 'http://x');
    if (url.pathname.endsWith('/page')) {
      requested = true; const page = index.page({ status: 'all' });
      return new Promise(done => { finish = () => done(page); });
    }
    return url.searchParams.has('cursor') ? index.changes(url.searchParams.get('cursor')) : index.bootstrap();
  } });
  t.after(() => client.close()); await client.sync();
  client.page('d', { status: 'all' }); assert.ok(requested);
  client.delta(index.apply(snapshot([task(1, { runState: 'running' })])));
  finish(); await tick();
  assert.equal(client.current().tasks[0].runState, 'running');
  index = createAirReadIndex(); index.apply(snapshot([task(1, { runState: 'error' })]));
  await client.sync(); assert.equal(client.current().tasks[0].runState, 'error');
});

test('waitingReply 只筛等待回复，兼容 waiting 继续代表待处理集合', () => {
  const index = createAirReadIndex();
  index.apply(snapshot([task(1, { runState: 'waiting' }), task(2, { runState: 'error' }), task(3, { runState: 'running' })]));
  assert.deepEqual(index.page({ status: 'waitingReply' }).tasks.map(t => t.id), ['1']);
  assert.equal(index.page({ status: 'waiting' }).total, 2);
});

test('未挂到任务板的会话事件只重算元数据；工作区级事件仍走全量', async t => {
  let observer; const builtIds = [];
  let data = snapshot([task(1)]);
  const runtime = createAirSyncRuntime({ index: createAirReadIndex(),
    build: async ids => { builtIds.push(ids); return ids ? { ...data, tasks: data.tasks.filter(x => ids.includes(x.id)) } : data; },
    subscribe: fn => { observer = fn; }, send() {},
    taskIdsForSession: () => [], // 会话尚未挂到任何任务板任务（新任务首轮/aux）
  });
  t.after(() => runtime.close());
  await runtime.ensureReady();
  assert.deepEqual(builtIds.at(-1), null, '首启引导仍是全量');
  data = { ...data, sessions: [{ id: 'term-1' }] };
  observer('d', { type: 'task_state', sessionId: 'unlinked' });
  await runtime.flush();
  assert.deepEqual(builtIds.at(-1), [], '空集合应走仅元数据构建，不再全量重建任务卡');
  assert.deepEqual(runtime.index.snapshot().sessions, [{ id: 'term-1' }], '元数据照常推进');
  assert.deepEqual(runtime.index.page({ status: 'all' }).tasks.map(x => x.id), ['1'], '任务行不受影响');
  observer('d', { type: 'workspace_state' });
  await runtime.flush();
  assert.deepEqual(builtIds.at(-1), null, '无会话指向的事件保持全量');
});
