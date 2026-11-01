'use strict';
const { boardRule } = require('./native-bridge');
const { taskDomain } = require('../native/task-domain');
const planning = require('./planning');
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
  const facts = {}, dates = [];
  for (const task of Object.values(board.tasks)) {
    dates.push([task.dueAt, planning.wireDate(task.dueAt)]);
    for (const id of new Set([...(task.refs || []).map(ref => ref.sessionId), task.routing?.workerSessionId, task.chatSessionId].filter(Boolean))) {
      if (Object.hasOwn(facts, id)) continue;
      let hasTurn = true, runState = null;
      try { hasTurn = options.sessionHasTurn?.(id) === true; } catch (_) {}
      try { runState = getSessionRunState?.(id) || null; } catch (_) {}
      facts[id] = { hasTurn, runState };
    }
  }
  const idOrder = Object.values(board.taskGroups || {}).map(group => group.id).sort((a, b) => a.localeCompare(b));
  return taskDomain({ op: 'view', board, facts, dates, idOrder, now: Number(options.now) || Date.now(),
    hasTurnPort: typeof options.sessionHasTurn === 'function', hasRunPort: typeof getSessionRunState === 'function' });
}
function aggregateTaskRunState(sessionIds, getSessionRunState) {
  return buildBoardDto({ modules: {}, tasks: { aggregate: { id: 'aggregate', refs: sessionIds.map(sessionId => ({ sessionId })) } } }, getSessionRunState).tasks[0].runState;
}
module.exports = { DISPATCH_CLAIM_GRACE_MS: 60000, aggregateTaskRunState, buildBoardDto,
  deadDispatchClaim, foreignRunSession, sessionHasTurn, soleRunSessionId, staleWorkerClaim, taskRunSessionIds };
