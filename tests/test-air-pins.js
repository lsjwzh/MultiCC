'use strict';

// Pin 住的任务（页头「齐刘海」/ 手机侧栏置顶）是用户的选择，不是缓存：换一台
// 设备、换 App 打开得看到同一份。这些用例钉住让这句话成立的四件事 —— 形状归一、
// 高容量安全线、存在性剪枝、以及 /api/air 快照里确实带着它。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { PIN_LIMIT, normalizePins, readStoredPinIds, createAirPinRuntime, createAirTodoRuntime } = require('../src/native/task-domain');
const { mountAir } = require('./helpers/air-host');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-air-pins-'));
  return path.join(dir, 'air-pins.json');
}

function fixture({ taskIds = ['t1', 't2', 't3'], file = tempFile() } = {}) {
  const known = new Set(taskIds);
  const warnings = [];
  const runtime = createAirPinRuntime({ file, listTaskIds: () => [...known], logger: { warn: msg => warnings.push(msg) } });
  const routes = new Map();
  runtime.mountRoutes({ get: (p, fn) => routes.set(`GET ${p}`, fn), post: (p, fn) => routes.set(`POST ${p}`, fn) });
  return { runtime, routes, known, file, warnings };
}

test('normalizePins drops blanks and duplicates and stops at the limit', () => {
  assert.deepEqual(normalizePins(null), []);
  assert.deepEqual(normalizePins([' t1 ', '', 't1', 42, 't2']), ['t1', 't2']);
  const many = Array.from({ length: PIN_LIMIT + 5 }, (_, i) => `t${i}`);
  assert.equal(normalizePins(many).length, PIN_LIMIT);
});

test('toggle 钉上再拔掉，顺序按钉的顺序，落盘后换一个进程实例仍在', () => {
  const { runtime, file } = fixture();
  assert.deepEqual(runtime.toggle('t2'), ['t2']);
  assert.deepEqual(runtime.toggle('t1'), ['t2', 't1']);
  assert.deepEqual(runtime.toggle('t2'), ['t1']);
  // 另一份运行时读同一个文件 —— 这就是「Web 和 App 看到同一份」那件事。
  const reopened = createAirPinRuntime({ file, listTaskIds: () => ['t1', 't2', 't3'] });
  assert.deepEqual(reopened.read(), ['t1']);
});

test('淘汰读取最新落盘 pin；损坏文件时拒绝猜测保护名单', () => {
  const { runtime, file } = fixture();
  assert.deepEqual(readStoredPinIds(file), []);
  runtime.toggle('t1');
  assert.deepEqual(readStoredPinIds(file), ['t1']);
  runtime.toggle('t2');
  assert.deepEqual(readStoredPinIds(file), ['t1', 't2']);
  fs.writeFileSync(file, '{ broken');
  assert.throws(() => readStoredPinIds(file));
});

test('failed pin persistence cannot report success or leave a memory-only pin', async () => {
  // A regular file used as a parent is guaranteed to make atomic save fail.
  const blocker = tempFile();
  fs.writeFileSync(blocker, 'not a directory');
  const blocked = fixture({ file: path.join(blocker, 'pins.json') });
  assert.throws(() => blocked.runtime.toggle('t1'), { code: 'pin_save_failed' });
  assert.deepEqual(blocked.runtime.read(), []);
  // 宿主把落盘失败原样抛给前门（status/code 都在信封里），内存里不留半个钉子。
  const air = mountAir({ pinsFile: path.join(blocker, 'pins.json'), getBoard: () => ({ tasks: { t1: { id: 't1' } } }) });
  const failed = await air.fail({ op: 'pins-replace', taskIds: ['t1'] });
  assert.equal(failed.status, 500);
  assert.equal(failed.code, 'pin_save_failed');
  assert.deepEqual(await air.ok({ op: 'pins-read' }), []);
});

test('页头可以 pin 超过 5 个，只在存储安全线拒绝', () => {
  const { runtime } = fixture({ taskIds: ['t1', 't2', 't3', 't4', 't5', 't6'] });
  for (const id of ['t1', 't2', 't3', 't4', 't5', 't6']) runtime.toggle(id);
  assert.deepEqual(runtime.read(), ['t1', 't2', 't3', 't4', 't5', 't6']);

  const ids = Array.from({ length: PIN_LIMIT + 1 }, (_, i) => `x${i}`);
  const capped = fixture({ taskIds: ids }).runtime;
  for (const id of ids.slice(0, PIN_LIMIT)) capped.toggle(id);
  assert.throws(() => capped.toggle(ids.at(-1)), { status: 409, code: 'pin_limit_reached' });
});

test('已经拔掉的 id 可以再钉回来', () => {
  const { runtime } = fixture({ taskIds: ['t1', 't2', 't3', 't4', 't5', 't6'] });
  for (const id of ['t1', 't2', 't3', 't4', 't5']) runtime.toggle(id);
  runtime.toggle('t3');
  assert.equal(runtime.toggle('t6').length, 5);
  assert.deepEqual(runtime.read(), ['t1', 't2', 't4', 't5', 't6']);
});

test('任务没了，钉子自己掉下来；但不存在的 id 不许写进去', () => {
  const { runtime, known } = fixture();
  runtime.toggle('t1');
  known.delete('t1');
  assert.deepEqual(runtime.read(), []);
  assert.throws(() => runtime.toggle('t1'), { status: 404, code: 'task_not_found' });
  assert.deepEqual(runtime.replace(['t1', 't2', 'ghost']), ['t2']);
});

test('replace 整份归一：去重、去空、截到上限、剪掉不存在的任务', () => {
  const { runtime } = fixture({ taskIds: ['t1', 't2', 't3', 't4', 't5', 't6'] });
  assert.deepEqual(runtime.replace(['t2', 't2', '', 't2']), ['t2']);
  assert.deepEqual(runtime.replace(['t3', 't1', 't2']), ['t3', 't1', 't2']);
  assert.equal(runtime.replace(['t1', 't2', 't3', 't4', 't5', 't6']).length, 6);
});

test('宿主端口：GET 读、POST 整份替换、toggle 单点，错误码带 status', async () => {
  const { runtime, file } = fixture();
  const tasks = Object.fromEntries(['t1', 't2', 't3'].map(id => [id, { id, title: id, refs: [{ sessionId: 's', dirId: 'd1' }] }]));
  const air = mountAir({
    pinsFile: file, getBoard: () => ({ tasks }),
    admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }) },
    records: new Map([['s', { id: 's', dirId: 'd1', kind: 'chat' }]]), directories: new Map(),
    shell: { taskAccess: () => ({ readOnly: false }), listTasks: () => Object.values(tasks) },
  });
  assert.deepEqual(await air.ok({ op: 'pins-read' }), []);
  // 前门把数组折成 { ok: true, taskIds }，数组本身是宿主唯一的事实。
  assert.deepEqual(await air.ok({ op: 'pins-toggle', taskId: 't1' }), ['t1']);
  assert.deepEqual(await air.ok({ op: 'pins-replace', taskIds: ['t3', 't2'] }), ['t3', 't2']);
  const ghost = await air.fail({ op: 'pins-toggle', taskId: 'nope' });
  assert.equal(ghost.status, 404);
  assert.equal(ghost.code, 'task_not_found');
  assert.equal((await air.ok({ op: 'pins-read' })).length, 2);
  // 同一份文件换一个进程实例读 —— 「Web 和 App 看到同一份」那件事。
  assert.deepEqual(runtime.read(), ['t3', 't2']);
  // 缺 taskIds / 非数组的 400 由前门判（native/gateway/tests/air_routes.rs），宿主根本
  // 收不到那次调用；宿主只负责把数组整份归一落盘，空数组就是清空。
  assert.deepEqual(await air.ok({ op: 'pins-replace', taskIds: [] }), []);
});

test('损坏的 pins 文件从空开始，不影响别的状态（爆炸半径只有几个钉子）', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ this is not json');
  const warnings = [];
  const runtime = createAirPinRuntime({ file, listTaskIds: () => ['t1'], logger: { warn: msg => warnings.push(msg) } });
  assert.deepEqual(runtime.read(), []);
  assert.equal(warnings.length, 1);
  runtime.toggle('t1');
  assert.deepEqual(createAirPinRuntime({ file, listTaskIds: () => ['t1'] }).read(), ['t1']);
});

test('/api/air 快照带着 pin，客户端不用为它多打一次接口', async () => {
  const pinsFile = tempFile();
  const board = { tasks: { t1: { id: 't1', title: 'One' }, t2: { id: 't2', title: 'Two', mergedIntoTaskId: 't1' } } };
  const air = mountAir({
    pinsFile, getBoard: () => board,
    admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }) },
    records: new Map(), directories: new Map(), clis: ['claude'],
    shell: { taskAccess: () => ({ readOnly: false }) },
  });
  await air.ok({ op: 'pins-toggle', taskId: 't1' });
  const snapshot = (await air.snapshot()).json;
  assert.deepEqual(snapshot.taskPins, ['t1']);
  assert.equal(snapshot.tasks.some(t => t.id === 't2'), false);
});

test('Air pinned and todo lists match the frozen state machines', () => {
  const { compileFunction } = require('node:vm');
  const { createRequire } = require('node:module');
  const { createHash } = require('node:crypto');
  function frozen(name, hash, override = {}) {
    const file = path.resolve(__dirname, '../src/workspace', name + '.js');
    const source = fs.readFileSync(path.join(__dirname, 'helpers', 'legacy-air-' + name + '.js'));
    assert.equal(createHash('sha1').update('blob ' + source.length + '\0').update(source).digest('hex'), hash);
    const mod = { exports: {} };
    const local = createRequire(file);
    compileFunction(source.toString(), ['require', 'module'], { filename: file })(id => override[id] || local(id), mod);
    return mod.exports;
  }
  const oldPins = frozen('pins', '4967f6324d789b66525afcd200f8f01abb7243f0');
  const oldTodos = frozen('todos', 'ab6b09c8ebe495aeef8157adb542a042c218dd6c', { './pins': oldPins });
  function run(make, kind, cap) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-list-diff-'));
    const file = path.join(dir, 'list.json');
    const out = [];
    let available = true, known = ['x', 'y', 'z', 'lost', '\ud800', '✨'], count = 0;
    const logger = { warn(msg) { out.push(['warning', msg.split(':')[0]]); } };
    const deps = { file, logger, listTaskIds() {
      assert.equal(this, deps);
      count++;
      if (!available) throw Error('board offline');
      return count % 3 === 0 ? known.filter(id => id !== 'lost') : new Set(known);
    } };
    const observe = fn => {
      try { out.push({ value: fn(), count }); }
      catch (err) { out.push({ error: [err.name, err.message, err.code, err.status], count }); }
    };
    try {
      const api = make(deps);
      assert.equal(api.limit, cap);
      assert.equal(api.file, file);
      observe(api.read);
      observe(() => api.replace([' x ', {}, 'x', 'lost', 'ghost', '\ud800', '✨', '\ufeffz']));
      observe(api.read);
      for (const id of ['x', 'ghost', {}, '   ', '\ud800', 'y']) observe(() => api.toggle(id));
      available = false;
      observe(() => api.replace(['offline', 'y']));
      observe(api.read);
      available = true;
      observe(api.read);
      known = Array.from({ length: cap + 2 }, (_, i) => 't' + i);
      observe(() => api.replace(known));
      observe(() => api.toggle(known[cap]));
      observe(() => api.toggle(known[0]));
      observe(() => api.toggle(known[cap]));
      out.push(JSON.parse(fs.readFileSync(file, 'utf8')).data);
      fs.writeFileSync(file, '{broken');
      observe(() => make(deps).read());
      const handlers = new Map();
      api.mountRoutes({ get: (url, cb) => handlers.set('GET ' + url, cb), post: (url, cb) => handlers.set('POST ' + url, cb) });
      for (const [method, body] of [['GET ', null], ['POST ', {}], ['POST ', { taskIds: [] }],
        ['toggle', { taskId: {} }], ['toggle', { taskId: 'missing' }], ['toggle', { taskId: 't2' }]]) {
        const res = { code: 200, status(n) { this.code = n; return this; }, json(payload) { out.push([this.code, payload]); } };
        handlers.get(method === 'toggle' ? 'POST /api/air/' + kind + '/toggle' : method + '/api/air/' + kind)({ body }, res);
      }
      const before = api.read();
      fs.rmSync(dir, { recursive: true });
      fs.writeFileSync(dir, 'blocked');
      observe(() => api.replace(['t4']));
      assert.deepEqual(api.read(), before);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    return out;
  }
  for (const [live, old, kind, cap] of [[createAirPinRuntime, oldPins.createAirPinRuntime, 'pins', 100],
    [createAirTodoRuntime, oldTodos.createAirTodoRuntime, 'todos', 500]]) {
    assert.deepEqual(run(live, kind, cap), run(old, kind, cap), kind);
  }
  const opaque = { toString() { throw Error('unexpected coercion'); } };
  for (const limit of [undefined, null, 0, -1, 1, 1.5, 2n, '3', Infinity, NaN, { valueOf: () => 2 }]) {
    const list = Object.freeze(['', ' a ', opaque, 42, 'a', '\ud800', '\ufffd', '\ufeffb', '👩‍🔬']);
    assert.deepEqual(normalizePins(list, limit), oldPins.normalizePins(list, limit));
  }
  // for-of stops and closes the iterator as soon as the accepted count reaches
  // the caller's limit; a coercion failure must also close it.
  for (const limit of [1, Symbol('limit')]) {
    function iteratorTrace(normalize) {
      const log = [];
      const input = [];
      input[Symbol.iterator] = function* () {
        try { for (const id of ['a', 'b', 'c']) { log.push(id); yield id; } }
        finally { log.push('close'); }
      };
      try { return [normalize(input, limit), log]; }
      catch (err) { return [[err.name, err.message], log]; }
    }
    assert.deepEqual(iteratorTrace(normalizePins), iteratorTrace(oldPins.normalizePins));
  }
  function reentry(make) {
    const file = tempFile();
    let nested = false, armed = false, runtime;
    const seen = [];
    try {
      runtime = make({ file, listTaskIds() {
        if (armed && !nested) {
          nested = true;
          seen.push(runtime.toggle('nested'));
        }
        return ['outer', 'nested'];
      } });
      runtime.read();
      armed = true;
      seen.push(runtime.toggle('outer'), runtime.read(), JSON.parse(fs.readFileSync(file, 'utf8')).data);
    } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
    return seen;
  }
  assert.deepEqual(reentry(createAirPinRuntime), reentry(oldPins.createAirPinRuntime));
  for (const body of [{}, { data: { taskIds: {} } }, { taskIds: ['a', ' a ', 'b'] }, { data: { taskIds: ['x'] } }]) {
    const file = tempFile();
    try {
      fs.writeFileSync(file, JSON.stringify(body));
      if (Array.isArray(body.taskIds || body.data?.taskIds)) assert.deepEqual(readStoredPinIds(file), oldPins.readStoredPinIds(file));
      else assert.throws(() => readStoredPinIds(file), { message: 'air pins unavailable' });
    } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
  }
});
