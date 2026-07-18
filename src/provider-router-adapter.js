'use strict';

// Host adapters are deliberately explicit.  The ProviderRouterPort receives
// only the operations MultiCC owns; CPR lifecycle/takeover/restore exports are
// never copied onto either adapter.

function requireFunction(target, name, label) {
  if (!target || typeof target[name] !== 'function') {
    const error = new Error(`${label}.${name} is required`);
    error.code = 'PROVIDER_ROUTER_ADAPTER_INVALID';
    throw error;
  }
  return target[name].bind(target);
}

function createProviderStoreAdapter(providers) {
  return Object.freeze({
    getProvider: requireFunction(providers, 'getProvider', 'providers'),
    getProviderSummary: requireFunction(providers, 'getProviderSummary', 'providers'),
  });
}

function legacyUsageToObservedInput(input, { protocol, now = Date.now } = {}) {
  const info = input && typeof input === 'object' ? input : {};
  const roleKind = info.roleKind || info.role || 'main';
  const usage = info.tokens || info.usage || null;
  const agentRole = roleKind === 'sub' ? (info.agentRole || 'default') : null;
  return {
    ...(info.eventId ? { eventId: info.eventId } : {}),
    occurredAt: info.occurredAt || info.timestamp || now(),
    sessionId: info.sessionId || info.externalSessionId,
    providerId: info.providerId || '_default_',
    providerName: info.providerName || '',
    roleKind,
    ...(agentRole ? { agentRole } : {}),
    routeName: roleKind === 'sub' ? (info.routeName || agentRole) : roleKind,
    source: info.source || 'exact',
    coverage: info.coverage || (usage ? 'observed' : 'unobservable'),
    status: info.status || (usage ? 'success' : 'unobservable'),
    protocol: info.protocol || protocol,
    model: info.model || '',
    ...(usage ? { usage } : {}),
    latencyMs: info.latencyMs || 0,
    ...(info.statusCode == null ? {} : { statusCode: info.statusCode }),
    ...(info.errorCode ? { errorCode: info.errorCode } : {}),
  };
}

function supportsObservedUsage(router) {
  const match = /^(\d+)\./.exec(String(router && router.API_VERSION || ''));
  return !!(match && Number(match[1]) >= 1 && typeof router.normalizeUsageEvent === 'function');
}

function createLegacyProviderRouterAdapter({ providers, router, now = Date.now } = {}) {
  const getProvider = requireFunction(providers, 'getProvider', 'providers');
  const getProviderSummary = requireFunction(providers, 'getProviderSummary', 'providers');
  const observedUsageNative = supportsObservedUsage(router);

  function mount(name, protocol, app, options = {}) {
    const mountProxy = requireFunction(router, name, 'legacy CPR compatibility');
    const mountOptions = { ...options };
    if (!observedUsageNative) {
      const sink = typeof options.onUsageEvent === 'function' ? options.onUsageEvent : null;
      delete mountOptions.onUsageEvent;
      if (sink) {
        mountOptions.onUsage = info => sink(legacyUsageToObservedInput(info, { protocol, now }));
      }
    }
    return mountProxy(app, mountOptions);
  }

  return Object.freeze({
    getProvider,
    getProviderSummary,
    resolveSpawnEnv: requireFunction(providers, 'resolveSpawnEnv', 'providers'),
    buildChildEnv: requireFunction(providers, 'buildChildEnv', 'providers'),
    resolveSessionWireModel: requireFunction(providers, 'resolveSessionWireModel', 'providers'),
    normalizeUsageEvent(input) {
      if (input && input.occurredAt && input.source && input.coverage && input.protocol) return input;
      return legacyUsageToObservedInput(input, { protocol: input && input.protocol, now });
    },
    mountClaudeProxy(app, options) {
      return mount('mountClaudeProxy', 'anthropic-messages', app, options);
    },
    mountCodexProxy(app, options) {
      return mount('mountCodexProxy', 'openai-responses', app, options);
    },
  });
}

// Shadow evaluates only pure/read-only operations.  In particular CPR's Codex
// spawn implementation materializes auth/config files, so the comparison below
// derives the expected CODEX_HOME from the injected host path without invoking
// it.  The required write/proxy methods exist only for contract negotiation and
// fail if a future caller crosses this boundary.
function createReadOnlyShadowRouter({ router, providerStore, codexHomesDir } = {}) {
  const resolveSessionWireModel = requireFunction(router, 'resolveSessionWireModel', 'router');
  const normalizeUsageEvent = requireFunction(router, 'normalizeUsageEvent', 'router');
  const resolveSpawnEnv = requireFunction(router, 'resolveSpawnEnv', 'router');

  function forbidden(operation) {
    const error = new Error(`shadow mode forbids ${operation}`);
    error.code = 'CPR_SHADOW_WRITE_FORBIDDEN';
    throw error;
  }

  return Object.freeze({
    API_VERSION: router.API_VERSION,
    CAPABILITIES: router.CAPABILITIES,
    resolveSpawnEnv(input) {
      if (input.cli !== 'codex') return resolveSpawnEnv(input);
      if (!input.providerId) {
        return { env: {}, skipDefaultModel: false, aliasOnly: false, providerModel: null, providerModels: [], providerName: null };
      }
      const provider = providerStore.getProvider('codex', input.providerId);
      if (!provider) {
        return { env: {}, skipDefaultModel: false, aliasOnly: false, providerModel: null, providerModels: [], providerName: null };
      }
      const path = require('path');
      const home = path.join(codexHomesDir, input.providerId);
      return {
        env: { CODEX_HOME: home },
        skipDefaultModel: false,
        aliasOnly: false,
        providerModel: null,
        providerModels: [],
        providerName: provider.name || input.providerId,
        codexHome: home,
      };
    },
    buildChildEnv() { return forbidden('buildChildEnv'); },
    resolveSessionWireModel,
    normalizeUsageEvent,
    mountClaudeProxy() { return forbidden('mountClaudeProxy'); },
    mountCodexProxy() { return forbidden('mountCodexProxy'); },
  });
}

module.exports = {
  createLegacyProviderRouterAdapter,
  createProviderStoreAdapter,
  createReadOnlyShadowRouter,
  legacyUsageToObservedInput,
};
