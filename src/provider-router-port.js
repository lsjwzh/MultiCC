'use strict';

const crypto = require('crypto');
const path = require('path');
const {
  assertProviderBinding,
  createProviderBinding,
  toLegacyProviderView,
} = require('./provider-binding');
const { mountCodexOfficialRelay } = require('./codex-official-relay');
const { createUsageObserved } = require('./usage-observed');

const PORT_API_VERSION = '1.0.0';
const PORT_MODES = Object.freeze(['legacy', 'shadow', 'cpr']);
const REQUIRED_CAPABILITIES = Object.freeze({
  providerStore: 1,
  spawnEnvironment: 1,
  protocolProxy: 1,
  agentRouting: 1,
  normalizedUsage: 1,
});
const REQUIRED_ROUTER_METHODS = Object.freeze([
  'resolveSpawnEnv',
  'buildChildEnv',
  'resolveSessionWireModel',
  'normalizeUsageEvent',
  'mountClaudeProxy',
  'mountCodexProxy',
]);
const SENSITIVE_KEY = /(?:^|[_-])(auth|authorization|token|secret|password|credential|cookie|api[_-]?key)(?:$|[_-])/i;

class ProviderRouterPortError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProviderRouterPortError';
    this.code = code || 'PROVIDER_ROUTER_PORT_ERROR';
  }
}

function parseVersion(value, label) {
  const text = String(value == null ? '' : value).trim();
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/.exec(text);
  if (!match) throw new ProviderRouterPortError(`${label} must be an explicit semver`, 'CPR_API_VERSION_MISSING');
  return { text, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] || 0) };
}

function validateRouterContract(router) {
  if (!router || typeof router !== 'object') {
    throw new ProviderRouterPortError('CPR router is required', 'CPR_ROUTER_MISSING');
  }
  const version = parseVersion(router.API_VERSION, 'CPR API_VERSION');
  if (version.major === 0) {
    throw new ProviderRouterPortError(
      `CPR API ${version.text} is compatibility-only and may run only in legacy mode`,
      'CPR_LEGACY_ONLY',
    );
  }
  const expectedMajor = Number(PORT_API_VERSION.split('.')[0]);
  if (version.major !== expectedMajor) {
    throw new ProviderRouterPortError(
      `CPR API major ${version.major} is incompatible with ProviderRouterPort major ${expectedMajor}`,
      'CPR_API_MAJOR_MISMATCH',
    );
  }
  const capabilities = router.CAPABILITIES;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new ProviderRouterPortError('CPR CAPABILITIES are required', 'CPR_CAPABILITIES_MISSING');
  }
  const negotiatedCapabilities = {};
  for (const [name, requiredMajor] of Object.entries(REQUIRED_CAPABILITIES)) {
    if (!Object.prototype.hasOwnProperty.call(capabilities, name)) {
      throw new ProviderRouterPortError(`CPR capability is required: ${name}`, 'CPR_CAPABILITY_MISSING');
    }
    const capability = parseVersion(capabilities[name], `CPR capability ${name}`);
    if (capability.major !== requiredMajor) {
      throw new ProviderRouterPortError(
        `CPR capability ${name} major ${capability.major} is incompatible with ${requiredMajor}`,
        'CPR_CAPABILITY_INCOMPATIBLE',
      );
    }
    negotiatedCapabilities[name] = capabilities[name];
  }
  for (const method of REQUIRED_ROUTER_METHODS) {
    if (typeof router[method] !== 'function') {
      throw new ProviderRouterPortError(`CPR method is required: ${method}`, 'CPR_METHOD_MISSING');
    }
  }
  return Object.freeze({
    apiVersion: version.text,
    capabilities: Object.freeze(negotiatedCapabilities),
  });
}

function validateEmbeddingPaths(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderRouterPortError('embeddingPaths must be explicitly injected', 'CPR_PATHS_REQUIRED');
  }
  const cprPaths = value.cprPaths;
  const codexHomesDir = String(value.codexHomesDir || '').trim();
  if (!cprPaths || typeof cprPaths !== 'object' || Array.isArray(cprPaths)) {
    throw new ProviderRouterPortError('embeddingPaths.cprPaths is required', 'CPR_PATHS_REQUIRED');
  }
  if (!path.isAbsolute(String(cprPaths.home || ''))) {
    throw new ProviderRouterPortError('embeddingPaths.cprPaths.home must be absolute', 'CPR_PATHS_INVALID');
  }
  for (const [name, candidate] of Object.entries(cprPaths)) {
    if (typeof candidate === 'string' && candidate && !path.isAbsolute(candidate)) {
      throw new ProviderRouterPortError(`embeddingPaths.cprPaths.${name} must be absolute`, 'CPR_PATHS_INVALID');
    }
  }
  if (!path.isAbsolute(codexHomesDir)) {
    throw new ProviderRouterPortError('embeddingPaths.codexHomesDir must be absolute', 'CPR_PATHS_INVALID');
  }
  return Object.freeze({ cprPaths: Object.freeze({ ...cprPaths }), codexHomesDir });
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function collectSecrets(value, found = new Set(), seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return found;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) && (typeof child === 'string' || typeof child === 'number')) {
      if (String(child)) found.add(String(child));
    } else if (child && typeof child === 'object') {
      collectSecrets(child, found, seen);
    }
  }
  return found;
}

function scrubString(value, secrets) {
  let output = String(value)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:token|access[_-]?token|key|api[_-]?key|auth|secret|password|credential)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//[REDACTED]@');
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    output = output.split(secret).join(`[REDACTED:${fingerprint(secret)}]`);
  }
  return output;
}

function redactForDiagnostics(value, knownSecrets) {
  const secrets = knownSecrets || collectSecrets(value);
  const seen = new WeakSet();
  function visit(current, key = '') {
    if (current == null || typeof current === 'boolean' || typeof current === 'number') return current;
    if (typeof current === 'string') {
      if (SENSITIVE_KEY.test(key)) return `[REDACTED:${fingerprint(current)}]`;
      return scrubString(current, secrets);
    }
    if (typeof current === 'function') return '[function]';
    if (typeof current !== 'object') return String(current);
    if (seen.has(current)) return '[circular]';
    seen.add(current);
    if (Array.isArray(current)) return current.map(item => visit(item));
    const output = {};
    for (const childKey of Object.keys(current).sort()) {
      output[childKey] = visit(current[childKey], childKey);
    }
    return output;
  }
  return visit(value);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function diffValues(left, right, prefix = '$', output = []) {
  if (output.length >= 100 || sameValue(left, right)) return output;
  const leftObject = left && typeof left === 'object';
  const rightObject = right && typeof right === 'object';
  if (!leftObject || !rightObject || Array.isArray(left) !== Array.isArray(right)) {
    output.push({ path: prefix, legacy: left, cpr: right });
    return output;
  }
  if (Array.isArray(left)) {
    const size = Math.max(left.length, right.length);
    for (let index = 0; index < size && output.length < 100; index += 1) {
      diffValues(left[index], right[index], `${prefix}[${index}]`, output);
    }
    return output;
  }
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  for (const key of keys) {
    if (output.length >= 100) break;
    diffValues(left[key], right[key], `${prefix}.${key}`, output);
  }
  return output;
}

function safeProviderSummary(provider, appType, id) {
  if (!provider) return null;
  const baseUrl = provider.baseUrl || provider.url || null;
  const modelOptions = Array.isArray(provider.modelOptions)
    ? provider.modelOptions
    : (Array.isArray(provider.models) ? provider.models : (provider.models ? [provider.models] : []));
  const aliasMap = {};
  if (provider.aliasMap && typeof provider.aliasMap === 'object' && !Array.isArray(provider.aliasMap)) {
    for (const [tier, entry] of Object.entries(provider.aliasMap)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        aliasMap[tier] = Object.freeze({
          model: entry.model == null ? '' : String(entry.model),
          name: entry.name == null ? '' : String(entry.name),
        });
      } else if (entry != null) {
        aliasMap[tier] = Object.freeze({ model: String(entry), name: '' });
      }
    }
  }
  return Object.freeze({
    id: String(provider.id || id || ''),
    appType: String(provider.appType || appType || ''),
    name: String(provider.name || provider.id || id || ''),
    source: provider.source == null ? null : String(provider.source),
    baseUrl: baseUrl == null ? null : scrubString(baseUrl, new Set()),
    model: provider.model == null ? null : String(provider.model),
    modelOptions: Object.freeze(modelOptions.map(String)),
    aliasMap: Object.freeze(aliasMap),
    protocol: provider.protocol == null ? null : String(provider.protocol),
    apiFormat: provider.apiFormat == null ? null : String(provider.apiFormat),
    wireApi: provider.wireApi == null ? null : String(provider.wireApi),
    compatibleClis: Object.freeze(Array.isArray(provider.compatibleClis) ? provider.compatibleClis.map(String) : []),
    requiresConversionFor: Object.freeze(Array.isArray(provider.requiresConversionFor) ? provider.requiresConversionFor.map(String) : []),
    aliasOnly: !!provider.aliasOnly,
    useChatResponsesProxy: !!provider.useChatResponsesProxy,
    isOfficial: !!provider.isOfficial,
    hasToken: !!(provider.hasToken || provider.tokenMask || provider.authToken || provider.apiKey),
  });
}

function requireMethod(target, method, label) {
  if (!target || typeof target[method] !== 'function') {
    throw new ProviderRouterPortError(`${label}.${method} is not available`, 'PROVIDER_ROUTER_METHOD_UNAVAILABLE');
  }
  return target[method].bind(target);
}

function createProviderRouterPort(options = {}) {
  const mode = String(options.mode || '').trim().toLowerCase();
  if (!PORT_MODES.includes(mode)) {
    throw new ProviderRouterPortError('mode must be legacy, shadow, or cpr', 'PROVIDER_ROUTER_MODE_INVALID');
  }
  const legacy = options.legacy || null;
  const router = options.router || null;
  let contract = null;
  let embeddingPaths = null;
  if (mode === 'legacy') {
    if (!legacy) throw new ProviderRouterPortError('legacy adapter is required', 'LEGACY_PROVIDER_ROUTER_MISSING');
  } else {
    contract = validateRouterContract(router);
    embeddingPaths = validateEmbeddingPaths(options.embeddingPaths);
    if (!options.providerStore || typeof options.providerStore.getProvider !== 'function') {
      throw new ProviderRouterPortError('providerStore.getProvider is required', 'CPR_PROVIDER_STORE_REQUIRED');
    }
    if (mode === 'shadow' && !legacy) {
      throw new ProviderRouterPortError('shadow mode requires a legacy adapter', 'LEGACY_PROVIDER_ROUTER_MISSING');
    }
  }
  const providerStore = options.providerStore || null;
  const onShadowDiff = typeof options.onShadowDiff === 'function' ? options.onShadowDiff : null;
  const logger = options.logger && typeof options.logger.debug === 'function' ? options.logger : null;

  function routerInput(binding) {
    const value = assertProviderBinding(binding);
    return {
      cli: value.cli,
      providerId: value.providerId,
      model: value.model,
      store: providerStore,
      paths: embeddingPaths.cprPaths,
      cprHome: embeddingPaths.cprPaths.home,
      codexHomesDir: embeddingPaths.codexHomesDir,
    };
  }

  function emitShadow(operation, binding, legacyValue, cprValue, error) {
    if (!onShadowDiff && !logger) return;
    const secrets = collectSecrets(legacyValue);
    collectSecrets(cprValue, secrets);
    const safeLegacy = redactForDiagnostics(legacyValue, secrets);
    const safeCpr = redactForDiagnostics(cprValue, secrets);
    const differences = error ? [] : diffValues(safeLegacy, safeCpr);
    const report = Object.freeze({
      operation,
      binding: binding ? Object.freeze({
        sessionId: binding.sessionId,
        cli: binding.cli,
        providerId: binding.providerId,
        roleKind: binding.roleKind,
        agentRole: binding.agentRole,
        routeName: binding.routeName,
      }) : null,
      equal: !error && differences.length === 0,
      differences: Object.freeze(differences.map(item => Object.freeze(item))),
      error: error ? Object.freeze({
        message: 'CPR shadow evaluation failed',
        code: /^[A-Z][A-Z0-9_]{0,63}$/.test(String(error.code || '')) ? String(error.code) : null,
      }) : null,
    });
    if (onShadowDiff) {
      try { onShadowDiff(report); } catch (_) {}
    }
    if (logger) {
      try { logger.debug('ProviderRouterPort shadow comparison', report); } catch (_) {}
    }
  }

  function shadow(operation, binding, legacyCall, cprCall) {
    const legacyValue = legacyCall();
    try {
      const cprValue = cprCall();
      emitShadow(operation, binding, legacyValue, cprValue, null);
    } catch (error) {
      emitShadow(operation, binding, legacyValue, null, error);
    }
    return legacyValue;
  }

  function resolveSpawn(binding) {
    const value = assertProviderBinding(binding);
    const legacyCall = () => requireMethod(legacy, 'resolveSpawnEnv', 'legacy')(toLegacyProviderView(value));
    const cprCall = () => router.resolveSpawnEnv(routerInput(value));
    if (mode === 'legacy') return legacyCall();
    if (mode === 'cpr') return cprCall();
    return shadow('resolveSpawn', value, legacyCall, cprCall);
  }

  function buildChildEnv(base, binding, extra = {}) {
    const value = assertProviderBinding(binding);
    if (!base || typeof base !== 'object' || Array.isArray(base)) {
      throw new ProviderRouterPortError('base environment must be an object', 'PROVIDER_ENV_INVALID');
    }
    const legacyCall = () => requireMethod(legacy, 'buildChildEnv', 'legacy')(
      base,
      toLegacyProviderView(value),
      extra,
    );
    const cprCall = () => router.buildChildEnv(base, routerInput(value), extra);
    if (mode === 'legacy') return legacyCall();
    if (mode === 'cpr') return cprCall();
    // Child-env construction may materialize Codex auth/config.  Shadow mode
    // evaluates only the pure summary/model/spawn projections.
    return legacyCall();
  }

  function resolveWireModel(model, resolution = {}) {
    const legacyCall = () => requireMethod(legacy, 'resolveSessionWireModel', 'legacy')(model, resolution);
    const cprCall = () => router.resolveSessionWireModel(model, resolution);
    if (mode === 'legacy') return legacyCall();
    if (mode === 'cpr') return cprCall();
    return shadow('resolveWireModel', null, legacyCall, cprCall);
  }

  function providerSummary(appType, providerId) {
    const legacyCall = () => safeProviderSummary(
      requireMethod(legacy, 'getProviderSummary', 'legacy')(appType, providerId),
      appType,
      providerId,
    );
    const cprCall = () => safeProviderSummary(
      typeof providerStore.getProviderSummary === 'function'
        ? providerStore.getProviderSummary(appType, providerId)
        : providerStore.getProvider(appType, providerId),
      appType,
      providerId,
    );
    if (mode === 'legacy') return legacyCall();
    if (mode === 'cpr') return cprCall();
    return shadow('providerSummary', null, legacyCall, cprCall);
  }

  function normalizeUsage(input, binding = null) {
    const value = binding == null ? null : assertProviderBinding(binding);
    const legacyCall = () => {
      const normalized = legacy && typeof legacy.normalizeUsageEvent === 'function'
        ? legacy.normalizeUsageEvent(input, { generateId: false })
        : input;
      return createUsageObserved(normalized, value);
    };
    const cprCall = () => createUsageObserved(
      router.normalizeUsageEvent(input, { generateId: false }),
      value,
    );
    if (mode === 'legacy') return legacyCall();
    if (mode === 'cpr') return cprCall();
    // Usage is an event stream, not a pure query: comparing it would duplicate
    // normalization side effects and lies outside the read-only shadow scope.
    return legacyCall();
  }

  // Only protocol mounts enter the port. CPR service, CC-Switch takeover,
  // direct-CLI takeover and restore APIs remain intentionally unreachable.
  function mountProtocolProxies(app, mountOptions = {}) {
    if (!app || typeof app.use !== 'function') {
      throw new ProviderRouterPortError('an Express-compatible app is required', 'PROXY_APP_INVALID');
    }
    const backend = mode === 'cpr' ? router : legacy;
    const getProvider = mode === 'cpr'
      ? providerStore.getProvider.bind(providerStore)
      : requireMethod(legacy, 'getProvider', 'legacy');
    const onUsageObserved = typeof mountOptions.onUsageObserved === 'function'
      ? mountOptions.onUsageObserved
      : null;
    if (mountOptions.protocols != null && !Array.isArray(mountOptions.protocols)) {
      throw new ProviderRouterPortError('protocols must be an array', 'PROXY_PROTOCOL_INVALID');
    }
    const protocols = mountOptions.protocols == null
      ? ['claude', 'codex']
      : [...new Set(mountOptions.protocols.map(String))];
    if (protocols.some(protocol => protocol !== 'claude' && protocol !== 'codex')) {
      throw new ProviderRouterPortError('protocols may contain only claude and codex', 'PROXY_PROTOCOL_INVALID');
    }
    const common = {
      getProvider,
      ...(embeddingPaths ? {
        paths: embeddingPaths.cprPaths,
        cprHome: embeddingPaths.cprPaths.home,
        ...(embeddingPaths.cprPaths.capturesDir
          ? { captureDir: embeddingPaths.cprPaths.capturesDir }
          : {}),
      } : {}),
      ...(typeof mountOptions.getPort === 'function' ? { getPort: mountOptions.getPort } : {}),
      ...(mountOptions.proxyBaseUrl ? { proxyBaseUrl: String(mountOptions.proxyBaseUrl) } : {}),
      onUsageEvent: onUsageObserved ? event => onUsageObserved(normalizeUsage(event)) : undefined,
      // Request/end activity is also the TaskRun producer fence.  Dropping it
      // here would make the host believe provider requests are drained while
      // the proxy is still streaming a response.
      ...(typeof mountOptions.onActivity === 'function'
        ? { onActivity: mountOptions.onActivity } : {}),
      // Token-level delta sidecar: cli-provider-router's codex proxy forwards each
      // upstream text/reasoning/tool delta here along with routing context
      // {providerId, sessionId, role, routeName, model}. The host broadcasts it to
      // the matching chat session so codex turns render incrementally (opencode-
      // style) instead of waiting for each item.completed boundary.
      ...(typeof mountOptions.onDelta === 'function' ? { onDelta: mountOptions.onDelta } : {}),
      // Claude subscription 5h rate-limit sidecar: the claude proxy reads the
      // anthropic-ratelimit-unified-5h-* response headers off official-OAuth turns
      // and forwards a whitewashed {rateLimitType,status,utilization,resetsAt} DTO
      // here with routing context. The host broadcasts it to the matching chat
      // session so the 5h usage bar updates live. Best-effort, never breaks stream.
      ...(typeof mountOptions.onRateLimit === 'function' ? { onRateLimit: mountOptions.onRateLimit } : {}),
    };
    const mounted = {};
    if (protocols.includes('claude')) {
      mounted.claude = requireMethod(backend, 'mountClaudeProxy', mode === 'cpr' ? 'router' : 'legacy')(
        app,
        { ...common, ...(mountOptions.claudeProxyPath ? { claudeProxyPath: String(mountOptions.claudeProxyPath) } : {}) },
      );
    }
    if (protocols.includes('codex')) {
      // CPR's generic Codex proxy intentionally requires an API key + base_url.
      // Mount the host-owned ChatGPT OAuth adapter first; it handles only the
      // Official provider shape and calls next() for every ordinary provider.
      mountCodexOfficialRelay(app, {
        getProvider,
        ...(mountOptions.codexOfficialRelay || {}),
        ...(mountOptions.codexProxyPath ? { codexProxyPath: String(mountOptions.codexProxyPath) } : {}),
      });
      mounted.codex = requireMethod(backend, 'mountCodexProxy', mode === 'cpr' ? 'router' : 'legacy')(
        app,
        { ...common, ...(mountOptions.codexProxyPath ? { codexProxyPath: String(mountOptions.codexProxyPath) } : {}) },
      );
    }
    return Object.freeze(mounted);
  }

  return Object.freeze({
    apiVersion: PORT_API_VERSION,
    mode,
    routerApiVersion: contract && contract.apiVersion,
    routerCapabilities: contract && contract.capabilities,
    createBinding: createProviderBinding,
    resolveSpawn,
    buildChildEnv,
    resolveWireModel,
    providerSummary,
    normalizeUsage,
    mountProtocolProxies,
  });
}

module.exports = {
  PORT_API_VERSION,
  PORT_MODES,
  REQUIRED_CAPABILITIES,
  ProviderRouterPortError,
  createProviderRouterPort,
  diffValues,
  redactForDiagnostics,
  validateRouterContract,
};
