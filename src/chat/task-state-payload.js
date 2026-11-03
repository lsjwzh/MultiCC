'use strict';

// The single task_state wire contract. Three producers send this frame — the
// connect-time seed (src/chat/task-state-seed.js), the live broadcast in
// server.js's setTaskState, and the extracted store
// (src/routes/task-state-store.js) — and a page that reopens must see exactly
// what a live page sees. They once drifted: the seed omitted apiError, so the
// API-error bar existed only while the failing turn was on screen and vanished
// on reload even though the envelope was persisted. Keep every field here.

const { taskShortCode } = require('../classify/task-short-code');
const { auxVerdictStaleness } = require('../classify/aux-verdict-health');
const { isGoalState } = require('../classify/vocab');

function taskStatePayload(task) {
  const next = task || {};
  return {
    type: 'task_state',
    goal: next.goal || '',
    // Stable display handle for the outward task (`#CODE · goal`). Derived from
    // the taskId so it survives title edits within the same task and renews
    // when Aux mints a new taskId. Empty until Aux attributes a task.
    taskShortCode: taskShortCode(next.taskId),
    phase: next.phase || 'idle',
    classifyState: next.classifyState || null,
    // 「执行成功」的子状态（达成目标 / 需要交互，GOAL_STATES）：只在
    // classifyState==='D' 时有值；只影响展示文案，不影响任何判定/守卫。
    goalState: isGoalState(next.goalState) ? next.goalState : null,
    // The persisted upstream-error envelope. api_error_policy events are live
    // only, so this field is the ONLY way a reopened page can re-render the
    // API-error bar; dropping it reopens the reload-loses-the-error bug.
    apiError: next.apiError || null,
    // Cancellation envelope. Lets a surface say 「已取消」 instead of 「API 异常」
    // without inventing a second terminal value: the state is still E, only
    // the reason differs (user stopped it, not the provider).
    cancelledAt: next.cancelledAt || null,
    cancelReason: next.cancelledAt ? (next.cancelReason || null) : null,
    // Verdicts carry whether Aux is still answering
    // (src/classify/aux-verdict-health.js): a page opened mid-outage gets its
    // only chance to learn the judgement is frozen from this frame.
    ...auxVerdictStaleness(),
  };
}

module.exports = { taskStatePayload };
