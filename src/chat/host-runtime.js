'use strict';

const { createChatHostCoordinator } = require('./host-coordinator');
const { redactProviderRouteCapability } = require('../observability');
const { protocolFamilyOf } = require('../cli/cli-capability');
const turnTimeline = require('./turn-timeline');

const REQUIRED_PORTS = Object.freeze([
  'appendMessage',
  'persistUsage',
  'afterUsageCommit',
  'getSessionState',
  'consumeHandoff',
  'emitTurnComplete',
  'emitDispatchComplete',
  'emitGatewayComplete',
  'logSuppressed',
]);

function assertHostRuntimePorts(ports) {
  if (!ports || typeof ports !== 'object') throw new TypeError('chat host runtime ports are required');
  for (const name of REQUIRED_PORTS) {
    if (typeof ports[name] !== 'function') throw new TypeError(`chat host runtime port missing: ${name}`);
  }
  return ports;
}

function clean(value) { return value == null ? '' : String(value).trim(); }

// The turn's main/sub split is otherwise only a live WS event; persisting it on
// the assistant message lets a reloaded history render the same 主/辅 rows.
// Only turns with sub-agent usage carry it — a main-only turn's `usage` already
// is the main row, so plain history stays byte-for-byte what it was.
function persistedRoleUsage(snapshotFn, sessionId) {
  if (typeof snapshotFn !== 'function') return null;
  let snap = null;
  try { snap = snapshotFn(sessionId); } catch (_) { return null; }
  if (!snap || !snap.sub) return null;
  return {
    main: snap.main || null,
    mainByProvider: Array.isArray(snap.mainByProvider) ? snap.mainByProvider : [],
    sub: snap.sub,
    subByProvider: Array.isArray(snap.subByProvider) ? snap.subByProvider : [],
  };
}

function protocolFor(cli, explicit) {
  const protocol = clean(explicit);
  if (protocol) return protocol;
  return protocolFamilyOf(cli) || cli || 'unknown';
}

function attributionSnapshot(state, turn, runner, explicit = {}) {
  const task = turn && turn.task && typeof turn.task === 'object' ? turn.task : {};
  const source = explicit && typeof explicit === 'object' ? explicit : {};
  const bound = runner && runner.usageAttribution && typeof runner.usageAttribution === 'object'
    ? runner.usageAttribution
    : turn && turn.usageAttribution && typeof turn.usageAttribution === 'object'
      ? turn.usageAttribution
      : {};
  const cli = clean(bound.cli || source.cli || (runner && runner.cli) || (state && state.cli)).toLowerCase();
  const providerId = clean(
    bound.providerId || source.providerId || (runner && runner.providerId)
    || (state && (state.providerId || state.provider)),
  ) || '_default_';
  const roleKind = clean(
    bound.roleKind || source.roleKind || source.role || (runner && runner.roleKind)
    || task.roleKind || (state && state.roleKind),
  ).toLowerCase() || 'main';
  return Object.freeze({
    providerId,
    providerName: clean(
      bound.providerName || source.providerName || (runner && runner.providerName)
      || (state && state.providerName),
    ) || providerId,
    cli,
    protocol: protocolFor(cli, bound.protocol || source.protocol || (runner && runner.protocol)),
    model: clean(
      bound.model || source.model || (runner && (runner.model || runner.modelId))
      || (state && (state.model || state.modelId)),
    ),
    roleKind,
    routeName: clean(
      bound.routeName || source.routeName || (runner && runner.routeName) || task.routeName
      || (state && state.routeName),
    ).toLowerCase() || roleKind,
    status: clean(source.status).toLowerCase() || 'success',
    occurredAt: Number.isSafeInteger(Number(source.occurredAt)) && Number(source.occurredAt) >= 0
      ? Number(source.occurredAt)
      : Date.now(),
    ...((bound.runtimeEpoch && bound.decisionId && bound.routeAttemptId
        && bound.providerRevision && Number.isSafeInteger(bound.routeGeneration)
        && Number.isSafeInteger(bound.attemptNo)) ? {
      runtimeEpoch: bound.runtimeEpoch,
      turnId: clean((runner && runner.turnId) || (turn && turn.turnId)),
      decisionId: bound.decisionId,
      routeAttemptId: bound.routeAttemptId,
      routeGeneration: bound.routeGeneration,
      attemptNo: bound.attemptNo,
      providerRevision: bound.providerRevision,
      routeAttribution: 'exact',
    } : {}),
  });
}

// Which model actually produced an assistant message is per-message, not per
// session: a session can switch provider/model mid-conversation, so a reloaded
// transcript needs each bubble to say who wrote it. Four display facts only —
// the same values the usage attribution keeps for a turn. `_default_` is the
// "no route configured, the CLI's own login answered" marker and says nothing
// about which model produced the text, so it is dropped; a turn whose four
// facts are all empty gets no `modelAttribution` key at all, so old history
// (and every path with no attribution) keeps its byte-for-byte shape.
const MODEL_ATTRIBUTION_KEYS = Object.freeze(['cli', 'providerId', 'providerName', 'model']);
const NO_ATTRIBUTION = '_default_';

function modelAttributionFor(state, turn, runner) {
  let snapshot = null;
  try { snapshot = attributionSnapshot(state, turn, runner); } catch (_) { return null; }
  const attribution = {};
  for (const key of MODEL_ATTRIBUTION_KEYS) {
    const value = clean(snapshot[key]);
    if (!value || value === NO_ATTRIBUTION) continue;
    attribution[key] = value;
  }
  return Object.keys(attribution).length ? attribution : null;
}

// The merge view of the same computation: `{}` when there is nothing to say, so
// a caller can fold it into an object without an `if`. Both the durable history
// stamp and the live `result` frame spread this, which is what keeps a
// streaming bubble and the same bubble after a reload byte-identical.
function modelAttributionField(state, turn, runner) {
  const attribution = modelAttributionFor(state, turn, runner);
  return attribution ? { modelAttribution: attribution } : {};
}

function createChatHostRuntime(rawPorts) {
  const ports = assertHostRuntimePorts(rawPorts);
  const usagePort = {
    commit: ({ sessionId, usage, attribution }) => ports.persistUsage(sessionId, usage, attribution),
    afterCommit: ({ sessionId, attribution }) => ports.afterUsageCommit(sessionId, attribution),
  };
  const coordinator = createChatHostCoordinator({
    history: {
      appendFinal: ({ sessionId, message }) => ports.appendMessage(
        sessionId, redactProviderRouteCapability(message),
      ),
    },
    usage: usagePort,
  });

  function persistFinalAssistantResult(sessionId, state, turn, runner, message, options = {}) {
    const roleUsage = persistedRoleUsage(ports.roleUsageSnapshot, sessionId);
    if (roleUsage && message && message.role === 'assistant') message = { ...message, roleUsage };
    // Same computation the live `result` frame spreads (see turn-engine), so a
    // bubble cannot say one model while streaming and another after a reload.
    if (message && message.role === 'assistant') {
      const attribution = modelAttributionField(state, turn, runner);
      if (attribution.modelAttribution) message = { ...message, ...attribution };
      // Model request/thinking/output spans for the replay trajectory strip;
      // every lane persists through here, so this is the one stamping point.
      if (!message.timeline) message = { ...message, ...turnTimeline.field(state) };
    }
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

  function recordDurableTurnUsage(sessionId, runner, usage, attribution = {}) {
    const state = ports.getSessionState(sessionId);
    const turn = state && state._activeTurn;
    return coordinator.commitUsage({
      turn,
      runner,
      currentTurn: turn,
      currentRunner: state && state._activeRunner,
      usage,
      attribution: attributionSnapshot(state, turn, runner, attribution),
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
      // sessionId/turnId identify which gateway instance produced the turn and
      // key its idempotency; a second gateway must not inherit the first's state.
      // requestId is the caller's correlation key for the terminal outcome frame.
      return ports.emitGatewayComplete(effect.finalText, effect.sessionId, effect.turnId, effect.requestId);
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
    // Part of the runtime contract, not just a module-level helper: server.js
    // destructures this off the returned object and hands it to the turn engine
    // (live `result` frame) and the codex usage host. Omitting it here makes the
    // name undefined at both call sites — the turn engine then throws mid
    // finalization and wedges the session's provider attempt.
    modelAttributionField,
    recordDurableTurnUsage,
    runDurablePostTurn,
  });
}

module.exports = {
  REQUIRED_PORTS,
  assertHostRuntimePorts,
  createChatHostRuntime,
  modelAttributionFor,
  modelAttributionField,
};
