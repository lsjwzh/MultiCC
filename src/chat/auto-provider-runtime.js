'use strict';

const {
  protocolOf,
  trustDomainOf,
  validateProviderSelection,
} = require('../providers/auto-provider-config');
const {
  NATIVE_OPENCODE_PREFIX,
  nativeOpenCodeId,
  syntheticNativeOpenCodeProvider,
} = require('../providers/native-opencode');
const { peekOpenCodeModels } = require('../routes/opencode-models');
const {
  chooseCandidate,
  failoverSafety,
  limitState,
} = require('./auto-provider-policy');
const { createAutoProviderRouting } = require('./auto-provider-routing');
const { expandCandidates, priceLadder } = require('./auto-provider-pricing');
const { createRoutingAdmissionPhase } = require('./admission-progress');
const { STALE_MS_DEFAULT } = require('../quota/provider-limit-cache');

const UNSAFE_HANDOFF_REASONS = new Set([
  'unsafe_failure_phase',
  'unsafe_replay_boundary',
  'provider_replay_fence_closed',
]);

class AutoProviderError extends Error {
  constructor(message, code = 'AUTO_PROVIDER_UNAVAILABLE') {
    super(message);
    this.name = 'AutoProviderError';
    this.code = code;
  }
}

function createAutoProviderRuntime(options = {}) {
  const providers = options.providers;
  if (!providers || typeof providers.listProviders !== 'function'
      || typeof providers.appTypeForCli !== 'function') {
    throw new TypeError('[auto-provider] providers catalog is required');
  }
  const limitCache = options.providerLimitCache || null;
  const staleAfterMs = Math.max(1_000, Number(options.limitCacheStaleMs) || STALE_MS_DEFAULT);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const emit = typeof options.emit === 'function' ? options.emit : () => {};
  const logger = options.logger || { info() {}, warn() {} };
  const liveBackgroundGate = typeof options.hasLiveBackgroundTasks === 'function'
    ? options.hasLiveBackgroundTasks : null;
  // Whether a lane can be switched to right now (installed, not disabled).
  // Only a cross-CLI pool ever asks.
  const isCliAvailable = typeof options.isCliAvailable === 'function'
    ? options.isCliAvailable : () => true;
  // The shared price table is only touched by a pool that prices its lines, so
  // a legacy pool never starts its refresh timer. `null` disables pricing.
  let priceTable = options.priceTable;
  function pricing() {
    if (priceTable === undefined) {
      try { priceTable = require('../pricing/price-table').sharedPriceTable(); }
      catch (_) { priceTable = null; }
    }
    return priceTable;
  }
  // Difficulty routing owns its own store; the runtime is the single owner of
  // both the pool and the tier verdict so a turn cannot be routed by one and
  // spawned by the other.
  const routing = options.routing || createAutoProviderRouting({
    logger,
    fetchImpl: options.fetchImpl,
    resolveApiKey: options.resolveApiKey,
    ttlMs: options.routingTtlMs,
    resolveLadder: ({ session, selection }) => catalogCandidates(session, selection).ladder.tiers,
  });
  const stickyBySession = new Map();
  const currentBySession = new Map();
  const selectionRefBySession = new Map();
  const pendingBySession = new Map();
  // Lane switches since the last successful turn. A cross-CLI pool whose every
  // lane is failing would otherwise hand the session back and forth forever.
  const hopsBySession = new Map();

  // The `<id>/<model>` wire ids OpenCode's own providers serve, read straight
  // from the 1-day model cache the /api/opencode/models route keeps. A cold
  // cache is not a failure: the native line simply keeps no model list and the
  // CLI falls back to its own default.
  function nativeModelOptions(id) {
    return (peekOpenCodeModels() || [])
      .filter(entry => entry && entry.provider === id && entry.model)
      .map(entry => `${entry.provider}/${entry.model}`);
  }

  // `nativeIds` are the OpenCode-native ids this pool names on the lane (see
  // catalogCandidates). They are not MultiCC providers, so a synthetic entry is
  // added per id: the runtime then treats the line exactly like any other route
  // (model choices included) while the spawn path resolves it to OpenCode's own
  // config.
  function laneCatalog(cli, nativeIds = null) {
    const appType = providers.appTypeForCli(cli);
    const resolvedAppTypes = typeof providers.appTypesForCli === 'function'
      ? providers.appTypesForCli(cli)
      : (cli === 'opencode' || cli === 'zcode' ? ['claude', 'codex'] : (appType ? [appType] : []));
    const appTypes = Array.isArray(resolvedAppTypes) ? [...new Set(resolvedAppTypes)] : [];
    const catalog = appTypes.length
      ? appTypes.flatMap(type => providers.listProviders(type))
      : providers.listProviders(appType);
    const byId = new Map((Array.isArray(catalog) ? catalog : [])
      .map(provider => [String(provider.id), provider]));
    if (cli === 'opencode' && nativeIds && nativeIds.size) {
      for (const id of nativeIds) {
        const key = NATIVE_OPENCODE_PREFIX + id;
        if (!byId.has(key)) byId.set(key, syntheticNativeOpenCodeProvider(id, nativeModelOptions(id)));
      }
    }
    return byId;
  }

  // Every line of the pool, on every lane, with its limit state and — for a
  // price-tiered pool — its price and this turn's price tier.
  function catalogCandidates(session, selection) {
    const home = session.cli || 'claude';
    const lanes = new Map();
    // Native OpenCode ids this pool names, per lane: a synthetic entry is built
    // only for a line the pool actually uses.
    const nativeIds = new Map();
    for (const candidate of selection.candidates) {
      const cli = candidate.cli || home;
      const nativeId = cli === 'opencode' ? nativeOpenCodeId(candidate.providerId) : null;
      if (nativeId === null) continue;
      if (!nativeIds.has(cli)) nativeIds.set(cli, new Set());
      nativeIds.get(cli).add(nativeId);
    }
    const lane = cli => {
      if (!lanes.has(cli)) lanes.set(cli, laneCatalog(cli, nativeIds.get(cli)));
      return lanes.get(cli);
    };
    const base = selection.candidates.map((candidate, index) => {
      const cli = candidate.cli || home;
      const provider = lane(cli).get(candidate.providerId);
      let entry = null;
      if (limitCache && provider) {
        try { entry = limitCache.get(provider.appType, provider.id); } catch (_) { entry = null; }
      }
      const limit = limitState(entry, { now: Number(now()), staleAfterMs });
      return Object.freeze({
        ...candidate,
        index,
        provider,
        providerName: provider && provider.name || candidate.providerId,
        protocol: protocolOf(provider),
        trustDomain: trustDomainOf(provider),
        model: candidate.model || provider && provider.model || null,
        limitState: limit.state,
        limitReason: limit.reason,
        cli,
      });
    });
    const priced = selection.routing && selection.routing.tiering === 'price';
    if (!priced) {
      // A manual ladder is hand-tagged on the lines themselves. An auto-model
      // line still expands over the models its provider serves — every variant
      // keeps the line's tier — and inside a tier the variants go cheapest
      // first, by price alone. Price is an internal sort key here, never shown.
      const expands = !!selection.routing && base.some(candidate => candidate.autoModel);
      const candidates = expands
        ? expandCandidates(base, { priceTable: pricing(), requirePrice: false })
        : base;
      return {
        candidates,
        ladder: Object.freeze({ tiers: null, tierOf: () => null, byPrice: expands }),
      };
    }
    const expanded = expandCandidates(base, { priceTable: pricing() });
    const ladder = priceLadder(expanded);
    return {
      candidates: expanded.map(candidate => Object.freeze({ ...candidate, tier: ladder.tierOf(candidate) })),
      ladder,
    };
  }

  // A new selection object (PATCH, re-enable, restart) starts from a clean slate.
  function syncSelection(sessionId, rawSelection) {
    if (selectionRefBySession.get(sessionId) === rawSelection) return;
    stickyBySession.delete(sessionId);
    currentBySession.delete(sessionId);
    pendingBySession.delete(sessionId);
    hopsBySession.delete(sessionId);
    selectionRefBySession.set(sessionId, rawSelection);
  }

  function priceFields(candidate) {
    return candidate && candidate.price
      ? { price: candidate.price.blended, priceSource: candidate.price.source || null } : {};
  }

  // Before a turn starts, decide whether it should run on another CLI lane.
  // Returns null to stay, or the lane (and the line reserved on it) to switch
  // to; the reservation is what beginTurn then picks on the new lane. Called by
  // the switch runtime, which owns the actual lane switch and its handoff.
  function planTurn({ session, text, turnOptions = {} } = {}) {
    const rawSelection = session && session.providerSelection;
    if (!rawSelection || rawSelection.mode !== 'auto') return null;
    // Background notifications belong to the lane whose tools they report on.
    if (turnOptions.bgTaskIds?.length || turnOptions.bgToolUseIds?.length) return null;
    const cli = session.cli || 'claude';
    const validated = validateProviderSelection(rawSelection, { cli, providers });
    if (!validated.ok || !validated.value.cliSwitch) return null;
    const selection = validated.value;
    syncSelection(session.id, rawSelection);
    if ((hopsBySession.get(session.id) || 0) >= selection.maxAttempts) return null;
    const pending = pendingBySession.get(session.id) || null;
    if (pending && pending.cli && pending.cli !== cli) {
      if (!isCliAvailable(pending.cli)) {
        pendingBySession.delete(session.id);
        return null;
      }
      return plan(session, pending);
    }
    // A continuation stays on its lane unless a handoff reserved another one.
    if (pending || (turnOptions.originContinue && !turnOptions.directUserInput)) return null;
    const { candidates, ladder } = catalogCandidates(session, selection);
    const reachable = candidates.filter(candidate => candidate.cli === cli || isCliAvailable(candidate.cli));
    const decision = selection.routing ? routing.resolveTier({
      selection,
      verdict: routing.consume({ sessionId: session.id, text }),
      tiers: ladder.tiers || undefined,
    }) : null;
    const choose = list => chooseCandidate({
      candidates: list,
      preferredTier: decision && decision.tier || null,
      ladder: ladder.tiers,
      byPrice: ladder.byPrice === true || !!ladder.tiers,
      preferCli: cli,
      stickyProviderId: selection.sticky ? stickyBySession.get(session.id) : null,
    }).candidate;
    let picked;
    if (selection.cliSwitch === 'routing') {
      picked = choose(reachable);
    } else {
      if (choose(reachable.filter(candidate => candidate.cli === cli))) return null;
      picked = choose(reachable.filter(candidate => candidate.cli !== cli));
    }
    if (!picked || picked.cli === cli) return null;
    const reservation = Object.freeze({
      sessionId: session.id,
      originTurnId: null,
      fromCli: cli,
      cli: picked.cli,
      fromProviderId: null,
      fromProviderName: null,
      providerId: picked.providerId,
      providerName: picked.providerName,
      model: picked.model,
      reasonCode: selection.cliSwitch === 'routing' ? 'auto_cli_routing' : 'auto_cli_failover',
      planned: true,
    });
    pendingBySession.set(session.id, reservation);
    // A price ladder is the only pool that publishes a price: a manual pool uses
    // it purely as an internal sort key.
    return plan(session, reservation, picked, decision,
      Array.isArray(ladder.tiers) && ladder.tiers.length > 0);
  }

  function plan(session, reservation, candidate = null, decision = null, priceTiered = false) {
    hopsBySession.set(session.id, (hopsBySession.get(session.id) || 0) + 1);
    const fromCli = session.cli || 'claude';
    const event = Object.freeze({
      type: 'provider_auto_route',
      version: 1,
      mode: 'auto',
      sessionId: session.id,
      turnId: null,
      routePhase: 'cli_switch_planned',
      cli: reservation.cli,
      fromCli,
      providerId: reservation.providerId,
      providerName: reservation.providerName || null,
      model: reservation.model || null,
      tier: candidate && candidate.tier || null,
      reasonCode: reservation.reasonCode || null,
      routing: decision,
      ...(priceTiered ? priceFields(candidate) : {}),
    });
    try { emit(session.id, event); } catch (_) {}
    logger.info?.('auto_provider_cli_switch_planned', {
      sessionId: session.id, fromCli, cli: reservation.cli,
      providerId: reservation.providerId, reasonCode: reservation.reasonCode || null,
    });
    return Object.freeze({
      cli: reservation.cli,
      fromCli,
      providerId: reservation.providerId,
      providerName: reservation.providerName || null,
      model: reservation.model || null,
      reasonCode: reservation.reasonCode || null,
    });
  }

  function beginTurn({ session, turnId, promptText }) {
    const rawSelection = session && session.providerSelection;
    if (!rawSelection || rawSelection.mode !== 'auto') {
      if (session && session.id) clearSession(session.id);
      return Object.freeze({
        enabled: false,
        routing: null,
        initial: () => Object.freeze({}),
        failover: () => null,
        prepareHandoff: () => null,
        recordSuccess: () => {},
      });
    }
    const validated = validateProviderSelection(rawSelection, {
      cli: session.cli || 'claude', providers,
    });
    if (!validated.ok) {
      throw new AutoProviderError(validated.error, validated.code || 'INVALID_AUTO_PROVIDER_CONFIG');
    }
    // A PATCH installs a new frozen selection object on the session. Reset
    // in-memory stickiness when that object changes, even if the new JSON is
    // textually identical after Auto was disabled and re-enabled.
    syncSelection(session.id, rawSelection);
    const selection = validated.value;
    const turnCli = session.cli || 'claude';
    const pool = catalogCandidates(session, selection);
    const ladder = pool.ladder;
    // The turn runs on one lane; the rest of the pool is only reachable through
    // a lane switch (planTurn before the turn, prepareHandoff after it).
    const candidates = pool.candidates.filter(candidate => candidate.cli === turnCli);
    const otherLanes = pool.candidates.filter(candidate => candidate.cli !== turnCli);
    // Difficulty routing: one verdict per USER MESSAGE, consumed here and pinned
    // for the whole turn — failover included — so a provider switch never
    // silently re-rolls the tier mid-turn. A verdict that never arrived (gateway
    // down, key missing, routing never prepared) resolves through onUnknown.
    const routingDecision = selection.routing
      ? routing.resolveTier({
        selection,
        verdict: routing.consume({ sessionId: session.id, text: promptText }),
        tiers: ladder.tiers || undefined,
      })
      : null;
    const preferredTier = routingDecision && routingDecision.tier ? routingDecision.tier : null;
    const attempted = new Set();
    let pending = pendingBySession.get(session.id) || null;
    // A reservation for another lane whose switch never happened (lane gone,
    // session busy) is void: this turn runs where the session actually is.
    if (pending && pending.cli && pending.cli !== turnCli) {
      pendingBySession.delete(session.id);
      pending = null;
    }
    if (pending?.fromProviderId && (!pending.fromCli || pending.fromCli === turnCli)) {
      attempted.add(pending.fromProviderId);
    }
    const byPrice = ladder.byPrice === true || !!ladder.tiers;
    // Only a price ladder publishes a price; a manual pool's variants carry one
    // purely so the chooser can order them, and it never reaches the wire.
    const priceTiered = Array.isArray(ladder.tiers) && ladder.tiers.length > 0;
    let current = null;
    let physicalAttempt = 0;
    let selectionFailureReason = null;

    // The wire field is `routePhase`: three unrelated enums (turn-progress
    // heartbeat, this policy narration, the attempt lifecycle) used to share the
    // key `phase`, so a reader could not tell which enum it had without the
    // message type. `phase` below is just this closure's local argument name.
    function publish(phase, candidate, details = {}) {
      const event = Object.freeze({
        type: 'provider_auto_route',
        version: 1,
        mode: 'auto',
        sessionId: session.id,
        turnId,
        protocol: candidate && candidate.protocol || selection.protocol,
        routePhase: phase,
        providerId: candidate && candidate.providerId || null,
        providerName: candidate && candidate.providerName || null,
        model: candidate && candidate.model || null,
        // The picked line's own tier: it differs from preferredTier when every
        // line of the preferred tier is exhausted or already attempted.
        tier: candidate && candidate.tier || null,
        trustDomain: candidate && candidate.trustDomain || null,
        fromTrustDomain: null,
        toTrustDomain: candidate && candidate.trustDomain || null,
        attemptNo: physicalAttempt,
        maxAttempts: selection.maxAttempts,
        preferredTier,
        routing: routingDecision,
        // Lane and price only exist for the pools that have them, so a legacy
        // pool's event keeps its exact shape.
        ...(selection.cliSwitch ? { cli: candidate && candidate.cli || turnCli } : {}),
        ...(priceTiered ? priceFields(candidate) : {}),
        ...details,
      });
      currentBySession.set(session.id, event);
      try { emit(session.id, event); } catch (_) {}
      logger.info?.('auto_provider_route', {
        sessionId: session.id, turnId, phase,
        providerId: event.providerId, fromProviderId: event.fromProviderId || null,
        trustDomain: event.trustDomain, fromTrustDomain: event.fromTrustDomain,
        toTrustDomain: event.toTrustDomain,
        reasonCode: event.reasonCode || null, attemptNo: physicalAttempt,
      });
      return event;
    }

    function select(reasonCode) {
      selectionFailureReason = null;
      if (physicalAttempt >= selection.maxAttempts) {
        selectionFailureReason = 'attempt_budget_exhausted';
        publish('exhausted', current, { reasonCode: selectionFailureReason });
        return null;
      }
      const picked = chooseCandidate({
        candidates,
        attempted,
        preferredTier,
        ladder: ladder.tiers,
        byPrice,
        pinned: pending ? { providerId: pending.providerId, model: pending.model || null } : null,
        stickyProviderId: selection.sticky ? stickyBySession.get(session.id) : null,
      });
      if (!picked.candidate) {
        selectionFailureReason = 'candidate_pool_exhausted';
        publish('exhausted', current, {
          reasonCode: selectionFailureReason,
          skipped: picked.skipped,
        });
        return null;
      }
      const previous = current;
      current = picked.candidate;
      if (pending) pendingBySession.delete(session.id);
      attempted.add(current.providerId);
      physicalAttempt += 1;
      publish(previous ? 'switched' : 'selected', current, {
        fromProviderId: previous && previous.providerId || null,
        fromProviderName: previous && previous.providerName || null,
        fromTrustDomain: previous && previous.trustDomain || null,
        toTrustDomain: current.trustDomain,
        reasonCode,
        skipped: picked.skipped,
      });
      return Object.freeze({
        providerId: current.providerId,
        model: current.model,
        reasonCode,
      });
    }

    function initial() {
      const result = select('auto_initial_selection');
      if (!result) {
        throw new AutoProviderError('Auto Provider has no eligible candidate', 'AUTO_PROVIDER_POOL_EXHAUSTED');
      }
      return result;
    }

    function terminalFailure(decision, reasonCode, attempt) {
      const terminalDecision = Object.freeze({
        ...decision,
        action: 'fail_fast',
        reason: reasonCode,
        delayMs: 0,
        retryAt: null,
      });
      return Object.freeze({
        invocationOptions: null,
        decision: terminalDecision,
        terminal: true,
        reasonCode,
        fromProviderName: candidates.find(item => item.providerId === attempt?.providerId)?.providerName
          || attempt?.providerId || current?.providerName || null,
        toProviderName: null,
      });
    }

    function failover(decision, attempt) {
      const safety = failoverSafety(decision, attempt);
      if (!safety.ok) {
        publish('blocked', current, { reasonCode: safety.reason });
        return null;
      }
      let backgroundActive = false;
      if (liveBackgroundGate) {
        try { backgroundActive = liveBackgroundGate(session.id) === true; }
        catch (_) { backgroundActive = true; }
      }
      if (backgroundActive) {
        publish('blocked', current, { reasonCode: 'background_tasks_active' });
        return terminalFailure(decision, 'auto_background_tasks_active', attempt);
      }
      const result = select(safety.reason);
      if (!result) {
        return terminalFailure(decision, `auto_${selectionFailureReason || 'provider_exhausted'}`, attempt);
      }
      const fromCandidate = candidates.find(item => item.providerId === attempt.providerId) || null;
      const retryDecision = Object.freeze({
        ...decision,
        action: 'retry',
        reason: 'provider_failover',
        delayMs: 0,
        retryAt: Number(now()),
        attempt: physicalAttempt - 1,
        providerFailover: Object.freeze({
          fromProviderId: attempt.providerId,
          toProviderId: result.providerId,
          fromTrustDomain: fromCandidate && fromCandidate.trustDomain || null,
          toTrustDomain: current.trustDomain,
          category: decision.error.category,
        }),
      });
      return Object.freeze({
        invocationOptions: result,
        decision: retryDecision,
        fromProviderName: fromCandidate && fromCandidate.providerName || attempt.providerId,
        toProviderName: current.providerName,
      });
    }

    // Unsafe replay boundaries cannot switch the physical route inside the
    // current logical turn. Reserve an eligible route for one fresh continuation
    // turn instead; the handoff coordinator owns durable injection and de-dup.
    // A cross-CLI pool also reserves a line on another lane when this lane has
    // nothing left — after an unsafe boundary, or after a safe failover ran the
    // lane dry — and the continuation turn switches lanes before it starts.
    function prepareHandoff(decision, attempt) {
      const safety = failoverSafety(decision, attempt);
      const unsafe = !safety.ok && UNSAFE_HANDOFF_REASONS.has(safety.reason);
      if (!unsafe && !(safety.ok && selection.cliSwitch)) return null;
      let backgroundActive = false;
      if (liveBackgroundGate) {
        try { backgroundActive = liveBackgroundGate(session.id) === true; }
        catch (_) { backgroundActive = true; }
      }
      if (backgroundActive) return null;
      const excluded = new Set(attempted);
      if (attempt?.providerId) excluded.add(attempt.providerId);
      const order = { attempted: excluded, preferredTier, ladder: ladder.tiers, byPrice };
      let picked = unsafe ? chooseCandidate({ candidates, ...order }) : { candidate: null, skipped: [] };
      if (!picked.candidate && selection.cliSwitch
          && (hopsBySession.get(session.id) || 0) < selection.maxAttempts) {
        // The same route on another lane shares its quota, so it stays excluded.
        picked = chooseCandidate({
          candidates: otherLanes.filter(candidate => isCliAvailable(candidate.cli)), ...order,
        });
      }
      if (!picked.candidate) return null;
      const reasonCode = unsafe ? safety.reason : 'lane_pool_exhausted';
      const reservation = Object.freeze({
        sessionId: session.id,
        originTurnId: turnId,
        fromProviderId: attempt?.providerId || current?.providerId || null,
        fromProviderName: candidates.find(item => item.providerId === attempt?.providerId)?.providerName
          || attempt?.providerId || current?.providerName || null,
        providerId: picked.candidate.providerId,
        providerName: picked.candidate.providerName,
        model: picked.candidate.model,
        reasonCode,
        ...(picked.candidate.cli !== turnCli ? { cli: picked.candidate.cli, fromCli: turnCli } : {}),
      });
      pendingBySession.set(session.id, reservation);
      publish('handoff_pending', picked.candidate, {
        fromProviderId: reservation.fromProviderId,
        fromProviderName: reservation.fromProviderName,
        fromTrustDomain: candidates.find(item => item.providerId === reservation.fromProviderId)?.trustDomain || null,
        toTrustDomain: picked.candidate.trustDomain,
        reasonCode,
        skipped: picked.skipped,
      });
      return reservation;
    }

    function recordSuccess(attempt) {
      const providerId = attempt && attempt.providerId || current && current.providerId;
      if (!providerId) return;
      if (selection.sticky) stickyBySession.set(session.id, providerId);
      hopsBySession.delete(session.id);
      publish('succeeded', current, { reasonCode: 'turn_succeeded' });
    }

    return Object.freeze({
      enabled: true, selection, routing: routingDecision,
      initial, failover, prepareHandoff, recordSuccess,
    });
  }

  function snapshot(sessionId) {
    const current = currentBySession.get(sessionId);
    return current ? Object.freeze({ ...current }) : null;
  }

  function clearSession(sessionId) {
    stickyBySession.delete(sessionId);
    currentBySession.delete(sessionId);
    selectionRefBySession.delete(sessionId);
    pendingBySession.delete(sessionId);
    hopsBySession.delete(sessionId);
    routing.clearSession(sessionId);
  }

  // Exposed for the chat admission path, which has the one async window before
  // the synchronous turn resolves its route (see auto-provider-routing.js). The
  // admission phase broadcasts its own progress frame, next to the wait it
  // explains.
  function prepareTurn(args) {
    return routing.prepareTurn(args);
  }

  const prepareAdmission = createRoutingAdmissionPhase({
    prepareTurn: routing.prepareTurn,
    broadcast: emit,
  });

  return Object.freeze({ beginTurn, clearSession, planTurn, prepareAdmission, prepareTurn, snapshot });
}

module.exports = {
  AutoProviderError,
  createAutoProviderRuntime,
};
