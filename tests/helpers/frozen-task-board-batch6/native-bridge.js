'use strict';
const { randomUUID } = require('node:crypto');
const { getNative } = require('../native/binding');
const planning = require('./planning');
const { taskDomain, replace } = require('../native/task-domain');
// 原生返回值回填已有对象，保持宿主观察者持有的任务引用。
function boardRule(action, args = {}) {
  const out = taskDomain({ op: 'board', action, ...args });
  if (args.board && out.board) {
    for (const key of ['tasks', 'modules', 'taskGroups']) {
      if (!out.board[key]) continue;
      args.board[key] ||= {};
      for (const id of Object.keys(args.board[key])) if (!Object.hasOwn(out.board[key], id)) delete args.board[key][id];
      for (const [id, value] of Object.entries(out.board[key])) {
        if (args.board[key][id]) replace(args.board[key][id], value);
        else args.board[key][id] = value;
      }
    }
    if (out.board.deletedTaskIds) args.board.deletedTaskIds = out.board.deletedTaskIds;
  }
  if (args.task && out.task) replace(args.task, out.task);
  return out.result;
}
const MAX_TASKS_IN_PROMPT = 50;
const recentTaskIds = board => boardRule('recentTaskIds', { board, limit: MAX_TASKS_IN_PROMPT });

// 孤立看板和常驻看板通过同一接口接收宿主 UUID 和 ICU 排序结果。
function classificationRule(action, args) {
  const newIds = Array.from({ length: 32 }, () => randomUUID().replace(/-/g, ''));
  const idOrder = Object.values(args.board?.taskGroups || {})
    .map(group => group.id).sort((a, b) => a.localeCompare(b));
  return boardRule(action, { op: 'classification', ...args, newIds, idOrder });
}

const taskRunSessionIds = task => boardRule('taskRunSessionIds', { task });
const soleRunSessionId = task => boardRule('soleRunSessionId', { task });
const sessionHasTurn = record => boardRule('sessionHasTurn', { record });
const deadDispatchClaim = (task, hasTurnState, now = Date.now()) => boardRule('deadDispatchClaim', { task, hasTurnState, now });
const foreignRunSession = (task, sessionId) => boardRule('foreignRunSession', { task, sessionId });
function staleWorkerClaim(task, getSessionRunState, now = Date.now()) {
  let state = null;
  try { state = getSessionRunState?.(soleRunSessionId(task)); } catch (_) {}
  return boardRule('staleWorkerClaim', { task, state, now });
}
function buildBoardDto(board, getSessionRunState, options = {}) {
  const readFact = getNative().taskBoardSessionFact;
  const facts = {}, dates = [];
  for (const task of Object.values(board.tasks)) {
    dates.push([task.dueAt, planning.wireDate(task.dueAt)]);
    for (const id of new Set([...(task.refs || []).map(ref => ref.sessionId), task.routing?.workerSessionId, task.chatSessionId].filter(Boolean))) {
      if (Object.hasOwn(facts, id)) continue;
      facts[id] = readFact(options, getSessionRunState, id);
    }
  }
  const idOrder = Object.values(board.taskGroups || {}).map(group => group.id).sort((a, b) => a.localeCompare(b));
  return taskDomain({ op: 'view', board, facts, dates, idOrder, now: Number(options.now) || Date.now(),
    hasTurnPort: typeof options.sessionHasTurn === 'function', hasRunPort: typeof getSessionRunState === 'function' });
}
function aggregateTaskRunState(sessionIds, getSessionRunState) {
  return buildBoardDto({ modules: {}, tasks: { aggregate: { id: 'aggregate', refs: sessionIds.map(sessionId => ({ sessionId })) } } }, getSessionRunState).tasks[0].runState;
}
const boardView = { DISPATCH_CLAIM_GRACE_MS: 60000, aggregateTaskRunState, buildBoardDto,
  deadDispatchClaim, foreignRunSession, sessionHasTurn, soleRunSessionId, staleWorkerClaim, taskRunSessionIds };

module.exports = { boardRule, boardView, classificationRule, recentTaskIds, MAX_TASKS_IN_PROMPT };
