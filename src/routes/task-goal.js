'use strict';

// Air 任务「标记达成」—— 把一张「执行成功但需要交互」的卡片改成「达成目标」。
//
//   接口：POST /api/air/tasks/mark-achieved { taskId }
//         → { ok: true, taskId, goalState: 'achieved' }
//
// 语义与聊天页 classify 条上的「需要交互 → 达成目标」完全一致：只移动 D 的子状态
// （goalState → achieved），classify 字母仍是 D，TaskBoard 生命周期一概不动。
// goalStateManualAt 是给后续归因精修用的护栏（见 state-machine 的 manualAchieved），
// 少了它，晚到的归因会把 interact 又画回去。
//
// 为什么这个路由挂在 session-admin 而不是 air-routes：真正落状态的函数是 server.js
// 的 setTaskState，它只被注入到 createSessionAdminRuntime；air-routes 的依赖里没有
// 它。复用同一个 writer（而不是在 air-routes 里另写一份改记录 + 广播）比把路由
// 放在「看起来更顺眼」的文件里重要。路由本身仍是 Air 的 HTTP 契约。
//
// 任务 → 执行会话：任务优先执行（task-first）的会话记录上有权威字段
// taskBoundTaskId（task-shell createExecution / task-board registerShellTask 一起
// 写入）；老任务没有绑定字段时退回 classify 落在 taskState.taskId 上的归属。
// 只认普通 chat 会话，aux / gateway / 终端不参与。

const { isTerminalLetter, GOAL_STATES } = require('../native/binding').classifyVocab;

const EXCLUDED_TYPES = new Set(['aux', 'gateway']);

function isChatRecord(record) {
  return !!record && record.kind === 'chat' && !EXCLUDED_TYPES.has(record.type);
}

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/** taskId → { sessionId, record }；找不到返回 null。 */
function resolveExecution(deps, taskId) {
  if (!deps || !deps.records || typeof deps.records[Symbol.iterator] !== 'function') return null;
  if (typeof deps.getTaskState !== 'function') return null;
  let legacy = null;
  for (const [sessionId, record] of deps.records) {
    if (!isChatRecord(record)) continue;
    // 权威绑定优先：一个任务一条独立执行记录。
    if (record.taskBoundTaskId === taskId) return { sessionId, record };
    // 老任务：归因把任务 id 写在 taskState 上，但一个会话可能先后属于多个任务，
    // 只把它当兜底，别抢在权威绑定前面。
    if (!legacy && deps.getTaskState(record).taskId === taskId) legacy = { sessionId, record };
  }
  return legacy;
}

// 退休处理器仍在的原样组合：eligibility 与写入各走一次端口，异常形状与旧实现
// 逐字一致（400/501/404/409/409）。留着是给测试与别的调用方一个入口。
function markTaskAchieved(deps, rawTaskId) {
  const facts = markTaskAchievedFacts(deps, rawTaskId);
  if (facts.unavailable) throw fail(501, 'task_state_unavailable', 'task state writes unavailable');
  if (!facts.found) throw fail(404, 'task_not_found', '任务不存在');
  if (facts.goalState !== GOAL_STATES.interact || !isTerminalLetter(facts.classifyState)) {
    throw fail(409, 'mark_achieved_not_applicable', '只有需要交互的任务才能标记达成目标');
  }
  if (facts.streaming) throw fail(409, 'task_streaming', '任务正在执行，无法标记达成目标');
  const written = markTaskAchievedWrite(deps, typeof rawTaskId === 'string' ? rawTaskId.trim() : '', facts.sessionId);
  return { ok: true, taskId: written.taskId, goalState: GOAL_STATES.achieved };
}

// Express 的挂载点退休了：`POST /api/air/tasks/mark-achieved` 由 Rust 前门独占
// （native/gateway/src/app/task_routes.rs）。eligibility 阶梯（404 → 409 不适用
// → 409 正在执行）在 native/core/src/task_routes.rs，这里只保留它需要探的
// Node 事实与真正落状态的 writer。宿主端口（src/routes/task-routes-host.js）
// 依次调用这两个端口，中间由 Rust 判定。
//
// `markTaskAchievedFacts` 返回：
//   { unavailable: true }                       deps 没有 setTaskState → 501
//   { found: false }                            → 404 task_not_found
//   { found: true, goalState, classifyState, streaming, sessionId }
//
// 退休处理器里 `fail()` 的 500 兜底由宿主端口负责（见 host 的 reply 包装）。
function markTaskAchievedFacts(deps, rawTaskId) {
  const taskId = typeof rawTaskId === 'string' ? rawTaskId.trim() : '';
  if (!taskId) throw fail(400, 'task_id_required', 'taskId is required');
  if (typeof deps.setTaskState !== 'function') return { unavailable: true };
  const found = resolveExecution(deps, taskId);
  if (!found) return { found: false, sessionId: null };
  const { sessionId, record } = found;
  const task = deps.getTaskState(record);
  const chat = deps.chatSessions && typeof deps.chatSessions.get === 'function'
    ? deps.chatSessions.get(sessionId) : null;
  return {
    found: true,
    goalState: task.goalState,
    classifyState: task.classifyState,
    streaming: !!(chat && chat.isStreaming),
    sessionId,
  };
}

// The one writer (server.js's setTaskState, injected through session-admin):
// persistence, chat broadcast and workspace broadcast all live inside it.
function markTaskAchievedWrite(deps, taskId, sessionId) {
  if (typeof deps.setTaskState !== 'function') throw fail(501, 'task_state_unavailable', 'task state writes unavailable');
  deps.setTaskState(sessionId, {
    goalState: GOAL_STATES.achieved, goalStateManualAt: Date.now(),
  });
  return { ok: true, taskId };
}

module.exports = {
  EXCLUDED_TYPES,
  resolveExecution,
  markTaskAchieved,
  markTaskAchievedFacts,
  markTaskAchievedWrite,
};
