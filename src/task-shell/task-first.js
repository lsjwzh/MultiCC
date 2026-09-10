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
      const errors = [], migrated = [];
      const known = new Map(store.list('task').map(task => [task.sessionId, task]));
      for (const record of records) {
        if (record.kind !== 'chat' || record.taskExecutionSlot || record.experimentalMode
          || ['aux', 'gateway'].includes(record.type) || !ports.getDirectory?.(record.dirId)) continue;
        if (ports.isDeletedTask?.(record.taskBoundTaskId) || ports.isDeletedTask?.(known.get(record.id)?.id)) continue;
        if (known.get(record.id)?.taskFirst && store.get('task-first:indexed', known.get(record.id).id)) continue;
        try {
          const owner = open(record.id), task = adopt(owner.id, record.id);
          promote(task);
        } catch (error) { errors.push({ sessionId: record.id, code: error.code || 'task_migration_failed' }); }
      }
      for (const original of store.list('task')) {
        if (ports.isDeletedTask?.(original.id)) continue;
        try {
          const task = promote(original);
          if (!store.get('task-first:indexed', task.id)) {
            const result = await indexTask(task);
            if (!result?.ok) throw Object.assign(new Error(), { code: result?.error || 'task_index_failed' });
            store.set('task-first:indexed', task.id, { taskId: task.id, sessionId: task.sessionId, version: 1 });
          }
          migrated.push(task.id);
        } catch (error) { errors.push({ taskId: original.id, code: error.code || 'task_migration_failed' }); }
      }
      return { ok: errors.length === 0, migrated, errors };
    })().finally(() => { flight = null; });
    return flight;
  }
  return { migrate, promote };
}
module.exports = { createTaskFirstMigration };
