'use strict';
const crypto = require('crypto');
const planning = require('./planning');
const { TURN_RUN_STATES } = require('../classify/vocab');
const { boardRule } = require('./native-bridge');
const MAX_TAGS_PER_TURN = 3;
const MAX_AREAS_PER_TASK = 8;
// References are durable ownership, not a display window. Never age them out.
const MAX_REFS_PER_TASK = Infinity;
const MAX_TASKS_IN_PROMPT = 50;
const MAX_TITLE_LEN = 40;
const MAX_MODULE_LEN = 20;
const MAX_TASKS_PER_GROUP = 100;
const CLASSIFY_PENDING_MODULE_NAME = '待归类';
const PENDING_TASK_TITLE = '新任务';
// Runtime projection is deliberately separate from task.status lifecycle.
// `succeeded` says the latest turn succeeded; only explicit user action writes
// task.status = 'done'. Legacy runState done/completed is migrated below.
// The vocabulary itself lives in src/classify/vocab.js (TURN_RUN_STATES): the
// classify letters, the session run state and this board projection all speak
// one list. Adding a state there is the only edit needed.
const TASK_RUN_STATES = new Set(TURN_RUN_STATES);
const MAX_ROUTING_ATTEMPTS = 50;

// Where the card came from, so the board can tell the two admissions apart at
// a glance. 'board' = an explicit send from the task board / Commander (an
// independent task that owns a task-bound session); 'session' = the task
// surfaced inside an ongoing chat (classify, the retroactive backfill scan, or
// a router-tool dispatch landing in a live worker). The UI uses this durable
// distinction for source filtering and for independent-task-only activity
// aggregation; it must not be inferred from recordType or chatSessionId.
const TASK_ORIGINS = new Set(['board', 'session']);
const BOARD_TASK_SOURCES = new Set(['task-board', 'commander', 'task-shell']);


function normalized(action, args = {}) {
  const idOrder = Object.values(args.board?.taskGroups || args.value?.taskGroups || {})
    .map(group => group.id).filter(Boolean).sort((a, b) => a.localeCompare(b));
  const dates = Object.values(args.value?.tasks || {}).map(task => [task.dueAt, planning.wireDate(task.dueAt)]);
  return boardRule(action, { op: 'normalize', ...args, idOrder, dates });
}
const taskOriginForSource = value => normalized('taskOriginForSource', { value });
const legacyTaskOrigin = value => normalized('legacyTaskOrigin', { value });
const safeClassificationError = value => normalized('safeClassificationError', { value });
const createEmptyBoard = () => normalized('createEmptyBoard');
const normalizeModuleName = value => normalized('normalizeModuleName', { value });
const normalizeBoard = value => normalized('normalizeBoard', { value });
const normalizeName = value => normalized('normalizeName', { value });
const canonicalTaskTitle = value => normalized('canonicalTaskTitle', { value });
const taskTitleSimilarity = (a, b) => normalized('taskTitleSimilarity', { a, b });
const deriveTaskTitle = value => normalized('deriveTaskTitle', { value });
function findModuleByName(board, value, dirId = null) { const mod = normalized('findModuleByName', { board, value, dirId }); return mod ? board.modules[mod.id] : null; }
function ownTask(board, taskId) { return board?.tasks && Object.hasOwn(board.tasks, taskId) ? board.tasks[taskId] : null; }
function reconcileTaskGroups(board) { normalized('reconcileTaskGroups', { board }); return board?.taskGroups || {}; }
function relatedTaskGroup(board, taskId) { const group = normalized('relatedTaskGroup', { board, taskId }); return group ? board.taskGroups[group.id] : null; }
const groupRelatedTasks = (board, taskId, relatedTaskId, now = Date.now()) => normalized('groupRelatedTasks', { board, taskId, relatedTaskId, now });
const normalizeTaskRouting = value => boardRule('normalizeTaskRouting', { value });
const setTaskRouting = (task, value) => boardRule('setTaskRouting', { task, value, now: Date.now() });
const taskDirId = (board, task) => boardRule('taskDirId', { board: { modules: { [task.moduleId]: board.modules?.[task.moduleId] } }, task });
function resolveTask(board, taskId) { const value = boardRule('resolveTask', { board, taskId }); return value ? board.tasks[value.id] : null; }
const taskLineageIds = (board, taskId) => boardRule('taskLineageIds', { board, taskId });
const taskLastTs = task => boardRule('taskLastTs', { task });
const addRefToTask = (task, ref, now, maxRefs = MAX_REFS_PER_TASK) => boardRule('addRefToTask', { task, ref, now, maxRefs });
// UUID 只由宿主提供；不承担业务身份推断。
const newId = prefix => `${prefix}-${crypto.randomUUID().replace(/-/g, '')}`;
module.exports = {
  MAX_TAGS_PER_TURN,
  MAX_AREAS_PER_TASK,
  MAX_REFS_PER_TASK,
  MAX_TASKS_IN_PROMPT,
  MAX_TITLE_LEN,
  MAX_MODULE_LEN,
  MAX_TASKS_PER_GROUP,
  CLASSIFY_PENDING_MODULE_NAME,
  PENDING_TASK_TITLE,
  TASK_RUN_STATES,
  TASK_ORIGINS,
  taskOriginForSource,
  legacyTaskOrigin,
  safeClassificationError,
  createEmptyBoard,
  normalizeModuleName,
  normalizeBoard,
  normalizeTaskRouting,
  setTaskRouting,
  normalizeName,
  canonicalTaskTitle,
  taskTitleSimilarity,
  findModuleByName,
  taskDirId,
  ownTask,
  resolveTask,
  taskLineageIds,
  reconcileTaskGroups,
  relatedTaskGroup,
  groupRelatedTasks,
  newId,
  taskLastTs,
  deriveTaskTitle,
  addRefToTask,
};
