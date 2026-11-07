'use strict';

// R2 policy over trusted, correlated host observations. This is a decision,
// never a filesystem lease or permission to mutate attribution. The eventual
// apply transaction must repeat the version checks while holding its guard.
//
// The gate lives in native/core/src/task_routing.rs and keeps JS strict-equality
// semantics (a missing field is undefined, not null; `=== true/false/0` accept
// only that exact value). tests/test-task-attribution-eligibility.js pins it.

const { getNative } = require('../native/runtime');

const native = getNative();

function evaluateAttribution(facts = {}) {
  return JSON.parse(native.taskRoutingRequest('evaluateAttribution', JSON.stringify(facts)));
}

module.exports = { evaluateAttribution };
