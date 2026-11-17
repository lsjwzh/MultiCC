'use strict';

const { createQuestionOwner } = require('./question-owner');
const { createUserInputOwnedHost } = require('../classify/user-input-owned-host');
const { createSessionWorkHost } = require('./host');

// Production composition. The legacy fields are consulted only for the first
// durable snapshot; after initialization the Rust store is the sole owner.
function createProductionQuestionHost({ getStore, getSession, getState, getRecord = () => null, setState, onResolved, log, now } = {}) {
  const liveTurn = id => {
    const session = getSession(id);
    if (!session) return null;
    return { _activeTurn: session._activeTurn ? { turnId: session._activeTurn.turnId } : null,
      isStreaming: session.isStreaming === true, _currentTaskId: session._currentTaskId || null };
  };
  const owner = createQuestionOwner({ getStore, liveTurn, ...(now ? { now } : {}), initialState(id) {
    const { pendingUserInput = null, ...category } = getState(id) || {};
    return { pendingQuestion: pendingUserInput, activeTurn: liveTurn(id),
      category: { ...category, unattended: getRecord(id)?.unattended || null } };
  } });
  const base = createUserInputOwnedHost({ owner, getState, setState, onResolved, log });
  const host = Object.freeze({ ...base, activateTurnAsync: id => owner.patchFactsAsync(id, { activeTurn: liveTurn(id) }),
    refreshAdmissionFactsAsync: id => owner.refreshUnattendedAsync(id, () => getRecord(id)?.unattended) });
  return { owner, host };
}

function createProductionWorkHost(deps, host) {
  const work = createSessionWorkHost({ ...deps, userInputSignalHost: host,
    pendingUserInput: host.pending, recordUserInput: host.record,
    resolveUserInput: host.resolve, moveUserInput: host.move });
  return Object.freeze({ ...work, recordInput: work.recordInputAsync, replayState: work.replayStateAsync });
}

module.exports = { createProductionQuestionHost, createProductionWorkHost };
