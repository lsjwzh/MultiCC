'use strict';

// The aux classify bar's opening frame. A client that connects while a session
// already has a judgement must be shown it immediately, not on the next
// classify event (which may be hours away for an idle session).
//
// It lives here rather than inline in the turn engine for two reasons. The
// payload has to carry Aux freshness — see src/classify/aux-verdict-health.js:
// a page can open in the middle of an outage, and since a frozen judgement
// produces no further `task_state`, the connect frame is the ONLY chance that
// page has to learn the verdict is stale. And the turn engine is at its
// registered line ceiling, which the repo's budget gate ratchets down rather
// than up.

const { taskShortCode } = require('../classify/task-short-code');
const { auxVerdictStaleness } = require('../classify/aux-verdict-health');

/**
 * The `task_state` frame that seeds a freshly connected chat page, or null when
 * the session has no judgement to show (which is what keeps an unclassified
 * session from opening onto an empty bar).
 */
function taskStateSeed(task) {
  if (!task || !(task.goal || (task.phase && task.phase !== 'idle'))) return null;
  return {
    type: 'task_state',
    goal: task.goal || '',
    // Stable display handle for the outward task (`#CODE · goal`). Derived from
    // the taskId so it survives title edits within the same task and renews when
    // Aux mints a new taskId.
    taskShortCode: taskShortCode(task.taskId),
    phase: task.phase || 'idle',
    classifyState: task.classifyState || null,
    ...auxVerdictStaleness(),
  };
}

module.exports = { taskStateSeed };
