'use strict';

// Air 任务「手动待办」—— 用户自己点「标记为待办」挑出来的任务。
//
// 待办视图汇集四类任务：需要交互（✅ 但 goalState=interact）、等待用户输入
// （runState=waiting）、出错（runState=error），以及这里这份手动清单。前三类是
// 服务端已经折好的运行态，客户端现读现分；只有「我想回头处理它」这件事没有任何
// 运行态能表达，所以单独落一份。理由同 pins：Web 与 App、换设备都要看到同一份。
//
//   文件：<data dir>/air-todos.json（默认），形状 { taskIds: [taskId, …] }
//   接口：GET  /api/air/todos          → { ok, taskIds }
//        POST /api/air/todos          { taskIds }  → 整份替换
//        POST /api/air/todos/toggle   { taskId }   → 标记 / 取消
//
// 顺序就是标记的先后；存在性剪枝在读的时候做（任务被删掉，标记自己掉下来）。

const { createPaths } = require('../paths');
const { createTaskIdListRuntime } = require('./pins');

const TODO_LIMIT = 500;

function createAirTodoRuntime(rawDeps) {
  return createTaskIdListRuntime(rawDeps, {
    kind: 'air-todos', route: '/api/air/todos', limit: TODO_LIMIT, label: '标记待办',
    defaultFile: () => createPaths().airTodosFile,
    codes: { saveFailed: 'todo_save_failed', limitReached: 'todo_limit_reached', failed: 'todo_failed' },
  });
}

module.exports = { TODO_LIMIT, createAirTodoRuntime };
