'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
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

// Air 的新任务胶囊把 lastRuntime 当成「用户最近用过的那套」，而定时任务的固定
// 会话每小时都会自动跑一轮，lastWorkAt 几乎总是最新 —— 规则自己才是「哪些会话
// 是自动化产物」的权威，所以由 cron 回答，Air 侧据此排除。
test('a schedule publishes the fixed sessions it owns so Air can exclude them', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cron-session-ids-'));
  const previous = process.env.MULTICC_DATA_DIR;
  process.env.MULTICC_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'scheduled_tasks.json'), JSON.stringify([
    { id: 'cron_a', name: '甲', dirId: 'dir-1', cli: 'claude', cron: '0 9 * * *', prompt: 'p',
      enabled: true, taskId: 'tsk_a', taskSessionId: 'task-a', taskBindingVersion: 1 },
    // 停用的规则也算：它的历史会话同样是自动化产物，不是用户挑的路由。老规则只留了
    // lastSessionId 时，那个 id 就是它的固定会话。
    { id: 'cron_b', name: '乙', dirId: 'dir-1', cli: 'claude', cron: '0 9 * * *', prompt: 'p',
      enabled: false, taskId: 'tsk_b', lastSessionId: 'chat-b', taskBindingVersion: 1 },
  ]));
  const modulePath = require.resolve('../plugins/cron/cron-tasks');
  delete require.cache[modulePath];
  const cron = require(modulePath);
  cron.init({
    directories: new Map([['dir-1', { id: 'dir-1', name: '项目一', path: root }]]),
    clis: ['claude'],
    getTask: async id => ({ ok: true, task: { id }, readOnly: false }),
    createTask: async () => { throw new Error('已绑定的规则不该再建任务'); },
    taskSummary: () => null,
  });
  t.after(() => cron.stop());
  await cron._migrateTasks();
  assert.deepEqual(cron.sessionIds().sort(), ['chat-b', 'task-a']);
});

// kind='script'：规则不建固定 Air 任务、不投递给任何会话，直接在工作目录里跑一条
// 本地命令（「盯任务板、出错就发提醒」这类轮询脚本不必为此养一个常驻大模型会话）。
// 这里锁住四条边界：建规则时不碰 createTask/sendTaskMessage、跑完把退出码与输出末尾
// 记进执行记录、重绑对脚本没有意义（409）、没有命令的脚本规则建不出来。
test('script rules run a local command and never touch a fixed Air task', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cron-script-'));
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
  let creates = 0;
  const deliveries = [];
  cron.init({
    directories: new Map([['dir-1', { id: 'dir-1', name: '项目一', path: root }]]),
    clis: ['claude', 'codex'],
    getTask: async () => { throw new Error('script rules must not resolve a fixed task'); },
    createTask: async () => { creates++; return { ok: true, taskId: 'tsk_never', sessionId: 'task-never' }; },
    sendTaskMessage: async () => { deliveries.push(1); return { ok: true }; },
  });
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'patch', 'delete']) app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  cron.mount(app);
  // 注意：路由 handler 是 async，await 它拿到的是 undefined 而不是响应对象 —— 响应要
  // 自己拿着（同本文件上面几个用例的写法）。
  const call = async (route, req) => {
    const res = response();
    await routes.get(route)(req, res, error => { throw error; });
    return res;
  };

  const empty = await call('POST /api/cron', { body: { name: '空脚本', dirId: 'dir-1', kind: 'script', cron: '* * * * *', command: '   ' } });
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.body.error, '脚本命令不能为空');

  const created = await call('POST /api/cron', { body: { name: '微信提醒看守', dirId: 'dir-1', kind: 'script', cron: '* * * * *',
    command: `${process.execPath} -e 'console.log("watchdog-ok")'`, prompt: '这段不该被用上' } });
  assert.equal(created.statusCode, 200);
  assert.equal(created.body.kind, 'script');
  assert.equal(created.body.taskId, null, 'script rules own no fixed Air task');
  assert.equal(created.body.prompt, '', 'prompt is not part of a script rule view');
  assert.equal(creates, 0);

  const first = await call('POST /api/cron/:id/run', { params: { id: created.body.id } });
  assert.equal(first.body.ok, true);
  assert.equal(first.body.exitCode, 0);
  assert.equal(first.body.taskId, null);
  assert.equal(deliveries.length, 0, 'a script rule never dispatches to a session');

  const view = (await call('GET /api/cron', {})).body[0];
  assert.equal(view.lastExitCode, 0);
  assert.match(view.lastOutput, /watchdog-ok/);
  assert.equal(view.recentRuns[0].exitCode, 0);
  assert.match(view.recentRuns[0].output, /watchdog-ok/);

  const patched = await call('PATCH /api/cron/:id', { params: { id: created.body.id },
    body: { command: `${process.execPath} -e 'console.error("boom"); process.exit(3)'` } });
  assert.equal(patched.statusCode, 200);
  const failed = await call('POST /api/cron/:id/run', { params: { id: created.body.id } });
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.exitCode, 3);
  assert.match(failed.body.error, /脚本退出码 3/);
  const after = (await call('GET /api/cron', {})).body[0];
  assert.equal(after.lastStatus, 'error');
  assert.equal(after.lastExitCode, 3);
  assert.equal(after.taskBindingError, '', 'a failing script is not a broken task binding');
  assert.match(after.recentRuns[0].output, /boom/);

  const rebind = await call('POST /api/cron/:id/rebind', { params: { id: created.body.id } });
  assert.equal(rebind.statusCode, 409);
  assert.match(rebind.body.error, /脚本任务/);

  const disk = JSON.parse(fs.readFileSync(path.join(root, 'scheduled_tasks.json'), 'utf8'));
  assert.equal(disk[0].kind, 'script');
  assert.equal(disk[0].taskId, undefined);
  assert.deepEqual(cron.sessionIds(), [], 'script rules contribute no session identity');
});

// 「定时脚本任务」的第一个真实用例在 examples/cron-scripts/wechat-alert.py：取任务状态
// （GET /api/air）→ 调会话接口（POST /api/sessions/<中转会话>/scheduled-messages）→
// 中转任务把正文发进微信群。全程不碰大模型，也不进任何 Air 会话。
//
// 这里用假服务端把它整条链路跑一遍，锁住四件事：首轮只登记不补发历史提醒、一轮里多条
// 提醒合并成一条投给中转会话、没变化就不重复投、被频率闸压住的提醒下一轮还在（不是
// 被静默吃掉）。没有 python3 的机器跳过 —— 这只是一个示例脚本，不该把别处的 CI 拖红。
function pythonInterpreter() {
  for (const candidate of ['/usr/bin/python3', 'python3', 'python']) {
    try {
      childProcess.execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch (_) { /* 换下一个候选 */ }
  }
  return null;
}

const PYTHON = pythonInterpreter();

test('the shipped cron-script example turns board state into one merged WeChat alert',
  { skip: PYTHON ? false : 'python3 不可用，跳过示例脚本的端到端验证' }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cron-example-'));
    const configPath = path.join(root, 'config-cron.json');
    const tasksPath = path.join(root, 'tasks.json');
    const receivedPath = path.join(root, 'received.json');
    const statePath = path.join(root, 'state-cron.json');
    const writeTasks = list => fs.writeFileSync(tasksPath, JSON.stringify(list));
    const received = () => (fs.existsSync(receivedPath) ? JSON.parse(fs.readFileSync(receivedPath, 'utf8')) : []);

    writeTasks([
      { id: 'tsk_a', sessionId: 'task-a', title: '会话甲', runState: 'waiting', status: 'active' },
      { id: 'tsk_relay', sessionId: 'task-relay', title: '微信提醒中转', runState: 'error', status: 'active' },
      { id: 'tsk_old', sessionId: 'task-old', title: '已收摊的旧卡片', runState: 'error', status: 'done' },
    ]);
    fs.writeFileSync(configPath, JSON.stringify({
      baseUrl: 'http://127.0.0.1:0', relayTaskId: 'tsk_relay', relaySessionId: 'task-relay',
      wechatGroup: 'all in one', excludeTitlePrefixes: ['微信提醒'],
      minDispatchIntervalMs: 120000, maxAlertsPerHour: 12, stateFile: 'state-cron.json',
    }));

    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/air') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ tasks: JSON.parse(fs.readFileSync(tasksPath, 'utf8')) }));
      }
      if (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/scheduled-messages$/.test(req.url)) {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        return req.on('end', () => {
          const kept = received();
          kept.push({ url: req.url, body: JSON.parse(body) });
          fs.writeFileSync(receivedPath, JSON.stringify(kept));
          res.writeHead(201, { 'Content-Type': 'application/json' });
          return res.end('{"ok":true}');
        });
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{"error":"not found"}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
    fs.writeFileSync(configPath, JSON.stringify({
      ...JSON.parse(fs.readFileSync(configPath, 'utf8')),
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    }));

    // 假服务端就在本进程的事件循环里，所以**不能用 spawnSync** —— 它会把循环占住，
    // 服务端永远答不上话，脚本一路等到超时。
    const script = path.join(__dirname, '..', 'examples', 'cron-scripts', 'wechat-alert.py');
    const launch = (file, ...extra) => new Promise(resolve => {
      childProcess.execFile(PYTHON, [script, '--config', file, ...extra], { encoding: 'utf8' },
        (error, stdout, stderr) => resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr }));
    });
    const run = (...extra) => launch(configPath, ...extra);

    // 首轮只登记不补发：机器上多半已经堆着一批历史 error，直接发就是往群里刷屏。
    const primed = await run();
    assert.equal(primed.status, 0, primed.stderr);
    assert.match(primed.stdout, /首轮扫描/);
    assert.deepEqual(received(), [], '首轮不投递任何东西');
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).primed, true);

    // 状态没变就不重复报。
    assert.match((await run()).stdout, /无变化/);
    assert.deepEqual(received(), []);

    // 两条新的变化 → 合并成一条投给中转会话（中转任务自己排掉，已收摊的卡片不算）。
    writeTasks([
      { id: 'tsk_a', sessionId: 'task-a', title: '会话甲', runState: 'error', status: 'active' },
      { id: 'tsk_c', sessionId: 'task-c', title: '会话丙', runState: 'waiting', status: 'active' },
      { id: 'tsk_relay', sessionId: 'task-relay', title: '微信提醒中转', runState: 'error', status: 'active' },
      { id: 'tsk_old', sessionId: 'task-old', title: '已收摊的旧卡片', runState: 'error', status: 'done' },
    ]);
    const alerted = await run();
    assert.equal(alerted.status, 0, alerted.stderr);
    assert.equal(received().length, 1, '一轮只投一条合并提醒');
    assert.match(received()[0].url, /\/api\/sessions\/task-relay\/scheduled-messages$/);
    assert.match(received()[0].body.message, /会话甲/);
    assert.match(received()[0].body.message, /会话丙/);
    assert.doesNotMatch(received()[0].body.message, /已收摊的旧卡片/);
    assert.match(received()[0].body.message, /微信群「all in one」/, '工单里带上要原样发送的正文');

    // 频率闸压住的提醒必须留着，下一轮再来 —— 不能被静默吃掉。
    writeTasks([
      { id: 'tsk_a', sessionId: 'task-a', title: '会话甲', runState: 'error', status: 'active' },
      { id: 'tsk_c', sessionId: 'task-c', title: '会话丙', runState: 'waiting', status: 'active' },
      { id: 'tsk_e', sessionId: 'task-e', title: '会话戊', runState: 'error', status: 'active' },
      { id: 'tsk_relay', sessionId: 'task-relay', title: '微信提醒中转', runState: 'error', status: 'active' },
    ]);
    assert.match((await run()).stdout, /压到下一轮/);
    assert.equal(received().length, 1);
    // dry-run 只彩排：既不改状态也不投递，压住的「会话戊」还在。
    const rehearsal = await run('--dry-run');
    assert.match(rehearsal.stdout, /\[dry-run\]/);
    assert.match(rehearsal.stdout, /会话戊/);
    assert.equal(received().length, 1);

    // 闸门放开后，压住的那条补投出去。
    const openGate = path.join(root, 'config-open.json');
    fs.writeFileSync(openGate, JSON.stringify({
      ...JSON.parse(fs.readFileSync(configPath, 'utf8')), minDispatchIntervalMs: 0,
    }));
    const released = await launch(openGate);
    assert.equal(released.status, 0, released.stderr);
    assert.equal(received().length, 2, '被压住的提醒晚到，但不能丢');
    assert.match(received()[1].body.message, /会话戊/);

    // 服务端连不上 → 非零退出码，让定时任务卡片进错误态。
    const broken = await run('--base-url', 'http://127.0.0.1:9');
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /连不上|Connection refused|ECONNREFUSED/i);
  });
