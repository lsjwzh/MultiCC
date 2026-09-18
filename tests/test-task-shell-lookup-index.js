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
const { airResponse } = require('./helpers/air-response');

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
  const res = airResponse();
  await handlers.get('/api/air')({}, res);
  const response = JSON.parse(res.body);
  assert.equal(snapshots, 1, 'admission.snapshot 必须每请求一次');
  assert.equal(accesses, 25, '每张卡片仍各自解析一次权属');
  assert.equal(response.tasks.length, 25);
  assert.equal(response.tasks[0].resource.id, 'ws_1');
  assert.equal(response.tasks[0].resource.lease, 'running');
  assert.deepEqual(response.budgets, { residentLimit: 128 });
});

test('receipt-shell 索引：与 list(receipt).filter().slice(-N) 逐字段一致', t => {
  const store = storeFixture(t);
  const legacy = (shellId, limit = 100) => store.list('receipt').filter(r => r.shellId === shellId).slice(-limit);
  assert.deepEqual(store.receiptsForShell('sh_1'), [], '没有收据的壳是空数组，不是「桶没建」');
  for (let i = 0; i < 130; i++) {
    store.set('receipt', `sr_${i}`, { id: `sr_${i}`, shellId: i % 2 ? 'sh_1' : 'sh_2',
      payload: { clientMsgId: `c${i}`, intent: 'work' }, status: 'accepted' });
  }
  // 同一条收据会被反复改写（reserve→delivering→accepted，还带 contextSavings）：
  // 更新既不能重复进桶，也不能把顺序挪到最后。
  store.set('receipt', 'sr_1', { id: 'sr_1', shellId: 'sh_1', payload: { clientMsgId: 'c1', intent: 'work' },
    status: 'failed', error: { code: 'x' }, contextSavings: { estimatedTokens: 12 } });
  for (const shellId of ['sh_1', 'sh_2', 'sh_none']) {
    assert.deepEqual(store.receiptsForShell(shellId), legacy(shellId), shellId + '：默认最后 100 条');
    assert.deepEqual(store.receiptsForShell(shellId, 5), legacy(shellId, 5), shellId + '：最后 5 条');
    assert.deepEqual(store.receiptsForShell(shellId, 1000), legacy(shellId, 1000), shellId + '：全量');
  }
  store.remove('receipt', 'sr_3');
  store.set('receipt', 'sr_5', { id: 'sr_5', shellId: 'sh_2', payload: { clientMsgId: 'c5', intent: 'work' }, status: 'accepted' });
  for (const shellId of ['sh_1', 'sh_2']) {
    assert.deepEqual(store.receiptsForShell(shellId), legacy(shellId), shellId + '：删除与改绑后仍然一致');
  }
});

test('receipt-shell 索引：老库首次读取扫一次补桶并落标记，缺行时自愈', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-shell-index-'));
  const file = path.join(dir, 'shell.sqlite');
  const store = createTaskShellStore(file);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  // 直接写库：模拟索引机制上线前就存在的收据行（store.set 会顺手建索引，绕开它）。
  const Database = require('better-sqlite3');
  const raw = new Database(file);
  for (let i = 0; i < 6; i++) {
    raw.prepare('INSERT INTO shell_records(kind, id, body) VALUES (?, ?, ?)').run('receipt', `sr_${i}`,
      JSON.stringify({ id: `sr_${i}`, shellId: i < 4 ? 'sh_a' : null, status: 'accepted', payload: { clientMsgId: `c${i}`, intent: 'work' } }));
  }
  raw.close();
  assert.equal(store.get('receipt-index-meta', 'v1'), null, '还没建过索引');
  assert.deepEqual(store.receiptsForShell('sh_a').map(r => r.id), ['sr_0', 'sr_1', 'sr_2', 'sr_3']);
  assert.ok(store.get('receipt-index-meta', 'v1'), '补桶后必须落标记，否则每个空壳都要再扫一次全表');
  assert.deepEqual(store.receiptsForShell('sh_none'), []);
  store.set('receipt', 'sr_new', { id: 'sr_new', shellId: 'sh_a', status: 'accepted', payload: { clientMsgId: 'new' } });
  assert.deepEqual(store.receiptsForShell('sh_a').map(r => r.id), ['sr_0', 'sr_1', 'sr_2', 'sr_3', 'sr_new']);
  // 索引行不是权威数据：库里的行被别的写法删掉后，读出来仍然是现存的那几条。
  const raw2 = new Database(file);
  raw2.prepare("DELETE FROM shell_records WHERE kind = 'receipt' AND id = ?").run('sr_2');
  raw2.close();
  assert.deepEqual(store.receiptsForShell('sh_a').map(r => r.id), ['sr_0', 'sr_1', 'sr_3', 'sr_new']);
});

test('view() 按壳读收据：不再整表 list(receipt)，投影与旧实现一致', t => {
  const f = fixture(t);
  const shellId = f.a.id;
  for (let i = 0; i < 120; i++) {
    f.store.set('receipt', `sr_${i}`, { id: `sr_${i}`, shellId, payload: { clientMsgId: `c${i}`, intent: i === 119 ? 'work' : 'steer' },
      status: 'accepted', contextSavings: i === 119 ? { estimatedTokens: 42 } : null });
  }
  const legacy = f.store.list('receipt').filter(r => r.shellId === shellId).slice(-100).map(r => ({
    id: r.id, clientMsgId: r.payload.clientMsgId, taskId: r.taskId, intent: r.payload.intent,
    status: r.status, error: r.error || null, contextSavings: r.contextSavings || null,
  }));
  // 收据表线上有 31MB：view() 里任何 list('receipt') 都应该立刻炸掉，而不是慢慢读。
  const origList = f.store.list;
  f.store.list = kind => {
    if (kind === 'receipt') throw new Error('view() 不该整表读 receipt');
    return origList(kind);
  };
  t.after(() => { f.store.list = origList; });
  const view = f.runtime.view(shellId);
  assert.equal(view.receipts.length, 100, '仍然只投影最后 100 条');
  assert.deepEqual(view.receipts, legacy);
  assert.deepEqual(view.tokenSavings, { estimatedTokens: 42 });
});
