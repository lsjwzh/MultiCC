'use strict';

const { completion, createCompletionTracker } = require('./completion');

// OpenCode v1.18.2 session/prompt.ts keeps sampling after tool calls even if
// the provider says stop. run.ts ends on idle and separately tracks errors.
// The JSON CLI exposes steps, not an authoritative whole-turn success event:
// retain a candidate until the process ends. Unknown/missing reasons stay unknown.
function createStepCompletionTracker() {
  let reason = null;
  let hasTools = false;
  return createCompletionTracker({
    observe(event) {
      if (event.type === 'step_start') {
        reason = null;
        hasTools = false;
      } else if (event.type === 'tool_use' || event.type === 'tool_call') hasTools = true;
      else if (event.type === 'step_finish') reason = event.part?.reason || null;
      else if (event.type === 'error') return completion('failed', 'session_error');
      return null;
    },
    close(boundary, evidence, facts) {
      if (boundary.kind !== 'process') return evidence;
      if (reason === 'stop' && !hasTools && !facts.sawError && facts.pendingTools === 0) {
        return completion('completed', 'final_step_stop', 'protocol_and_exit');
      }
      return completion('unknown', hasTools ? 'tool_step_requires_followup' : reason || 'missing_step_finish');
    },
  });
}

module.exports = { createStepCompletionTracker };
