'use strict';
const { randomUUID } = require('node:crypto');
const { getNative } = require('../native/binding');
const { taskDomain, replace, boardStoreOf } = require('../native/task-domain');
const TASK_BOARD_SCHEMA_VERSION = 2;
const TASK_RECORD_TYPES = new Set(['planned', 'observed']);
const WORKFLOW_STAGES = new Set(['inbox', 'ready', 'doing', 'review', 'done']);
const TASK_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);
const RANK_STEP = 1024;
// V8 日期解析和 ICU 排序是历史协议的一部分，只通过宿主兼容端口提供。
function wireDate(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function call(action, args = {}) {
  const values = [args.input, args.input?.dueAt, args.task?.dueAt];
  const dates = values.filter(value => value !== undefined).map(value => [value, wireDate(value)]);
  // 常驻板的任务序由句柄维护，不再每次排序全部 id。
  const idOrder = boardStoreOf(args.board) ? undefined : Object.keys(args.board?.tasks || {}).sort((a, b) => a.localeCompare(b));
  const out = taskDomain({ op: 'planning', action, ...args, inputNonFinite: typeof args.input === 'number' && !Number.isFinite(args.input), dates, idOrder });
  return getNative().taskBoardPlanningResult(action, args, out, replace, mapTasks);
}
// Leave Array species and sparse-array mapping to the engine owning the caller's array.
const mapTasks = (rows, board) => rows.map(task => board.tasks[task.id]);
function boardCall(action, board, taskId, input, options = {}) {
  return call(action, { board, taskId, input, options: { now: Date.now(), ...options } });
}
module.exports = {
  wireDate, TASK_BOARD_SCHEMA_VERSION, TASK_RECORD_TYPES, WORKFLOW_STAGES, TASK_PRIORITIES, RANK_STEP,
  normalizePriority: input => call('normalizePriority', { input }),
  normalizeDueAt: input => call('normalizeDueAt', { input }),
  normalizeRank: (input, fallback = 0) => call('normalizeRank', { input, options: { fallback } }),
  planningRevision: (input, fallback = 1) => call('planningRevision', { input, options: { fallback } }),
  recordTypeForTask: (task, origin) => call('recordTypeForTask', { task, origin }),
  normalizePlanningTask: (task, options = {}) => call('normalizePlanningTask', { task, options }),
  planningFields: task => call('planningFields', { task }),
  validateExpectedRevision: (task, input) => call('validateExpectedRevision', { task, input }),
  plannedTasksInStage: (board, stage, exclude = null, dirId = null) => call('plannedTasksInStage', { board, stage, exclude, dirId }),
  rankAtEnd: (board, stage, exclude = null, dirId = null) => call('rankAtEnd', { board, stage, exclude, dirId }),
  renumberStage: (board, stage, exclude = null, dirId = null) => call('renumberStage', { board, stage, exclude, dirId }),
  rankForMove: (board, taskId, stage, input = {}) => call('rankForMove', { board, taskId, stage, input, options: input }),
  createPlannedTask: (board, input = {}, options = {}) => boardCall('createPlannedTask', board, options.id || `tsk-plan-${randomUUID().replace(/-/g, '')}`, input, options),
  updatePlannedTask: (board, taskId, input = {}, options = {}) => boardCall('updatePlannedTask', board, taskId, input, options),
  renameTask: (board, taskId, input, options = {}) => boardCall('renameTask', board, taskId, input, options),
  movePlannedTask: (board, taskId, input = {}, options = {}) => boardCall('movePlannedTask', board, taskId, input, options),
  markPlannedTaskStarted: (task, now = Date.now()) => call('markPlannedTaskStarted', { task, options: { now } }),
  alignStageWithStatus: (task, status, now = Date.now(), board = null) => call('alignStageWithStatus', { task, board, status, options: { now } }),
};
