'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAirReadIndex } = require('./helpers/legacy-air-read-index');
const { createAirSyncRuntime } = require('../src/native/binding').airSyncRuntime;
const airIssueApi = require('../src/native/binding').airIndexPort;
const { airNotices: airNoticeHooks } = airIssueApi;
const { createAirStorageNotice } = airIssueApi;
const { create } = require('../public/air-sync');
const { createAirCardCache } = require('../src/native/binding').airCardCache;

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

test('待办元数据写入后，快照和分页等待摘要索引更新', async t => {
  const data = snapshot([task(1, { runState: 'error' })]);
  data.taskTodoIgnored = ['1'];
  const runtime = createAirSyncRuntime({ index: createAirReadIndex(), build: async () => structuredClone(data),
    send() {}, debounceMs: 60_000 });
  t.after(() => runtime.close());
  await runtime.ensureReady();
  data.taskTodoIgnored = [];
  runtime.invalidate([]);
  const [fresh, page] = await Promise.all([runtime.syncHttp({}), runtime.pageHttp({ status: 'needs' })]);
  assert.deepEqual(fresh.taskTodoIgnored, []);
  assert.deepEqual(page.tasks.map(item => item.id), ['1']);
});

test('摘要构建进行中发生新写入时，读取等待包含新写入的下一次构建', async t => {
  const data = snapshot([task(1, { runState: 'error' })]);
  data.taskTodoIgnored = ['1'];
  let hold = false, release, started;
  const building = new Promise(resolve => { started = resolve; });
  const runtime = createAirSyncRuntime({ index: createAirReadIndex(), send() {}, debounceMs: 60_000,
    build: async () => {
      const captured = structuredClone(data);
      if (hold) { started(); await new Promise(resolve => { release = resolve; }); }
      return captured;
    } });
  t.after(() => runtime.close());
  await runtime.ensureReady();
  hold = true;
  runtime.invalidate([]);
  const oldBuild = runtime.flush();
  await building;
  hold = false;
  data.taskTodoIgnored = [];
  runtime.invalidate([]);
  const read = runtime.syncHttp({});
  release();
  await oldBuild;
  assert.deepEqual((await read).taskTodoIgnored, []);
});

test('元数据更新失败时不返回旧快照，恢复后可读取', async t => {
  const data = snapshot([task(1)]);
  let fail = false;
  const runtime = createAirSyncRuntime({ index: createAirReadIndex(), send() {}, debounceMs: 60_000,
    logger: { warn() {} }, build: async () => { if (fail) throw new Error('fixture unavailable'); return structuredClone(data); } });
  t.after(() => runtime.close());
  await runtime.ensureReady();
  data.taskTodos = ['1']; fail = true;
  runtime.invalidate([]);
  await assert.rejects(runtime.syncHttp({}), error => error.status === 503 && error.code === 'air_refresh_pending');
  await assert.rejects(runtime.pageHttp({ status: 'all' }), error => error.status === 503 && error.code === 'air_refresh_pending');
  fail = false;
  await runtime.flush();
  assert.deepEqual((await runtime.syncHttp({})).taskTodos, ['1']);
});

test('元数据构建卡住时读取有界失败，后台恢复后可读取', async t => {
  const data = snapshot([task(1)]);
  let hold = false, release;
  const runtime = createAirSyncRuntime({ index: createAirReadIndex(), send() {}, debounceMs: 60_000,
    build: async () => { if (hold) await new Promise(resolve => { release = resolve; }); return structuredClone(data); } });
  t.after(async () => { release?.(); await runtime.close(); });
  await runtime.ensureReady();
  data.taskTodos = ['1']; hold = true;
  runtime.invalidate([]);
  await assert.rejects(runtime.syncHttp({}), error => error.status === 503 && error.code === 'air_refresh_pending');
  hold = false; release();
  await runtime.flush();
  assert.deepEqual((await runtime.syncHttp({})).taskTodos, ['1']);
});

test('冷启动告知磁盘写满、退避不重建、模块错配另报，恢复后可读', async t => {
  let calls = 0, failure = Object.assign(new Error('write /private/session/path'), { code: 'ENOSPC' });
  const runtime = createAirSyncRuntime({ index: createAirReadIndex(), logger: { warn() {} },
    build: async () => { calls++; if (failure) throw new Error('save failed', { cause: failure }); return snapshot([task(1)]); } });
  t.after(() => runtime.close());
  await assert.rejects(runtime.ensureReady(), { status: 507, code: 'ENOSPC', message: /磁盘空间不足/ });
  await assert.rejects(runtime.ensureReady(), error => !error.message.includes('/private') && error.code === 'ENOSPC');
  assert.equal(calls, 1);
  failure = new Error('invalid_task_domain_command');
  await runtime.flush();
  await assert.rejects(runtime.ensureReady(), { status: 503, code: 'invalid_task_domain_command', message: /模块/ });
  failure = new Error('disk I/O error');
  await runtime.flush();
  await assert.rejects(runtime.ensureReady(), { status: 503, code: 'EIO' });
  failure = null;
  await runtime.flush();
  await runtime.ensureReady();
});

test('已加载的首页收到持久化告警、保留任务，并在服务解除告警时清除提示', async t => {
  const notice = createAirStorageNotice();
  const runtime = createAirSyncRuntime({ index: createAirReadIndex(), build: async () => snapshot([task(1)]),
    storageNotice: notice.current, send: (socket, frame) => socket.onmessage({ data: JSON.stringify(frame) }) });
  // /api/air/sync 的公开注册已迁 Rust 前门；这里直调处理器原体。
  const handlers = { '/api/air/sync': ({ query }) => runtime.syncHttp(query || {}) };
  let socket, issue;
  class Socket extends EventEmitter {
    readyState = 1;
    constructor() { super(); socket = this; }
    close() { this.emit('close'); }
  }
  const client = create({ Socket, socketUrl: url => url, onIssue: next => { issue = next; },
    request: url => handlers['/api/air/sync']({ query: Object.fromEntries(new URL(url, 'http://localhost').searchParams) }) });
  t.after(async () => { client.close(); await runtime.close(); });
  await client.sync();
  await runtime.attach(socket, new URL('http://localhost/?cursor=' + runtime.index.cursor()));
  assert.equal(notice.record(Object.assign(new Error('private SQL'), { code: 'SQLITE_FULL' })), true);
  runtime.publishStatus();
  assert.equal(issue.code, 'SQLITE_FULL');
  assert.equal(client.current().tasks[0].id, '1');
  await client.sync();
  assert.match(issue.message, /容量限制/);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(300_001);
  runtime.publishStatus();
  assert.equal(issue, null);
});

test('局部刷新失败只重试那几张卡，不升级成全量；重试间隔按失败次数退避', async t => {
  const calls = [], warnings = [];
  let fail = false, data = snapshot([task(1), task(2)]);
  const runtime = createAirSyncRuntime({ index: createAirReadIndex(),
    build: async ids => {
      calls.push(ids);
      if (fail) throw Object.assign(new Error('owner unavailable'), { code: 'SESSION_SESSION_WORK_OWNER_UNAVAILABLE' });
      return ids ? { ...data, tasks: data.tasks.filter(task => ids.includes(task.id)) } : data;
    },
    logger: { warn: (event, fields) => warnings.push({ event, ...fields }) }, send() {} });
  t.after(() => runtime.close());
  await runtime.ensureReady();
  assert.equal(calls[0], null, '首轮是全量');
  await runtime.flush(); assert.equal(calls[1], null, '没有变化时走周期性全量核对');
  fail = true; runtime.invalidate(['1']);
  await runtime.flush();
  assert.deepEqual(calls.at(-1), ['1'], '失败的是局部刷新');
  assert.equal(warnings.at(-1).full, false, '不得把局部失败报成全量');
  const firstRetry = warnings.at(-1).retryInMs;
  fail = true; await runtime.flush();
  assert.deepEqual(calls.at(-1), ['1'], '失败后仍然只重试这一张卡');
  assert.ok(warnings.at(-1).retryInMs > firstRetry, '连续失败应退避');
  fail = false; await runtime.flush();
  assert.equal(warnings.at(-1).event, 'air_sync_refresh_failed', '成功前不重置告警计数');
  fail = false; runtime.invalidate(['2']); await runtime.flush();
  assert.deepEqual(calls.at(-1), ['2'], '恢复后继续按局部刷新');
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

test('前端：切筛选时不复用旧分页统计，同筛选翻页仍保留统计', async t => {
  const index = createAirReadIndex();
  index.apply(snapshot(Array.from({ length: 45 }, (_, i) => task(i + 1))));
  const completions = [];
  let failPage = false;
  const client = create({ Socket: null, request: async path => {
    const url = new URL(path, 'http://x');
    if (!url.pathname.endsWith('/page')) return index.bootstrap();
    if (failPage) throw new Error('fixture unavailable');
    const result = index.page({ status: 'all', page: Number(url.searchParams.get('page')) || 1 });
    return new Promise(done => completions.push(() => done(result)));
  } });
  t.after(() => client.close());
  await client.sync();
  client.page('directory', { status: 'all', page: 1 });
  completions.shift()(); await tick();
  assert.equal(client.page('directory', { status: 'all', page: 1 }).pages, 3);
  const next = client.page('directory', { status: 'all', page: 2 });
  assert.equal(next.loading, true);
  assert.equal(next.pages, 3, '同一筛选的页数仍可用于翻页');
  completions.shift()(); await tick();
  const filtered = client.page('directory', { status: 'all', query: '任务 07', page: 1 });
  assert.equal(filtered.loading, true);
  assert.equal(filtered.pages, 1, '筛选变化时不得展示上一筛选的分页');
  assert.equal(filtered.total, 0, '筛选变化时不得展示上一筛选的总数');
  completions.shift()(); await tick();
  failPage = true;
  client.page('directory', { status: 'all', query: '不存在', page: 1 });
  await tick();
  const failed = client.page('directory', { status: 'all', query: '不存在', page: 1 });
  assert.deepEqual(failed.tasks, [], '筛选请求失败不能把旧筛选任务当作当前结果');
  assert.equal(failed.pages, 1);
  assert.equal(failed.total, 0);
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

// /api/air/sync 与 /api/air/page 的公开注册迁到 Rust 前门后，处理器原体是
// runtime.syncHttp/pageHttp；这里钉住原 req.query 上的全部 JS 强制转换。
test('syncHttp：dayStart/cursor/include 的退役强制转换逐条保持', async t => {
  const calls = [];
  const index = {
    isReady: () => true, cursor: () => 'c0',
    publish: async () => ({ event: null, stats: [] }),
    sync: async (since, day) => { calls.push(['sync', since, day]); return { events: [], cursor: 'c1' }; },
    bootstrap: async options => { calls.push(['bootstrap', options]); return { cursor: 'c0', taskStats: { all: { total: 0 } } }; },
    close: async () => {},
  };
  const runtime = createAirSyncRuntime({ index, build: async () => snapshot([]), send: () => {}, logger: { warn() {} } });
  t.after(() => runtime.close());
  await runtime.syncHttp({});
  assert.deepEqual(calls.pop(), ['bootstrap', { include: [], dayStart: 0 }]);
  await runtime.syncHttp({ dayStart: '5', include: 'a,b,,c' });
  assert.deepEqual(calls.pop(), ['bootstrap', { include: ['a', 'b', 'c'], dayStart: 5 }]);
  // Number(['5']) === 5，Number(['5','6']) 与 Number({}) 都是 NaN → ||0
  await runtime.syncHttp({ dayStart: ['5'] });
  assert.deepEqual(calls.pop(), ['bootstrap', { include: [], dayStart: 5 }]);
  await runtime.syncHttp({ dayStart: ['5', '6'], include: ['x', 'y'] });
  assert.deepEqual(calls.pop(), ['bootstrap', { include: ['x', 'y'], dayStart: 0 }]);
  await runtime.syncHttp({ dayStart: { a: 1 } });
  assert.deepEqual(calls.pop(), ['bootstrap', { include: [], dayStart: 0 }]);
  // String({}) === '[object Object]'，切分后是一个元素
  await runtime.syncHttp({ include: {} });
  assert.deepEqual(calls.pop(), ['bootstrap', { include: ['[object Object]'], dayStart: 0 }]);
  // cursor truthy → readSync 臂；since 原样进 index.sync（String 强转在读索引适配层里）
  await runtime.syncHttp({ cursor: 'c9', dayStart: '7' });
  assert.deepEqual(calls.pop(), ['sync', 'c9', 7]);
  await runtime.syncHttp({ cursor: ['a', 'b'] });
  assert.deepEqual(calls.pop(), ['sync', ['a', 'b'], 0]);
  // 空字符串 cursor 是 falsy → bootstrap 臂
  await runtime.syncHttp({ cursor: '' });
  assert.deepEqual(calls.pop(), ['bootstrap', { include: [], dayStart: 0 }]);
  // 响应合成：结果展开 + checkedAt + statusFields
  const reply = await runtime.syncHttp({ cursor: 'c9' });
  assert.equal(reply.cursor, 'c1');
  assert.equal(typeof reply.checkedAt, 'number');
  assert.equal(reply.degraded, false);
  calls.pop();
});

test('pageHttp：visits 的截断解析与 ids 的 undefined/空串/列表形状', async t => {
  const calls = [];
  const index = {
    isReady: () => true, cursor: () => 'c0',
    publish: async () => ({ event: null, stats: [] }),
    page: async options => { calls.push(['page', options]); return { ok: true, tasks: [] }; },
    close: async () => {},
  };
  const runtime = createAirSyncRuntime({ index, build: async () => snapshot([]), send: () => {}, logger: { warn() {} } });
  t.after(() => runtime.close());
  // 未知键照原样透传（退役的 {...req.query, ...} 展开语义）
  await runtime.pageHttp({ status: 'all', foo: 'ignored' });
  assert.deepEqual(calls.pop(), ['page', { status: 'all', foo: 'ignored', visits: {}, ids: null }]);
  await runtime.pageHttp({ ids: '' });
  assert.deepEqual(calls.pop(), ['page', { ids: [], visits: {} }]);
  await runtime.pageHttp({ ids: ['a', 'b'], visits: '{"x":2}' });
  assert.deepEqual(calls.pop(), ['page', { ids: ['a', 'b'], visits: { x: 2 } }]);
  await runtime.pageHttp({ visits: 'not-json' });
  assert.deepEqual(calls.pop(), ['page', { visits: {}, ids: null }]);
  // String(['a','b']) === 'a,b' 不是 JSON → {}；String({}) 同理
  await runtime.pageHttp({ visits: ['a', 'b'] });
  assert.deepEqual(calls.pop(), ['page', { visits: {}, ids: null }]);
  // 10000 个 UTF-16 单元处截断：切断代理对后 JSON 必坏 → {}
  await runtime.pageHttp({ visits: `{"ok":"${'𐐷'.repeat(4999)}"}` });
  assert.deepEqual(calls.pop(), ['page', { visits: {}, ids: null }]);
});

test('syncHttp/pageHttp：关闭后是 air_closed，串行队列满时是 air_busy', async t => {
  const closed = createAirSyncRuntime({ index: { isReady: () => true, close: async () => {} },
    build: async () => snapshot([]), send: () => {}, logger: { warn() {} } });
  await closed.close();
  await assert.rejects(closed.syncHttp({}), e => e.status === 503 && e.code === 'air_closed');
  await assert.rejects(closed.pageHttp({}), e => e.status === 503 && e.code === 'air_closed');

  let release; const gate = new Promise(r => { release = r; });
  const index = {
    isReady: () => true, cursor: () => 'c',
    publish: async () => ({ event: null, stats: [] }),
    sync: async () => { await gate; return { events: [], cursor: 'c' }; },
    close: async () => {},
  };
  const runtime = createAirSyncRuntime({ index, build: async () => snapshot([]), send: () => {}, maxPending: 1, logger: { warn() {} } });
  t.after(() => runtime.close());
  await runtime.flush();
  const first = runtime.syncHttp({ cursor: 'c' });
  await assert.rejects(runtime.syncHttp({ cursor: 'c' }), e => e.status === 503 && e.code === 'air_busy');
  release(); await first;
});

test('Air persistence notices match the frozen cause traversal, lifetime and callbacks', () => {
  const fs = require('node:fs'), path = require('node:path');
  const { compileFunction } = require('node:vm'), { createRequire } = require('node:module');
  const { createHash } = require('node:crypto');
  function legacy(name, hash, overrides = {}) {
    const file = path.resolve(__dirname, '../src/workspace', name + '.js');
    const src = fs.readFileSync(path.join(__dirname, 'helpers', 'legacy-' + name + '.js'));
    assert.equal(createHash('sha1').update('blob ' + src.length + '\0').update(src).digest('hex'), hash);
    const mod = { exports: {} }, local = createRequire(file);
    compileFunction(src.toString(), ['module', 'require'], { filename: file })(mod, id => overrides[id] || local(id));
    return mod.exports;
  }
  const old = legacy('air-sync-issue', '9e87bfa162e03ce54055db1c6198f7273cae92f3');
  const oldHooks = legacy('air-storage-notice', '8fd890d1a9232acdcdd2b97cec66920879b88105', { './air-sync-issue': old });
  const now = Date.now;
  function trace(issues, hooks) {
    let at = 19000;
    Date.now = () => at;
    const n = issues.createAirStorageNotice(), out = [];
    assert.equal(n.current(), null);
    function chain(size, fail) {
      let next;
      for (let i = size - 1; i >= 0; --i) {
        const tail = next;
        next = { get code() { out.push('c' + i); return i === fail ? 'SQLITE_FULL' : ''; },
          get message() { out.push('m' + i); return i === 2 ? 'x'.repeat(1023) + '✨ SQLITE_FULL' : ''; },
          get cause() { out.push('n' + i); return tail; } };
      }
      return next;
    }
    for (let size = 0; size <= 7; ++size) {
      for (let hit = -1; hit <= size; ++hit) out.push(issues.describeAirIssue(chain(size, hit)));
    }
    const cycle = { code: Symbol('code'), message: 123n };
    cycle.cause = cycle;
    for (const error of [cycle, null, { get message() { throw Error('broken'); } }, { code: 'EIO' }]) {
      out.push(issues.describeAirIssue(error), n.record(error));
    }
    assert.equal(n.record({ code: 'ENOSPC', message: 'private path' }), true);
    const ref = n.current();
    ref.marker = true;
    for (const delta of [-1, 299999, 300000, 300001]) {
      at = 19000 + delta;
      const notice = n.current();
      out.push([delta, notice === ref, notice?.marker, notice?.message]);
    }
    at = 19001;
    const flow = [];
    const publisher = () => { flow.push('publish'); };
    hooks.bindPublisher(publisher);
    const logger = { error(event, facts) { flow.push([event, facts]); } };
    const metrics = { inc(key) { flow.push(key); } };
    let failStore;
    hooks.installStateStoreReporter({ setFailureReporter(fn) { failStore = fn; } }, { metrics, logger });
    failStore({ code: 'ENOSPC', message: 'path' }, { get file() { flow.push('meta'); return 'data'; } });
    const failSession = hooks.sessionPersistenceOnFailure({ metrics, logger });
    failSession({ error: { code: 'SQLITE_FULL', message: 'db' }, mode: 'atomic', source: 1, attempt: 2, dirty: false });
    failSession({ error: null });
    const sentinel = Error('publisher');
    hooks.bindPublisher(() => { throw sentinel; });
    assert.throws(() => failStore({ code: 'ENOSPC' }, {}), err => err === sentinel);
    hooks.bindPublisher(null);
    out.push(flow, hooks.storageNotice());
    return out;
  }
  try {
    assert.deepEqual(trace(airIssueApi, airNoticeHooks), trace(old, oldHooks));
  } finally { Date.now = now; airNoticeHooks.bindPublisher(null); }
});
