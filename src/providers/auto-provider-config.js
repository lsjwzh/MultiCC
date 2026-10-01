'use strict';

// Persisted Auto Provider contract. The virtual selection never becomes
// session.provider: every physical invocation still resolves to one concrete
// provider id before the spawn proof is issued.

// The client owns the wire facts these come from, so they are read from it
// rather than restated here: the gateway table itself, its default gateway, the
// custom deployment's entry name and model id, and the endpoint length both
// layers cap.
const {
  CUSTOM_API_KEY_NAME,
  CUSTOM_GATEWAY,
  CUSTOM_MODEL,
  DEFAULT_GATEWAY,
  GATEWAY_NAMES,
  JEV_GATEWAYS,
  MAX_ENDPOINT_CHARS,
} = require('./jev-client');
const {
  NATIVE_OPENCODE_ID,
  nativeOpenCodeId,
} = require('./native-opencode');

const PROTOCOLS = new Set(['anthropic', 'openai_responses']);
const PROVIDER_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const MODEL_ID = /^[A-Za-z0-9._:/\[\]-]{1,100}$/;
// The evaluation model id of the OpenRouter gateway starts with `~` (community
// namespace), which the candidate model pattern above does not allow, so routing
// carries its own — a superset of it, and only for routing.model.
const ROUTING_MODEL_ID = /^[A-Za-z0-9._:/[\]~-]{1,100}$/;
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
// Which gateway the evaluation call goes to: three hosted ones (JEV_GATEWAYS in
// jev-client.js) plus `custom` for the pool's own deployment. An unrouted pool
// has no gateway at all, and an existing routed config has none either — that is
// the Vercel gateway, which is where it was always sent.
const DEFAULT_ROUTING_GATEWAY = DEFAULT_GATEWAY;
const CUSTOM_ROUTING_GATEWAY = CUSTOM_GATEWAY;
const ROUTING_GATEWAYS = new Set([...GATEWAY_NAMES, CUSTOM_ROUTING_GATEWAY]);
// Prefixed so that a config — which agents can write through the API — cannot
// name an unrelated vault entry (a GitHub token, say) and have it sent to an
// arbitrary URL. The presets only ever ship their key to their own fixed host,
// so their names stay free-form.
const CUSTOM_ROUTING_API_KEY_PREFIX = 'jev-';
const DEFAULT_ROUTING_API_KEY = JEV_GATEWAYS[DEFAULT_ROUTING_GATEWAY].apiKeyName;
const DEFAULT_CUSTOM_ROUTING_API_KEY = CUSTOM_API_KEY_NAME;
// A custom endpoint speaks the same evaluation contract as the hosted gateways,
// whose default model id is this. Requiring one would only produce a save error
// the user cannot act on, so a blank model resolves to it instead.
const DEFAULT_CUSTOM_ROUTING_MODEL = CUSTOM_MODEL;
const MAX_ROUTING_ENDPOINT_CHARS = MAX_ENDPOINT_CHARS;
// http is a plaintext Bearer request, so it is confined to the machine the
// server itself runs on — where there is no network to intercept.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const VAULT_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const DEFAULT_ROUTING_TIMEOUT_MS = 2_500;
// Cross-CLI pools: a candidate may name the CLI lane that serves it, and the
// session then switches lanes (with the usual handoff checkpoint) when the pool
// picks a line on another CLI. Only lanes whose provider is a user-selectable
// route are eligible — a providerless lane has nothing for the pool to pick.
const AUTO_CLIS = new Set(['claude', 'claude-exp', 'codex', 'codex-exp', 'opencode', 'zcode', 'kimi']);
// These lanes resolve the API dialect independently for each physical attempt.
const MULTI_PROTOCOL_CLIS = new Set(['opencode', 'zcode']);
// When a cross-CLI pool leaves the session's current lane:
//   failover — only when no line on the current CLI is usable (default; a lane
//              switch costs a handoff, so it is the last resort);
//   routing  — whenever the per-turn pick (difficulty tier, price) lives on
//              another CLI.
const CLI_SWITCH_POLICIES = new Set(['failover', 'routing']);
// How a routed pool's tiers are decided: `manual` is the hand-tagged ladder
// (candidate.tier + routing.tiers); `price` derives the ladder per turn from the
// shared price table (src/pricing/price-table.js), cheapest first.
const ROUTING_TIERINGS = new Set(['manual', 'price']);
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
  const cli = raw.cli == null || raw.cli === '' ? null : String(raw.cli).trim();
  if (cli != null && !AUTO_CLIS.has(cli)) {
    return fail(`candidate ${index + 1} has an unsupported cli`, 'invalid_provider_candidate');
  }
  const autoModel = raw.autoModel === true;
  // An auto-model line picks its model per turn from the provider's own list;
  // a pinned model next to it would be a second, contradicting answer.
  if (autoModel && model) {
    return fail(`candidate ${index + 1} cannot pin a model and pick one automatically`,
      'invalid_provider_candidate');
  }
  let trustDomain = null;
  let protocol = null;
  // OpenCode's own providers are named, not looked up: they are validated
  // structurally (the id and the `<id>/` model prefix) so a stored pool survives
  // a cold boot, without ever asking the live OpenCode model list. They are
  // protocol-agnostic, so they never take part in the protocol-mix check.
  const nativeId = nativeOpenCodeId(providerId);
  if (nativeId !== null) {
    if (!NATIVE_OPENCODE_ID.test(nativeId)) {
      return fail(`candidate ${index + 1} has an invalid OpenCode provider id`, 'invalid_provider_candidate');
    }
    const lane = cli || context.homeCli || null;
    if (lane !== 'opencode') {
      return fail(`candidate ${index + 1} names an OpenCode native provider, which is only usable on the opencode cli`,
        'invalid_provider_candidate');
    }
    if (model && !model.startsWith(`${nativeId}/`)) {
      return fail(`candidate ${index + 1} model must start with "${nativeId}/"`, 'invalid_provider_candidate');
    }
    const value = { providerId, model, priority, enabled };
    if (tier != null) value.tier = tier;
    if (cli != null) value.cli = cli;
    if (autoModel) value.autoModel = true;
    return Object.freeze({
      ok: true,
      value: Object.freeze(value),
      trustDomain: 'user-managed',
      protocol: null,
    });
  }
  const catalog = context.catalogFor ? context.catalogFor(cli) : context.catalog;
  if (catalog) {
    const provider = catalog.byId.get(providerId);
    if (!provider) return fail(`provider ${providerId} was not found`, 'provider_not_found');
    const supports = typeof catalog.providers.providerSupportsCli === 'function'
      ? catalog.providers.providerSupportsCli(provider, catalog.cli)
      : Array.isArray(provider.compatibleClis) && provider.compatibleClis.includes(catalog.cli);
    if (!supports) return fail(`provider ${providerId} does not support ${catalog.cli}`, 'provider_cli_mismatch');
    protocol = protocolOf(provider);
    // On multi-protocol lanes the pool protocol is descriptive: each provider
    // binding supplies its own wire dialect. Other lanes retain the constraint.
    if (!context.crossCli && !MULTI_PROTOCOL_CLIS.has(catalog.cli)
        && context.protocol && protocol !== context.protocol) {
      return fail(`provider ${providerId} does not use ${context.protocol}`, 'provider_protocol_mismatch');
    }
    if (model && typeof catalog.providers.modelValidForProvider === 'function'
        && !catalog.providers.modelValidForProvider(provider.appType || catalog.appType, providerId, model)) {
      return fail(`model ${model} is not available for provider ${providerId}`, 'provider_model_mismatch');
    }
    trustDomain = trustDomainOf(provider);
  }
  // Fields a legacy pool never set stay absent rather than null: the DTO is a
  // wire contract, and an untouched pool must keep emitting byte-identical JSON.
  const value = { providerId, model, priority, enabled };
  if (tier != null) value.tier = tier;
  if (cli != null) value.cli = cli;
  if (autoModel) value.autoModel = true;
  return Object.freeze({
    ok: true,
    value: Object.freeze(value),
    trustDomain,
    protocol,
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

// Where a custom endpoint may point. Returns the reason it is unusable, or null.
function customEndpointError(raw) {
  const endpoint = String(raw == null ? '' : raw).trim();
  if (!endpoint) return 'routing.endpoint is required for the custom gateway';
  if (endpoint.length > MAX_ROUTING_ENDPOINT_CHARS) {
    return `routing.endpoint must be at most ${MAX_ROUTING_ENDPOINT_CHARS} characters`;
  }
  let url;
  try {
    url = new URL(endpoint);
  } catch (_) {
    return 'routing.endpoint must be a URL';
  }
  // The whole URL is handed to fetch, so userinfo would travel as part of the
  // request line; a key belongs in the vault, not in an address people paste.
  if (url.username || url.password) return 'routing.endpoint must not carry credentials';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return null;
  return 'routing.endpoint must use https (http only for a loopback host)';
}

// The gateway half of a routing config: which host the call goes to, which model
// it asks for and which vault entry holds the key. Shared verbatim by
// validateRouting (the persisted config) and by the editor's "test" route, so
// the two can never disagree about what a gateway name means. The endpoint of a
// preset is *not* configurable — see the error below.
function validateRoutingTarget(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const gateway = source.gateway == null || source.gateway === ''
    ? DEFAULT_ROUTING_GATEWAY : String(source.gateway).trim().toLowerCase();
  if (!ROUTING_GATEWAYS.has(gateway)) {
    return fail(`unsupported routing gateway ${gateway}`, 'invalid_provider_routing');
  }
  const preset = JEV_GATEWAYS[gateway] || null;
  // Rejected rather than ignored: a caller that attached its own URL to a preset
  // would otherwise believe the key was being sent there. `custom` is the
  // supported way to point at another host, and it has its own key rule.
  if (preset && source.endpoint != null && String(source.endpoint).trim() !== '') {
    return fail('routing.endpoint is only allowed for the custom gateway',
      'invalid_provider_routing');
  }
  const endpoint = gateway === CUSTOM_GATEWAY ? String(source.endpoint || '').trim() : preset.endpoint;
  if (gateway === CUSTOM_GATEWAY) {
    const problem = customEndpointError(endpoint);
    if (problem) return fail(problem, 'invalid_provider_routing');
  }
  const apiKeyName = source.apiKeyName == null || String(source.apiKeyName).trim() === ''
    ? (preset ? preset.apiKeyName : DEFAULT_CUSTOM_ROUTING_API_KEY)
    : String(source.apiKeyName).trim();
  if (!VAULT_NAME_RE.test(apiKeyName)) {
    return fail('routing.apiKeyName must be a vault entry name', 'invalid_provider_routing');
  }
  if (gateway === CUSTOM_GATEWAY && !apiKeyName.startsWith(CUSTOM_ROUTING_API_KEY_PREFIX)) {
    return fail(`a custom gateway key must live in a ${CUSTOM_ROUTING_API_KEY_PREFIX}* vault entry`,
      'invalid_provider_routing');
  }
  const model = source.model == null || String(source.model).trim() === ''
    ? (preset ? preset.model : DEFAULT_CUSTOM_ROUTING_MODEL)
    : String(source.model).trim();
  if (!ROUTING_MODEL_ID.test(model)) {
    return fail('routing.model is invalid', 'invalid_provider_routing');
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      gateway,
      // Absent for a preset: its endpoint is the table's, and persisting a copy
      // would let a stale one survive a table update.
      ...(gateway === CUSTOM_GATEWAY ? { endpoint } : {}),
      model,
      apiKeyName,
    }),
  });
}

// The call target of a validated routing block. Callers that hold a routing
// config (the chat runtime) and callers that hold only a gateway name (the
// editor's test route) both come through here, so there is exactly one answer to
// "which URL, which model, which vault entry". Tolerant like the client's own
// override readers: an unusable field degrades to the gateway's default.
function jevTarget(routing) {
  const source = routing && typeof routing === 'object' ? routing : {};
  const named = String(source.gateway || '').trim().toLowerCase();
  const gateway = ROUTING_GATEWAYS.has(named) ? named : DEFAULT_ROUTING_GATEWAY;
  const preset = JEV_GATEWAYS[gateway] || null;
  const model = String(source.model || '').trim();
  const apiKeyName = String(source.apiKeyName || '').trim();
  const endpoint = String(source.endpoint || '').trim();
  return Object.freeze({
    gateway,
    endpoint: gateway === CUSTOM_GATEWAY
      ? (endpoint || null)
      : preset.endpoint,
    model: model || (preset ? preset.model : DEFAULT_CUSTOM_ROUTING_MODEL),
    apiKeyName: apiKeyName || (preset ? preset.apiKeyName : DEFAULT_CUSTOM_ROUTING_API_KEY),
  });
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
  const target = validateRoutingTarget(input);
  if (target.ok === false) return target;
  const { gateway, endpoint, model, apiKeyName } = target.value;
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
  const tiering = input.tiering == null || input.tiering === ''
    ? 'manual' : String(input.tiering).trim().toLowerCase();
  if (!ROUTING_TIERINGS.has(tiering)) {
    return fail('routing.tiering must be manual or price', 'invalid_provider_routing');
  }
  let ladder = { order: [] };
  if (tiering === 'price') {
    // The ladder is the price table's, recomputed per turn; a hand-tagged tier
    // next to it would be a second ladder nobody reads.
    if (candidates.some(candidate => candidate.tier)
        || (Array.isArray(input.tiers) && input.tiers.length)) {
      return fail('manual tiers are not used with price tiering', 'provider_routing_tier_mismatch');
    }
  } else {
    ladder = tierOrderFor(candidates, input.tiers);
    if (ladder.error) return ladder.error;
    // One tier cannot route: every request would get the same answer while the
    // UI claimed a difficulty decision had been made.
    if (ladder.order.length < 2) {
      return fail('routing requires at least two enabled candidate tiers',
        'provider_routing_requires_tiers');
    }
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
      // Always written, resolved: a routed pool that predates the gateway field
      // is a Vercel pool, and saying so explicitly is what lets the editor show
      // the right vault entry. `endpoint` travels only for a custom gateway.
      gateway,
      ...(endpoint ? { endpoint } : {}),
      model,
      apiKeyName,
      timeoutMs,
      onUnknown,
      // Only a price-tiered pool carries the key, so a manual pool's DTO stays
      // byte-identical to the one it had before tiering existed.
      ...(tiering === 'price' ? { tiering } : {}),
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
  // The protocol is derived from the pool when the client omits it: the wire
  // format of the first enabled line that has one. A pool that is entirely
  // protocol-agnostic — OpenCode's own providers — declares the neutral default
  // rather than an empty field. An explicit but unknown value is still refused,
  // because "some protocol I do not know" cannot be routed.
  const declaredProtocol = String(input.protocol || '').trim();
  if (declaredProtocol && !PROTOCOLS.has(declaredProtocol)) {
    return fail('invalid Auto Provider protocol', 'invalid_provider_protocol');
  }
  let derivedProtocol = null;
  if (!Array.isArray(input.candidates) || input.candidates.length < 2
      || input.candidates.length > MAX_CANDIDATES) {
    return fail(`Auto Provider requires 2-${MAX_CANDIDATES} candidates`, 'invalid_provider_candidates');
  }
  // Missing/false keeps the v1 fail-closed behavior. A true value is the
  // persisted user authorization for a mixed Official/user-managed pool.
  const allowCrossTrust = input.allowCrossTrust === true;
  // A pool is cross-CLI as soon as one candidate names its lane. The others then
  // belong to the session's current lane, written out so the stored pool reads
  // the same whichever lane the session happens to be on later.
  const crossCli = input.candidates.some(raw => raw && typeof raw === 'object'
    && raw.cli != null && raw.cli !== '');
  const homeCli = options && options.cli ? String(options.cli) : null;
  const catalogs = new Map();
  const laneCatalog = (cli) => {
    const key = cli || homeCli || '';
    if (!catalogs.has(key)) {
      catalogs.set(key, key ? catalogFor({ ...options, cli: key }) : catalogFor(options));
    }
    return catalogs.get(key);
  };
  const candidates = [];
  const ids = new Set();
  const trustDomains = new Set();
  const laneProtocols = new Map();
  const poolProtocols = new Set();
  for (let index = 0; index < input.candidates.length; index += 1) {
    let raw = input.candidates[index];
    if (crossCli && raw && typeof raw === 'object' && !Array.isArray(raw)
        && (raw.cli == null || raw.cli === '')) {
      if (!homeCli || !AUTO_CLIS.has(homeCli)) {
        return fail(`candidate ${index + 1} must name its cli in a cross-CLI pool`,
          'invalid_provider_candidate');
      }
      raw = { ...raw, cli: homeCli };
    }
    const result = validateCandidate(raw, index, {
      protocol: declaredProtocol || null, homeCli, crossCli,
      catalog: crossCli ? null : laneCatalog(null),
      catalogFor: crossCli ? laneCatalog : null,
    });
    if (!result.ok) return result;
    // The derived protocol is the first enabled line that has one, in pool order.
    if (!declaredProtocol && !derivedProtocol && result.value.enabled && result.protocol) {
      derivedProtocol = result.protocol;
    }
    // The same route may serve two lanes (an Anthropic-format key used by both
    // claude and opencode); within one lane it may appear once.
    const key = `${result.value.cli || ''}\n${result.value.providerId}`;
    if (ids.has(key)) {
      return fail(`provider ${result.value.providerId} appears more than once`, 'duplicate_provider_candidate');
    }
    ids.add(key);
    if (result.protocol) {
      poolProtocols.add(result.protocol);
      const lane = result.value.cli || homeCli;
      if (!MULTI_PROTOCOL_CLIS.has(lane)
          && laneProtocols.has(lane) && laneProtocols.get(lane) !== result.protocol) {
        return fail(`candidates on ${lane} mix protocols`, 'provider_protocol_mismatch');
      }
      laneProtocols.set(lane, result.protocol);
    }
    candidates.push(result.value);
    if (result.value.enabled && result.trustDomain) trustDomains.add(result.trustDomain);
  }
  const protocol = declaredProtocol || derivedProtocol || 'anthropic';
  if (poolProtocols.size && !poolProtocols.has(protocol)) {
    return fail(`no candidate uses ${protocol}`, 'provider_protocol_mismatch');
  }
  const cliSwitch = input.cliSwitch == null || input.cliSwitch === ''
    ? 'failover' : String(input.cliSwitch).trim().toLowerCase();
  if (!CLI_SWITCH_POLICIES.has(cliSwitch)) {
    return fail('cliSwitch must be failover or routing', 'invalid_provider_selection');
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
  // Picking a model per turn needs a routing decision to pick by — a manual
  // ladder tags the lines, a price ladder ranks them; either gives the turn a
  // tier to land on. Without routing the pick would silently mean "the first
  // model", which is not a decision at all.
  if (candidates.some(candidate => candidate.autoModel) && !routing) {
    return fail('automatic model selection requires routing',
      'provider_auto_model_requires_routing');
  }
  const value = {
    version: 1,
    mode: 'auto',
    protocol,
    candidates: Object.freeze(candidates),
    maxAttempts,
    sticky: input.sticky !== false,
    allowCrossTrust,
  };
  if (crossCli) value.cliSwitch = cliSwitch;
  if (routing) value.routing = routing.value;
  return Object.freeze({ ok: true, value: Object.freeze(value), error: null, code: null });
}

// `cli` scopes a cross-CLI pool to the lane the session is on: the concrete
// fallback provider must be one that lane can actually run.
function primaryProviderCandidate(selection, cli = null) {
  const candidates = selection && Array.isArray(selection.candidates) ? selection.candidates : [];
  let primary = null;
  for (const candidate of candidates) {
    if (!candidate || candidate.enabled === false) continue;
    if (cli && candidate.cli && candidate.cli !== cli) continue;
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
    ...(value.cliSwitch ? { cliSwitch: value.cliSwitch } : {}),
    ...(value.routing
      ? { routing: { ...value.routing, tiers: [...value.routing.tiers] } }
      : {}),
  };
}

// Lanes a pool spans, in first-seen order; empty for a single-lane pool.
function selectionClis(selection) {
  const out = [];
  for (const candidate of selection && Array.isArray(selection.candidates) ? selection.candidates : []) {
    if (candidate && candidate.cli && !out.includes(candidate.cli)) out.push(candidate.cli);
  }
  return out;
}

module.exports = {
  AUTO_CLIS,
  CLI_SWITCH_POLICIES,
  CUSTOM_ROUTING_GATEWAY,
  DEFAULT_CUSTOM_ROUTING_API_KEY,
  DEFAULT_CUSTOM_ROUTING_MODEL,
  DEFAULT_ROUTING_API_KEY,
  DEFAULT_ROUTING_GATEWAY,
  MAX_ATTEMPTS,
  MAX_CANDIDATES,
  MAX_ROUTING_ENDPOINT_CHARS,
  MAX_TIERS,
  PROTOCOLS,
  ROUTING_GATEWAYS,
  catalogFor,
  customEndpointError,
  jevTarget,
  normalizeStoredProviderSelection,
  primaryProviderCandidate,
  protocolOf,
  providerSelectionDto,
  selectionClis,
  trustDomainOf,
  validateProviderSelection,
  validateRoutingTarget,
};
