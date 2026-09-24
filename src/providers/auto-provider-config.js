'use strict';

// Persisted Auto Provider contract. The virtual selection never becomes
// session.provider: every physical invocation still resolves to one concrete
// provider id before the spawn proof is issued.

const PROTOCOLS = new Set(['anthropic', 'openai_responses']);
const PROVIDER_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const MODEL_ID = /^[A-Za-z0-9._:/\[\]-]{1,100}$/;
const MAX_CANDIDATES = 12;
const MAX_ATTEMPTS = 4;
// Difficulty routing (Jev): a candidate may declare which tier of the pool it
// serves, and the selection may declare how the tier is decided per request.
// `tier` is meaningless without `routing`, and `routing` is meaningless without
// at least two distinct tiers in the pool — both are rejected rather than
// silently ignored, because a pool that thinks it routes but does not is worse
// than one that never claimed to.
const TIER_KEY = /^[A-Za-z0-9_-]{1,24}$/;
const MAX_TIERS = 6;
const ROUTING_PROVIDERS = new Set(['jev']);
const ROUTING_ON_UNKNOWN = new Set(['strong', 'weak', 'priority']);
// The escalation signals a pool may tune. Kept here rather than derived from the
// client so a knob that stops being read fails validation (see validateRouting).
const ROUTING_ESCALATION_KEYS = new Set(['minConfidence', 'minTierProbability']);
const DEFAULT_ROUTING_API_KEY = 'vercel-api-key';
const DEFAULT_ROUTING_TIMEOUT_MS = 2_500;
const MIN_ROUTING_TIMEOUT_MS = 250;
const MAX_ROUTING_TIMEOUT_MS = 10_000;

function fail(error, code = 'invalid_provider_selection') {
  return Object.freeze({ ok: false, value: null, error, code });
}

function protocolOf(provider) {
  // 'openai_chat' is a retired format value; persisted auto-provider configs
  // that still name it keep matching openai_responses providers.
  const raw = provider && (provider.protocol || provider.apiFormat);
  const value = raw === 'openai_chat' ? 'openai_responses' : raw;
  return PROTOCOLS.has(value) ? value : null;
}

function trustDomainOf(provider) {
  // Official login/subscription routes and user-managed API routes are separate
  // trust domains. Different user-managed vendors may fail over between one
  // another because the user explicitly placed them in the same candidate pool.
  return provider && provider.isOfficial ? 'official' : 'user-managed';
}

function catalogFor(options) {
  const providers = options && options.providers;
  const cli = String(options && options.cli || '');
  if (!providers || typeof providers.listProviders !== 'function'
      || typeof providers.appTypeForCli !== 'function') return null;
  const appType = providers.appTypeForCli(cli);
  const resolvedAppTypes = typeof providers.appTypesForCli === 'function'
    ? providers.appTypesForCli(cli)
    : (cli === 'opencode' || cli === 'zcode' ? ['claude', 'codex'] : (appType ? [appType] : []));
  const appTypes = Array.isArray(resolvedAppTypes) ? [...new Set(resolvedAppTypes)] : [];
  const list = appTypes.length
    ? appTypes.flatMap(type => providers.listProviders(type))
    : providers.listProviders(appType);
  return {
    appType,
    providers,
    cli,
    byId: new Map((Array.isArray(list) ? list : []).map(item => [String(item.id), item])),
  };
}

function validateCandidate(raw, index, context) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(`candidate ${index + 1} must be an object`, 'invalid_provider_candidate');
  }
  const providerId = String(raw.providerId || '').trim();
  if (!PROVIDER_ID.test(providerId) || /^auto(?::|$)/i.test(providerId)) {
    return fail(`candidate ${index + 1} has an invalid providerId`, 'invalid_provider_candidate');
  }
  const model = raw.model == null ? null : String(raw.model).trim() || null;
  if (model && !MODEL_ID.test(model)) {
    return fail(`candidate ${index + 1} has an invalid model`, 'invalid_provider_candidate');
  }
  const priority = raw.priority == null ? index + 1 : Number(raw.priority);
  if (!Number.isSafeInteger(priority) || priority < 1 || priority > 100) {
    return fail(`candidate ${index + 1} priority must be an integer from 1 to 100`, 'invalid_provider_candidate');
  }
  const tier = raw.tier == null || raw.tier === '' ? null : String(raw.tier).trim();
  if (tier != null && !TIER_KEY.test(tier)) {
    return fail(`candidate ${index + 1} has an invalid tier`, 'invalid_provider_candidate');
  }
  const enabled = raw.enabled !== false;
  let trustDomain = null;
  if (context.catalog) {
    const provider = context.catalog.byId.get(providerId);
    if (!provider) return fail(`provider ${providerId} was not found`, 'provider_not_found');
    const supports = typeof context.catalog.providers.providerSupportsCli === 'function'
      ? context.catalog.providers.providerSupportsCli(provider, context.catalog.cli)
      : Array.isArray(provider.compatibleClis) && provider.compatibleClis.includes(context.catalog.cli);
    if (!supports) return fail(`provider ${providerId} does not support ${context.catalog.cli}`, 'provider_cli_mismatch');
    if (protocolOf(provider) !== context.protocol) {
      return fail(`provider ${providerId} does not use ${context.protocol}`, 'provider_protocol_mismatch');
    }
    if (model && typeof context.catalog.providers.modelValidForProvider === 'function'
        && !context.catalog.providers.modelValidForProvider(provider.appType || context.catalog.appType, providerId, model)) {
      return fail(`model ${model} is not available for provider ${providerId}`, 'provider_model_mismatch');
    }
    trustDomain = trustDomainOf(provider);
  }
  // Fields a legacy pool never set stay absent rather than null: the DTO is a
  // wire contract, and an untouched pool must keep emitting byte-identical JSON.
  const value = { providerId, model, priority, enabled };
  if (tier != null) value.tier = tier;
  return Object.freeze({
    ok: true,
    value: Object.freeze(value),
    trustDomain,
  });
}

// Tier ladder, weakest first. Derived from the enabled candidates' priorities
// unless the caller states the order explicitly — a pool whose priority order is
// not its capability order must say so, or the escalation steps up the wrong
// ladder.
function tierOrderFor(candidates, declared) {
  const derived = [];
  for (const candidate of [...candidates].sort((left, right) => left.priority - right.priority)) {
    if (candidate.enabled && candidate.tier && !derived.includes(candidate.tier)) {
      derived.push(candidate.tier);
    }
  }
  const present = new Set(derived);
  if (!Array.isArray(declared)) return { order: derived, present, declared: false };
  const order = [];
  for (const raw of declared) {
    const key = String(raw == null ? '' : raw).trim();
    if (!TIER_KEY.test(key)) {
      return { error: fail('routing.tiers must be tier keys', 'invalid_provider_routing') };
    }
    if (!present.has(key)) {
      return { error: fail(`routing tier ${key} is not used by any enabled candidate`, 'provider_routing_tier_mismatch') };
    }
    if (order.includes(key)) {
      return { error: fail(`routing tier ${key} appears more than once`, 'invalid_provider_routing') };
    }
    order.push(key);
  }
  if (order.length !== derived.length) {
    return {
      error: fail('routing.tiers must list every enabled candidate tier',
        'provider_routing_tier_mismatch'),
    };
  }
  return { order, present, declared: true };
}

function routingRatio(value, fallback, label) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    return fail(`routing.${label} must be between 0 and 1`, 'invalid_provider_routing');
  }
  return number;
}

function validateRouting(input, candidates) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    return fail('providerSelection.routing must be an object', 'invalid_provider_routing');
  }
  if (input.version != null && input.version !== 1) {
    return fail('unsupported providerSelection.routing version', 'invalid_provider_routing');
  }
  const provider = String(input.provider || 'jev').trim().toLowerCase();
  if (!ROUTING_PROVIDERS.has(provider)) {
    return fail(`unsupported routing provider ${provider}`, 'invalid_provider_routing');
  }
  const model = input.model == null ? null : String(input.model).trim() || null;
  if (model && !MODEL_ID.test(model)) {
    return fail('routing.model is invalid', 'invalid_provider_routing');
  }
  const apiKeyName = input.apiKeyName == null
    ? DEFAULT_ROUTING_API_KEY : String(input.apiKeyName).trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(apiKeyName)) {
    return fail('routing.apiKeyName must be a vault entry name', 'invalid_provider_routing');
  }
  const timeoutMs = input.timeoutMs == null
    ? DEFAULT_ROUTING_TIMEOUT_MS : Number(input.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_ROUTING_TIMEOUT_MS
      || timeoutMs > MAX_ROUTING_TIMEOUT_MS) {
    return fail(`routing.timeoutMs must be ${MIN_ROUTING_TIMEOUT_MS}-${MAX_ROUTING_TIMEOUT_MS}`,
      'invalid_provider_routing');
  }
  const onUnknown = input.onUnknown == null ? 'strong' : String(input.onUnknown).trim().toLowerCase();
  if (!ROUTING_ON_UNKNOWN.has(onUnknown)) {
    return fail('routing.onUnknown must be strong, weak or priority', 'invalid_provider_routing');
  }
  const ladder = tierOrderFor(candidates, input.tiers);
  if (ladder.error) return ladder.error;
  // One tier cannot route: every request would get the same answer while the UI
  // claimed a difficulty decision had been made.
  if (ladder.order.length < 2) {
    return fail('routing requires at least two enabled candidate tiers',
      'provider_routing_requires_tiers');
  }
  const escalationInput = input.escalation && typeof input.escalation === 'object'
    && !Array.isArray(input.escalation) ? input.escalation : {};
  const escalation = {};
  for (const label of Object.keys(escalationInput)) {
    // A knob the router no longer reads must fail loudly, not be ignored: a pool
    // that still asks for a removed signal would otherwise route as if it were
    // set. `planningProbability` is the first such knob (see jev-client.js).
    if (!ROUTING_ESCALATION_KEYS.has(label)) {
      return fail(`routing.escalation.${label} is not a supported signal`,
        'invalid_provider_routing');
    }
    const value = routingRatio(escalationInput[label], undefined, label);
    if (value && value.ok === false) return value;
    if (value !== undefined) escalation[label] = value;
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      version: 1,
      provider,
      model,
      apiKeyName,
      timeoutMs,
      onUnknown,
      tiers: Object.freeze([...ladder.order]),
      escalation: Object.freeze(escalation),
    }),
  });
}

function validateProviderSelection(input, options = {}) {
  if (input == null || input === '' || (input && input.mode === 'manual')) {
    return Object.freeze({ ok: true, value: null, error: null, code: null });
  }
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.mode !== 'auto') {
    return fail('providerSelection must be null/manual or an Auto Provider object');
  }
  if (input.version != null && input.version !== 1) return fail('unsupported providerSelection version');
  const protocol = String(input.protocol || '').trim();
  if (!PROTOCOLS.has(protocol)) return fail('invalid Auto Provider protocol', 'invalid_provider_protocol');
  if (!Array.isArray(input.candidates) || input.candidates.length < 2
      || input.candidates.length > MAX_CANDIDATES) {
    return fail(`Auto Provider requires 2-${MAX_CANDIDATES} candidates`, 'invalid_provider_candidates');
  }
  // Missing/false keeps the v1 fail-closed behavior. A true value is the
  // persisted user authorization for a mixed Official/user-managed pool.
  const allowCrossTrust = input.allowCrossTrust === true;
  const catalog = catalogFor(options);
  const candidates = [];
  const ids = new Set();
  const trustDomains = new Set();
  for (let index = 0; index < input.candidates.length; index += 1) {
    const result = validateCandidate(input.candidates[index], index, { protocol, catalog });
    if (!result.ok) return result;
    if (ids.has(result.value.providerId)) {
      return fail(`provider ${result.value.providerId} appears more than once`, 'duplicate_provider_candidate');
    }
    ids.add(result.value.providerId);
    candidates.push(result.value);
    if (result.value.enabled && result.trustDomain) trustDomains.add(result.trustDomain);
  }
  const enabledCount = candidates.filter(candidate => candidate.enabled).length;
  if (enabledCount < 2) return fail('Auto Provider requires at least two enabled candidates', 'insufficient_provider_candidates');
  if (trustDomains.size > 1 && !allowCrossTrust) {
    return fail('Auto Provider candidates cross trust domains', 'provider_trust_mismatch');
  }
  const maxAttempts = input.maxAttempts == null ? Math.min(3, enabledCount) : Number(input.maxAttempts);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 2
      || maxAttempts > Math.min(MAX_ATTEMPTS, enabledCount)) {
    return fail(`maxAttempts must be between 2 and ${Math.min(MAX_ATTEMPTS, enabledCount)}`, 'invalid_provider_attempt_budget');
  }
  const routing = validateRouting(input.routing, candidates);
  if (routing && routing.ok === false) return routing;
  const value = {
    version: 1,
    mode: 'auto',
    protocol,
    candidates: Object.freeze(candidates),
    maxAttempts,
    sticky: input.sticky !== false,
    allowCrossTrust,
  };
  if (routing) value.routing = routing.value;
  return Object.freeze({ ok: true, value: Object.freeze(value), error: null, code: null });
}

function primaryProviderCandidate(selection) {
  const candidates = selection && Array.isArray(selection.candidates) ? selection.candidates : [];
  let primary = null;
  for (const candidate of candidates) {
    if (!candidate || candidate.enabled === false) continue;
    if (!primary || candidate.priority < primary.priority) primary = candidate;
  }
  return primary;
}

function normalizeStoredProviderSelection(input) {
  const result = validateProviderSelection(input);
  return result.ok ? result.value : null;
}

function providerSelectionDto(input) {
  const value = normalizeStoredProviderSelection(input);
  if (!value) return null;
  return {
    version: 1,
    mode: 'auto',
    protocol: value.protocol,
    candidates: value.candidates.map(candidate => ({ ...candidate })),
    maxAttempts: value.maxAttempts,
    sticky: value.sticky,
    allowCrossTrust: value.allowCrossTrust,
    ...(value.routing
      ? { routing: { ...value.routing, tiers: [...value.routing.tiers] } }
      : {}),
  };
}

module.exports = {
  DEFAULT_ROUTING_API_KEY,
  MAX_ATTEMPTS,
  MAX_CANDIDATES,
  MAX_TIERS,
  PROTOCOLS,
  normalizeStoredProviderSelection,
  primaryProviderCandidate,
  protocolOf,
  providerSelectionDto,
  trustDomainOf,
  validateProviderSelection,
};
