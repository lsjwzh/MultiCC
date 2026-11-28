'use strict';

// GET /api/cron/calendar — the month-grid data source for the cron panel's
// calendar view. Follows tests/test-cron-task-first.js: fake deps, route map,
// next month so every cron expression has deterministic points left.

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

function nextMonth() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1, key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` };
}

async function setup(t, tasks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cron-calendar-'));
  const previous = process.env.MULTICC_DATA_DIR;
  process.env.MULTICC_DATA_DIR = root;
  fs.writeFileSync(path.join(root, 'scheduled_tasks.json'), JSON.stringify(tasks));
  const cron = require('../src/native/binding').createCronTasks();
  cron.init({
    directories: new Map([['dir-1', { id: 'dir-1', name: '项目一', path: root }]]),
    clis: ['claude'],
    taskSummary: () => null,
  });
  t.after(() => {
    cron.stop();
    if (previous === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'patch', 'delete']) {
    app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  }
  cron.mount(app);
  return { routes, cron, root };
}

test('calendar expands daily runs per day, skips disabled tasks, flags dense ones', async t => {
  const { month, key } = nextMonth();
  const daysInMonth = new Date(month.year, month.month, 0).getDate();
  const { routes, cron } = await setup(t, [
    { id: 'cron_daily', name: '每日站会', dirId: 'dir-1', cli: 'claude', cron: '0 9 * * *', prompt: 'p', enabled: true, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'cron_off', name: '停用', dirId: 'dir-1', cli: 'claude', cron: '0 10 * * *', prompt: 'p', enabled: false, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'cron_every_min', name: '高频巡检', dirId: 'dir-1', cli: 'claude', cron: '* * * * *', prompt: 'p', enabled: true, createdAt: '2026-01-01T00:00:00.000Z' },
  ]);
  await cron._migrateTasks();

  const res = response();
  await routes.get('GET /api/cron/calendar')({ query: { month: key } }, res, e => { throw e; });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.month, key);
  // 每日任务: 下个月每天都有且只有一个 09:00 的点(本机时区)。
  for (let day = 1; day <= daysInMonth; day++) {
    const points = (res.body.days[String(day)] || []).filter(p => p.id === 'cron_daily');
    assert.equal(points.length, 1, `day ${day}`);
    assert.equal(new Date(points[0].at).getHours(), 9);
    assert.equal(points[0].dense, false);
  }
  // 停用的任务不展开。
  const flat = Object.values(res.body.days).flat();
  assert.ok(!flat.some(p => p.id === 'cron_off'));
  // 每分钟任务: 触顶 200 点, 进 dense 名单, 已展开的点全标 dense。
  assert.deepEqual(res.body.dense, ['cron_every_min']);
  const densePoints = flat.filter(p => p.id === 'cron_every_min');
  assert.equal(densePoints.length, 200);
  assert.ok(densePoints.every(p => p.dense === true));
  // 同一天内按时间排序。
  for (const list of Object.values(res.body.days)) {
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].at <= list[i].at);
  }
});

test('calendar rejects malformed month and handles empty task list', async t => {
  const { routes, cron } = await setup(t, []);
  await cron._migrateTasks();

  const bad = response();
  await routes.get('GET /api/cron/calendar')({ query: { month: '2026-13' } }, bad, e => { throw e; });
  assert.equal(bad.statusCode, 400);
  const bad2 = response();
  await routes.get('GET /api/cron/calendar')({ query: {} }, bad2, e => { throw e; });
  assert.equal(bad2.statusCode, 400);

  const { key } = nextMonth();
  const ok = response();
  await routes.get('GET /api/cron/calendar')({ query: { month: key } }, ok, e => { throw e; });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body.days, {});
  assert.deepEqual(ok.body.dense, []);
});

test('calendar shows subscription placeholder jobs via their hint cron, but never-hint ones', async t => {
  const { year, month, key } = nextMonth();
  const daysInMonth = new Date(year, month, 0).getDate();
  const hintDay = Math.min(15, daysInMonth);   // 15 号 08:30 触发(展示提示)
  const hintCron = `30 8 ${hintDay} ${month} *`;
  const { routes, cron } = await setup(t, [
    // 订阅插件建的占位 job: disabled + createdBy=subscriptions + 指向下次真实触发时刻。
    { id: 'cron_sub', name: '📅 视频会员', dirId: 'dir-1', cli: 'claude', cron: hintCron, prompt: 'p', enabled: false, createdBy: 'subscriptions', createdAt: '2026-01-01T00:00:00.000Z' },
    // 暂停/已完结的订阅: cron 是永不匹配的 2 月 31 → 不展开, 也不烧一年扫描。
    { id: 'cron_sub_never', name: '📅 已完结', dirId: 'dir-1', cli: 'claude', cron: '0 0 31 2 *', prompt: 'p', enabled: false, createdBy: 'subscriptions', createdAt: '2026-01-01T00:00:00.000Z' },
    // 普通的停用任务(非订阅): 依旧不展开。
    { id: 'cron_user_off', name: '用户停用', dirId: 'dir-1', cli: 'claude', cron: '0 10 * * *', prompt: 'p', enabled: false, createdAt: '2026-01-01T00:00:00.000Z' },
  ]);
  await cron._migrateTasks();

  const res = response();
  await routes.get('GET /api/cron/calendar')({ query: { month: key } }, res, e => { throw e; });
  assert.equal(res.statusCode, 200);
  const flat = Object.values(res.body.days).flat();
  const sub = flat.filter(p => p.id === 'cron_sub');
  // 提示 cron 只在下月 15 号 08:30 命中一次(表达式年字段 *, 但月份限定)。
  assert.equal(sub.length, 1);
  assert.equal(new Date(sub[0].at).getDate(), hintDay);
  assert.equal(new Date(sub[0].at).getHours(), 8);
  assert.equal(new Date(sub[0].at).getMinutes(), 30);
  assert.equal(sub[0].dense, false);
  assert.ok(!flat.some(p => p.id === 'cron_sub_never'));
  assert.ok(!flat.some(p => p.id === 'cron_user_off'));
});
