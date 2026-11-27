'use strict';

// Retire user-facing role sessions without deleting the executions that own
// native handles, pending replies, transcripts, or unmerged workspaces.
function createTaskFirstMigration({ store, open, adopt, roles, indexTask, ports }) {
  let flight;
  function promote(task) {
    if (!task.taskFirst) store.set('task', task.id, { ...task, taskFirst: true });
    roles.snapshot(task.id);
    return store.get('task', task.id);
  }
  function migrate(records) {
    if (flight) return flight;
    flight = (async () => {
      const errors = [], migrated = [], tasks = [];
      // 整轮只读一次 task 全表：既当定位用的 sessionId 索引，又是第二轮的遍历源
      // （行本身还要交给调用方，它原本为此再扫了第二遍）。用 Map 而不是数组是因为
      // 第一轮领养出来的新行必须并回来 —— 老实现就是靠重扫全表看见它们的；同一个 id
      // 只该被处理一次，而 Map 的 set 覆盖又天然保序。「已建索引」的标记集合也一次
      // 读全，老实现是每行一次 store.get('task-first:indexed')。
      // 两次读都走行缓存：同一轮 /api/air 里 listTasks() 马上要再读一次同一张
      // 表，内容没变时不该解析两遍（store.js 的 cachedList/cachedEntries）。
      const all = new Map(store.cachedList('task').map(task => [task.id, task]));
      const indexed = new Set(store.cachedEntries('task-first:indexed').map(([id]) => id));
      const known = new Map([...all.values()].map(task => [task.sessionId, task]));
      const list = Array.isArray(records) ? records : [...records];
      // 已删除判定原来逐条问 ports.isDeletedTask：宿主里它是任务板镜像上
      // `deletedTaskIds.includes(id)`，而镜像的 Proxy 让每次 includes 都重扫一遍
      // 整张已删除表 —— 一轮 migrate 要问 ~2N 次，表大时是 O(N·m)。改成一次问一批：
      // Rust（native/core/src/task_domain/deleted.rs）把表索引进一次 HashSet，再按
      // 入参顺序回已删除的 id，这里只建一个 Set。端口缺失（旧宿主、只传
      // isDeletedTask 的测试）或调用失败时，原样退回逐条判定。
      const deleted = new Set();
      let bulk = typeof ports.deletedAmong === 'function';
      const loadDeleted = async ids => {
        if (!bulk) return false;
        try {
          const found = await ports.deletedAmong(ids);
          if (!Array.isArray(found)) return false;
          for (const id of found) deleted.add(id);
          return true;
        } catch (_) { return false; }
      };
      const isDeleted = id => (bulk ? deleted.has(id) : !!ports.isDeletedTask?.(id));
      const bound = [];
      for (const record of list) bound.push(record?.taskBoundTaskId, known.get(record?.id)?.id);
      bulk = await loadDeleted(bound);
      for (const record of list) {
        if (record.kind !== 'chat' || record.taskExecutionSlot || record.experimentalMode
          || ['aux', 'gateway'].includes(record.type) || !ports.getDirectory?.(record.dirId)) continue;
        if (isDeleted(record.taskBoundTaskId) || isDeleted(known.get(record.id)?.id)) continue;
        if (known.get(record.id)?.taskFirst && indexed.has(known.get(record.id).id)) continue;
        try {
          const owner = open(record.id), task = adopt(owner.id, record.id);
          all.set(task.id, promote(task));
        } catch (error) { errors.push({ sessionId: record.id, code: error.code || 'task_migration_failed' }); }
      }
      // 第一轮领养出来的新行到这里才进 all。老实现是进第二轮循环时逐条现问，
      // 所以这里要用最终的键集再问一次（已问过的 id 结果不变，取并集即可）。
      if (bulk) bulk = await loadDeleted([...all.keys()]);
      for (const original of all.values()) {
        if (isDeleted(original.id)) continue;
        tasks.push(original);
        try {
          // 已经 promote 且已建索引的行不再走 promote()：那是 roles.snapshot()
          // （四读一写、还会重算角色快照哈希）加一次回读，稳态下全是空转，
          // 而 Air 快照每 15 秒就要问一次迁移 —— 线上 514 行任务每轮白跑一遍。
          // 上面那个循环早就用同一个条件跳过它们了，这里只是对齐。
          const promoted = original.taskFirst && indexed.has(original.id);
          const task = promoted ? original : promote(original);
          if (!promoted && !indexed.has(task.id)) {
            const result = await indexTask(task);
            if (!result?.ok) throw Object.assign(new Error(), { code: result?.error || 'task_index_failed' });
            store.set('task-first:indexed', task.id, { taskId: task.id, sessionId: task.sessionId, version: 1 });
            indexed.add(task.id);
          }
          migrated.push(task.id);
        } catch (error) { errors.push({ taskId: original.id, code: error.code || 'task_migration_failed' }); }
      }
      return { ok: errors.length === 0, migrated, errors, tasks };
    })().finally(() => { flight = null; });
    return flight;
  }
  return { migrate, promote };
}
module.exports = { createTaskFirstMigration };
