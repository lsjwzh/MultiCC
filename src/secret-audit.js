'use strict';

// Compatibility bridge only. Rust owns the schema, outcome policy, timestamps,
// private permissions, locking and durable append. No request text reaches it.
const { AsyncLocalStorage } = require('node:async_hooks');
const { createPaths } = require('./paths');
const { getNative } = require('./native/runtime');
const scope = new AsyncLocalStorage();

function record(input) {
  try {
    const file = createPaths().secretAuditFile;
    return JSON.parse(getNative('secret_audit', 'rust').recordSecretAudit(file, JSON.stringify(input)));
  } catch (_) {
    const error = new Error('Secret audit is unavailable; vault access cannot continue.');
    error.code = 'secret_audit_unavailable';
    error.statusCode = 503;
    error.secretToolError = true;
    throw error;
  }
}

function call(operation, context, names, action) {
  const inherited = scope.getStore() || {};
  // The router and host-side tools share one call when crossing the bridge.
  if (inherited.operation === operation) return action();
  const metadata = {
    operation, source: context?.source || inherited.source || 'internal',
    sessionId: context?.sessionId || inherited.sessionId,
    turnId: context?.turnId || inherited.turnId,
    taskId: context?.taskId || inherited.taskId,
    parentCallId: inherited.callId,
    names: Array.isArray(names) ? names.filter(n => typeof n === 'string') : [],
  };
  const { callId } = record({ ...metadata, phase: 'started' });
  const startedAt = Date.now();
  function finish(result, error) {
    // Environment maps can legally contain keys such as `error` or `signal`.
    // They are values issued to a child, never an operation-result envelope.
    const summary = operation === 'env_inject' || operation === 'env_overlay' ? null : result;
    record({ ...metadata, callId, phase: 'completed', durationMs: Math.max(0, Date.now() - startedAt),
      failed: !!error || !!summary?.error || summary?.ok === false,
      code: typeof error?.code === 'string' ? error.code : undefined,
      exitCode: Number.isInteger(summary?.exit_code) ? summary.exit_code : undefined,
      status: Number.isInteger(summary?.status) ? summary.status : undefined,
      timedOut: summary?.timed_out === true || error?.code === 'http_timeout',
      aborted: summary?.aborted === true,
      signaled: typeof summary?.signal === 'string' && !!summary.signal,
    });
    if (error) throw error;
    return result;
  }
  return scope.run({ ...metadata, callId }, () => {
    let result;
    try { result = action(); }
    catch (error) { return finish(null, error); }
    return result && typeof result.then === 'function'
      ? result.then(value => finish(value), error => finish(null, error))
      : finish(result);
  });
}

function withContext(context, action) {
  return scope.run({ ...scope.getStore(), ...context }, action);
}

module.exports = { call, withContext };
