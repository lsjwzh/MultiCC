/* FROZEN: differential-test oracle. Codex native background task records. Copy of the pre-Rust
 * implementation, kept only so tests can compare it with the Rust owner.
 * Never require this from product code. */

'use strict';

const { safeText } = require('../../src/cli-adapters/codex-background-events.cjs');

// 原生子线程只负责展示和存活状态；结果由 CLI 自己回传主 Agent，避免重复唤醒。
function createNativeBackgroundTasks({ broadcast, observe, now }) {
  const sessions = new Map();
  function records(name) {
    if (!sessions.has(name)) sessions.set(name, new Map());
    return sessions.get(name);
  }
  function handle(name, event) {
    if (!/^codex_task_(started|progress|done)$/.test(event.subtype || '') || !event.task_id) return null;
    const tasks = records(name);
    const id = String(event.task_id);
    const previous = tasks.get(id);
    const done = event.subtype === 'codex_task_done';
    if (done && previous?.live === false) return { handled: true, changed: false };
    if (!done && event.subtype !== 'codex_task_started' && previous?.live === false) {
      return { handled: true, changed: false };
    }
    const status = done
      ? (['completed', 'failed', 'interrupted'].includes(event.status) ? event.status : 'interrupted') : 'running';
    const task = { description: safeText(event.description) || 'Codex 子任务',
      live: !done, kind: event.kind === 'tool' ? 'tool' : 'agent',
      at: event.heartbeat && previous ? previous.at : now() };
    tasks.set(id, task);
    if (!event.heartbeat) observe({ sessionId: name, taskId: id, status,
      detail: { description: task.description, kind: `codex-${task.kind}` } }, `原生后台任务 ${id}`);
    const type = done ? 'monitor_done' : previous?.live ? 'monitor_progress' : 'monitor_started';
    broadcast(name, { type, task_id: id, description: task.description,
      ...(done ? { summary: task.description } : {}), status, background: true });
    // 保留近期终态去重记录，长期存活任务始终保留。
    if (tasks.size > 2000) {
      for (const [key, value] of tasks) {
        if (!value.live) tasks.delete(key);
        if (tasks.size <= 1000) break;
      }
    }
    return { handled: true, changed: !!previous?.live !== task.live };
  }
  function list(name) {
    return [...(sessions.get(name) || [])].filter(([, task]) => task.live)
      .map(([id, task]) => ({ id, task_id: id, description: task.description }));
  }
  function has(name) {
    return [...(sessions.get(name)?.values() || [])].some(task => task.live && task.kind === 'agent');
  }
  function silence(name, at) {
    return Math.max(0, ...[...(sessions.get(name)?.values() || [])]
      .filter(task => task.live && task.kind === 'agent').map(task => at - task.at));
  }
  function reap(name) {
    const tasks = list(name);
    for (const task of tasks) handle(name, { subtype: 'codex_task_done', task_id: task.id,
      description: `${task.description} · 进程已退出，任务中断`, status: 'interrupted',
      kind: sessions.get(name)?.get(task.id)?.kind });
    return tasks.length;
  }
  return { handle, list, has, silence, reap, stop: name => sessions.delete(name) };
}

module.exports = { createNativeBackgroundTasks };
