'use strict';

// Persisted Auto Provider contract. The virtual selection never becomes
// session.provider: every physical invocation still resolves to one concrete
// provider id before the spawn proof is issued.
//
// Every rule (the constants, the regular expressions, the error text and codes,
// the key order of each DTO) lives in native/core/src/auto_provider_config.rs.
// This file only:
//   * assembles the cross-module facts once at load (the Jev gateway table from
//     jev-client, the native-line namespaces from native-opencode/native-vendor)
//     and hands them to the core as data;
//   * asks the core for one frozen snapshot of its own constants;
//   * drives the provider-registry callbacks the core asks for, in the exact
//     order and count the old inline implementation used, by replaying the
//     core's deferred-probe protocol;
//   * restores JavaScript result shapes (frozen objects, Set constants, the
//     candidate object identity `primaryProviderCandidate` returns).
const { getNative } = require('../native/runtime');
const {
  CUSTOM_API_KEY_NAME,
  CUSTOM_GATEWAY,
  CUSTOM_MODEL,
  DEFAULT_GATEWAY,
  GATEWAY_NAMES,
  JEV_GATEWAYS,
  MAX_ENDPOINT_CHARS,
} = require('./jev-client');
const { NATIVE_OPENCODE_ID, NATIVE_OPENCODE_PREFIX } = require('./native-opencode');
const {
  MODEL_ID: NATIVE_VENDOR_MODEL_ID,
  NATIVE_VENDOR_ID,
  NATIVE_VENDOR_SUFFIX,
  VENDOR_NATIVE_CLIS,
} = require('./native-vendor');

const native = getNative();

// The facts the core must not restate. They are read from their owners here,
// once, and never re-derived on this side.
const FACTS = {
  gateways: GATEWAY_NAMES.map(name => ({
    name,
    endpoint: JEV_GATEWAYS[name].endpoint,
    model: JEV_GATEWAYS[name].model,
    apiKeyName: JEV_GATEWAYS[name].apiKeyName,
  })),
  defaultGateway: DEFAULT_GATEWAY,
  customGateway: CUSTOM_GATEWAY,
  customApiKeyName: CUSTOM_API_KEY_NAME,
  customModel: CUSTOM_MODEL,
  maxEndpointChars: MAX_ENDPOINT_CHARS,
  nativeOpenCodePrefix: NATIVE_OPENCODE_PREFIX,
  nativeOpenCodeIdPattern: NATIVE_OPENCODE_ID.source,
  nativeOpenCodeIdIgnoreCase: NATIVE_OPENCODE_ID.flags.includes('i'),
  nativeVendorSuffix: NATIVE_VENDOR_SUFFIX,
  vendorNativeClis: [...VENDOR_NATIVE_CLIS],
  nativeVendorIdPattern: NATIVE_VENDOR_ID.source,
  nativeVendorIdIgnoreCase: NATIVE_VENDOR_ID.flags.includes('i'),
  nativeVendorModelPattern: NATIVE_VENDOR_MODEL_ID.source,
  nativeVendorModelIgnoreCase: NATIVE_VENDOR_MODEL_ID.flags.includes('i'),
};

const SNAPSHOT = JSON.parse(native.autoProviderFacts(JSON.stringify(FACTS)));

const AUTO_CLIS = new Set(SNAPSHOT.autoClis);
const CLI_SWITCH_POLICIES = new Set(SNAPSHOT.cliSwitchPolicies);
const PROTOCOLS = new Set(SNAPSHOT.protocols);
const ROUTING_GATEWAYS = new Set(SNAPSHOT.routingGateways);

const CUSTOM_ROUTING_GATEWAY = SNAPSHOT.customRoutingGateway;
const DEFAULT_CUSTOM_ROUTING_API_KEY = SNAPSHOT.defaultCustomRoutingApiKey;
const DEFAULT_CUSTOM_ROUTING_MODEL = SNAPSHOT.defaultCustomRoutingModel;
const DEFAULT_ROUTING_API_KEY = SNAPSHOT.defaultRoutingApiKey;
const DEFAULT_ROUTING_GATEWAY = SNAPSHOT.defaultRoutingGateway;
const MAX_ATTEMPTS = SNAPSHOT.maxAttempts;
const MAX_CANDIDATES = SNAPSHOT.maxCandidates;
const MAX_ROUTING_ENDPOINT_CHARS = SNAPSHOT.maxRoutingEndpointChars;
const MAX_TIERS = SNAPSHOT.maxTiers;

const PROVIDER_FIELDS = ['id', 'protocol', 'apiFormat', 'isOfficial', 'appType', 'compatibleClis'];

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

// JSON cannot carry `undefined`, NaN, ±Infinity or BigInt. Property values the
// core must not see as present are omitted; array entries become null. The
// three non-finite numbers and BigInt are tagged so the core can apply
// JavaScript's own truthiness/`String`/`Number` rules to them.
function encode(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { __jsnum__: 'NaN' };
    if (value === Infinity) return { __jsnum__: 'Infinity' };
    if (value === -Infinity) return { __jsnum__: '-Infinity' };
    return value;
  }
  if (typeof value === 'bigint') return { __jsbigint__: value.toString() };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(item => encode(item));
  const out = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
    out[key] = encode(item);
  }
  return out;
}

function request(payload) {
  return JSON.stringify({ facts: FACTS, ...payload });
}

function projectProvider(item) {
  const out = {};
  if (item && typeof item === 'object') {
    for (const key of PROVIDER_FIELDS) {
      if (key in item) out[key] = encode(item[key]);
    }
  }
  return out;
}

// One catalog read, exactly as the old `catalogFor` did it: resolve the appType
// list (the core owns that rule), then ask `listProviders` for each type — or
// for the appType itself when the list is empty. The originals are kept so
// `providerSupportsCli` still receives the registry's own object.
function readCatalog(providers, cli) {
  const appType = providers.appTypeForCli(cli);
  const hasAppTypesForCli = typeof providers.appTypesForCli === 'function';
  const appTypes = hasAppTypesForCli ? providers.appTypesForCli(cli) : undefined;
  const plan = JSON.parse(native.catalogAppTypes(JSON.stringify({
    cli: encode(cli),
    appType: encode(appType),
    appTypes: encode(appTypes),
    hasAppTypesForCli,
  })));
  const list = plan.list.length
    ? plan.list.flatMap(type => providers.listProviders(type))
    : providers.listProviders(appType);
  const items = Array.isArray(list) ? list : [];
  return {
    appType,
    cli,
    items,
    originals: new Map(items.map(item => [String(item.id), item])),
  };
}

function answerProbe(probe, providers, catalogs) {
  if (probe.kind === 'catalog') {
    const read = readCatalog(providers, probe.cli);
    catalogs.set(probe.cli, read);
    return {
      catalog: {
        appType: encode(read.appType),
        cli: read.cli,
        providers: read.items.map(projectProvider),
      },
    };
  }
  if (probe.kind === 'supportsCli') {
    const read = catalogs.get(probe.cli);
    const id = probe.provider && probe.provider.id;
    const original = read ? read.originals.get(String(id)) : undefined;
    const provider = original === undefined ? probe.provider : original;
    return { value: encode(providers.providerSupportsCli(provider, probe.cli)) };
  }
  if (probe.kind === 'modelValid') {
    return {
      value: encode(providers.modelValidForProvider(probe.appType, probe.providerId, probe.model)),
    };
  }
  throw new Error(`unknown auto-provider probe: ${probe.kind}`);
}

function validateProviderSelection(input, options = {}) {
  const providers = options && options.providers;
  const flags = {
    usable: !!(providers && typeof providers.listProviders === 'function'
      && typeof providers.appTypeForCli === 'function'),
    hasProviderSupportsCli: !!(providers && typeof providers.providerSupportsCli === 'function'),
    hasModelValidForProvider: !!(providers && typeof providers.modelValidForProvider === 'function'),
  };
  const encodedInput = encode(input);
  const encodedOptions = encode(options);
  const answers = [];
  const catalogs = new Map();
  for (;;) {
    const reply = JSON.parse(native.validateProviderSelection(request({
      input: encodedInput,
      options: encodedOptions,
      providers: flags,
      answers,
    })));
    if (!reply.probe) return deepFreeze(reply.result);
    answers.push(answerProbe(reply.probe, providers, catalogs));
  }
}

// The appType list a catalog read should ask for. Kept for the callers that
// assemble a catalog by hand; the rule itself is the core's.
function catalogFor(options) {
  const providers = options && options.providers;
  const cli = String(options && options.cli || '');
  if (!providers || typeof providers.listProviders !== 'function'
      || typeof providers.appTypeForCli !== 'function') return null;
  const read = readCatalog(providers, cli);
  return {
    appType: read.appType,
    providers,
    cli,
    byId: new Map(read.items.map(item => [String(item.id), item])),
  };
}

function protocolOf(provider) {
  return JSON.parse(native.protocolOf(request({ provider: encode(provider) })));
}

function trustDomainOf(provider) {
  return JSON.parse(native.trustDomainOf(request({ provider: encode(provider) })));
}

function customEndpointError(raw) {
  return JSON.parse(native.customEndpointError(request({ endpoint: encode(raw) })));
}

function validateRoutingTarget(input = {}) {
  return deepFreeze(JSON.parse(native.validateRoutingTarget(request({ input: encode(input) }))));
}

function jevTarget(routing) {
  return deepFreeze(JSON.parse(native.jevTarget(request({ routing: encode(routing) }))));
}

function normalizeStoredProviderSelection(input) {
  const value = JSON.parse(native.normalizeStoredProviderSelection(request({ input: encode(input) })));
  return value == null ? null : deepFreeze(value);
}

function providerSelectionDto(input) {
  const value = JSON.parse(native.providerSelectionDto(request({ input: encode(input) })));
  if (!value) return null;
  return {
    version: 1,
    mode: 'auto',
    protocol: value.protocol,
    candidates: value.candidates.map(candidate => ({ ...candidate })),
    maxAttempts: value.maxAttempts,
    sticky: value.sticky,
    preferMaxQuota: value.preferMaxQuota !== false,
    allowCrossTrust: value.allowCrossTrust,
    ...(value.cliSwitch ? { cliSwitch: value.cliSwitch } : {}),
    ...(value.routing
      ? { routing: { ...value.routing, tiers: [...value.routing.tiers] } }
      : {}),
  };
}

// `cli` scopes a cross-CLI pool to the lane the session is on: the concrete
// fallback provider must be one that lane can actually run. The core returns
// the index; the identity of the candidate object is the caller's.
function primaryProviderCandidate(selection, cli = null) {
  const reply = JSON.parse(native.primaryProviderCandidate(
    request({ selection: encode(selection), cli: encode(cli) }),
  ));
  if (reply.index == null) return null;
  return selection.candidates[reply.index];
}

// Lanes a pool spans, in first-seen order; empty for a single-lane pool.
function selectionClis(selection) {
  return JSON.parse(native.selectionClis(request({ selection: encode(selection) })));
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
