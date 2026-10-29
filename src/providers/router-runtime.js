'use strict';

const path = require('path');
const {
  PORT_MODES,
  ProviderRouterPortError,
  createProviderRouterPort,
  validateRouterContract,
} = require('./router-port');
const {
  createLegacyProviderRouterAdapter,
  createProviderStoreAdapter,
  createReadOnlyShadowRouter,
} = require('./router-adapter');
const { toLegacyProviderView } = require('./binding');
const { applyCliKeyAccountEnv, selectedAccountId } = require('../cli-key-accounts');
const { ensureLoopbackNoProxyEnv, hasProxyEnv } = require('../network/proxy-policy');
const { latestChildProxyEnv } = require('../network/global-proxy');

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
  const { resolveCprBackend, createRustCprRouter } = require('./rust-cpr');
  const proxyBackend = resolveCprBackend(env);
  const mode = String(options.mode || resolveMode(env)).trim().toLowerCase();
  if (!PORT_MODES.includes(mode)) {
    throw new ProviderRouterPortError('mode must be legacy, shadow, or cpr', 'PROVIDER_ROUTER_MODE_INVALID');
  }
  const providers = options.providers;
  if (!providers) throw new Error('providers implementation is required');
  // The dependency is loaded here, never from server.js.  Legacy mode supports
  // the installed CPR 0.2 compatibility mounts; shadow/cpr negotiate below.
  const nodeRouter = options.router || require('cli-provider-router');
  const router = proxyBackend === 'rust' ? createRustCprRouter(nodeRouter, { env }) : nodeRouter;
  const routerVersion = resolveRouterVersion(router, options.routerPackageVersion);
  if (mode !== 'legacy' && /^0\./.test(routerVersion)) {
    throw new ProviderRouterPortError(
      `CPR ${routerVersion} is compatibility-only and may run only in legacy mode`,
      'CPR_LEGACY_ONLY',
    );
  }
  // Per-session API-key accounts (src/cli-key-accounts.js). Without a store a
  // session's pick still fails closed instead of spawning on the CLI's login.
  const keyAccounts = options.keyAccounts || { readKey: () => null };
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
    const cli = overrides.cli || value.cli || 'claude';
    const requestedProvider = overrides.providerId !== undefined ? overrides.providerId : value.provider;
    const providerId = !value.loginFlow && typeof providers.normalizeOfficialProviderId === 'function'
      ? providers.normalizeOfficialProviderId(cli === 'codex-exp' ? 'codex' : cli === 'claude-exp' ? 'claude' : cli, requestedProvider) : requestedProvider;
    return port.createBinding({
      sessionId: overrides.sessionId || value.id || value.sessionId,
      cli, providerId,
      model: overrides.model !== undefined ? overrides.model : value.model,
      roleKind: overrides.roleKind || 'main',
      ...(overrides.agentRole ? { agentRole: overrides.agentRole } : {}),
      ...(overrides.routeName ? { routeName: overrides.routeName } : {}),
    });
  }

  function hostOwnsOfficialCodexHome(binding) {
    if (mode !== 'cpr' || !['codex', 'codex-exp'].includes(binding.cli) || !binding.providerId) return false;
    const provider = providers.getProvider('codex', binding.providerId);
    return typeof providers.isOfficialCodexOAuthProvider === 'function'
      && providers.isOfficialCodexOAuthProvider(provider);
  }

  // The account rides on top of whatever the route produced, on both launch
  // paths: chat children (buildChildEnv) and terminals (resolveSpawnEnv env).
  function withKeyAccount(result, session, cli) {
    if (!result || !selectedAccountId(session, cli)) return result;
    return { ...result, env: applyCliKeyAccountEnv(result.env || {}, session, keyAccounts, cli) };
  }

  // Children routed onto the local CPR (127.0.0.1) must never let a proxy
  // capture that hop. Two capture paths: (a) inherited proxy env without a
  // loopback NO_PROXY — fixed by ensureLoopbackNoProxyEnv; (b) codex
  // (Rust/reqwest) silently reading the macOS system proxy when the env has no
  // proxy vars at all. For (b) declare the discovered proxy explicitly: env
  // vars take precedence over system settings in reqwest, and the env path
  // honors NO_PROXY, so the loopback bypass applies. Snapshot comes from the
  // global proxy refresh (60s cadence); a stale or absent snapshot keeps the
  // previous behavior, and the hijack hint on the turn error covers the gap.
  const childProxyEnv = options.childProxyEnv || latestChildProxyEnv;
  function withManagedProxyEnv(result, cli) {
    if (!result || !result.env) return result;
    let env = result.env;
    if (['codex', 'codex-exp'].includes(cli) && !hasProxyEnv(env)) {
      const snapshot = childProxyEnv();
      if (snapshot) env = {
        ...env,
        http_proxy: snapshot.HTTP_PROXY || '', HTTP_PROXY: snapshot.HTTP_PROXY || '',
        https_proxy: snapshot.HTTPS_PROXY || '', HTTPS_PROXY: snapshot.HTTPS_PROXY || '',
        no_proxy: snapshot.NO_PROXY || '', NO_PROXY: snapshot.NO_PROXY || '',
      };
    }
    const merged = ensureLoopbackNoProxyEnv(env);
    return merged === env ? result : { ...result, env: merged };
  }

  function resolveSpawnEnv(session, overrides) {
    const binding = createBinding(session, overrides);
    // CPR's generic Codex materializer copies provider/global auth.json before
    // an attempt route exists. Official OAuth is a host-only credential, so
    // select MultiCC's credential-free relay home at this earliest boundary.
    // Pi owns its local provider credentials. CPR has no Pi materializer yet;
    // keep unknown-CLI fallback behavior outside this lane.
    const result = binding.cli === 'pi' || hostOwnsOfficialCodexHome(binding)
      ? legacy.resolveSpawnEnv(toLegacyProviderView(binding))
      : port.resolveSpawn(binding);
    return withManagedProxyEnv(withKeyAccount(result, session, binding.cli), binding.cli);
  }

  function buildChildEnv(base, session, extra = {}, overrides) {
    const binding = createBinding(session, overrides);
    // Shadow comparisons are intentionally limited to summary/model/spawn.
    // Child-env construction can materialize Codex state, so it stays legacy.
    const result = mode === 'shadow' || binding.cli === 'pi' || hostOwnsOfficialCodexHome(binding)
      ? legacy.buildChildEnv(base, toLegacyProviderView(binding), extra)
      : port.buildChildEnv(base, binding, extra);
    return withManagedProxyEnv(withKeyAccount(result, session, binding.cli), binding.cli);
  }

  return Object.freeze({
    apiVersion: port.apiVersion,
    mode: port.mode,
    proxyBackend,
    routerApiVersion: port.routerApiVersion,
    routerCapabilities: port.routerCapabilities,
    // Any advertised capability, including optional ones the port does not
    // negotiate (e.g. `upstreamAgent`): an option the installed CPR does not
    // know is silently ignored, so a host relying on one must check first.
    routerSupports: name => !!(router && router.CAPABILITIES && router.CAPABILITIES[name]),
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
