'use strict';

const { createHash } = require('node:crypto');
const { createProviderRevision } = require('./provider-attempt-runtime');
const { resolveAutoStallTimeoutMs } = require('./auto-stall-timeout');
const { createProviderRouteProof } = require('./turn-request');
const { protocolFamilyOf } = require('../cli/cli-capability');

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function protocolFor(cli, summary) {
  const explicit = clean(summary && (summary.apiFormat || summary.protocol));
  if (explicit) return explicit;
  return protocolFamilyOf(cli, 'api') || clean(cli) || 'native';
}

// Everything a physical child bakes at spawn, hashed for the route capability.
// A resident lane keeps its capability while this digest is unchanged and gets a
// fresh one as soon as it moves, so the lane's own routing fingerprint recycles
// the warm process exactly when the spawn contract changed — and never because
// the attempt (or its route token) merely rotated, which is what made residency
// impossible. Claude bakes its route into ANTHROPIC_* plus --model/--effort/
// --agent argv, so the argv and SDK options belong here. The codex app-server
// reads its route from CODEX_HOME and takes model/effort per turn (turn/start,
// see the adapter's turnOptions), so its provider binding alone is the contract.
function spawnKeyFor({ cli, providerId, protocol, providerRevision, subagent, invocation }) {
  const contract = [providerId, protocol, providerRevision, subagent];
  if (protocolFamilyOf(cli, 'api') !== 'openai_responses') {
    contract.push(
      invocation && (invocation.sdkOptions || invocation.streamArgs || invocation.args) || null,
      invocation && invocation.settings || null,
    );
  }
  return createHash('sha256').update(JSON.stringify(contract)).digest('base64url');
}

function providerRetryRouteOptions(attempt) {
  const route = attempt && typeof attempt === 'object' ? attempt : {};
  return {
    providerId: route.providerId,
    model: route.model === '_default_' ? null : route.model,
  };
}

function createProviderInvocationFactory(options = {}) {
  const router = options.providerRouterRuntime;
  const attempts = options.providerAttemptRuntime;
  const effectiveSessionModel = options.effectiveSessionModel;
  if (!router || typeof router.createBinding !== 'function'
      || typeof router.resolveSpawnEnv !== 'function'
      || typeof router.getProviderSummary !== 'function') {
    throw new TypeError('provider router runtime is required');
  }
  if (!attempts || typeof attempts.beginAttempt !== 'function'
      || typeof attempts.proxySessionId !== 'function') {
    throw new TypeError('provider attempt runtime is required');
  }
  if (typeof effectiveSessionModel !== 'function') {
    throw new TypeError('effective session model resolver is required');
  }

  function prepare(input = {}) {
    const { request, turn, session, provider, envelope } = input;
    if (!request || !turn || !session || !provider || !envelope
        || typeof provider.buildInvocation !== 'function') {
      throw new TypeError('provider invocation input is incomplete');
    }
    const selectionOverrides = Object.freeze({
      ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
    });
    const hasModelOverride = input.model !== undefined;
    const routeBinding = router.createBinding(session, selectionOverrides);
    const resolution = router.resolveSpawnEnv(session, selectionOverrides);
    const routeRawModel = clean(resolution.qualifiedModel)
      || clean(routeBinding.model)
      || (hasModelOverride ? null : envelope.spawnOpts.rawModel);
    const routeEffectiveModel = hasModelOverride
      ? (clean(routeBinding.model) || clean(resolution.providerModel) || null)
      : effectiveSessionModel(session);
    const baseInvocationEnvelope = {
      ...envelope,
      spawnOpts: {
        ...envelope.spawnOpts,
        skipDefaultModel: resolution.skipDefaultModel,
        providerModel: resolution.providerModel,
        providerModels: resolution.providerModels,
        effectiveModel: routeEffectiveModel,
        rawModel: routeRawModel,
      },
    };
    const invocationEnvelope = input.bareText === undefined
      ? baseInvocationEnvelope
      : {
        ...baseInvocationEnvelope,
        contextLayers: [],
        userText: String(input.bareText),
        suffix: '',
        historyHandle: {
          ...baseInvocationEnvelope.historyHandle,
          isFirstTurn: input.firstTurn === true,
          cliSessionId: session.cliSessionId,
        },
        spawnOpts: { ...baseInvocationEnvelope.spawnOpts, ultracode: false },
      };
    const invocation = provider.buildInvocation(invocationEnvelope);
    const model = clean(invocationEnvelope.spawnOpts.rawModel)
      || clean(invocationEnvelope.spawnOpts.effectiveModel)
      || clean(resolution.providerModel)
      || clean(routeBinding.model)
      || '_default_';
    const binding = router.createBinding(session, { ...selectionOverrides, model });
    const providerId = binding.providerId || '_default_';
    // `model` above is the immutable wire model proved by the attempt (for
    // OpenCode/ZCode it may already be `provider-id/raw-model`). buildChildEnv
    // resolves a ProviderBinding again, so feeding that qualified value back as
    // its selection would qualify it a second time. Preserve the raw selection
    // separately for the child-env rebuild while the proof/attempt keep `model`.
    const selectedModel = clean(routeBinding.model)
      || clean(resolution.providerModel)
      || (Array.isArray(resolution.providerModels)
        ? resolution.providerModels.map(clean).find(Boolean) : '')
      || null;
    const routeOverrides = Object.freeze({ providerId: binding.providerId, model: selectedModel });
    const summary = binding.providerId
      ? router.getProviderSummary(undefined, binding.providerId)
      : null;
    const protocol = protocolFor(binding.cli, summary);
    const providerName = clean(resolution.providerName)
      || clean(summary && summary.name) || providerId;
    const providerRevision = createProviderRevision({
      cli: binding.cli, providerId, protocol, model, summary,
    });
    const attempt = attempts.beginAttempt({
      sessionId: binding.sessionId,
      turnId: turn.turnId,
      cli: binding.cli,
      providerId,
      providerName,
      protocol,
      model,
      providerRevision,
      subagentProviderId: session.subagent && session.subagent.providerId,
      attemptNo: input.attemptNo,
      reasonCode: input.reasonCode,
      continuation: input.continuation === true,
      // Auto Provider only fails over when an attempt errors, so a silently
      // stalled upstream wedges the turn forever. Every Auto attempt therefore
      // carries its own idle budget for the proxy watchdog; a non-Auto session
      // resolves to 0 and the proxy never arms one for it.
      stallTimeoutMs: resolveAutoStallTimeoutMs(session, input.env),
      spawnKey: spawnKeyFor({
        cli: binding.cli, providerId, protocol,
        providerRevision: protocolFamilyOf(binding.cli, 'api') === 'openai_responses'
          ? createProviderRevision({ cli: binding.cli, providerId, protocol, model: '_spawn_', summary }) : providerRevision,
        subagent: session.subagent ? {
          providerId: clean(session.subagent.providerId), model: clean(session.subagent.model),
          revision: createProviderRevision({ cli: binding.cli, providerId: session.subagent.providerId,
            protocol, model: session.subagent.model || '_default_',
            summary: router.getProviderSummary(undefined, session.subagent.providerId) }),
        } : null,
        invocation,
      }),
    });
    let routeProof;
    let proxySessionId;
    try {
      routeProof = createProviderRouteProof(request, {
        resolved: true,
        binding,
        providerName,
        protocol,
        runtimeEpoch: attempt.runtimeEpoch,
        turnId: turn.turnId,
        decisionId: attempt.decisionId,
        routeAttemptId: attempt.routeAttemptId,
        routeGeneration: attempt.routeGeneration,
        attemptNo: attempt.attemptNo,
        providerRevision,
      });
      proxySessionId = attempts.proxySessionId(attempt);
    } catch (error) {
      attempts.finishAttempt(attempt, {
        outcome: 'failed', errorCategory: 'route_proof', reasonCode: 'route_proof_rejected',
      });
      throw error;
    }
    const baseUsageAttribution = Object.freeze({
      providerId, providerName, cli: binding.cli, protocol, model,
      roleKind: 'main', routeName: 'main',
    });
    const usageAttribution = Object.freeze({
      ...baseUsageAttribution,
      runtimeEpoch: attempt.runtimeEpoch,
      decisionId: attempt.decisionId,
      routeAttemptId: attempt.routeAttemptId,
      routeGeneration: attempt.routeGeneration,
      attemptNo: attempt.attemptNo,
      providerRevision: attempt.providerRevision,
    });
    return Object.freeze({
      routeOverrides, routeBinding, binding, resolution, invocationEnvelope,
      invocation, attempt, routeProof, proxySessionId,
      baseUsageAttribution, usageAttribution,
    });
  }

  return Object.freeze({ prepare });
}

module.exports = {
  createProviderInvocationFactory,
  protocolFor,
  providerRetryRouteOptions,
};
