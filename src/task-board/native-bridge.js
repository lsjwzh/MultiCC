'use strict';
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
module.exports = { boardRule };
