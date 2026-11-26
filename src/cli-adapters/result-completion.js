'use strict';

const { getNative } = require('../native/binding');

function isMainResult(event) {
  return getNative().cliIsMainResult(event);
}

// Claude 2.1.251's embedded SDK schema explicitly allows terminal_reason to
// be absent for local slash commands. Qoder's buildResultSuccess and CodeBuddy
// 2.143.0's result builder use subtype + is_error. In all three, a result is a
// boundary, including error results; subtype=success alone is insufficient.
function resultCompletion(event) {
  return getNative().cliResultCompletion(event);
}

function createResultCompletionTracker() {
  return getNative().createResultCompletionTracker();
}

module.exports = { isMainResult, resultCompletion, createResultCompletionTracker };
