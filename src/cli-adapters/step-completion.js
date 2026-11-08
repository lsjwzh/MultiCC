'use strict';

const { createCompletionTracker } = require('./completion');
const { getNative } = require('../native/runtime');

// OpenCode v1.18.2 session/prompt.ts keeps sampling after tool calls even if
// the provider says stop. run.ts ends on idle and separately tracks errors.
// The JSON CLI exposes steps, not an authoritative whole-turn success event:
// retain a candidate until the process ends. Unknown/missing reasons stay unknown.
// A resident lane (zcode --resident) has no per-turn process: its bridge ends a
// turn with an explicit turn-end line, which settles the stream boundary instead.
function createStepCompletionTracker({ streamBoundary = false } = {}) {
  const native = new (getNative().RustStepCompletionTracker)(!!streamBoundary);
  return createCompletionTracker({
    observe: event => native.observe(event),
    close: (boundary, evidence, facts) => native.close(boundary, evidence, facts),
  });
}

module.exports = { createStepCompletionTracker };
