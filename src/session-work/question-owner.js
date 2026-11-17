'use strict';

// Synchronous transport for the Rust question owner. The caller supplies a
// trusted legacy snapshot for first access; only Rust decides transitions.
function createQuestionOwner({ getStore, initialState, liveTurn, now = Date.now } = {}) {
  for (const [name, value] of Object.entries({ getStore, initialState, liveTurn, now })) {
    if (typeof value !== 'function') throw new TypeError(`[question-owner] ${name} is required`);
  }
  function store() {
    const value = getStore();
    if (typeof value?.sessionWorkStateSync !== 'function' || typeof value?.sessionWorkQuestionSync !== 'function') {
      throw Object.assign(new Error('session_work_question_owner_unavailable'), { code: 'SESSION_WORK_OWNER_UNAVAILABLE' });
    }
    return value;
  }
  function read(sessionId) {
    const current = store();
    const observed = current.sessionWorkStateSync(sessionId);
    return observed.exists ? observed : current.sessionWorkStateSync(sessionId, initialState(sessionId));
  }
  function readAsync(sessionId) {
    const current = store();
    if (typeof current.sessionWorkStateReadOrInitialize !== 'function') {
      throw Object.assign(new Error('session_work_question_owner_unavailable'), { code: 'SESSION_WORK_OWNER_UNAVAILABLE' });
    }
    return current.sessionWorkStateReadOrInitialize(sessionId, initialState);
  }
  function transition(action, sessionId, fields = {}) {
    const current = store();
    const request = { ...fields, action, sessionId, at: Number(now()) };
    // A missing-row error is emitted before any write. Only then consult the
    // trusted legacy snapshot; initialized sessions never depend on it again.
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return current.sessionWorkQuestionSync(request); }
      catch (error) {
        if (error?.code !== 'ORCHESTRATION_SQLITE_ERROR') throw error;
        if (error.message === 'question transition requires a trusted initial snapshot'
            && !Object.hasOwn(request, 'initialState')) {
          request.initialState = initialState(sessionId);
          continue;
        }
        if (error.message === 'question move requires a trusted target snapshot'
            && !Object.hasOwn(request, 'targetInitialState')) {
          request.targetInitialState = initialState(request.targetSessionId);
          continue;
        }
        throw error;
      }
    }
    throw new Error('session_work_question_initialization_failed');
  }
  async function transitionAsync(action, sessionId, fields = {}, prepare) {
    const current = store();
    if (typeof current.sessionWorkQuestion !== 'function') {
      throw Object.assign(new Error('session_work_question_owner_unavailable'), { code: 'SESSION_WORK_OWNER_UNAVAILABLE' });
    }
    const request = { ...fields, action, sessionId, at: Number(now()) };
    // Backfill retries remain inside one store queue slot, so a later answer
    // cannot run between a missing-row response and the initial write.
    return current.sessionWorkQuestion(request, initialState, prepare);
  }
  return Object.freeze({
    read, readAsync,
    record: signal => transition('record', String(signal.sessionId || ''), {
      signal, liveActiveTurn: liveTurn(String(signal.sessionId || '')),
    }),
    beginTurn: (sessionId, { originContinue = false, turnId } = {}) => transition('beginTurn', sessionId, { originContinue, turnId }),
    resolve: (sessionId, requestId, { dismissed = false } = {}) => transition('resolve', sessionId, { requestId, dismissed }),
    patchFacts: (sessionId, { categoryPatch, activeTurn } = {}) => transition('patchFacts', sessionId, { categoryPatch, activeTurn }),
    move: (sessionId, targetSessionId, { turnId, taskId, expectedRequestId } = {}) => transition('move', sessionId, {
      targetSessionId, turnId, taskId, expectedRequestId,
    }),
    // The queued transition must observe the active turn in its Rust snapshot
    // when its slot runs; a Node observation taken before an await can be stale.
    recordAsync: signal => transitionAsync('record', String(signal.sessionId || ''), { signal }),
    resolveAsync: (sessionId, requestId, { dismissed = false } = {}) => transitionAsync('resolve', sessionId, { requestId, dismissed }),
    beginTurnAsync: (sessionId, { originContinue = false, turnId } = {}) => transitionAsync('beginTurn', sessionId, { originContinue, turnId }),
    patchFactsAsync: (sessionId, { categoryPatch, activeTurn } = {}) => transitionAsync('patchFacts', sessionId, { categoryPatch, activeTurn }),
    refreshUnattendedAsync: (sessionId, readUnattended) => transitionAsync('patchFacts', sessionId, {},
      () => ({ categoryPatch: { unattended: readUnattended() || null } })),
    moveAsync: (sessionId, targetSessionId, { turnId, taskId, expectedRequestId } = {}) => transitionAsync('move', sessionId, {
      targetSessionId, turnId, taskId, expectedRequestId,
    }),
  });
}

module.exports = { createQuestionOwner };
