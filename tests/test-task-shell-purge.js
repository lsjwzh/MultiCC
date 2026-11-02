'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/task-shell');
const { databaseConstructor } = require('../src/sqlite/driver');

test('删除投影保留存储键、关联值类型和缺失字段，兼容没有派生索引的旧行', t => {
  const f = fixture(t);
  const raw = new (databaseConstructor())(f.file, { timeout: 5000 });
  const rows = [
    ['stored-key', { id: 'logical-id', taskId: 'tsk_old', receiptId: 'receipt-old', payload: '大正文'.repeat(5000) }],
    ['missing', {}],
    ['nulls', { id: null, taskId: null, receiptId: null }],
    ['typed', { id: false, taskId: 7, receiptId: ['a', { nested: true }] }],
  ];
  try {
    const insert = raw.prepare('INSERT INTO shell_records(kind, id, body) VALUES (?, ?, ?)');
    for (const [id, row] of rows) insert.run('receipt', id, JSON.stringify(row));
  } finally { raw.close(); }
  assert.deepEqual(f.store.deletionEntries('receipt'), rows.map(([id, row]) => [id,
    Object.fromEntries(Object.entries(row).filter(([key]) => ['id', 'taskId', 'receiptId'].includes(key)))]));
  assert.equal(f.store.get('receipt-index-meta', 'v1'), null, '投影查询不依赖或重建收据桶');
});

test('删除投影在 SQL 里只取引用字段，孤立代理项与整行宽松解码口径一致', t => {
  const f = fixture(t);
  const raw = new (databaseConstructor())(f.file, { timeout: 5000 });
  // 原文字面量里的孤立代理项转义：SQLite 接受，serde 只能宽松解码。
  const body = '{"id":"r\\ud800","taskId":"tsk_\\udc00x","payload":"\\ud83d"}';
  try { raw.prepare('INSERT INTO shell_records(kind, id, body) VALUES (?, ?, ?)').run('receipt', 'lone', body); }
  finally { raw.close(); }
  assert.deepEqual(f.store.deletionEntries('receipt'), [['lone', { id: 'r\ufffd', taskId: 'tsk_\ufffdx' }]]);
  assert.deepEqual(f.store.get('receipt', 'lone'), { id: 'r\ufffd', taskId: 'tsk_\ufffdx', payload: '\ufffd' });
});

test('批量删除按原有归属清理关联行和索引，并保留共享快照与仍有任务的壳', t => {
  const f = fixture(t);
  const shells = [
    { id: 'sh_deleted', standalone: true, defaultTaskId: 'tsk_a', currentTaskId: 'tsk_a' },
    { id: 'sh_kept', standalone: true, defaultTaskId: 'tsk_b', currentTaskId: 'tsk_b', cursorVersion: 4 },
    { id: 'sh_shared', standalone: false, defaultTaskId: 'tsk_keep', currentTaskId: 'tsk_a', cursorVersion: 9 },
  ];
  for (const shell of shells) f.store.set('shell', shell.id, shell);
  const tasks = [
    { id: 'tsk_a', sessionId: 'session-a', ownerShellId: 'sh_deleted', snapshotIds: ['snap_a', 'snap_shared'] },
    { id: 'tsk_b', sessionId: 'session-b', ownerShellId: 'sh_kept', snapshotIds: ['snap_b'] },
    { id: 'tsk_keep', sessionId: 'session-keep', ownerShellId: 'sh_kept', snapshotIds: ['snap_shared', 'snap_keep'] },
  ];
  for (const task of tasks) f.store.set('task', task.id, task);
  for (const id of ['snap_a', 'snap_b', 'snap_shared', 'snap_keep']) f.store.set('snapshot', id, { id });
  for (const task of tasks) f.store.set('link', `link-${task.id}`, { taskId: task.id, shellId: task.ownerShellId });
  // 收据的存储键与正文 id 故意不同，答案仍需沿正文 id 清理。
  f.store.set('receipt', 'receipt-storage', { id: 'receipt-a', taskId: 'tsk_a', shellId: 'sh_deleted' });
  f.store.set('receipt', 'receipt-keep', { id: 'receipt-keep', taskId: 'tsk_keep', attributedTaskId: 'tsk_a', shellId: 'sh_kept' });
  f.store.set('receipt', 'tsk_b', { id: 'receipt-by-key', taskId: 'tsk_keep', shellId: 'sh_kept' });
  for (const kind of ['claim', 'answer', 'fork', 'task-separation']) {
    f.store.set(kind, 'via-task', { taskId: 'tsk_b' });
    f.store.set(kind, 'via-receipt', { receiptId: 'receipt-a' });
    f.store.set(kind, 'tsk_a', { taskId: 'tsk_keep' });
    f.store.set(kind, 'unrelated', { taskId: 'tsk_keep', receiptId: 'receipt-keep' });
    f.store.set(kind, 'key-only-receipt', { receiptId: 'receipt-by-key' });
  }
  f.store.receiptsForShell('sh_deleted');
  const heldTasks = f.store.cachedList('task');
  const heldShells = f.store.cachedList('shell');
  f.runtime.purgeTasks(['tsk_a', 'tsk_b']);

  assert.deepEqual(f.store.list('task').map(row => row.id), ['tsk_keep']);
  assert.deepEqual(f.store.list('snapshot').map(row => row.id), ['snap_shared', 'snap_keep']);
  assert.equal(f.store.get('shell', 'sh_deleted'), null);
  assert.deepEqual(f.store.get('shell', 'sh_kept'), { ...shells[1], currentTaskId: null, defaultTaskId: null, cursorVersion: 5 });
  assert.deepEqual(f.store.get('shell', 'sh_shared'), { ...shells[2], currentTaskId: null, cursorVersion: 10 });
  for (const kind of ['claim', 'answer', 'fork', 'task-separation']) {
    assert.deepEqual(f.store.entries(kind).map(([id]) => id).sort(), ['key-only-receipt', 'unrelated']);
  }
  assert.equal(f.store.taskBySession('session-a'), null);
  assert.equal(f.store.taskBySession('session-b'), null);
  assert.equal(f.store.taskBySession('session-keep').id, 'tsk_keep');
  assert.equal(f.store.linkByTask('tsk_a'), null);
  assert.equal(f.store.linkByTask('tsk_b'), null);
  assert.equal(f.store.linkByTask('tsk_keep').shellId, 'sh_kept');
  assert.deepEqual(f.store.receiptsForShell('sh_deleted'), []);
  assert.deepEqual(f.store.receiptsForShell('sh_kept').map(row => row.id), ['receipt-keep']);
  assert.deepEqual(f.store.cachedList('task').map(row => row.id), ['tsk_keep']);
  assert.equal(heldTasks.length, 3, '不就地改写旧行缓存');
  assert.equal(heldShells.find(row => row.id === 'sh_kept').currentTaskId, 'tsk_b');
  // 重复删除不改变已经归零的游标，也不删除共享快照。
  f.runtime.purgeTasks(['tsk_a', 'tsk_b']);
  assert.equal(f.store.get('shell', 'sh_kept').cursorVersion, 5);
  assert.ok(f.store.get('snapshot', 'snap_shared'));
});

test('删除只扫一次收据关联投影，壳数量不增加 task 全表读取，JS 不解析收据正文', t => {
  const f = fixture(t);
  const marker = '不可送入删除路径的收据正文';
  const payload = marker.repeat(10000);
  f.store.set('task', 'tsk_delete', { id: 'tsk_delete', sessionId: 'session-delete', snapshotIds: [] });
  f.store.set('task', 'tsk_keep', { id: 'tsk_keep', sessionId: 'session-keep', snapshotIds: [] });
  for (let i = 0; i < 12; i++) {
    f.store.set('shell', `sh_${i}`, { id: `sh_${i}`, standalone: true, defaultTaskId: 'tsk_delete' });
    f.store.set('receipt', `receipt_${i}`, { id: `receipt_${i}`, shellId: `sh_${i}`,
      taskId: i === 0 ? 'tsk_delete' : 'tsk_keep', payload });
  }
  const scans = new Map();
  let taskReads = 0;
  const originalList = f.store.list, originalEntries = f.store.entries;
  const originalDeletionEntries = f.store.deletionEntries;
  const originalParse = JSON.parse;
  f.store.list = kind => {
    assert.notEqual(kind, 'receipt', '禁止整表读取收据正文');
    if (kind === 'task') taskReads++;
    return originalList(kind);
  };
  f.store.entries = kind => {
    assert.notEqual(kind, 'receipt', '禁止通过 entries 整表读取收据正文');
    return originalEntries(kind);
  };
  f.store.deletionEntries = kind => {
    scans.set(kind, (scans.get(kind) || 0) + 1);
    return originalDeletionEntries(kind);
  };
  JSON.parse = function (text, ...args) {
    assert.equal(typeof text === 'string' && text.includes(marker), false,
      '关联与无关的收据大正文都不应传给 JSON.parse');
    return originalParse.call(this, text, ...args);
  };
  try { f.runtime.purgeTasks(['tsk_delete']); }
  finally { JSON.parse = originalParse; }
  assert.equal(scans.get('receipt'), 1, '收据投影只扫描一次并复用于关联删除');
  assert.equal(taskReads, 2, '删除前与删除后各读一次，剩余集合供全部壳和快照复用');
  assert.equal(f.store.get('receipt', 'receipt_0'), null);
  assert.equal(f.store.get('receipt', 'receipt_1').payload, payload);
});

test('清理后段失败时任务、收据桶、壳和快照在同一事务中完整回滚', t => {
  const f = fixture(t);
  f.store.set('task', 'tsk_delete', { id: 'tsk_delete', sessionId: 'session-delete', ownerShellId: 'sh_delete', snapshotIds: ['snapshot-delete'] });
  f.store.set('shell', 'sh_delete', { id: 'sh_delete', standalone: true, defaultTaskId: 'tsk_delete' });
  f.store.set('link', 'link-delete', { taskId: 'tsk_delete', shellId: 'sh_delete' });
  f.store.set('receipt', 'receipt-delete', { id: 'receipt-delete', taskId: 'tsk_delete', shellId: 'sh_delete' });
  f.store.set('answer', 'answer-delete', { receiptId: 'receipt-delete' });
  f.store.set('snapshot', 'snapshot-delete', { id: 'snapshot-delete' });
  f.store.receiptsForShell('sh_delete');
  const kinds = ['task', 'shell', 'link', 'receipt', 'answer', 'snapshot', 'task-session', 'link-task', 'receipt-shell'];
  const before = new Map(kinds.map(kind => [kind, f.store.entries(kind)]));
  const remove = f.store.remove;
  f.store.remove = (kind, id) => {
    if (kind === 'snapshot') throw new Error('模拟快照清理失败');
    return remove(kind, id);
  };
  assert.throws(() => f.runtime.purgeTasks(['tsk_delete']), /模拟快照清理失败/);
  for (const kind of kinds) assert.deepEqual(f.store.entries(kind), before.get(kind), `${kind} 必须回滚`);
  assert.equal(f.store.taskBySession('session-delete').id, 'tsk_delete');
  assert.deepEqual(f.store.receiptsForShell('sh_delete').map(row => row.id), ['receipt-delete']);
});
