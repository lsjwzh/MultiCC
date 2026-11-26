'use strict';

const { getNative } = require('../native/binding');

function completion(state, reason, source = 'protocol') {
  return getNative().cliCompletion(state, reason, source);
}

function isCompleted(outcome) {
  return getNative().cliIsCompleted(outcome);
}

// One tracker per runner, never per adapter/session. Native events describe
// protocol completion; process/stream settlement supplies the independent
// execution boundary. Neither output text nor a socket close proves success.
function createCompletionTracker(options = {}) {
  return getNative().createCliCompletionTracker(options);
}

function createAdapterCompletion(adapter) {
  return typeof adapter?.createCompletionTracker === 'function'
    ? adapter.createCompletionTracker() : createCompletionTracker({ fallback: true });
}

function createProtocolCompletionTracker(protocol) {
  return getNative().createProtocolCompletionTracker(protocol);
}

function createStepCompletionTracker({ streamBoundary = false } = {}) {
  return getNative().createStepCompletionTracker(!!streamBoundary);
}

module.exports = { createStepCompletionTracker, completion, isCompleted, createCompletionTracker, createAdapterCompletion, createProtocolCompletionTracker };
