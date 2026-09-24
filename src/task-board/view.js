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

// 这张卡片名下的会话（Commander 单向路由由被派的 worker 执行，见 buildBoardDto）。
function taskRunSessionIds(task) {
  const sessionIds = [...new Set((task?.refs || []).map(ref => ref.sessionId).filter(Boolean))];
  const routing = normalizeTaskRouting(task?.routing);
  return routing?.oneWay && routing.workerSessionId ? [routing.workerSessionId] : sessionIds;
}

// 「这一轮被受理过」的物证。会话记录里有 taskState 对象 *不等于* 跑过一轮：归因
// 链路（annotateChatTurn / recordTaskBoardGoal → setTaskState，字段表见
// routes/task-state-store.js 的 TASK_STATE_DEFAULTS）也会往一份空白记录里写
// goal/phase/taskId/auxRunId —— 那是一份「标注」，不是一次调度。落盘的证据只有
// 执行侧写下的这些字段：
//   · queueState           每一次调度事件都落这个字段（session-work/host.js）
//   · classifyState        轮次结束后的判定（P/B/C/D/W/E）
//   · classifyHistory      判定历史（classify 至少跑过一次）
//   · classifyUpdatedAt    上一次判定的时间戳
//   · lastTurnEndedAt / startedAt / endedAt  轮次边界
// 只被归因写过的记录里，这些字段全部是默认值（null / 空数组）。
const TURN_EVIDENCE_KEYS = [
  'queueState', 'classifyState', 'classifyHistory', 'classifyUpdatedAt',
  'lastTurnEndedAt', 'startedAt', 'endedAt',
];

function sessionHasTurn(record) {
  const state = record && record.taskState;
  if (!state || typeof state !== 'object') return false;
  return TURN_EVIDENCE_KEYS.some(key => {
    const value = state[key];
    if (Array.isArray(value)) return value.length > 0;
    return value !== null && value !== undefined && value !== '';
  });
}

// 派发时卡片会先写上一个乐观的 runState（running / queued），真正有没有被受理只有
// 会话侧知道：每一次调度事件都会把 queueState 落进会话记录，所以「名下所有会话都
// 拿不出受理物证」（会话记录已不存在同理）就是「这一轮连受理都没发生过」的证明。
// 这种卡片永远不会被谁改回来，读出去就是「执行中」挂到天荒地老 —— 按空闲投影。
//
// 宽限只留给派发竞态：卡片写完到第一个调度事件落地之间（毫秒级）卡片上那个值是
// 唯一的真相，这一瞬间不能把它闪成空闲。
const DISPATCH_CLAIM_GRACE_MS = 60 * 1000;
function deadDispatchClaim(task, hasTurnState, now = Date.now()) {
  if (task?.runState !== 'running' && task?.runState !== 'queued') return false;
  if (hasTurnState) return false;
  const claimedAt = Number(task.runStateAt || task.updatedAt || task.createdAt || 0);
  return claimedAt > 0 && now - claimedAt > DISPATCH_CLAIM_GRACE_MS;
}

// 单向路由的卡片只由被派的 worker 执行；带着这张卡 taskId 的其他会话（派活方
// 收到回传结果后起的那一轮）不是这张卡的运行。
function foreignRunSession(task, sessionId) {
  const routing = normalizeTaskRouting(task?.routing);
  if (!sessionId || !routing?.oneWay || !routing.workerSessionId) return false;
  return sessionId !== routing.workerSessionId && sessionId !== task.chatSessionId;
}

// 自愈：卡片上写着「执行中/排队」，但唯一执行它的 worker 会话自己已经不在跑
// （队列不是 running/queued），且这个值已过派发宽限 —— 那是被别的会话的事件
// 写上去、再没人改回来的陈旧值，按 worker 的真实状态投影。
function staleWorkerClaim(task, getSessionRunState, now = Date.now()) {
  if (task?.runState !== 'running' && task?.runState !== 'queued') return null;
  const routing = normalizeTaskRouting(task.routing);
  if (!routing?.oneWay || !routing.workerSessionId || typeof getSessionRunState !== 'function') return null;
  const claimedAt = Number(task.runStateAt || task.updatedAt || task.createdAt || 0);
  if (!(claimedAt > 0 && now - claimedAt > DISPATCH_CLAIM_GRACE_MS)) return null;
  let workerState = null;
  try { workerState = getSessionRunState(routing.workerSessionId); } catch (_) { return null; }
  if (!workerState || workerState === 'running' || workerState === 'queued') return null;
  return ['done', 'completed'].includes(workerState) ? 'succeeded' : workerState;
}

function buildBoardDto(board, getSessionRunState, options = {}) {
  const sessionHasTurn = typeof options.sessionHasTurn === 'function' ? options.sessionHasTurn : null;
  const now = Number(options.now) || Date.now();
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
    const runSessionIds = taskRunSessionIds(t);
    // 读不到会话记录时按「有过」处理：修复只能靠证据，不能靠读失败。
    const hasTurnState = !sessionHasTurn || runSessionIds.some(sid => {
      try { return sessionHasTurn(sid) === true; } catch (_) { return true; }
    });
    return {
      id: t.id,
      moduleId: t.moduleId,
      title: t.title,
      status: t.status,
      deleting: t.deleting === true,
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
      runState: deadDispatchClaim(t, hasTurnState, now)
        ? 'idle'
        : staleWorkerClaim(t, getSessionRunState, now) || (TASK_RUN_STATES.has(t.runState)
          ? t.runState
          : aggregateTaskRunState(runSessionIds, getSessionRunState)),
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
  DISPATCH_CLAIM_GRACE_MS,
  aggregateTaskRunState,
  buildBoardDto,
  deadDispatchClaim,
  foreignRunSession,
  sessionHasTurn,
  staleWorkerClaim,
  taskRunSessionIds,
};
