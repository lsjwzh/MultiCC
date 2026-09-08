'use strict';

const { completion, createCompletionTracker } = require('./completion');

function isMainResult(event) {
  return event?.type === 'result' && event.parent_tool_use_id == null
    && event.origin?.kind !== 'task-notification';
}

// Claude 2.1.251's embedded SDK schema explicitly allows terminal_reason to
// be absent for local slash commands. Qoder's buildResultSuccess and CodeBuddy
// 2.143.0's result builder use subtype + is_error. In all three, a result is a
// boundary, including error results; subtype=success alone is insufficient.
function resultCompletion(event) {
  if (!isMainResult(event)) return null;
  const reason = event.terminal_reason;
  if (['cancelled', 'aborted', 'interrupted'].includes(reason)) return completion('cancelled', reason);
  if (event.is_error === true || /^error(?:_|$)/.test(event.subtype || '')
      || reason === 'api_error') return completion('failed', reason || event.subtype || 'error_result');
  if (reason !== undefined && reason !== 'completed') return completion('unknown', 'unrecognized_terminal_reason');
  if (event.subtype === 'success' && event.is_error === false) {
    return completion('completed', reason || 'success_result');
  }
  return completion('unknown', 'unrecognized_result');
}

function createResultCompletionTracker() {
  return createCompletionTracker({ observe: resultCompletion });
}

module.exports = { isMainResult, resultCompletion, createResultCompletionTracker };
