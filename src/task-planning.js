'use strict';

const crypto = require('crypto');

const TASK_BOARD_SCHEMA_VERSION = 2;
const TASK_RECORD_TYPES = new Set(['planned', 'observed']);
const WORKFLOW_STAGES = new Set(['inbox', 'ready', 'doing', 'review', 'done']);
const TASK_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);
const MAX_DESCRIPTION_LEN = 20_000;
const MAX_ACCEPTANCE_CRITERIA_LEN = 20_000;
const RANK_STEP = 1024;

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizePriority(value) {
  if (value == null || value === '' || value === 'none') return null;
  const priority = String(value).trim().toLowerCase();
  return TASK_PRIORITIES.has(priority) ? priority : null;
}

function normalizeDueAt(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value
    : typeof value === 'number' ? new Date(value)
      : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeRank(value, fallback = 0) {
  const rank = Number(value);
  return Number.isFinite(rank) && Math.abs(rank) <= Number.MAX_SAFE_INTEGER
    ? rank : fallback;
}

function planningRevision(value, fallback = 1) {
  const revision = Math.floor(Number(value));
  return Number.isSafeInteger(revision) && revision >= 1 ? revision : fallback;
}

function recordTypeForTask(task, origin) {
  if (TASK_RECORD_TYPES.has(task?.recordType)) return task.recordType;
  return origin === 'board' ? 'planned' : 'observed';
}

// Additive load-time migration for planning metadata. `status` is an explicit
// lifecycle verdict and may seed a missing stage; transient runState never may.
function normalizePlanningTask(task, { origin = 'session', dirId = null } = {}) {
  const recordType = recordTypeForTask(task, origin);
  task.recordType = recordType;
  if (recordType !== 'planned') return task;
  task.dirId = cleanText(task.dirId, 160) || cleanText(dirId, 160) || null;
  task.description = cleanText(task.description, MAX_DESCRIPTION_LEN);
  task.workflowStage = WORKFLOW_STAGES.has(task.workflowStage)
    ? task.workflowStage
    : task.status === 'done' ? 'done' : 'inbox';
  task.rank = normalizeRank(task.rank, 0);
  task.priority = normalizePriority(task.priority);
  task.dueAt = normalizeDueAt(task.dueAt);
  task.acceptanceCriteria = cleanText(
    Array.isArray(task.acceptanceCriteria)
      ? task.acceptanceCriteria.filter(value => typeof value === 'string').join('\n')
      : task.acceptanceCriteria,
    MAX_ACCEPTANCE_CRITERIA_LEN,
  );
  task.planningRevision = planningRevision(task.planningRevision);
  // Keep the two explicit user-controlled completion representations aligned.
  if (task.workflowStage === 'done') task.status = 'done';
  else if (task.status === 'done') task.workflowStage = 'done';
  return task;
}

function planningFields(task) {
  const planned = task?.recordType === 'planned';
  return {
    recordType: planned ? 'planned' : 'observed',
    dirId: planned ? task.dirId || null : null,
    description: planned ? task.description || '' : '',
    workflowStage: planned ? task.workflowStage : null,
    rank: planned ? normalizeRank(task.rank, 0) : null,
    priority: planned ? normalizePriority(task.priority) : null,
    dueAt: planned ? normalizeDueAt(task.dueAt) : null,
    acceptanceCriteria: planned ? task.acceptanceCriteria || '' : '',
    planningRevision: planned ? planningRevision(task.planningRevision) : 0,
  };
}

function invalid(error, field = null) {
  return { ok: false, error, ...(field ? { field } : {}) };
}

function validateExpectedRevision(task, value) {
  if (value === undefined || value === null || value === '') {
    return invalid('expected_revision_required', 'expectedRevision');
  }
  const expected = Number(value);
  if (!Number.isSafeInteger(expected) || expected < 1) {
    return invalid('invalid_expected_revision', 'expectedRevision');
  }
  const actual = planningRevision(task?.planningRevision);
  if (expected !== actual) {
    return { ok: false, error: 'revision_conflict', expectedRevision: expected, actualRevision: actual };
  }
  return { ok: true, expectedRevision: expected };
}

function plannedTasksInStage(board, stage, excludeTaskId = null, dirId = null) {
  return Object.values(board?.tasks || {})
    .filter(task => task?.recordType === 'planned'
      && task.workflowStage === stage && task.status !== 'archived'
      && (dirId == null || task.dirId === dirId)
      && task.id !== excludeTaskId)
    .sort((left, right) => normalizeRank(left.rank, 0) - normalizeRank(right.rank, 0)
      || (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0)
      || String(left.id).localeCompare(String(right.id)));
}

function rankAtEnd(board, stage, excludeTaskId = null, dirId = null) {
  const tasks = plannedTasksInStage(board, stage, excludeTaskId, dirId);
  return tasks.length ? normalizeRank(tasks.at(-1).rank, 0) + RANK_STEP : RANK_STEP;
}

function renumberStage(board, stage, excludeTaskId = null, dirId = null) {
  const tasks = plannedTasksInStage(board, stage, excludeTaskId, dirId);
  tasks.forEach((task, index) => { task.rank = (index + 1) * RANK_STEP; });
  return tasks;
}

function rankForMove(board, taskId, stage, {
  beforeTaskId = null, afterTaskId = null, _renumbered = false,
} = {}) {
  const movingTask = board.tasks?.[taskId];
  if (!movingTask || movingTask.recordType !== 'planned') return invalid('task_not_found');
  const dirId = movingTask.dirId || null;
  const tasks = plannedTasksInStage(board, stage, taskId, dirId);
  const beforeId = cleanText(beforeTaskId, 128) || null;
  const afterId = cleanText(afterTaskId, 128) || null;
  if (beforeId && beforeId === taskId || afterId && afterId === taskId) {
    return invalid('invalid_move_anchor');
  }
  const beforeIndex = beforeId ? tasks.findIndex(task => task.id === beforeId) : -1;
  const afterIndex = afterId ? tasks.findIndex(task => task.id === afterId) : -1;
  if (beforeId && beforeIndex < 0 || afterId && afterIndex < 0) {
    return invalid('move_anchor_not_found');
  }
  if (beforeId && afterId && afterIndex >= beforeIndex) {
    return invalid('invalid_move_anchor_order');
  }
  let lower = null;
  let upper = null;
  if (afterId) lower = normalizeRank(tasks[afterIndex].rank, 0);
  if (beforeId) upper = normalizeRank(tasks[beforeIndex].rank, 0);
  if (lower == null && beforeIndex > 0) lower = normalizeRank(tasks[beforeIndex - 1].rank, 0);
  if (upper == null && afterIndex >= 0 && afterIndex < tasks.length - 1) {
    upper = normalizeRank(tasks[afterIndex + 1].rank, 0);
  }
  if (lower == null && upper == null) {
    return { ok: true, rank: rankAtEnd(board, stage, taskId, dirId) };
  }
  if (lower == null) return { ok: true, rank: upper - RANK_STEP };
  if (upper == null) return { ok: true, rank: lower + RANK_STEP };
  if (upper <= lower) {
    if (_renumbered) return invalid('invalid_move_anchor_order');
    renumberStage(board, stage, taskId, dirId);
    return rankForMove(board, taskId, stage, {
      beforeTaskId: beforeId, afterTaskId: afterId, _renumbered: true,
    });
  }
  const rank = lower + ((upper - lower) / 2);
  if (!(rank > lower && rank < upper)) {
    if (_renumbered) return invalid('rank_space_exhausted');
    renumberStage(board, stage, taskId, dirId);
    return rankForMove(board, taskId, stage, {
      beforeTaskId: beforeId, afterTaskId: afterId, _renumbered: true,
    });
  }
  return { ok: true, rank };
}

function taskId() {
  return `tsk-plan-${crypto.randomUUID().replace(/-/g, '')}`;
}

function createPlannedTask(board, input = {}, { now = Date.now(), id = null } = {}) {
  const description = cleanText(input.description, MAX_DESCRIPTION_LEN);
  const title = cleanText(input.title, 40)
    || description.split(/\r?\n/, 1)[0].slice(0, 40);
  const dirId = cleanText(input.dirId, 160);
  if (!title) return invalid('title_required', 'title');
  if (!dirId) return invalid('directory_required', 'dirId');
  const stage = input.workflowStage == null || input.workflowStage === ''
    ? 'inbox' : String(input.workflowStage);
  if (!WORKFLOW_STAGES.has(stage)) return invalid('invalid_workflow_stage', 'workflowStage');
  if (input.priority != null && input.priority !== '' && input.priority !== 'none'
      && !TASK_PRIORITIES.has(String(input.priority).trim().toLowerCase())) {
    return invalid('invalid_priority', 'priority');
  }
  if (input.dueAt != null && input.dueAt !== '' && !normalizeDueAt(input.dueAt)) {
    return invalid('invalid_due_at', 'dueAt');
  }
  const idValue = id || taskId();
  if (board.tasks[idValue]) return invalid('task_exists');
  const task = {
    id: idValue,
    moduleId: null,
    title,
    status: stage === 'done' ? 'done' : 'active',
    areas: [],
    createdAt: now,
    updatedAt: now,
    refs: [],
    origin: 'board',
    recordType: 'planned',
    dirId,
    description,
    workflowStage: stage,
    rank: input.rank == null
      ? rankAtEnd(board, stage, null, dirId)
      : normalizeRank(input.rank, rankAtEnd(board, stage, null, dirId)),
    priority: normalizePriority(input.priority),
    dueAt: normalizeDueAt(input.dueAt),
    acceptanceCriteria: cleanText(
      Array.isArray(input.acceptanceCriteria)
        ? input.acceptanceCriteria.filter(value => typeof value === 'string').join('\n')
        : input.acceptanceCriteria,
      MAX_ACCEPTANCE_CRITERIA_LEN,
    ),
    planningRevision: 1,
  };
  board.tasks[idValue] = task;
  return { ok: true, task };
}

function updatePlannedTask(board, taskIdValue, patch = {}, { now = Date.now(), expectedRevision } = {}) {
  const task = board.tasks?.[taskIdValue];
  if (!task) return invalid('task_not_found');
  if (task.recordType !== 'planned') return invalid('task_not_planned');
  if (task.status === 'archived') return invalid('task_archived');
  const revision = validateExpectedRevision(task, expectedRevision);
  if (!revision.ok) return revision;
  if (patch.recordType != null && patch.recordType !== 'planned') return invalid('record_type_immutable');
  if (patch.dirId !== undefined && !cleanText(patch.dirId, 160)) return invalid('directory_required', 'dirId');
  if (patch.title !== undefined && !cleanText(patch.title, 40)) return invalid('title_required', 'title');
  if (patch.priority !== undefined && patch.priority != null && patch.priority !== '' && patch.priority !== 'none'
      && !TASK_PRIORITIES.has(String(patch.priority).trim().toLowerCase())) {
    return invalid('invalid_priority', 'priority');
  }
  if (patch.dueAt !== undefined && patch.dueAt != null && patch.dueAt !== ''
      && !normalizeDueAt(patch.dueAt)) return invalid('invalid_due_at', 'dueAt');
  if (patch.workflowStage !== undefined && !WORKFLOW_STAGES.has(patch.workflowStage)) {
    return invalid('invalid_workflow_stage', 'workflowStage');
  }
  const previousDirId = task.dirId;
  const previousStage = task.workflowStage;
  if (patch.title !== undefined) task.title = cleanText(patch.title, 40);
  if (patch.dirId !== undefined) task.dirId = cleanText(patch.dirId, 160);
  if (patch.description !== undefined) task.description = cleanText(patch.description, MAX_DESCRIPTION_LEN);
  if (patch.priority !== undefined) task.priority = normalizePriority(patch.priority);
  if (patch.dueAt !== undefined) task.dueAt = normalizeDueAt(patch.dueAt);
  if (patch.acceptanceCriteria !== undefined) {
    task.acceptanceCriteria = cleanText(
      Array.isArray(patch.acceptanceCriteria)
        ? patch.acceptanceCriteria.filter(value => typeof value === 'string').join('\n')
        : patch.acceptanceCriteria,
      MAX_ACCEPTANCE_CRITERIA_LEN,
    );
  }
  if (patch.workflowStage !== undefined) {
    task.workflowStage = patch.workflowStage;
    task.status = patch.workflowStage === 'done' ? 'done' : 'active';
  }
  if (task.dirId !== previousDirId || task.workflowStage !== previousStage) {
    task.rank = rankAtEnd(board, task.workflowStage, task.id, task.dirId);
  }
  task.updatedAt = now;
  task.planningRevision = revision.actualRevision ? revision.actualRevision + 1
    : planningRevision(task.planningRevision) + 1;
  return { ok: true, task };
}

function movePlannedTask(board, taskIdValue, input = {}, { now = Date.now(), expectedRevision } = {}) {
  const task = board.tasks?.[taskIdValue];
  if (!task) return invalid('task_not_found');
  if (task.recordType !== 'planned') return invalid('task_not_planned');
  if (task.status === 'archived') return invalid('task_archived');
  const revision = validateExpectedRevision(task, expectedRevision);
  if (!revision.ok) return revision;
  const stage = input.workflowStage == null ? task.workflowStage : String(input.workflowStage);
  if (!WORKFLOW_STAGES.has(stage)) return invalid('invalid_workflow_stage', 'workflowStage');
  const ranked = rankForMove(board, task.id, stage, input);
  if (!ranked.ok) return ranked;
  task.workflowStage = stage;
  task.rank = ranked.rank;
  task.status = stage === 'done' ? 'done' : 'active';
  task.updatedAt = now;
  task.planningRevision = planningRevision(task.planningRevision) + 1;
  return { ok: true, task };
}

function markPlannedTaskStarted(task, now = Date.now()) {
  if (!task || task.recordType !== 'planned' || task.status === 'archived') return false;
  let changed = false;
  if (task.workflowStage !== 'doing') { task.workflowStage = 'doing'; changed = true; }
  if (task.status !== 'active') { task.status = 'active'; changed = true; }
  if (!changed) return false;
  task.updatedAt = now;
  task.planningRevision = planningRevision(task.planningRevision) + 1;
  return true;
}

function alignStageWithStatus(task, status, now = Date.now(), board = null) {
  if (!task || task.recordType !== 'planned') return false;
  const nextStage = status === 'done' ? 'done'
    : status === 'active' && task.workflowStage === 'done' ? 'ready' : task.workflowStage;
  if (nextStage === task.workflowStage) return false;
  task.workflowStage = nextStage;
  if (board) task.rank = rankAtEnd(board, nextStage, task.id, task.dirId);
  task.updatedAt = now;
  task.planningRevision = planningRevision(task.planningRevision) + 1;
  return true;
}

module.exports = {
  TASK_BOARD_SCHEMA_VERSION,
  TASK_RECORD_TYPES,
  WORKFLOW_STAGES,
  TASK_PRIORITIES,
  RANK_STEP,
  normalizePriority,
  normalizeDueAt,
  normalizeRank,
  planningRevision,
  recordTypeForTask,
  normalizePlanningTask,
  planningFields,
  validateExpectedRevision,
  plannedTasksInStage,
  rankAtEnd,
  renumberStage,
  rankForMove,
  createPlannedTask,
  updatePlannedTask,
  movePlannedTask,
  markPlannedTaskStarted,
  alignStageWithStatus,
};
