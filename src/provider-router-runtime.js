'use strict';

const path = require('path');
const {
  PORT_MODES,
  ProviderRouterPortError,
  createProviderRouterPort,
  validateRouterContract,
} = require('./provider-router-port');
const {
  createLegacyProviderRouterAdapter,
  createProviderStoreAdapter,
  createReadOnlyShadowRouter,
} = require('./provider-router-adapter');
const { toLegacyProviderView } = require('./provider-binding');

const DEFAULT_MODE = 'legacy';

// Pure path construction only.  Host embedding must never call CPR's
// createCprPaths/ensureCprPaths or consult CPR_HOME; any directories that CPR
// mode later needs remain rooted in MultiCC's explicitly injected data path.
function createHostEmbeddingPaths({ dataRoot, codexHomesDir } = {}) {
  if (!path.isAbsolute(String(dataRoot || '')) || !path.isAbsolute(String(codexHomesDir || ''))) {
    const error = new Error('absolute MultiCC dataRoot and codexHomesDir are required');
    error.code = 'CPR_HOST_PATHS_REQUIRED';
    throw error;
  }
  const home = path.join(dataRoot, '.provider-router-host');
  const configDir = path.join(home, 'config');
  const dataDir = path.join(home, 'data');
  const runDir = path.join(home, 'run');
  const logsDir = path.join(home, 'logs');
  const ccSwitchDir = path.join(home, 'ccswitch');
  const directCliConfigDir = path.join(home, 'direct-cli-config');
  return Object.freeze({
    cprPaths: Object.freeze({
      home,
      configDir,
      dataDir,
      runDir,
      logsDir,
      ccSwitchDir,
      ccSwitchStateFile: path.join(ccSwitchDir, 'state.json'),
      ccSwitchSnapshotsDir: path.join(ccSwitchDir, 'snapshots'),
      ccSwitchAuditFile: path.join(ccSwitchDir, 'audit.jsonl'),
      directCliConfigDir,
      directCliConfigSnapshotsDir: path.join(directCliConfigDir, 'snapshots'),
      directCliConfigStateDir: path.join(directCliConfigDir, 'state'),
      backupsDir: path.join(home, 'backups'),
      capturesDir: path.join(home, 'captures'),
      codexHomesDir,
      settingsFile: path.join(configDir, 'settings.json'),
      providersFile: path.join(dataDir, 'providers.json'),
      routeProfilesFile: path.join(dataDir, 'route-profiles.json'),
      usageDir: path.join(dataDir, 'usage'),
      usagePolicyFile: path.join(configDir, 'usage-policy.json'),
      servicePidFile: path.join(runDir, 'cpr.pid'),
      serviceStateFile: path.join(runDir, 'service.json'),
      serviceHealthFile: path.join(runDir, 'health.json'),
      serviceLogFile: path.join(logsDir, 'service.log'),
      adminTokenFile: path.join(runDir, 'admin-token'),
      legacyProvidersFile: path.join(home, 'providers.json'),
    }),
    codexHomesDir,
  });
}

function resolveMode(env = process.env) {
  return String(env.MULTICC_PROVIDER_ROUTER_MODE || DEFAULT_MODE).trim().toLowerCase();
}

function resolveRouterVersion(router, explicitVersion) {
  if (router && router.API_VERSION) return String(router.API_VERSION);
  if (explicitVersion) return String(explicitVersion);
  try { return String(require('cli-provider-router/package.json').version || ''); }
  catch (_) { return ''; }
}

function createProviderRouterRuntime(options = {}) {
  const env = options.env || process.env;
  const mode = String(options.mode || resolveMode(env)).trim().toLowerCase();
  if (!PORT_MODES.includes(mode)) {
    throw new ProviderRouterPortError('mode must be legacy, shadow, or cpr', 'PROVIDER_ROUTER_MODE_INVALID');
  }
  const providers = options.providers;
  if (!providers) throw new Error('providers implementation is required');
  // The dependency is loaded here, never from server.js.  Legacy mode supports
  // the installed CPR 0.2 compatibility mounts; shadow/cpr negotiate below.
  const router = options.router || require('cli-provider-router');
  const routerVersion = resolveRouterVersion(router, options.routerPackageVersion);
  if (mode !== 'legacy' && /^0\./.test(routerVersion)) {
    throw new ProviderRouterPortError(
      `CPR ${routerVersion} is compatibility-only and may run only in legacy mode`,
      'CPR_LEGACY_ONLY',
    );
  }
  const providerStore = createProviderStoreAdapter(providers);
  const legacy = createLegacyProviderRouterAdapter({ providers, router, now: options.now });
  const embeddingPaths = createHostEmbeddingPaths({
    dataRoot: options.dataRoot,
    codexHomesDir: options.codexHomesDir,
  });

  let portRouter = router;
  if (mode === 'shadow') {
    // Validate the real package before wrapping it.  A 0.2 dependency must not
    // appear production-ready merely because a host facade has modern fields.
    validateRouterContract(router);
    portRouter = createReadOnlyShadowRouter({
      router,
      providerStore,
      codexHomesDir: embeddingPaths.codexHomesDir,
    });
  }

  const port = createProviderRouterPort({
    mode,
    legacy,
    router: portRouter,
    providerStore,
    embeddingPaths,
    onShadowDiff: options.onShadowDiff,
    logger: options.logger,
  });

  function createBinding(session, overrides = {}) {
    const value = session && typeof session === 'object' ? session : {};
    return port.createBinding({
      sessionId: overrides.sessionId || value.id || value.sessionId,
      cli: overrides.cli || value.cli || 'claude',
      providerId: overrides.providerId !== undefined ? overrides.providerId : value.provider,
      model: overrides.model !== undefined ? overrides.model : value.model,
      roleKind: overrides.roleKind || 'main',
      ...(overrides.agentRole ? { agentRole: overrides.agentRole } : {}),
      ...(overrides.routeName ? { routeName: overrides.routeName } : {}),
    });
  }

  function hostOwnsOfficialCodexHome(binding) {
    if (mode !== 'cpr' || binding.cli !== 'codex' || !binding.providerId) return false;
    const provider = providers.getProvider('codex', binding.providerId);
    return typeof providers.isOfficialCodexOAuthProvider === 'function'
      && providers.isOfficialCodexOAuthProvider(provider);
  }

  function resolveSpawnEnv(session, overrides) {
    const binding = createBinding(session, overrides);
    // CPR's generic Codex materializer copies provider/global auth.json before
    // an attempt route exists. Official OAuth is a host-only credential, so
    // select MultiCC's credential-free relay home at this earliest boundary.
    if (hostOwnsOfficialCodexHome(binding)) {
      return legacy.resolveSpawnEnv(toLegacyProviderView(binding));
    }
    return port.resolveSpawn(binding);
  }

  function buildChildEnv(base, session, extra = {}, overrides) {
    const binding = createBinding(session, overrides);
    // Shadow comparisons are intentionally limited to summary/model/spawn.
    // Child-env construction can materialize Codex state, so it stays legacy.
    if (mode === 'shadow' || hostOwnsOfficialCodexHome(binding)) {
      return legacy.buildChildEnv(base, toLegacyProviderView(binding), extra);
    }
    return port.buildChildEnv(base, binding, extra);
  }

  return Object.freeze({
    apiVersion: port.apiVersion,
    mode: port.mode,
    routerApiVersion: port.routerApiVersion,
    routerCapabilities: port.routerCapabilities,
    embeddingPaths,
    createBinding,
    resolveSpawnEnv,
    buildChildEnv,
    resolveSessionWireModel: port.resolveWireModel,
    getProviderSummary: port.providerSummary,
    normalizeUsageObserved: port.normalizeUsage,
    mountProtocolProxies: port.mountProtocolProxies,
  });
}

module.exports = {
  DEFAULT_MODE,
  createHostEmbeddingPaths,
  createProviderRouterRuntime,
  resolveMode,
  resolveRouterVersion,
};
