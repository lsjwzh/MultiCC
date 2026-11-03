'use strict';

// The aux classify bar's opening frame. A client that connects while a session
// already has a judgement must be shown it immediately, not on the next
// classify event (which may be hours away for an idle session).
//
// The payload itself is shared with every other task_state producer — see
// src/chat/task-state-payload.js for why they must never drift (a reopened
// page lost the last API error when this seed omitted apiError). This file
// keeps only the seed-specific decision: whether there is anything worth
// showing at all.

const { taskStatePayload } = require('./task-state-payload');

/**
 * The `task_state` frame that seeds a freshly connected chat page, or null when
 * the session has no judgement to show (which is what keeps an unclassified
 * session from opening onto an empty bar). A persisted API error counts as a
 * judgement: an unattributed session whose last turn failed must still seed,
 * or the reopened page loses the API-error bar the envelope was kept for.
 */
function taskStateSeed(task) {
  if (!task || !(task.goal || (task.phase && task.phase !== 'idle') || task.apiError)) return null;
  return taskStatePayload(task);
}

module.exports = { taskStateSeed };
