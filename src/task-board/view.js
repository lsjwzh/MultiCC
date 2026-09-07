'use strict';

const planning = require('./planning');
const {
  TASK_ORIGINS,
  TASK_RUN_STATES,
  legacyTaskOrigin,
  normalizeTaskRouting,
  resolveTask,
  safeClassificationError,
  taskLastTs,
} = require('./normalize');
// Read-side projection: the board DTO consumed by the panel. Pure over the
// normalized board; never mutates task records.
// Aggregate turn run-state from a task's sessions: running > waiting > error > idle;
// succeeded only when all sessions succeeded. This never mutates task.status.
function aggregateTaskRunState(sessionIds, getSessionRunState) {
  if (!getSessionRunState || !sessionIds.length) return 'idle';
  const states = sessionIds.map(sid => getSessionRunState(sid)).filter(Boolean)
    .map(state => ['done', 'completed'].includes(state) ? 'succeeded' : state);
  if (!states.length) return 'idle';
  if (states.some(s => s === 'running')) return 'running';
  if (states.some(s => s === 'queued')) return 'queued';
  if (states.some(s => s === 'waiting')) return 'waiting';
  if (states.some(s => s === 'error')) return 'error';
  if (states.every(s => s === 'succeeded')) return 'succeeded';
  return 'idle';
}

function buildBoardDto(board, getSessionRunState) {
  const mergedCount = new Map();
  for (const task of Object.values(board.tasks)) {
    if (!task.mergedInto) continue;
    const target = resolveTask(board, task.id);
    if (target) mergedCount.set(target.id, (mergedCount.get(target.id) || 0) + 1);
  }
  const groupByTaskId = new Map();
  for (const group of Object.values(board.taskGroups || {})) {
    for (const taskId of Array.isArray(group.taskIds) ? group.taskIds : []) {
      if (!groupByTaskId.has(taskId)) groupByTaskId.set(taskId, group.id);
    }
  }
  const tasks = Object.values(board.tasks).filter(t => !t.mergedInto).map(t => {
    const sessionIds = [...new Set(t.refs.map(r => r.sessionId))];
    const routing = normalizeTaskRouting(t.routing);
    // A Commander one-way route is executed by the admitted worker. Commander
    // is only the router and must not make a running worker appear "waiting".
    const runSessionIds = routing?.oneWay && routing.workerSessionId
      ? [routing.workerSessionId]
      : sessionIds;
    return {
      id: t.id,
      moduleId: t.moduleId,
      title: t.title,
      status: t.status,
      areas: t.areas,
      refCount: t.refs.length,
      sessionIds,
      dirIds: [...new Set([t.dirId, ...t.refs.map(r => r.dirId)].filter(Boolean))],
      lastTs: taskLastTs(t),
      createdAt: t.createdAt,
      taskGroupId: groupByTaskId.get(t.id) || null,
      mergedTaskCount: mergedCount.get(t.id) || 0,
      origin: TASK_ORIGINS.has(t.origin) ? t.origin : legacyTaskOrigin(t.id),
      ...planning.planningFields(t),
      runState: TASK_RUN_STATES.has(t.runState)
        ? t.runState
        : aggregateTaskRunState(runSessionIds, getSessionRunState),
      moduleAssignment: t.moduleAssignment ? {
        running: t.moduleAssignment.running === true,
        attempts: t.moduleAssignment.attempts || 0,
        lastAttemptAt: t.moduleAssignment.lastAttemptAt || 0,
        lastError: safeClassificationError(t.moduleAssignment.lastError),
      } : null,
      routing,
      attemptCount: routing?.attempts?.length || 0,
      // M3 ledger surfaced so detail views can offer diff/merge/cleanup
      // without a second fetch; absent until the first run creates it.
      worktreePath: typeof t.worktreePath === 'string' ? t.worktreePath : null,
      branch: typeof t.branch === 'string' ? t.branch : null,
      // P1 reverse pointer to the task-bound hidden chat session (the session
      // record's taskBoundTaskId is the authoritative hiding marker). The task
      // chat view deep-links this through ordinary session APIs.
      chatSessionId: typeof t.chatSessionId === 'string' ? t.chatSessionId : null,
    };
  }).sort((a, b) => b.lastTs - a.lastTs);
  const countByModule = new Map();
  const lastByModule = new Map();
  for (const t of tasks) {
    countByModule.set(t.moduleId, (countByModule.get(t.moduleId) || 0) + 1);
    lastByModule.set(t.moduleId, Math.max(lastByModule.get(t.moduleId) || 0, t.lastTs));
  }
  const modules = Object.values(board.modules).map(m => ({
    id: m.id,
    name: m.name,
    source: m.source,
    dirId: m.dirId,
    taskCount: countByModule.get(m.id) || 0,
    lastTs: lastByModule.get(m.id) || m.updatedAt || 0,
  })).sort((a, b) => b.lastTs - a.lastTs);
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const taskGroups = Object.values(board.taskGroups || {}).map(group => {
    const taskIds = (Array.isArray(group.taskIds) ? group.taskIds : [])
      .filter(taskId => taskById.has(taskId));
    if (taskIds.length < 2) return null;
    const rootTaskId = taskIds.includes(group.rootTaskId) ? group.rootTaskId : taskIds[0];
    return {
      id: group.id,
      rootTaskId,
      taskIds,
      title: taskById.get(rootTaskId)?.title || '关联任务',
      createdAt: Math.max(0, Number(group.createdAt) || 0),
      updatedAt: Math.max(0, Number(group.updatedAt) || 0),
      lastTs: Math.max(...taskIds.map(taskId => taskById.get(taskId)?.lastTs || 0)),
    };
  }).filter(Boolean).sort((a, b) => b.lastTs - a.lastTs || a.id.localeCompare(b.id));
  return {
    schemaVersion: planning.TASK_BOARD_SCHEMA_VERSION,
    revision: Number.isSafeInteger(Number(board.revision)) && Number(board.revision) >= 0
      ? Number(board.revision) : 0,
    modules,
    tasks,
    taskGroups,
  };
}

module.exports = {
  aggregateTaskRunState,
  buildBoardDto,
};
