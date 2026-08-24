'use strict';

const crypto = require('node:crypto');
const { createChatHostCoordinator } = require('./host-coordinator');
const { createProviderBinding } = require('../provider-binding');
const { redactProviderRouteCapability } = require('../observability');

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
  if (ports.persistTaskRunUsage != null && typeof ports.persistTaskRunUsage !== 'function') {
    throw new TypeError('chat host runtime port invalid: persistTaskRunUsage');
  }
  return ports;
}

function clean(value) { return value == null ? '' : String(value).trim(); }

function firstDefined(source, keys) {
  for (const key of keys) {
    if (source && source[key] != null) return source[key];
  }
  return undefined;
}

function tokenCount(value, label) {
  const number = value == null ? 0 : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return number;
}

const TOKEN_FIELDS = Object.freeze({
  input: Object.freeze(['input', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens', 'promptTokenCount']),
  cacheRead: Object.freeze(['cacheRead', 'cache_read', 'cacheReadTokens', 'cache_read_input_tokens', 'cached_input_tokens']),
  cacheWrite: Object.freeze(['cacheWrite', 'cache_write', 'cacheWriteTokens', 'cache_creation_input_tokens']),
  output: Object.freeze(['output', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'candidatesTokenCount']),
  reasoning: Object.freeze(['reasoning', 'reasoningTokens', 'reasoning_tokens', 'reasoning_output_tokens', 'thoughtsTokenCount']),
});

function normalizeUsage(rawUsage) {
  const outer = rawUsage && typeof rawUsage === 'object' && !Array.isArray(rawUsage) ? rawUsage : {};
  const source = outer.usage && typeof outer.usage === 'object' && !Array.isArray(outer.usage)
    ? outer.usage
    : outer;
  const observed = Object.values(TOKEN_FIELDS)
    .some(keys => keys.some(key => source[key] != null));
  if (!observed) return Object.freeze({ coverage: 'unobservable', tokens: null });
  return Object.freeze({
    coverage: 'observed',
    tokens: Object.freeze({
      input: tokenCount(firstDefined(source, TOKEN_FIELDS.input), 'usage.input'),
      cacheRead: tokenCount(firstDefined(source, TOKEN_FIELDS.cacheRead), 'usage.cacheRead'),
      cacheWrite: tokenCount(firstDefined(source, TOKEN_FIELDS.cacheWrite), 'usage.cacheWrite'),
      output: tokenCount(firstDefined(source, TOKEN_FIELDS.output), 'usage.output'),
      reasoning: tokenCount(firstDefined(source, TOKEN_FIELDS.reasoning), 'usage.reasoning'),
    }),
  });
}

function protocolFor(cli, explicit) {
  const protocol = clean(explicit);
  if (protocol) return protocol;
  if (cli === 'codex') return 'openai-responses';
  if (cli === 'claude') return 'anthropic-messages';
  return cli || 'unknown';
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

function taskRunCommitAcknowledged(result) {
  if (result === true) return true;
  if (!result || typeof result !== 'object' || result.ok === false) return false;
  const flags = ['inserted', 'duplicate', 'corrected'].filter(key => result[key] === true);
  return flags.length === 1
    && clean(result.eventId).length > 0
    && Number.isSafeInteger(Number(result.revision))
    && Number(result.revision) >= 0;
}

function normalizeTaskRunUsagePayload(input = {}) {
  const normalized = normalizeUsage(input.usage);
  const attribution = input.attribution && typeof input.attribution === 'object'
    ? input.attribution
    : {};
  const digest = crypto.createHash('sha256').update([
    clean(input.taskRunId), clean(input.sessionId), clean(input.turnId),
    clean(input.runnerId), clean(input.idempotencyKey),
  ].join('\u0000')).digest('hex').slice(0, 32);
  const eventId = `tru_${digest}`;
  const providerBinding = createProviderBinding({
    sessionId: clean(input.sessionId),
    cli: clean(attribution.cli).toLowerCase(),
    providerId: clean(attribution.providerId) || '_default_',
    model: clean(attribution.model) || null,
    roleKind: clean(attribution.roleKind).toLowerCase() || 'main',
    routeName: clean(attribution.routeName).toLowerCase() || 'main',
  });
  const event = Object.freeze({
    eventId,
    sourceEventId: clean(input.idempotencyKey) || null,
    occurredAt: attribution.occurredAt,
    providerId: clean(attribution.providerId) || '_default_',
    providerName: clean(attribution.providerName || attribution.providerId) || '_default_',
    cli: clean(attribution.cli).toLowerCase(),
    protocol: protocolFor(clean(attribution.cli).toLowerCase(), attribution.protocol),
    model: clean(attribution.model),
    roleKind: clean(attribution.roleKind).toLowerCase() || 'main',
    routeName: clean(attribution.routeName).toLowerCase() || 'main',
    source: 'reconciled',
    coverage: normalized.coverage,
    status: normalized.coverage === 'observed'
      ? clean(attribution.status).toLowerCase() || 'success'
      : 'unobservable',
    tokens: normalized.tokens,
    ...(attribution.routeAttemptId ? {
      runtimeEpoch: attribution.runtimeEpoch,
      turnId: attribution.turnId,
      decisionId: attribution.decisionId,
      routeAttemptId: attribution.routeAttemptId,
      routeGeneration: attribution.routeGeneration,
      attemptNo: attribution.attemptNo,
      providerRevision: attribution.providerRevision,
      routeAttribution: 'exact',
    } : {}),
  });
  return Object.freeze({
    runId: clean(input.taskRunId),
    taskRunId: clean(input.taskRunId),
    taskId: clean(input.taskId) || null,
    leaseEpoch: Number(input.leaseEpoch),
    taskRunLease: Object.freeze({
      runId: clean(input.taskRunId),
      leaseEpoch: Number(input.leaseEpoch),
    }),
    providerBinding,
    sessionId: clean(input.sessionId),
    turnId: clean(input.turnId),
    runnerId: clean(input.runnerId),
    idempotencyKey: clean(input.idempotencyKey),
    eventId,
    event,
    usage: normalized.tokens,
  });
}

function createChatHostRuntime(rawPorts) {
  const ports = assertHostRuntimePorts(rawPorts);
  const usagePort = {
    commit: ({ sessionId, usage, attribution }) => ports.persistUsage(sessionId, usage, attribution),
    afterCommit: ({ sessionId, attribution }) => ports.afterUsageCommit(sessionId, attribution),
  };
  if (ports.persistTaskRunUsage) {
    usagePort.commitTaskRun = input => taskRunCommitAcknowledged(
      ports.persistTaskRunUsage(normalizeTaskRunUsagePayload(input)),
    );
  }
  const coordinator = createChatHostCoordinator({
    history: {
      appendFinal: ({ sessionId, message }) => ports.appendMessage(
        sessionId, redactProviderRouteCapability(message),
      ),
    },
    usage: usagePort,
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
    recordDurableTurnUsage,
    runDurablePostTurn,
  });
}

module.exports = { REQUIRED_PORTS, assertHostRuntimePorts, createChatHostRuntime };
