'use strict';

// The aux classify bar's opening frame. A client that connects while a session
// already has a judgement must be shown it immediately, not on the next
// classify event (which may be hours away for an idle session).
//
// Both the seed gate and the payload belong to
// `multicc_core::chat_task_state_frame`: a persisted API error counts as a
// judgement, because an unattributed session whose last turn failed must still
// seed or the reopened page loses the API-error bar the envelope was kept for.
// Phase 'idle' is not a judgement; any other phase is.

const { getNative } = require('../native/runtime');
const { taskStatePayload } = require('./task-state-payload');

/**
 * The `task_state` frame that seeds a freshly connected chat page, or null when
 * the session has no judgement to show (which is what keeps an unclassified
 * session from opening onto an empty bar).
 */
function taskStateSeed(task) {
  // Resolving the payload can mint a persisted short code.
  if (!getNative().chatTaskStateShouldSeed(JSON.stringify({ task }))) return null;
  return taskStatePayload(task);
}

module.exports = { taskStateSeed };
