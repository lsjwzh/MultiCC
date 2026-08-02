'use strict';

const { createChatHostCoordinator } = require('./host-coordinator');

const REQUIRED_PORTS = Object.freeze([
  'appendMessage',
  'persistUsage',
  'afterUsageCommit',
  'getSessionState',
  'consumeHandoff',
  'emitTurnComplete',
  'emitDispatchComplete',
  'emitGatewayComplete',
  'inspectDispatchMarkers',
  'logSuppressed',
]);

function assertHostRuntimePorts(ports) {
  if (!ports || typeof ports !== 'object') throw new TypeError('chat host runtime ports are required');
  for (const name of REQUIRED_PORTS) {
    if (typeof ports[name] !== 'function') throw new TypeError(`chat host runtime port missing: ${name}`);
  }
  return ports;
}

function createChatHostRuntime(rawPorts) {
  const ports = assertHostRuntimePorts(rawPorts);
  const coordinator = createChatHostCoordinator({
    history: {
      appendFinal: ({ sessionId, message }) => ports.appendMessage(sessionId, message),
    },
    usage: {
      commit: ({ sessionId, usage }) => ports.persistUsage(sessionId, usage),
      afterCommit: ({ sessionId }) => ports.afterUsageCommit(sessionId),
    },
  });

  function persistFinalAssistantResult(sessionId, state, turn, runner, message, options = {}) {
    const result = coordinator.appendFinal({
      turn,
      runner,
      currentTurn: state && state._activeTurn,
      currentRunner: state && state._activeRunner,
      boundary: options.resultEvent === true ? 'result' : 'close',
      facts: {
        normalExit: options.final === true,
        killReason: runner && runner.killReason,
        apiError: !!(runner && runner.sawApiError),
        adapterError: !!(runner && runner.adapterError),
        retryPlanned: !!(runner && runner.retryPlanned),
      },
      checkpointKey: options.checkpointKey,
      message,
    });
    if (state) state._resultSaved = result.durable === true;
    return result.durable === true;
  }

  function recordDurableTurnUsage(sessionId, runner, usage) {
    const state = ports.getSessionState(sessionId);
    return coordinator.commitUsage({
      turn: state && state._activeTurn,
      runner,
      currentTurn: state && state._activeTurn,
      currentRunner: state && state._activeRunner,
      usage,
    }).committed === true;
  }

  function executeEffect(effect, state) {
    if (effect.type === 'consume-cli-handoff') return ports.consumeHandoff(effect.sessionId);
    if (effect.type === 'turn-complete') {
      return ports.emitTurnComplete(effect.sessionId, state, {
        turnId: effect.turnId,
        lineage: effect.lineage,
        resultDurable: effect.resultDurable,
      });
    }
    if (effect.type === 'complete-dispatch') {
      return ports.emitDispatchComplete(effect.operationId, effect.sessionId, effect.finalText);
    }
    if (effect.type === 'gateway-turn-complete') {
      // sessionId/turnId identify which gateway instance produced the marker and
      // key its idempotency; a second gateway must not inherit the first's state.
      // requestId is the caller's correlation key for the terminal outcome frame.
      return ports.emitGatewayComplete(effect.finalText, effect.sessionId, effect.turnId, effect.requestId);
    }
    if (effect.type === 'inspect-dispatch-markers') {
      return ports.inspectDispatchMarkers(effect.sessionId, effect.finalText);
    }
    throw new Error(`unsupported chat post-turn effect: ${effect.type}`);
  }

  function runDurablePostTurn(sessionId, state, persisted, turn, runner, finalText, facts = {}) {
    const plan = coordinator.claimPostTurnPlan({
      turn,
      runner,
      currentTurn: state && state._activeTurn,
      currentRunner: state && state._activeRunner,
      interrupted: facts.interrupted === true,
      apiError: facts.apiError === true,
      retryPlanned: facts.retryPlanned === true,
      handoffResumeFailure: facts.handoffResumeFailure === true,
      sessionType: persisted && persisted.type,
      finalText,
    });
    if (!plan.ok) {
      ports.logSuppressed({
        sessionId,
        turnId: turn && turn.turnId,
        runnerId: runner && runner.runnerId,
        reason: plan.code,
      });
      return false;
    }
    for (const effect of plan.effects) executeEffect(effect, state);
    if (state && state._continuationLineage
        && state._continuationLineage.turnId === (turn && turn.turnId)) {
      state._continuationLineage = null;
    }
    return true;
  }

  return Object.freeze({
    isCurrentTurnRunner: coordinator.isCurrentTurnRunner,
    assistantCheckpointKey: coordinator.assistantCheckpointKey,
    persistFinalAssistantResult,
    recordDurableTurnUsage,
    runDurablePostTurn,
  });
}

module.exports = { REQUIRED_PORTS, assertHostRuntimePorts, createChatHostRuntime };
