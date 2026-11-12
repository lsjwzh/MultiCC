'use strict';

// Auto Provider turn runtime.
//
// The decisions and the per-session route state live in
// `native/core/src/auto_provider_runtime.rs`. This file keeps only the host
// wiring: assembling the candidate pool (providers catalog, OpenCode/vendor
// synthetic lines, limit cache, quota guard, price table), the clocks, the
// `emit`/`logger` sinks, the `lastGoodRoute` and lane-availability lookups,
// and the difficulty-routing store. Every native answer is an envelope
// `{ value, undefined, error, effects }`: the effects are replayed here in the
// order the old closure produced them, so the wire narration stays identical.
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
const {
  VENDOR_NATIVE_SET,
  syntheticVendorProvider,
} = require('../providers/native-vendor');
const { peekOpenCodeModels } = require('../routes/opencode-models');
const { limitState } = require('./auto-provider-policy');
const { createAutoProviderRouting } = require('./auto-provider-routing');
const { expandCandidates, modelChoices, priceLadder } = require('./auto-provider-pricing');
const { createRoutingAdmissionPhase } = require('./admission-progress');
const { STALE_MS_DEFAULT } = require('../quota/provider-limit-cache');
const { selectionKey } = require('./auto-provider-selection-key');
const { getNative } = require('../native/runtime');

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
  // Hard account protection (src/quota/quota-guard), distinct from the steering
  // hint inside chooseCandidate: a guarded candidate is withdrawn from the pool
  // entirely, sticky or not.
  const quotaGuard = options.quotaGuard && typeof options.quotaGuard.check === 'function'
    ? options.quotaGuard : null;
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
  const hasCliProbe = typeof options.isCliAvailable === 'function';
  // (selectionKey, sessionId) => the line another session of this same pool
  // last finished a turn on, or null. The route notes emitter owns those
  // records, so it carries the lookup too.
  const lastGoodRoute = [options.lastGoodRoute, options.emit && options.emit.lastGoodRoute]
    .find(fn => typeof fn === 'function') || null;
  // The shared price table is only touched by a pool that prices its lines.
  let priceTable = options.priceTable;
  function pricing() {
    if (priceTable === undefined) {
      try { priceTable = require('../pricing/price-table').sharedPriceTable(); }
      catch (_) { priceTable = null; }
    }
    return priceTable;
  }
  // Difficulty routing owns its own store; the runtime is the single owner of
  // both the pool and the tier verdict.
  const routing = options.routing || createAutoProviderRouting({
    logger,
    fetchImpl: options.fetchImpl,
    resolveApiKey: options.resolveApiKey,
    ttlMs: options.routingTtlMs,
    resolveLadder: ({ session, selection }) => catalogCandidates(session, selection).ladder.tiers,
  });

  // The route state and turn closures live in Rust; one instance per runtime,
  // exactly like the closure this file used to hold.
  const state = new (getNative().RustAutoProviderRuntime)();

  function native(method, ...args) {
    const answer = state[method](...args);
    return answer == null ? null : JSON.parse(answer);
  }

  // Replay the native effects and unwrap the envelope. `emit` is wrapped (the
  // old code swallowed a throwing emit); `logger` is not (it never was).
  function apply(envelope) {
    for (const effect of envelope.effects) {
      if (effect.kind === 'emit') {
        try { emit(effect.sessionId, effect.event); } catch (_) {}
      } else if (effect.kind === 'info') {
        logger.info?.(effect.name, effect.fields);
      }
    }
    if (envelope.error) {
      throw new AutoProviderError(envelope.error.message, envelope.error.code);
    }
    return envelope.undefined ? undefined : envelope.value;
  }

  function call(method, ...args) {
    return apply(native(method, ...args));
  }

  function backgroundActive(sessionId) {
    if (!liveBackgroundGate) return false;
    try { return liveBackgroundGate(sessionId) === true; }
    catch (_) { return true; }
  }

  // `isCliAvailable` for every lane this pool could name. The kernel only asks
  // about lanes it would have asked about; `null` means "the default probe",
  // which answers true for every lane.
  function availabilityMap(candidates, home) {
    if (!hasCliProbe) return null;
    const lanes = new Set([home]);
    for (const candidate of candidates) lanes.add(candidate.cli || home);
    const map = {};
    for (const lane of lanes) map[lane] = Boolean(isCliAvailable(lane));
    return map;
  }

  // The `<id>/<model>` wire ids OpenCode's own providers serve, read straight
  // from the 1-hour model cache the /api/opencode/models route keeps.
  function nativeModelOptions(id) {
    return (peekOpenCodeModels() || [])
      .filter(entry => entry && entry.provider === id && entry.model)
      .map(entry => `${entry.provider}/${entry.model}`);
  }

  // `nativeIds` are the OpenCode-native ids this pool names on the lane.
  function laneCatalog(cli, nativeIds = null) {
    if (VENDOR_NATIVE_SET.has(cli) && cli !== 'dsh' && cli !== 'grok') {
      const line = syntheticVendorProvider(cli);
      return new Map([[line.id, line]]);
    }
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
    if (VENDOR_NATIVE_SET.has(cli)) {
      const line = syntheticVendorProvider(cli);
      byId.set(line.id, line);
    }
    return byId;
  }

  // Every line of the pool, on every lane, with its limit state and — for a
  // price-tiered pool — its price and this turn's price tier.
  function catalogCandidates(session, selection) {
    const home = session.cli || 'claude';
    const lanes = new Map();
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
      // The model this candidate would actually request: a model-scoped park
      // only binds that model, so the candidate's own model must decide.
      const model = candidate.model || provider && provider.model || null;
      const limit = limitState(entry, { now: Number(now()), staleAfterMs, model });
      let guard = null;
      if (quotaGuard && provider) {
        try { guard = quotaGuard.check({ appType: provider.appType, providerId: provider.id }); }
        catch (_) { guard = null; }
      }
      const guarded = !!(guard && guard.blocked);
      return Object.freeze({
        ...candidate,
        index,
        provider,
        providerName: provider && provider.name || candidate.providerId,
        protocol: protocolOf(provider),
        trustDomain: trustDomainOf(provider),
        model,
        limitState: guarded ? 'exhausted' : limit.state,
        limitReason: guarded ? `quota_guard_${guard.kind}` : limit.reason,
        usedPercent: limit.usedPercent == null ? null : limit.usedPercent,
        cli,
      });
    });
    const priced = selection.routing && selection.routing.tiering === 'price';
    if (!priced) {
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

  // A cloned policy is still the same pool. A changed policy starts afresh;
  // after a process restart, restore a matching route. The reset itself lives
  // in Rust; this side supplies the two host facts it may need (`lastGoodRoute`
  // and the lane's model choices).
  function syncSelection(session, rawSelection, selection) {
    const sessionId = session.id;
    const key = selectionKey(rawSelection);
    const last = session.autoProviderLastRoute;
    const hasKey = last ? Object.prototype.hasOwnProperty.call(last, 'selectionKey') : false;
    const cli = session.cli || 'claude';
    // `syncPrepare` answers a bare `{ action }` (it never narrates), unlike the
    // envelope-returning steps below.
    const step = native('syncPrepare', {
      sessionId,
      key,
      cli,
      selection,
      lastRoute: last ?? null,
      lastRouteHasSelectionKey: hasKey,
    });
    if (!step || step.action === 'same' || step.action === 'none') return;
    if (step.action === 'seed') {
      if (!step.want || !lastGoodRoute) {
        call('syncFinishSeed', { sessionId, cli, selection, seed: null });
        return;
      }
      let seed = null;
      try { seed = lastGoodRoute(key, session.id); } catch (_) { seed = null; }
      call('syncFinishSeed', { sessionId, cli, selection, seed });
      return;
    }
    if (step.action === 'legacy') {
      const remembered = step.candidate || {};
      const nativeId = cli === 'opencode' ? nativeOpenCodeId(remembered.providerId) : null;
      const provider = laneCatalog(cli, nativeId === null ? null : new Set([nativeId]))
        .get(remembered.providerId);
      if (!provider) {
        call('syncFinishLegacy', { sessionId, found: false });
        return;
      }
      const model = remembered.model || provider.model || null;
      const choices = remembered.autoModel ? modelChoices(provider) : [];
      call('syncFinishLegacy', {
        sessionId,
        found: true,
        providerId: remembered.providerId,
        model,
        choices,
        lastModel: last && last.model != null ? last.model : null,
      });
    }
  }

  // Before a turn starts, decide whether it should run on another CLI lane.
  // Returns null to stay, or the lane (and the line reserved on it) to switch
  // to; the reservation is what beginTurn then picks on the new lane.
  function planTurn({ session, text, turnOptions = {} } = {}) {
    const rawSelection = session && session.providerSelection;
    if (!rawSelection || rawSelection.mode !== 'auto') return null;
    const cli = session.cli || 'claude';
    const validated = validateProviderSelection(rawSelection, { cli, providers });
    if (!validated.ok || !validated.value.cliSwitch) return null;
    const selection = validated.value;
    syncSelection(session, rawSelection, selection);
    const { candidates, ladder } = catalogCandidates(session, selection);
    const backgroundNotification = !!(turnOptions.bgTaskIds?.length || turnOptions.bgToolUseIds?.length);
    // A difficulty router owns the lane choice itself. A background
    // notification is not a user message: it must not consume the verdict.
    const decision = selection.routing && !backgroundNotification ? routing.resolveTier({
      selection,
      verdict: routing.consume({ sessionId: session.id, text }),
      tiers: ladder.tiers || undefined,
    }) : null;
    return call('planTurn', {
      sessionId: session.id,
      cli,
      selection,
      candidates,
      ladder: ladder.tiers,
      byPrice: ladder.byPrice === true || !!ladder.tiers,
      priceTiered: Array.isArray(ladder.tiers) && ladder.tiers.length > 0,
      routingDecision: decision,
      originContinue: !!turnOptions.originContinue,
      directUserInput: !!turnOptions.directUserInput,
      // Whether a background notification may leave its lane is decided in
      // Rust (plan_turn): only a sibling adapter, only when this lane is empty.
      backgroundNotification,
      availability: availabilityMap(candidates, cli),
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
    const selection = validated.value;
    syncSelection(session, rawSelection, selection);
    const turnCli = session.cli || 'claude';
    const { candidates, ladder } = catalogCandidates(session, selection);
    // Difficulty routing: one verdict per USER MESSAGE, pinned for the whole
    // turn — failover included.
    const routingDecision = selection.routing ? routing.resolveTier({
      selection,
      verdict: routing.consume({ sessionId: session.id, text: promptText }),
      tiers: ladder.tiers || undefined,
    }) : null;
    const byPrice = ladder.byPrice === true || !!ladder.tiers;
    const priceTiered = Array.isArray(ladder.tiers) && ladder.tiers.length > 0;
    const started = call('beginTurn', {
      sessionId: session.id,
      turnId,
      cli: turnCli,
      selection,
      candidates,
      ladder: ladder.tiers,
      byPrice,
      priceTiered,
      routingDecision,
    });
    const handle = started.handle;

    function initial() {
      return call('turnInitial', handle);
    }
    function failover(decision, attempt) {
      return call('turnFailover', {
        handle,
        decision: decision ?? null,
        attempt: attempt ?? null,
        now: Number(now()),
        backgroundActive: backgroundActive(session.id),
      });
    }
    function prepareHandoff(decision, attempt) {
      return call('turnPrepareHandoff', {
        handle,
        decision: decision ?? null,
        attempt: attempt ?? null,
        backgroundActive: backgroundActive(session.id),
        // Re-probed now, like the old closure did at handoff time: a lane that
        // was installed when the turn started may be gone by the time a
        // continuation needs it.
        availability: availabilityMap(candidates, turnCli),
      });
    }
    function recordSuccess(attempt) {
      call('turnRecordSuccess', { handle, attempt: attempt ?? null });
    }

    return Object.freeze({
      enabled: true, selection, routing: routingDecision,
      initial, failover, prepareHandoff, recordSuccess,
    });
  }

  function pendingCliSwitch(sessionId, cli) {
    const pending = native('pendingCliSwitch', sessionId, cli || 'claude');
    return pending ? Object.freeze(pending) : null;
  }

  function snapshot(sessionId) {
    const current = native('snapshot', sessionId);
    return current ? Object.freeze({ ...current }) : null;
  }

  // Earliest epoch-ms at which THIS session's Auto pool could accept a turn
  // again, or null when some candidate is usable now / no reset is known.
  // Read-only: the decision lives in `auto_provider_runtime.rs`; this side only
  // has the limit cache and hands each line's summary across.
  function retryNotBefore(session) {
    const rawSelection = session && session.providerSelection;
    if (!rawSelection || rawSelection.mode !== 'auto') return null;
    let validated;
    try {
      validated = validateProviderSelection(rawSelection, {
        cli: session.cli || 'claude', providers,
      });
    } catch (_) {
      return null;
    }
    if (!validated.ok) return null;
    const cli = session.cli || 'claude';
    const pool = catalogCandidates(session, validated.value);
    const candidates = pool.candidates.map(candidate => {
      const provider = candidate.provider;
      let entry = null;
      if (limitCache && provider) {
        try { entry = limitCache.get(provider.appType, provider.id); } catch (_) { entry = null; }
      }
      return {
        cli: candidate.cli,
        enabled: candidate.enabled,
        limitState: candidate.limitState,
        summary: entry && entry.summary ? entry.summary : null,
      };
    });
    const answer = JSON.parse(getNative().autoProviderRetryNotBefore({
      cli, now: Number(now()), candidates,
    }));
    return answer == null ? null : answer;
  }

  function clearSession(sessionId) {
    state.clearSession(sessionId);
    routing.clearSession(sessionId);
  }

  // Exposed for the chat admission path, which has the one async window before
  // the synchronous turn resolves its route.
  function prepareTurn(args) {
    return routing.prepareTurn(args);
  }

  const prepareAdmission = createRoutingAdmissionPhase({
    prepareTurn: routing.prepareTurn,
    broadcast: emit,
  });

  return Object.freeze({ beginTurn, clearSession, pendingCliSwitch, planTurn, prepareAdmission, prepareTurn, retryNotBefore, snapshot });
}

module.exports = {
  AutoProviderError,
  createAutoProviderRuntime,
};
