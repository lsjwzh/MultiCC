'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return value; },
  };
}

test('central cron migrates once and always delivers through one fixed Air task', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cron-task-first-'));
  const previous = process.env.MULTICC_DATA_DIR;
  process.env.MULTICC_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(root, 'scheduled_tasks.json'), JSON.stringify([{
    id: 'cron_legacy', name: '每日检查', dirId: 'dir-1', cli: 'claude',
    cron: '0 9 * * *', prompt: '检查今天的状态', enabled: true,
    lastSessionId: 'legacy-chat', taskId: 'tsk_empty_startup_race', taskSessionId: 'task-empty',
    createdAt: '2026-09-01T00:00:00.000Z',
  }]));
  const modulePath = require.resolve('../plugins/cron/cron-tasks');
  delete require.cache[modulePath];
  const cron = require(modulePath);
  const known = new Set(['tsk_legacy', 'tsk_empty_startup_race']);
  const deliveries = [];
  let creates = 0;
  const entry = id => ({ ok: true, task: { id, title: id }, sessionId: `task-${id}`,
    ownerShellId: `shell-${id}`, readOnly: false });
  cron.init({
    directories: new Map([['dir-1', { id: 'dir-1', name: '项目一', path: root }]]),
    clis: ['claude', 'codex'],
    resolveTaskId: sessionId => sessionId === 'legacy-chat' ? 'tsk_legacy' : null,
    getTask: async id => {
      if (!known.has(id)) throw Object.assign(new Error('missing'), { code: 'task_not_found' });
      return entry(id);
    },
    createTask: async input => {
      creates++;
      const taskId = `tsk_created_${creates}`;
      known.add(taskId);
      return { ...entry(taskId), taskId };
    },
    sendTaskMessage: async (taskId, prompt, options) => {
      deliveries.push({ taskId, prompt, options });
      return { ok: true, taskId, sessionId: `task-${taskId}`,
        receiptId: `receipt-${deliveries.length}`, decision: deliveries.length === 1 ? 'continue' : 'queued' };
    },
    taskSummary: id => known.has(id) ? { id, dirId: 'dir-1', title: '每日检查', status: 'active',
      readOnly: false, sessionId: `task-${id}`, runtime: { cli: 'claude' } } : null,
  });
  t.after(() => cron.stop());

  const migration = await cron._migrateTasks();
  assert.equal(migration.errors.length, 0);
  assert.equal(creates, 0, 'legacy history is adopted instead of creating another task');

  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'patch', 'delete']) {
    app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  }
  cron.mount(app);
  const listResponse = response();
  await routes.get('GET /api/cron')({}, listResponse, error => { throw error; });
  assert.equal(listResponse.body[0].taskId, 'tsk_legacy');
  assert.match(listResponse.body[0].taskUrl, /^\/air\?task=tsk_legacy/);

  for (let index = 0; index < 2; index++) {
    const runResponse = response();
    await routes.get('POST /api/cron/:id/run')({ params: { id: 'cron_legacy' } }, runResponse, error => { throw error; });
    assert.equal(runResponse.body.ok, true);
    assert.equal(runResponse.body.taskId, 'tsk_legacy');
  }
  assert.deepEqual(deliveries.map(value => value.taskId), ['tsk_legacy', 'tsk_legacy']);
  assert.notEqual(deliveries[0].options.clientMsgId, deliveries[1].options.clientMsgId);
  assert.equal(deliveries[0].options.source, 'cron');

  const disk = JSON.parse(fs.readFileSync(path.join(root, 'scheduled_tasks.json'), 'utf8'));
  assert.equal(disk[0].taskId, 'tsk_legacy');
  assert.equal(disk[0].lastSessionId, 'task-tsk_legacy');
  assert.equal(disk[0].runCount, 2);
  assert.equal(disk[0].lastStatus, 'queued');
});

test('new cron creates its fixed Air task before the schedule becomes visible', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cron-create-'));
  const previous = process.env.MULTICC_DATA_DIR;
  process.env.MULTICC_DATA_DIR = root;
  fs.writeFileSync(path.join(root, 'scheduled_tasks.json'), '[]');
  const modulePath = require.resolve('../plugins/cron/cron-tasks');
  delete require.cache[modulePath];
  const cron = require(modulePath);
  t.after(() => {
    cron.stop();
    if (previous === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  let input = null;
  cron.init({
    directories: new Map([['dir-1', { id: 'dir-1', name: '项目一', path: root }]]),
    clis: ['claude', 'codex'],
    getTask: async id => ({ ok: true, task: { id }, sessionId: 'task-created', ownerShellId: 'shell-created', readOnly: false }),
    createTask: async value => { input = value; return { ok: true, taskId: 'tsk_created', sessionId: 'task-created' }; },
    sendTaskMessage: async () => ({ ok: true }),
    taskSummary: () => ({ title: '库存同步', status: 'active', runtime: { cli: 'codex' } }),
  });
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'patch', 'delete']) app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  cron.mount(app);
  const res = response();
  await routes.get('POST /api/cron')({ body: { name: '库存同步', dirId: 'dir-1', cli: 'codex',
    cron: '0 * * * *', prompt: '同步库存', enabled: true } }, res, error => { throw error; });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.taskId, 'tsk_created');
  assert.equal(input.title, '库存同步');
  assert.equal(input.cli, 'codex');
  assert.match(input.clientMsgId, /^cron-task:/);
  const disk = JSON.parse(fs.readFileSync(path.join(root, 'scheduled_tasks.json'), 'utf8'));
  assert.equal(disk.length, 1);
  assert.equal(disk[0].taskId, 'tsk_created');
});

test('an archived fixed task stops the rule instead of spawning a session or a task', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cron-broken-binding-'));
  const previous = process.env.MULTICC_DATA_DIR;
  process.env.MULTICC_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'scheduled_tasks.json'), JSON.stringify([{
    id: 'cron_archived', name: '每小时巡检', dirId: 'dir-1', cli: 'claude',
    cron: '0 * * * *', prompt: '检查服务健康', enabled: true,
    taskId: 'tsk_archived', taskSessionId: 'task-archived', taskBindingVersion: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
  }]));
  const modulePath = require.resolve('../plugins/cron/cron-tasks');
  delete require.cache[modulePath];
  const cron = require(modulePath);
  t.after(() => cron.stop());
  let creates = 0;
  const deliveries = [];
  const broken = [];
  cron.init({
    directories: new Map([['dir-1', { id: 'dir-1', name: '项目一', path: root }]]),
    clis: ['claude', 'codex'],
    getTask: async id => ({ ok: true, task: { id, title: '每小时巡检' }, sessionId: `task-${id}`,
      ownerShellId: `shell-${id}`, readOnly: id === 'tsk_archived' }),
    createTask: async () => { creates++; return { ok: true, taskId: 'tsk_unexpected', sessionId: 'task-unexpected' }; },
    sendTaskMessage: async (taskId) => { deliveries.push(taskId); return { ok: true, decision: 'continue' }; },
    taskSummary: id => ({ title: '每小时巡检', status: id === 'tsk_archived' ? 'archived' : 'active',
      readOnly: id === 'tsk_archived', sessionId: `task-${id}`, runtime: { cli: 'claude' } }),
    notifyBroken: info => broken.push(info),
  });
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'patch', 'delete']) app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  cron.mount(app);
  const run = async () => {
    const res = response();
    await routes.get('POST /api/cron/:id/run')({ params: { id: 'cron_archived' }, body: {} }, res, error => { throw error; });
    return res;
  };
  for (let index = 0; index < 3; index++) {
    const res = await run();
    assert.equal(res.body.ok, false);
    assert.equal(res.body.taskId, 'tsk_archived', 'the schedule keeps its own identity');
  }
  assert.equal(creates, 0, 'a broken binding never creates a replacement task');
  assert.deepEqual(deliveries, [], 'nothing is delivered anywhere else');
  assert.equal(broken.length, 1, 'the break is reported once, not once per interval');

  const listResponse = response();
  await routes.get('GET /api/cron')({}, listResponse, error => { throw error; });
  const view = listResponse.body[0];
  assert.equal(view.taskId, 'tsk_archived');
  assert.equal(view.taskBindingBroken, true);
  assert.match(view.taskBindingError, /归档|只读/);
  assert.equal(view.runCount, 3);
  assert.equal(view.lastStatus, 'error');
});

test('rebind creates exactly one replacement fixed task and refuses while the binding is healthy', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cron-rebind-'));
  const previous = process.env.MULTICC_DATA_DIR;
  process.env.MULTICC_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'scheduled_tasks.json'), JSON.stringify([{
    id: 'cron_rebind', name: '库存同步', dirId: 'dir-1', cli: 'codex',
    cron: '0 * * * *', prompt: '同步库存', enabled: true,
    taskId: 'tsk_gone', taskBindingVersion: 1, taskBindingError: '固定任务已归档或只读',
    createdAt: '2026-09-01T00:00:00.000Z',
  }]));
  const modulePath = require.resolve('../plugins/cron/cron-tasks');
  delete require.cache[modulePath];
  const cron = require(modulePath);
  t.after(() => cron.stop());
  const created = [];
  const known = new Set(['tsk_gone']);
  const deliveries = [];
  cron.init({
    directories: new Map([['dir-1', { id: 'dir-1', name: '项目一', path: root }]]),
    clis: ['claude', 'codex'],
    getTask: async id => {
      if (!known.has(id)) throw Object.assign(new Error('missing'), { code: 'task_not_found' });
      return { ok: true, task: { id, title: '库存同步' }, sessionId: `task-${id}`, ownerShellId: `shell-${id}`,
        readOnly: id === 'tsk_gone' };
    },
    createTask: async input => {
      created.push(input);
      const taskId = `tsk_rebound_${created.length}`;
      known.add(taskId);
      return { ok: true, taskId, sessionId: `task-${taskId}` };
    },
    sendTaskMessage: async (taskId) => { deliveries.push(taskId); return { ok: true, decision: 'continue' }; },
    taskSummary: id => ({ title: '库存同步', status: id === 'tsk_gone' ? 'archived' : 'active',
      readOnly: id === 'tsk_gone', sessionId: `task-${id}`, runtime: { cli: 'codex' } }),
  });
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'patch', 'delete']) app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  cron.mount(app);
  const rebind = async () => {
    const res = response();
    await routes.get('POST /api/cron/:id/rebind')({ params: { id: 'cron_rebind' }, body: {} }, res, error => { throw error; });
    return res;
  };

  const first = await rebind();
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.taskId, 'tsk_rebound_1');
  assert.equal(first.body.previousTaskId, 'tsk_gone');
  assert.equal(created.length, 1, 'rebind creates exactly one fixed task');
  assert.equal(created[0].title, '库存同步');
  assert.equal(created[0].cli, 'codex');
  assert.match(created[0].clientMsgId, /^cron-rebind:cron_rebind:tsk_gone$/);
  assert.equal(first.body.task.taskBindingBroken, false);
  assert.equal(first.body.task.taskRebindHistory.length, 1);
  assert.equal(first.body.task.taskRebindHistory[0].from, 'tsk_gone');

  const second = await rebind();
  assert.equal(second.statusCode, 409);
  assert.equal(second.body.error, 'binding_healthy');
  assert.equal(created.length, 1, 'a healthy binding is never rotated');

  const runResponse = response();
  await routes.get('POST /api/cron/:id/run')({ params: { id: 'cron_rebind' }, body: {} }, runResponse, error => { throw error; });
  assert.equal(runResponse.body.ok, true);
  assert.deepEqual(deliveries, ['tsk_rebound_1']);

  const disk = JSON.parse(fs.readFileSync(path.join(root, 'scheduled_tasks.json'), 'utf8'));
  assert.equal(disk[0].taskId, 'tsk_rebound_1');
  assert.equal(disk[0].taskBindingError, '');
  assert.equal(disk[0].taskRebindHistory.length, 1);
});

// 执行记录: 每次触发都留一条(时间/来源/结果/去向/错误), 旧的滚出去, 有界。
test('every firing leaves an execution record the panel can read back', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cron-runs-'));
  const previous = process.env.MULTICC_DATA_DIR;
  process.env.MULTICC_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'scheduled_tasks.json'), JSON.stringify([{
    id: 'cron_runs', name: '每日早报', dirId: 'dir-1', cli: 'claude',
    cron: '0 9 * * *', prompt: '生成早报', enabled: true,
    taskId: 'tsk_runs', taskSessionId: 'task-runs', taskBindingVersion: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
  }]));
  const modulePath = require.resolve('../plugins/cron/cron-tasks');
  delete require.cache[modulePath];
  const cron = require(modulePath);
  t.after(() => cron.stop());

  let failNext = false;
  let delivered = 0;
  cron.init({
    directories: new Map([['dir-1', { id: 'dir-1', name: '项目一', path: root }]]),
    clis: ['claude', 'codex'],
    getTask: async id => ({ ok: true, task: { id, title: '每日早报' }, sessionId: `task-${id}`,
      ownerShellId: `shell-${id}`, readOnly: false }),
    createTask: async () => ({ ok: true, taskId: 'tsk_runs', sessionId: 'task-runs' }),
    sendTaskMessage: async () => {
      if (failNext) return { ok: false, code: 'delivery_failed', error: '任务入队失败: 队列已满' };
      delivered++;
      return { ok: true, decision: 'queued', receiptId: `receipt-${delivered}` };
    },
    taskSummary: () => ({ title: '每日早报', status: 'active', readOnly: false, runtime: { cli: 'claude' } }),
  });
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'patch', 'delete']) app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  cron.mount(app);
  const run = async () => {
    const res = response();
    await routes.get('POST /api/cron/:id/run')({ params: { id: 'cron_runs' }, body: {} }, res, error => { throw error; });
    return res;
  };

  await run();
  failNext = true;
  const failed = await run();
  assert.equal(failed.body.ok, false);
  failNext = false;

  // 列表里带回最近的执行记录, 最新的在最前面
  const listResponse = response();
  await routes.get('GET /api/cron')({}, listResponse, error => { throw error; });
  const view = listResponse.body[0];
  assert.equal(view.recentRuns.length, 2);
  assert.equal(view.recentRuns[0].status, 'error');
  assert.match(view.recentRuns[0].error, /队列已满/);
  assert.equal(view.recentRuns[0].reason, 'manual');
  assert.equal(view.recentRuns[0].taskId, 'tsk_runs');
  assert.equal(view.recentRuns[1].status, 'queued');
  assert.equal(view.recentRuns[1].receiptId, 'receipt-1');
  assert.equal(view.recentRuns[1].error, '');
  assert.equal(view.runCount, 2);
  assert.ok(view.recentRuns[0].at > view.recentRuns[1].at, '最新的在前');

  // 专用接口给完整那份(仍然有界)
  const runsResponse = response();
  await routes.get('GET /api/cron/:id/runs')({ params: { id: 'cron_runs' } }, runsResponse, error => { throw error; });
  assert.equal(runsResponse.body.ok, true);
  assert.equal(runsResponse.body.id, 'cron_runs');
  assert.equal(runsResponse.body.runCount, 2);
  assert.equal(runsResponse.body.limit, cron.RUN_HISTORY_LIMIT);
  assert.equal(runsResponse.body.runs.length, 2);
  const missing = response();
  await routes.get('GET /api/cron/:id/runs')({ params: { id: 'nope' } }, missing, error => { throw error; });
  assert.equal(missing.statusCode, 404);

  // 记录随任务一起落盘(重启后还在), 且不会无限增长
  for (let index = 0; index < cron.RUN_HISTORY_LIMIT + 5; index++) await run();
  const disk = JSON.parse(fs.readFileSync(path.join(root, 'scheduled_tasks.json'), 'utf8'));
  assert.equal(disk[0].runs.length, cron.RUN_HISTORY_LIMIT, '超出上限的旧记录要滚出去');
  assert.equal(disk[0].runCount, 2 + cron.RUN_HISTORY_LIMIT + 5);
  assert.equal(disk[0].runs[disk[0].runs.length - 1].status, 'queued');
  // 读回列表: 只回放最近 RUN_HISTORY_VIEW 条
  const capped = response();
  await routes.get('GET /api/cron')({}, capped, error => { throw error; });
  assert.equal(capped.body[0].recentRuns.length, cron.RUN_HISTORY_VIEW);
});
