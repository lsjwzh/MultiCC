'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { databaseConstructor } = require('../sqlite/driver');

// Durable task-shell routing state. Chat history and the task board
// keep their existing ownership. Sync transactions cover decisions before any
// asynchronous workspace creation or delivery can yield.
function createTaskShellStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const Database = databaseConstructor();
  const db = new Database(file, { timeout: 5000 });
  try {
    const version = db.pragma('user_version', { simple: true });
    if (version > 1) throw new Error('unsupported task-shell schema');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.exec('CREATE TABLE IF NOT EXISTS shell_records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind, id)); PRAGMA user_version = 1;');
    if (file !== ':memory:') for (const suffix of ['', '-wal', '-shm']) {
      try { fs.chmodSync(file + suffix, 0o600); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  } catch (error) { db.close(); throw error; }
  const select = db.prepare('SELECT body FROM shell_records WHERE kind = ? AND id = ?');
  const all = db.prepare('SELECT body FROM shell_records WHERE kind = ? ORDER BY rowid');
  const allWithIds = db.prepare('SELECT id, body FROM shell_records WHERE kind = ? ORDER BY rowid');
  const allWithRowids = db.prepare('SELECT rowid AS rid, id, body FROM shell_records WHERE kind = ? ORDER BY rowid');
  const rowidOf = db.prepare('SELECT rowid AS rid FROM shell_records WHERE kind = ? AND id = ?');
  const receiptWatermarkStmt = db.prepare("SELECT max(rowid) AS mx FROM shell_records WHERE kind = 'receipt'");
  const put = db.prepare('INSERT INTO shell_records(kind, id, body) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body');
  const remove = db.prepare('DELETE FROM shell_records WHERE kind = ? AND id = ?');
  const get = (kind, id) => { const row = select.get(kind, id); return row ? JSON.parse(row.body) : null; };
  const scan = kind => allWithIds.all(kind).map(row => ({ id: row.id, value: JSON.parse(row.body) }));

  // ── 派生索引 ────────────────────────────────────────────────────────────
  // 「按 sessionId 找 task」「按 taskId 找 link」是任务壳每次读投影都要问的
  // 单点查询，但 shell_records 只有 PRIMARY KEY(kind, id)：task 行的 id 是
  // tsk_…，sessionId 没有二级索引。这两次查询因此被写成了 list(kind).find()，
  // 即每次全表读 + 逐行 JSON.parse。任务板读投影是按卡片逐个解析权属的，
  // 实测 1069 张卡片会触发 511 次 task 全表读（约 490MB JSON 重新解析），
  // 单次 /api/air 约 3.1s CPU —— 全部花在同一个 O(1) 查询上。
  // 索引行是派生状态：与源行同事务写入，读不到时回退一次全表扫描并回填
  // 标记（含"确实没有"的负标记），永远不是权威数据。
  // 一个 sessionId 只应有一个 task（identity 由 adopt 保证）；真出现重复行时
  // 索引取最后写入的那一行，而不是旧的 list().find 会取到的最早一行。
  const TASK_BY_SESSION = 'task-session';
  const LINK_BY_TASK = 'link-task';
  const indexRow = (kind, id) => get(kind, id);
  // 会话壳的收据（receipt）是任务壳里最大的一张表：线上 1294 行、约 31MB，
  // 单行最大 200KB（快照/上下文计划都挂在上面）。view() 起初只想要「这个壳
  // 最后 100 条收据」，却因此把整张表 list() 出来逐行 JSON.parse —— 每次
  // /api/task-shells/:id 约 0.35s，全部花在过滤别的壳的行上。
  // 索引先按壳分桶保存收据 id（插入序，与 rowid 一致，也就是旧的 list() 顺序）。
  // 老库第一次读时用一次全表扫描把桶建全，之后只增量维护；meta 行记录
  // 「已经建过」，这样「这个壳没有收据」和「桶还没建」不会再被混为一谈。
  const RECEIPTS_BY_SHELL = 'receipt-shell';
  const RECEIPT_INDEX_META = 'receipt-index-meta';
  function dropTaskIndex(taskId, sessionId) {
    if (!sessionId) return;
    const current = indexRow(TASK_BY_SESSION, sessionId);
    if (current && current.taskId === taskId) remove.run(TASK_BY_SESSION, sessionId);
  }
  function dropLinkIndex(linkId) {
    const row = select.get('link', linkId);
    if (!row) return;
    const link = JSON.parse(row.body);
    if (!link?.taskId) return;
    const current = indexRow(LINK_BY_TASK, link.taskId);
    if (current && current.linkId === linkId) remove.run(LINK_BY_TASK, link.taskId);
  }
  // 桶里存 { id, rowid } 而不是纯 id：旧实现按 list() 的 rowid 顺序取最后 N 条，
  // 收据被改写（UPSERT）时 rowid 不变。只存 id 的话，「换了壳的收据」或任何
  // 改写都会掉到桶尾，读出来的顺序就与旧行为不一致。
  function receiptItemsFor(shellId) {
    return indexRow(RECEIPTS_BY_SHELL, shellId)?.items || [];
  }
  function writeReceiptItems(shellId, items) {
    put.run(RECEIPTS_BY_SHELL, shellId, JSON.stringify({ shellId, items }));
  }
  function addReceiptIndex(shellId, receiptId) {
    const items = receiptItemsFor(shellId);
    const rowid = rowidOf.get('receipt', receiptId)?.rid ?? null;
    const existing = items.find(item => item.id === receiptId);
    if (existing) {
      if (existing.rowid !== rowid) writeReceiptItems(shellId, items.map(item => item.id === receiptId ? { id: receiptId, rowid } : item));
      return;
    }
    writeReceiptItems(shellId, [...items, { id: receiptId, rowid }]);
    bumpReceiptWatermark(rowid);
  }
  // meta 里的 watermark 是本进程已经记进桶的最大收据 rowid。库里出现了比它更大的
  // 行，就说明有人绕过本进程写过收据（老代码进程在重启交接窗口里补写），这时桶不再
  // 可信，必须重建一次 —— 否则那几条收据会永久不出现在 view() 里。
  function receiptWatermark() {
    return receiptWatermarkStmt.get().mx ?? 0;
  }
  function bumpReceiptWatermark(rowid) {
    const meta = indexRow(RECEIPT_INDEX_META, 'v1');
    if (!meta || !rowid || rowid <= (meta.watermark || 0)) return;
    put.run(RECEIPT_INDEX_META, 'v1', JSON.stringify({ ...meta, watermark: rowid }));
  }
  function dropReceiptIndex(shellId, receiptId) {
    if (!shellId) return;
    const items = receiptItemsFor(shellId);
    const next = items.filter(item => item.id !== receiptId);
    if (next.length !== items.length) writeReceiptItems(shellId, next);
  }
  // 一次全表扫描把所有壳的桶补齐（老库首次读取时走一次），并落 meta 标记。
  const buildReceiptIndex = db.transaction(force => {
    if (!force && indexRow(RECEIPT_INDEX_META, 'v1')) return;
    const grouped = new Map();
    for (const row of allWithRowids.all('receipt')) {
      const shellId = JSON.parse(row.body)?.shellId;
      if (!shellId) continue;
      if (!grouped.has(shellId)) grouped.set(shellId, []);
      grouped.get(shellId).push({ id: row.id, rowid: row.rid });
    }
    for (const [shellId, items] of grouped) writeReceiptItems(shellId, items);
    put.run(RECEIPT_INDEX_META, 'v1', JSON.stringify({ builtAt: Date.now(), watermark: receiptWatermark(), shells: grouped.size }));
  });
  const putIndexed = db.transaction((kind, id, body, previous) => {
    // 先写源行、再维护派生索引：收据桶要记录源行的 rowid（顺序就是它），
    // 而 rowid 只有行写下去之后才存在。
    put.run(kind, id, body);
    if (kind === 'task') {
      const before = previous ? JSON.parse(previous.body) : null;
      const after = JSON.parse(body);
      if (before?.sessionId && before.sessionId !== after?.sessionId) dropTaskIndex(id, before.sessionId);
      if (after?.sessionId) put.run(TASK_BY_SESSION, after.sessionId, JSON.stringify({ taskId: after.id || id, sessionId: after.sessionId }));
    } else if (kind === 'link') {
      const link = JSON.parse(body);
      // list('link').find 一直解析到「这个 task 的最早一条 link」；保持这个语义，
      // 否则同一个 task 被再次 link 时会静默把卡片换到另一个 shell 名下。
      const current = link?.taskId && indexRow(LINK_BY_TASK, link.taskId);
      if (link?.taskId && !current?.linkId) {
        put.run(LINK_BY_TASK, link.taskId, JSON.stringify({ taskId: link.taskId, shellId: link.shellId, linkId: id }));
      }
    } else if (kind === 'receipt') {
      const before = previous ? JSON.parse(previous.body) : null;
      const after = JSON.parse(body);
      if (before?.shellId && before.shellId !== after?.shellId) dropReceiptIndex(before.shellId, id);
      if (after?.shellId) addReceiptIndex(after.shellId, id);
    }
  });
  const removeIndexed = db.transaction((kind, id) => {
    if (kind === 'task') {
      const row = select.get('task', id);
      dropTaskIndex(id, row ? JSON.parse(row.body)?.sessionId : null);
    } else if (kind === 'link') dropLinkIndex(id);
    else if (kind === 'receipt') dropReceiptIndex(select.get('receipt', id) ? JSON.parse(select.get('receipt', id).body)?.shellId : null, id);
    return remove.run(kind, id);
  });
  return {
    get,
    list: kind => all.all(kind).map(row => JSON.parse(row.body)),
    entries: kind => db.prepare('SELECT id, body FROM shell_records WHERE kind = ?').all(kind).map(row => [row.id, JSON.parse(row.body)]),
    // 单点查询（索引命中即一次单行读；未命中回退扫描并回填标记）。
    taskBySession(sessionId) {
      if (!sessionId) return null;
      const indexed = indexRow(TASK_BY_SESSION, sessionId);
      if (indexed) {
        const found = indexed.taskId ? get('task', indexed.taskId) : null;
        if (indexed.taskId && !found) remove.run(TASK_BY_SESSION, sessionId);
        return found;
      }
      const found = scan('task').find(entry => entry.value?.sessionId === sessionId) || null;
      put.run(TASK_BY_SESSION, sessionId, JSON.stringify({ taskId: found ? found.value?.id || found.id : null, sessionId }));
      return found ? found.value : null;
    },
    linkByTask(taskId) {
      if (!taskId) return null;
      const indexed = indexRow(LINK_BY_TASK, taskId);
      if (indexed) {
        const found = indexed.linkId ? get('link', indexed.linkId) : null;
        if (indexed.linkId && !found) remove.run(LINK_BY_TASK, taskId);
        return found;
      }
      const found = scan('link').find(entry => entry.value?.taskId === taskId) || null;
      put.run(LINK_BY_TASK, taskId, JSON.stringify({ taskId,
        shellId: found?.value?.shellId || null, linkId: found ? found.id : null }));
      return found ? found.value : null;
    },
    // 一个壳最后 limit 条收据，顺序与 list('receipt').filter(…).slice(-limit) 完全一致。
    receiptsForShell(shellId, limit = 100) {
      if (!shellId) return [];
      const meta = indexRow(RECEIPT_INDEX_META, 'v1');
      if (!meta) buildReceiptIndex(false);
      else if (receiptWatermark() > (meta.watermark || 0)) buildReceiptIndex(true);
      const items = [...receiptItemsFor(shellId)].sort((a, b) => (a.rowid ?? 0) - (b.rowid ?? 0));
      const slice = limit > 0 ? items.slice(-limit) : items;
      const out = [];
      let stale = false;
      for (const item of slice) {
        const row = select.get('receipt', item.id);
        if (!row) { stale = true; continue; }
        out.push(JSON.parse(row.body));
      }
      // 索引行不是权威数据：真有对不上的行，就地按现存行收敛一次。
      if (stale) writeReceiptItems(shellId, items.filter(item => select.get('receipt', item.id)));
      return out;
    },
    set(kind, id, value) {
      const body = JSON.stringify(value);
      if (kind === 'snapshot') {
        const previous = select.get(kind, id);
        if (previous && previous.body !== body) throw new Error('immutable snapshot conflict');
      }
      if (kind === 'task' || kind === 'link' || kind === 'receipt') putIndexed(kind, id, body, select.get(kind, id));
      else put.run(kind, id, body);
      return value;
    },
    remove: (kind, id) => (kind === 'task' || kind === 'link' || kind === 'receipt' ? removeIndexed(kind, id) : remove.run(kind, id)),
    transaction: callback => db.transaction(callback).immediate(),
    close: () => { if (db.open) db.close(); },
  };
}

module.exports = { createTaskShellStore };
