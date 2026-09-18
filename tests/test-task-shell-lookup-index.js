'use strict';
// 回归守卫：任务壳的单点查询（sessionId→task、taskId→link）必须走索引，
// 不能退化成 list(kind).find(...) 的全表读 + 逐行 JSON.parse。
// 背景：任务板读投影按卡片逐个解析权属，一次 /api/air 曾因此把 229 行的
// task 表整表读 511 遍（约 490MB JSON），单请求 3 秒以上 CPU。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskShellStore } = require('../src/task-shell/store');
const { fixture } = require('./helpers/task-shell');
const { mountAirRoutes } = require('../src/workspace/air-routes');

function storeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-shell-index-'));
  const store = createTaskShellStore(path.join(dir, 'shell.sqlite'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}

test('sessionId→task 索引：负标记可被后来创建的任务覆盖，改绑与删除都同步', t => {
  const store = storeFixture(t);
  assert.equal(store.taskBySession('s1'), null, '未命中先落负标记');
  store.set('task', 'tsk_a', { id: 'tsk_a', sessionId: 's1', title: 'A' });
  assert.equal(store.taskBySession('s1').id, 'tsk_a', '任务创建后负标记必须被覆盖');
  store.set('task', 'tsk_a', { id: 'tsk_a', sessionId: 's2', title: 'A' });
  assert.equal(store.taskBySession('s1'), null, '改绑后旧 sessionId 不再指向该任务');
  assert.equal(store.taskBySession('s2').id, 'tsk_a');
  store.remove('task', 'tsk_a');
  assert.equal(store.taskBySession('s2'), null, '删除任务同步清索引');
  assert.equal(store.list('task').length, 0);
});

test('taskId→link 索引：保持 list().find 的「最早一条」语义，删除后不残留', t => {
  const store = storeFixture(t);
  assert.equal(store.linkByTask('tsk_a'), null);
  store.set('link', 'sh_1:tsk_a', { shellId: 'sh_1', taskId: 'tsk_a' });
  store.set('link', 'sh_2:tsk_a', { shellId: 'sh_2', taskId: 'tsk_a' });
  assert.equal(store.linkByTask('tsk_a').shellId, 'sh_1', '同任务多条 link 仍解析最早那条');
  store.remove('link', 'sh_1:tsk_a');
  assert.equal(store.linkByTask('tsk_a').shellId, 'sh_2', '最早那条被删后回退扫描，解析到现存最早的那条');
  store.remove('link', 'sh_2:tsk_a');
  assert.equal(store.linkByTask('tsk_a'), null);
});

test('索引读与旧的全表扫描语义一致（含无 sessionId 的任务）', t => {
  const store = storeFixture(t);
  const rows = [
    { id: 'tsk_1', sessionId: 's1', title: '一' },
    { id: 'tsk_2', sessionId: null, title: '没有会话' },
    { id: 'tsk_3', sessionId: 's3', title: '三' },
  ];
  for (const row of rows) store.set('task', row.id, row);
  const legacy = sessionId => store.list('task').find(task => task.sessionId === sessionId) || null;
  for (const sessionId of ['s1', 's2', 's3']) {
    assert.deepEqual(store.taskBySession(sessionId), legacy(sessionId), 'sessionId=' + sessionId);
  }
  // 空 sessionId 不再落进「任何一张没有会话的卡」这种意外的匹配。
  assert.equal(store.taskBySession(null), null);
  assert.equal(store.taskBySession(undefined), null);
  const links = [{ shellId: 'sh_a', taskId: 'tsk_1' }, { shellId: 'sh_b', taskId: 'tsk_9' }];
  for (const link of links) store.set('link', `${link.shellId}:${link.taskId}`, link);
  const legacyLink = taskId => store.list('link').find(link => link.taskId === taskId) || null;
  for (const taskId of ['tsk_1', 'tsk_9', 'tsk_none']) {
    assert.deepEqual(store.linkByTask(taskId), legacyLink(taskId), 'taskId=' + taskId);
  }
});

test('任务板逐卡片解析权属不再触发 task/link 全表读（每次请求 511 次 → 0 次）', t => {
  const f = fixture(t);
  for (let i = 0; i < 6; i++) {
    f.store.set('task', `tsk_store_${i}`, { id: `tsk_store_${i}`, dirId: 'd1', sessionId: 'a', title: `任务 ${i}` });
  }
  // 每张卡片一份：历史 observed 卡（store 里没有对应 task 行、只能靠 refs 找回会话）
  const cards = [];
  for (let i = 0; i < 40; i++) cards.push({ id: `tsk_legacy_${i}`, dirId: 'd1', title: `历史 ${i}`, refs: [{ sessionId: i % 2 ? 'a' : 'b' }] });
  for (const task of f.store.list('task')) cards.push(task);
  const counted = new Map();
  const origList = f.store.list, origGet = f.store.get;
  f.store.list = kind => { counted.set('list:' + kind, (counted.get('list:' + kind) || 0) + 1); return origList(kind); };
  f.store.get = (kind, id) => { counted.set('get:' + kind, (counted.get('get:' + kind) || 0) + 1); return origGet(kind, id); };
  for (const card of cards) f.runtime.taskAccess(card);   // 第一次：回填索引
  counted.clear();
  for (const card of cards) f.runtime.taskAccess(card);   // 第二次：必须全是单点读
  assert.equal(counted.get('list:task') || 0, 0, 'task 全表读必须为 0');
  assert.equal(counted.get('list:link') || 0, 0, 'link 全表读必须为 0');
  assert.ok((counted.get('get:task') || 0) >= cards.length, '仍然逐个读卡片自己的 task 行');
});

test('/api/air 一次请求只读一次 admission 快照（不再按卡片各读一次）', async () => {
  const handlers = new Map();
  const app = { get: (p, fn) => handlers.set(p, fn), post() {} };
  let snapshots = 0, accesses = 0;
  const records = new Map([['s1', { id: 's1', dirId: 'd1', kind: 'chat', workspaceOwnerSessionId: 's1' }]]);
  const board = { tasks: {}, modules: {}, deletedTaskIds: [] };
  for (let i = 0; i < 25; i++) board.tasks[`tsk_${i}`] = { id: `tsk_${i}`, title: `卡片 ${i}`, status: 'active',
    recordType: 'observed', chatSessionId: i === 0 ? 's1' : null, refs: [{ sessionId: 's1', dirId: 'd1' }] };
  board.tasks.tsk_0.ownerShellId = 'sh_1';
  mountAirRoutes(app, {
    admission: {
      snapshot: () => { snapshots++; return { workspaces: [{ id: 'ws_1', ownerId: 's1', residency: 'resident', path: '/repo/wt', branch: 'b', pins: [] }],
        leases: [{ workspaceId: 'ws_1', state: 'running', reason: null }], budgets: { residentLimit: 128 } }; },
      capacityReason: () => null,
    },
    records, directories: new Map([['d1', { id: 'd1', name: 'Repo', path: '/repo' }]]),
    getBoard: () => board, clis: ['codex'],
    shell: { taskAccess: task => { accesses++; return { readOnly: true, ownerShellId: null, sourceSessionId: null, status: 'active' }; } },
  });
  const response = await new Promise((resolve, reject) => {
    handlers.get('/api/air')({}, { json: resolve, status: () => ({ json: reject }) });
  });
  assert.equal(snapshots, 1, 'admission.snapshot 必须每请求一次');
  assert.equal(accesses, 25, '每张卡片仍各自解析一次权属');
  assert.equal(response.tasks.length, 25);
  assert.equal(response.tasks[0].resource.id, 'ws_1');
  assert.equal(response.tasks[0].resource.lease, 'running');
  assert.deepEqual(response.budgets, { residentLimit: 128 });
});
