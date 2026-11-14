'use strict';

const { sanitizePublicText } = require('../http/public-safety');

const DEFAULT_PROVIDER_IDS = Object.freeze({ claude: null, codex: null });
const { nativeVendorOf } = require('../providers/native-vendor');
const { NATIVE_OPENCODE_ID, nativeOpenCodeId } = require('../providers/native-opencode');

function publicError(error, fallback) {
  return sanitizePublicText(error && error.message, fallback);
}

function publicText(value, fallback) {
  return sanitizePublicText(typeof value === 'string' ? value : '', fallback);
}

function assertProviderRouteDeps(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('provider route dependencies are required');
  const requiredFunctions = [
    'atomicWriteJson',
    'findProviderReferences',
    'getAuxConfig',
    'getPort',
  ];
  for (const name of requiredFunctions) {
    if (typeof deps[name] !== 'function') throw new TypeError(`provider route dependency missing: ${name}`);
  }
  if (!deps.fs || typeof deps.fs.readFileSync !== 'function') {
    throw new TypeError('provider route dependency missing: fs.readFileSync');
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
  const providerDefaults = { ...DEFAULT_PROVIDER_IDS };

  // 子任务默认线路的归一化只由 Rust 决定。
  const subagentNative = () => typeof deps.getNative === 'function'
    ? deps.getNative()
    : require('../native/runtime').getNative();
  function normalizeStoredSubagent(value) {
    const native = subagentNative();
    try {
      const parsed = JSON.parse(native.normalizeSubagentDefaults(JSON.stringify({ stored: value })));
      if (!parsed || typeof parsed !== 'object') return undefined;
      return { claude: parsed.claude ?? null, codex: parsed.codex ?? null };
    } catch (_) { return undefined; }
  }

  try {
    const stored = JSON.parse(deps.fs.readFileSync(deps.providerDefaultsFile, 'utf8'));
    providerDefaults.claude = stored.claude || null;
    providerDefaults.codex = stored.codex || null;
    // Only users who already used the feature see the key; everybody else keeps
    // the exact response shapes existing clients and tests deepEqual.
    if (Object.prototype.hasOwnProperty.call(stored, 'subagent')) {
      const normalized = normalizeStoredSubagent(stored.subagent);
      providerDefaults.subagent = normalized === undefined ? stored.subagent : normalized;
    }
  } catch (_) {
    // Missing or invalid legacy defaults keep the established null defaults.
  }

  if (typeof deps.providers.normalizeOfficialProviderId === 'function') {
    for (const cli of ['claude', 'codex']) providerDefaults[cli] = deps.providers.normalizeOfficialProviderId(cli, providerDefaults[cli]);
  }

  // Throws so callers that must answer "saved or not" (the subagent-defaults
  // sync) can defer every session mutation until the file write succeeded.
  function persistProviderDefaults(value = providerDefaults) {
    deps.atomicWriteJson(deps.providerDefaultsFile, value);
  }

  function saveProviderDefaults() {
    try {
      persistProviderDefaults();
    } catch (error) {
      log.error('[multicc] save provider-defaults failed:', publicError(error, 'save failed'));
      return false;
    }
    return true;
  }

  function validProviderId(cli, id) {
    const appType = deps.providers.appTypeForCli(cli);
    if (typeof deps.providers.normalizeOfficialProviderId === 'function') {
      id = deps.providers.normalizeOfficialProviderId(cli === 'codex-exp' ? 'codex' : cli === 'claude-exp' ? 'claude' : cli, id);
    }
    if (id == null || id === '') return { ok: true, value: null };
    // A vendor-native Auto line has no provider record; the lane itself owns the
    // account, so only the lane check applies.
    const nativeVendor = nativeVendorOf(id);
    if (nativeVendor !== null) {
      return cli === nativeVendor.cli ? { ok: true, value: String(id) } : { ok: false };
    }
    // OpenCode's own native lines (`opencode-native:<id>`) are legal Auto pool
    // candidates and are persisted as session.provider; the new-task form replays
    // that stored line as an explicit provider, so revalidation must accept it.
    // Structural only, mirroring the Rust candidate validator: opencode lane,
    // id shape, never a store lookup.
    const openCodeNative = nativeOpenCodeId(id);
    if (openCodeNative !== null) {
      return cli === 'opencode' && NATIVE_OPENCODE_ID.test(openCodeNative)
        ? { ok: true, value: String(id) }
        : { ok: false };
    }
    // Qoder CN remains vendor-managed. OpenCode and ZCode both support the two
    // MultiCC pools, so their provider ids are looked up globally and then
    // constrained by the provider's declared protocol compatibility.
    const appTypes = typeof deps.providers.appTypesForCli === 'function'
      ? deps.providers.appTypesForCli(cli)
      : (appType ? [appType] : []);
    if (!appTypes.length) return { ok: false };
    const globalPoolCli = appTypes.length > 1;
    const summary = deps.providerRouterRuntime.getProviderSummary(
      globalPoolCli ? undefined : appType,
      String(id),
    );
    if (!summary || !deps.providers.providerSupportsCli(summary, cli)) return { ok: false };
    return { ok: true, value: String(id) };
  }

  function mountManagementRoutes(app) {
    for (const method of ['get', 'post', 'patch', 'delete', 'put']) assertAppMethod(app, method);
    // 16 条 provider 路由（目录、增删改、探测、批量迁移、借道、默认值）已由 Rust 前门
    // 独占（native/gateway/src/app/providers.rs）。这里只剩前门回调的宿主端口：
    // provider store 事实、会话引用、落盘与逐会话 PATCH。
    require('./providers-host').mountProvidersHostRoute(app, {
      providerDefaults,
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
