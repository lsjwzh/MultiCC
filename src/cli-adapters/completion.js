'use strict';

const { getNative } = require('../native/runtime');

function completion(state, reason, source = 'protocol') {
  return getNative().cliCompletion(state, reason, source);
}

function isCompleted(outcome) {
  return getNative().cliIsCompleted(outcome);
}

// One tracker per runner, never per adapter/session. Native events describe
// protocol completion; process/stream settlement supplies the independent
// execution boundary. Neither output text nor a socket close proves success.
function createCompletionTracker({ observe, close, fallback = false } = {}) {
  const native = new (getNative().RustCliCompletionTracker)();
  let evidence = completion('unknown', 'missing_terminal_event');
  // Opaque evidence, callbacks and SameValueZero tool identities stay in this
  // host closure until the adapter/runner interface moves. Rust owns decisions
  // and lifecycle flags without a strong native reference back into the closure.
  const tools = new Set();
  const port = Object.freeze({ observe, close, fallback, tools,
    read: () => evidence,
    write: value => { evidence = value; },
    settle: () => (evidence = Object.freeze({ ...evidence, settled: true })),
  });
  return Object.freeze({
    observe(raw, decoded = []) {
      if (!native.acceptsRaw(raw)) return evidence;
      for (const event of decoded) native.observeDecoded(event, tools);
      return native.observeProtocol(raw, decoded, port);
    },
    finish(boundary = {}) {
      return native.finish(boundary, port);
    },
    snapshot() { return evidence; },
  });
}

function createAdapterCompletion(adapter) {
  return typeof adapter?.createCompletionTracker === 'function'
    ? adapter.createCompletionTracker() : createCompletionTracker({ fallback: true });
}

function createProtocolCompletionTracker(protocol) {
  return createCompletionTracker({ observe: event => getNative().cliProtocolCompletion(protocol, event) });
}

module.exports = { completion, isCompleted, createCompletionTracker, createAdapterCompletion, createProtocolCompletionTracker };
