/* FROZEN: differential-test oracle. Background-task metadata ledger. Copy of the pre-Rust
 * implementation, kept only so tests can compare it with the Rust owner.
 * Never require this from product code. */

'use strict';

const FIELDS = ['parent_task_id', 'run_id', 'subagent_type', 'task_type'];
const text = value => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 240) : '';

// 展示信息独立于任务控制；旧版事件缺少字段时继续沿用已知信息。
function createTaskMetadata() {
  const sessions = new Map();
  const snapshots = new Map();
  function remember(name, event) {
    const id = text(event.task_id || event.id);
    if (!id) return true;
    if (!sessions.has(name)) sessions.set(name, new Map());
    const tasks = sessions.get(name);
    const previous = tasks.get(id) || {};
    const run = text(event.run_id);
    if (run && previous.run_id && run < previous.run_id) return false;
    const next = { ...previous };
    for (const field of FIELDS) if (text(event[field])) next[field] = text(event[field]);
    if (text(event.description)) next.description = text(event.description);
    tasks.delete(id);
    tasks.set(id, next);
    // 活跃任务不被挤走，已结束任务只保留有限条用于父任务名称与迟到事件判断。
    if (tasks.size > 2000) for (const key of tasks.keys()) {
      if (!snapshots.get(name)?.has(key)) tasks.delete(key);
      if (tasks.size <= 2000) break;
    }
    return true;
  }
  function fields(name, id) {
    const task = sessions.get(name)?.get(String(id)) || {};
    const out = {};
    for (const field of FIELDS) if (task[field]) out[field] = task[field];
    const parent = task.parent_task_id && sessions.get(name)?.get(task.parent_task_id);
    if (parent?.description) out.parent_description = parent.description;
    return out;
  }
  function snapshot(name, tasks) {
    const active = new Map();
    for (const task of tasks) {
      if (!task || typeof task !== 'object') continue;
      const id = text(task.task_id || task.id);
      if (!id) continue;
      const accepted = remember(name, task);
      active.set(id, accepted ? task : {
        ...task, description: sessions.get(name)?.get(id)?.description || task.description,
      });
    }
    snapshots.set(name, active);
    return tasks.map(task => task && typeof task === 'object'
      ? { ...(active.get(text(task.task_id || task.id)) || task), ...fields(name, task.task_id || task.id) } : task);
  }
  return {
    remember, fields, snapshot,
    description: (name, id) => sessions.get(name)?.get(String(id))?.description,
    active: name => [...(snapshots.get(name)?.values() || [])]
      .map(task => ({ ...task, ...fields(name, task.task_id || task.id) })),
    finish(name, id) { snapshots.get(name)?.delete(String(id)); },
    clear(name) { sessions.delete(name); snapshots.delete(name); },
  };
}

module.exports = { createTaskMetadata };
