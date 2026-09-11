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
