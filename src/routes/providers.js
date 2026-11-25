'use strict';

const { sanitizePublicText } = require('../http/public-safety');

const DEFAULT_PROVIDER_IDS = Object.freeze({ claude: null, codex: null });
const { VENDOR_NATIVE_CLIS, NATIVE_VENDOR_SUFFIX } = require('../providers/native-vendor');
const { NATIVE_OPENCODE_PREFIX } = require('../native/runtime').getNativeOpenCodeCatalog();

function publicError(error, fallback) {
  return sanitizePublicText(error && error.message, fallback);
}

function publicText(value, fallback) {
  return sanitizePublicText(typeof value === 'string' ? value : '', fallback);
}

function assertProviderRouteDeps(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('provider route dependencies are required');
  const requiredFunctions = [
    'findProviderReferences',
    'getAuxConfig',
    'getPort',
  ];
  for (const name of requiredFunctions) {
    if (typeof deps[name] !== 'function') throw new TypeError(`provider route dependency missing: ${name}`);
  }
  if (!deps.providers || !deps.providerRouterRuntime || !deps.persistedSessions
      || !deps.providerRelayShares
      || typeof deps.providerRelayShares.create !== 'function'
      || typeof deps.providerRelayShares.list !== 'function'
      || typeof deps.providerRelayShares.getCredential !== 'function'
      || typeof deps.providerRelayShares.revoke !== 'function'
      || typeof deps.providerRelayShares.revokeProvider !== 'function') {
    throw new TypeError('provider route runtime dependencies are required');
  }
  if (!deps.providerDefaultsFile || !deps.claudeCmd) {
    throw new TypeError('provider route host values are required');
  }
  return deps;
}

function assertAppMethod(app, method) {
  if (!app || typeof app[method] !== 'function') {
    throw new TypeError(`Express app.${method} is required`);
  }
}

function createProviderRoutes(rawDeps) {
  const deps = assertProviderRouteDeps(rawDeps);
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const log = deps.logger || console;
  const defaultsPort = require('../providers/defaults-port');
  const defaultsOwner = deps.providerDefaultsOwner || defaultsPort.getProviderDefaultsOwner(deps.providerDefaultsFile);
  const providerDefaults = defaultsPort.providerDefaultsView(defaultsOwner);

  // 子任务默认线路的归一化只由 Rust 决定。
  const subagentNative = () => typeof deps.getNative === 'function'
    ? deps.getNative()
    : require('../native/runtime').getNative();
  if (typeof deps.providers.normalizeOfficialProviderId === 'function') {
    for (const cli of ['claude', 'codex']) defaultsOwner.set(cli, deps.providers.normalizeOfficialProviderId(cli, defaultsOwner.get(cli)));
  }

  // Throws so callers that must answer "saved or not" (the subagent-defaults
  // sync) can defer every session mutation until the file write succeeded.
  function persistProviderDefaults(value = providerDefaults) {
    defaultsOwner.commit(value);
  }

  function saveProviderDefaults() {
    try {
      defaultsOwner.persist();
    } catch (error) {
      log.error('[multicc] save provider-defaults failed:', publicError(error, 'save failed'));
      return false;
    }
    return true;
  }

  // 校验控制流全在 Rust（`multicc_core::provider_registry`）。唯一的形状适配：
  // 内核把「空 id 放行」编成 `{ok:true}`（没有 value 键），退役实现返回
  // `{ok:true,value:null}`，而消费点是直接读 `.value` 的（会话记录、子任务路由
  // 都以 null 落盘），所以这里把缺省的 value 补回 null。这是结果形状适配，不是规则。
  function validProviderId(cli, id) {
    const result = subagentNative().providerValidateId(deps, cli, id,
      VENDOR_NATIVE_CLIS, NATIVE_VENDOR_SUFFIX, NATIVE_OPENCODE_PREFIX);
    if (result && result.ok === true && result.value === undefined) return { ok: true, value: null };
    return result;
  }

  function mountManagementRoutes(app) {
    for (const method of ['get', 'post', 'patch', 'delete', 'put']) assertAppMethod(app, method);
    // 16 条 provider 路由（目录、增删改、探测、批量迁移、借道、默认值）已由 Rust 前门
    // 独占（native/gateway/src/app/providers.rs）。这里只剩前门回调的宿主端口：
    // provider store 事实、会话引用、落盘与逐会话 PATCH。
    require('./providers-host').mountProvidersHostRoute(app, {
      providerDefaults,
      defaultsOwner,
      saveProviderDefaults,
      validProviderId,
      providers: deps.providers,
      providerRouterRuntime: deps.providerRouterRuntime,
      findProviderReferences: deps.findProviderReferences,
      getAuxConfig: deps.getAuxConfig,
      persistedSessions: deps.persistedSessions,
      applySessionPatch: deps.applySessionPatch,
      previewSessionPatch: deps.previewSessionPatch,
      clearAuxProvider: deps.clearAuxProvider,
      providerRelayShares: deps.providerRelayShares,
      getPort: deps.getPort,
      claudeCmd: deps.claudeCmd,
      relayModelCatalogRuntime: deps.relayModelCatalogRuntime,
      codexAccountModelCatalogRuntime: deps.codexAccountModelCatalogRuntime,
      providerLimitCache: deps.providerLimitCache,
      limitRecorder: deps.limitRecorder,
      limitCacheStaleMs: deps.limitCacheStaleMs,
      now,
      logger: log,
      ...(typeof deps.isLocalRequest === 'function' ? { isLocal: deps.isLocalRequest } : {}),
    });

    // 子任务默认线路 + 一键同步：公开路由由 Rust 前门独占（native/gateway/），这里只剩
    // 前门回调的宿主端口：会话表/provider 事实、默认值落盘与逐会话 PATCH。
    require('./subagent-defaults-host').mountSubagentDefaultsHostRoute(app, {
      providerDefaults,
      sessions: deps.persistedSessions,
      validProviderId,
      providers: deps.providers,
      applySessionPatch: deps.applySessionPatch,
      previewSessionPatch: deps.previewSessionPatch,
      persistDefaults: persistProviderDefaults,
      ...(typeof deps.isLocalRequest === 'function' ? { isLocal: deps.isLocalRequest } : {}),
    });

  }

  return Object.freeze({
    providerDefaults,
    validProviderId,
    mountManagementRoutes,
  });
}

function mountProviderRoutes(app, deps) {
  const routes = createProviderRoutes(deps);
  routes.mountManagementRoutes(app);
  return routes;
}

module.exports = {
  DEFAULT_PROVIDER_IDS,
  assertProviderRouteDeps,
  createProviderRoutes,
  mountProviderRoutes,
  publicError,
};
