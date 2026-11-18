'use strict';

const { applyUserInputEvidence, userInputDegraded } = require('./vocab');

// Compatibility transport around the Rust-owned question lifecycle. The
// caller must provide trusted first-access snapshots and must route all live
// writers and readers through the same owner before enabling this host.
function createUserInputOwnedHost({ owner, getState, setState, onResolved = () => {}, log = () => {} } = {}) {
  if (!owner || ['read', 'record', 'beginTurn', 'resolve', 'move'].some(name => typeof owner[name] !== 'function')) {
    throw new TypeError('[user-input-signal] Rust question owner is required');
  }
  if (typeof getState !== 'function' || typeof setState !== 'function') {
    throw new TypeError('[user-input-signal] state ports are required');
  }
  let readContext = null;
  function read(sessionId) {
    const context = readContext;
    return context?.sessionId === sessionId ? context.snapshot : owner.read(sessionId);
  }
  async function withSnapshotAsync(sessionId, fn) {
    const snapshot = await owner.readAsync(sessionId);
    const previous = readContext;
    readContext = { sessionId, snapshot };
    try { return fn(); }
    finally { readContext = previous; }
  }
  function pending(sessionId) { return read(sessionId).pendingQuestion || null; }
  function lastResolved(sessionId) { return read(sessionId).category?.lastResolvedUserInput || null; }
  function turnId(sessionId) { return read(sessionId).category?.userInputSignalTurnId || null; }
  async function pendingAsync(sessionId) { return (await owner.readAsync(sessionId)).pendingQuestion || null; }
  async function lastResolvedAsync(sessionId) { return (await owner.readAsync(sessionId)).category?.lastResolvedUserInput || null; }
  async function turnIdAsync(sessionId) { return (await owner.readAsync(sessionId)).category?.userInputSignalTurnId || null; }
  async function snapshotAsync(sessionId) { return owner.readAsync(sessionId); }
  function notify(sessionId, notification) {
    if (!notification || notification.type !== 'user_input_resolved') return;
    const { type, requestId, taskId, ...extra } = notification;
    onResolved(sessionId, requestId, taskId ?? null, Object.keys(extra).length ? extra : undefined);
  }
  function recorded(signal, response) {
    if (response.result?.ok && !response.result.duplicate) {
      log(`[multicc/classify] ${signal.sessionId} request_user_input recorded request=${signal.requestId} turn=${signal.turnId}`);
    }
    return response.result;
  }
  function record(signal = {}) { return recorded(signal, owner.record(signal)); }
  async function recordAsync(signal = {}) { return recorded(signal, await owner.recordAsync(signal)); }
  function begun(sessionId, response) {
    notify(sessionId, response.notification);
    // The classification projection remains in the session-record host until
    // its other writers are migrated; pending-question fields are not written.
    return setState(sessionId, { classifyState: 'P', goalState: null });
  }
  function beginTurn(sessionId, options = {}) { return begun(sessionId, owner.beginTurn(sessionId, options)); }
  async function beginTurnAsync(sessionId, options = {}) { return begun(sessionId, await owner.beginTurnAsync(sessionId, options)); }
  function resolved(sessionId, requestId, response) {
    notify(sessionId, response.notification);
    if (response.result?.ok && !response.result.duplicate) {
      log(`[multicc/classify] ${sessionId} request_user_input resolved request=${requestId}`);
    }
    return response.result;
  }
  function resolve(sessionId, requestId, options = {}) { return resolved(sessionId, requestId, owner.resolve(sessionId, requestId, options)); }
  async function resolveAsync(sessionId, requestId, options = {}) {
    return resolved(sessionId, requestId, await owner.resolveAsync(sessionId, requestId, options));
  }
  function moved(sourceId, targetId, response) {
    if (!response.result?.ok) return response.result;
    notify(sourceId, response.notification);
    setState(targetId, { classifyState: 'W' });
    return { ok: true, requestId: response.question?.requestId, question: response.question };
  }
  function move(sourceId, targetId, options = {}) { return moved(sourceId, targetId, owner.move(sourceId, targetId, options)); }
  async function moveAsync(sourceId, targetId, options = {}) {
    return moved(sourceId, targetId, await owner.moveAsync(sourceId, targetId, options));
  }
  function apply(sessionId, result) { return applyUserInputEvidence(result, pending(sessionId)); }
  function degradedResult(sessionId, currentTask) {
    const question = pending(sessionId);
    if (!question || question.resolved === true) return null;
    const state = getState(sessionId) || {};
    return userInputDegraded(question, { goal: state.goal, phase: state.phase },
      { goal: currentTask?.goal, phase: currentTask?.phase });
  }
  return Object.freeze({ pending, lastResolved, turnId, pendingAsync, lastResolvedAsync, turnIdAsync, snapshotAsync, withSnapshotAsync, record, beginTurn, resolve, move,
    recordAsync, beginTurnAsync, resolveAsync, moveAsync, apply, degradedResult });
}

module.exports = { createUserInputOwnedHost };
