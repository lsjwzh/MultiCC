'use strict';

// Pin 住的任务（页头「齐刘海」/ 手机侧栏置顶）是用户的选择，不是缓存：换一台
// 设备、换 App 打开得看到同一份。这些用例钉住让这句话成立的四件事 —— 形状归一、
// 高容量安全线、存在性剪枝、以及 /api/air 快照里确实带着它。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { airResponse } = require('./helpers/air-response');

const { PIN_LIMIT, normalizePins, createAirPinRuntime } = require('../src/workspace/pins');
const { mountAirRoutes } = require('../src/workspace/air-routes');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-air-pins-'));
  return path.join(dir, 'air-pins.json');
}

function invoke(routes, key, { params = {}, body = {} } = {}) {
  return call(routes.get(key), { params, body });
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

test('HTTP：GET 读、POST 整份替换、toggle 单点，错误码带 status', () => {
  const { runtime, routes } = fixture();
  assert.deepEqual(invoke(routes, 'GET /api/air/pins').body, { ok: true, taskIds: [] });
  const toggled = invoke(routes, 'POST /api/air/pins/toggle', { body: { taskId: 't1' } });
  assert.equal(toggled.statusCode, 200);
  assert.deepEqual(toggled.body.taskIds, ['t1']);
  const replaced = invoke(routes, 'POST /api/air/pins', { body: { taskIds: ['t3', 't2'] } });
  assert.deepEqual(replaced.body.taskIds, ['t3', 't2']);
  assert.equal(invoke(routes, 'POST /api/air/pins', { body: {} }).statusCode, 400);
  const ghost = invoke(routes, 'POST /api/air/pins/toggle', { body: { taskId: 'nope' } });
  assert.equal(ghost.statusCode, 404);
  assert.equal(ghost.body.code, 'task_not_found');
  assert.equal(runtime.read().length, 2);
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
  const handlers = new Map();
  const app = { get: (p, fn) => handlers.set(p, fn), post: (p, fn) => handlers.set(p, fn) };
  mountAirRoutes(app, {
    pinsFile, getBoard: () => board,
    admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }) },
    records: new Map(), directories: new Map(), clis: ['claude'],
    shell: { taskAccess: () => ({ readOnly: false }) },
  });
  call(handlers.get('/api/air/pins/toggle'), { body: { taskId: 't1' } });
  const res = airResponse(); await handlers.get('/api/air')({}, res); const snapshot = JSON.parse(res.body);
  assert.deepEqual(snapshot.taskPins, ['t1']);
  assert.equal(snapshot.tasks.some(t => t.id === 't2'), false);
});
