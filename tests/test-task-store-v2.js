'use strict';
// 任务仓储 v2（native/core/src/task_store/context.rs）：台账独立成类、上下文记录分层、
// 每任务只留最近 20 轮选材明细，以及 v1→v2 一次性迁移。对照基准是旧 JS tracePlan
// 在完整计划上给出的引用来源。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fixture } = require('./helpers/task-shell');
const { createTaskShellStore } = require('../src/task-shell/store');
const { databaseConstructor } = require('../src/sqlite/driver');

const DETAIL_TURNS = 20;
const KEYS = ['id', 'version', 'mode', 'taskId', 'taskName', 'path', 'scope', 'skill', 'snapshotId', 'estimatedTokens', 'truncated', 'reason', 'via', 'messageCount'];
// 旧 context-plan.js tracePlan 的逐字复刻：迁移/压缩前后必须给出同一份来源。
function legacyTrace(plan, receipts, include) {
  if (!plan || plan.status === 'prepared') return [];
  const retained = (plan.retained || []).flatMap(ref => {
    const original = receipts[ref.receiptId]?.contextPlan?.sources.find(s => s.id === ref.id && s.version === ref.version);
    return original ? [{ ...original, retained: true }] : [];
  });
  return [...plan.sources, ...retained].map(source => ({ retained: source.retained === true,
    ...Object.fromEntries(KEYS.filter(k => source[k] !== undefined).map(k => [k, source[k]])),
    ...(include ? { excerpt: source.excerpt } : {}) }));
}
const source = (id, version, extra = {}) => ({ id, version, mode: 'memory:fact', taskName: `资料 ${id}`, path: `/m/${id}.md`,
  excerpt: `正文 ${id}@${version} `.repeat(20), priority: 300, label: id, reason: 'query', truncated: false, estimatedTokens: 42, ...extra });
// 第 i 轮：注入 m{i}，沿用上一轮注入的 m{i-1}，另有一条超预算与两条「与本轮无关」。
function turnPlan(task, i, status = 'committed') {
  return { turnId: `turn-${i}`, status, initial: i === 0, generation: i, cli: 'codex', roleEpoch: 1,
    budget: { limit: 8000, used: 100 + i, managedOnly: true },
    sources: [source(`m${i}`, `v${i}`), source('policy', 'p1', { mode: 'context:policy', reason: 'policy' })],
    retained: i ? [{ id: `m${i - 1}`, version: `v${i - 1}`, mode: 'memory:fact', taskName: `资料 m${i - 1}`, receiptId: `${task}-r${i - 1}` }] : [],
    omitted: [{ id: `big${i}`, reason: 'budget' }, { id: 'x', reason: 'not_relevant' }, { id: 'y', reason: 'not_relevant' }],
    removed: [], diagnostics: [] };
}
const receipt = (task, i, plan) => ({ id: `${task}-r${i}`, taskId: task, shellId: 'sh', contextPlan: plan });

function legacyDb(t, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-store-v1-'));
  const file = path.join(dir, 'shell.sqlite');
  const raw = new (databaseConstructor())(file, { timeout: 5000 });
  try {
    raw.exec('CREATE TABLE shell_records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id)); PRAGMA user_version=1;');
    const insert = raw.prepare('INSERT INTO shell_records(kind, id, body) VALUES (?, ?, ?)');
    for (const [kind, id, body] of rows) insert.run(kind, id, JSON.stringify(body));
  } finally { raw.close(); }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { file, dir };
}

test('v1→v2 迁移：台账搬出任务行，近 20 轮来源与旧格式逐项一致，更早的只留注入引用', t => {
  const task = 'tsk_m', total = 25, receipts = {};
  for (let i = 0; i < total; i++) receipts[`${task}-r${i}`] = receipt(task, i, turnPlan(task, i));
  receipts[`${task}-r${total}`] = receipt(task, total, turnPlan(task, total, 'sent'));   // 进行中的一轮原样保留
  const ledger = { sources: { [`m${total - 1}`]: { version: `v${total - 1}`, taskName: 'x', truncated: false, receiptId: `${task}-r${total - 1}` } },
    generation: total - 1, cli: 'codex', roleEpoch: 1, nativeId: 'n1' };
  const { file, dir } = legacyDb(t, [
    ['task', task, { id: task, sessionId: 's', title: '迁移', contextLedger: ledger }],
    ...Object.values(receipts).map(r => ['receipt', r.id, r]),
  ]);
  const expected = Object.fromEntries(Object.entries(receipts).map(([id, r]) => [id, legacyTrace(r.contextPlan, receipts, true)]));
  const store = createTaskShellStore(file);
  assert.equal(fs.readdirSync(dir).filter(name => name.includes('.v1-backup-')).length, 1);
  assert.equal(store.get('task', task).contextLedger, undefined, '台账不再留在任务行');
  const moved = store.get('context-ledger', task);
  assert.equal(moved.taskId, task);
  assert.equal(moved.generation, total - 1);
  assert.ok(moved.sources[`m${total - 1}`].key, '台账条目补上目录键');
  for (let i = 0; i <= total; i++) {
    const id = `${task}-r${i}`, trace = store.contextTrace(id, true);
    // 窗口按收据计：进行中的第 25 轮也占一格，已提交的 r6..r24 保留明细。
    if (i > total - DETAIL_TURNS) {
      assert.deepEqual(trace.sources, expected[id], `第 ${i} 轮来源一致`);
      assert.equal(trace.detailExpired, undefined);
      continue;
    }
    assert.equal(trace.detailExpired, true, `第 ${i} 轮降级`);
    assert.deepEqual(trace.sources.map(s => [s.id, s.version, s.retained]), [[`m${i}`, `v${i}`, false], ['policy', 'p1', false]]);
    assert.equal(trace.sources[0].excerpt, undefined, '降级后不再保留摘录');
    assert.deepEqual(trace.omittedCounts, { budget: 1, not_relevant: 2 });
    assert.deepEqual(trace.budget, receipts[id].contextPlan.budget);
  }
  const kept = store.contextTrace(`${task}-r${total - 1}`, false);
  assert.deepEqual(kept.omitted, [{ id: `big${total - 1}`, reason: 'budget' }], '「与本轮无关」只记数量');
  assert.deepEqual(kept.omittedCounts, { budget: 1, not_relevant: 2 });
  assert.deepEqual(kept.retained, [receipts[`${task}-r${total - 1}`].contextPlan.retained[0]]);
  // 目录：窗口内已提交 19 轮各一条 m{i}、共享的 policy 一条、窗口最老一轮沿用的 m5 一条。
  assert.equal(store.entries('context-source').length, DETAIL_TURNS + 1);
  store.close();
  const reopened = createTaskShellStore(file);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.contextTrace(`${task}-r${total - 1}`, true).sources, expected[`${task}-r${total - 1}`], '已是 v2 不再迁移');
  assert.equal(fs.readdirSync(dir).filter(name => name.includes('.v1-backup-')).length, 1);
});

test('迁移不依赖写入顺序：沿用可以指向更晚写入的收据（受理先后与提交先后不一致）', t => {
  const task = 'tsk_order';
  const first = receipt(task, 1, turnPlan(task, 1));     // 先受理、后提交：沿用 r0
  const second = receipt(task, 0, turnPlan(task, 0));    // 后受理、先提交
  const receipts = { [first.id]: first, [second.id]: second };
  const { file } = legacyDb(t, [['receipt', first.id, first], ['receipt', second.id, second]]);
  const want = legacyTrace(first.contextPlan, receipts, true);
  assert.ok(want.some(s => s.retained), '样例里确有沿用');
  const store = createTaskShellStore(file);
  t.after(() => store.close());
  assert.deepEqual(store.contextTrace(first.id, true).sources, want);
  assert.deepEqual(store.contextTrace(first.id, false).retained, first.contextPlan.retained);
});

test('每轮提交：计划压成引用、同一资料只存一份，超过 20 轮的明细随提交降级并回收目录', t => {
  const f = fixture(t), task = 'tsk_live';
  const receipts = {};
  for (let i = 0; i < DETAIL_TURNS + 3; i++) {
    const r = receipt(task, i, turnPlan(task, i));
    receipts[r.id] = r;
    const expected = legacyTrace(r.contextPlan, receipts, true);
    f.store.set('receipt', r.id, r);
    assert.deepEqual(f.store.contextTrace(r.id, true).sources, expected, '提交前（完整计划）');
    f.store.contextCommitted(task, r.id);
    const compact = f.store.get('receipt', r.id).contextPlan;
    assert.equal(compact.format, 2);
    assert.ok(!JSON.stringify(compact).includes('正文'), '收据里不再有注入正文');
    assert.deepEqual(f.store.contextTrace(r.id, true).sources, expected, '提交后（压缩计划）');
  }
  assert.equal(f.store.contextTrace(`${task}-r2`, false).detailExpired, true);
  assert.equal(f.store.contextTrace(`${task}-r3`, false).detailExpired, undefined);
  assert.equal(f.store.entries('context-source').filter(([, row]) => row.taskId === task).length, DETAIL_TURNS + 2);
  // 同一资料（policy）在 23 轮里只存一份；未提交的收据不受影响。
  assert.equal(f.store.entries('context-source').filter(([, row]) => row.source.id === 'policy').length, 1);
  assert.equal(f.store.contextCommitted('tsk_other', `${task}-r0`), null, '收据不属于该任务时不处理');
});

test('内容没变的写入不落盘、不推进读数：派生缓存不会无故失效', t => {
  const f = fixture(t);
  f.store.set('task', 'tsk_same', { id: 'tsk_same', sessionId: 's1', title: '同值' });
  const before = f.store.epoch(['task', 'task-session']);
  f.store.set('task', 'tsk_same', { id: 'tsk_same', sessionId: 's1', title: '同值' });
  assert.equal(f.store.epoch(['task', 'task-session']), before);
  f.store.set('task', 'tsk_same', { id: 'tsk_same', sessionId: 's1', title: '改了' });
  assert.notEqual(f.store.epoch(['task', 'task-session']), before);
  f.store.set('snapshot', 'snap', { id: 'snap', messages: [] });
  f.store.set('snapshot', 'snap', { id: 'snap', messages: [] });
  assert.throws(() => f.store.set('snapshot', 'snap', { id: 'snap', messages: [1] }), /immutable snapshot conflict/);
});

test('整页批量权限与逐卡 taskAccess 同一套规则、结果逐张一致', t => {
  const f = fixture(t, { taskFirst: true });
  f.store.set('shell', 'sh_solo', { id: 'sh_solo', sourceSessionId: 'a', dirId: 'd1', standalone: true });
  f.store.set('shell', 'sh_shared', { id: 'sh_shared', sourceSessionId: 'b', dirId: 'd1', standalone: false });
  const tasks = [
    { id: 'tsk_owned', ownerShellId: 'sh_solo', sessionId: 'a', origin: 'board' },
    { id: 'tsk_linked', sessionId: 'b', taskFirst: false, forkedFromTaskId: 'tsk_owned' },
    { id: 'tsk_linked_first', sessionId: 'b', taskFirst: true },
    { id: 'tsk_archived', ownerShellId: 'sh_solo', status: 'archived' },
    { id: 'tsk_board', origin: 'board' },
    { id: 'tsk_orphan', refs: [{ sessionId: 'missing' }] },
  ];
  for (const task of tasks) f.store.set('task', task.id, task);
  f.store.set('link', 'link-1', { taskId: 'tsk_linked', shellId: 'sh_shared' });
  f.store.set('link', 'link-2', { taskId: 'tsk_linked_first', shellId: 'sh_shared' });
  const batch = f.runtime.taskAccessBatch(tasks);
  assert.deepEqual([...batch.keys()], tasks.map(t => t.id));
  for (const task of tasks) assert.deepEqual(batch.get(task.id), f.runtime.taskAccess(task), task.id);
  assert.equal(batch.get('tsk_linked').readOnly, true);
  assert.equal(batch.get('tsk_linked_first').readOnly, false);
  assert.equal(batch.get('tsk_archived').readOnly, true);
});

test('启动闸门的只读探测与单份备份：被打断留下的旧备份/半成品先清掉，迁移后只剩一份、进度文件删除', t => {
  const addon = require('../src/native/runtime').getNative('task_store', 'rust');
  const empty = legacyDb(t, []);
  assert.equal(addon.taskStoreMigrationPending(path.join(empty.dir, 'absent.sqlite')), false, '库不存在');
  assert.equal(addon.taskStoreMigrationPending(empty.file), false, '空的旧库不需要迁移');
  const { file, dir } = legacyDb(t, [['task', 'tsk_b', { id: 'tsk_b', title: '备份' }]]);
  assert.equal(addon.taskStoreMigrationPending(file), true);
  // 上一次被杀掉的迁移：一份完整旧备份 + 一份写到一半的半成品。
  fs.writeFileSync(`${file}.v1-backup-1`, 'old');
  fs.writeFileSync(`${file}.v1-backup-2.partial`, 'half');
  const report = JSON.parse(addon.migrateTaskStore(file));
  assert.equal(report.from, 1);
  assert.equal(report.to, 2);
  const backups = fs.readdirSync(dir).filter(name => name.startsWith('shell.sqlite.v1-backup-'));
  assert.deepEqual(backups, [path.basename(report.backup)], '只留本次这一份完整备份');
  assert.equal(fs.existsSync(`${file}.migration.json`), false, '成功后不留进度文件');
  assert.equal(addon.taskStoreMigrationPending(file), false, '迁移后不再需要');
  const store = createTaskShellStore(file);
  t.after(() => store.close());
  assert.equal(store.get('task', 'tsk_b').title, '备份');
  // 备份本身是迁移前的旧库，可原样恢复。
  const raw = new (databaseConstructor())(report.backup, { readonly: true });
  try { assert.equal(raw.pragma('user_version', { simple: true }), 1); } finally { raw.close(); }
});
