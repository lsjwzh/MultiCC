'use strict';
// Frozen transcription of the connect-time `task_state` frame, captured
// 2026-11-20 as the differential oracle for
// multicc_core::chat_task_state_frame.
//
// Sources, transcribed statement for statement:
//   src/chat/task-state-seed.js    -- whether there is anything to seed
//   src/chat/task-state-payload.js -- the one task_state wire contract
//
//   function taskStateSeed(task) {
//     if (!task || !(task.goal || (task.phase && task.phase !== 'idle') || task.apiError)) return null;
//     return taskStatePayload(task);
//   }
//
//   function taskStatePayload(task) {
//     const next = task || {};
//     return {
//       type: 'task_state',
//       goal: next.goal || '',
//       taskShortCode: taskShortCode(next.taskId),
//       phase: next.phase || 'idle',
//       classifyState: next.classifyState || null,
//       goalState: isGoalState(next.goalState) ? next.goalState : null,
//       apiError: next.apiError || null,
//       cancelledAt: next.cancelledAt || null,
//       cancelReason: next.cancelledAt ? (next.cancelReason || null) : null,
//       ...auxVerdictStaleness(),
//     };
//   }
//
// Three impure inputs are facts here, because they are not derivable from the
// task record:
//   * `taskShortCode(taskId)` reads (and can mint into) the persisted code
//     registry, so the already-resolved code is passed in.
//   * `auxVerdictStaleness()` reads live Aux health, so its two fields are
//     passed in. They are SPREAD LAST, so a task record carrying its own
//     `auxUnhealthy` cannot win over the live reading.
//   * `isGoalState` is the classify vocabulary: achieved | interact.
//
// Two details decide the contract:
//   * The seed gate treats a persisted API error as a judgement worth showing.
//     An unattributed session whose last turn failed must still seed, or the
//     reopened page loses the API-error bar the envelope was kept for. Equally,
//     phase 'idle' is NOT a judgement, but any other phase is.
//   * `cancelReason` is gated on `cancelledAt`, not on itself: a reason with no
//     timestamp is dropped, so a stale reason cannot outlive its cancellation.

const GOAL_STATES = { achieved: 'achieved', interact: 'interact' };

function isGoalState(value) {
  return value === GOAL_STATES.achieved || value === GOAL_STATES.interact;
}

// JS truthiness over the fields the payload reads with `||`.
function truthy(value) {
  if (value === undefined || value === null || value === false) return false;
  if (value === '' || value === 0) return false;
  if (typeof value === 'number' && Number.isNaN(value)) return false;
  return true;
}

// `!(task.goal || (task.phase && task.phase !== 'idle') || task.apiError)`
function seeds(task, facts) {
  if (!task) return false;
  return !!(truthy(task.goal)
    || (truthy(task.phase) && task.phase !== 'idle')
    || truthy(task.apiError));
}

function taskStatePayload(task, facts) {
  const next = task || {};
  return {
    type: 'task_state',
    goal: truthy(next.goal) ? next.goal : '',
    taskShortCode: facts.taskShortCode,
    phase: truthy(next.phase) ? next.phase : 'idle',
    classifyState: truthy(next.classifyState) ? next.classifyState : null,
    goalState: isGoalState(next.goalState) ? next.goalState : null,
    apiError: truthy(next.apiError) ? next.apiError : null,
    cancelledAt: truthy(next.cancelledAt) ? next.cancelledAt : null,
    cancelReason: truthy(next.cancelledAt)
      ? (truthy(next.cancelReason) ? next.cancelReason : null) : null,
    auxUnhealthy: facts.auxUnhealthy,
    auxUnhealthySince: facts.auxUnhealthy ? facts.auxUnhealthySince : null,
  };
}

function taskStateSeed(task, facts) {
  if (!seeds(task, facts)) return null;
  return taskStatePayload(task, facts);
}

module.exports = { GOAL_STATES, isGoalState, seeds, taskStatePayload, taskStateSeed };
