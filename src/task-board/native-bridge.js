'use strict';
const { randomUUID } = require('node:crypto');
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

module.exports = { boardRule, classificationRule, recentTaskIds, MAX_TASKS_IN_PROMPT };
